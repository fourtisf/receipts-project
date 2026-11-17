import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { Redis } from 'ioredis';
import type { PrismaClient } from '@receipts/db';
import type { Env } from './env.js';

export interface ServerDeps {
  env: Env;
  prisma: PrismaClient;
  redis?: Redis;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: ServerDeps;
  }
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { env } = deps;
  const app = Fastify({
    logger:
      env.NODE_ENV === 'test'
        ? false
        : {
            level: env.NODE_ENV === 'production' ? 'info' : 'debug',
            redact: ['req.headers.cookie', 'req.headers.authorization'],
          },
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 256 * 1024,
  });
  app.decorate('deps', deps);

  const origins = env.CORS_ORIGINS
    ? env.CORS_ORIGINS.split(',').map((s) => s.trim())
    : [`https://${env.APP_DOMAIN}`, ...(env.NODE_ENV !== 'production' ? ['http://localhost:3000'] : [])];
  await app.register(cors, { origin: origins, credentials: true });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cookie, { secret: env.SESSION_SECRET || undefined });
  await app.register(rateLimit, { global: true, max: 120, timeWindow: '1 minute' });
  await app.register(websocket);

  app.setErrorHandler((err, _req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) app.log.error(err);
    const code = (err as { code?: string }).code ?? (status === 429 ? 'RATE_LIMITED' : 'INTERNAL');
    reply.status(status).send({
      error: { code, message: status >= 500 ? 'Internal error. Try again in a moment.' : err.message },
    });
  });

  app.get('/health', async () => {
    let db = false;
    let redis = false;
    let lastBlock: string | null = null;
    try {
      await deps.prisma.$queryRaw`SELECT 1`;
      db = true;
      const cursor = await deps.prisma.indexerCursor.findUnique({ where: { id: 'registry' } });
      lastBlock = cursor ? cursor.lastBlock.toString() : null;
    } catch {
      db = false;
    }
    try {
      redis = deps.redis ? (await deps.redis.ping()) === 'PONG' : false;
    } catch {
      redis = false;
    }
    let indexerLagBlocks: number | null = null;
    try {
      const head = deps.redis ? await deps.redis.get('chain:head') : null;
      if (head && lastBlock) indexerLagBlocks = Number(BigInt(head) - BigInt(lastBlock));
    } catch {
      indexerLagBlocks = null;
    }
    return { ok: db && redis, indexerLagBlocks, lastBlock, db, redis };
  });

  return app;
}
