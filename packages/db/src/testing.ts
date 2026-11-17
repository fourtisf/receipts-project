import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Test helper: a fresh Postgres schema per test file (created with the non-destructive `prisma migrate deploy`),
 * dropped again by `drop()`. Base URL from TEST_DATABASE_URL or DATABASE_URL.
 */
export async function createTestDb(): Promise<{
  prisma: PrismaClient;
  url: string;
  drop: () => Promise<void>;
}> {
  const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!base) throw new Error('Set TEST_DATABASE_URL (or DATABASE_URL) to run database tests.');
  const schema = `test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const url = `${base.split('?')[0]}?schema=${schema}`;
  execSync('pnpm prisma migrate deploy', {
    cwd: root,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'ignore',
  });
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  return {
    prisma,
    url,
    drop: async () => {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); // only the schema created above
      await prisma.$disconnect();
    },
  };
}
