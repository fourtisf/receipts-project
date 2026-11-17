import type { Candle } from './types.js';

/**
 * Market data fetchers for indicator candles (HANDOFF §8). Execution and performance prices always come from chain;
 * these candles only feed template decisions and backtests.
 */
type Fetch = typeof fetch;
const HOUR = 3_600_000;

export const CRYPTO_PAIRS: Record<string, { coinbase: string; binance: string }> = {
  WETH: { coinbase: 'ETH-USD', binance: 'ETHUSDT' },
  cbBTC: { coinbase: 'BTC-USD', binance: 'BTCUSDT' },
};

async function getJson(
  fetchImpl: Fetch,
  url: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const res = await fetchImpl(url, { headers: { 'user-agent': 'receipts-worker', ...headers } });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

/** Coinbase Exchange candles: [time(s), low, high, open, close, volume], newest first, max 300 per call. */
export async function coinbase(
  fetchImpl: Fetch,
  product: string,
  hours: number,
  now: number,
): Promise<Candle[]> {
  const out: Candle[] = [];
  let end = Math.floor(now / HOUR) * HOUR;
  while (out.length < hours) {
    const n = Math.min(300, hours - out.length);
    const start = end - n * HOUR;
    const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=3600&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
    const rows = (await getJson(fetchImpl, url)) as number[][];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) out.push({ t: r[0]! * 1000, l: r[1]!, h: r[2]!, o: r[3]!, c: r[4]!, v: r[5]! });
    end = start;
  }
  return dedupe(out);
}

/** Binance klines: [openTime(ms), o, h, l, c, v, …], oldest first, max 1000. */
export async function binance(
  fetchImpl: Fetch,
  symbol: string,
  hours: number,
  now: number,
): Promise<Candle[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=${Math.min(1000, hours)}&endTime=${now}`;
  const rows = (await getJson(fetchImpl, url)) as (string | number)[][];
  return dedupe(
    rows.map((r) => ({
      t: Number(r[0]),
      o: Number(r[1]),
      h: Number(r[2]),
      l: Number(r[3]),
      c: Number(r[4]),
      v: Number(r[5]),
    })),
  );
}

/** Polygon aggregates (hourly). */
export async function polygon(
  fetchImpl: Fetch,
  ticker: string,
  hours: number,
  now: number,
  key: string,
): Promise<Candle[]> {
  const from = now - hours * HOUR * 3; // markets are closed ~2/3 of the time
  const url = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/hour/${from}/${now}?adjusted=true&sort=asc&limit=50000&apiKey=${key}`;
  const j = (await getJson(fetchImpl, url)) as {
    results?: { t: number; o: number; h: number; l: number; c: number; v: number }[];
  };
  return dedupe((j.results ?? []).map((r) => ({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v }))).slice(
    -hours,
  );
}

/** Alpaca market data v2 bars (key as "KEYID:SECRET"). */
export async function alpaca(
  fetchImpl: Fetch,
  ticker: string,
  hours: number,
  now: number,
  key: string,
): Promise<Candle[]> {
  const [id, secret] = key.split(':');
  const start = new Date(now - hours * HOUR * 3).toISOString();
  const url = `https://data.alpaca.markets/v2/stocks/${ticker}/bars?timeframe=1Hour&start=${start}&limit=10000&adjustment=all`;
  const j = (await getJson(fetchImpl, url, {
    'APCA-API-KEY-ID': id ?? '',
    'APCA-API-SECRET-KEY': secret ?? '',
  })) as {
    bars?: { t: string; o: number; h: number; l: number; c: number; v: number }[];
  };
  return dedupe(
    (j.bars ?? []).map((b) => ({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })),
  ).slice(-hours);
}

export function dedupe(cs: Candle[]): Candle[] {
  const m = new Map<number, Candle>();
  for (const c of cs) m.set(c.t, c);
  return [...m.values()].sort((a, b) => a.t - b.t);
}

/** US equity market hours (NYSE regular session, America/New_York, weekdays 09:30–16:00). */
export function usMarketOpen(now: number): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(new Date(now));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const wd = get('weekday');
  if (wd === 'Sat' || wd === 'Sun') return false;
  const hm = Number(get('hour')) * 60 + Number(get('minute'));
  return hm >= 9 * 60 + 30 && hm < 16 * 60;
}
