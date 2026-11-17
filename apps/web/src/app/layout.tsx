import type { Metadata } from 'next';
import { GeistMono } from 'geist/font/mono';
import '@fontsource-variable/plus-jakarta-sans';
import './globals.css';

const appName = process.env.NEXT_PUBLIC_APP_NAME ?? 'Receipts';

export const metadata: Metadata = {
  title: appName,
  description: 'Copy trading with receipts. Every trade committed on-chain before it executes.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={GeistMono.variable}>
      <body className="bg-bg font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
