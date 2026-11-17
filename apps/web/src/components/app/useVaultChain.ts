'use client';

import { useQuery } from '@tanstack/react-query';
import { useAccount, usePublicClient } from 'wagmi';
import { erc20Abi, receiptsVaultAbi, signalRegistryAbi, vaultFactoryAbi } from '@receipts/shared/abi';
import { useChainConfig, type ClientToken } from '@/lib/chain-config';

export const ZERO = '0x0000000000000000000000000000000000000000' as const;

export interface VaultToken extends ClientToken {
  listed: boolean;
  enabled: boolean;
  balance: bigint;
  /** USD per whole token, 18 decimals; null when the feed is stale or invalid right now. */
  priceUsd: bigint | null;
  /** balance × price, 18 decimals; null when the price is unavailable. */
  valueUsd: bigint | null;
}

export interface VaultChainState {
  address: `0x${string}`;
  operator: `0x${string}`;
  paused: boolean;
  marksFrozen: boolean;
  maxSlippageBps: number;
  drawdownBps: number;
  dailyLimitUsd: bigint;
  maxDailyLimitUsd: bigint;
  windowStart: bigint;
  usedInWindowUsd: bigint;
  remainingDailyUsd: bigint;
  followingId: bigint;
  allocationUsd: bigint;
  peakNav: bigint;
  hwmNav: bigint;
  /** Lenient NAV (USD 18 dec); null if it cannot be computed right now. */
  nav: bigint | null;
  exposureUsd: bigint | null;
  /**
   * Estimated creator fee due now, in USDG base units (rounded up): (navStrict − hwmNav) × min(snapshot, current
   * share) / 10 000 at the strict USDG price. It is paid from the vault's USDG first on withdraw / follow / unfollow.
   */
  pendingFeeBase: bigint;
  tokens: VaultToken[];
}

export interface OwnerChainState {
  factory: `0x${string}`;
  defaultOperator: `0x${string}`;
  maxDailyLimitUsd: bigint;
  /** Wallet USDG balance and allowance to the vault (6 decimals). */
  walletBase: bigint;
  allowance: bigint;
  vault: VaultChainState | null;
}

