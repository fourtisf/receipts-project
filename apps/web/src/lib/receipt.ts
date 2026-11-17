import type { ReceiptSummary } from '@receipts/shared';

export type RevealState = 'match' | 'mismatch' | 'missed' | 'pending';

/**
 * REVEALED means the registry accepted hash(signal + salt) == commit. A MISMATCH match status means the
 * vault executions differ from the revealed signal, which is flagged publicly as well.
 */
export function revealState(r: Pick<ReceiptSummary, 'status' | 'matchStatus'>): RevealState {
  if (r.status === 'MISSED') return 'missed';
  if (r.status === 'COMMITTED') return 'pending';
  return r.matchStatus === 'MISMATCH' ? 'mismatch' : 'match';
}

export function receiptHref(r: Pick<ReceiptSummary, 'strategyId' | 'nonce'>): string {
  return `/app/s/${r.strategyId}/receipt/${r.nonce}`;
}

export function strategyHref(id: number | string): string {
  return `/app/s/${id}`;
}

/** "BUY NVDA" / "SELL ETH"; null while the signal is still hidden. */
export function tradeLabel(r: Pick<ReceiptSummary, 'side' | 'asset'>): string | null {
  if (!r.side || !r.asset) return null;
  return `${r.side} ${r.asset}`;
}
