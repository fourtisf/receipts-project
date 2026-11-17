import type { ReceiptDetail, ReceiptSummary } from '@receipts/shared';
import { APP_NAME } from '@/lib/env';
import { amount, ago, bpsPct, nf, price, short, timeUtc, until } from '@/lib/format';
import { revealState, tradeLabel, type RevealState } from '@/lib/receipt';
import { ExtLink, LogoMark } from '@/components/ui';

const NBSP2 = '  ';

function RevealWord({ state }: { state: RevealState }) {
  switch (state) {
    case 'match':
      return <span className="gain">matches ✓</span>;
    case 'mismatch':
      return <span className="loss">mismatch ✕</span>;
    case 'missed':
      return <span className="loss">missed</span>;
    default:
      return <span className="dim">pending</span>;
  }
}

export function Stamp({ state }: { state: RevealState }) {
  if (state === 'match')
    return (
      <div className="stamp" aria-label="Matches commit">
        Matches
        <br />
        commit
      </div>
    );
  if (state === 'missed')
    return (
      <div className="stamp bad" aria-label="Reveal missed">
        Reveal
        <br />
        missed
      </div>
    );
  if (state === 'mismatch')
    return (
      <div className="stamp bad" aria-label="Trade does not match the signal">
        Trade
        <br />
        mismatch
      </div>
    );
  return (
    <div className="stamp wait" aria-label="Awaiting reveal">
      Awaiting
      <br />
      reveal
    </div>
  );
}

/** Small slip used in grids and on the landing preview. */
export function CompactSlip({ r, now }: { r: ReceiptSummary; now: number }) {
  const state = revealState(r);
  const trade = tradeLabel(r);
  return (
    <div className="slipwrap">
      <div className="slip">
        <div className="row">
          <span className="h4">#{nf(r.receiptNo)}</span>
          <span className="dim">{ago(r.committedAt, now)}</span>
        </div>
        <div className="row">
          <span className="dim">{r.strategyName}</span>
        </div>
        <hr className="cut" />
        <div className="row">
          <span>
            {trade ??
              (state === 'pending' ? 'signal hidden' : state === 'missed' ? 'never revealed' : 'no trade')}
          </span>
          <span>{r.executions > 0 ? amount(r.valueUsd) : state === 'match' ? 'paper' : '—'}</span>
        </div>
        <div className="row">
          <span className="dim">commit</span>
          <span>{short(r.hash)}</span>
        </div>
        <div className="row">
          <span className="dim">vs oracle</span>
          <span>{r.slippageBps === null ? '—' : bpsPct(r.slippageBps)}</span>
        </div>
        <div className="row">
          <span className="dim">reveal</span>
          <RevealWord state={state} />
        </div>
      </div>
    </div>
  );
}

/** Before reveal the signal is hidden, but vault executions (and their pair) are already public. */
function tradeOf(d: ReceiptDetail): string | null {
  const t = tradeLabel(d);
  if (t) return t;
  const e = d.executionList[0];
  if (!e) return null;
  if (e.tokenInSymbol === 'USDG' && e.tokenOutSymbol) return `BUY ${e.tokenOutSymbol}`;
  if (e.tokenOutSymbol === 'USDG' && e.tokenInSymbol) return `SELL ${e.tokenInSymbol}`;
  return null;
}

