import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  explorerAddress,
  receiptDetailSchema,
  strategyDetailSchema,
  tokenByAddress,
  type ReceiptDetail,
} from '@receipts/shared';
import { ApiError, apiGet, apiTry } from '@/lib/api.server';
import { amount, bpsPct, dateTimeUtc, nf, short, tokenAmount } from '@/lib/format';
import { shortAddr } from '@/lib/address';
import { revealState, strategyHref, tradeLabel } from '@/lib/receipt';
import { AppPage, PageHead } from '@/components/app/AppPage';
import { VerifiedChecks } from '@/components/receipt/VerifiedChecks';
import { FullSlip } from '@/components/receipt/ReceiptSlip';
import { ExtLink } from '@/components/ui';
import { LiveRefresh } from '@/components/LiveRefresh';

type Params = { params: { id: string; nonce: string } };

async function strategyIdOf(id: string): Promise<number> {
  if (/^\d+$/.test(id)) return Number(id);
  const s = await apiTry(`/strategies/${encodeURIComponent(id)}`, strategyDetailSchema);
  if (!s.ok) notFound();
  return s.data.id;
}

async function loadReceipt(params: Params['params']): Promise<ReceiptDetail> {
  if (!/^\d+$/.test(params.nonce)) notFound();
  const sid = await strategyIdOf(params.id);
  try {
    return await apiGet(`/receipts/${sid}-${params.nonce}`, receiptDetailSchema);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  }
}

const STATUS_TEXT: Record<ReturnType<typeof revealState>, string> = {
  match: 'Revealed, and the reveal matches the commit.',
  mismatch: 'Revealed, but a vault execution does not match the revealed signal.',
  missed: 'The strategy did not reveal before the window closed. This counts as a missed reveal forever.',
  pending: 'Committed. The signal stays hidden until the strategy reveals it.',
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  if (!/^\d+$/.test(params.nonce) || !/^\d+$/.test(params.id)) return { title: 'Receipt' };
  const r = await apiTry(`/receipts/${params.id}-${params.nonce}`, receiptDetailSchema);
  if (!r.ok) return { title: 'Receipt' };
  const d = r.data;
  return {
    title: `Receipt #${d.receiptNo} · ${d.strategyName}`,
    description: `${d.strategyName} receipt #${d.receiptNo}: ${STATUS_TEXT[revealState(d)]}`,
  };
}

