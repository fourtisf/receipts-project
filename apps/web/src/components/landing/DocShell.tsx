import type { ReactNode } from 'react';
import { chainConfigSchema } from '@receipts/shared';
import { apiTry } from '@/lib/api.server';
import { LandingNav } from './LandingNav';
import { Footer } from './Footer';

/** Landing chrome (nav + footer) around a long-form page. */
export async function DocShell({ children }: { children: ReactNode }) {
  const chain = await apiTry('/config/chain', chainConfigSchema, 300);
  return (
    <>
      <LandingNav />
      <main className="wrap pb-24 pt-16 max-[800px]:pt-10">{children}</main>
      <Footer
        registry={chain.ok ? chain.data.registry : null}
        factory={chain.ok ? chain.data.factory : null}
      />
    </>
  );
}
