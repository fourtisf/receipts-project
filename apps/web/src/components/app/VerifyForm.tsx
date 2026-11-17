'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { receiptDetailSchema, receiptListSchema, type ReceiptDetail } from '@receipts/shared';
import { ClientApiError, fetchApi } from '@/lib/api.client';
import { useChainConfig } from '@/lib/chain-config';
import { receiptHref, strategyHref } from '@/lib/receipt';
import { verifyOnChain, type ChainVerification } from '@/lib/verify-chain';
import { ChecksList } from '@/components/receipt/ChecksList';
import { FullSlip } from '@/components/receipt/ReceiptSlip';
import { VerifiedChecks } from '@/components/receipt/VerifiedChecks';

/** Normalises user input to an API id: receipt number, full commit hash, or strategyId-nonce. */
export function parseReceiptQuery(raw: string): { id: string } | { error: string } {
  const q = raw.trim().replace(/^#/, '').replace(/[,\s]/g, '').toLowerCase();
  if (!q) return { error: 'Enter a receipt number like 48213, or a commit hash that starts with 0x.' };
  if (/^\d+$/.test(q)) return { id: q };
  if (/^\d+-\d+$/.test(q)) return { id: q };
  if (/^0x[0-9a-f]{64}$/.test(q)) return { id: q };
  if (q.startsWith('0x'))
    return { error: 'That hash is incomplete. Paste the full commit hash: 0x followed by 64 characters.' };
  return { error: 'Use a receipt number (48213), a commit hash (0x…) or strategy-nonce (3-17).' };
}

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; receipt: ReceiptDetail; checkedAt: number }
  | { kind: 'chainOnly'; v: ChainVerification; strategyId: number; nonce: number };

export function VerifyForm({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [query, setQuery] = useState(initialQuery);
  const [state, setState] = useState<State>({ kind: 'idle' });
  const abort = useRef<AbortController | null>(null);
  const cfg = useChainConfig();

  const run = useCallback(
    async (raw: string) => {
      const parsed = parseReceiptQuery(raw);
      if ('error' in parsed) {
        setState({ kind: 'error', message: parsed.error });
        return;
      }
      abort.current?.abort();
      const ctl = new AbortController();
      abort.current = ctl;
      setState({ kind: 'loading' });
      try {
        const receipt = await fetchApi(`/receipts/${parsed.id}`, receiptDetailSchema, ctl.signal);
        setState({ kind: 'done', receipt, checkedAt: Date.now() });
        router.replace(`${pathname ?? '/app/verify'}?q=${encodeURIComponent(parsed.id)}`, { scroll: false });
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        // API unreachable: a strategy-nonce id can still be verified straight from the chain
        const pair = /^(\d+)-(\d+)$/.exec(parsed.id);
        const apiDown = !(e instanceof ClientApiError) || e.status === 0 || e.status >= 500;
        if (pair && apiDown && cfg.registry) {
          try {
            const v = await verifyOnChain({
              rpcUrl: cfg.rpcUrl,
              chainId: cfg.chainId,
              registry: cfg.registry,
              factory: cfg.factory,
              strategyId: Number(pair[1]),
              nonce: Number(pair[2]),
            });
            setState({ kind: 'chainOnly', v, strategyId: Number(pair[1]), nonce: Number(pair[2]) });
            return;
          } catch {
            /* fall through to the API error */
          }
        }
        const message =
          e instanceof ClientApiError && e.status === 404
            ? 'No receipt with that number or hash yet. Check for a typo — new commits appear within seconds of confirmation.'
            : e instanceof Error
              ? e.message
              : 'Something went wrong. Try again.';
        setState({ kind: 'error', message });
      }
    },
    [pathname, router, cfg.registry, cfg.rpcUrl, cfg.chainId, cfg.factory],
  );

  useEffect(() => {
    if (initialQuery) void run(initialQuery);
    return () => abort.current?.abort();
    // run once for a ?q= deep link
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void run(query);
  };

  const loadLatest = async () => {
    setState({ kind: 'loading' });
    try {
      const list = await fetchApi('/receipts/latest?limit=20', receiptListSchema);
      const pick = list.items.find((r) => r.status === 'REVEALED') ?? list.items[0];
      if (!pick) {
        setState({
          kind: 'error',
          message: 'No receipts yet — the first commit will appear here within seconds.',
        });
        return;
      }
      setQuery(pick.hash);
      await run(pick.hash);
    } catch (e) {
      setState({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Could not load the latest receipt.',
      });
    }
  };

  return (
    <div className="grid grid-cols-[1fr_360px] items-start gap-6 max-[1060px]:grid-cols-1">
      <div className="card">
        <form onSubmit={onSubmit} noValidate>
          <label className="field" htmlFor="verifyInput">
            Receipt number or commit hash
          </label>
          <div className="flex items-center gap-2 max-[420px]:flex-wrap">
            <input
              className="input mono"
              id="verifyInput"
              placeholder="48213 or 0x7c1e…"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-describedby="verifyHelp"
            />
            <button
              className="btn btn-dark h-[46px] max-[420px]:w-full"
              type="submit"
              disabled={state.kind === 'loading'}
            >
              Check receipt
            </button>
          </div>
          <p className="help" id="verifyHelp">
            No receipt handy?{' '}
            <button type="button" className="linkbtn" onClick={() => void loadLatest()}>
              Use the latest revealed receipt
            </button>
          </p>
        </form>
        <div aria-live="polite">
          {state.kind === 'idle' ? (
            <div className="empty">
              Five checks appear here: commit found, reveal matches, executed after the commit, price within
              the oracle limit, and vault balance changed correctly.
            </div>
          ) : state.kind === 'loading' ? (
            <div className="empty">Checking…</div>
          ) : state.kind === 'error' ? (
            <div className="error" role="alert">
              {state.message}
            </div>
          ) : state.kind === 'chainOnly' ? (
            <>
              <p className="notice ok mt-4">
                <strong className="font-semibold">Verified from chain via {state.v.rpcHost}.</strong> The API
                is unreachable, so this check read Robinhood Chain only (no oracle price comparison).
              </p>
              <ChecksList checks={state.v.checks} />
              <p className="help">
                <Link className="linkbtn" href={`/app/s/${state.strategyId}/receipt/${state.nonce}`}>
                  Permalink
                </Link>
              </p>
            </>
          ) : (
            <>
              <VerifiedChecks receipt={state.receipt} />
              <p className="help">
                Strategy:{' '}
                <Link className="linkbtn" href={strategyHref(state.receipt.strategyId)}>
                  {state.receipt.strategyName}
                </Link>
                {' · '}
                <Link className="linkbtn" href={receiptHref(state.receipt)}>
                  Permalink
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
      <div>{state.kind === 'done' ? <FullSlip d={state.receipt} now={state.checkedAt} /> : null}</div>
    </div>
  );
}
