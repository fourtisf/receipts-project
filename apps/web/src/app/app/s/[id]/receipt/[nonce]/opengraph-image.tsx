import { ImageResponse } from 'next/og';
import { receiptDetailSchema } from '@receipts/shared';
import { apiTry } from '@/lib/api.server';
import { APP_NAME } from '@/lib/env';
import { amount, bpsPct, dateTimeUtc, nf, short } from '@/lib/format';
import { revealState, tradeLabel } from '@/lib/receipt';
import { C, OG_CONTENT_TYPE, OG_SIZE, OgFrame, ogFonts } from '@/lib/og';

export const runtime = 'nodejs';
export const revalidate = 60;
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = `Receipt on ${APP_NAME}`;

const STAMP = {
  match: { text: ['Matches', 'commit'], color: C.green, ink: C.greenD },
  missed: { text: ['Reveal', 'missed'], color: C.red, ink: C.red },
  mismatch: { text: ['Trade', 'mismatch'], color: C.red, ink: C.red },
  pending: { text: ['Awaiting', 'reveal'], color: '#D4D4D8', ink: C.muted },
} as const;

export default async function Image({ params }: { params: { id: string; nonce: string } }) {
  const fonts = await ogFonts();
  const valid = /^\d+$/.test(params.id) && /^\d+$/.test(params.nonce);
  const r = valid ? await apiTry(`/receipts/${params.id}-${params.nonce}`, receiptDetailSchema, 60) : null;
  if (!r?.ok) {
    return new ImageResponse(
      <OgFrame>
        <div style={{ display: 'flex', fontSize: 72, fontWeight: 700, marginTop: 80 }}>Receipt not found</div>
      </OgFrame>,
      { ...size, fonts },
    );
  }
  const d = r.data;
  const state = revealState(d);
  const stamp = STAMP[state];
  const rows: [string, string][] = [
    ['Strategy', d.strategyName],
    ['Commit', `blk ${nf(d.commit.blockNumber)} · ${short(d.hash)}`],
    ['Trade', tradeLabel(d) ?? (state === 'pending' ? 'hidden until reveal' : '—')],
    ['Value', d.executions > 0 ? `${amount(d.valueUsd)} USD` : state === 'match' ? 'paper' : '—'],
    ['Slippage vs oracle', d.slippageBps === null ? '—' : bpsPct(d.slippageBps)],
    [
      'Reveal',
      d.reveal ? `blk ${nf(d.reveal.blockNumber)}` : state === 'missed' ? 'window closed' : 'pending',
    ],
  ];

  return new ImageResponse(
    <OgFrame footer={`Committed ${dateTimeUtc(d.committedAt)} on Robinhood Chain`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 56, marginTop: 28 }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            width: 640,
            background: '#fff',
            border: `1px solid ${C.line}`,
            borderRadius: 6,
            padding: '22px 28px',
            fontFamily: 'Mono',
            fontSize: 22,
            color: '#18181B',
            boxShadow: '0 10px 30px rgba(10,10,10,0.08)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 500 }}>
            <span>Receipt #{nf(d.receiptNo)}</span>
          </div>
          <div style={{ display: 'flex', borderTop: '2px dashed #D4D4D8', margin: '12px 0' }} />
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', lineHeight: 1.7 }}>
              <span style={{ color: C.faint }}>{k}</span>
              <span>{v}</span>
            </div>
          ))}
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            width: 230,
            height: 230,
            borderRadius: 999,
            border: `5px solid ${stamp.color}`,
            color: stamp.ink,
            fontSize: 34,
            fontWeight: 700,
            lineHeight: 1.15,
            transform: 'rotate(-12deg)',
          }}
        >
          <span>{stamp.text[0]}</span>
          <span>{stamp.text[1]}</span>
        </div>
      </div>
    </OgFrame>,
    { ...size, fonts },
  );
}
