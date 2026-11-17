'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useAccount } from 'wagmi';
import { useChainConfig } from '@/lib/chain-config';
import { strategyHref } from '@/lib/receipt';
import { usdToNumber } from '@/lib/units';
import { useMyVault } from './useVault';
import { useVaultChain } from './useVaultChain';
import { VaultSetup } from './vault/VaultSetup';
import { VaultDashboard } from './vault/VaultDashboard';

/**
 * /app/vault: create-vault flow, or the dashboard of the connected wallet's vault. Balances, limits and state are read
 * from the chain; the activity log comes from the indexer.
 */
export function VaultView({ followId, followName }: { followId: number | null; followName: string | null }) {
  const cfg = useChainConfig();
  const { isConnected, status } = useAccount();
  const chain = useVaultChain();
  // the indexer's copy (activity log) is only asked for once the chain says a vault exists
  const api = useMyVault(Boolean(chain.data?.vault));
  const cap = cfg.maxDailyLimitUsd ? Number(cfg.maxDailyLimitUsd) : 2000;
  // keep the setup view mounted until its multi-transaction flow has finished
  const [creating, setCreating] = useState(false);

  if (status === 'reconnecting' || status === 'connecting')
    return <div className="empty">Connecting to your wallet…</div>;
  if (!isConnected || !cfg.factory)
    return <VaultSetup connected={false} maxDailyLimit={cap} deployed={Boolean(cfg.factory)} />;
  if (chain.isPending) return <div className="empty">Reading your vault from Robinhood Chain…</div>;
  if (chain.isError || !chain.data)
    return (
      <div className="error" role="alert">
        Your vault could not be read from Robinhood Chain: {chain.error?.message ?? 'unknown error'}. Check
        your connection and reload; your funds are not affected.
      </div>
    );
  const data = chain.data;
  if (!data.vault || creating)
    return (
      <>
        {followId ? (
          <p className="notice mb-5">
            Create your vault first. Then deposit USDG and copy{' '}
            <Link className="linkbtn" href={strategyHref(followId)}>
              {followName ?? `strategy #${followId}`}
            </Link>
            .
          </p>
        ) : null}
        <VaultSetup
          connected
          maxDailyLimit={Math.floor(usdToNumber(data.maxDailyLimitUsd))}
          deployed
          onBusy={setCreating}
        />
      </>
    );
  return (
    <>
      {followId && data.vault.followingId !== BigInt(followId) ? (
        <p className="notice ok mb-5">
          Your vault is ready.{' '}
          {data.vault.nav === null || data.vault.nav === 0n ? 'Deposit USDG below, then ' : ''}
          <Link className="linkbtn !text-inherit" href={strategyHref(followId)}>
            copy {followName ?? `strategy #${followId}`}
          </Link>
          .
        </p>
      ) : null}
      <VaultDashboard chain={data} vault={data.vault} apiVault={api.vault ?? null} />
    </>
  );
}
