import type { FastifyInstance } from 'fastify';
import { encodeFunctionData, keccak256, toHex } from 'viem';
import type { Redis } from 'ioredis';
import { Prisma } from '@receipts/db';
import {
  backtestRequestSchema,
  backtestResultSchema,
  canonicalJson,
  createStrategyRequestSchema,
  createStrategyResponseSchema,
  metadataHash,
  modelHashOf,
  tokenBySymbol,
  ZERO_HASH,
} from '@receipts/shared';
import { signalRegistryAbi } from '@receipts/shared/abi';
import {
  backtest,
  binance,
  coinbase,
  polygon,
  alpaca,
  templateById,
  validateParams,
  BACKTEST_CANDLES,
  CRYPTO_PAIRS,
  type Candle,
} from '@receipts/strategies';
import { z } from 'zod';
import { ApiError, send } from '../lib/http.js';
import { expectedUri, requireAuth } from './auth.js';

const HOUR = 3_600_000;

/** Authenticated writes (API.md "Writes"). Nothing here moves funds: on-chain actions are returned as tx data. */
export async function writeRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, env, redis } = app.deps;
  const auth = requireAuth(app);
  const writeLimit = { rateLimit: { max: env.NODE_ENV === 'test' ? 10_000 : 20, timeWindow: '1 minute' } };
  const memCache = new Map<string, { at: number; v: unknown }>();

  app.post('/backtest', { preHandler: auth, config: writeLimit }, async (req, reply) => {
    const body = backtestRequestSchema.safeParse(req.body);
    if (!body.success)
      throw new ApiError(
        400,
        'BAD_REQUEST',
        body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    const t = templateById(body.data.template);
    if (!t) throw new ApiError(400, 'BAD_TEMPLATE', `Unknown template "${body.data.template}".`);
    if (t.ai)
      throw new ApiError(
        400,
        'NO_AI_BACKTEST',
        'AI strategies cannot be backtested honestly (the model sees today’s news); they build a live track record from their first commit.',
      );
    const v = validateParams(t, body.data.params, body.data.assets);
    if (!v.ok) throw new ApiError(400, 'BAD_PARAMS', v.errors.join(' '));

    const key = `backtest:${keccak256(toHex(canonicalJson({ t: t.id, p: v.params, a: body.data.assets, h: Math.floor(Date.now() / (10 * 60_000)) })))}`;
    const cached = await cacheGet(redis, memCache, key);
    if (cached) return send(reply, backtestResultSchema, cached);

    const now = Date.now();
    const candles: Record<string, Candle[]> = {};
    const sources = new Set<string>();
    for (const a of body.data.assets) {
      const r = await loadCandles(a, now);
      candles[a] = r.candles;
      sources.add(r.source);
    }
    const n = Math.min(...Object.values(candles).map((c) => c.length));
    if (!Number.isFinite(n) || n < 100) {
      throw new ApiError(
        503,
        'NO_DATA',
        'Not enough price history for these assets yet. Try again later or pick other assets.',
      );
    }
    const r = backtest(t.id, v.params, body.data.assets, candles);
    const out = { ...r, candles: n, source: [...sources].join(', ') };
    await cacheSet(redis, memCache, key, out, 600);
    return send(reply, backtestResultSchema, out);
  });

  /** Market data for backtests: public exchange klines (crypto), Polygon/Alpaca (stocks), else Chainlink rounds. */
  async function loadCandles(symbol: string, now: number): Promise<{ candles: Candle[]; source: string }> {
    const tok = tokenBySymbol(symbol);
    try {
      if (tok?.kind === 'crypto' && CRYPTO_PAIRS[symbol]) {
        const c = await coinbase(fetch, CRYPTO_PAIRS[symbol]!.coinbase, BACKTEST_CANDLES, now).catch(() =>
          binance(fetch, CRYPTO_PAIRS[symbol]!.binance, BACKTEST_CANDLES, now),
        );
        if (c.length >= 100) return { candles: c.slice(-BACKTEST_CANDLES), source: 'exchange klines' };
      }
      const key = process.env.MARKET_DATA_API_KEY;
      if (tok?.kind === 'stock' && key) {
        const c =
          process.env.MARKET_DATA_PROVIDER === 'alpaca'
            ? await alpaca(fetch, symbol, BACKTEST_CANDLES, now, key)
            : await polygon(fetch, symbol, BACKTEST_CANDLES, now, key);
        if (c.length >= 100) return { candles: c, source: 'market data API' };
      }
    } catch {
      /* fall back */
    }
    const rows = await prisma.pricePoint.findMany({
      where: { token: symbol, updatedAt: { gte: new Date(now - BACKTEST_CANDLES * HOUR) } },
      orderBy: { updatedAt: 'asc' },
      select: { priceUsd: true, updatedAt: true },
    });
    const candles: Candle[] = [];
    let i = 0;
    let last: number | null = null;
    for (let t = Math.floor(now / HOUR) * HOUR - (BACKTEST_CANDLES - 1) * HOUR; t <= now; t += HOUR) {
      while (i < rows.length && rows[i]!.updatedAt.getTime() < t + HOUR)
        last = Number(rows[i++]!.priceUsd.toString());
      if (last !== null) candles.push({ t, o: last, h: last, l: last, c: last });
    }
    return { candles, source: 'Chainlink rounds' };
  }

  // ───────────────────────── create strategy (metadata only; the user signs registerStrategy)

  app.post('/strategies', { preHandler: auth, config: writeLimit }, async (req, reply) => {
    const body = createStrategyRequestSchema.safeParse(req.body);
    if (!body.success)
      throw new ApiError(
        400,
        'BAD_REQUEST',
        body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    const t = templateById(body.data.template);
    if (!t) throw new ApiError(400, 'BAD_TEMPLATE', `Unknown template "${body.data.template}".`);
    const v = validateParams(t, body.data.params, body.data.assets);
    if (!v.ok) throw new ApiError(400, 'BAD_PARAMS', v.errors.join(' '));
    if (!env.REGISTRY_ADDRESS) throw new ApiError(503, 'NOT_DEPLOYED', 'Contracts are not deployed yet.');
    if (!env.SIGNER_ADDRESS_TEMPLATE)
      throw new ApiError(503, 'NO_SIGNER', 'The template signer is not configured yet. Try again later.');
    const aiModel = process.env.AI_MODEL;
    if (t.ai && !aiModel)
      throw new ApiError(503, 'NO_AI', 'AI strategies are not available yet (no model configured).');

    const meta = {
      schema: 'receipts.strategy/1' as const,
      name: body.data.name.trim(),
      description: (body.data.description ?? '').trim(),
      template: t.id,
      params: v.params,
      assets: body.data.assets,
      kind: t.ai ? ('AI' as const) : ('TEMPLATE' as const),
      modelId: t.ai ? (aiModel ?? null) : null,
    };
    const hash = metadataHash(meta);
    await prisma.metadataDoc.upsert({
      where: { hash },
      create: {
        hash,
        json: JSON.parse(canonicalJson(meta)) as Prisma.InputJsonValue,
        creatorAddr: req.user!.address,
      },
      update: {},
    });
    const out = {
      metadataURI: `${expectedUri(env.APP_DOMAIN, env.NODE_ENV)}/api/metadata/${hash}`,
      signer: env.SIGNER_ADDRESS_TEMPLATE,
      revealWindow: env.TEMPLATE_REVEAL_WINDOW_SEC,
      modelHash: t.ai && aiModel ? modelHashOf(aiModel) : ZERO_HASH,
      creatorShareBps: body.data.creatorShareBps,
      registry: env.REGISTRY_ADDRESS,
    };
    return send(reply, createStrategyResponseSchema, out);
  });

  /**
   * Name / description changes. Metadata is content-addressed and pinned on-chain, so this stores a new document and
   * returns the setMetadataURI transaction for the creator to sign; the indexer applies it when it lands.
   */
  const patchBody = z.object({
    name: z.string().min(3).max(60).optional(),
    description: z.string().max(600).optional(),
  });
  app.patch('/strategies/:id', { preHandler: auth, config: writeLimit }, async (req) => {
    const s = await ownStrategy(req.params, req.user!.address);
    const body = patchBody.safeParse(req.body);
    if (!body.success || (!body.data.name && body.data.description === undefined))
      throw new ApiError(400, 'BAD_REQUEST', 'Send a new name and/or description.');
    const meta = {
      schema: 'receipts.strategy/1' as const,
      name: body.data.name ?? s.name,
      description: body.data.description ?? s.description,
      template: s.template,
      params: s.params as Record<string, unknown>,
      assets: s.assets,
      kind: s.kind === 'HOUSE' ? 'HOUSE' : s.kind,
      modelId: s.modelId,
    };
    const hash = metadataHash(meta);
    await prisma.metadataDoc.upsert({
      where: { hash },
      create: {
        hash,
        json: JSON.parse(canonicalJson(meta)) as Prisma.InputJsonValue,
        creatorAddr: req.user!.address,
      },
      update: {},
    });
    const metadataURI = `${expectedUri(env.APP_DOMAIN, env.NODE_ENV)}/api/metadata/${hash}`;
    return {
      metadataURI,
      tx: {
        to: env.REGISTRY_ADDRESS,
        data: encodeFunctionData({
          abi: signalRegistryAbi,
          functionName: 'setMetadataURI',
          args: [BigInt(s.id), metadataURI],
        }),
      },
    };
  });

  app.post('/strategies/:id/deactivate', { preHandler: auth, config: writeLimit }, async (req) => {
    const s = await ownStrategy(req.params, req.user!.address);
    return {
      tx: {
        to: env.REGISTRY_ADDRESS,
        data: encodeFunctionData({
          abi: signalRegistryAbi,
          functionName: 'setActive',
          args: [BigInt(s.id), false],
        }),
      },
    };
  });

  async function ownStrategy(params: unknown, address: string) {
    const id = Number((params as { id?: string }).id);
    if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, 'BAD_ID', 'Use a numeric strategy id.');
    const s = await prisma.strategy.findUnique({ where: { id } });
    if (!s) throw new ApiError(404, 'NOT_FOUND', `No strategy ${id}.`);
    if (s.creatorAddr.toLowerCase() !== address.toLowerCase())
      throw new ApiError(403, 'NOT_CREATOR', 'Only the strategy creator can do this.');
    if (!env.REGISTRY_ADDRESS) throw new ApiError(503, 'NOT_DEPLOYED', 'Contracts are not deployed yet.');
    return s;
  }
}

async function cacheGet(
  redis: Redis | undefined,
  mem: Map<string, { at: number; v: unknown }>,
  key: string,
): Promise<unknown | null> {
  if (redis) {
    const v = await redis.get(key).catch(() => null);
    return v ? JSON.parse(v) : null;
  }
  const m = mem.get(key);
  return m && Date.now() - m.at < 600_000 ? m.v : null;
}

async function cacheSet(
  redis: Redis | undefined,
  mem: Map<string, { at: number; v: unknown }>,
  key: string,
  v: unknown,
  ttl: number,
) {
  if (redis) await redis.set(key, JSON.stringify(v), 'EX', ttl).catch(() => undefined);
  else mem.set(key, { at: Date.now(), v });
}
