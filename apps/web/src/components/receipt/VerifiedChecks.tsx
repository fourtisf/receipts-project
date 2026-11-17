'use client';

import { useEffect, useState } from 'react';
import type { ReceiptDetail } from '@receipts/shared';
import { APP_NAME } from '@/lib/env';
import { useChainConfig } from '@/lib/chain-config';
import { rpcHost, verifyOnChain, type ChainVerification } from '@/lib/verify-chain';
import { ChecksList } from './ChecksList';

type State =
  { kind: 'verifying' } | { kind: 'chain'; v: ChainVerification } | { kind: 'api'; reason: string };

/**
 * The five receipt checks. Shows the API result immediately, then verifies from Robinhood Chain in the browser and
 * swaps in the chain result. The page always says which source it used.
 */
export function VerifiedChecks({ receipt }: { receipt: ReceiptDetail }) {
  const chain = useChainConfig();
  const [state, setState] = useState<State>({ kind: 'verifying' });
  const registry = chain.registry ?? (receipt.registry as `0x${string}` | null);

  useEffect(() => {
    let cancelled = false;
    if (!registry) {
      setState({ kind: 'api', reason: 'the registry address is not configured' });
      return;
    }
    setState({ kind: 'verifying' });
    verifyOnChain({
      rpcUrl: chain.rpcUrl,
      chainId: chain.chainId,
      registry,
      factory: chain.factory,
      strategyId: receipt.strategyId,
      nonce: receipt.nonce,
      hints: {
        revealBlock: receipt.reveal ? BigInt(receipt.reveal.blockNumber) : null,
        executionBlocks: [...new Set(receipt.executionList.map((e) => e.source.blockNumber))].map((b) =>
          BigInt(b),
        ),
      },
      apiPriceCheck: receipt.checks.find((c) => c.id === 'price_within_oracle') ?? null,
    })
      .then((v) => !cancelled && setState({ kind: 'chain', v }))
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg =
          e instanceof Error
            ? ((e as Error & { shortMessage?: string }).shortMessage ?? e.message)
            : 'unknown error';
        setState({ kind: 'api', reason: msg.length > 160 ? `${msg.slice(0, 160)}…` : msg });
      });
    return () => {
      cancelled = true;
    };
  }, [receipt, registry, chain.rpcUrl, chain.chainId, chain.factory]);

  const host = rpcHost(chain.rpcUrl);
  return (
    <div data-testid="checks-source" data-source={state.kind}>
      <p className={`notice mt-4${state.kind === 'chain' ? ' ok' : ''}`}>
        {state.kind === 'chain' ? (
          <>
            <strong className="font-semibold">Verified from chain via {state.v.rpcHost}.</strong> The hash was
            recomputed in your browser from on-chain events.
            {state.v.checks.some((c) => c.source === 'api')
              ? ' The oracle price check is shown from the API: recomputing a past Chainlink price needs an archive node.'
              : ''}
          </>
        ) : state.kind === 'verifying' ? (
          <>
            Checked via {APP_NAME} API. Verifying from chain via {host}…
          </>
        ) : (
          <>
            Checked via {APP_NAME} API (indexed chain events). Reading the chain directly failed:{' '}
            {state.reason}.
          </>
        )}
      </p>
      <ChecksList checks={state.kind === 'chain' ? state.v.checks : receipt.checks} />
    </div>
  );
}
