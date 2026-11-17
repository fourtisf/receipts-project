import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { decodeFunctionData } from 'viem';
import type { PrismaClient } from '@receipts/db';
import { createTestDb } from '@receipts/db/testing';
import { metadataHash } from '@receipts/shared';
import { signalRegistryAbi } from '@receipts/shared/abi';
import { loadEnv } from '../src/env.js';
import { buildServer } from '../src/server.js';

const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'); // anvil test key
const other = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const DOMAIN = 'receipts.test';
const REGISTRY = '0x000000000000000000000000000000000000dead';
const SIGNER = '0x90f79bf6eb2c4f870365e785982e1f101e93b906';

let app: FastifyInstance;
let prisma: PrismaClient;
let drop: () => Promise<void>;

beforeAll(async () => {
  const db = await createTestDb();
  prisma = db.prisma;
  drop = db.drop;
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: db.url,
    APP_DOMAIN: DOMAIN,
    SESSION_SECRET: 'x'.repeat(64),
    REGISTRY_ADDRESS: REGISTRY,
    SIGNER_ADDRESS_TEMPLATE: SIGNER,
  });
  app = await buildServer({ env, prisma });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await drop?.();
});

async function siwe(
  opts: { domain?: string; chainId?: number; uri?: string; signer?: typeof account; nonce?: string } = {},
) {
  const nonce = opts.nonce ?? (await app.inject('/auth/nonce')).json().nonce;
  const message = createSiweMessage({
    address: account.address,
    chainId: opts.chainId ?? 4663,
    domain: opts.domain ?? DOMAIN,
    nonce,
    uri: opts.uri ?? `https://${DOMAIN}`,
    version: '1',
    statement: 'Sign in to Receipts. This costs no gas.',
  });
  const signature = await (opts.signer ?? account).signMessage({ message });
  return { message, signature, nonce };
}

async function login(): Promise<string> {
  const { message, signature } = await siwe();
  const r = await app.inject({ method: 'POST', url: '/auth/verify', payload: { message, signature } });
  expect(r.statusCode).toBe(200);
  const cookie = r.cookies.find((c) => c.name === 'sid')!;
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe('Lax');
  return `sid=${cookie.value}`;
}

describe('SIWE auth', () => {
  it('signs in, reads /auth/me and logs out', async () => {
    const n = (await app.inject('/auth/nonce')).json();
    expect(n).toMatchObject({ domain: DOMAIN, uri: `https://${DOMAIN}` });
    const cookie = await login();
    const me = await app.inject({ url: '/auth/me', headers: { cookie } });
    expect(me.json()).toEqual({ address: account.address.toLowerCase() });
    await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
    expect((await app.inject({ url: '/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('nonces are single use', async () => {
    const s = await siwe();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/verify',
          payload: { message: s.message, signature: s.signature },
        })
      ).statusCode,
    ).toBe(200);
    const again = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { message: s.message, signature: s.signature },
    });
    expect(again.json().error.code).toBe('BAD_NONCE');
  });

  it('expired or unknown nonces are rejected', async () => {
    const nonce = (await app.inject('/auth/nonce')).json().nonce as string;
    await prisma.siweNonce.update({ where: { nonce }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const s = await siwe({ nonce });
    expect((await app.inject({ method: 'POST', url: '/auth/verify', payload: s })).json().error.code).toBe(
      'BAD_NONCE',
    );
    const unknown = await siwe({ nonce: 'abcdefgh12345678' });
    expect(
      (await app.inject({ method: 'POST', url: '/auth/verify', payload: unknown })).json().error.code,
    ).toBe('BAD_NONCE');
  });

  it('rejects wrong domain, chain, uri and signer', async () => {
    const codes = [];
    for (const o of [
      { domain: 'evil.example' },
      { chainId: 1 },
      { uri: 'https://evil.example' },
      { signer: other },
    ]) {
      const s = await siwe(o);
      codes.push(
        (
          await app.inject({
            method: 'POST',
            url: '/auth/verify',
            payload: { message: s.message, signature: s.signature },
          })
        ).json().error.code,
      );
    }
    expect(codes).toEqual(['BAD_DOMAIN', 'BAD_CHAIN', 'BAD_URI', 'BAD_SIGNATURE']);
  });

  it('forged or unsigned cookies are ignored', async () => {
    const s = await prisma.session.findFirst();
    expect((await app.inject({ url: '/auth/me', headers: { cookie: `sid=${s?.id}` } })).statusCode).toBe(401);
  });
});

