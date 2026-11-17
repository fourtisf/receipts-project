'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { explorerAddress, tokenByAddress, type Vault } from '@receipts/shared';
import { amount, bpsPct, dateTimeUtc, dateUtc, nf, roundDec, timeUtc, tokenAmount } from '@/lib/format';
import { checksum, shortAddr } from '@/lib/address';
import { strategyHref } from '@/lib/receipt';
import { ExtLink } from '@/components/ui';
import { PageHead } from './AppPage';
import { formatCents, worstCaseCents } from '@/components/landing/WorstCaseCalculator';
import { useMyVault } from './useVault';

type VaultEvent = Vault['events'][number];
const ZERO = '0x0000000000000000000000000000000000000000';

const str = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
/** 18-decimal fixed point (on-chain USD) → decimal string. */
const usd18 = (v: unknown) => tokenAmount(str(v) || '0', 18, 2);

/** "14:05" for the last 24 hours (UTC), else "Oct 13". */
function logTime(iso: string): string {
  const t = new Date(iso);
  if (Date.now() - t.getTime() < 86_400_000) return timeUtc(iso).slice(0, 5);
  return dateUtc(iso);
}

/** One human line per indexed vault event. */
export function describeEvent(e: VaultEvent, names: Record<string, string> = {}): string {
  const d = e.data;
  const strat = (id: unknown) => names[str(id)] ?? `strategy #${str(id)}`;
  switch (e.type) {
    case 'CREATED':
      return 'Vault created';
    case 'DEPOSITED':
      return `Deposited ${tokenAmount(str(d.amount) || '0', 6, 2)} USDG`;
    case 'WITHDRAWN': {
      const t = tokenByAddress(str(d.token));
      return `Withdrew ${tokenAmount(str(d.amount) || '0', t?.decimals ?? 18, 4)} ${t?.symbol ?? 'tokens'} to your wallet`;
    }
    case 'FOLLOWED':
      return `Started copying ${strat(d.strategyId)} with ${usd18(d.allocationUsd)} USD`;
    case 'UNFOLLOWED':
      return `Stopped copying ${strat(d.strategyId)}`;
    case 'ALLOCATION':
      return `Allocation set to ${usd18(d.allocationUsd)} USD`;
    case 'LIMITS':
      return `Limits set: ${usd18(d.dailyLimitUsd)} USDG a day, ${bpsPct(Number(d.maxSlippageBps), 1)} slippage, breaker at −${bpsPct(Number(d.drawdownBps), 0)}`;
    case 'PAUSED':
      return d.paused ? 'Paused trading' : 'Resumed trading';
    case 'OPERATOR':
      return str(d.current).toLowerCase() === ZERO
        ? 'Revoked bot access'
        : `Gave bot access to ${shortAddr(str(d.current))}`;
    case 'TOKEN': {
      const t = tokenByAddress(str(d.token));
      return `${d.enabled ? 'Allowed' : 'Removed'} ${t?.symbol ?? shortAddr(str(d.token))}`;
    }
    case 'BREAKER':
      return 'Drawdown breaker tripped; trading paused';
    case 'PEAK_RESET':
      return 'Peak reset';
    case 'FEES_SETTLED':
      return 'Creator fee settled';
    case 'FEE_DEFERRED':
      return 'Creator fee deferred';
    default:
      return e.type.toLowerCase().replace(/_/g, ' ');
  }
}

