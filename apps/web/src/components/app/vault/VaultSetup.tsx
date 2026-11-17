'use client';

import { useState } from 'react';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { useQueryClient } from '@tanstack/react-query';
import { usePublicClient, useAccount } from 'wagmi';
import { receiptsVaultAbi, vaultFactoryAbi } from '@receipts/shared/abi';
import { useChainConfig } from '@/lib/chain-config';
import { nf } from '@/lib/format';
import { usd18 } from '@/lib/units';
import { useToast } from '@/components/Toast';
import { PageHead } from '../AppPage';
import { useTx } from '../useTx';
import { ZERO } from '../useVaultChain';
import { formatCents } from '@/components/landing/WorstCaseCalculator';
import { maxPoolFeeBps, worstCaseCents } from './math';

const DEFAULT_ASSETS = ['WETH', 'cbBTC', 'NVDA', 'AAPL', 'SPY', 'QQQ'];

/** "Create your vault" (prototype VaultSetup): limits + allowed assets → createVault, then disable unchecked assets. */
export function VaultSetup({
  connected,
  maxDailyLimit,
  deployed,
  onBusy,
}: {
  /** Told when the multi-transaction create flow starts / ends, so the page keeps this view until it is done. */
  onBusy?: (busy: boolean) => void;
  connected: boolean;
  /** Beta cap in whole USD (factory MAX_DAILY_LIMIT_USD). */
  maxDailyLimit: number;
  deployed: boolean;
}) {
  const cfg = useChainConfig();
  const { openConnectModal } = useConnectModal();
  const { address } = useAccount();
  const client = usePublicClient();
  const qc = useQueryClient();
  const toast = useToast();
  const { run, busy } = useTx();
  const assets = cfg.tokens.filter((t) => t.kind !== 'base');
  const max = Math.max(50, Math.min(5000, Math.floor(maxDailyLimit / 50) * 50));
  const [limit, setLimit] = useState(Math.min(500, max));
  const [slip, setSlip] = useState(10); // tenths of a percent
  const [dd, setDd] = useState(15);
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(DEFAULT_ASSETS.filter((a) => assets.some((t) => t.symbol === a))),
  );
  const [progress, setProgress] = useState<string | null>(null);
  const toggle = (a: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(a)) n.delete(a);
      else n.add(a);
      return n;
    });
  const feeBps = maxPoolFeeBps(assets.filter((t) => picked.has(t.symbol)));

  const create = async () => {
    if (!cfg.factory || !client || !address) return;
    if (picked.size === 0) {
      toast({ message: 'Pick at least one asset strategies may trade.', tone: 'error' });
      return;
    }
    onBusy?.(true);
    try {
      await createFlow();
    } finally {
      onBusy?.(false);
      setProgress(null);
      await qc.invalidateQueries();
    }
  };

  const createFlow = async () => {
    if (!cfg.factory || !client || !address) return;
    const disable = assets.filter((t) => !picked.has(t.symbol));
    const total = 1 + disable.length;
    setProgress(`Step 1 of ${total}: create the vault`);
    const r = await run(
      'Create vault',
      {
        address: cfg.factory,
        abi: vaultFactoryAbi,
        functionName: 'createVault',
        args: [slip * 10, usd18(limit), dd * 100],
      },
      { step: total > 1 ? `Step 1 of ${total}` : undefined, quiet: true, success: 'Vault created.' },
    );
    if (!r) return;
    const vault = await client.readContract({
      address: cfg.factory,
      abi: vaultFactoryAbi,
      functionName: 'vaultOf',
      args: [address],
    });
    if (vault !== ZERO) {
      for (const [i, t] of disable.entries()) {
        const step = `Step ${i + 2} of ${total}`;
        setProgress(`${step}: turn off ${t.symbol}`);
        const ok = await run(
          `Turn off ${t.symbol}`,
          {
            address: vault,
            abi: receiptsVaultAbi,
            functionName: 'setTokenEnabled',
            args: [t.address, false],
          },
          { step, quiet: true },
        );
        if (!ok) {
          toast({
            message: `Your vault is created, but ${t.symbol} is still allowed. You can turn it off from the vault page.`,
            tone: 'error',
          });
          break;
        }
      }
      toast({ message: 'Vault ready. Deposit USDG to start.', tone: 'ok' });
    }
  };

  return (
    <>
      <PageHead title="Create your vault">
        <p>
          A contract owned by your wallet. Strategies can trade inside it within these limits and can never
          move money out.
        </p>
      </PageHead>
      <div className="grid grid-cols-[1.2fr_1fr] items-start gap-5 max-[1060px]:grid-cols-1">
        <div className="card">
          <h2>Limits</h2>
          <p className="sub">You can change every limit later.</p>
          <div className="mb-[22px]">
            <div className="range-top">
              <label htmlFor="rLimit">Daily trading limit</label>
              <strong>{nf(limit)} USDG</strong>
            </div>
            <input
              type="range"
              id="rLimit"
              min={50}
              max={max}
              step={50}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              aria-valuetext={`${nf(limit)} USDG`}
            />
            <p className="help">
              The most a strategy can trade from your vault in 24 hours
              {maxDailyLimit < 5000 ? ` (beta cap: ${nf(maxDailyLimit)} USDG)` : ''}.
            </p>
          </div>
          <div className="mb-[22px]">
            <div className="range-top">
              <label htmlFor="rSlip">Max slippage vs Chainlink</label>
              <strong>{(slip / 10).toFixed(1)}%</strong>
            </div>
            <input
              type="range"
              id="rSlip"
              min={1}
              max={50}
              step={1}
              value={slip}
              onChange={(e) => setSlip(Number(e.target.value))}
              aria-valuetext={`${(slip / 10).toFixed(1)} percent`}
            />
            <p className="help">Trades that fill worse than this revert. 1% suits most pools.</p>
          </div>
          <div className="mb-[22px]">
            <div className="range-top">
              <label htmlFor="rDd">Drawdown breaker</label>
              <strong>−{dd}%</strong>
            </div>
            <input
              type="range"
              id="rDd"
              min={5}
              max={50}
              step={1}
              value={dd}
              onChange={(e) => setDd(Number(e.target.value))}
              aria-valuetext={`minus ${dd} percent`}
            />
            <p className="help">Trading pauses by itself if the vault falls this far from its peak.</p>
          </div>
          <p className="field" id="assetsLabel">
            Assets strategies may trade
          </p>
          <div className="mb-[22px] flex flex-wrap gap-1.5" role="group" aria-labelledby="assetsLabel">
            {assets.map((t) => (
              <button
                key={t.symbol}
                type="button"
                aria-pressed={picked.has(t.symbol)}
                onClick={() => toggle(t.symbol)}
                className="chip"
              >
                {t.symbol}
              </button>
            ))}
          </div>
          {!deployed ? (
            <>
              <button className="btn btn-dark btn-lg w-full" type="button" disabled>
                Create vault
              </button>
              <p className="help">The vault contracts are not deployed on this network yet.</p>
            </>
          ) : connected ? (
            <>
              <button
                className="btn btn-dark btn-lg w-full"
                type="button"
                onClick={() => void create()}
                disabled={busy !== null}
              >
                {progress ?? 'Create vault'}
              </button>
              <p className="help">
                {assets.length - picked.size > 0
                  ? `One transaction to create the vault, then one per asset you turned off (${assets.length - picked.size}).`
                  : 'One transaction. Gas only.'}
              </p>
            </>
          ) : (
            <button className="btn btn-dark btn-lg w-full" type="button" onClick={openConnectModal}>
              Connect wallet to create a vault
            </button>
          )}
        </div>
        <div className="card">
          <h2>If our bot key were stolen</h2>
          <p className="sub">Worst case per day with these limits, until you pause or revoke.</p>
          <div className="mb-2.5 mt-1 font-mono text-[clamp(32px,3.6vw,42px)] font-medium leading-none tracking-[-0.035em]">
            ≈ {formatCents(worstCaseCents(limit, slip * 10, feeBps))}{' '}
            <small className="font-sans text-[15px] font-medium tracking-normal text-muted">USDG</small>
          </div>
          <p className="help mb-[22px]">
            {nf(limit)} × ({(slip / 10).toFixed(1)}% slippage + {(feeBps / 100).toFixed(2)}% pool fee + 0.5%
            oracle lag). The bot cannot withdraw or send funds anywhere.
          </p>
          <div className="kv">
            <div>
              <span>Who can withdraw</span>
              <span>Only your wallet</span>
            </div>
            <div>
              <span>Works while paused</span>
              <span>Yes</span>
            </div>
            <div>
              <span>Works if this site is down</span>
              <span>Yes, from Blockscout</span>
            </div>
            <div>
              <span>Cost to create</span>
              <span>Gas only</span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
