'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';
import { shortAddr } from '@/lib/address';

/**
 * Topbar wallet button (`.btn.btn-sm` as in the prototype): connect → sign in with Ethereum (a signed message,
 * no gas) → address. Signing in is what lets the API run backtests and store strategy metadata for you.
 */
export function WalletButton() {
  return (
    <ConnectButton.Custom>
      {({
        account,
        chain,
        mounted,
        authenticationStatus,
        openAccountModal,
        openChainModal,
        openConnectModal,
      }) => {
        if (!mounted || authenticationStatus === 'loading')
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
        if (authenticationStatus === 'unauthenticated')
          return (
            <button
              className="btn btn-sm"
              type="button"
              onClick={openConnectModal}
              title="Sign a message to prove you own this wallet. No transaction, no gas."
            >
              Sign in <span className="font-normal text-muted">· no gas</span>
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