function SetupPreview({
  connected,
  maxDailyLimit,
  assets,
}: {
  connected: boolean;
  maxDailyLimit: number;
  assets: string[];
}) {
  const { openConnectModal } = useConnectModal();
  const max = Math.max(50, Math.min(5000, Math.floor(maxDailyLimit / 50) * 50));
  const [limit, setLimit] = useState(Math.min(500, max));
  const [slip, setSlip] = useState(10);
  const [dd, setDd] = useState(15);
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(['WETH', 'cbBTC', 'NVDA', 'AAPL', 'SPY', 'QQQ'].filter((a) => assets.includes(a))),
  );
  const toggle = (a: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(a)) n.delete(a);
      else n.add(a);
      return n;
    });

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
            />
            <p className="help">The most a strategy can trade from your vault in 24 hours.</p>
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
            />
            <p className="help">Trading pauses by itself if the vault falls this far from its peak.</p>
          </div>
          <p className="field" id="assetsLabel">
            Assets strategies may trade
          </p>
          <div className="mb-[22px] flex flex-wrap gap-1.5" role="group" aria-labelledby="assetsLabel">
            {assets.map((a) => (
              <button
                key={a}
                type="button"
                aria-pressed={picked.has(a)}
                onClick={() => toggle(a)}
                className="h-[34px] rounded-[9px] border border-line bg-white px-3 text-[13.5px] font-medium text-muted aria-pressed:border-ink aria-pressed:bg-bg-2 aria-pressed:text-ink"
              >
                {a}
              </button>
            ))}
          </div>
          {connected ? (
            <>
              <button className="btn btn-dark btn-lg w-full" type="button" disabled>
                Create vault
              </button>
              <p className="help">
                This wallet has no vault yet. Creating one from this site opens in the next release.
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
            ≈ {formatCents(worstCaseCents(limit, slip))}{' '}
            <small className="font-sans text-[15px] font-medium tracking-normal text-muted">USDG</small>
          </div>
          <p className="help mb-[22px]">The bot cannot withdraw or send funds anywhere.</p>
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

function Dashboard({ v, explorer }: { v: Vault; explorer: string }) {
  const nav = v.navUsd;
  const peak = v.peakNavUsd;
  // drawdown from peak in % (display only)
  const ddNow = Number(peak) > 0 ? ((Number(nav) - Number(peak)) / Number(peak)) * 100 : 0;
  const ddLimit = v.drawdownBps / 100;
  const off = v.paused || !v.operator || v.operator === ZERO;
  const status =
    !v.operator || v.operator === ZERO
      ? 'Bot access revoked'
      : v.paused
        ? 'Paused'
        : v.followingName
          ? `Copying ${v.followingName}`
          : 'Ready to copy a strategy';
  const writeUrl = `${explorer}/address/${checksum(v.address)}?tab=write_contract`;
  const names: Record<string, string> =
    v.followingId && v.followingName ? { [String(v.followingId)]: v.followingName } : {};

  return (
    <>
      <PageHead
        title="Your vault"
        actions={
          <>
            <button className="btn" type="button" disabled title="Opens in the next release">
              {v.paused ? 'Resume trading' : 'Pause trading'}
            </button>
            <button className="btn" type="button" disabled title="Opens in the next release">
              Revoke bot access
            </button>
          </>
        }
      >
        <p className="font-mono !text-[13px]">
          <ExtLink href={explorerAddress(v.address)}>{shortAddr(v.address)}</ExtLink> on Robinhood Chain
        </p>
      </PageHead>
      <div className="grid grid-cols-[1.2fr_1fr] items-start gap-5 max-[1060px]:grid-cols-1">
        <div className="grid min-w-0 gap-5">
          <div className="card">
            <p className="mb-2 text-[14px] text-muted">Balance</p>
            <div className="balance">
              {amount(nav)} <small>USD</small>
            </div>
            <div className={`status${off ? ' off' : ''}`}>{status}</div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="input min-w-[180px] flex-1"
                inputMode="decimal"
                placeholder="Amount in USDG"
                aria-label="Amount in USDG"
                disabled
              />
              <button className="btn btn-dark h-[46px]" type="button" disabled>
                Deposit
              </button>
              <button className="btn h-[46px]" type="button" disabled>
                Withdraw
              </button>
            </div>
            <p className="help">
              Deposits and withdrawals from this site open in the next release. You can always withdraw
              directly on <ExtLink href={writeUrl}>Blockscout</ExtLink>, even while paused.
            </p>
          </div>
          <div className="card">
            <h2>Activity</h2>
            <p className="sub">Each line links to its transaction on Blockscout.</p>
            {v.events.length === 0 ? (
              <p className="help">No activity indexed yet.</p>
            ) : (
              <ul className="log text-[14.5px]">
                {v.events.map((e) => (
                  <li key={e.source.txHash + e.type}>
                    <time dateTime={e.at} title={dateTimeUtc(e.at)}>
                      {logTime(e.at)}
                    </time>
                    <span>
                      <ExtLink href={e.source.explorerUrl}>{describeEvent(e, names)}</ExtLink>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <div className="card">
          <h2>Limits in force</h2>
          <p className="sub">Enforced by the vault contract on every trade.</p>
          <div className="range-top">
            <span>Daily limit</span>
            <strong>{amount(v.dailyLimitUsd)} USDG</strong>
          </div>
          <p className="help mb-5">The most a strategy can trade from this vault in 24 hours.</p>
          <div className="range-top">
            <span>Drawdown from peak</span>
            <strong className={ddNow < 0 ? 'loss' : ''}>
              {roundDec(String(ddNow), 1).replace('-', '−')}% of −{ddLimit}%
            </strong>
          </div>
          <div className={`meter${ddNow <= -ddLimit * 0.7 ? ' warn' : ''}`} aria-hidden="true">
            <b style={{ width: `${Math.min(100, (Math.abs(ddNow) / Math.max(ddLimit, 0.01)) * 100)}%` }} />
          </div>
          <p className="help mb-5">Trading pauses by itself at −{ddLimit}%.</p>
          <div className="kv">
            <div>
              <span>Max slippage</span>
              <span>{bpsPct(v.maxSlippageBps, 1)}</span>
            </div>
            <div>
              <span>Allocation</span>
              <span>{amount(v.allocationUsd)} USD</span>
            </div>
            <div>
              <span>High-water mark</span>
              <span>{amount(v.hwmNavUsd)} USD</span>
            </div>
            <div>
              <span>Strategy</span>
              <span>
                {v.followingId ? (
                  <Link className="linkbtn" href={strategyHref(v.followingId)}>
                    {v.followingName ?? `#${v.followingId}`}
                  </Link>
                ) : (
                  <Link className="linkbtn" href="/app">
                    Choose one
                  </Link>
                )}
              </span>
            </div>
            <div>
              <span>Bot (operator)</span>
              <span>
                {v.operator && v.operator !== ZERO ? (
                  <ExtLink href={explorerAddress(v.operator)} className="src font-mono text-[13px]">
                    {shortAddr(v.operator)}
                  </ExtLink>
                ) : (
                  'None'
                )}
              </span>
            </div>
            <div>
              <span>Created</span>
              <span>
                <ExtLink href={v.created.explorerUrl} className="src font-mono text-[13px]">
                  blk {nf(v.created.blockNumber)}
                </ExtLink>
              </span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export function VaultView({
  explorer,
  maxDailyLimitUsd,
  assets,
}: {
  explorer: string;
  maxDailyLimitUsd: string | null;
  assets: string[];
}) {
  const { isConnected, vault, loading, error, connecting } = useMyVault();
  const maxDaily = maxDailyLimitUsd ? Number(roundDec(maxDailyLimitUsd, 0)) : 5000;

  if (isConnected && loading) return <div className="empty">Reading your vault…</div>;
  if (isConnected && error)
    return (
      <div className="error" role="alert">
        Your vault could not be loaded: {error.message}
      </div>
    );
  if (isConnected && vault) return <Dashboard v={vault} explorer={explorer} />;
  return <SetupPreview connected={isConnected && !connecting} maxDailyLimit={maxDaily} assets={assets} />;
}
