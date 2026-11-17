'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { defineChain, type Chain } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { createConfig, http, useAccount, WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  connectorsForWallets,
  createAuthenticationAdapter,
  lightTheme,
  RainbowKitAuthenticationProvider,
  RainbowKitProvider,
  type AuthenticationStatus,
  type WalletList,
} from '@rainbow-me/rainbowkit';
import {
  coinbaseWallet,
  injectedWallet,
  metaMaskWallet,
  rainbowWallet,
  walletConnectWallet,
} from '@rainbow-me/rainbowkit/wallets';
import {
  authMeSchema as meSchema,
  authNonceSchema as nonceSchema,
  authSessionSchema as sessionSchema,
} from '@receipts/shared';
import { APP_NAME, PUBLIC_API_BASE, WALLETCONNECT_PROJECT_ID } from '@/lib/env';
import { ChainConfigProvider, type ClientChainConfig } from '@/lib/chain-config';
import { ToastProvider, useToast } from '@/components/Toast';

/** Multicall3 is deployed at its canonical address on Robinhood Chain. */
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

function toChain(c: ClientChainConfig): Chain {
  return defineChain({
    id: c.chainId,
    name: c.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [c.rpcUrl] } },
    blockExplorers: { default: { name: 'Blockscout', url: c.explorer } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
}

// ───────────────────────── SIWE session (EIP-4361 → httpOnly cookie set by the API)

interface Session {
  status: AuthenticationStatus;
  /** Lowercase address of the signed-in wallet, if any. */
  address: string | null;
  /** false when the API cannot be reached: wallets still connect, API-backed actions are unavailable. */
  available: boolean;
}

const SessionCtx = createContext<Session>({ status: 'loading', address: null, available: true });

/** Sign-in state for API-backed actions (backtest, create strategy). Vault transactions need no session. */
export function useSession(): Session {
  return useContext(SessionCtx);
}

function SiweAuth({ cfg, children }: { cfg: ClientChainConfig; children: ReactNode }) {
  const { address, isConnected } = useAccount();
  const toast = useToast();
  const [sessionAddr, setSessionAddr] = useState<string | null | undefined>(undefined);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch(`${PUBLIC_API_BASE}/auth/session`, { cache: 'no-store', credentials: 'same-origin' })
      .then(async (r) => {
        if (cancelled) return;
        if (r.ok) setSessionAddr(sessionSchema.parse(await r.json()).address?.toLowerCase() ?? null);
        else {
          setAvailable(false);
          setSessionAddr(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAvailable(false);
          setSessionAddr(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const status: AuthenticationStatus =
    sessionAddr === undefined
      ? 'loading'
      : sessionAddr && (!isConnected || sessionAddr === address?.toLowerCase())
        ? 'authenticated'
        : 'unauthenticated';

  const notify = useCallback((m: string, tone: 'ok' | 'error') => toast({ message: m, tone }), [toast]);

  const adapter = useMemo(() => {
    // the API tells us the exact domain / uri it verifies; fall back to the server-provided values
    let expected = { domain: cfg.siweDomain, uri: cfg.siweUri };
    return createAuthenticationAdapter<string>({
      getNonce: async () => {
        const r = await fetch(`${PUBLIC_API_BASE}/auth/nonce`, { cache: 'no-store' });
        if (!r.ok) throw new Error('Could not start sign-in. Try again in a moment.');
        const n = nonceSchema.parse(await r.json());
        expected = { domain: n.domain ?? cfg.siweDomain, uri: n.uri ?? cfg.siweUri };
        return n.nonce;
      },
      createMessage: ({ nonce, address: addr, chainId }) =>
        createSiweMessage({
          domain: expected.domain,
          address: addr,
          statement: `Sign in to ${APP_NAME}. This only proves you own this wallet: it is not a transaction and costs no gas.`,
          uri: expected.uri,
          version: '1',
          chainId,
          nonce,
          issuedAt: new Date(),
          expirationTime: new Date(Date.now() + 10 * 60_000),
        }),
      verify: async ({ message, signature }) => {
        const r = await fetch(`${PUBLIC_API_BASE}/auth/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ message, signature }),
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
          notify(body?.error?.message ?? 'Sign-in failed. Try again.', 'error');
          return false;
        }
        const me = meSchema.parse(await r.json());
        setSessionAddr(me.address.toLowerCase());
        notify('Signed in. No transaction, no gas.', 'ok');
        return true;
      },
      signOut: async () => {
        await fetch(`${PUBLIC_API_BASE}/auth/logout`, { method: 'POST', credentials: 'same-origin' }).catch(
          () => undefined,
        );
        setSessionAddr(null);
      },
    });
  }, [cfg.siweDomain, cfg.siweUri, notify]);

  const session = useMemo<Session>(
    () => ({ status, address: status === 'authenticated' ? (sessionAddr ?? null) : null, available }),
    [status, sessionAddr, available],
  );

  return (
    <SessionCtx.Provider value={session}>
      <RainbowKitAuthenticationProvider adapter={adapter} status={status} enabled={available}>
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
      </RainbowKitAuthenticationProvider>
    </SessionCtx.Provider>
  );
}

/**
 * wagmi v2 + RainbowKit for Robinhood Chain with SIWE sign-in. Without a WalletConnect project id only injected
 * wallets are offered, so the build and the page never depend on that key.
 */
export function WalletProviders({ config, children }: { config: ClientChainConfig; children: ReactNode }) {
  const [state] = useState(() => {
    const c = toChain(config);
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
    const wagmiConfig = createConfig({
      chains: [c],
      connectors,
      transports: { [c.id]: http(config.rpcUrl, { batch: true }) },
      ssr: true,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: 1 } } });
    return { wagmiConfig, queryClient };
  });

  return (
    <ChainConfigProvider value={config}>
      <WagmiProvider config={state.wagmiConfig}>
        <QueryClientProvider client={state.queryClient}>
          <ToastProvider>
            <SiweAuth cfg={config}>{children}</SiweAuth>
          </ToastProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </ChainConfigProvider>
  );
}
