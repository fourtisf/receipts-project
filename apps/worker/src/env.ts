import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, '../../../.env') });

const addr = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => s.toLowerCase() as `0x${string}`);
const optAddr = z.preprocess((v) => (v === '' ? undefined : v), addr.optional());
const addrList = z
  .string()
  .default('')
  .transform(
    (s) =>
      s
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter((x) => /^0x[0-9a-f]{40}$/.test(x)) as `0x${string}`[],
  );
const optStr = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  APP_DOMAIN: z.string().default('localhost:3000'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  CHAIN_ID: z.coerce.number().int().default(4663),
  RPC_URL: z.string().url().default('https://robinhood.drpc.org'),
  RPC_URL_FALLBACK: optStr,
  EXPLORER_URL: z.string().url().default('https://robinhoodchain.blockscout.com'),
  CONFIRMATIONS: z.coerce.number().int().min(0).default(3),
  START_BLOCK: z.preprocess((v) => (v === '' || v === undefined ? '0' : v), z.coerce.bigint()),
  INDEXER_CHUNK: z.coerce.number().int().min(1).max(10_000).default(2000),
  INDEXER_POLL_MS: z.coerce.number().int().min(200).default(2000),
  REORG_REWIND: z.coerce.number().int().min(1).default(64),
  REGISTRY_ADDRESS: optAddr,
  FACTORY_ADDRESS: optAddr,
  HOUSE_VAULTS: addrList,
  HOUSE_CREATORS: addrList,
  // worker keys (M5) — never logged
  EXECUTOR_PRIVATE_KEY: optStr,
  SIGNER_PRIVATE_KEYS: optStr,
  SALT_ENCRYPTION_KEY: optStr,
  MIN_GAS_BALANCE_ETH: z.string().default('0.002'),
  // data sources / AI / alerts (M5)
  MARKET_DATA_PROVIDER: z.enum(['polygon', 'alpaca']).default('polygon'),
  MARKET_DATA_API_KEY: optStr,
  CRYPTO_CANDLES_PROVIDER: z.enum(['coinbase', 'binance']).default('coinbase'),
  AI_BASE_URL: optStr,
  AI_API_KEY: optStr,
  AI_MODEL: optStr,
  TELEGRAM_BOT_TOKEN: optStr,
  TELEGRAM_CHAT_ID: optStr,
  // feature switches
  RUN_INDEXER: z.string().default('1'),
  RUN_PRICES: z.string().default('1'),
  RUN_STATS: z.string().default('1'),
  RUN_MISSED: z.string().default('1'),
  RUN_RUNNER: z.string().default('1'),
  RUN_EXECUTOR: z.string().default('1'),
});

export type WorkerEnv = z.infer<typeof EnvSchema>;

export function loadEnv(overrides: Record<string, string | undefined> = {}): WorkerEnv {
  const parsed = EnvSchema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(
      `Invalid worker environment: ${issues}. Fill these in the root .env (see deploy/env.example).`,
    );
  }
  return parsed.data;
}

export const on = (v: string): boolean => v === '1' || v === 'true';
