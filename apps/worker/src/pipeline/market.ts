import type { PrismaClient } from '@receipts/db';
import { tokenBySymbol } from '@receipts/shared';
import { alpaca, binance, coinbase, polygon, CRYPTO_PAIRS, type Candle } from '@receipts/strategies';
export { usMarketOpen, coinbase, binance } from '@receipts/strategies';
import type { WorkerEnv } from '../env.js';

/**
 * Market data for indicators (HANDOFF §8). Execution and performance prices always come from chain; these candles
 * only feed the template decisions. Crypto: Coinbase / Binance public klines. Stocks: Polygon or Alpaca (key).
 * Fallback for any asset: hourly candles built from indexed Chainlink rounds (no key needed).
 */
export interface MarketData {
  hourly(symbol: string, hours: number, now: number): Promise<Candle[]>;
}

const HOUR = 3_600_000;
const CRYPTO_PAIR = CRYPTO_PAIRS;

type Fetch = typeof fetch;

export function makeMarketData(env: WorkerEnv, prisma: PrismaClient, fetchImpl: Fetch = fetch): MarketData {
  const chainlink = async (symbol: string, hours: number, now: number) =>
    chainlinkCandles(prisma, symbol, hours, now);
  return {
    async hourly(symbol, hours, now) {
      const t = tokenBySymbol(symbol);
      try {
        if (t?.kind === 'crypto' && CRYPTO_PAIR[symbol]) {
          const c =
            env.CRYPTO_CANDLES_PROVIDER === 'binance'
              ? await binance(fetchImpl, CRYPTO_PAIR[symbol]!.binance, hours, now)
              : await coinbase(fetchImpl, CRYPTO_PAIR[symbol]!.coinbase, hours, now);
          if (c.length >= Math.min(hours, 24)) return c;
        } else if (t?.kind === 'stock' && env.MARKET_DATA_API_KEY) {
          const c =
            env.MARKET_DATA_PROVIDER === 'alpaca'
              ? await alpaca(fetchImpl, symbol, hours, now, env.MARKET_DATA_API_KEY)
              : await polygon(fetchImpl, symbol, hours, now, env.MARKET_DATA_API_KEY);
          if (c.length >= Math.min(hours, 24)) return c;
        }
      } catch {
        /* fall back to Chainlink */
      }
      return chainlink(symbol, hours, now);
    },
  };
}

/** Hourly candles from indexed Chainlink rounds (forward-filled). */
export async function chainlinkCandles(
  prisma: PrismaClient,
  symbol: string,
  hours: number,
  now: number,
): Promise<Candle[]> {
  const since = new Date(now - (hours + 48) * HOUR);
  const rows = await prisma.pricePoint.findMany({
    where: { token: symbol, updatedAt: { gte: since } },
    orderBy: { updatedAt: 'asc' },
    select: { priceUsd: true, updatedAt: true },
  });
  if (rows.length === 0) return [];
  const out: Candle[] = [];
  let i = 0;
  let last: number | null = null;
  const end = Math.floor(now / HOUR) * HOUR;
  for (let t = end - (hours - 1) * HOUR; t <= end; t += HOUR) {
    let o: number | null = last;
    let h = -Infinity;
    let l = Infinity;
    while (i < rows.length && rows[i]!.updatedAt.getTime() < t + HOUR) {
      const p = Number(rows[i]!.priceUsd.toString());
      if (o === null) o = p;
      h = Math.max(h, p);
      l = Math.min(l, p);
      last = p;
      i++;
    }
    if (last === null) continue;
    out.push({
      t,
      o: o ?? last,
      h: Number.isFinite(h) ? Math.max(h, last) : last,
      l: Number.isFinite(l) ? Math.min(l, last) : last,
      c: last,
    });
  }
  return out;
}
