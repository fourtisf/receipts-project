import { defineChain, getAddress, type Address, type Chain } from 'viem';
import { robinhoodConfig } from './generated/robinhood.js';

export { robinhoodConfig };

export type TokenKind = 'base' | 'crypto' | 'stock';

export interface TokenInfo {
  symbol: string;
  /** checksummed */
  address: Address;
  feed: Address;
  feedDescription: string;
  maxStaleness: number;
  /** Uniswap V3 fee tier of the pinned <token>/USDG pool; 0 for the base token. */
  feeTier: number;
  kind: TokenKind;
}

export const CHAIN_ID = robinhoodConfig.chainId;
export const EXPLORER_URL = robinhoodConfig.explorer;
export const BASE_SYMBOL = robinhoodConfig.stable;

export const TOKENS: readonly TokenInfo[] = robinhoodConfig.tokens.map((t) => {
  const raw = t as { kind?: string; feeTier?: number };
  const kind: TokenKind =
    t.symbol === robinhoodConfig.stable ? 'base' : raw.kind === 'stock' ? 'stock' : 'crypto';
  return {
    symbol: t.symbol,
    address: getAddress(t.address),
    feed: getAddress(t.feed),
    feedDescription: t.feedDescription,
    maxStaleness: t.maxStaleness,
    feeTier: raw.feeTier ?? 0,
    kind,
  };
});

export const ROUTER_ADDRESS: Address = getAddress(robinhoodConfig.router);

const bySymbol = new Map(TOKENS.map((t) => [t.symbol.toUpperCase(), t]));
const byAddress = new Map(TOKENS.map((t) => [t.address.toLowerCase(), t]));

export function tokenBySymbol(symbol: string): TokenInfo | undefined {
  return bySymbol.get(symbol.toUpperCase());
}

export function tokenByAddress(address: string): TokenInfo | undefined {
  return byAddress.get(address.toLowerCase());
}

export function baseToken(): TokenInfo {
  const t = tokenBySymbol(BASE_SYMBOL);
  if (!t) throw new Error(`Base token ${BASE_SYMBOL} missing from config/robinhood.json`);
  return t;
}

/** viem chain object for Robinhood Chain. Pass a custom RPC (paid key) in production. */
export function robinhoodChain(rpcUrl: string = robinhoodConfig.publicRpc): Chain {
  return defineChain({
    id: robinhoodConfig.chainId,
    name: robinhoodConfig.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: 'Blockscout', url: robinhoodConfig.explorer } },
  });
}

export function explorerTx(hash: string): string {
  return `${EXPLORER_URL}/tx/${hash}`;
}

export function explorerAddress(address: string): string {
  return `${EXPLORER_URL}/address/${address}`;
}

export function explorerBlock(block: bigint | number | string): string {
  return `${EXPLORER_URL}/block/${block.toString()}`;
}
