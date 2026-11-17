import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Load the single root .env so NEXT_PUBLIC_* values are inlined at build time.
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, '../../.env') });

/** @type {import('next').NextConfig} */
const nextConfig = {
  // e2e:fork runs its own dev server next to a normal one; it builds into a separate directory
  distDir: process.env.NEXT_DIST_DIR || '.next',
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@receipts/shared', 'geist'],
  webpack: (config, { webpack }) => {
    // wagmi/walletconnect optional deps that are not used in the browser bundle
    config.externals.push('pino-pretty', 'lokijs', 'encoding');
    // Optional deps of wallet SDKs that are never used here: @wagmi/connectors → @base-org/account →
    // @coinbase/cdp-sdk references x402 payment packages, and @metamask/sdk references React Native storage.
    config.plugins.push(
      new webpack.IgnorePlugin({
        resourceRegExp: /^(@x402\/.*|@react-native-async-storage\/async-storage)$/,
      }),
    );
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
