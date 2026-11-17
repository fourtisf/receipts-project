import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import { APP_NAME } from '@/lib/env';
import { WalletButton } from './WalletButton';

export type Crumb = { label: string; href?: string };

/** Topbar (breadcrumb + wallet) and the padded content area of an app screen. */
export function AppPage({ crumbs, children }: { crumbs: Crumb[]; children: ReactNode }) {
  return (
    <>
      <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-4 border-b border-line bg-white/[.88] px-9 backdrop-blur-[12px] max-[800px]:static max-[800px]:justify-end max-[800px]:px-[18px]">
        <nav aria-label="Breadcrumb" className="min-w-0 truncate text-[14.5px] text-muted max-[800px]:hidden">
          <Link href="/app" className="hover:text-ink">
            {APP_NAME}
          </Link>
          {crumbs.map((c, i) => (
            <Fragment key={`${c.label}-${i}`}>
              {' / '}
              {i === crumbs.length - 1 ? (
                <b className="font-semibold text-ink" aria-current="page">
                  {c.label}
                </b>
              ) : c.href ? (
                <Link href={c.href} className="hover:text-ink">
                  {c.label}
                </Link>
              ) : (
                c.label
              )}
            </Fragment>
          ))}
        </nav>
        <div className="flex items-center gap-2.5">
          <WalletButton />
        </div>
      </header>
      <main className="max-w-[1240px] p-9 max-[800px]:px-[18px] max-[800px]:py-[22px]">{children}</main>
    </>
  );
}

export function PageHead({
  title,
  children,
  actions,
}: {
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="phead mb-[26px] flex flex-wrap items-end justify-between gap-5">
      <div className="min-w-0">
        <h1>{title}</h1>
        {children}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
