'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { decodeEventLog } from 'viem';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { useAccount } from 'wagmi';
import {
  backtestResultSchema,
  createStrategyResponseSchema,
  errorSchema,
  strategyDetailSchema,
  type BacktestResult,
  type Template,
} from '@receipts/shared';
import { signalRegistryAbi } from '@receipts/shared/abi';
import { PUBLIC_API_BASE } from '@/lib/env';
import { useChainConfig } from '@/lib/chain-config';
import { nf, pct, pctPlain, tone } from '@/lib/format';
import { strategyHref } from '@/lib/receipt';
import { useToast } from '@/components/Toast';
import { Kpi } from '@/components/ui';
import { EquityChart } from './EquityChart';
import { useSession } from './WalletProviders';
import { useTx } from './useTx';

type ParamValue = number | string | string[];

const unit = (t: Template['params'][number]['type']) =>
  t === 'percent' ? '%' : t === 'hours' ? ' h' : t === 'days' ? ' d' : '';

function defaults(t: Template): Record<string, ParamValue> {
  return Object.fromEntries(t.params.map((p) => [p.key, p.default]));
}

function defaultAssets(t: Template): string[] {
  const prefer = ['WETH', 'cbBTC', 'SPY', 'QQQ', 'NVDA', 'AAPL'];
  const pick = prefer.filter((a) => t.assets.allowed.includes(a));
  return (pick.length ? pick : t.assets.allowed).slice(0, Math.max(1, t.assets.min));
}

