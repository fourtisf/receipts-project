'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useAccount } from 'wagmi';
import { explorerAddress, type Vault } from '@receipts/shared';
import { erc20Abi, receiptsVaultAbi } from '@receipts/shared/abi';
import { useChainConfig } from '@/lib/chain-config';
import { shortAddr } from '@/lib/address';
import { nf, timeUtc } from '@/lib/format';
import { strategyHref } from '@/lib/receipt';
import { fmtToken, fmtUnits, parseAmount, usd18, usdToNumber, USD } from '@/lib/units';
import { useToast } from '@/components/Toast';
import { ExtLink } from '@/components/ui';
import { PageHead } from '../AppPage';
import { useTx } from '../useTx';
import { ZERO, type OwnerChainState, type VaultChainState, type VaultToken } from '../useVaultChain';
import { tradesStocks, useGeo, useStrategyList } from '../useApi';
import { describeEvent, logTime } from './events';
import { bpsLabel, maxPoolFeeBps, worstCaseUsd18 } from './math';

const DAY = 86_400n;

function useVaultTx(vault: `0x${string}`) {
  const { run, busy } = useTx();
  const v = { address: vault, abi: receiptsVaultAbi } as const;
  return { run, busy, v };
}

// ───────────────────────── balance, deposit, withdraw USDG

function BalanceCard({
  chain,
  vault,
  status,
  off,
}: {
  chain: OwnerChainState;
  vault: VaultChainState;
  status: string;
  off: boolean;
}) {
  const cfg = useChainConfig();
  const toast = useToast();
  const { address } = useAccount();
  const { run, v } = useVaultTx(vault.address);
  const base = vault.tokens.find((t) => t.kind === 'base')!;
  const [amt, setAmt] = useState('');

  const deposit = async () => {
    const a = parseAmount(amt, base.decimals);
    if (!a) return toast({ message: 'Enter an amount above 0 USDG.', tone: 'error' });
    if (a > chain.walletBase)
      return toast({
        message: `Your wallet holds ${fmtToken(chain.walletBase, base.decimals, 2)} USDG. Lower the amount or top up your wallet.`,
        tone: 'error',
      });
    const needApprove = chain.allowance < a;
    if (needApprove) {
      const ok = await run(
        'Approve USDG',
        { address: base.address, abi: erc20Abi, functionName: 'approve', args: [vault.address, a] },
        { step: 'Step 1 of 2', quiet: true, success: 'USDG approved. Now confirm the deposit.' },
      );
      if (!ok) return;
    }
    const r = await run(
      'Deposit',
      { ...v, functionName: 'deposit', args: [a] },
      {
        step: needApprove ? 'Step 2 of 2' : undefined,
        success: `Deposited ${fmtToken(a, base.decimals, 2)} USDG.`,
      },
    );
    if (r) setAmt('');
  };

  const withdraw = async () => {
    const a = parseAmount(amt, base.decimals);
    if (!a) return toast({ message: 'Enter an amount above 0 USDG.', tone: 'error' });
    const maxOut = base.balance > vault.pendingFeeBase ? base.balance - vault.pendingFeeBase : 0n;
    if (a > base.balance)
      return toast({
        message: `The vault holds ${fmtToken(base.balance, base.decimals, 2)} USDG. Enter that or less.`,
        tone: 'error',
      });
    if (vault.pendingFeeBase > 0n && a > maxOut)
      return toast({
        message: `A creator fee of about ${fmtToken(vault.pendingFeeBase, base.decimals, 2)} USDG is due on profit above your high-water mark and is paid from the vault’s USDG first. Withdraw at most ${fmtToken(maxOut, base.decimals, 2)} USDG.`,
        tone: 'error',
      });
    if (!address) return;
    const r = await run(
      'Withdraw USDG',
      { ...v, functionName: 'withdraw', args: [base.address, a, address] },
      { success: `Withdrew ${fmtToken(a, base.decimals, 2)} USDG to your wallet.` },
    );
    if (r) setAmt('');
  };

  return (
    <div className="card">
      <p className="mb-2 text-[14px] text-muted">Balance</p>
      <div className="balance">
        {vault.nav === null ? '—' : fmtUnits(vault.nav, USD)} <small>USD</small>
      </div>
      <div className={`status${off ? ' off' : ''}`} data-testid="vault-status">
        {status}
      </div>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void deposit();
        }}
      >
        <input
          className="input min-w-[180px] flex-1"
          inputMode="decimal"
          placeholder="Amount in USDG"
          aria-label="Amount in USDG"
          value={amt}
          onChange={(e) => setAmt(e.target.value)}
        />
        <button className="btn btn-dark h-[46px]" type="submit">
          Deposit
        </button>
        <button className="btn h-[46px]" type="button" onClick={() => void withdraw()}>
          Withdraw
        </button>
      </form>
      <p className="help">
        Wallet: {fmtToken(chain.walletBase, base.decimals, 2)} USDG · Vault:{' '}
        {fmtToken(base.balance, base.decimals, 2)} USDG. Withdraw sends USDG straight to your wallet and works
        even while paused or with the bot revoked
        {cfg.explorer ? (
          <>
            {' '}
            (also from{' '}
            <ExtLink href={`${cfg.explorer}/address/${vault.address}?tab=write_contract`}>Blockscout</ExtLink>
            )
          </>
        ) : null}
        .
      </p>
    </div>
  );
}

