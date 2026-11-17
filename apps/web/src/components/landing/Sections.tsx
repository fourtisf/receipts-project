import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Stats } from '@receipts/shared';
import { APP_NAME } from '@/lib/env';
import { amount, nf } from '@/lib/format';
import { ArrowRight, CheckIcon } from '@/components/ui';
import { WorstCaseCalculator } from './WorstCaseCalculator';

export function BuiltOn() {
  return (
    <section className="wrap pt-[150px] text-center max-[800px]:pt-[72px]">
      <p className="mb-[18px] text-[13.5px] font-medium text-faint">
        Built on infrastructure you already trust
      </p>
      <div className="flex flex-wrap justify-center gap-14 text-[20px] font-bold tracking-[-0.02em] text-[#B4B4BB] max-[800px]:gap-7 max-[800px]:text-[17px]">
        <span>Robinhood Chain</span>
        <span>Uniswap</span>
        <span>Chainlink</span>
        <span>Blockscout</span>
      </div>
    </section>
  );
}

function Feature({
  icon,
  title,
  body,
  demo,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  demo: [string, string][];
}) {
  return (
    <div className="rounded-frame border border-line bg-white p-7 shadow-sm">
      <div className="mb-[22px] grid h-11 w-11 place-items-center rounded-xl bg-bg-3">{icon}</div>
      <h3 className="mb-2 text-[19px] font-bold tracking-[-0.02em]">{title}</h3>
      <p className="text-[15.5px] text-muted">{body}</p>
      <div className="mt-[22px] grid gap-1.5 border-t border-line-2 pt-[18px] font-mono text-[12.5px] text-ink-2">
        {demo.map(([k, v]) => (
          <div key={k} className="flex justify-between">
            <span className="muted">{k}</span>
            <span>{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const ic = { fill: 'none', stroke: '#0A0A0A', strokeWidth: 1.7 } as const;

export function FeatureCards({
  stats,
  maxDailyLimitUsd,
}: {
  stats: Stats | null;
  maxDailyLimitUsd: string | null;
}) {
  return (
    <section className="sec wrap sec-c scroll-mt-20 pt-[128px] max-[800px]:pt-[88px]" id="features">
      <p className="eyebrow">Product</p>
      <h2>Everything a strategy claims, you can check.</h2>
      <p className="intro">
        {APP_NAME} turns copy trading into something you can audit yourself, in a few clicks.
      </p>
      <div className="mt-14 grid grid-cols-3 gap-5 text-left max-[1060px]:grid-cols-2 max-[800px]:grid-cols-1">
        <Feature
          icon={
            <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
              <path d="M5 3h12v16l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5-2 1.5z" {...ic} strokeLinejoin="round" />
              <path d="M8 9l2 2 4-4" {...ic} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          }
          title="Verified track records"
          body="Every trade is committed before it executes, so winners can’t be added and losers can’t be deleted later."
          demo={[
            ['Receipts', stats ? nf(stats.receiptsPrinted) : '—'],
            ['Missed reveals', stats ? nf(stats.missedReveals) : '—'],
          ]}
        />
        <Feature
          icon={
            <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
              <rect x="3" y="5" width="16" height="13" rx="3" {...ic} />
              <circle cx="14" cy="11.5" r="2" {...ic} />
              <path d="M7 5V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v1" {...ic} />
            </svg>
          }
          title="Your vault, your keys"
          body="Funds sit in a contract owned by your wallet. Strategies can trade inside your limits but never withdraw."
          demo={[
            ['Who can withdraw', 'You'],
            ['Daily limit', maxDailyLimitUsd ? `Up to ${amount(maxDailyLimitUsd, 0)} USDG` : 'You set it'],
          ]}
        />
        <Feature
          icon={
            <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
              <path d="M3 16l5-5 3 3 7-7" {...ic} strokeLinecap="round" strokeLinejoin="round" />
              <path d="M13 7h5v5" {...ic} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          }
          title="Pay only on profit"
          body="Creators earn a share of profit above your vault’s previous high. If you lose, nobody gets paid."
          demo={[
            ['Fee on deposit', '0.00'],
            ['Fee if you lose', '0.00'],
          ]}
        />
      </div>
    </section>
  );
}

const GUARDS: [string, string][] = [
  ['Oracle price check', 'Fills worse than the Chainlink price minus your slippage limit revert.'],
  ['Daily limit', 'Caps the dollar value a strategy can trade from your vault in 24 hours.'],
  ['Drawdown breaker', 'Trading pauses by itself when the vault falls a set percentage from its peak.'],
  ['Withdraw any time', 'Works while paused, and directly from Blockscout if this website is offline.'],
  ['Revoke the bot', 'One transaction removes trading access completely.'],
];

export function Security() {
  return (
    <section className="sec wrap scroll-mt-20 pt-[128px] max-[800px]:pt-[88px]" id="security">
      <p className="eyebrow">Security</p>
      <h2>Your vault sets the rules.</h2>
      <p className="intro">
        Strategies only trade inside the limits you choose. These are enforced by the contract, not by us.
      </p>
      <div className="mt-14 grid grid-cols-2 items-start gap-16 max-[1060px]:grid-cols-1 max-[1060px]:gap-10">
        <ul className="grid">
          {GUARDS.map(([t, d]) => (
            <li key={t} className="grid grid-cols-[32px_1fr] gap-3.5 border-b border-line-2 py-5 first:pt-0">
              <span className="mt-0.5 grid h-6 w-6 place-items-center rounded-full bg-green-bg">
                <CheckIcon />
              </span>
              <div>
                <h3 className="mb-0.5 text-[17px] font-bold tracking-[-0.01em]">{t}</h3>
                <p className="text-[15px] text-muted">{d}</p>
              </div>
            </li>
          ))}
        </ul>
        <WorstCaseCalculator />
      </div>
    </section>
  );
}

const CMP: [string, string, string][] = [
  ['When trades are recorded', 'After they happen', 'Before they happen, on-chain'],
  ['Who can edit history', 'Whoever runs the server', 'Nobody'],
  ['Losing trades', 'Can quietly disappear', 'Stay on record, missed reveals counted'],
  ['AI strategies', '“Trust us, it’s AI”', 'Model and prompt hash committed'],
  ['Creator pay', 'Win or lose', 'Only from profit above your high'],
];

export function ComparisonTable() {
  return (
    <section className="sec wrap pt-[128px] max-[800px]:pt-[88px]">
      <p className="eyebrow">Why {APP_NAME}</p>
      <h2>Not another leaderboard.</h2>
      <p className="intro">
        Most agent platforms show results from their own database. On crypto Twitter, that’s what people call
        a LARP.
      </p>
      <div
        className="cmp mt-14 overflow-hidden rounded-panel border border-line shadow-sm"
        role="table"
        aria-label="Comparison"
      >
        <div className="cmp-row cmp-head" role="row">
          <div role="columnheader">
            <span className="sr-only">Question</span>
          </div>
          <div role="columnheader">Leaderboard on a server</div>
          <div role="columnheader">{APP_NAME}</div>
        </div>
        {CMP.map(([q, them, us]) => (
          <div className="cmp-row" role="row" key={q}>
            <div role="rowheader">{q}</div>
            <div role="cell">
              <span className="x" aria-hidden="true">
                ✕
              </span>
              <span className="sr-only">Leaderboard on a server: </span>
              {them}
            </div>
            <div role="cell">
              <span className="v" aria-hidden="true">
                ✓
              </span>
              <span className="sr-only">{APP_NAME}: </span>
              {us}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

const QA: [string, string][] = [
  [
    'Can the bot take my money?',
    'No. The vault contract has no function that lets the bot send funds out. It can only swap between the assets you allowed, within your daily limit and slippage limit. Only your wallet can withdraw.',
  ],
  [
    'What is a missed reveal?',
    'A strategy commits a fingerprint before each trade and must publish the decision behind it within a time window. If it doesn’t, the receipt is marked missed, and the count stays on the strategy’s page permanently.',
  ],
  [
    'How can an AI strategy be verified?',
    'Each signal from an AI strategy also commits the model name and a hash of the exact prompt, so anyone can check that neither changed silently.',
  ],
  [
    `What does ${APP_NAME} charge?`,
    `Nothing on deposits, withdrawals or swaps beyond gas and the Uniswap pool fee. Creators earn a share of profit above your vault’s previous high, and ${APP_NAME} keeps part of that share.`,
  ],
  [
    'What if this website goes offline?',
    'Your vault lives on Robinhood Chain, not on our servers. You can call withdraw directly from Blockscout at any time.',
  ],
];

export function Faq() {
  return (
    <section className="sec wrap sec-c scroll-mt-20 pt-[128px] max-[800px]:pt-[88px]" id="faq">
      <p className="eyebrow">FAQ</p>
      <h2>Questions people ask first.</h2>
      <div className="faq mx-auto mt-12 max-w-[760px] text-left">
        {QA.map(([q, a]) => (
          <details key={q}>
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

export function FinalCta() {
  return (
    <section className="wrap">
      <div className="final relative mb-24 mt-[128px] overflow-hidden rounded-final border border-line bg-bg-2 px-8 py-[84px] text-center max-[800px]:rounded-[22px] max-[800px]:px-[22px] max-[800px]:py-14">
        <h2 className="mx-auto mb-4 max-w-[14ch] text-[clamp(34px,4.4vw,56px)] font-bold leading-[1.05] tracking-[-0.04em]">
          Start with a record you can check.
        </h2>
        <p className="mb-[30px] text-[18px] text-muted">
          Browse strategies, create a vault, copy one when you’re ready.
        </p>
        <div className="flex flex-wrap justify-center gap-2.5">
          <Link className="btn btn-dark btn-lg" href="/app">
            Launch app
            <ArrowRight />
          </Link>
        </div>
      </div>
    </section>
  );
}
