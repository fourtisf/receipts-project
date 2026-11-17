import type { PrismaClient, Strategy } from '@receipts/db';
import type { Redis } from 'ioredis';
import { baseToken, modelHashOf, tokenByAddress, tokenBySymbol } from '@receipts/shared';
import {
  applySignal,
  buildAiPrompt,
  decide,
  equityOf,
  isScheduled,
  parseAiAnswer,
  DECIDERS,
  EMPTY_PORTFOLIO,
  type AiInputs,
  type CandleSet,
  type Portfolio,
  type SignalOut,
} from '@receipts/strategies';
import type { WorkerEnv } from '../env.js';
import type { Logger } from '../log.js';
import { usMarketOpen, type MarketData } from './market.js';
import type { AiArtifactInput } from './executor.js';

export interface RunnerDeps {
  prisma: PrismaClient;
  redis: Redis;
  env: WorkerEnv;
  log: Logger;
  market: MarketData;
  signerAddresses: Set<string>;
  enqueue: (job: { strategyId: number; signal: SignalOut; ai: AiArtifactInput | null }) => Promise<void>;
  fetchImpl?: typeof fetch;
}

const CANDLES = 720;

/**
 * Paper portfolio from the strategy's public, revealed signals (the same data anyone can read), priced at the
 * Chainlink price at each commit. Trailing-stop peaks come from candles since entry.
 */
export async function paperPortfolio(
  prisma: PrismaClient,
  strategyId: number,
  candles: CandleSet,
): Promise<Portfolio> {
  const base = baseToken().address.toLowerCase();
  const commits = await prisma.commit.findMany({
    where: { strategyId, status: 'REVEALED' },
    orderBy: { committedAt: 'asc' },
  });
  const p = EMPTY_PORTFOLIO();
  for (const c of commits) {
    if (!c.tokenIn || !c.tokenOut || c.sizeBps === null) continue;
    const isBuy = c.tokenIn === base;
    const asset = tokenByAddress(isBuy ? c.tokenOut : c.tokenIn);
    const price = Number((isBuy ? c.priceOutAtCommit : c.priceInAtCommit)?.toString() ?? 0);
    if (!asset || !(price > 0)) continue;
    const priceOf = (a: string) => (a === asset.symbol ? price : lastClose(candles, a));
    applySignal(
      p,
      { side: isBuy ? 'BUY' : 'SELL', asset: asset.symbol, sizeBps: c.sizeBps, reason: '' },
      price,
      c.committedAt.getTime(),
      equityOf(p, priceOf),
      0.001,
    );
  }
  for (const [a, e] of Object.entries(p.entry)) {
    for (const k of candles[a] ?? []) if (k.t >= e.t) e.peak = Math.max(e.peak, k.c);
  }
  return p;
}

function lastClose(c: CandleSet, a: string): number | null {
  const xs = c[a];
  return xs && xs.length ? xs[xs.length - 1]!.c : null;
}

export class Runner {
  constructor(private readonly d: RunnerDeps) {}

  /** Strategies we run: active, signer is one of our keys, rule-based template or AI news. */
  async ours(): Promise<Strategy[]> {
    const all = await this.d.prisma.strategy.findMany({ where: { active: true } });
    return all.filter(
      (s) =>
        this.d.signerAddresses.has(s.signerAddr.toLowerCase()) &&
        (s.template in DECIDERS || s.template === 'ai_news'),
    );
  }

  async runOnce(now = Date.now()): Promise<number> {
    let produced = 0;
    for (const s of await this.ours()) {
      try {
        produced += await this.runStrategy(s, now);
      } catch (err) {
        this.d.log.error({ strategyId: s.id, err: String(err) }, 'runner failed for strategy');
      }
    }
    return produced;
  }

