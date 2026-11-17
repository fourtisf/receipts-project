import { change, highest, rsi, sma, stdev } from './indicators.js';
import { DUST, type DecideInput, type Portfolio, type SignalOut } from './types.js';
import type { TemplateId } from './catalog.js';

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
const bps = (pct: number): number => Math.max(1, Math.min(10_000, Math.round(pct * 100)));

export function lastPrice(input: DecideInput, asset: string): number | null {
  const cs = input.candles[asset];
  return cs && cs.length ? cs[cs.length - 1]!.c : null;
}

export function closes(input: DecideInput, asset: string): number[] {
  return (input.candles[asset] ?? []).map((c) => c.c);
}

export function equityOf(p: Portfolio, price: (a: string) => number | null): number {
  let e = p.cash;
  for (const [a, u] of Object.entries(p.units)) {
    if (u <= DUST) continue;
    const px = price(a);
    if (px !== null) e += u * px;
  }
  return e;
}

function holding(p: Portfolio, asset: string): number {
  return p.units[asset] ?? 0;
}

/** Single-asset exits shared by several templates: trailing stop from the running peak, or a fixed stop/target. */
function trailingStopHit(p: Portfolio, asset: string, price: number, stopPct: number): boolean {
  const e = p.entry[asset];
  if (!e) return false;
  const peak = Math.max(e.peak, price);
  return price <= peak * (1 - stopPct / 100);
}

function stopHit(p: Portfolio, asset: string, price: number, stopPct: number): boolean {
  const e = p.entry[asset];
  return Boolean(e && price <= e.price * (1 - stopPct / 100));
}

type Decide = (input: DecideInput) => SignalOut[];

const momentum: Decide = (input) => {
  const a = input.assets[0]!;
  const xs = closes(input, a);
  const price = lastPrice(input, a);
  if (price === null) return [];
  const p = input.portfolio;
  if (holding(p, a) > DUST) {
    const stop = num(input.params.trailingStop, 8);
    return trailingStopHit(p, a, price, stop)
      ? [{ side: 'SELL', asset: a, sizeBps: 10_000, reason: `Trailing stop ${stop}% hit at ${price}.` }]
      : [];
  }
  const window = Math.round(num(input.params.window, 48));
  const hi = highest(xs, window, xs.length - 1);
  if (hi !== null && price > hi) {
    return [
      {
        side: 'BUY',
        asset: a,
        sizeBps: bps(num(input.params.size, 100)),
        reason: `Breakout above the ${window}h high ${hi}.`,
      },
    ];
  }
  return [];
};

const meanrev: Decide = (input) => {
  const a = input.assets[0]!;
  const xs = closes(input, a);
  const price = lastPrice(input, a);
  const n = Math.round(num(input.params.maWindow, 48));
  const m = sma(xs, n);
  const sd = stdev(xs, n);
  if (price === null || m === null || sd === null) return [];
  const p = input.portfolio;
  if (holding(p, a) > DUST) {
    if (price >= m)
      return [{ side: 'SELL', asset: a, sizeBps: 10_000, reason: `Back at the ${n}h mean ${m.toFixed(4)}.` }];
    if (stopHit(p, a, price, num(input.params.stop, 10)))
      return [{ side: 'SELL', asset: a, sizeBps: 10_000, reason: 'Stop loss hit.' }];
    return [];
  }
  const k = num(input.params.entrySigma, 2);
  if (sd > 0 && price < m - k * sd) {
    return [
      {
        side: 'BUY',
        asset: a,
        sizeBps: bps(num(input.params.size, 100)),
        reason: `${k}σ below the ${n}h mean.`,
      },
    ];
  }
  return [];
};

const maCross: Decide = (input) => {
  const a = input.assets[0]!;
  const xs = closes(input, a);
  const price = lastPrice(input, a);
  const f = Math.round(num(input.params.fast, 12));
  const s = Math.round(num(input.params.slow, 48));
  const fNow = sma(xs, f);
  const sNow = sma(xs, s);
  const fPrev = sma(xs, f, xs.length - 1);
  const sPrev = sma(xs, s, xs.length - 1);
  if (price === null || fNow === null || sNow === null || fPrev === null || sPrev === null) return [];
  const p = input.portfolio;
  if (holding(p, a) > DUST) {
    const e = p.entry[a];
    if (fPrev >= sPrev && fNow < sNow)
      return [{ side: 'SELL', asset: a, sizeBps: 10_000, reason: 'Fast MA crossed below slow MA.' }];
    if (stopHit(p, a, price, num(input.params.stop, 10)))
      return [{ side: 'SELL', asset: a, sizeBps: 10_000, reason: 'Stop loss hit.' }];
    if (e && price >= e.price * (1 + num(input.params.takeProfit, 25) / 100)) {
      return [{ side: 'SELL', asset: a, sizeBps: 10_000, reason: 'Take profit hit.' }];
    }
    return [];
  }
  if (fPrev <= sPrev && fNow > sNow) {
    return [
      {
        side: 'BUY',
        asset: a,
        sizeBps: bps(num(input.params.size, 100)),
        reason: `${f}h MA crossed above ${s}h MA.`,
      },
    ];
  }
  return [];
};

