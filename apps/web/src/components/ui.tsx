import type { ReactNode } from 'react';

const MARK_PATH =
  'M3.5 1h17A2.5 2.5 0 0 1 23 3.5V25l-2.75-2-2.75 2-2.75-2L12 25l-2.75-2-2.75 2-2.75-2L1 25V3.5A2.5 2.5 0 0 1 3.5 1z';

/** The receipt logo mark from the prototype. */
export function LogoMark({ width = 24, lines = true }: { width?: number; lines?: boolean }) {
  const height = Math.round((width * 28) / 24);
  return (
    <svg width={width} height={height} viewBox="0 0 24 28" aria-hidden="true" focusable="false">
      <path d={MARK_PATH} fill="#0A0A0A" />
      {lines ? (
        <path d="M6.5 8.5h11M6.5 13h11M6.5 17.5h6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
      ) : null}
    </svg>
  );
}

export function ArrowRight() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M3 8h9.5M8.5 4l4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path
        d="M2.5 6.2l2.3 2.3L9.5 3.8"
        fill="none"
        stroke="#067647"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function LockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="3" y="7" width="10" height="7" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

/** "House" (black) and "AI" (blue) tags. AI only for kind === 'AI', never for rule-based templates. */
export function StrategyTags({
  house,
  kind,
  realFunds = false,
}: {
  house: boolean;
  kind: string;
  realFunds?: boolean;
}) {
  return (
    <>
      {house ? <span className="tag house">{realFunds ? 'House, real funds' : 'House'}</span> : null}
      {kind === 'AI' ? <span className="tag ai">AI</span> : null}
    </>
  );
}

/** "All revealed" / "3 missed" pill. */
export function RevealPill({ missed, receipts }: { missed: number; receipts: number }) {
  if (missed > 0) return <span className="st miss">{missed} missed</span>;
  if (receipts === 0) return <span className="st wait">No receipts yet</span>;
  return <span className="st ok">All revealed</span>;
}

export function Kpi({ label, children, tone = '' }: { label: string; children: ReactNode; tone?: string }) {
  return (
    <div className="kpi">
      <dt>{label}</dt>
      <dd className={tone}>{children}</dd>
    </div>
  );
}

/** Link to a source on Blockscout (opens in a new tab). */
export function ExtLink({
  href,
  children,
  className = 'src',
  title = 'View on Blockscout',
}: {
  href: string;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className} title={title}>
      {children}
    </a>
  );
}
