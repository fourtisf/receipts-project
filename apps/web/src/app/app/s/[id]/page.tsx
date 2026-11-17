import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  equitySchema,
  explorerAddress,
  receiptListSchema,
  strategyDetailSchema,
  type StrategyDetail,
} from '@receipts/shared';
import { ApiError, apiGet, apiTry } from '@/lib/api.server';
import { nf, pct, pctPlain, tone } from '@/lib/format';
import { receiptHref } from '@/lib/receipt';
import { AppPage, PageHead } from '@/components/app/AppPage';
import { EquityChart } from '@/components/app/EquityChart';
import { CopyPanel } from '@/components/app/CopyPanel';
import { OnChainFacts } from '@/components/app/OnChainFacts';
import { creatorLabel, sharePct } from '@/lib/strategy';
import { CompactSlip } from '@/components/receipt/ReceiptSlip';
import { ExtLink, Kpi, StrategyTags } from '@/components/ui';
import { LiveRefresh } from '@/components/LiveRefresh';

type Params = { params: { id: string } };

async function loadStrategy(id: string): Promise<StrategyDetail> {
  try {
    return await apiGet(`/strategies/${encodeURIComponent(id)}`, strategyDetailSchema);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  }
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const r = await apiTry(`/strategies/${encodeURIComponent(params.id)}`, strategyDetailSchema);
  if (!r.ok) return { title: 'Strategy' };
  const s = r.data;
  return {
    title: s.name,
    description: `${s.name}: ${pct(s.ret30d)} over 30 days (${pct(s.vsHold)} vs holding), ${nf(s.receipts)} receipts, ${nf(s.missed)} missed reveals. Every trade committed on-chain before it executes.`,
  };
}

export default async function StrategyPage({ params }: Params) {
  const s = await loadStrategy(params.id);
  const [equity, receipts] = await Promise.all([
    apiTry(`/strategies/${s.id}/equity?range=30d`, equitySchema, 60),
    apiTry(`/strategies/${s.id}/receipts?limit=6`, receiptListSchema),
  ]);
  const now = Date.now();
  const col = s.ret30d !== null && s.ret30d < 0 ? '#D92D20' : '#12B76A';
  const points = equity.ok ? equity.data.points : [];
  const share = sharePct(s.creatorShareBps);
  const registryHref = s.registry ? explorerAddress(s.registry) : s.registered.explorerUrl;

  return (
    <AppPage crumbs={[{ label: 'Strategies', href: '/app' }, { label: s.name }]}>
      <Link
        className="mb-3.5 inline-flex items-center gap-1.5 text-[14px] text-muted hover:text-ink"
        href="/app"
      >
        ‹ All strategies
      </Link>
      <PageHead
        title={
          <>
            {s.name}
            <StrategyTags house={s.house} kind={s.kind} realFunds={Boolean(s.houseVault)} />
          </>
        }
      >
        {s.description ? <p>{s.description}</p> : null}
        <p className="!text-[13.5px]">
          {s.templateName}, by {creatorLabel(s)}
        </p>
      </PageHead>

      <div className="grid grid-cols-[1fr_360px] items-start gap-6 max-[1060px]:grid-cols-1">
        <div className="min-w-0">
          <dl className="mb-4 grid grid-cols-3 gap-3 max-[800px]:grid-cols-2">
            <Kpi label="30-day return" tone={tone(s.ret30d)}>
              {pct(s.ret30d)}
            </Kpi>
            <Kpi label="vs holding" tone={tone(s.vsHold)}>
              {pct(s.vsHold)}
            </Kpi>
            <Kpi label="Max drawdown">{pctPlain(s.maxDrawdown30d)}</Kpi>
            <Kpi label="Receipts">
              <ExtLink href={registryHref} className="hover:underline">
                {nf(s.receipts)}
              </ExtLink>
            </Kpi>
            <Kpi label="Missed reveals" tone={s.missed > 0 ? 'loss' : ''}>
              <ExtLink href={registryHref} className="hover:underline">
                {nf(s.missed)}
              </ExtLink>
            </Kpi>
            <Kpi label="Creator share">
              <ExtLink href={s.registered.explorerUrl} className="hover:underline">
                {share}
              </ExtLink>
            </Kpi>
          </dl>

          <div className="card">
            <div className="legend mb-3 flex flex-wrap gap-x-5 gap-y-1 text-[13.5px] text-muted">
              <span>
                <i style={{ background: col }} />
                {s.name}
              </span>
              <span>
                <i className="h" />
                Holding {s.market}
              </span>
              {equity.ok && points.length > 1 && equity.data.basis !== 'live' ? (
                <span className="ml-auto text-faint">
                  {equity.data.basis === 'paper'
                    ? 'Paper performance from Chainlink prices'
                    : 'Live and paper receipts'}
                </span>
              ) : null}
            </div>
            {points.length > 1 ? (
              <EquityChart points={points} label={s.name} gradientId={`eq-${s.id}`} />
            ) : (
              <div className="empty !mt-0">
                {equity.ok
                  ? 'No performance history yet. The chart fills in as receipts are revealed.'
                  : `The chart could not be loaded: ${equity.error.message}`}
              </div>
            )}
          </div>

          <h2 className="mb-3.5 mt-8 text-[19px] font-bold tracking-[-0.02em]">Recent receipts</h2>
          {receipts.ok && receipts.data.items.length > 0 ? (
            <div className="rgrid grid grid-cols-3 gap-4 max-[1060px]:grid-cols-2 max-[800px]:grid-cols-1">
              {receipts.data.items.map((r) => (
                <Link key={r.receiptNo} href={receiptHref(r)} aria-label={`Receipt #${r.receiptNo}`}>
                  <CompactSlip r={r} now={now} />
                </Link>
              ))}
            </div>
          ) : (
            <div className="empty !mt-0">
              {receipts.ok
                ? 'No receipts yet — the first commit will appear here within seconds.'
                : `Receipts could not be loaded: ${receipts.error.message}`}
            </div>
          )}
        </div>

        <aside className="sticky top-[88px] grid gap-4 max-[1060px]:static">
          <CopyPanel strategyName={s.name} />
          <OnChainFacts s={s} />
        </aside>
      </div>
      <LiveRefresh topic={`strategy:${s.id}`} />
    </AppPage>
  );
}
