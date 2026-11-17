import { Redis } from 'ioredis';
import { getPrisma, disconnectPrisma } from '@receipts/db';
import { loadEnv } from './env.js';
import { buildServer } from './server.js';
import { makeChainReader } from './chain.js';
import { makeReporter } from '@receipts/shared';

const env = loadEnv();
const prisma = getPrisma();
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });

const chain = makeChainReader(env.RPC_URL, env.FACTORY_ADDRESS);
const reporter = makeReporter({ dsn: process.env.SENTRY_DSN, service: 'api', environment: env.NODE_ENV });
const app = await buildServer({ env, prisma, redis, chain, reporter });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await disconnectPrisma();
  redis.disconnect();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: env.API_PORT, host: env.API_HOST });