const rsiReversal: Decide = (input) => {
  const a = input.assets[0]!;
  const xs = closes(input, a);
  const price = lastPrice(input, a);
  const r = rsi(xs, Math.round(num(input.params.period, 14)));
  if (price === null || r === null) return [];
  const p = input.portfolio;
  if (holding(p, a) > DUST) {
    if (r > num(input.params.sellAbove, 70))
      return [{ side: 'SELL', asset: a, sizeBps: 10_000, reason: `RSI ${r.toFixed(1)} overbought.` }];
    if (stopHit(p, a, price, num(input.params.stop, 12)))
      return [{ side: 'SELL', asset: a, sizeBps: 10_000, reason: 'Stop loss hit.' }];
    return [];
  }
  if (r < num(input.params.buyBelow, 30)) {
    return [
      {
        side: 'BUY',
        asset: a,
        sizeBps: bps(num(input.params.size, 100)),
        reason: `RSI ${r.toFixed(1)} oversold.`,
      },
    ];
  }
  return [];
};

const dip: Decide = (input) => {
  const a = input.assets[0]!;
  const xs = closes(input, a);
  const price = lastPrice(input, a);
  if (price === null) return [];
  const p = input.portfolio;
  if (holding(p, a) > DUST) {
    const stop = num(input.params.trailingStop, 6);
    return trailingStopHit(p, a, price, stop)
      ? [{ side: 'SELL', asset: a, sizeBps: 10_000, reason: `Trailing stop ${stop}% hit.` }]
      : [];
  }
  const tn = Math.round(num(input.params.trend, 168));
  const dn = Math.round(num(input.params.dipWindow, 24));
  const trendNow = sma(xs, tn);
  const trendPrev = sma(xs, tn, xs.length - 24);
  const dm = sma(xs, dn);
  const dsd = stdev(xs, dn);
  if (trendNow === null || trendPrev === null || dm === null || dsd === null) return [];
  const uptrend = price > trendNow && trendNow > trendPrev;
  const k = num(input.params.depthSigma, 1.5);
  if (uptrend && dsd > 0 && price < dm - k * dsd) {
    return [
      {
        side: 'BUY',
        asset: a,
        sizeBps: bps(num(input.params.size, 100)),
        reason: `Dip of ${k}σ in an uptrend.`,
      },
    ];
  }
  return [];
};

/** Equal weight across assets; trades only the assets that drifted more than the threshold. Sells first. */
const rebalance: Decide = (input) => {
  const price = (a: string) => lastPrice(input, a);
  if (input.assets.some((a) => price(a) === null)) return [];
  const p = input.portfolio;
  const equity = equityOf(p, price);
  if (equity <= 0) return [];
  const target = 1 / input.assets.length;
  const drift = num(input.params.drift, 2) / 100;
  const sells: SignalOut[] = [];
  const buys: SignalOut[] = [];
  for (const a of input.assets) {
    const w = (holding(p, a) * price(a)!) / equity;
    if (w - target > drift && holding(p, a) > DUST) {
      sells.push({
        side: 'SELL',
        asset: a,
        sizeBps: Math.max(1, Math.round(((w - target) / w) * 10_000)),
        reason: `Weight ${(w * 100).toFixed(1)}% > target.`,
      });
    } else if (target - w > drift) {
      // BUY sizeBps is a share of the allocation (≈ equity for a fully allocated vault)
      buys.push({
        side: 'BUY',
        asset: a,
        sizeBps: Math.max(1, Math.round((target - w) * 10_000)),
        reason: `Weight ${(w * 100).toFixed(1)}% < target.`,
      });
    }
  }
  return [...sells, ...buys];
};

/** Holds the asset with the strongest trend over the lookback (daily closes). */
const rotation: Decide = (input) => {
  const lookbackH = Math.round(num(input.params.lookback, 20)) * 24;
  let best: { a: string; r: number } | null = null;
  for (const a of input.assets) {
    const r = change(closes(input, a), lookbackH);
    if (r !== null && (best === null || r > best.r)) best = { a, r };
  }
  if (!best) return [];
  const p = input.portfolio;
  const out: SignalOut[] = [];
  for (const a of input.assets) {
    if (a !== best.a && holding(p, a) > DUST)
      out.push({ side: 'SELL', asset: a, sizeBps: 10_000, reason: `${best.a} has the stronger trend.` });
  }
  if (holding(p, best.a) <= DUST) {
    out.push({
      side: 'BUY',
      asset: best.a,
      sizeBps: 10_000,
      reason: `${best.a} ${(best.r * 100).toFixed(2)}% over ${lookbackH / 24}d.`,
    });
  }
  return out;
};

export const DECIDERS: Record<Exclude<TemplateId, 'ai_news'>, Decide> = {
  momentum,
  meanrev,
  ma_cross: maCross,
  rsi: rsiReversal,
  dip,
  rebalance,
  rotation,
};

/** Rule-based decision. AI templates are decided by the runner (model call), never here. */
export function decide(template: string, input: DecideInput): SignalOut[] {
  const fn = (DECIDERS as Record<string, Decide | undefined>)[template];
  if (!fn) return [];
  return fn(input).filter((s) => s.sizeBps >= 1 && s.sizeBps <= 10_000);
}

/** Whether a scheduled template should evaluate at `now` (UTC): weekly = Monday US open / Friday close. */
export function isScheduled(template: string, params: Record<string, unknown>, now: number): boolean {
  const d = new Date(now);
  const schedule = str(params.schedule, 'weekly');
  const hm = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (template === 'rebalance') {
    if (schedule === 'daily') return hm >= 14 * 60 + 30 && hm < 15 * 60 + 30; // first hour after the US open (EST)
    return d.getUTCDay() === 1 && hm >= 14 * 60 + 30 && hm < 15 * 60 + 30;
  }
  if (template === 'rotation') {
    if (schedule === 'daily') return hm >= 20 * 60 && hm < 21 * 60;
    return d.getUTCDay() === 5 && hm >= 20 * 60 && hm < 21 * 60; // Friday close
  }
  return true; // hourly templates
}