async function postJson(
  path: string,
  body: unknown,
): Promise<{ ok: true; json: unknown } | { ok: false; status: number; code: string; message: string }> {
  try {
    const r = await fetch(`${PUBLIC_API_BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    const json: unknown = await r.json().catch(() => null);
    if (r.ok) return { ok: true, json };
    const e = errorSchema.safeParse(json);
    return {
      ok: false,
      status: r.status,
      code: e.success ? e.data.error.code : `HTTP_${r.status}`,
      message: e.success ? e.data.error.message : `The server answered ${r.status}. Try again in a moment.`,
    };
  } catch {
    return {
      ok: false,
      status: 0,
      code: 'NETWORK',
      message: 'Could not reach the server. Check your connection.',
    };
  }
}

type Preview =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string; signIn?: boolean }
  | { kind: 'done'; r: BacktestResult };

type Done = { id: number | null; txUrl: string; indexed: boolean };

export function CreateStrategy({ templates }: { templates: Template[] }) {
  const cfg = useChainConfig();
  const toast = useToast();
  const session = useSession();
  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { run, busy } = useTx();
  const first = templates.find((t) => !t.ai) ?? templates[0]!;
  const [tid, setTid] = useState(first.id);
  const template = templates.find((t) => t.id === tid) ?? first;
  const [params, setParams] = useState<Record<string, ParamValue>>(() => defaults(first));
  const [assets, setAssets] = useState<string[]>(() => defaultAssets(first));
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [share, setShare] = useState(10); // percent, 0..30 step 0.5
  const [preview, setPreview] = useState<Preview>({ kind: 'idle' });
  const [creating, setCreating] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const signedIn = session.status === 'authenticated';

  const chooseTemplate = (id: string) => {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setTid(t.id);
    setParams(defaults(t));
    setAssets(defaultAssets(t));
  };
  const toggleAsset = (a: string) =>
    setAssets((cur) => {
      if (cur.includes(a)) return cur.filter((x) => x !== a);
      if (template.assets.max === 1) return [a];
      return cur.length >= template.assets.max ? cur : [...cur, a];
    });

  const assetsOk = assets.length >= template.assets.min && assets.length <= template.assets.max;
  const body = useMemo(() => ({ template: tid, params, assets }), [tid, params, assets]);

  // live backtest preview (debounced, needs a SIWE session); stale responses are ignored
  useEffect(() => {
    let stale = false;
    if (!signedIn) {
      setPreview({
        kind: 'error',
        message: 'Sign in to run the backtest preview. Signing is free: no transaction, no gas.',
        signIn: true,
      });
      return;
    }
    if (template.ai) {
      setPreview({
        kind: 'error',
        message:
          'AI strategies cannot be backtested honestly (the model sees today’s news); they build a live track record from their first commit.',
      });
      return;
    }
    if (!assetsOk) {
      setPreview({
        kind: 'error',
        message: `Pick ${template.assets.min === template.assets.max ? template.assets.min : `${template.assets.min}–${template.assets.max}`} asset${template.assets.max === 1 ? '' : 's'}.`,
      });
      return;
    }
    setPreview({ kind: 'loading' });
    const t = setTimeout(async () => {
      const res = await postJson('/backtest', body);
      if (stale) return;
      if (!res.ok) {
        setPreview({ kind: 'error', message: res.message, signIn: res.status === 401 });
        return;
      }
      const parsed = backtestResultSchema.safeParse(res.json);
      setPreview(
        parsed.success
          ? { kind: 'done', r: parsed.data }
          : { kind: 'error', message: 'The backtest service sent an unexpected response.' },
      );
    }, 700);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [body, signedIn, template.ai, template.assets.min, template.assets.max, assetsOk]);

  const create = async () => {
    if (!isConnected) return openConnectModal?.();
    if (!signedIn) return openConnectModal?.();
    const n = name.trim();
    if (n.length < 3 || n.length > 60)
      return toast({ message: 'Give the strategy a name of 3–60 characters.', tone: 'error' });
    if (description.length > 600)
      return toast({ message: 'Keep the description under 600 characters.', tone: 'error' });
    if (!assetsOk) return toast({ message: 'Pick the number of assets this template needs.', tone: 'error' });
    setCreating('Saving the strategy details…');
    const res = await postJson('/strategies', {
      name: n,
      description: description.trim() || undefined,
      template: tid,
      params,
      assets,
      creatorShareBps: Math.round(share * 100),
    });
    if (!res.ok) {
      setCreating(null);
      return toast({ message: res.message, tone: 'error' });
    }
    const meta = createStrategyResponseSchema.safeParse(res.json);
    if (!meta.success) {
      setCreating(null);
      return toast({ message: 'The server sent an unexpected response. Try again.', tone: 'error' });
    }
    const m = meta.data;
    setCreating('Confirm the registration in your wallet…');
    const receipt = await run(
      'Register strategy',
      {
        address: m.registry as `0x${string}`,
        abi: signalRegistryAbi,
        functionName: 'registerStrategy',
        args: [
          m.signer as `0x${string}`,
          m.creatorShareBps,
          m.revealWindow,
          m.modelHash as `0x${string}`,
          m.metadataURI,
        ],
      },
      { success: 'Strategy registered on-chain.', quiet: true },
    );
    setCreating(null);
    if (!receipt) return;
    let id: number | null = null;
    for (const log of receipt.logs) {
      try {
        const ev = decodeEventLog({ abi: signalRegistryAbi, data: log.data, topics: log.topics });
        if (ev.eventName === 'StrategyRegistered') id = Number(ev.args.id);
      } catch {
        /* other events */
      }
    }
    setDone({ id, txUrl: `${cfg.explorer}/tx/${receipt.transactionHash}`, indexed: false });
  };

  // poll until the indexer has the new strategy
  useEffect(() => {
    if (!done || done.indexed || done.id === null) return;
    let tries = 0;
    const iv = setInterval(async () => {
      tries += 1;
      try {
        const r = await fetch(`${PUBLIC_API_BASE}/strategies/${done.id}`, { cache: 'no-store' });
        if (r.ok && strategyDetailSchema.safeParse(await r.json()).success) {
          setDone((d) => (d ? { ...d, indexed: true } : d));
          clearInterval(iv);
        }
      } catch {
        /* keep polling */
      }
      if (tries > 60) clearInterval(iv);
    }, 2000);
    return () => clearInterval(iv);
  }, [done]);

  const r = preview.kind === 'done' ? preview.r : null;
  const points = r
    ? r.equity.map((p) => ({ at: new Date(p.t).toISOString(), equity: p.equity, hold: p.hold }))
    : [];

  return (
    <div className="grid grid-cols-[1.1fr_1fr] items-start gap-5 max-[1060px]:grid-cols-1">
      <div className="card">
        <h2>Strategy</h2>
        <p className="sub">
          Pick a template and its settings. Every trade it makes is committed on-chain first.
        </p>
        <label className="field" htmlFor="tpl">
          Template
        </label>
        <select
          id="tpl"
          className="select mb-2 h-[46px] w-full"
          value={tid}
          onChange={(e) => chooseTemplate(e.target.value)}
        >
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.ai ? ' (AI)' : ''}
            </option>
          ))}
        </select>
        <p className="help mb-[22px] !mt-0">
          {template.description}
          {template.ai
            ? ' Model and prompt hashes are committed with every signal.'
            : ' Rule-based: no AI involved.'}
        </p>

        {template.params.map((p) => {
          const val = params[p.key];
          if (p.type === 'select')
            return (
              <div className="mb-[22px]" key={p.key}>
                <p className="field" id={`l-${p.key}`}>
                  {p.label}
                </p>
                <div className="seg" role="group" aria-labelledby={`l-${p.key}`}>
                  {(p.options ?? []).map((o) => (
                    <button
                      key={o}
                      type="button"
                      aria-pressed={val === o}
                      onClick={() => setParams({ ...params, [p.key]: o })}
                    >
                      {o[0]!.toUpperCase() + o.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            );
          if (p.type === 'text')
            return (
              <div className="mb-[22px]" key={p.key}>
                <label className="field" htmlFor={`p-${p.key}`}>
                  {p.label}
                </label>
                <textarea
                  id={`p-${p.key}`}
                  className="input !h-auto min-h-[90px] py-3 font-mono !text-[13px]"
                  value={String(val ?? '')}
                  onChange={(e) => setParams({ ...params, [p.key]: e.target.value })}
                />
                {p.help ? <p className="help">{p.help}</p> : null}
              </div>
            );
          if (p.type === 'assets') return null;
          const num = typeof val === 'number' ? val : Number(p.default);
          return (
            <div className="mb-[22px]" key={p.key}>
              <div className="range-top">
                <label htmlFor={`p-${p.key}`}>{p.label}</label>
                <strong>
                  {num}
                  {unit(p.type)}
                </strong>
              </div>
              <input
                type="range"
                id={`p-${p.key}`}
                min={p.min}
                max={p.max}
                step={p.step ?? 1}
                value={num}
                onChange={(e) => setParams({ ...params, [p.key]: Number(e.target.value) })}
              />
              {p.help ? <p className="help">{p.help}</p> : null}
            </div>
          );
        })}

        <p className="field" id="assetsLbl">
          {template.assets.max === 1 ? 'Asset' : `Assets (${template.assets.min}–${template.assets.max})`}
        </p>
        <div className="mb-[22px] flex flex-wrap gap-1.5" role="group" aria-labelledby="assetsLbl">
          {template.assets.allowed.map((a) => (
            <button
              key={a}
              type="button"
              className="chip"
              aria-pressed={assets.includes(a)}
              onClick={() => toggleAsset(a)}
            >
              {a}
            </button>
          ))}
        </div>

        <label className="field" htmlFor="sName">
          Name
        </label>
        <input
          id="sName"
          className="input mb-[22px]"
          maxLength={60}
          placeholder="ETH breakout 48h"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label className="field" htmlFor="sDesc">
          Description <span className="font-normal text-muted">(optional)</span>
        </label>
        <textarea
          id="sDesc"
          className="input mb-[22px] !h-auto min-h-[80px] py-3"
          maxLength={600}
          placeholder="What it does, in plain words."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="mb-[22px]">
          <div className="range-top">
            <label htmlFor="sShare">Creator share</label>
            <strong>{share}%</strong>
          </div>
          <input
            type="range"
            id="sShare"
            min={0}
            max={30}
            step={0.5}
            value={share}
            onChange={(e) => setShare(Number(e.target.value))}
          />
          <p className="help">
            Your share of followers’ profit above their previous high. You can lower it later, never raise it.
          </p>
        </div>

        {done ? (
          <div className="notice ok">
            Registered on-chain.{' '}
            <a className="linkbtn !text-inherit" href={done.txUrl} target="_blank" rel="noopener noreferrer">
              View transaction
            </a>
            {done.id !== null ? (
              done.indexed ? (
                <>
                  {' · '}
                  <Link className="linkbtn !text-inherit" href={strategyHref(done.id)}>
                    Open strategy #{done.id}
                  </Link>
                </>
              ) : (
                ` · Strategy #${done.id} appears here once indexed (a few seconds)…`
              )
            ) : null}
          </div>
        ) : (
          <>
            <button
              className="btn btn-dark btn-lg w-full"
              type="button"
              onClick={() => void create()}
              disabled={creating !== null || busy !== null || !cfg.registry}
            >
              {creating ??
                (!isConnected
                  ? 'Connect wallet to create'
                  : !signedIn
                    ? 'Sign in to create (no gas)'
                    : 'Create strategy')}
            </button>
            <p className="help">
              {cfg.registry
                ? 'Two steps: the server stores the strategy details, then your wallet signs the on-chain registration. You become its creator.'
                : 'The strategy registry is not deployed on this network yet.'}
            </p>
          </>
        )}
      </div>

      <div className="card min-[1061px]:sticky min-[1061px]:top-[88px]" aria-live="polite">
        <h2>Backtest preview</h2>
        <p className="sub">
          Last 720 hourly candles, 0.1% cost per trade, against buying and holding the same assets.
        </p>
        {preview.kind === 'loading' ? (
          <div className="empty !mt-0">Running the backtest…</div>
        ) : preview.kind === 'error' ? (
          <div className="empty !mt-0">
            {preview.message}
            {preview.signIn ? (
              <>
                {' '}
                <button type="button" className="linkbtn" onClick={openConnectModal}>
                  {isConnected ? 'Sign in' : 'Connect wallet'}
                </button>
              </>
            ) : null}
          </div>
        ) : r ? (
          <>
            <dl className="mb-4 grid grid-cols-3 gap-3 max-[420px]:grid-cols-2">
              <Kpi label="Return" tone={tone(r.ret)}>
                {pct(r.ret * 100)}
              </Kpi>
              <Kpi label="vs holding" tone={tone(r.ret - r.hold)}>
                {pct((r.ret - r.hold) * 100)}
              </Kpi>
              <Kpi label="Max drawdown">{pctPlain(r.maxDrawdown * 100)}</Kpi>
              <Kpi label="Win rate">{r.trades > 0 ? `${Math.round(r.winRate * 100)}%` : '—'}</Kpi>
              <Kpi label="Trades">{nf(r.trades)}</Kpi>
              <Kpi label="Holding">{pct(r.hold * 100)}</Kpi>
            </dl>
            {points.length > 1 ? (
              <>
                <div className="legend mb-3 flex flex-wrap gap-x-5 gap-y-1 text-[13.5px] text-muted">
                  <span>
                    <i style={{ background: r.ret >= 0 ? '#12B76A' : '#D92D20' }} />
                    {name.trim() || 'This strategy'}
                  </span>
                  <span>
                    <i className="h" />
                    Holding {assets.join(', ')}
                  </span>
                </div>
                <EquityChart points={points} label={name.trim() || 'Backtest'} gradientId="bt" />
              </>
            ) : null}
            <p className="help">
              Data: {r.source}, {nf(r.candles)} hourly candles. A backtest is not a track record: past results
              don’t predict future returns.
            </p>
          </>
        ) : (
          <div className="empty !mt-0">Adjust the settings to see a preview.</div>
        )}
      </div>
    </div>
  );
}
