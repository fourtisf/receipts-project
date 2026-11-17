import type { EquityPoint } from '@receipts/shared';
import { pct } from '@/lib/format';

/**
 * Strategy equity vs buy-and-hold (ported from the prototype chart). Points are index values rebased to 100
 * at the start of the window; the chart plots the % change. Line is green when the return is ≥ 0, red otherwise.
 */
export function EquityChart({
  points,
  label,
  gradientId,
}: {
  points: EquityPoint[];
  label: string;
  gradientId: string;
}) {
  const W = 720;
  const H = 250;
  const P = { l: 46, r: 12, t: 12, b: 28 };
  const a = points.map((p) => p.equity - 100);
  const h = points.map((p) => p.hold - 100);
  const n = a.length;
  const all = [...a, ...h];
  const mn = Math.min(...all, 0);
  const mx = Math.max(...all, 0);
  const pad = (mx - mn) * 0.12 || 1;
  const y0 = mn - pad;
  const y1 = mx + pad;
  const X = (i: number) => P.l + (i * (W - P.l - P.r)) / Math.max(1, n - 1);
  const Y = (v: number) => P.t + ((y1 - v) * (H - P.t - P.b)) / (y1 - y0);
  const path = (s: number[]) =>
    s.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join('');
  const area = `${path(a)}L${X(n - 1).toFixed(1)} ${Y(y0).toFixed(1)}L${X(0).toFixed(1)} ${Y(y0).toFixed(1)}Z`;
  const range = y1 - y0;
  const step = range > 4 ? Math.max(1, Math.ceil(range / 4)) : range > 2 ? 1 : 0.5;
  const ticks: number[] = [];
  for (let t = Math.ceil(y0 / step) * step; t <= y1; t += step) ticks.push(Math.round(t * 10) / 10);
  const ret = a[n - 1] ?? 0;
  const col = ret >= 0 ? '#12B76A' : '#D92D20';
  const first = points[0];
  const last = points[n - 1];
  const spanDays =
    first && last ? (new Date(last.at).getTime() - new Date(first.at).getTime()) / 86_400_000 : 0;
  const startLabel =
    spanDays >= 1.5
      ? `${Math.round(spanDays)} days ago`
      : `${Math.max(1, Math.round(spanDays * 24))} hours ago`;
  const font = { fontFamily: 'var(--font-mono), Geist Mono, monospace', fontSize: 11, fill: '#A1A1AA' };

  return (
    <svg
      className="block h-auto w-full"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`${label} ${pct(ret)} against holding ${pct(h[n - 1] ?? 0)} over ${startLabel.replace(' ago', '')}`}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={col} stopOpacity=".14" />
          <stop offset="1" stopColor={col} stopOpacity="0" />
        </linearGradient>
      </defs>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={P.l} x2={W - P.r} y1={Y(t)} y2={Y(t)} stroke={t === 0 ? '#E4E4E7' : '#F4F4F5'} />
          <text x={P.l - 10} y={Y(t) + 4} textAnchor="end" {...font}>
            {t > 0 ? '+' : ''}
            {t}%
          </text>
        </g>
      ))}
      <text x={P.l} y={H - 6} {...font}>
        {startLabel}
      </text>
      <text x={W - P.r} y={H - 6} textAnchor="end" {...font}>
        today
      </text>
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={path(h)} fill="none" stroke="#D4D4D8" strokeWidth="1.6" strokeDasharray="4 4" />
      <path d={path(a)} fill="none" stroke={col} strokeWidth="2.2" strokeLinejoin="round" />
      <circle cx={X(n - 1)} cy={Y(ret)} r="4.5" fill={col} stroke="#fff" strokeWidth="2.5" />
    </svg>
  );
}
