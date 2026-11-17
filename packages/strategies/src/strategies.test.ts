import { describe, expect, it } from 'vitest';
import { sma, stdev, highest, rsi, change } from './indicators.js';
import { decide, isScheduled, equityOf } from './templates.js';
import { backtest, applySignal } from './backtest.js';
import { parseAiAnswer, buildAiPrompt } from './ai.js';
import { TEMPLATES, validateParams, templateById } from './catalog.js';
import { EMPTY_PORTFOLIO, type Candle, type Portfolio } from './types.js';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 5, 0); // a Monday
const mk = (closes: number[], start = T0): Candle[] =>
  closes.map((c, i) => ({ t: start + i * H, o: c, h: c, l: c, c }));
const held = (asset: string, units: number, entry: number, peak = entry): Portfolio => ({
  cash: 0,
  units: { [asset]: units },
  entry: { [asset]: { price: entry, t: T0, peak } },
});
/** Seeded deterministic random walk (test fixture). */
function walk(n: number, seed: number, start = 100, vol = 0.01, drift = 0): number[] {
  let s = seed;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const out = [start];
  for (let i = 1; i < n; i++) out.push(out[i - 1]! * (1 + drift + (rnd() - 0.5) * 2 * vol));
  return out;
}

describe('indicators', () => {
  it('sma / stdev / highest / change', () => {
    expect(sma([1, 2, 3, 4], 2)).toBe(3.5);
    expect(sma([1], 2)).toBeNull();
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9], 8)).toBeCloseTo(2, 10);
    expect(highest([1, 5, 3, 9], 3, 3)).toBe(5); // excludes the last candle
    expect(change([100, 110, 121], 2)).toBeCloseTo(0.21, 10);
    expect(change([100], 2)).toBeNull();
  });
  it('rsi extremes', () => {
    expect(rsi([1, 2, 3, 4, 5, 6], 3)).toBe(100);
    expect(rsi([6, 5, 4, 3, 2, 1], 3)).toBeCloseTo(0, 10);
    expect(rsi([1, 2], 3)).toBeNull();
  });
});

