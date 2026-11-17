'use client';

import { useState, type ReactNode } from 'react';
import { defineChain, type Chain } from 'viem';
import { createConfig, http, WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  connectorsForWallets,
  lightTheme,
  RainbowKitProvider,
  type WalletList,
} from '@rainbow-me/rainbowkit';
import {
  coinbaseWallet,
  injectedWallet,
  metaMaskWallet,
  rainbowWallet,
  walletConnectWallet,
} from '@rainbow-me/rainbowkit/wallets';
import { APP_NAME, WALLETCONNECT_PROJECT_ID } from '@/lib/env';

export interface ChainInfo {
  id: number;
  name: string;
  rpcUrl: string;
  explorer: string;
}

function toChain(c: ChainInfo): Chain {
  return defineChain({
    id: c.id,
    name: c.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [c.rpcUrl] } },
    blockExplorers: { default: { name: 'Blockscout', url: c.explorer } },
  });
}

/**
 * wagmi v2 + RainbowKit for Robinhood Chain (connect / disconnect only in M3). Without a WalletConnect
 * project id only injected wallets are offered, so the build and the page never depend on that key.
 */
export function WalletProviders({ chain, children }: { chain: ChainInfo; children: ReactNode }) {
  const [state] = useState(() => {
    const c = toChain(chain);
    const wallets: WalletList = WALLETCONNECT_PROJECT_ID
      ? [
          {
            groupName: 'Popular',
            wallets: [injectedWallet, metaMaskWallet, coinbaseWallet, rainbowWallet, walletConnectWallet],
          },
        ]
      : [{ groupName: 'Installed', wallets: [injectedWallet] }];
    const connectors = connectorsForWallets(wallets, {
      appName: APP_NAME,
      projectId: WALLETCONNECT_PROJECT_ID || 'injected-only',
    });
    const config = createConfig({
      chains: [c],
      connectors,
      transports: { [c.id]: http(chain.rpcUrl) },
      ssr: true,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1 } } });
    return { config, queryClient };
  });

  return (
    <WagmiProvider config={state.config}>
      <QueryClientProvider client={state.queryClient}>
        <RainbowKitProvider
          appInfo={{ appName: APP_NAME }}
          modalSize="compact"
          theme={lightTheme({
            accentColor: '#0A0A0A',
            accentColorForeground: '#FFFFFF',
            borderRadius: 'medium',
          })}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
