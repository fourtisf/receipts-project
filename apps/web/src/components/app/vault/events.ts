import { tokenByAddress, type Vault } from '@receipts/shared';
import { shortAddr } from '@/lib/address';
import { bpsPct, dateUtc, timeUtc, tokenAmount } from '@/lib/format';

type VaultEvent = Vault['events'][number];
const ZERO = '0x0000000000000000000000000000000000000000';

const str = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
/** 18-decimal fixed point (on-chain USD) → decimal string. */
const usd18 = (v: unknown) => tokenAmount(str(v) || '0', 18, 2);

/** "14:05" for the last 24 hours (UTC), else "Oct 13". */
export function logTime(iso: string): string {
  const t = new Date(iso);
  if (Date.now() - t.getTime() < 86_400_000) return timeUtc(iso).slice(0, 5);
  return dateUtc(iso);
}

/** One human line per indexed vault event. */
export function describeEvent(e: VaultEvent, names: Record<string, string> = {}): string {
  const d = e.data;
  const strat = (id: unknown) => names[str(id)] ?? `strategy #${str(id)}`;
  switch (e.type) {
    case 'CREATED':
      return 'Vault created';
    case 'DEPOSITED':
      return `Deposited ${tokenAmount(str(d.amount) || '0', 6, 2)} USDG`;
    case 'WITHDRAWN': {
      const t = tokenByAddress(str(d.token));
      return `Withdrew ${tokenAmount(str(d.amount) || '0', t?.decimals ?? 18, 4)} ${t?.symbol ?? 'tokens'} to your wallet`;
    }
    case 'FOLLOWED':
      return `Started copying ${strat(d.strategyId)} with ${usd18(d.allocationUsd)} USD`;
    case 'UNFOLLOWED':
      return `Stopped copying ${strat(d.strategyId)}`;
    case 'ALLOCATION':
      return `Allocation set to ${usd18(d.allocationUsd)} USD`;
    case 'LIMITS':
      return `Limits set: ${usd18(d.dailyLimitUsd)} USDG a day, ${bpsPct(Number(d.maxSlippageBps), 1)} slippage, breaker at −${bpsPct(Number(d.drawdownBps), 0)}`;
    case 'PAUSED':
      return d.paused ? 'Paused trading' : 'Resumed trading';
    case 'OPERATOR':
      return str(d.current).toLowerCase() === ZERO
        ? 'Revoked bot access'
        : `Gave bot access to ${shortAddr(str(d.current))}`;
    case 'TOKEN': {
      const t = tokenByAddress(str(d.token));
      return `${d.enabled ? 'Allowed' : 'Turned off'} ${t?.symbol ?? shortAddr(str(d.token))}`;
    }
    case 'BREAKER':
      return 'Drawdown breaker tripped; trading paused';
    case 'PEAK_RESET':
      return 'Peak reset; breaker re-armed';
    case 'MARKS_FROZEN':
      return 'Marks frozen';
    case 'MARKS_RESET':
      return 'Marks reset';
    case 'FEES_SETTLED':
      return 'Creator fee settled';
    case 'FEE_DEFERRED':
      return 'Creator fee deferred (not enough USDG in the vault)';
    default:
      return e.type.toLowerCase().replace(/_/g, ' ');
  }
}