describe('templates', () => {
  it('momentum buys a breakout and exits on the trailing stop', () => {
    const closes = [...Array(48).fill(100), 105];
    const buy = decide('momentum', {
      params: { window: 48, trailingStop: 8, size: 50 },
      assets: ['WETH'],
      candles: { WETH: mk(closes) },
      portfolio: EMPTY_PORTFOLIO(),
      now: T0,
    });
    expect(buy).toEqual([expect.objectContaining({ side: 'BUY', asset: 'WETH', sizeBps: 5000 })]);
    const stop = decide('momentum', {
      params: { window: 48, trailingStop: 8 },
      assets: ['WETH'],
      candles: { WETH: mk([...closes, 96]) },
      portfolio: held('WETH', 1, 100, 105),
      now: T0,
    });
    expect(stop[0]).toMatchObject({ side: 'SELL', sizeBps: 10_000 });
    const keep = decide('momentum', {
      params: { window: 48, trailingStop: 8 },
      assets: ['WETH'],
      candles: { WETH: mk([...closes, 99]) },
      portfolio: held('WETH', 1, 100, 105),
      now: T0,
    });
    expect(keep).toEqual([]);
  });

  it('mean reversion buys below the band and sells at the mean', () => {
    const base = walk(60, 7, 100, 0.002);
    const low = decide('meanrev', {
      params: { maWindow: 48, entrySigma: 2, stop: 10, size: 100 },
      assets: ['cbBTC'],
      candles: { cbBTC: mk([...base, 90]) },
      portfolio: EMPTY_PORTFOLIO(),
      now: T0,
    });
    expect(low[0]).toMatchObject({ side: 'BUY', sizeBps: 10_000 });
    const back = decide('meanrev', {
      params: { maWindow: 48 },
      assets: ['cbBTC'],
      candles: { cbBTC: mk([...base, 110]) },
      portfolio: held('cbBTC', 1, 90),
      now: T0,
    });
    expect(back[0]).toMatchObject({ side: 'SELL' });
  });

  it('ma crossover', () => {
    const closes = [...Array(50).fill(100), 99, 98, 97, 96, 95, 110];
    const r = decide('ma_cross', {
      params: { fast: 2, slow: 10, size: 100 },
      assets: ['NVDA'],
      candles: { NVDA: mk(closes) },
      portfolio: EMPTY_PORTFOLIO(),
      now: T0,
    });
    expect(r[0]).toMatchObject({ side: 'BUY' });
    const tp = decide('ma_cross', {
      params: { fast: 2, slow: 10, takeProfit: 5 },
      assets: ['NVDA'],
      candles: { NVDA: mk([...Array(50).fill(100), 106]) },
      portfolio: held('NVDA', 1, 100),
      now: T0,
    });
    expect(tp[0]).toMatchObject({ side: 'SELL', reason: 'Take profit hit.' });
  });

  it('rsi reversal', () => {
    const down = Array.from({ length: 30 }, (_, i) => 100 - i);
    expect(
      decide('rsi', {
        params: { period: 14, buyBelow: 30 },
        assets: ['TSLA'],
        candles: { TSLA: mk(down) },
        portfolio: EMPTY_PORTFOLIO(),
        now: T0,
      })[0],
    ).toMatchObject({ side: 'BUY' });
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(
      decide('rsi', {
        params: { period: 14, sellAbove: 70 },
        assets: ['TSLA'],
        candles: { TSLA: mk(up) },
        portfolio: held('TSLA', 1, 100),
        now: T0,
      })[0],
    ).toMatchObject({ side: 'SELL' });
  });

  it('dip in uptrend', () => {
    const trend = Array.from({ length: 200 }, (_, i) => 100 + i * 0.5 + (i % 2 ? 0.2 : -0.2));
    const r = decide('dip', {
      params: { trend: 168, dipWindow: 24, depthSigma: 1.5, size: 100 },
      assets: ['WETH'],
      candles: { WETH: mk([...trend, 185]) },
      portfolio: EMPTY_PORTFOLIO(),
      now: T0,
    });
    expect(r[0]).toMatchObject({ side: 'BUY' });
  });

  it('rebalance sells overweight first, then buys underweight', () => {
    const c = { A: mk([10, 10]), B: mk([10, 10]) };
    const p: Portfolio = { cash: 0, units: { A: 0.08, B: 0.02 }, entry: {} }; // A 80%, B 20%
    const r = decide('rebalance', {
      params: { drift: 2 },
      assets: ['A', 'B'],
      candles: c,
      portfolio: p,
      now: T0,
    });
    expect(r.map((s) => [s.side, s.asset])).toEqual([
      ['SELL', 'A'],
      ['BUY', 'B'],
    ]);
    expect(r[0]!.sizeBps).toBe(3750); // sell 37.5% of A → 50%
    expect(r[1]!.sizeBps).toBe(3000); // buy 30% of the allocation
    const balanced: Portfolio = { cash: 0, units: { A: 0.05, B: 0.05 }, entry: {} };
    expect(
      decide('rebalance', {
        params: { drift: 2 },
        assets: ['A', 'B'],
        candles: c,
        portfolio: balanced,
        now: T0,
      }),
    ).toEqual([]);
  });

  it('rotation holds the stronger trend', () => {
    const n = 20 * 24 + 2;
    const spy = mk(Array.from({ length: n }, (_, i) => 100 + i * 0.01));
    const qqq = mk(Array.from({ length: n }, (_, i) => 100 + i * 0.02));
    const r = decide('rotation', {
      params: { lookback: 20 },
      assets: ['SPY', 'QQQ'],
      candles: { SPY: spy, QQQ: qqq },
      portfolio: held('SPY', 1, 100),
      now: T0,
    });
    expect(r.map((s) => [s.side, s.asset])).toEqual([
      ['SELL', 'SPY'],
      ['BUY', 'QQQ'],
    ]);
  });

  it('ai and unknown templates never decide here', () => {
    expect(
      decide('ai_news', { params: {}, assets: ['NVDA'], candles: {}, portfolio: EMPTY_PORTFOLIO(), now: T0 }),
    ).toEqual([]);
    expect(
      decide('nope', { params: {}, assets: ['NVDA'], candles: {}, portfolio: EMPTY_PORTFOLIO(), now: T0 }),
    ).toEqual([]);
  });

  it('schedules', () => {
    const mon = Date.UTC(2026, 9, 5, 14, 45);
    const fri = Date.UTC(2026, 9, 9, 20, 15);
    expect(isScheduled('rebalance', {}, mon)).toBe(true);
    expect(isScheduled('rebalance', {}, fri)).toBe(false);
    expect(isScheduled('rotation', {}, fri)).toBe(true);
    expect(isScheduled('rotation', { schedule: 'daily' }, Date.UTC(2026, 9, 6, 20, 30))).toBe(true);
    expect(isScheduled('momentum', {}, mon)).toBe(true);
  });
});