/** Everything the vault page needs, read straight from Robinhood Chain (the indexer is only used for history). */
export function useVaultChain() {
  const { address } = useAccount();
  const client = usePublicClient();
  const cfg = useChainConfig();
  const base = cfg.tokens.find((t) => t.kind === 'base');

  return useQuery<OwnerChainState>({
    queryKey: ['vaultChain', address?.toLowerCase(), cfg.factory],
    enabled: Boolean(address && client && cfg.factory && base),
    refetchInterval: 8_000,
    queryFn: async () => {
      if (!address || !client || !cfg.factory || !base) throw new Error('not ready');
      const factory = cfg.factory;
      const [vaultAddr, defaultOperator, maxDailyLimitUsd, walletBase] = await client.multicall({
        allowFailure: false,
        contracts: [
          { address: factory, abi: vaultFactoryAbi, functionName: 'vaultOf', args: [address] },
          { address: factory, abi: vaultFactoryAbi, functionName: 'defaultOperator' },
          { address: factory, abi: vaultFactoryAbi, functionName: 'MAX_DAILY_LIMIT_USD' },
          { address: base.address, abi: erc20Abi, functionName: 'balanceOf', args: [address] },
        ],
      });
      const out: OwnerChainState = {
        factory,
        defaultOperator,
        maxDailyLimitUsd,
        walletBase,
        allowance: 0n,
        vault: null,
      };
      if (vaultAddr === ZERO) return out;

      const v = { address: vaultAddr, abi: receiptsVaultAbi } as const;
      const fixed = await client.multicall({
        allowFailure: true,
        contracts: [
          { ...v, functionName: 'operator' },
          { ...v, functionName: 'paused' },
          { ...v, functionName: 'marksFrozen' },
          { ...v, functionName: 'maxSlippageBps' },
          { ...v, functionName: 'drawdownBps' },
          { ...v, functionName: 'dailyLimitUsd' },
          { ...v, functionName: 'maxDailyLimitUsd' },
          { ...v, functionName: 'windowStart' },
          { ...v, functionName: 'usedInWindowUsd' },
          { ...v, functionName: 'remainingDailyUsd' },
          { ...v, functionName: 'followingId' },
          { ...v, functionName: 'allocationUsd' },
          { ...v, functionName: 'peakNav' },
          { ...v, functionName: 'hwmNav' },
          { ...v, functionName: 'navLenient' },
          { ...v, functionName: 'exposureUsd' },
          { address: base.address, abi: erc20Abi, functionName: 'allowance', args: [address, vaultAddr] },
          { ...v, functionName: 'navStrict' },
          { ...v, functionName: 'creatorShareSnapshot' },
        ],
      });
      const ok = <T>(r: { status: 'success'; result: T } | { status: 'failure' }): T | null =>
        r.status === 'success' ? r.result : null;
      const need = <T>(r: { status: 'success'; result: T } | { status: 'failure' }, what: string): T => {
        const x = ok(r);
        if (x === null) throw new Error(`Could not read ${what} from your vault. Try again in a moment.`);
        return x;
      };

      const [cfgRes, balRes, priceRes] = await Promise.all([
        client.multicall({
          allowFailure: true,
          contracts: cfg.tokens.map((t) => ({
            ...v,
            functionName: 'tokenConfig' as const,
            args: [t.address] as const,
          })),
        }),
        client.multicall({
          allowFailure: true,
          contracts: cfg.tokens.map((t) => ({
            address: t.address,
            abi: erc20Abi,
            functionName: 'balanceOf' as const,
            args: [vaultAddr] as const,
          })),
        }),
        client.multicall({
          allowFailure: true,
          contracts: cfg.tokens.map((t) => ({
            ...v,
            functionName: 'priceUsd' as const,
            args: [t.address] as const,
          })),
        }),
      ]);

      const tokens: VaultToken[] = cfg.tokens.map((t, i) => {
        const c = ok(cfgRes[i]!);
        const balance = ok(balRes[i]!) ?? 0n;
        const priceUsd = ok(priceRes[i]!);
        return {
          ...t,
          listed: c ? c[0] : false,
          enabled: c ? c[1] : false,
          decimals: c ? c[2] : t.decimals,
          balance,
          priceUsd,
          valueUsd: priceUsd === null ? null : (balance * priceUsd) / 10n ** BigInt(c ? c[2] : t.decimals),
        };
      });

      out.allowance = ok(fixed[16]!) ?? 0n;
      const followingId = need(fixed[10]!, 'the strategy');
      const hwm = need(fixed[13]!, 'the high-water mark');
      const navStrict = ok(fixed[17]!);
      const snapshot = ok(fixed[18]!) ?? 0;
      let pendingFeeBase = 0n;
      const baseTok = tokens.find((t) => t.kind === 'base');
      if (followingId > 0n && navStrict !== null && navStrict > hwm && baseTok?.priceUsd) {
        const current = cfg.registry
          ? await client
              .readContract({
                address: cfg.registry,
                abi: signalRegistryAbi,
                functionName: 'creatorShareOf',
                args: [followingId],
              })
              .catch(() => snapshot)
          : snapshot;
        const share = BigInt(Math.min(snapshot, current));
        const feeUsd = ((navStrict - hwm) * share) / 10_000n;
        const unit = 10n ** BigInt(baseTok.decimals);
        pendingFeeBase = (feeUsd * unit + baseTok.priceUsd - 1n) / baseTok.priceUsd;
      }
      out.vault = {
        address: vaultAddr,
        operator: need(fixed[0]!, 'the operator'),
        paused: need(fixed[1]!, 'the pause state'),
        marksFrozen: need(fixed[2]!, 'the marks'),
        maxSlippageBps: need(fixed[3]!, 'the slippage limit'),
        drawdownBps: need(fixed[4]!, 'the breaker'),
        dailyLimitUsd: need(fixed[5]!, 'the daily limit'),
        maxDailyLimitUsd: ok(fixed[6]!) ?? maxDailyLimitUsd,
        windowStart: need(fixed[7]!, 'the daily window'),
        usedInWindowUsd: need(fixed[8]!, 'the daily window'),
        remainingDailyUsd: need(fixed[9]!, 'the daily window'),
        followingId,
        allocationUsd: need(fixed[11]!, 'the allocation'),
        peakNav: need(fixed[12]!, 'the peak'),
        hwmNav: hwm,
        nav: ok(fixed[14]!),
        exposureUsd: ok(fixed[15]!),
        pendingFeeBase,
        tokens,
      };
      return out;
    },
  });
}
