/**
 * Equity index per strategy (WORKER.md §6). Pure and deterministic so anyone can recompute it from chain data.
 *
 * Model (documented on the docs page):
 * - Start: 100% USDG, index 100, at the strategy's first commit.
 * - Each revealed signal is applied at its commit time:
 *     buy  (tokenIn = USDG):  spend min(cash, sizeBps × equity) at the price paid
 *     sell (tokenOut = USDG): sell sizeBps × the position at the price received
 *   Price = the volume-weighted fill of real vault executions when there are any ("live"), otherwise the
 *   Chainlink price at the commit block ("paper"). Paper trades pay COST_BPS per trade (same as the backtester).
 * - Equity is marked hourly with Chainlink prices; hold = equal-weight buy-and-hold of the strategy's assets.
 * - Missed and unrevealed commits never trade (a missed reveal cannot add a winner later).
 */
export const COST_BPS = 10; // 0.1%
export const HOUR = 3_600_000;

export interface Trade {
  at: number; // ms
  side: 'BUY' | 'SELL';
  asset: string; // non-base symbol
  sizeBps: number;
  price: number; // USD per asset unit
  live: boolean;
}

export type PriceSeries = Map<string, { t: number; p: number }[]>; // sorted by t

export interface EquityResult {
  points: { at: number; equity: number; hold: number }[];
  basis: 'live' | 'paper' | 'mixed';
}

export function priceAt(series: PriceSeries, asset: string, t: number): number | null {
  const s = series.get(asset);
  if (!s || s.length === 0) return null;
  // binary search: last point with time ≤ t
  let lo = 0;
  let hi = s.length - 1;
  if (s[0]!.t > t) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  return s[lo]!.p;
}

export function computeEquity(
  trades: readonly Trade[],
  series: PriceSeries,
  assets: readonly string[],
  start: number,
  end: number,
  step = HOUR,
): EquityResult {
  const sorted = [...trades].sort((a, b) => a.at - b.at);
  const t0 = Math.floor(start / step) * step;
  let cash = 1;
  const units = new Map<string, number>();
  const holdUnits = new Map<string, number>();
  const holdAssets = assets.filter((a) => priceAt(series, a, start) !== null || series.has(a));
  let holdInitialized = false;
  const points: EquityResult['points'] = [];
  let ti = 0;
  let live = 0;
  let paper = 0;

  const markEquity = (t: number): number => {
    let e = cash;
    for (const [a, u] of units) {
      if (u === 0) continue;
      const p = priceAt(series, a, t);
      if (p !== null) e += u * p;
    }
    return e;
  };

  // the series starts at 100 before any trade, so returns include the cost of the first trade
  points.push({ at: t0 - step, equity: 100, hold: 100 });
  for (let t = t0; t <= end; t += step) {
    while (ti < sorted.length && sorted[ti]!.at <= t) {
      const tr = sorted[ti]!;
      ti++;
      if (!(tr.price > 0) || tr.sizeBps < 1 || tr.sizeBps > 10_000) continue;
      const cost = tr.live ? 0 : COST_BPS / 10_000;
      if (tr.live) live++;
      else paper++;
      if (tr.side === 'BUY') {
        const equityNow = markEquity(tr.at);
        const spend = Math.min(cash, (tr.sizeBps / 10_000) * equityNow);
        if (spend <= 0) continue;
        cash -= spend;
        units.set(tr.asset, (units.get(tr.asset) ?? 0) + (spend * (1 - cost)) / tr.price);
      } else {
        const held = units.get(tr.asset) ?? 0;
        const qty = (tr.sizeBps / 10_000) * held;
        if (qty <= 0) continue;
        units.set(tr.asset, held - qty);
        cash += qty * tr.price * (1 - cost);
      }
    }
    if (!holdInitialized) {
      const n = holdAssets.filter((a) => priceAt(series, a, t) !== null).length;
      if (n > 0) {
        for (const a of holdAssets) {
          const p = priceAt(series, a, t);
          if (p !== null) holdUnits.set(a, 1 / n / p);
        }
        holdInitialized = true;
      }
    }
    let hold = holdInitialized ? 0 : 1;
    for (const [a, u] of holdUnits) {
      const p = priceAt(series, a, t);
      if (p !== null) hold += u * p;
    }
    points.push({ at: t, equity: round(100 * markEquity(t)), hold: round(100 * hold) });
  }
  const basis = live > 0 && paper > 0 ? 'mixed' : live > 0 ? 'live' : 'paper';
  return { points, basis };
}

export interface Kpis {
  ret: number | null;
  hold: number | null;
  maxDrawdown: number | null;
}

/** Return, hold return and max drawdown (fractions) over the last `windowMs` of the series. */
export function kpis(points: EquityResult['points'], windowMs = 30 * 24 * HOUR): Kpis {
  if (points.length < 2) return { ret: null, hold: null, maxDrawdown: null };
  const end = points[points.length - 1]!;
  const from = end.at - windowMs;
  const win = points.filter((p) => p.at >= from);
  const first = win[0]!;
  let peak = -Infinity;
  let mdd = 0;
  for (const p of win) {
    peak = Math.max(peak, p.equity);
    if (peak > 0) mdd = Math.min(mdd, p.equity / peak - 1);
  }
  return {
    ret: first.equity > 0 ? end.equity / first.equity - 1 : null,
    hold: first.hold > 0 ? end.hold / first.hold - 1 : null,
    maxDrawdown: mdd,
  };
}

function round(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
