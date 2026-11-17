import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { APP_NAME } from './env';

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = 'image/png';

const FONT_DIR = join(process.cwd(), 'node_modules/geist/dist/fonts');

type OgFont = { name: string; data: ArrayBuffer; weight: 400 | 500 | 700; style: 'normal' };

async function font(name: string, file: string, weight: OgFont['weight']): Promise<OgFont | null> {
  try {
    const buf = await readFile(join(FONT_DIR, file));
    return {
      name,
      data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      weight,
      style: 'normal',
    };
  } catch {
    return null; // fall back to the built-in font
  }
}

/** TTF fonts for satori (it cannot read woff2): Geist for text, Geist Mono for numbers. */
export async function ogFonts(): Promise<OgFont[]> {
  const all = await Promise.all([
    font('Sans', 'geist-sans/Geist-Medium.ttf', 500),
    font('Sans', 'geist-sans/Geist-Bold.ttf', 700),
    font('Mono', 'geist-mono/GeistMono-Regular.ttf', 400),
    font('Mono', 'geist-mono/GeistMono-Medium.ttf', 500),
  ]);
  return all.filter((f): f is OgFont => f !== null);
}

export const C = {
  ink: '#0A0A0A',
  ink2: '#3F3F46',
  muted: '#71717A',
  faint: '#A1A1AA',
  line: '#EAEAEA',
  bg2: '#FAFAFA',
  bg3: '#F4F4F5',
  green: '#12B76A',
  greenD: '#067647',
  greenBg: '#ECFDF3',
  red: '#D92D20',
  redBg: '#FEF3F2',
  aiBg: '#EEF4FF',
  ai: '#3538CD',
};

export function OgMark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={(size * 28) / 24} viewBox="0 0 24 28">
      <path
        d="M3.5 1h17A2.5 2.5 0 0 1 23 3.5V25l-2.75-2-2.75 2-2.75-2L12 25l-2.75-2-2.75 2-2.75-2L1 25V3.5A2.5 2.5 0 0 1 3.5 1z"
        fill={C.ink}
      />
      <path d="M6.5 8.5h11M6.5 13h11M6.5 17.5h6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/** White canvas with the logo top-left and a footer line, like the site. */
export function OgFrame({ children, footer }: { children: ReactNode; footer?: string }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: '#FFFFFF',
        padding: '56px 64px',
        fontFamily: 'Sans',
        color: C.ink,
        backgroundImage: `radial-gradient(60% 70% at 85% 30%, rgba(18,183,106,0.10), rgba(255,255,255,0) 70%)`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          fontSize: 34,
          fontWeight: 700,
          letterSpacing: '-0.02em',
        }}
      >
        <OgMark size={34} />
        {APP_NAME}
      </div>
      <div style={{ display: 'flex', flex: 1, flexDirection: 'column' }}>{children}</div>
      <div style={{ display: 'flex', fontSize: 22, color: C.faint, fontWeight: 500 }}>
        {footer ?? 'Every trade committed on Robinhood Chain before it executes.'}
      </div>
    </div>
  );
}
