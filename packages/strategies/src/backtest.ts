import { decide, equityOf, isScheduled } from './templates.js';
import { DUST, EMPTY_PORTFOLIO, type CandleSet, type Portfolio, type SignalOut } from './types.js';

export const BACKTEST_COST = 0.001; // 0.1% per trade
export const BACKTEST_CANDLES = 720;

export interface BacktestResult {
  ret: number; // fraction
  hold: number; // fraction, equal-weight buy-and-hold
  maxDrawdown: number; // fraction ≤ 0
  winRate: number; // fraction of closed round trips with profit
  trades: number;
  equity: { t: number; equity: number; hold: number }[]; // index, 100 = start
}

/** Applies a signal to a portfolio at `price` (fills at the candle close with `cost`). Returns realized PnL on sells. */
export function applySignal(
  p: Portfolio,
  s: SignalOut,
  price: number,
  t: number,
  equity: number,
  cost = BACKTEST_COST,
) {
  if (s.side === 'BUY') {
    const spend = Math.min(p.cash, (s.sizeBps / 10_000) * equity);
    if (spend <= DUST) return null;
    const units = (spend * (1 - cost)) / price;
    const prev = p.units[s.asset] ?? 0;
    const prevEntry = p.entry[s.asset];
    p.cash -= spend;
    p.units[s.asset] = prev + units;
    const avg = prevEntry && prev > DUST ? (prevEntry.price * prev + price * units) / (prev + units) : price;
    p.entry[s.asset] = { price: avg, t: prevEntry?.t ?? t, peak: Math.max(prevEntry?.peak ?? price, price) };
    return null;
  }
  const held = p.units[s.asset] ?? 0;
  const qty = (s.sizeBps / 10_000) * held;
  if (qty <= DUST) return null;
  const entry = p.entry[s.asset]?.price ?? price;
  p.units[s.asset] = held - qty;
  p.cash += qty * price * (1 - cost);
  if (p.units[s.asset]! <= DUST) {
    delete p.units[s.asset];
    delete p.entry[s.asset];
  }
  return (price * (1 - cost) - entry) * qty;
}

/**
 * Backtest a template over aligned hourly candles (HANDOFF §8: last 720 candles, 0.1% cost per trade, compared with
 * buy-and-hold). Decisions at each close use only candles up to that close (no look-ahead).
 */
export function backtest(
  template: string,
  params: Record<string, number | string | string[]>,
  assets: readonly string[],
  candles: CandleSet,
  cost = BACKTEST_COST,
): BacktestResult {
  const n = Math.min(...assets.map((a) => candles[a]?.length ?? 0));
  if (!Number.isFinite(n) || n < 2)
    return { ret: 0, hold: 0, maxDrawdown: 0, winRate: 0, trades: 0, equity: [] };
  const aligned: CandleSet = Object.fromEntries(assets.map((a) => [a, candles[a]!.slice(-n)]));
  const p = EMPTY_PORTFOLIO();
  const first = (a: string) => aligned[a]![0]!.c;
  const holdUnits = Object.fromEntries(assets.map((a) => [a, 1 / assets.length / first(a)]));
  const warmup = Math.min(n - 1, Math.max(24, Math.floor(n / 6)));
  const equity: BacktestResult['equity'] = [];
  let trades = 0;
  let wins = 0;
  let closed = 0;
  let peak = 1;
  let mdd = 0;

  for (let i = 0; i < n; i++) {
    const t = aligned[assets[0]!]![i]!.t;
    const price = (a: string) => aligned[a]?.[i]?.c ?? null;
    // running peaks for trailing stops
    for (const a of Object.keys(p.entry)) {
      const px = price(a);
      if (px !== null) p.entry[a]!.peak = Math.max(p.entry[a]!.peak, px);
    }
    if (i >= warmup && isScheduled(template, params, t)) {
      const window: CandleSet = Object.fromEntries(assets.map((a) => [a, aligned[a]!.slice(0, i + 1)]));
      const signals = decide(template, { params, assets, candles: window, portfolio: p, now: t });
      for (const s of signals) {
        const px = price(s.asset);
        if (px === null) continue;
        const pnl = applySignal(p, s, px, t, equityOf(p, price), cost);
        trades++;
        if (pnl !== null) {
          closed++;
          if (pnl > 0) wins++;
        }
      }
    }
    const e = equityOf(p, price);
    peak = Math.max(peak, e);
    mdd = Math.min(mdd, e / peak - 1);
    const hold = assets.reduce((acc, a) => acc + holdUnits[a]! * (price(a) ?? first(a)), 0);
    equity.push({ t, equity: round(100 * e), hold: round(100 * hold) });
  }
  const last = equity[equity.length - 1]!;
  return {
    ret: round(last.equity / 100 - 1),
    hold: round(last.hold / 100 - 1),
    maxDrawdown: round(mdd),
    winRate: closed ? round(wins / closed) : 0,
    trades,
    equity,
  };
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;