  async runStrategy(s: Strategy, now: number): Promise<number> {
    const params = (s.params ?? {}) as Record<string, number | string | string[]>;
    if (!isScheduled(s.template, params, now)) return 0;
    if (s.assets.some((a) => tokenBySymbol(a)?.kind === 'stock') && !usMarketOpen(now)) return 0; // stocks: market hours only
    // one evaluation per strategy per hour, even across restarts
    const bucket = Math.floor(now / 3_600_000);
    if ((await this.d.redis.set(`runner:${s.id}:${bucket}`, '1', 'EX', 7200, 'NX')) !== 'OK') return 0;
    // never decide on top of a commit that is not revealed yet
    const open = await this.d.prisma.secretSalt.count({ where: { strategyId: s.id, revealedAt: null } });
    if (open > 0) return 0;

    const candles: CandleSet = {};
    for (const a of s.assets) candles[a] = await this.d.market.hourly(a, CANDLES, now);
    if (s.assets.some((a) => (candles[a]?.length ?? 0) < 24)) {
      this.d.log.warn({ strategyId: s.id }, 'not enough candles to decide');
      return 0;
    }
    const portfolio = await paperPortfolio(this.d.prisma, s.id, candles);

    if (s.template === 'ai_news') {
      const r = await this.decideAi(s, params, candles, portfolio, now);
      if (r) {
        await this.d.enqueue({ strategyId: s.id, signal: r.signal, ai: r.ai });
        return 1;
      }
      return 0;
    }
    const signals = decide(s.template, { params, assets: s.assets, candles, portfolio, now });
    for (const signal of signals) await this.d.enqueue({ strategyId: s.id, signal, ai: null });
    if (signals.length)
      this.d.log.info(
        { strategyId: s.id, signals: signals.map((x) => `${x.side} ${x.asset} ${x.sizeBps}`) },
        'signals',
      );
    return signals.length;
  }

  /** AI decision: exact prompt + inputs are committed as promptHash and published at reveal. */
  async decideAi(
    s: Strategy,
    params: Record<string, number | string | string[]>,
    candles: CandleSet,
    portfolio: Portfolio,
    now: number,
  ): Promise<{ signal: SignalOut; ai: AiArtifactInput } | null> {
    const { env } = this.d;
    if (!env.AI_BASE_URL || !env.AI_MODEL) return null;
    // the model must be the one this strategy committed to at registration
    if (!s.modelHash || s.modelHash.toLowerCase() !== modelHashOf(env.AI_MODEL).toLowerCase()) {
      this.d.log.error({ strategyId: s.id }, 'AI_MODEL does not match the committed modelHash — not trading');
      return null;
    }
    const inputs: AiInputs = {
      assets: s.assets,
      headlines: await this.headlines(s.assets, now),
      prices: Object.fromEntries(
        s.assets.map((a) => [a, (candles[a] ?? []).slice(-48).map((c) => ({ t: c.t, c: c.c }))]),
      ),
      holdings: Object.fromEntries(Object.entries(portfolio.units).map(([a, u]) => [a, u])),
      asOf: new Date(now).toISOString(),
    };
    const prompt = buildAiPrompt(String(params.promptTemplate ?? ''), inputs);
    const fetchImpl = this.d.fetchImpl ?? fetch;
    const res = await fetchImpl(`${env.AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.AI_API_KEY ?? ''}` },
      body: JSON.stringify({
        model: env.AI_MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: JSON.stringify(inputs) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`AI endpoint returned ${res.status}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = body.choices?.[0]?.message?.content ?? '';
    const { answer, signal } = parseAiAnswer(raw, s.assets);
    if (!signal) return null;
    return { signal, ai: { model: env.AI_MODEL, prompt, inputs, output: answer } };
  }

  async headlines(assets: readonly string[], now: number): Promise<AiInputs['headlines']> {
    const { env } = this.d;
    if (!env.MARKET_DATA_API_KEY) return [];
    const fetchImpl = this.d.fetchImpl ?? fetch;
    const out: AiInputs['headlines'] = [];
    for (const a of assets) {
      try {
        if (env.MARKET_DATA_PROVIDER === 'polygon') {
          const since = new Date(now - 24 * 3_600_000).toISOString();
          const r = await fetchImpl(
            `https://api.polygon.io/v2/reference/news?ticker=${a}&published_utc.gte=${since}&limit=10&apiKey=${env.MARKET_DATA_API_KEY}`,
          );
          const j = (await r.json()) as {
            results?: { title: string; publisher?: { name?: string }; published_utc: string }[];
          };
          for (const n of j.results ?? [])
            out.push({
              asset: a,
              title: n.title,
              source: n.publisher?.name ?? 'polygon',
              publishedAt: n.published_utc,
            });
        } else {
          const [id, secret] = env.MARKET_DATA_API_KEY.split(':');
          const r = await fetchImpl(`https://data.alpaca.markets/v1beta1/news?symbols=${a}&limit=10`, {
            headers: { 'APCA-API-KEY-ID': id ?? '', 'APCA-API-SECRET-KEY': secret ?? '' },
          });
          const j = (await r.json()) as { news?: { headline: string; source: string; created_at: string }[] };
          for (const n of j.news ?? [])
            out.push({ asset: a, title: n.headline, source: n.source, publishedAt: n.created_at });
        }
      } catch {
        /* headlines are best-effort inputs */
      }
    }
    return out;
  }
}
