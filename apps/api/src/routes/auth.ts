import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createPublicClient, http, verifyMessage } from 'viem';
import { generateSiweNonce, parseSiweMessage } from 'viem/siwe';
import { robinhoodChain } from '@receipts/shared';
import { ApiError } from '../lib/http.js';

const SESSION_DAYS = 7;
const NONCE_TTL_MS = 10 * 60_000;
export const SESSION_COOKIE = 'sid';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string; address: string };
  }
}

/** Expected SIWE origin: https://APP_DOMAIN (http only for localhost in development). */
export function expectedUri(domain: string, nodeEnv: string): string {
  return domain.startsWith('localhost') && nodeEnv !== 'production'
    ? `http://${domain}`
    : `https://${domain}`;
}

/** SIWE (EIP-4361) → httpOnly session cookie (API.md "Auth"). Sign-in costs no gas. */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, env } = app.deps;
  const client = createPublicClient({
    chain: robinhoodChain(env.RPC_URL),
    transport: http(env.RPC_URL, { timeout: 10_000 }),
  });
  const writeLimit = { rateLimit: { max: env.NODE_ENV === 'test' ? 10_000 : 20, timeWindow: '1 minute' } };

  app.get('/auth/nonce', { config: writeLimit }, async (_req, reply) => {
    const nonce = generateSiweNonce();
    await prisma.siweNonce.create({ data: { nonce, expiresAt: new Date(Date.now() + NONCE_TTL_MS) } });
    reply.header('Cache-Control', 'no-store');
    // domain / uri the sign-in message must carry (so clients build exactly what /auth/verify checks)
    return { nonce, domain: env.APP_DOMAIN, uri: expectedUri(env.APP_DOMAIN, env.NODE_ENV) };
  });

  const verifyBody = z.object({
    message: z.string().min(10).max(4000),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  });

  app.post('/auth/verify', { config: writeLimit }, async (req, reply) => {
    const body = verifyBody.safeParse(req.body);
    if (!body.success)
      throw new ApiError(400, 'BAD_REQUEST', 'Send { message, signature } from your wallet.');
    const fields = parseSiweMessage(body.data.message);
    const uri = expectedUri(env.APP_DOMAIN, env.NODE_ENV);
    if (fields.domain !== env.APP_DOMAIN)
      throw new ApiError(
        401,
        'BAD_DOMAIN',
        `Sign in on ${env.APP_DOMAIN}; this message is for ${fields.domain}.`,
      );
    if (fields.chainId !== env.SIWE_CHAIN_ID)
      throw new ApiError(
        401,
        'BAD_CHAIN',
        `Switch your wallet to chain ${env.SIWE_CHAIN_ID} and sign again.`,
      );
    if (fields.uri !== uri) throw new ApiError(401, 'BAD_URI', `The message URI must be ${uri}.`);
    if (!fields.address || !fields.nonce)
      throw new ApiError(400, 'BAD_MESSAGE', 'The sign-in message is incomplete.');
    if (fields.expirationTime && fields.expirationTime.getTime() < Date.now())
      throw new ApiError(401, 'EXPIRED', 'The sign-in message expired. Try again.');

    // single use + 10 minute expiry, claimed atomically
    const claimed = await prisma.siweNonce.updateMany({
      where: { nonce: fields.nonce, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1)
      throw new ApiError(
        401,
        'BAD_NONCE',
        'This sign-in request expired or was already used. Click sign in again.',
      );

    // EOA signatures locally (no RPC); EIP-1271 smart-contract wallets via an on-chain check
    const args = {
      address: fields.address,
      message: body.data.message,
      signature: body.data.signature as `0x${string}`,
    };
    const valid =
      (await verifyMessage(args).catch(() => false)) || (await client.verifyMessage(args).catch(() => false));
    if (!valid)
      throw new ApiError(
        401,
        'BAD_SIGNATURE',
        'The signature does not match the address. Sign again with the same wallet.',
      );

    const address = fields.address.toLowerCase();
    const user = await prisma.user.upsert({
      where: { address },
      create: { address },
      update: { lastSeenAt: new Date() },
    });
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000),
        ip: req.ip,
        userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
      },
    });
    reply.setCookie(SESSION_COOKIE, session.id, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_DAYS * 86_400,
      signed: Boolean(env.SESSION_SECRET),
    });
    return { address };
  });

  app.get('/auth/me', async (req, reply) => {
    const user = await sessionUser(app, req);
    if (!user)
      return reply
        .status(401)
        .send({ error: { code: 'UNAUTHENTICATED', message: 'Sign in with your wallet.' } });
    reply.header('Cache-Control', 'no-store');
    return { address: user.address };
  });

  /** Like /auth/me but always 200 (`address: null` when signed out), for pages that only want to know. */
  app.get('/auth/session', async (req, reply) => {
    const user = await sessionUser(app, req);
    reply.header('Cache-Control', 'no-store');
    return { address: user?.address ?? null };
  });

  app.post('/auth/logout', async (req, reply) => {
    const sid = readSid(app, req);
    if (sid) await prisma.session.deleteMany({ where: { id: sid } });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}

function readSid(app: FastifyInstance, req: FastifyRequest): string | null {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (!raw) return null;
  if (!app.deps.env.SESSION_SECRET) return raw;
  const r = req.unsignCookie(raw);
  return r.valid ? r.value : null;
}

export async function sessionUser(
  app: FastifyInstance,
  req: FastifyRequest,
): Promise<{ id: string; address: string } | null> {
  const sid = readSid(app, req);
  if (!sid) return null;
  const s = await app.deps.prisma.session.findUnique({ where: { id: sid }, include: { user: true } });
  if (!s || s.expiresAt.getTime() < Date.now()) return null;
  return { id: s.user.id, address: s.user.address };
}

/** preHandler for routes that need a SIWE session. */
export function requireAuth(app: FastifyInstance) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const user = await sessionUser(app, req);
    if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in with your wallet first (no gas needed).');
    req.user = user;
  };
}
