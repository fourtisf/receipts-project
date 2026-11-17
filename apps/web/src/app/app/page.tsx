import type { Metadata } from 'next';
import { statsSchema, strategyListSchema } from '@receipts/shared';
import { apiTry } from '@/lib/api.server';
import { nf, usdCompact } from '@/lib/format';
import { AppPage, PageHead } from '@/components/app/AppPage';
import { StrategiesToolbar } from '@/components/app/StrategiesToolbar';
import { isCategory, isSort, type Category, type Sort } from '@/lib/strategy';
import { StrategiesTable } from '@/components/app/StrategiesTable';
import { Kpi } from '@/components/ui';

export const metadata: Metadata = { title: 'Strategies' };

export default async function StrategiesPage({
  searchParams,
}: {
  searchParams: { [k: string]: string | string[] | undefined };
}) {
  const category: Category = isCategory(searchParams.category) ? searchParams.category : 'all';
  const sort: Sort = isSort(searchParams.sort) ? searchParams.sort : 'vs';
  const [stats, list] = await Promise.all([
    apiTry('/stats', statsSchema),
    apiTry(`/strategies?category=${category}&sort=${sort}&limit=100`, strategyListSchema),
  ]);
  const s = stats.ok ? stats.data : null;

  return (
    <AppPage crumbs={[{ label: 'Strategies' }]}>
      <PageHead title="Strategies">
        <p>
          Returns come only from revealed receipts. Every strategy is listed with its losses and missed
          reveals.
        </p>
      </PageHead>
      <dl className="mb-6 grid grid-cols-4 gap-3.5 max-[1060px]:grid-cols-2">
        <Kpi label="Receipts printed">{s ? nf(s.receiptsPrinted) : '—'}</Kpi>
        <Kpi label="Strategies live">{s ? nf(s.strategiesLive) : '—'}</Kpi>
        <Kpi label="Missed reveals">{s ? nf(s.missedReveals) : '—'}</Kpi>
        <Kpi label="In user vaults">{s ? usdCompact(s.tvlUsd) : '—'}</Kpi>
      </dl>
      <StrategiesToolbar category={category} sort={sort} />
      {list.ok ? (
        <>
          <StrategiesTable
            items={list.data.items}
            emptyText={
              category === 'all'
                ? 'No strategies yet. The first one appears here as soon as it is registered on-chain.'
                : 'No strategies in this filter yet.'
            }
          />
          {list.data.nextCursor ? (
            <p className="help">
              Showing the first {list.data.items.length} of {nf(list.data.totals.count)} strategies.
            </p>
          ) : null}
        </>
      ) : (
        <div className="error" role="alert">
          Strategies could not be loaded: {list.error.message}
        </div>
      )}
    </AppPage>
  );
}