export default async function ReceiptPage({ params }: Params) {
  const d = await loadReceipt(params);
  const state = revealState(d);
  const trade = tradeLabel(d);

  return (
    <AppPage
      crumbs={[
        { label: 'Strategies', href: '/app' },
        { label: d.strategyName, href: strategyHref(d.strategyId) },
        { label: `Receipt #${nf(d.receiptNo)}` },
      ]}
    >
      <Link
        className="mb-3.5 inline-flex items-center gap-1.5 text-[14px] text-muted hover:text-ink"
        href={strategyHref(d.strategyId)}
      >
        ‹ {d.strategyName}
      </Link>
      <PageHead
        title={`Receipt #${nf(d.receiptNo)}`}
        actions={
          <Link className="btn" href={`/app/verify?q=${d.receiptNo}`}>
            Check receipt
          </Link>
        }
      >
        <p>
          {STATUS_TEXT[state]} Committed {dateTimeUtc(d.committedAt)} in L2 block{' '}
          <ExtLink href={d.commit.explorerUrl}>{nf(d.commit.blockNumber)}</ExtLink>.
        </p>
      </PageHead>

      <div className="grid grid-cols-[1fr_360px] items-start gap-6 max-[1060px]:grid-cols-1">
        <div className="grid min-w-0 gap-5">
          <div className="card">
            <h2>Checks</h2>
            <p className="sub !mb-0">
              Commit found, reveal matches, executed after the commit, price within the oracle limit, balances
              changed correctly. Every transaction links to Blockscout.
            </p>
            <VerifiedChecks receipt={d} />
          </div>

          <div className="card">
            <h2>Executions</h2>
            <p className="sub">
              {d.executionList.length === 0
                ? state === 'pending'
                  ? 'No vault has executed this signal yet.'
                  : 'No vault executed this signal. Performance uses the Chainlink price at the commit block.'
                : `${d.executionList.length} vault${d.executionList.length === 1 ? '' : 's'} executed ${trade ?? 'this signal'}.`}
            </p>
            {d.executionList.length > 0 ? (
              <div className="tablecard !shadow-none">
                <table className="table stack">
                  <thead>
                    <tr>
                      <th scope="col">Vault</th>
                      <th scope="col">Swap</th>
                      <th scope="col" className="num">
                        Value
                      </th>
                      <th scope="col" className="num">
                        vs oracle
                      </th>
                      <th scope="col" className="num">
                        Transaction
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.executionList.map((e) => {
                      const tin = tokenByAddress(e.tokenIn);
                      const tout = tokenByAddress(e.tokenOut);
                      return (
                        <tr key={e.source.txHash + e.vault}>
                          <td data-l="Vault" className="font-mono text-[13px]">
                            <ExtLink href={explorerAddress(e.vault)}>{shortAddr(e.vault)}</ExtLink>
                          </td>
                          <td data-l="Swap" className="font-mono text-[13px]">
                            <span className="block">
                              {tokenAmount(e.amountIn, tin?.decimals ?? 18)}{' '}
                              {e.tokenInSymbol ?? short(e.tokenIn)}
                            </span>
                            <span className="block text-muted">
                              → {tokenAmount(e.amountOut, tout?.decimals ?? 18)}{' '}
                              {e.tokenOutSymbol ?? short(e.tokenOut)}
                            </span>
                          </td>
                          <td data-l="Value" className="num">
                            {amount(e.valueUsd)}
                          </td>
                          <td data-l="vs oracle" className="num">
                            {bpsPct(e.slippageVsOracleBps)}
                          </td>
                          <td data-l="Transaction" className="num">
                            <ExtLink href={e.source.explorerUrl}>blk {nf(e.source.blockNumber)}</ExtLink>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>

          {d.signal ? (
            <div className="card">
              <h2 className="mb-3.5">Revealed signal</h2>
              <div className="kv">
                <div>
                  <span>Sell</span>
                  <span>
                    <ExtLink href={explorerAddress(d.signal.tokenIn)}>
                      {d.tokenInSymbol ?? shortAddr(d.signal.tokenIn)}
                    </ExtLink>
                  </span>
                </div>
                <div>
                  <span>Buy</span>
                  <span>
                    <ExtLink href={explorerAddress(d.signal.tokenOut)}>
                      {d.tokenOutSymbol ?? shortAddr(d.signal.tokenOut)}
                    </ExtLink>
                  </span>
                </div>
                <div>
                  <span>Size</span>
                  <span>{bpsPct(d.signal.sizeBps, 0)} of allocation</span>
                </div>
                <div>
                  <span>Prompt hash</span>
                  <span className="font-mono text-[13px]">{short(d.signal.promptHash)}</span>
                </div>
                <div>
                  <span>Salt</span>
                  <span className="font-mono text-[13px]">{short(d.signal.salt)}</span>
                </div>
                {d.reveal ? (
                  <div>
                    <span>Reveal transaction</span>
                    <span>
                      <ExtLink href={d.reveal.explorerUrl} className="src font-mono text-[13px]">
                        {short(d.reveal.txHash)}
                      </ExtLink>
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {d.ai ? (
            <div className="card">
              <h2>AI prompt</h2>
              <p className="sub">
                Published at reveal. Model {d.ai.model}; prompt hash{' '}
                <span className="font-mono">{short(d.ai.promptHash)}</span>.
              </p>
              <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-[11px] border border-line-2 bg-bg-2 p-4 font-mono text-[12.5px] text-ink-2">
                {d.ai.prompt}
              </pre>
            </div>
          ) : null}
        </div>

        <div className="sticky top-[88px] max-[1060px]:static max-[1060px]:max-w-[420px]">
          <FullSlip d={d} />
        </div>
      </div>
      {d.status === 'COMMITTED' ? <LiveRefresh topic={`strategy:${d.strategyId}`} /> : null}
    </AppPage>
  );
}
