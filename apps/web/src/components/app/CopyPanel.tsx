'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useAccount } from 'wagmi';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { receiptsVaultAbi } from '@receipts/shared/abi';
import { useChainConfig } from '@/lib/chain-config';
import { fmtUnits, parseAmount, USD } from '@/lib/units';
import { useToast } from '@/components/Toast';
import { useTx } from './useTx';
import { useVaultChain } from './useVaultChain';
import { tradesStocks, useGeo } from './useApi';

const US_NOTICE = 'Robinhood Stock Tokens are not available to US persons.';

/** "Copy into your vault": follow this strategy with an allocation (user-signed `follow`). */
export function CopyPanel({
  strategy,
}: {
  strategy: { id: number; name: string; category: string; active: boolean };
}) {
  const cfg = useChainConfig();
  const toast = useToast();
  const { openConnectModal } = useConnectModal();
  const { isConnected } = useAccount();
  const chain = useVaultChain();
  const geo = useGeo();
  const { run, busy } = useTx();
  const [amt, setAmt] = useState('');

  const stocks = tradesStocks(strategy.category);
  const blocked = stocks && geo.data?.stocksBlocked === true;
  const vault = chain.data?.vault ?? null;
  const followingThis = vault !== null && vault.followingId === BigInt(strategy.id);
  const followingOther = vault !== null && vault.followingId > 0n && !followingThis;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!vault) return;
    const a = parseAmount(amt, USD);
    if (!a) return toast({ message: 'Enter an amount above 0 USD to allocate.', tone: 'error' });
    const v = { address: vault.address, abi: receiptsVaultAbi } as const;
    const r = followingThis
      ? await run(
          'Update allocation',
          { ...v, functionName: 'setAllocation', args: [a] },
          { success: 'Allocation updated.' },
        )
      : await run(
          `Copy ${strategy.name}`,
          { ...v, functionName: 'follow', args: [BigInt(strategy.id), a] },
          { success: `Copying ${strategy.name} with up to ${fmtUnits(a, USD)} USD.` },
        );
    if (r) setAmt('');
  };

  let help: string;
  if (!isConnected) help = 'Connect a wallet to see your vault balance.';
  else if (!cfg.factory) help = 'The vault contracts are not deployed on this network yet.';
  else if (chain.isPending) help = 'Reading your vault…';
  else if (!vault) help = 'You need a vault first. It takes one transaction.';
  else
    help = `Vault balance: ${vault.nav === null ? '—' : fmtUnits(vault.nav, USD)} USD${
      followingThis ? ` · allocated ${fmtUnits(vault.allocationUsd, USD)} USD` : ''
    }`;

  const disabled = blocked || !strategy.active || busy !== null;

  return (
    <div className="card">
      <h2>Copy into your vault</h2>
      <p className="sub">The strategy trades your vault within your limits. Stop it or withdraw any time.</p>
      {followingThis ? <p className="status !mt-0">You are copying this strategy</p> : null}
      <form onSubmit={(e) => void submit(e)}>
        <label className="field" htmlFor="copyAmt">
          {followingThis ? 'New allocation' : 'Amount to allocate'}
        </label>
        <div className="flex items-center gap-2">
          <input
            className="input"
            id="copyAmt"
            inputMode="decimal"
            placeholder={vault?.nav ? fmtUnits(vault.nav, USD, 0).replace(/,/g, '') : '250'}
            value={amt}
            onChange={(e) => setAmt(e.target.value)}
            disabled={!vault || disabled}
            aria-describedby="copyHelp"
          />
          <span className="unit">USD</span>
        </div>
        <p className="help" id="copyHelp">
          {help}
        </p>
        <div className="h-4" />
        {!isConnected ? (
          <button className="btn btn-dark btn-lg w-full" type="button" onClick={openConnectModal}>
            Connect wallet to copy
          </button>
        ) : !vault ? (
          chain.isPending || !cfg.factory ? (
            <button className="btn btn-dark btn-lg w-full" type="button" disabled>
              Create a vault first
            </button>
          ) : (
            <Link className="btn btn-dark btn-lg w-full" href={`/app/vault?follow=${strategy.id}`}>
              Create a vault first
            </Link>
          )
        ) : (
          <button className="btn btn-dark btn-lg w-full" type="submit" disabled={disabled}>
            {followingThis ? 'Update allocation' : `Copy ${strategy.name}`}
          </button>
        )}
      </form>
      {followingThis && vault ? (
        <button
          type="button"
          className="btn mt-2 w-full"
          onClick={() =>
            void run(
              'Stop copying',
              { address: vault.address, abi: receiptsVaultAbi, functionName: 'unfollow', args: [] },
              { success: `Stopped copying ${strategy.name}.` },
            )
          }
        >
          Stop copying
        </button>
      ) : null}
      {followingOther ? (
        <p className="help">
          Copying this replaces the strategy your vault follows now (any fee owed is settled first).
        </p>
      ) : null}
      {!strategy.active ? (
        <p className="notice warn mt-3">This strategy was deactivated by its creator and cannot be copied.</p>
      ) : null}
      {stocks ? (
        <p className={`notice mt-3${blocked ? ' warn' : ''}`}>
          {geo.data?.notice ?? US_NOTICE}
          {blocked ? ' Copying stock-token strategies is not available in your region.' : ''}
        </p>
      ) : null}
    </div>
  );
}
