/** Hourly OHLC candle, oldest first. `t` = candle open time (ms). */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
}

export type CandleSet = Record<string, Candle[]>;

/** Paper / backtest portfolio as fractions of the allocation (cash + token units). */
export interface Portfolio {
  cash: number;
  units: Record<string, number>;
  /** entry price and running peak since entry, per held asset (trailing stops) */
  entry: Record<string, { price: number; t: number; peak: number }>;
}

/**
 * One public signal = one swap against USDG.
 *  BUY : spend sizeBps/10000 of the allocation on `asset`
 *  SELL: sell sizeBps/10000 of the current holding of `asset`
 */
export interface SignalOut {
  side: 'BUY' | 'SELL';
  asset: string;
  sizeBps: number;
  reason: string;
}

export interface DecideInput {
  params: Record<string, number | string | string[]>;
  assets: readonly string[];
  candles: CandleSet;
  portfolio: Portfolio;
  now: number;
}

export const EMPTY_PORTFOLIO = (): Portfolio => ({ cash: 1, units: {}, entry: {} });
export const DUST = 1e-9;
