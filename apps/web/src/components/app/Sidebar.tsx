'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useBlockNumber } from 'wagmi';
import { APP_NAME } from '@/lib/env';
import { nf } from '@/lib/format';
import { LogoMark } from '@/components/ui';

const NAV = [
  {
    href: '/app',
    label: 'Strategies',
    match: (p: string) => p === '/app' || p.startsWith('/app/s/'),
    icon: (
      <path
        d="M3 13l3.5-4 3 2.5L15 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  {
    href: '/app/vault',
    label: 'Vault',
    match: (p: string) => p.startsWith('/app/vault'),
    icon: (
      <>
        <rect
          x="2.5"
          y="4"
          width="13"
          height="10.5"
          rx="2.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
        />
        <circle cx="11.5" cy="9.25" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      </>
    ),
  },
  {
    href: '/app/verify',
    label: 'Check a receipt',
    match: (p: string) => p.startsWith('/app/verify'),
    icon: (
      <>
        <path
          d="M4 2.5h10v13l-1.7-1.2-1.6 1.2-1.7-1.2-1.7 1.2-1.6-1.2L4 15.5z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path
          d="M6.8 8.3l1.6 1.6 3-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ),
  },
];

function NetworkCard({
  chainId,
  chainName,
  explorer,
}: {
  chainId: number;
  chainName: string;
  explorer: string;
}) {
  const { data: block, isError } = useBlockNumber({
    chainId,
    watch: true,
    query: { refetchInterval: 6_000 },
  });
  return (
    <div className="net flex items-center gap-2.5 rounded-[10px] border border-line bg-white px-3 py-2.5 text-[13px] leading-[1.35]">
      <i className={block === undefined ? 'off' : undefined} aria-hidden="true" />
      <div className="min-w-0">
        <b className="font-semibold">{chainName}</b>
        <span className="block font-mono text-[11.5px] text-faint" aria-live="off">
          {block !== undefined ? (
            <a
              href={`${explorer}/block/${block.toString()}`}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-ink"
              title="View block on Blockscout"
            >
              Block {nf(block)}
            </a>
          ) : isError ? (
            'Block unavailable'
          ) : (
            'Reading block…'
          )}
        </span>
      </div>
    </div>
  );
}

export function Sidebar({
  chainId,
  chainName,
  explorer,
}: {
  chainId: number;
  chainName: string;
  explorer: string;
}) {
  const pathname = usePathname() ?? '/app';
  return (
    <aside className="side sticky top-0 flex h-screen flex-col border-r border-line bg-[#FCFCFC] px-3.5 py-[18px] max-[800px]:z-30 max-[800px]:h-auto max-[800px]:flex-row max-[800px]:items-center max-[800px]:gap-1.5 max-[800px]:overflow-x-auto max-[800px]:border-b max-[800px]:border-r-0 max-[800px]:px-3 max-[800px]:py-2.5">
      <Link
        className="logo mx-2.5 mb-[26px] mt-0.5 text-[17px] max-[800px]:my-0 max-[800px]:ml-1 max-[800px]:mr-2"
        href="/app"
      >
        <LogoMark width={20} />
        {APP_NAME}
      </Link>
      <p className="mx-3 mb-2 text-[12px] font-semibold text-faint max-[800px]:hidden">Menu</p>
      <nav aria-label="App" className="grid gap-0.5 max-[800px]:flex">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} aria-current={n.match(pathname) ? 'page' : undefined}>
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
              {n.icon}
            </svg>
            {n.label}
          </Link>
        ))}
      </nav>
      <div className="mt-auto grid gap-2.5 max-[800px]:hidden">
        <NetworkCard chainId={chainId} chainName={chainName} explorer={explorer} />
        <Link
          className="flex items-center gap-2 px-3 py-1.5 text-[13.5px] text-muted hover:text-ink"
          href="/"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
            <path
              d="M8.5 3L4.5 7l4 4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Back to website
        </Link>
      </div>
    </aside>
  );
}
