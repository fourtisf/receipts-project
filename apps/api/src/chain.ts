import { createPublicClient, http, type Address } from 'viem';
import { robinhoodChain } from '@receipts/shared';
import { vaultFactoryAbi } from '@receipts/shared/abi';

export interface ChainReader {
  maxDailyLimitUsd(): Promise<string | null>;
}

/** Minimal chain reads for the API (cached). Balances are read by the browser, not here. */
export function makeChainReader(rpcUrl: string, factory: Address | undefined): ChainReader {
  const client = createPublicClient({
    chain: robinhoodChain(rpcUrl),
    transport: http(rpcUrl, { timeout: 8000 }),
  });
  let cap: { v: string | null; at: number } | null = null;
  return {
    async maxDailyLimitUsd() {
      if (!factory) return null;
      if (cap && Date.now() - cap.at < 3_600_000) return cap.v;
      try {
        const v = await client.readContract({
          address: factory,
          abi: vaultFactoryAbi,
          functionName: 'MAX_DAILY_LIMIT_USD',
        });
        const whole = v / 10n ** 18n;
        const frac = (v % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
        cap = { v: frac ? `${whole}.${frac}` : whole.toString(), at: Date.now() };
      } catch {
        cap = { v: cap?.v ?? null, at: Date.now() - 3_000_000 }; // retry in ~10 min
      }
      return cap.v;
    },
  };
}
