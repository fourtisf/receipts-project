'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { ClientChainConfig } from './client-config';

export type { ClientChainConfig, ClientToken } from './client-config';

const Ctx = createContext<ClientChainConfig | null>(null);

export function ChainConfigProvider({ value, children }: { value: ClientChainConfig; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useChainConfig(): ClientChainConfig {
  const v = useContext(Ctx);
  if (!v) throw new Error('useChainConfig must be used inside ChainConfigProvider');
  return v;
}
