import { ImageResponse } from 'next/og';
import { statsSchema } from '@receipts/shared';
import { apiTry } from '@/lib/api.server';
import { APP_NAME } from '@/lib/env';
import { nf, usdCompact } from '@/lib/format';
import { C, OG_CONTENT_TYPE, OG_SIZE, OgFrame, ogFonts } from '@/lib/og';

export const runtime = 'nodejs';
export const revalidate = 300;
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = `${APP_NAME}: track records you can’t fake`;

export default async function Image() {
  const [stats, fonts] = await Promise.all([apiTry('/stats', statsSchema, 300), ogFonts()]);
  const s = stats.ok ? stats.data : null;
  const cells: [string, string][] = s
    ? [
        ['Receipts printed', nf(s.receiptsPrinted)],
        ['Strategies live', nf(s.strategiesLive)],
        ['Missed reveals', nf(s.missedReveals)],
        ['In user vaults', usdCompact(s.tvlUsd)],
      ]
    : [];

  return new ImageResponse(
    <OgFrame footer="Copy trading on Robinhood Chain · Not investment advice">
      <div
        style={{
          display: 'flex',
          marginTop: 56,
          maxWidth: 800,
          fontSize: 84,
          fontWeight: 700,
          letterSpacing: '-0.04em',
          lineHeight: 1.04,
        }}
      >
        Track records you can’t fake.
      </div>
      {cells.length > 0 ? (
        <div style={{ display: 'flex', gap: 18, marginTop: 'auto', marginBottom: 28 }}>
          {cells.map(([k, v]) => (
            <div
              key={k}
              style={{
                display: 'flex',
                flexDirection: 'column',
                border: `1px solid ${C.line}`,
                borderRadius: 16,
                padding: '16px 22px',
                minWidth: 230,
                background: '#fff',
              }}
            >
              <div style={{ display: 'flex', fontSize: 20, color: C.muted }}>{k}</div>
              <div
                style={{ display: 'flex', fontSize: 38, fontFamily: 'Mono', fontWeight: 500, marginTop: 4 }}
              >
                {v}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </OgFrame>,
    { ...size, fonts },
  );
}
