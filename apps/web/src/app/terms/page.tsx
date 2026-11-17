import type { Metadata } from 'next';
import Link from 'next/link';
import { APP_NAME } from '@/lib/env';
import { DocShell } from '@/components/landing/DocShell';
import { LegalBanner } from '@/components/landing/LegalBanner';

export const metadata: Metadata = { title: 'Terms of use' };

export default function TermsPage() {
  return (
    <DocShell>
      <article className="doc">
        <p className="eyebrow">Legal</p>
        <h1>Terms of use</h1>
        <LegalBanner />
        <h2>1. What {APP_NAME} is</h2>
        <p>
          {APP_NAME} is software: a website and open-source smart contracts on Robinhood Chain that let you
          create a vault you own, choose limits, and let a strategy trade inside it. We do not hold your
          funds, cannot withdraw them, and cannot change your vault. Every transaction is signed by you in
          your own wallet.
        </p>
        <h2>2. Not investment advice</h2>
        <p>
          Nothing on this site is investment, financial, legal or tax advice, or a recommendation to buy or
          sell any asset. Strategy track records, backtests and statistics describe the past and do not
          predict future returns. You decide whether to copy a strategy and with how much.
        </p>
        <h2>3. Eligibility and restricted assets</h2>
        <ul>
          <li>You must be of legal age and allowed to use these services where you live.</li>
          <li>
            <strong>Robinhood Stock Tokens are not available to US persons.</strong> Strategies that trade
            stock tokens may be unavailable in some regions, and we may block them based on your location.
          </li>
          <li>You are responsible for complying with the laws and taxes that apply to you.</li>
        </ul>
        <h2>4. Risks you accept</h2>
        <ul>
          <li>Trading can lose money, including all of the funds in your vault.</li>
          <li>
            The smart contracts are not yet externally audited. Bugs, oracle failures, shallow liquidity,
            chain or sequencer outages and issuer actions (USDG and stock tokens can be frozen by their
            issuers) can cause losses or delays.
          </li>
          <li>
            If the executor key were compromised, losses are bounded by your limits as explained in{' '}
            <Link href="/docs#worst-case">the worst-case math</Link>, but not zero.
          </li>
          <li>
            Losing your wallet key means losing access to your vault; vault ownership cannot be transferred.
          </li>
        </ul>
        <h2>5. Strategy creators</h2>
        <p>
          Creators register strategies from templates and earn a share of followers’ profit above each vault’s
          high-water mark, as enforced by the contracts. Creators must not mislead followers; strategies are
          listed with their losses and missed reveals, and rule-based strategies are never presented as AI.
        </p>
        <h2>6. No warranty, limitation of liability</h2>
        <p>
          The software is provided “as is”, without warranties of any kind. To the extent the law allows, the
          operators are not liable for losses arising from your use of the site or the contracts. [To be
          completed by counsel.]
        </p>
        <h2>7. Changes and contact</h2>
        <p>
          We may update these terms; the date below will change when we do. Contact: [to be published at
          launch].
        </p>
        <p className="text-[14px] text-muted">Last updated: template, not in force.</p>
      </article>
    </DocShell>
  );
}