// ───────────────────────── holdings (withdraw any token)

function HoldingRow({
  t,
  vault,
  pendingFeeBase,
}: {
  t: VaultToken;
  vault: `0x${string}`;
  pendingFeeBase: bigint;
}) {
  const toast = useToast();
  const { address } = useAccount();
  const { run, v } = useVaultTx(vault);
  const [amt, setAmt] = useState('');
  const isBase = t.kind === 'base';
  // USDG pays any creator fee due first inside withdraw, so "Max" keeps the estimated fee back
  const maxOut = isBase && t.balance > pendingFeeBase ? t.balance - pendingFeeBase : isBase ? 0n : t.balance;
  const withdraw = async () => {
    const a = parseAmount(amt, t.decimals);
    if (!a) return toast({ message: `Enter an amount of ${t.symbol} above 0.`, tone: 'error' });
    if (a > t.balance)
      return toast({
        message: `The vault holds ${fmtToken(t.balance, t.decimals)} ${t.symbol}. Enter that or less.`,
        tone: 'error',
      });
    if (isBase && pendingFeeBase > 0n && a > maxOut)
      return toast({
        message: `A creator fee of about ${fmtToken(pendingFeeBase, t.decimals, 2)} USDG is due and is paid from the vault’s USDG first. Withdraw at most ${fmtToken(maxOut, t.decimals, 2)} USDG.`,
        tone: 'error',
      });
    if (!address) return;
    const r = await run(
      `Withdraw ${t.symbol}`,
      { ...v, functionName: 'withdraw', args: [t.address, a, address] },
      { success: `Withdrew ${fmtToken(a, t.decimals)} ${t.symbol} to your wallet.` },
    );
    if (r) setAmt('');
  };
  return (
    <tr>
      <td className="lead !min-w-0">
        <span className="sname">{t.symbol}</span>
        {!t.enabled ? <span className="tag">Off</span> : null}
      </td>
      <td data-l="Balance" className="num">
        {fmtToken(t.balance, t.decimals)}
      </td>
      <td data-l="Value (USD)" className="num">
        {t.valueUsd === null ? 'price stale' : fmtUnits(t.valueUsd, USD)}
      </td>
      <td data-l="Withdraw" className="!whitespace-normal">
        <form
          className="flex items-center justify-end gap-1.5 max-[800px]:justify-start"
          onSubmit={(e) => {
            e.preventDefault();
            void withdraw();
          }}
        >
          <input
            className="input !h-9 w-[120px] !text-[14px]"
            inputMode="decimal"
            aria-label={`Amount of ${t.symbol} to withdraw`}
            placeholder="Amount"
            value={amt}
            onChange={(e) => setAmt(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setAmt(fmtToken(maxOut, t.decimals, t.decimals).replace(/,/g, ''))}
            title={isBase && pendingFeeBase > 0n ? 'Keeps back the creator fee that is due' : undefined}
          >
            Max
          </button>
          <button type="submit" className="btn btn-sm btn-dark">
            Withdraw
          </button>
        </form>
      </td>
    </tr>
  );
}

function HoldingsCard({ vault }: { vault: VaultChainState }) {
  const held = vault.tokens.filter((t) => t.balance > 0n);
  return (
    <div className="card">
      <h2>Holdings</h2>
      <p className="sub">Read from the vault contract. Withdraw any token at any time, paused or not.</p>
      {vault.pendingFeeBase > 0n ? (
        <p className="notice mb-4">
          A creator fee of about {fmtToken(vault.pendingFeeBase, 6, 2)} USDG is due on profit above your
          high-water mark. It is paid from the vault’s USDG first when you withdraw, so Max for USDG keeps it
          back.
        </p>
      ) : null}
      {held.length === 0 ? (
        <p className="help">The vault holds no tokens yet. Deposit USDG to start.</p>
      ) : (
        <div className="tablecard !shadow-none">
          <table className="table stack">
            <thead>
              <tr>
                <th scope="col">Token</th>
                <th scope="col" className="num">
                  Balance
                </th>
                <th scope="col" className="num">
                  Value (USD)
                </th>
                <th scope="col" className="num">
                  Withdraw
                </th>
              </tr>
            </thead>
            <tbody>
              {held.map((t) => (
                <HoldingRow
                  key={t.address}
                  t={t}
                  vault={vault.address}
                  pendingFeeBase={vault.pendingFeeBase}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ───────────────────────── strategy: follow / unfollow / allocation

function StrategyCard({ vault, followName }: { vault: VaultChainState; followName: string | null }) {
  const toast = useToast();
  const { run, v } = useVaultTx(vault.address);
  const list = useStrategyList();
  const geo = useGeo();
  const [pick, setPick] = useState<string>('');
  const [alloc, setAlloc] = useState('');
  const [newAlloc, setNewAlloc] = useState('');
  const following = vault.followingId > 0n;
  const name =
    followName ??
    list.data?.items.find((s) => BigInt(s.id) === vault.followingId)?.name ??
    `Strategy #${vault.followingId}`;
  const candidates = (list.data?.items ?? []).filter((s) => s.active && BigInt(s.id) !== vault.followingId);
  const selected = candidates.find((s) => String(s.id) === pick) ?? null;
  const blocked = Boolean(selected && tradesStocks(selected.category) && geo.data?.stocksBlocked);

  const follow = async () => {
    if (!selected) return toast({ message: 'Pick a strategy to copy.', tone: 'error' });
    const a = parseAmount(newAlloc, USD);
    if (!a) return toast({ message: 'Enter an allocation above 0 USD.', tone: 'error' });
    const r = await run(
      `Copy ${selected.name}`,
      { ...v, functionName: 'follow', args: [BigInt(selected.id), a] },
      { success: `Copying ${selected.name}.` },
    );
    if (r) {
      setNewAlloc('');
      setPick('');
    }
  };
  const setAllocation = async () => {
    const a = parseAmount(alloc, USD);
    if (!a) return toast({ message: 'Enter an allocation above 0 USD.', tone: 'error' });
    const r = await run(
      'Update allocation',
      { ...v, functionName: 'setAllocation', args: [a] },
      { success: 'Allocation updated.' },
    );
    if (r) setAlloc('');
  };

  return (
    <div className="card">
      <h2>Strategy</h2>
      <p className="sub">
        The allocation caps how much (in USD) the strategy may hold outside USDG in this vault.
      </p>
      {following ? (
        <>
          <div className="kv mb-4">
            <div>
              <span>Copying</span>
              <span>
                <Link className="linkbtn" href={strategyHref(vault.followingId.toString())}>
                  {name}
                </Link>
              </span>
            </div>
            <div>
              <span>Allocation</span>
              <span>{fmtUnits(vault.allocationUsd, USD)} USD</span>
            </div>
          </div>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void setAllocation();
            }}
          >
            <input
              className="input min-w-[160px] flex-1"
              inputMode="decimal"
              placeholder="New allocation in USD"
              aria-label="New allocation in USD"
              value={alloc}
              onChange={(e) => setAlloc(e.target.value)}
            />
            <button className="btn h-[46px]" type="submit">
              Update allocation
            </button>
            <button
              className="btn h-[46px]"
              type="button"
              onClick={() =>
                void run(
                  'Stop copying',
                  { ...v, functionName: 'unfollow', args: [] },
                  { success: 'Stopped copying.' },
                )
              }
            >
              Stop copying
            </button>
          </form>
          <p className="help">Stopping settles any creator fee owed on profit above your high first.</p>
          {vault.pendingFeeBase > (vault.tokens.find((t) => t.kind === 'base')?.balance ?? 0n) ? (
            <p className="notice warn mt-3">
              A creator fee of about {fmtToken(vault.pendingFeeBase, 6, 2)} USDG is due on profit above your
              high-water mark, but the vault holds less USDG. Deposit USDG (or withdraw a position) before you
              switch or stop copying.
            </p>
          ) : null}
        </>
      ) : null}
      <form
        className={following ? 'mt-5 border-t border-line-2 pt-5' : ''}
        onSubmit={(e) => {
          e.preventDefault();
          void follow();
        }}
      >
        <label className="field" htmlFor="followPick">
          {following ? 'Switch to another strategy' : 'Strategy to copy'}
        </label>
        <select
          id="followPick"
          className="select mb-2 h-[46px] w-full"
          value={pick}
          onChange={(e) => setPick(e.target.value)}
        >
          <option value="">
            {list.isPending
              ? 'Loading strategies…'
              : candidates.length
                ? 'Choose a strategy'
                : 'No strategies yet'}
          </option>
          {candidates.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.market}
            </option>
          ))}
        </select>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input min-w-[160px] flex-1"
            inputMode="decimal"
            placeholder="Allocation in USD"
            aria-label="Allocation in USD"
            value={newAlloc}
            onChange={(e) => setNewAlloc(e.target.value)}
          />
          <button className="btn btn-dark h-[46px]" type="submit" disabled={blocked}>
            {following ? 'Switch' : 'Copy strategy'}
          </button>
        </div>
        {selected && tradesStocks(selected.category) ? (
          <p className={`notice mt-3${blocked ? ' warn' : ''}`}>
            {geo.data?.notice ?? 'Robinhood Stock Tokens are not available to US persons.'}
            {blocked ? ' Copying stock-token strategies is not available in your region.' : ''}
          </p>
        ) : null}
      </form>
    </div>
  );
}

// ───────────────────────── limits

function LimitsCard({ vault, created }: { vault: VaultChainState; created: Vault['created'] | null }) {
  const { run, v } = useVaultTx(vault.address);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const active = now < vault.windowStart + DAY;
  const used = active ? vault.usedInWindowUsd : 0n;
  const usedPct = vault.dailyLimitUsd > 0n ? Number((used * 10000n) / vault.dailyLimitUsd) / 100 : 0;
  const peak = vault.peakNav;
  const ddNow =
    vault.nav !== null && peak > 0n
      ? ((usdToNumber(vault.nav) - usdToNumber(peak)) / usdToNumber(peak)) * 100
      : 0;
  const ddLimit = vault.drawdownBps / 100;
  const tripped =
    vault.nav !== null && peak > 0n && vault.nav * 10000n < peak * BigInt(10000 - vault.drawdownBps);
  const enabled = vault.tokens.filter((t) => t.enabled);
  const feeBps = maxPoolFeeBps(enabled);
  const worst = worstCaseUsd18(vault.dailyLimitUsd, vault.maxSlippageBps, feeBps);
  const maxLimit = Math.max(50, Math.floor(usdToNumber(vault.maxDailyLimitUsd) / 50) * 50);

  const [limit, setLimit] = useState(() => Math.min(maxLimit, Math.round(usdToNumber(vault.dailyLimitUsd))));
  const [slip, setSlip] = useState(() => Math.max(1, Math.round(vault.maxSlippageBps / 10)));
  const [dd, setDd] = useState(() => Math.round(vault.drawdownBps / 100));

  return (
    <div className="card">
      <h2>Limits in force</h2>
      <p className="sub">Enforced by the vault contract on every trade.</p>
      <div className="range-top">
        <span>Daily limit used</span>
        <strong>
          {fmtUnits(used, USD)} / {fmtUnits(vault.dailyLimitUsd, USD)}
        </strong>
      </div>
      <div className="meter" aria-hidden="true">
        <b style={{ width: `${Math.min(100, usedPct)}%` }} />
      </div>
      <p className="help mb-5">
        {fmtUnits(vault.remainingDailyUsd, USD)} USDG left.{' '}
        {active
          ? `The window resets at ${timeUtc(new Date(Number(vault.windowStart + DAY) * 1000).toISOString()).slice(0, 5)} UTC.`
          : 'Resets 24 hours after the first trade of the window.'}
      </p>
      <div className="range-top">
        <span>Drawdown from peak</span>
        <strong className={ddNow < 0 ? 'loss' : ''}>
          {vault.nav === null ? '—' : `${ddNow < 0 ? '−' : ''}${Math.abs(ddNow).toFixed(1)}%`} of −{ddLimit}%
        </strong>
      </div>
      <div className={`meter${ddNow <= -ddLimit * 0.7 ? ' warn' : ''}`} aria-hidden="true">
        <b
          style={{
            width: `${Math.min(100, (Math.abs(Math.min(0, ddNow)) / Math.max(ddLimit, 0.01)) * 100)}%`,
          }}
        />
      </div>
      <p className="help mb-5">Trading pauses by itself at −{ddLimit}%.</p>
      {tripped ? (
        <div className="notice warn mb-5">
          The drawdown breaker tripped and paused trading. Re-arm it from today’s value, then resume trading.{' '}
          <button
            type="button"
            className="linkbtn !text-inherit"
            onClick={() =>
              void run(
                'Reset peak',
                { ...v, functionName: 'resetPeak', args: [] },
                { success: 'Breaker re-armed from the current value.' },
              )
            }
          >
            Reset peak
          </button>
        </div>
      ) : null}
      <div className="kv">
        <div>
          <span>Max slippage</span>
          <span>{bpsLabel(vault.maxSlippageBps)}</span>
        </div>
        <div>
          <span>If the bot key were stolen</span>
          <span className="font-mono">≈ {fmtUnits(worst, USD)} USDG / day</span>
        </div>
        <div>
          <span>High-water mark</span>
          <span>{fmtUnits(vault.hwmNav, USD)} USD</span>
        </div>
        <div>
          <span>Bot (operator)</span>
          <span>
            {vault.operator === ZERO ? (
              'Revoked'
            ) : (
              <ExtLink href={explorerAddress(vault.operator)} className="src font-mono text-[13px]">
                {shortAddr(vault.operator)}
              </ExtLink>
            )}
          </span>
        </div>
        {created ? (
          <div>
            <span>Created</span>
            <span>
              <ExtLink href={created.explorerUrl} className="src font-mono text-[13px]">
                blk {nf(created.blockNumber)}
              </ExtLink>
            </span>
          </div>
        ) : null}
      </div>
      <details className="mt-5 border-t border-line-2 pt-4">
        <summary className="cursor-pointer text-[15px] font-semibold">Change limits</summary>
        <div className="mt-4">
          <div className="mb-4">
            <div className="range-top">
              <label htmlFor="eLimit">Daily trading limit</label>
              <strong>{nf(limit)} USDG</strong>
            </div>
            <input
              type="range"
              id="eLimit"
              min={50}
              max={maxLimit}
              step={50}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            />
          </div>
          <div className="mb-4">
            <div className="range-top">
              <label htmlFor="eSlip">Max slippage vs Chainlink</label>
              <strong>{(slip / 10).toFixed(1)}%</strong>
            </div>
            <input
              type="range"
              id="eSlip"
              min={1}
              max={50}
              step={1}
              value={slip}
              onChange={(e) => setSlip(Number(e.target.value))}
            />
          </div>
          <div className="mb-4">
            <div className="range-top">
              <label htmlFor="eDd">Drawdown breaker</label>
              <strong>−{dd}%</strong>
            </div>
            <input
              type="range"
              id="eDd"
              min={5}
              max={50}
              step={1}
              value={dd}
              onChange={(e) => setDd(Number(e.target.value))}
            />
          </div>
          <button
            type="button"
            className="btn btn-dark w-full"
            onClick={() =>
              void run(
                'Save limits',
                { ...v, functionName: 'setLimits', args: [slip * 10, usd18(limit), dd * 100] },
                { success: 'Limits updated.' },
              )
            }
          >
            Save limits
          </button>
        </div>
      </details>
    </div>
  );
}

// ───────────────────────── allowed assets

function AssetsCard({ vault }: { vault: VaultChainState }) {
  const { run, v } = useVaultTx(vault.address);
  const assets = vault.tokens.filter((t) => t.kind !== 'base' && t.listed);
  const following = vault.followingId > 0n;
  const heldWhileFollowing = following ? assets.filter((t) => t.enabled && t.balance > 0n) : [];
  return (
    <div className="card">
      <h2>Assets strategies may trade</h2>
      <p className="sub">
        Each change is one transaction. A token you turn off stays in the vault and can still be withdrawn.
      </p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Allowed assets">
        {assets.map((t) => {
          const locked = following && t.enabled && t.balance > 0n;
          return (
            <button
              key={t.address}
              type="button"
              className="chip"
              aria-pressed={t.enabled}
              disabled={locked}
              title={locked ? `Withdraw ${t.symbol} first (this settles the creator fee)` : undefined}
              onClick={() =>
                void run(`${t.enabled ? 'Turn off' : 'Allow'} ${t.symbol}`, {
                  ...v,
                  functionName: 'setTokenEnabled',
                  args: [t.address, !t.enabled],
                })
              }
            >
              {t.symbol}
              {locked ? <span className="sr-only"> (held: withdraw it first)</span> : null}
            </button>
          );
        })}
      </div>
      {heldWhileFollowing.length > 0 ? (
        <p className="help">
          {heldWhileFollowing.map((t) => t.symbol).join(', ')}{' '}
          {heldWhileFollowing.length === 1 ? 'is' : 'are'} held while copying a strategy, so{' '}
          {heldWhileFollowing.length === 1 ? 'it stays' : 'they stay'} on. Withdraw it first (this settles the
          creator fee).
        </p>
      ) : null}
    </div>
  );
}

// ───────────────────────── activity (indexer)

function ActivityCard({
  events,
  followName,
  followingId,
}: {
  events: Vault['events'] | null;
  followName: string | null;
  followingId: bigint;
}) {
  const names: Record<string, string> = followName ? { [followingId.toString()]: followName } : {};
  return (
    <div className="card">
      <h2>Activity</h2>
      <p className="sub">Each line links to its transaction on Blockscout.</p>
      {events === null ? (
        <p className="help">
          The indexer has not picked up this vault yet. New activity appears within seconds.
        </p>
      ) : events.length === 0 ? (
        <p className="help">No activity indexed yet.</p>
      ) : (
        <ul className="log text-[14.5px]">
          {events.map((e) => (
            <li key={e.source.txHash + e.type}>
              <time dateTime={e.at}>{logTime(e.at)}</time>
              <span>
                <ExtLink href={e.source.explorerUrl}>{describeEvent(e, names)}</ExtLink>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ───────────────────────── page

export function VaultDashboard({
  chain,
  vault,
  apiVault,
}: {
  chain: OwnerChainState;
  vault: VaultChainState;
  apiVault: Vault | null;
}) {
  const { run, busy, v } = useVaultTx(vault.address);
  const list = useStrategyList();
  const revoked = vault.operator === ZERO;
  const following = vault.followingId > 0n;
  const followName =
    (apiVault && apiVault.followingId !== null && BigInt(apiVault.followingId) === vault.followingId
      ? apiVault.followingName
      : null) ??
    list.data?.items.find((s) => BigInt(s.id) === vault.followingId)?.name ??
    null;
  const tripped =
    vault.nav !== null &&
    vault.peakNav > 0n &&
    vault.nav * 10000n < vault.peakNav * BigInt(10000 - vault.drawdownBps);
  const status = revoked
    ? 'Bot access revoked'
    : vault.paused
      ? tripped
        ? 'Paused by the drawdown breaker'
        : 'Paused'
      : following
        ? `Copying ${followName ?? `strategy #${vault.followingId}`}`
        : 'Ready to copy a strategy';

  return (
    <>
      <PageHead
        title="Your vault"
        actions={
          <>
            <button
              className="btn"
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void run(
                  vault.paused ? 'Resume trading' : 'Pause trading',
                  { ...v, functionName: 'setPaused', args: [!vault.paused] },
                  {
                    success: vault.paused ? 'Trading resumed.' : 'Trading paused. Withdrawals still work.',
                  },
                )
              }
            >
              {vault.paused ? 'Resume trading' : 'Pause trading'}
            </button>
            <button
              className="btn"
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void run(
                  revoked ? 'Give bot access' : 'Revoke bot access',
                  { ...v, functionName: 'setOperator', args: [revoked ? chain.defaultOperator : ZERO] },
                  {
                    success: revoked
                      ? 'Bot access restored.'
                      : 'Bot access revoked. It can no longer trade this vault.',
                  },
                )
              }
            >
              {revoked ? 'Give bot access' : 'Revoke bot access'}
            </button>
          </>
        }
      >
        <p className="font-mono !text-[13px]">
          <ExtLink href={explorerAddress(vault.address)}>{shortAddr(vault.address)}</ExtLink> on Robinhood
          Chain
        </p>
      </PageHead>
      {vault.marksFrozen ? (
        <div className="notice warn mb-5">
          The vault’s profit marks are frozen (a price could not be read during a withdrawal). Copying is
          paused for fees until you reset them; creator fees accrued before the freeze are dropped.{' '}
          <button
            type="button"
            className="linkbtn !text-inherit"
            onClick={() =>
              void run(
                'Reset marks',
                { ...v, functionName: 'resetMarks', args: [] },
                { success: 'Marks reset.' },
              )
            }
          >
            Reset marks
          </button>
        </div>
      ) : null}
      <div className="grid grid-cols-[1.2fr_1fr] items-start gap-5 max-[1060px]:grid-cols-1">
        <div className="grid min-w-0 gap-5">
          <BalanceCard chain={chain} vault={vault} status={status} off={vault.paused || revoked} />
          <HoldingsCard vault={vault} />
          <StrategyCard vault={vault} followName={followName} />
          <ActivityCard
            events={apiVault ? apiVault.events : null}
            followName={followName}
            followingId={vault.followingId}
          />
        </div>
        <div className="grid min-w-0 gap-5">
          <LimitsCard vault={vault} created={apiVault?.created ?? null} />
          <AssetsCard vault={vault} />
        </div>
      </div>
    </>
  );
}
