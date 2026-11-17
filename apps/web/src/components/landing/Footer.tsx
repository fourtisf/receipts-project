import Link from 'next/link';
import { explorerAddress } from '@receipts/shared';
import { APP_NAME, LINKS } from '@/lib/env';
import { checksum } from '@/lib/address';
import { LogoMark } from '@/components/ui';

const linkCls = 'text-left text-[15px] text-muted';

export function Footer({ registry, factory }: { registry: string | null; factory: string | null }) {
  const verify: [string, string][] = [];
  if (registry) verify.push(['Contracts', explorerAddress(registry)]);
  if (LINKS.github) verify.push(['GitHub', LINKS.github]);
  verify.push(['Docs', LINKS.docs ?? '/docs']);
  const social: [string, string][] = [];
  if (LINKS.x) social.push(['X', LINKS.x]);
  if (LINKS.telegram) social.push(['Telegram', LINKS.telegram]);
  const contracts: [string, string][] = [];
  if (registry) contracts.push(['SignalRegistry', registry]);
  if (factory) contracts.push(['VaultFactory', factory]);

  return (
    <footer className="lfoot border-t border-line pb-9 pt-12">
      <div className="wrap">
        <div className="mb-10 flex flex-wrap justify-between gap-10">
          <div>
            <Link className="logo" href="/">
              <LogoMark width={20} lines={false} />
              {APP_NAME}
            </Link>
            <p className="mt-2.5 max-w-[22em] text-[15px] text-muted">
              Verifiable trading strategies and non-custodial vaults on Robinhood Chain.
            </p>
          </div>
          <div className="flex gap-16 max-[800px]:gap-9">
            <div>
              <p className="mb-3 text-[13.5px] font-semibold text-faint">Product</p>
              <nav className="grid gap-2" aria-label="Product">
                <Link className={linkCls} href="/app">
                  Strategies
                </Link>
                <Link className={linkCls} href="/app/vault">
                  Vault
                </Link>
                <Link className={linkCls} href="/app/verify">
                  Check a receipt
                </Link>
              </nav>
            </div>
            {verify.length > 0 ? (
              <div>
                <p className="mb-3 text-[13.5px] font-semibold text-faint">Verify</p>
                <nav className="grid gap-2" aria-label="Verify">
                  {verify.map(([label, href]) =>
                    href.startsWith('/') ? (
                      <Link key={label} className={linkCls} href={href}>
                        {label}
                      </Link>
                    ) : (
                      <a
                        key={label}
                        className={linkCls}
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {label}
                      </a>
                    ),
                  )}
                </nav>
              </div>
            ) : null}
            {social.length > 0 ? (
              <div>
                <p className="mb-3 text-[13.5px] font-semibold text-faint">Social</p>
                <nav className="grid gap-2" aria-label="Social">
                  {social.map(([label, href]) => (
                    <a key={label} className={linkCls} href={href} target="_blank" rel="noopener noreferrer">
                      {label}
                    </a>
                  ))}
                </nav>
              </div>
            ) : null}
          </div>
        </div>
        {contracts.length > 0 ? (
          <div className="mb-5 flex flex-wrap gap-x-6 gap-y-1.5 text-[13px] text-muted">
            {contracts.map(([name, addr]) => (
              <span key={name} className="min-w-0 break-all">
                {name}{' '}
                <a
                  className="src font-mono text-ink-2"
                  href={explorerAddress(addr)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="View on Blockscout"
                >
                  {checksum(addr)}
                </a>
              </span>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap justify-between gap-4 border-t border-line-2 pt-[22px] text-[13.5px] text-faint">
          <span>
            Not investment advice. Robinhood Stock Tokens are not available to US persons.{' '}
            <Link href="/terms" className="hover:text-ink">
              Terms
            </Link>
            {' · '}
            <Link href="/privacy" className="hover:text-ink">
              Privacy
            </Link>
          </span>
          <span>
            © {new Date().getFullYear()} {APP_NAME}
          </span>
        </div>
      </div>
    </footer>
  );
}
