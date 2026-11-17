import { describe, expect, it } from 'vitest';
import { computeEquity, kpis, priceAt, HOUR, type PriceSeries, type Trade } from '../src/stats/equity.js';

const t0 = Date.UTC(2026, 10, 1);
const series = (pts: [number, number][]): PriceSeries =>
  new Map([['WETH', pts.map(([h, p]) => ({ t: t0 + h * HOUR, p }))]]);

describe('priceAt', () => {
  it('returns the last price at or before t', () => {
    const s = series([
      [0, 100],
      [2, 110],
    ]);
    expect(priceAt(s, 'WETH', t0 - 1)).toBeNull();
    expect(priceAt(s, 'WETH', t0)).toBe(100);
    expect(priceAt(s, 'WETH', t0 + HOUR)).toBe(100);
    expect(priceAt(s, 'WETH', t0 + 2 * HOUR)).toBe(110);
    expect(priceAt(s, 'NOPE', t0)).toBeNull();
  });
});

describe('computeEquity', () => {
  it('stays flat with no trades and tracks hold', () => {
    const s = series([
      [0, 100],
      [5, 150],
    ]);
    const r = computeEquity([], s, ['WETH'], t0, t0 + 5 * HOUR);
    expect(r.points).toHaveLength(7); // starting point + 6 hourly marks
    expect(r.points[0]!.equity).toBe(100);
    expect(r.points.at(-1)!.equity).toBe(100);
    expect(r.points.at(-1)!.hold).toBe(150);
  });

  it('applies a paper buy with cost and marks to market', () => {
    const s = series([
      [0, 100],
      [3, 120],
    ]);
    const trades: Trade[] = [
      { at: t0, side: 'BUY', asset: 'WETH', sizeBps: 10_000, price: 100, live: false },
    ];
    const r = computeEquity(trades, s, ['WETH'], t0, t0 + 3 * HOUR);
    expect(r.basis).toBe('paper');
    expect(r.points[0]!.equity).toBe(100); // before any trade
    expect(r.points[1]!.equity).toBeCloseTo(99.9, 6); // 0.1% cost
    expect(r.points.at(-1)!.equity).toBeCloseTo(119.88, 6);
  });

  it('round trip with a live fill has no paper cost', () => {
    const s = series([
      [0, 100],
      [1, 110],
    ]);
    const trades: Trade[] = [
      { at: t0, side: 'BUY', asset: 'WETH', sizeBps: 5000, price: 100, live: true },
      { at: t0 + HOUR, side: 'SELL', asset: 'WETH', sizeBps: 10_000, price: 110, live: true },
    ];
    const r = computeEquity(trades, s, ['WETH'], t0, t0 + HOUR);
    expect(r.basis).toBe('live');
    expect(r.points.at(-1)!.equity).toBeCloseTo(105, 6);
  });

  it('ignores invalid sizes and sells without a position', () => {
    const s = series([[0, 100]]);
    const trades: Trade[] = [
      { at: t0, side: 'SELL', asset: 'WETH', sizeBps: 10_000, price: 100, live: false },
      { at: t0, side: 'BUY', asset: 'WETH', sizeBps: 0, price: 100, live: false },
    ];
    const r = computeEquity(trades, s, ['WETH'], t0, t0 + HOUR);
    expect(r.points.every((p) => p.equity === 100)).toBe(true);
  });
});

describe('kpis', () => {
  it('computes return, hold and max drawdown', () => {
    const pts = [100, 120, 90, 110].map((e, i) => ({ at: t0 + i * HOUR, equity: e, hold: 100 + i }));
    const k = kpis(pts);
    expect(k.ret).toBeCloseTo(0.1, 6);
    expect(k.hold).toBeCloseTo(0.03, 6);
    expect(k.maxDrawdown).toBeCloseTo(-0.25, 6);
    expect(kpis(pts.slice(0, 1)).ret).toBeNull();
  });
});