describe('writes', () => {
  it('require a session', async () => {
    const r = await app.inject({ method: 'POST', url: '/strategies', payload: {} });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('POST /strategies stores content-addressed metadata and returns registerStrategy inputs', async () => {
    const cookie = await login();
    const body = {
      name: 'My Momentum',
      template: 'momentum',
      params: { window: 24, trailingStop: 5, size: 50 },
      assets: ['WETH'],
      creatorShareBps: 1500,
    };
    const r = await app.inject({ method: 'POST', url: '/strategies', headers: { cookie }, payload: body });
    expect(r.statusCode).toBe(200);
    const out = r.json();
    expect(out).toMatchObject({
      signer: SIGNER,
      revealWindow: 3600,
      creatorShareBps: 1500,
      registry: REGISTRY,
      modelHash: `0x${'0'.repeat(64)}`,
    });
    const hash = out.metadataURI.split('/').pop();
    expect(out.metadataURI).toBe(`https://${DOMAIN}/api/metadata/${hash}`);
    const doc = await app.inject(`/metadata/${hash}`);
    expect(doc.json()).toMatchObject({
      name: 'My Momentum',
      template: 'momentum',
      kind: 'TEMPLATE',
      assets: ['WETH'],
    });
    expect(metadataHash(doc.json())).toBe(hash); // anyone can recompute it
  });

  it('POST /strategies validates template params', async () => {
    const cookie = await login();
    const r = await app.inject({
      method: 'POST',
      url: '/strategies',
      headers: { cookie },
      payload: {
        name: 'Bad',
        template: 'ma_cross',
        params: { fast: 50, slow: 10 },
        assets: ['WETH'],
        creatorShareBps: 100,
      },
    });
    expect(r.json().error).toMatchObject({ code: 'BAD_PARAMS' });
    const ai = await app.inject({
      method: 'POST',
      url: '/strategies',
      headers: { cookie },
      payload: { name: 'AI one', template: 'ai_news', params: {}, assets: ['NVDA'], creatorShareBps: 100 },
    });
    expect(ai.json().error.code).toBe('NO_AI');
  });

  it('PATCH and deactivate return tx data for the creator only', async () => {
    const cookie = await login();
    await prisma.strategy.create({
      data: {
        id: 5,
        slug: 'mine-5',
        name: 'Mine',
        description: 'd',
        kind: 'TEMPLATE',
        category: 'CRYPTO',
        template: 'momentum',
        params: {},
        assets: ['WETH'],
        creatorAddr: account.address.toLowerCase(),
        signerAddr: SIGNER,
        creatorShareBps: 0,
        revealWindowSec: 3600,
        metadataURI: 'x',
        registeredTx: `0x${'1'.repeat(64)}`,
        registeredAt: new Date(),
      },
    });
    const d = await app.inject({ method: 'POST', url: '/strategies/5/deactivate', headers: { cookie } });
    const call = decodeFunctionData({ abi: signalRegistryAbi, data: d.json().tx.data });
    expect(call).toMatchObject({ functionName: 'setActive', args: [5n, false] });
    const p = await app.inject({
      method: 'PATCH',
      url: '/strategies/5',
      headers: { cookie },
      payload: { name: 'Renamed' },
    });
    expect(decodeFunctionData({ abi: signalRegistryAbi, data: p.json().tx.data }).functionName).toBe(
      'setMetadataURI',
    );
    await prisma.strategy.update({ where: { id: 5 }, data: { creatorAddr: other.address.toLowerCase() } });
    expect(
      (await app.inject({ method: 'POST', url: '/strategies/5/deactivate', headers: { cookie } })).json()
        .error.code,
    ).toBe('NOT_CREATOR');
  });

  it('POST /backtest validates input and refuses AI templates', async () => {
    const cookie = await login();
    const ai = await app.inject({
      method: 'POST',
      url: '/backtest',
      headers: { cookie },
      payload: { template: 'ai_news', params: {}, assets: ['NVDA'] },
    });
    expect(ai.json().error.code).toBe('NO_AI_BACKTEST');
    const bad = await app.inject({
      method: 'POST',
      url: '/backtest',
      headers: { cookie },
      payload: { template: 'rsi', params: { period: 2 }, assets: ['NVDA'] },
    });
    expect(bad.json().error.code).toBe('BAD_PARAMS');
  });
});
