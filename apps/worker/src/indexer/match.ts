/**
 * Match check (WORKER.md §1): after a reveal, every execution of the commit must use the revealed token pair and
 * direction, and must not be larger than the signal allows. Under-sizing is accepted (the executor clamps to the
 * remaining daily limit, the vault's balance and allocation headroom); over-sizing beyond the 2% tolerance is a
 * mismatch because it moves more of the follower's money than the strategy committed to.
 */
export interface MatchSignal {
  tokenIn: string;
  tokenOut: string;
  sizeBps: number;
}

export interface MatchExecution {
  vault: string;
  tokenIn: string;
  tokenOut: string;
  /** USD, 18 decimals (from the Executed event) */
  valueUsd: bigint;
  /** vault allocation at execution time, USD 18 decimals; null if unknown */
  allocationUsd: bigint | null;
}

export type MatchResult =
  | { status: 'MATCH'; note: string | null }
  | { status: 'MISMATCH'; note: string }
  | { status: 'NO_EXECUTION'; note: null };

export const SIZE_TOLERANCE_BPS = 200n; // ±2%

export function matchCheck(
  signal: MatchSignal,
  base: string,
  executions: readonly MatchExecution[],
): MatchResult {
  if (executions.length === 0) return { status: 'NO_EXECUTION', note: null };
  const sIn = signal.tokenIn.toLowerCase();
  const sOut = signal.tokenOut.toLowerCase();
  const b = base.toLowerCase();
  if (!Number.isInteger(signal.sizeBps) || signal.sizeBps < 1 || signal.sizeBps > 10_000) {
    return { status: 'MISMATCH', note: `Revealed size ${signal.sizeBps} bps is outside 1–10000.` };
  }
  const problems: string[] = [];
  const notes: string[] = [];
  for (const e of executions) {
    const eIn = e.tokenIn.toLowerCase();
    const eOut = e.tokenOut.toLowerCase();
    if (eIn !== sIn || eOut !== sOut) {
      problems.push(`Vault ${e.vault} traded ${eIn}→${eOut}; the revealed signal was ${sIn}→${sOut}.`);
      continue;
    }
    if (sIn === b && e.allocationUsd !== null && e.allocationUsd > 0n) {
      const expected = (e.allocationUsd * BigInt(signal.sizeBps)) / 10_000n;
      const maxAllowed = (expected * (10_000n + SIZE_TOLERANCE_BPS)) / 10_000n;
      if (e.valueUsd > maxAllowed) {
        problems.push(
          `Vault ${e.vault} bought $${fmt(e.valueUsd)}; the signal allows at most $${fmt(expected)} (+2%).`,
        );
      } else if (e.valueUsd * 10_000n < expected * (10_000n - SIZE_TOLERANCE_BPS)) {
        notes.push(
          `Vault ${e.vault} was clamped to $${fmt(e.valueUsd)} (daily limit, balance or allocation).`,
        );
      }
    }
  }
  if (problems.length > 0) return { status: 'MISMATCH', note: problems.join(' ') };
  return { status: 'MATCH', note: notes.length ? notes.join(' ') : null };
}

function fmt(v18: bigint): string {
  const cents = v18 / 10n ** 16n;
  const s = cents.toString().padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}
