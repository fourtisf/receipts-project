import { ImageResponse } from 'next/og';
import { equitySchema, strategyDetailSchema } from '@receipts/shared';
import { apiTry } from '@/lib/api.server';
import { APP_NAME } from '@/lib/env';
import { nf, pct, pctPlain } from '@/lib/format';
import { C, OG_CONTENT_TYPE, OG_SIZE, OgFrame, ogFonts } from '@/lib/og';

export const runtime = 'nodejs';
export const revalidate = 300;
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = `Strategy on ${APP_NAME}`;

function spark(points: { equity: number; hold: number }[], w: number, h: number) {
  const vals = points.flatMap((p) => [p.equity, p.hold]);
  const mn = Math.min(...vals);
  const mx = Math.max(...vals);
  const span = mx - mn || 1;
  const n = points.length;
  const X = (i: number) => (i * w) / Math.max(1, n - 1);
  const Y = (v: number) => h - ((v - mn) / span) * h;
  const line = (k: 'equity' | 'hold') =>
    points.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(p[k]).toFixed(1)}`).join('');
  return { eq: line('equity'), hold: line('hold'), area: `${line('equity')}L${w} ${h}L0 ${h}Z` };
}

export default async function Image({ params }: { params: { id: string } }) {
  const [r, fonts] = await Promise.all([
    apiTry(`/strategies/${encodeURIComponent(params.id)}`, strategyDetailSchema, 300),
    ogFonts(),
  ]);
  if (!r.ok) {
    return new ImageResponse(
      <OgFrame>
        <div style={{ display: 'flex', fontSize: 72, fontWeight: 700, marginTop: 80 }}>
          Strategy not found
        </div>
      </OgFrame>,
      { ...size, fonts },
    );
  }
  const s = r.data;
  const eq = await apiTry(`/strategies/${s.id}/equity?range=30d`, equitySchema, 300);
  const pts = eq.ok ? eq.data.points : [];
  const up = (s.ret30d ?? 0) >= 0;
  const col = up ? C.green : C.red;
  const sp = pts.length > 1 ? spark(pts, 1072, 150) : null;
  const tone = (v: number | null) => (v === null ? C.ink : v > 0 ? C.greenD : v < 0 ? C.red : C.ink);
  const cells: [string, string, string][] = [
    ['30-day return', pct(s.ret30d), tone(s.ret30d)],
    ['vs holding', pct(s.vsHold), tone(s.vsHold)],
    ['Max drawdown', pctPlain(s.maxDrawdown30d), C.ink],
    ['Receipts', nf(s.receipts), C.ink],
    ['Missed reveals', nf(s.missed), s.missed > 0 ? C.red : C.ink],
  ];

  return new ImageResponse(
    <OgFrame footer={`${s.market} · every trade committed on-chain before it executes`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 40 }}>
        <div style={{ display: 'flex', fontSize: 68, fontWeight: 700, letterSpacing: '-0.035em' }}>
          {s.name}
        </div>
        {s.house ? (
          <div
            style={{
              display: 'flex',
              fontSize: 22,
              fontWeight: 700,
              background: C.ink,
              color: '#fff',
              borderRadius: 8,
              padding: '4px 12px',
            }}
          >
            House
          </div>
        ) : null}
        {s.kind === 'AI' ? (
          <div
            style={{
              display: 'flex',
              fontSize: 22,
              fontWeight: 700,
              background: C.aiBg,
              color: C.ai,
              borderRadius: 8,
              padding: '4px 12px',
            }}
          >
            AI
          </div>
        ) : null}
      </div>
      <div style={{ display: 'flex', gap: 14, marginTop: 26 }}>
        {cells.map(([k, v, c]) => (
          <div
            key={k}
            style={{
              display: 'flex',
              flexDirection: 'column',
              border: `1px solid ${C.line}`,
              borderRadius: 14,
              padding: '12px 18px',
              flex: 1,
              background: '#fff',
            }}
          >
            <div style={{ display: 'flex', fontSize: 18, color: C.muted }}>{k}</div>
            <div
              style={{
                display: 'flex',
                fontSize: 34,
                fontFamily: 'Mono',
                fontWeight: 500,
                color: c,
                marginTop: 2,
              }}
            >
              {v}
            </div>
          </div>
        ))}
      </div>
      {sp ? (
        <svg width="1072" height="150" viewBox="0 0 1072 150" style={{ marginTop: 'auto', marginBottom: 22 }}>
          <defs>
            <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={col} stopOpacity="0.16" />
              <stop offset="1" stopColor={col} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={sp.area} fill="url(#g)" />
          <path d={sp.hold} fill="none" stroke="#D4D4D8" strokeWidth="2" strokeDasharray="6 6" />
          <path d={sp.eq} fill="none" stroke={col} strokeWidth="3.5" strokeLinejoin="round" />
        </svg>
      ) : null}
    </OgFrame>,
    { ...size, fonts },
  );
}
