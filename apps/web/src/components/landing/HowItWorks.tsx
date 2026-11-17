'use client';

import { useRef, useState, type KeyboardEvent } from 'react';
import type { ReceiptDetail } from '@receipts/shared';
import { amount } from '@/lib/format';
import { EmptySlip, FullSlip } from '@/components/receipt/ReceiptSlip';

type Step = 1 | 2 | 3;

export function HowItWorks({ receipt, now }: { receipt: ReceiptDetail | null; now: number }) {
  const [step, setStep] = useState<Step>(1);
  const refs = useRef<(HTMLLIElement | null)[]>([]);
  const swap =
    receipt?.side && receipt.asset && receipt.executions > 0
      ? `vault.swap(${receipt.asset}, ${receipt.side}, ${amount(receipt.valueUsd)} USDG)`
      : 'vault.swap(asset, side, amount)';
  const steps: { n: Step; title: string; body: string; code: string }[] = [
    {
      n: 1,
      title: 'Commit',
      body: 'The strategy posts a fingerprint of its next trade. Nobody can read it yet, including us.',
      code: 'commit(hash(asset, side, size, salt))',
    },
    {
      n: 2,
      title: 'Execute',
      body: 'Your vault swaps through a pinned Uniswap pool. Fills worse than Chainlink minus your slippage limit are rejected.',
      code: swap,
    },
    {
      n: 3,
      title: 'Reveal',
      body: 'The strategy publishes the decision and its salt. The contract checks it matches and stamps the receipt.',
      code: 'reveal(signal, salt) == commit',
    },
  ];

  const go = (n: Step, focus = false) => {
    setStep(n);
    if (focus) refs.current[n - 1]?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLLIElement>, n: Step) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      go(n);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      go(((step % 3) + 1) as Step, true);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      go((((step + 1) % 3) + 1) as Step, true);
    }
  };

  return (
    <section className="sec wrap scroll-mt-20 pt-[128px] max-[800px]:pt-[88px]" id="how">
      <p className="eyebrow">How it works</p>
      <h2>Three transactions. One receipt.</h2>
      <p className="intro">Click a step to see where it lands on the receipt.</p>
      <div className="mt-14 grid grid-cols-[1fr_400px] items-center gap-[72px] max-[1060px]:grid-cols-1 max-[1060px]:gap-10">
        <ol className="grid gap-3" role="tablist" aria-label="Receipt steps" aria-orientation="vertical">
          {steps.map((s) => (
            <li
              key={s.n}
              ref={(el) => {
                refs.current[s.n - 1] = el;
              }}
              className="step"
              role="tab"
              id={`how-tab-${s.n}`}
              aria-controls="how-panel"
              aria-selected={step === s.n}
              tabIndex={step === s.n ? 0 : -1}
              onClick={() => go(s.n)}
              onKeyDown={(e) => onKey(e, s.n)}
            >
              <span className="n">{s.n}</span>
              <div className="min-w-0">
                <h3 className="mb-1 text-[18px] font-bold tracking-[-0.015em]">{s.title}</h3>
                <p className="text-[15px] text-muted">{s.body}</p>
                <code>{s.code}</code>
              </div>
            </li>
          ))}
        </ol>
        <div
          id="how-panel"
          role="tabpanel"
          aria-labelledby={`how-tab-${step}`}
          className="grid place-items-center rounded-[22px] border border-line bg-bg-2 px-[30px] pb-10 pt-[34px] max-[1060px]:max-w-[460px] max-[800px]:px-5"
        >
          <div className="w-full max-w-[330px]">
            {receipt ? <FullSlip d={receipt} hl={step} now={now} /> : <EmptySlip hl={step} />}
          </div>
        </div>
      </div>
    </section>
  );
}
