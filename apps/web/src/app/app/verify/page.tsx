import type { Metadata } from 'next';
import { APP_NAME } from '@/lib/env';
import { AppPage, PageHead } from '@/components/app/AppPage';
import { VerifyForm } from '@/components/app/VerifyForm';

export const metadata: Metadata = { title: 'Check a receipt' };

export default function VerifyPage({ searchParams }: { searchParams: { q?: string | string[] } }) {
  const q = typeof searchParams.q === 'string' ? searchParams.q.slice(0, 80) : '';
  return (
    <AppPage crumbs={[{ label: 'Check a receipt' }]}>
      <PageHead title="Check a receipt">
        <p>
          Paste a receipt number or commit hash. Your browser re-checks it against Robinhood Chain (via{' '}
          {APP_NAME} API as the fast path) and says which source it used.
        </p>
      </PageHead>
      <VerifyForm initialQuery={q} />
    </AppPage>
  );
}
