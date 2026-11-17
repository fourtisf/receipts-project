import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@receipts/db';
import type { Env } from './env.js';
import type { ChainReader } from './chain.js';
import { ApiError } from './lib/http.js';
import { publicRoutes } from './routes/public.js';
import { wsRoutes } from './routes/ws.js';
import { authRoutes } from './routes/auth.js';
import { writeRoutes } from './routes/writes.js';
import { geoRoutes } from './routes/geo.js';

export interface ServerDeps {
  env: Env;
  prisma: PrismaClient;
  redis?: Redis;
  chain?: ChainReader;
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
            redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
          },
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 256 * 1024,
  });
  app.decorate('deps', deps);

  const origins = env.CORS_ORIGINS
    ? env.CORS_ORIGINS.split(',').map((s) => s.trim())
    : [
        `https://${env.APP_DOMAIN}`,
        `https://www.${env.APP_DOMAIN}`,
        ...(env.NODE_ENV !== 'production' ? ['http://localhost:3000'] : []),
      ];
  await app.register(cors, { origin: origins, credentials: true });
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cookie, { secret: env.SESSION_SECRET || undefined });
  await app.register(rateLimit, {
    global: true,
    max: env.NODE_ENV === 'test' ? 10_000 : 120,
    timeWindow: '1 minute',
    redis: deps.redis,
    keyGenerator: (req) => req.ip,
    // Server-side rendering in Next.js calls the API directly on loopback (no X-Forwarded-For). Requests through
    // Nginx carry the real client IP (TRUST_PROXY=loopback), so this cannot be spoofed by browsers.
    allowList: (req) =>
      !req.headers['x-forwarded-for'] && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip),
  });
  await app.register(websocket);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error(err);
    const code =
      status === 429
        ? 'RATE_LIMITED'
        : status === 400
          ? 'BAD_REQUEST'
          : ((err as { code?: string }).code ?? 'INTERNAL');
    const message =
      status === 429
        ? 'Too many requests. Wait a minute and try again.'
        : status >= 500
          ? 'Internal error. Try again in a moment.'
          : err.message;
    return reply.status(status).send({ error: { code, message } });
  });
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No route ${req.method} ${req.url}.` } }),
  );

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

  await app.register(publicRoutes);
  await app.register(wsRoutes);
  await app.register(authRoutes);
  await app.register(writeRoutes);
  await app.register(geoRoutes);
  return app;
}
