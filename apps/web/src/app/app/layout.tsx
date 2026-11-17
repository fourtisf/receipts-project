import type { Metadata } from 'next';
import '@rainbow-me/rainbowkit/styles.css';
import { chainConfigSchema, robinhoodConfig, TOKENS } from '@receipts/shared';
import { apiTry } from '@/lib/api.server';
import { PUBLIC_RPC_URL } from '@/lib/env';
import { toClientTokens, type ClientChainConfig } from '@/lib/client-config';
import { WalletProviders } from '@/components/app/WalletProviders';
import { Sidebar } from '@/components/app/Sidebar';

export const metadata: Metadata = { title: 'App' };

/** SIWE domain / uri as the API expects them (it also returns them from GET /auth/nonce). */
function siwe(): { siweDomain: string; siweUri: string } {
  const domain = process.env.APP_DOMAIN ?? 'localhost:3000';
  const local = domain.startsWith('localhost') && process.env.NODE_ENV !== 'production';
  return { siweDomain: domain, siweUri: `${local ? 'http' : 'https'}://${domain}` };
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Chain + deployment settings come from the API (/config/chain); fall back to the shared config + public RPC.
  const cfg = await apiTry('/config/chain', chainConfigSchema, 300);
  const config: ClientChainConfig = cfg.ok
    ? {
        chainId: cfg.data.chainId,
        name: cfg.data.name,
        explorer: cfg.data.explorer,
        rpcUrl: cfg.data.rpcUrl,
        registry: cfg.data.registry as `0x${string}` | null,
        factory: cfg.data.factory as `0x${string}` | null,
        maxDailyLimitUsd: cfg.data.maxDailyLimitUsd,
        tokens: toClientTokens(cfg.data.tokens),
        ...siwe(),
      }
    : {
        chainId: robinhoodConfig.chainId,
        name: robinhoodConfig.name,
        explorer: robinhoodConfig.explorer,
        rpcUrl: PUBLIC_RPC_URL ?? robinhoodConfig.publicRpc,
        registry: null,
        factory: null,
        maxDailyLimitUsd: null,
        tokens: TOKENS.map((t) => ({
          symbol: t.symbol,
          address: t.address,
          decimals: t.decimals,
          kind: t.kind,
          feeTier: t.feeTier,
        })),
        ...siwe(),
      };

  return (
    <WalletProviders config={config}>
      <div className="grid min-h-screen grid-cols-[244px_minmax(0,1fr)] bg-white max-[800px]:grid-cols-1">
        <Sidebar chainId={config.chainId} chainName={config.name} explorer={config.explorer} />
        <div className="min-w-0">{children}</div>
      </div>
    </WalletProviders>
  );
}
