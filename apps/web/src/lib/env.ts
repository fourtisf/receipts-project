/** Public, build-time inlined settings. The product name and domain are never hard-coded. */
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? 'Receipts';

/** Optional public links; hidden when unset so the site never shows dead links. */
export const LINKS = {
  docs: process.env.NEXT_PUBLIC_DOCS_URL || null,
  github: process.env.NEXT_PUBLIC_GITHUB_URL || null,
  x: process.env.NEXT_PUBLIC_X_URL || null,
  telegram: process.env.NEXT_PUBLIC_TELEGRAM_URL || null,
} as const;

/** WalletConnect Cloud project id; empty → injected wallets only. */
export const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? '';

/** RPC the browser may use when /config/chain is unavailable. */
export const PUBLIC_RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || undefined;

/** Browser-side API base (Nginx proxies /api → API in production, next.config rewrites in dev). */
export const PUBLIC_API_BASE = (process.env.NEXT_PUBLIC_API_URL || '/api').replace(/\/$/, '');

/** Optional explicit WebSocket URL; defaults to `${origin}/api/ws`. */
export const PUBLIC_WS_URL = process.env.NEXT_PUBLIC_WS_URL || null;
