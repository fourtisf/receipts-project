'use client';

import { useState } from 'react';
import { nf } from '@/lib/format';

/** Pool fee and oracle lag assumptions from SECURITY.md / HANDOFF §10, in tenths of a percent. */
const POOL_FEE_TENTHS = 3; // 0.3 %
const ORACLE_LAG_TENTHS = 5; // up to 0.5 %

/** Worst case per day in USDG cents: dailyLimit × (slippage + pool fee + oracle lag), integer math only. */
export function worstCaseCents(dailyLimit: number, slippageTenths: number): number {
  return (dailyLimit * (slippageTenths + POOL_FEE_TENTHS + ORACLE_LAG_TENTHS)) / 10;
}

export function formatCents(cents: number): string {
  const c = Math.round(cents);
  return `${nf(Math.floor(c / 100))}.${String(c % 100).padStart(2, '0')}`;
}

export function WorstCaseCalculator() {
  const [limit, setLimit] = useState(500);
  const [slip, setSlip] = useState(10); // tenths of a percent

  return (
    <div className="rounded-panel border border-line bg-white p-[30px] shadow">
      <h3 className="text-[20px] font-bold tracking-[-0.02em]">If our bot key were stolen</h3>
      <p className="mb-6 mt-1 text-[15px] text-muted">
        The worst it could cost you per day, until you pause or revoke. It can never withdraw.
      </p>
      <output
        className="mb-6 block rounded-[14px] border border-line-2 bg-bg-2 p-[22px] font-mono text-[clamp(38px,4vw,50px)] font-medium leading-none tracking-[-0.035em]"
        htmlFor="cLimit cSlip"
        aria-live="polite"
      >
        ≈ {formatCents(worstCaseCents(limit, slip))}{' '}
        <small className="font-sans text-[15px] font-medium tracking-normal text-muted">USDG / day</small>
      </output>
      <div className="mb-[22px]">
        <div className="range-top">
          <label htmlFor="cLimit">Daily limit</label>
          <strong>{nf(limit)} USDG</strong>
        </div>
        <input
          type="range"
          id="cLimit"
          min={50}
          max={5000}
          step={50}
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          aria-valuetext={`${nf(limit)} USDG`}
        />
      </div>
      <div className="mb-2">
        <div className="range-top">
          <label htmlFor="cSlip">Max slippage</label>
          <strong>{(slip / 10).toFixed(1)}%</strong>
        </div>
        <input
          type="range"
          id="cSlip"
          min={1}
          max={50}
          step={1}
          value={slip}
          onChange={(e) => setSlip(Number(e.target.value))}
          aria-valuetext={`${(slip / 10).toFixed(1)} percent`}
        />
      </div>
      <p className="mt-1.5 text-[13px] text-faint">
        Daily limit × (slippage + 0.3% pool fee + up to 0.5% oracle lag)
      </p>
    </div>
  );
}
