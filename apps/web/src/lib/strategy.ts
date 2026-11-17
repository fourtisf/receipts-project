import type { StrategyListItem } from '@receipts/shared';
import { APP_NAME } from './env';
import { shortAddr } from './address';

/** "Receipts house" for house strategies, else the creator's short address. */
export function creatorLabel(s: Pick<StrategyListItem, 'kind' | 'creator'>): string {
  return s.kind === 'HOUSE' ? `${APP_NAME} house` : shortAddr(s.creator);
}

/** Creator share in bps → "15%". */
export function sharePct(bps: number): string {
  return `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
}

export const CATEGORIES = [
  ['all', 'All'],
  ['crypto', 'Crypto'],
  ['stock', 'Stock tokens'],
  ['ai', 'AI'],
] as const;
export const SORTS = [
  ['vs', 'Return vs holding'],
  ['ret', '30-day return'],
  ['dd', 'Smallest drawdown'],
  ['vaults', 'Most followed'],
] as const;
export type Category = (typeof CATEGORIES)[number][0];
export type Sort = (typeof SORTS)[number][0];

export const isCategory = (v: unknown): v is Category => CATEGORIES.some(([c]) => c === v);
export const isSort = (v: unknown): v is Sort => SORTS.some(([s]) => s === v);
