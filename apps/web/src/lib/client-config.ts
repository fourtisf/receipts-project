import { tokenByAddress, type ChainConfig } from '@receipts/shared';

export interface ClientToken {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
  kind: 'base' | 'crypto' | 'stock';
  feeTier: number;
}

/** Chain + deployment settings the browser needs (from GET /config/chain, with config/robinhood.json fallback). */
export interface ClientChainConfig {
  chainId: number;
  name: string;
  explorer: string;
  rpcUrl: string;
  registry: `0x${string}` | null;
  factory: `0x${string}` | null;
  maxDailyLimitUsd: string | null;
  tokens: ClientToken[];
  /** SIWE domain / uri the API expects (APP_DOMAIN). */
  siweDomain: string;
  siweUri: string;
}

/** Builds the client config from the API response (decimals from the shared token list). */
export function toClientTokens(tokens: ChainConfig['tokens']): ClientToken[] {
  return tokens.map((t) => ({
    symbol: t.symbol,
    address: t.address as `0x${string}`,
    decimals: tokenByAddress(t.address)?.decimals ?? 18,
    kind: t.kind,
    feeTier: t.feeTier,
  }));
}
