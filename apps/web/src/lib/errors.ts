import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Abi, type Hex } from 'viem';
import { tokenByAddress } from '@receipts/shared';
import { fmtToken, formatUsd18 } from './units';

/** OpenZeppelin 5 ERC20 errors (USDG and stock tokens revert with these inside deposit / approve). */
const ERC20_ERRORS = [
  {
    type: 'error',
    name: 'ERC20InsufficientBalance',
    inputs: [
      { name: 'sender', type: 'address' },
      { name: 'balance', type: 'uint256' },
      { name: 'needed', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'ERC20InsufficientAllowance',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'allowance', type: 'uint256' },
      { name: 'needed', type: 'uint256' },
    ],
  },
] as const satisfies Abi;

const sym = (a: unknown) =>
  typeof a === 'string' ? (tokenByAddress(a)?.symbol ?? `${a.slice(0, 6)}…${a.slice(-4)}`) : 'a token';

/** Plain-language message for a decoded custom error: what went wrong and how to fix it. */
export function customErrorMessage(name: string, args: readonly unknown[] = []): string {
  switch (name) {
    case 'NotOwner':
      return 'Only the wallet that owns this vault can do that. Switch to the owner wallet and try again.';
    case 'VaultExists':
      return 'This wallet already has a vault. Reload the page to open it.';
    case 'NotFollowing':
      return 'The vault is not copying a strategy right now.';
    case 'StrategyInactive':
      return 'This strategy has been deactivated by its creator, so it cannot be copied. Pick another strategy.';
    case 'SlippageTooHigh':
      return 'Max slippage can be at most 5%. Lower it and try again.';
    case 'DailyLimitTooHigh':
      return 'That daily limit is above the beta cap for vaults. Lower it and try again.';
    case 'BadDrawdown':
      return 'The drawdown breaker must be between 5% and 50%.';
    case 'PricesStale':
      return 'A Chainlink price for a token in your vault is stale right now (stock feeds pause on weekends). Try again when it updates. Pause, revoke and withdraw still work.';
    case 'StaleOraclePrice':
      return `The Chainlink price for ${sym(args[0])} is stale right now. Try again when it updates; withdrawals still work.`;
    case 'BadOraclePrice':
      return `The Chainlink price for ${sym(args[0])} is invalid right now. Try again later; withdrawals still work.`;
    case 'TokenNotAllowed':
      return `${sym(args[0])} can't be changed here (USDG must stay enabled, and only listed tokens are allowed).`;
    case 'MarksNotFrozen':
      return 'Marks are not frozen, so there is nothing to reset.';
    case 'MarksAreFrozen':
      return 'Marks are frozen. Reset them first, then try again.';
    case 'ZeroAmount':
      return 'Enter an amount above 0.';
    case 'ZeroAddress':
      return 'A required address is empty.';
    case 'DailyLimitExceeded':
      return `That exceeds the daily limit: ${formatUsd18(args[0])} requested, ${formatUsd18(args[1])} left in this window.`;
    case 'AllocationExceeded':
      return 'That would exceed the allocation cap for this vault.';
    case 'BadShare':
      return 'The creator share can be at most 30%. Lower it and try again.';
    case 'BadWindow':
      return 'The reveal window must be between 10 minutes and 24 hours.';
    case 'NotCreator':
      return 'Only the strategy creator can do that. Switch to the creator wallet.';
    case 'UnknownStrategy':
      return 'That strategy does not exist on-chain.';
    case 'TokenHeld':
      return `Your vault holds ${sym(args[0])} and is copying a strategy, so it can't be turned off. Withdraw it first (this settles the creator fee), then turn it off.`;
    case 'FeeUnpaid':
      return `A creator fee of ${typeof args[0] === 'bigint' ? fmtToken(args[0], 6, 2) : 'some'} USDG is due on profit above your high-water mark, but the vault holds only ${typeof args[1] === 'bigint' ? fmtToken(args[1], 6, 2) : 'less'} USDG. Deposit USDG (or withdraw a position) and try again.`;
    case 'ERC20InsufficientBalance':
      return 'There is not enough of that token for this transfer. Lower the amount.';
    case 'ERC20InsufficientAllowance':
      return 'The vault is not allowed to pull that much USDG yet. Approve the amount first, then deposit.';
    default:
      return `The contract rejected the transaction (${name}).`;
  }
}

function errorsOf(e: BaseError): { name: string; args: readonly unknown[] } | null {
  const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError) {
    if (reverted.data?.errorName) return { name: reverted.data.errorName, args: reverted.data.args ?? [] };
    const raw = (reverted as unknown as { raw?: Hex }).raw;
    if (raw) {
      try {
        const d = decodeErrorResult({ abi: ERC20_ERRORS, data: raw });
        return { name: d.errorName, args: d.args };
      } catch {
        /* unknown selector */
      }
    }
    if (reverted.reason) return { name: `reason:${reverted.reason}`, args: [] };
  }
  return null;
}

/** What went wrong with a wallet / contract call, and how to fix it. */
export function txErrorMessage(e: unknown): string {
  const text = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  if (/user rejected|user denied|rejected the request|UserRejectedRequestError|4001/i.test(text))
    return 'You rejected the request in your wallet. Nothing was sent.';
  if (e instanceof BaseError) {
    const ce = errorsOf(e);
    if (ce?.name.startsWith('reason:')) return `The contract rejected the transaction: ${ce.name.slice(7)}.`;
    if (ce) return customErrorMessage(ce.name, ce.args);
    if (/insufficient funds/i.test(text))
      return 'Your wallet needs a little ETH on Robinhood Chain to pay gas. Add some and try again.';
    if (/chain mismatch|does not match the target chain|ChainMismatch/i.test(text))
      return 'Switch your wallet to Robinhood Chain and try again.';
    if (/ConnectorNotConnected|connector not connected/i.test(text)) return 'Connect your wallet first.';
    return e.shortMessage || 'The transaction failed. Try again in a moment.';
  }
  return e instanceof Error ? e.message : 'Something went wrong. Try again in a moment.';
}
