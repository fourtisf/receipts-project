/** Pure indicator helpers over close prices (oldest first). All return null when there is not enough data. */

export function sma(xs: readonly number[], n: number, end = xs.length): number | null {
  if (n <= 0 || end < n) return null;
  let s = 0;
  for (let i = end - n; i < end; i++) s += xs[i]!;
  return s / n;
}

export function stdev(xs: readonly number[], n: number, end = xs.length): number | null {
  const m = sma(xs, n, end);
  if (m === null) return null;
  let v = 0;
  for (let i = end - n; i < end; i++) v += (xs[i]! - m) ** 2;
  return Math.sqrt(v / n);
}

/** Highest value of the `n` items before `end` (exclusive of end). */
export function highest(xs: readonly number[], n: number, end = xs.length): number | null {
  if (end < n || n <= 0) return null;
  let h = -Infinity;
  for (let i = end - n; i < end; i++) h = Math.max(h, xs[i]!);
  return h;
}

/** Wilder's RSI over `period`, computed on the closes up to `end`. */
export function rsi(xs: readonly number[], period: number, end = xs.length): number | null {
  if (end < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = xs[i]! - xs[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  for (let i = period + 1; i < end; i++) {
    const d = xs[i]! - xs[i - 1]!;
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgL === 0) return avgG === 0 ? 50 : 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

/** Simple return over the last `n` items: xs[end-1] / xs[end-1-n] − 1. */
export function change(xs: readonly number[], n: number, end = xs.length): number | null {
  if (end - 1 - n < 0) return null;
  const a = xs[end - 1 - n]!;
  return a > 0 ? xs[end - 1]! / a - 1 : null;
}
