import type { Metadata } from 'next';
import { APP_NAME } from '@/lib/env';
import { DocShell } from '@/components/landing/DocShell';
import { LegalBanner } from '@/components/landing/LegalBanner';

export const metadata: Metadata = { title: 'Privacy' };

export default function PrivacyPage() {
  return (
    <DocShell>
      <article className="doc">
        <p className="eyebrow">Legal</p>
        <h1>Privacy</h1>
        <LegalBanner />
        <h2>What is public by design</h2>
        <p>
          Everything on Robinhood Chain is public: your wallet address, your vault, its balances, limits and
          every transaction. {APP_NAME} reads and displays this data; it cannot make it private.
        </p>
        <h2>What we store</h2>
        <ul>
          <li>
            <strong>Sign-in:</strong> when you sign in with your wallet we store your address and a session
            (an httpOnly cookie, 7 days), plus the IP address and browser user agent of that session for
            security.
          </li>
          <li>
            <strong>Strategies you create:</strong> the name, description, template settings and your address,
            which are published as the strategy’s metadata.
          </li>
          <li>
            <strong>Server logs:</strong> IP addresses are used for rate limiting and abuse prevention and
            kept only as long as needed for that. Cookies and authorization headers are never logged.
          </li>
          <li>
            <strong>Location:</strong> to apply the stock-token restriction we read your country from a proxy
            header; we do not store it.
          </li>
        </ul>
        <h2>What we don’t do</h2>
        <ul>
          <li>No advertising or cross-site tracking cookies, no selling of data.</li>
          <li>We never ask for or hold your private keys or seed phrase.</li>
        </ul>
        <h2>Third parties</h2>
        <p>
          Your browser talks to a Robinhood Chain RPC provider to read the chain and to your wallet to sign.
          Links open Blockscout. Error reports (if enabled) go to our error-monitoring provider with secrets
          removed. [Providers and data-processing terms to be listed by counsel.]
        </p>
        <h2>Your choices</h2>
        <p>
          You can sign out at any time, which deletes the session. To ask about data we hold, contact: [to be
          published at launch].
        </p>
        <p className="text-[14px] text-muted">Last updated: template, not in force.</p>
      </article>
    </DocShell>
  );
}
