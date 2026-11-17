import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Load the single root .env so NEXT_PUBLIC_* values are inlined at build time.
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, '../../.env') });

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@receipts/shared', 'geist'],
  webpack: (config) => {
    // wagmi/walletconnect optional deps that are not used in the browser bundle
    config.externals.push('pino-pretty', 'lokijs', 'encoding');
    return config;
  },
  async rewrites() {
    // Dev convenience: proxy /api/* to the local API so cookies are same-origin (Nginx does this in production).
    if (process.env.NODE_ENV === 'production') return [];
    const target = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';
    return [{ source: '/api/:path*', destination: `${target}/:path*` }];
  },
};

export default nextConfig;
