'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { APP_NAME, LINKS } from '@/lib/env';
import { LogoMark } from '@/components/ui';

const SECTIONS = [
  ['features', 'Product'],
  ['how', 'How it works'],
  ['security', 'Security'],
  ['faq', 'FAQ'],
] as const;

export function LandingNav() {
  const [scrolled, setScrolled] = useState(false);
  const home = usePathname() === '/';
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);

  return (
    <header className={`lnav${scrolled ? ' scrolled' : ''}`}>
      <div className="wrap flex h-[70px] items-center gap-9">
        <Link className="logo" href="/" aria-label={`${APP_NAME} home`}>
          <LogoMark width={24} />
          {APP_NAME}
        </Link>
        <nav className="flex gap-[30px] max-[1060px]:hidden" aria-label="Sections">
          {SECTIONS.map(([id, label]) => (
            <a
              key={id}
              href={home ? `#${id}` : `/#${id}`}
              className="text-[15px] font-medium text-muted transition-colors duration-150 hover:text-ink"
            >
              {label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-[18px]">
          <a
            className="text-[15px] font-medium text-muted hover:text-ink max-[800px]:hidden"
            href={LINKS.docs ?? '/docs'}
          >
            Docs
          </a>
          <Link className="btn btn-dark" href="/app">
            Launch app
          </Link>
        </div>
      </div>
    </header>
  );
}