/** Full receipt with the three steps; `hl` highlights one step (landing "How it works"). */
export function FullSlip({ d, hl = 0, now }: { d: ReceiptDetail; hl?: 0 | 1 | 2 | 3; now?: number }) {
  const state = revealState(d);
  const H = (k: number) => (hl === k ? 'hl' : undefined);
  const first = d.executionList[0];
  const trade = tradeOf(d);
  const n = d.executionList.length;
  return (
    <div className="slipwrap">
      <div className="slip" role="group" aria-label={`Receipt #${d.receiptNo}`}>
        <div className="brand">
          <LogoMark width={15} lines={false} />
          {APP_NAME}
        </div>
        <div className="row">
          <span className="h4">Receipt #{nf(d.receiptNo)}</span>
          <span className="dim">{timeUtc(d.committedAt)}</span>
        </div>
        <div className="row">
          <span className="dim">Strategy</span>
          <span>{d.strategyName}</span>
        </div>
        <hr className="cut" />
        <div className="row">
          <span className={H(1)}>1 Commit</span>
          <span className="dim">
            blk <ExtLink href={d.commit.explorerUrl}>{nf(d.commit.blockNumber)}</ExtLink>
          </span>
        </div>
        <div className="row">
          <span className="dim">
            {NBSP2}
            {short(d.hash)}
          </span>
          <span />
        </div>
        <div className="row">
          <span className={H(2)}>2 Execute</span>
          <span className="dim">
            {first ? (
              <>
                blk <ExtLink href={first.source.explorerUrl}>{nf(first.source.blockNumber)}</ExtLink>
              </>
            ) : state === 'pending' ? (
              'waiting'
            ) : (
              'no vaults'
            )}
          </span>
        </div>
        <div className="row">
          <span>
            {NBSP2}
            {trade ?? (state === 'missed' ? 'never revealed' : 'signal hidden')}
          </span>
          <span>{n > 0 ? amount(d.valueUsd) : state === 'match' ? 'paper' : '—'}</span>
        </div>
        {n > 1 ? (
          <div className="row">
            <span className="dim">
              {NBSP2}across {n} vaults
            </span>
            <span />
          </div>
        ) : null}
        <div className="row">
          <span className="dim">
            {NBSP2}fill {d.fillPriceUsd ? price(d.fillPriceUsd) : '—'}
          </span>
          <span className="dim">oracle {d.oraclePriceUsd ? price(d.oraclePriceUsd) : '—'}</span>
        </div>
        <div className="row">
          <span className={H(3)}>3 {state === 'missed' ? 'No reveal' : 'Reveal'}</span>
          <span className="dim">
            {d.reveal ? (
              <>
                blk <ExtLink href={d.reveal.explorerUrl}>{nf(d.reveal.blockNumber)}</ExtLink>
              </>
            ) : state === 'missed' ? (
              d.missed ? (
                <ExtLink href={d.missed.explorerUrl}>window closed</ExtLink>
              ) : (
                'window closed'
              )
            ) : (
              `due ${until(d.revealDeadline, now)}`
            )}
          </span>
        </div>
        <div className="row">
          <span className="dim">{NBSP2}hash(signal+salt)</span>
          <span className="dim">{d.status === 'REVEALED' ? short(d.hash) : '—'}</span>
        </div>
        <hr className="cut" />
        <div className="row">
          <span className="dim">Slippage vs oracle</span>
          <span>{d.slippageBps === null ? '—' : bpsPct(d.slippageBps)}</span>
        </div>
        <div className="row">
          <span className="dim">Fee to {APP_NAME}</span>
          <span>0.00</span>
        </div>
        <div style={{ height: 100 }} />
        <Stamp state={state} />
      </div>
    </div>
  );
}

/** Same layout with no numbers, for when nothing has been committed yet. */
export function EmptySlip({ hl = 0, compact = false }: { hl?: 0 | 1 | 2 | 3; compact?: boolean }) {
  const H = (k: number) => (hl === k ? 'hl' : undefined);
  if (compact)
    return (
      <div className="slipwrap">
        <div className="slip">
          <div className="row">
            <span className="h4">No receipts yet</span>
          </div>
          <hr className="cut" />
          <p className="dim">The first commit will appear here within seconds.</p>
        </div>
      </div>
    );
  return (
    <div className="slipwrap">
      <div className="slip">
        <div className="brand">
          <LogoMark width={15} lines={false} />
          {APP_NAME}
        </div>
        <div className="row">
          <span className="h4">Receipt #—</span>
          <span className="dim">—</span>
        </div>
        <hr className="cut" />
        <div className="row">
          <span className={H(1)}>1 Commit</span>
          <span className="dim">blk —</span>
        </div>
        <div className="row">
          <span className={H(2)}>2 Execute</span>
          <span className="dim">blk —</span>
        </div>
        <div className="row">
          <span className={H(3)}>3 Reveal</span>
          <span className="dim">blk —</span>
        </div>
        <hr className="cut" />
        <p className="dim">No receipts yet — the first commit will appear here within seconds.</p>
      </div>
    </div>
  );
}
