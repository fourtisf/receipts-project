'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';
import { shortAddr } from '@/lib/address';

/** Topbar wallet button styled like the prototype (`.btn.btn-sm`). Connect / disconnect only. */
export function WalletButton() {
  return (
    <ConnectButton.Custom>
      {({ account, chain, mounted, openAccountModal, openChainModal, openConnectModal }) => {
        if (!mounted)
          return (
            <button className="btn btn-sm invisible" type="button" tabIndex={-1} aria-hidden="true">
              Connect wallet
            </button>
          );
        if (!account)
          return (
            <button className="btn btn-sm" type="button" onClick={openConnectModal}>
              Connect wallet
            </button>
          );
        if (chain?.unsupported)
          return (
            <button className="btn btn-sm" type="button" onClick={openChainModal}>
              Switch to Robinhood Chain
            </button>
          );
        return (
          <button
            className="btn btn-sm"
            type="button"
            onClick={openAccountModal}
            aria-label={`Wallet ${account.address}. Open account menu`}
          >
            {shortAddr(account.address)}
          </button>
        );
      }}
    </ConnectButton.Custom>
  );
}
