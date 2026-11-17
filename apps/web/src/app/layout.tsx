import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { GeistMono } from 'geist/font/mono';
import { APP_NAME } from '@/lib/env';
import './globals.css';

// Self-hosted Plus Jakarta Sans (variable, latin subset) from @fontsource-variable, preloaded with a
// metric-matched fallback so text does not shift when the font arrives.
const jakarta = localFont({
  src: '../../node_modules/@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-normal.woff2',
  weight: '200 800',
  style: 'normal',
  display: 'swap',
  variable: '--font-jakarta',
  fallback: ['system-ui', '-apple-system', 'sans-serif'],
});

function siteUrl(): URL {
  const explicit = process.env.NEXT_PUBLIC_APP_URL;
  if (explicit) return new URL(explicit);
  const domain = process.env.APP_DOMAIN ?? 'localhost:3000';
  return new URL(`${/^(localhost|127\.0\.0\.1)/.test(domain) ? 'http' : 'https'}://${domain}`);
}

const description =
  'Copy trading with receipts: every trade is committed on Robinhood Chain before it executes, and your money stays in a vault only your wallet can withdraw from.';

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: { default: `${APP_NAME} · Track records you can’t fake`, template: `%s · ${APP_NAME}` },
  description,
  applicationName: APP_NAME,
  openGraph: {
    type: 'website',
    siteName: APP_NAME,
    title: `${APP_NAME} · Track records you can’t fake`,
    description,
  },
  twitter: { card: 'summary_large_image' },
};

export const viewport: Viewport = { themeColor: '#FFFFFF', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${jakarta.variable} ${GeistMono.variable}`}>
      <body className="bg-bg font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
