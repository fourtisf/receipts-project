import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pino } from 'pino';
import { Redis } from 'ioredis';
import { getPrisma, disconnectPrisma } from '@receipts/db';

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, '../../../.env') });

// M0 skeleton: connects to Postgres + Redis and reports liveness. Jobs are added in M2 (indexer) and M5.
const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const prisma = getPrisma();
const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', { maxRetriesPerRequest: null });

await prisma.$queryRaw`SELECT 1`;
log.info({ redis: await redis.ping() }, 'worker started');

const timer = setInterval(() => {
  void redis.set('worker:heartbeat', Date.now().toString(), 'EX', 120);
}, 10_000);

const shutdown = async () => {
  clearInterval(timer);
  await disconnectPrisma();
  redis.disconnect();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
