import type { ClientToken } from '@/lib/chain-config';

/** Oracle deviation lag assumed in the worst case (SECURITY.md §1). */
export const ORACLE_LAG_BPS = 50;

/** Highest pinned pool fee among the given tokens, in bps (Uniswap fee tier 3000 = 0.30% = 30 bps). */
export function maxPoolFeeBps(tokens: Pick<ClientToken, 'feeTier' | 'kind'>[]): number {
  return tokens.filter((t) => t.kind !== 'base').reduce((m, t) => Math.max(m, t.feeTier / 100), 0);
}

/**
 * Worst case per day if the executor key were stolen, for these limits:
 * dailyLimit × (max slippage + pool fee + oracle lag). Returns USD cents (integer math on whole-dollar limits).
 */
export function worstCaseCents(dailyLimitUsd: number, slippageBps: number, poolFeeBps: number): number {
  return Math.round((dailyLimitUsd * (slippageBps + poolFeeBps + ORACLE_LAG_BPS)) / 100);
}

/** Same for an on-chain 18-decimal limit; returns USD 18 decimals. */
export function worstCaseUsd18(dailyLimitUsd: bigint, slippageBps: number, poolFeeBps: number): bigint {
  const bps = BigInt(Math.round((slippageBps + poolFeeBps + ORACLE_LAG_BPS) * 100));
  return (dailyLimitUsd * bps) / 1_000_000n;
}

export function bpsLabel(bps: number): string {
  return `${(bps / 100).toFixed(bps % 10 === 0 ? (bps % 100 === 0 ? 0 : 1) : 2)}%`;
}
