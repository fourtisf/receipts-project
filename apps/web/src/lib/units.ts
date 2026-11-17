import { formatUnits, parseUnits } from 'viem';
import { amount } from './format';

/** USD values on chain are 18-decimal fixed point. */
export const USD = 18;

/** bigint fixed-point → "2,480.00" (display only). */
export function fmtUnits(v: bigint | null | undefined, decimals: number, frac = 2): string {
  if (v === null || v === undefined) return '—';
  return amount(formatUnits(v, decimals), frac);
}

export function formatUsd18(v: unknown, frac = 2): string {
  return typeof v === 'bigint' ? fmtUnits(v, USD, frac) : '—';
}

/** Token amounts with up to `maxFrac` decimals, trailing zeros trimmed: "0.0431". */
export function fmtToken(v: bigint, decimals: number, maxFrac = 6): string {
  return amount(formatUnits(v, decimals), maxFrac)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
}

/** Parses a user-typed decimal ("1,250.5") into base units; null when invalid or not positive. */
export function parseAmount(input: string, decimals: number): bigint | null {
  const s = input.trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [, frac = ''] = s.split('.');
  if (frac.length > decimals) return null;
  try {
    const v = parseUnits(s, decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/** Whole-dollar number → 18-decimal USD bigint. */
export const usd18 = (dollars: number): bigint => BigInt(Math.round(dollars)) * 10n ** 18n;

/** Display-only conversion of an 18-dec USD bigint to a JS number (for slider positions / ratios). */
export const usdToNumber = (v: bigint): number => Number(formatUnits(v, USD));
