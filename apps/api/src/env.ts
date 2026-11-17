import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

// Every app loads the single root .env (deploy/DEPLOY.md §2).
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, '../../../.env') });

const addr = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => s.toLowerCase() as `0x${string}`);
const optionalAddr = z.preprocess((v) => (v === '' ? undefined : v), addr.optional());

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_NAME: z.string().default('Receipts'),
  APP_DOMAIN: z.string().default('localhost:3000'),
  API_PORT: z.coerce.number().int().default(4000),
  API_HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  SESSION_SECRET: z.string().default(''),
  SIWE_CHAIN_ID: z.coerce.number().int().default(4663),
  CHAIN_ID: z.coerce.number().int().default(4663),
  RPC_URL: z.string().url().default('https://robinhood.drpc.org'),
  /** RPC the browser should use (no secret keys). Falls back to the public endpoint. */
  PUBLIC_RPC_URL: z
    .string()
    .url()
    .default(process.env.NEXT_PUBLIC_RPC_URL || 'https://robinhood.drpc.org'),
  EXPLORER_URL: z.string().url().default('https://robinhoodchain.blockscout.com'),
  REGISTRY_ADDRESS: optionalAddr,
  FACTORY_ADDRESS: optionalAddr,
  SIGNER_ADDRESS_TEMPLATE: optionalAddr,
  TEMPLATE_REVEAL_WINDOW_SEC: z.coerce.number().int().default(3600),
  GEOBLOCK_STOCKS: z.string().default('US'),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: z
    .string()
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(overrides: Partial<Record<keyof Env, string>> = {}): Env {
  const parsed = EnvSchema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(
      `Invalid API environment: ${issues}. Fill these in the root .env (see deploy/env.example).`,
    );
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production' && env.SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters in production (64 random hex chars).');
  }
  return env;
}
