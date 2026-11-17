/**
 * Fixed-point helpers. Money is bigint on chain and decimal strings in DB/API — never JS floats.
 * USD values on chain are 18-decimal fixed point.
 */
export const USD_DECIMALS = 18;
export const WAD = 10n ** 18n;

/** Format a bigint fixed-point amount as a decimal string with up to `maxFrac` fraction digits (truncating). */
export function formatFixed(value: bigint, decimals: number, maxFrac = decimals): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, '0').slice(0, Math.max(0, maxFrac));
  frac = frac.replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toString()}${frac ? `.${frac}` : ''}`;
}

/** Parse a decimal string into a bigint fixed-point amount (truncates extra digits). */
export function parseFixed(value: string, decimals: number): bigint {
  const s = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`Not a decimal number: "${value}"`);
  const neg = s.startsWith('-');
  const [w = '0', f = ''] = (neg ? s.slice(1) : s).split('.');
  const frac = f.slice(0, decimals).padEnd(decimals, '0');
  const v = BigInt(w) * 10n ** BigInt(decimals) + BigInt(frac || '0');
  return neg ? -v : v;
}

/** USD (18 decimals) bigint → decimal string, full precision. */
export function usdToString(v: bigint): string {
  return formatFixed(v, USD_DECIMALS);
}

/** Display a USD decimal string as "$1,234.56". Display only — never use the result for math. */
export function displayUsd(v: string | bigint, frac = 2): string {
  const s = typeof v === 'bigint' ? formatFixed(v, USD_DECIMALS) : v;
  const neg = s.startsWith('-');
  const [w = '0', f = ''] = (neg ? s.slice(1) : s).split('.');
  const fracStr = (f + '0'.repeat(frac)).slice(0, frac);
  const whole = w.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${whole}${frac > 0 ? `.${fracStr}` : ''}`;
}