describe('backtest', () => {
  it('is deterministic, never looks ahead and compares with hold', () => {
    const c = { WETH: mk(walk(720, 3, 2000, 0.012, 0.0003)) };
    const a = backtest('momentum', { window: 24, trailingStop: 5, size: 100 }, ['WETH'], c);
    const b = backtest('momentum', { window: 24, trailingStop: 5, size: 100 }, ['WETH'], c);
    expect(a).toEqual(b);
    expect(a.equity).toHaveLength(720);
    expect(a.equity[0]!.equity).toBe(100);
    expect(a.trades).toBeGreaterThan(0);
    expect(a.maxDrawdown).toBeLessThanOrEqual(0);
    expect(a.hold).toBeCloseTo(c.WETH[719]!.c / c.WETH[0]!.c - 1, 5);
    // changing a future candle must not change earlier equity points
    const c2 = { WETH: [...c.WETH.slice(0, 719), { ...c.WETH[719]!, c: c.WETH[719]!.c * 2 }] };
    const d = backtest('momentum', { window: 24, trailingStop: 5, size: 100 }, ['WETH'], c2);
    expect(d.equity.slice(0, 719)).toEqual(a.equity.slice(0, 719));
  });

  it('runs every rule-based template on aligned multi-asset candles', () => {
    const cs = {
      WETH: mk(walk(720, 11, 2000)),
      cbBTC: mk(walk(720, 13, 60000)),
      SPY: mk(walk(720, 17, 500)),
      QQQ: mk(walk(720, 19, 450)),
    };
    for (const t of TEMPLATES.filter((x) => !x.ai)) {
      const assets = t.assets.min === 1 ? ['WETH'] : t.id === 'rotation' ? ['SPY', 'QQQ'] : ['WETH', 'cbBTC'];
      const params = Object.fromEntries(t.params.map((p) => [p.key, p.default]));
      const r = backtest(t.id, params, assets, cs);
      expect(r.equity.length, t.id).toBe(720);
      expect(Number.isFinite(r.ret), t.id).toBe(true);
    }
  });

  it('applySignal pays cost and tracks realized pnl', () => {
    const p = EMPTY_PORTFOLIO();
    applySignal(p, { side: 'BUY', asset: 'X', sizeBps: 10_000, reason: '' }, 100, 0, 1);
    expect(p.cash).toBe(0);
    expect(p.units.X).toBeCloseTo(0.00999, 10);
    const pnl = applySignal(p, { side: 'SELL', asset: 'X', sizeBps: 10_000, reason: '' }, 110, 1, 1);
    expect(pnl).toBeGreaterThan(0);
    expect(p.units.X).toBeUndefined();
    expect(equityOf(p, () => 110)).toBeCloseTo(0.00999 * 110 * 0.999, 9);
  });

  it('handles empty input', () => {
    expect(backtest('momentum', {}, ['WETH'], {}).equity).toEqual([]);
  });
});

describe('ai answers', () => {
  it('accepts strict JSON for allowed assets only', () => {
    expect(
      parseAiAnswer('{"action":"buy","asset":"NVDA","sizeBps":2500,"reason":"beat"}', ['NVDA']).signal,
    ).toEqual({ side: 'BUY', asset: 'NVDA', sizeBps: 2500, reason: 'beat' });
    expect(
      parseAiAnswer('```json\n{"action":"sell","asset":"NVDA","sizeBps":10000,"reason":"x"}\n```', ['NVDA'])
        .signal?.side,
    ).toBe('SELL');
    expect(
      parseAiAnswer('{"action":"buy","asset":"AAPL","sizeBps":2500,"reason":"x"}', ['NVDA']).signal,
    ).toBeNull();
    expect(parseAiAnswer('not json', ['NVDA']).answer.action).toBe('hold');
    expect(
      parseAiAnswer('{"action":"buy","asset":"NVDA","sizeBps":20000,"reason":"x"}', ['NVDA']).signal,
    ).toBeNull();
    expect(
      parseAiAnswer('{"action":"hold","asset":"NVDA","sizeBps":0,"reason":"x"}', ['NVDA']).signal,
    ).toBeNull();
  });
  it('builds the committed prompt', () => {
    expect(
      buildAiPrompt('Trade {assets}.', {
        assets: ['NVDA', 'TSLA'],
        headlines: [],
        prices: {},
        holdings: {},
        asOf: '',
      }),
    ).toBe('Trade NVDA, TSLA.');
  });
});

describe('catalog validation', () => {
  it('validates ranges, asset counts and cross-field rules', () => {
    const m = templateById('ma_cross')!;
    expect(validateParams(m, { fast: 12, slow: 48 }, ['WETH']).ok).toBe(true);
    expect(validateParams(m, { fast: 50, slow: 20 }, ['WETH'])).toMatchObject({ ok: false });
    expect(validateParams(m, { fast: 1 }, ['WETH'])).toMatchObject({ ok: false });
    expect(validateParams(m, {}, ['WETH', 'cbBTC'])).toMatchObject({ ok: false });
    expect(validateParams(m, {}, ['DOGE'])).toMatchObject({ ok: false });
    const r = templateById('rebalance')!;
    expect(validateParams(r, { schedule: 'monthly' }, ['SPY', 'QQQ'])).toMatchObject({ ok: false });
    expect(validateParams(r, {}, ['SPY', 'QQQ'])).toMatchObject({
      ok: true,
      params: { schedule: 'weekly', drift: 2 },
    });
  });
});
