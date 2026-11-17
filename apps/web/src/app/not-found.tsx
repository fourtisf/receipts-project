import Link from 'next/link';
import { APP_NAME } from '@/lib/env';
import { LogoMark } from '@/components/ui';

export default function NotFound() {
  return (
    <main className="wrap grid min-h-[70vh] place-items-center py-24 text-center">
      <div>
        <Link className="logo mb-8 inline-flex" href="/">
          <LogoMark width={24} />
          {APP_NAME}
        </Link>
        <h1 className="mb-3 text-[32px] font-bold tracking-[-0.035em]">Nothing printed here</h1>
        <p className="mx-auto mb-7 max-w-[30em] text-muted">
          This page or receipt does not exist. New receipts appear within seconds of their commit, so check
          the number or browse the strategies.
        </p>
        <div className="flex flex-wrap justify-center gap-2.5">
          <Link className="btn btn-dark" href="/app">
            Browse strategies
          </Link>
          <Link className="btn" href="/app/verify">
            Check a receipt
          </Link>
        </div>
      </div>
    </main>
  );
}
