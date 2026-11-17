'use client';

import { useConnectModal } from '@rainbow-me/rainbowkit';
import { amount } from '@/lib/format';
import { useMyVault } from './useVault';

/** Read-only in M3: the copy settings are shown but disabled; copying (a signed transaction) lands in M4. */
export function CopyPanel({ strategyName }: { strategyName: string }) {
  const { openConnectModal } = useConnectModal();
  const { isConnected, vault, loading } = useMyVault();

  const help = !isConnected
    ? 'Connect a wallet to see your vault balance.'
    : loading
      ? 'Reading your vault…'
      : vault
        ? `Vault balance: ${amount(vault.navUsd)} USD`
        : 'You need a vault first. It takes one transaction.';

  return (
    <div className="card">
      <h2>Copy into your vault</h2>
      <p className="sub">The strategy trades your vault within your limits. Stop it or withdraw any time.</p>
      <label className="field" htmlFor="copyAmt">
        Amount to allocate
      </label>
      <div className="flex items-center gap-2">
        <input
          className="input"
          id="copyAmt"
          inputMode="decimal"
          placeholder="Amount"
          disabled
          aria-describedby="copyHelp"
        />
        <span className="unit">USDG</span>
      </div>
      <p className="help" id="copyHelp">
        {help}
      </p>
      <div className="h-4" />
      {!isConnected ? (
        <button className="btn btn-dark btn-lg w-full" type="button" onClick={openConnectModal}>
          Connect wallet to copy
        </button>
      ) : (
        <>
          <button className="btn btn-dark btn-lg w-full" type="button" disabled>
            Copy {strategyName}
          </button>
          <p className="help">
            Copying from this site opens in the next release. Nothing is signed on this page yet.
          </p>
        </>
      )}
    </div>
  );
}
