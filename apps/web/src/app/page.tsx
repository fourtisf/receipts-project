import {
  chainConfigSchema,
  receiptDetailSchema,
  receiptListSchema,
  statsSchema,
  strategyListSchema,
  type ReceiptSummary,
} from '@receipts/shared';
import { apiTry } from '@/lib/api.server';
import { LandingNav } from '@/components/landing/LandingNav';
import { Hero } from '@/components/landing/Hero';
import {
  BuiltOn,
  ComparisonTable,
  Faq,
  FeatureCards,
  FinalCta,
  Security,
} from '@/components/landing/Sections';
import { HowItWorks } from '@/components/landing/HowItWorks';
import { Footer } from '@/components/landing/Footer';
import { LiveRefresh } from '@/components/LiveRefresh';

export const revalidate = 10;

/** The receipt shown in "How it works": the newest revealed one that a vault executed, else the newest. */
function pickShowcase(items: ReceiptSummary[]): ReceiptSummary | null {
  return (
    items.find((r) => r.status === 'REVEALED' && r.executions > 0) ??
    items.find((r) => r.status === 'REVEALED') ??
    items[0] ??
    null
  );
}

export default async function LandingPage() {
  const [stats, strategies, latest, chain] = await Promise.all([
    apiTry('/stats', statsSchema),
    apiTry('/strategies?limit=5', strategyListSchema),
    apiTry('/receipts/latest?limit=8', receiptListSchema),
    apiTry('/config/chain', chainConfigSchema, 300),
  ]);
  const receipts = latest.ok ? latest.data.items : [];
  const showcase = pickShowcase(receipts);
  const detail = showcase ? await apiTry(`/receipts/${showcase.receiptNo}`, receiptDetailSchema) : null;
  const now = Date.now();

  return (
    <>
      <LandingNav />
      <main>
        <Hero
          live={chain.ok && chain.data.registry !== null}
          strategies={strategies.ok ? strategies.data.items : null}
          latest={receipts[0] ?? null}
          tvlUsd={stats.ok ? stats.data.tvlUsd : null}
          now={now}
        />
        <BuiltOn />
        <FeatureCards
          stats={stats.ok ? stats.data : null}
          maxDailyLimitUsd={chain.ok ? chain.data.maxDailyLimitUsd : null}
        />
        <HowItWorks receipt={detail?.ok ? detail.data : null} now={now} />
        <Security />
        <ComparisonTable />
        <Faq />
        <FinalCta />
      </main>
      <Footer
        registry={chain.ok ? chain.data.registry : null}
        factory={chain.ok ? chain.data.factory : null}
      />
      <LiveRefresh topic="receipts" />
    </>
  );
}
