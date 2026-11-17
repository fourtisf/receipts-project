import type { Metadata } from 'next';
import '@rainbow-me/rainbowkit/styles.css';
import { chainConfigSchema, robinhoodConfig } from '@receipts/shared';
import { apiTry } from '@/lib/api.server';
import { PUBLIC_RPC_URL } from '@/lib/env';
import { WalletProviders, type ChainInfo } from '@/components/app/WalletProviders';
import { Sidebar } from '@/components/app/Sidebar';

export const metadata: Metadata = { title: 'App' };

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Chain settings come from the API (/config/chain); fall back to the shared config + public RPC env.
  const cfg = await apiTry('/config/chain', chainConfigSchema, 300);
  const chain: ChainInfo = cfg.ok
    ? { id: cfg.data.chainId, name: cfg.data.name, rpcUrl: cfg.data.rpcUrl, explorer: cfg.data.explorer }
    : {
        id: robinhoodConfig.chainId,
        name: robinhoodConfig.name,
        rpcUrl: PUBLIC_RPC_URL ?? robinhoodConfig.publicRpc,
        explorer: robinhoodConfig.explorer,
      };

  return (
    <WalletProviders chain={chain}>
      <div className="grid min-h-screen grid-cols-[244px_minmax(0,1fr)] bg-white max-[800px]:grid-cols-1">
        <Sidebar chainId={chain.id} chainName={chain.name} explorer={chain.explorer} />
        <div className="min-w-0">{children}</div>
      </div>
    </WalletProviders>
  );
}
