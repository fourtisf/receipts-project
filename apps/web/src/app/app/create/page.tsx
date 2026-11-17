import type { Metadata } from 'next';
import { templateListSchema } from '@receipts/shared';
import { apiTry } from '@/lib/api.server';
import { AppPage, PageHead } from '@/components/app/AppPage';
import { CreateStrategy } from '@/components/app/CreateStrategy';

export const metadata: Metadata = { title: 'Create strategy' };

export default async function CreatePage() {
  const templates = await apiTry('/templates', templateListSchema, 300);
  return (
    <AppPage crumbs={[{ label: 'Create strategy' }]}>
      <PageHead title="Create strategy">
        <p>
          Start from a template, check a backtest, and register it on-chain from your wallet. From its first
          signal, every trade is committed before it executes and counted on its public record.
        </p>
      </PageHead>
      {templates.ok && templates.data.items.length > 0 ? (
        <CreateStrategy templates={templates.data.items} />
      ) : (
        <div className="error" role="alert">
          Templates could not be loaded{templates.ok ? '' : `: ${templates.error.message}`}. Try again in a
          moment.
        </div>
      )}
    </AppPage>
  );
}
