import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Prisma, type PrismaClient } from '@receipts/db';
import { createTestDb } from '@receipts/db/testing';
import {
  hashSignal,
  receiptDetailSchema,
  strategyListSchema,
  statsSchema,
  templateListSchema,
  chainConfigSchema,
} from '@receipts/shared';
import { loadEnv } from '../src/env.js';
import { buildServer } from '../src/server.js';
import { topicsOf } from '../src/routes/ws.js';

const REGISTRY = '0x000000000000000000000000000000000000dead';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const VAULT = '0x1111111111111111111111111111111111111111';
const OWNER = '0x2222222222222222222222222222222222222222';
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

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
    REGISTRY_ADDRESS: REGISTRY,
    CHAIN_ID: '4663',
  });
  app = await buildServer({ env, prisma });

  const now = Date.now();
  for (const [id, name, kind, cat, assets, ret, hold] of [
    [
      1,
      'Mag7 Rebalance',
      'HOUSE',
      'STOCK',
      ['NVDA', 'AAPL', 'MSFT', 'META', 'GOOGL', 'AMZN', 'TSLA'],
      0.068,
      0.049,
    ],
    [2, 'ETH Trend', 'TEMPLATE', 'CRYPTO', ['WETH'], 0.114, 0.072],
    [3, 'Dip Buyer', 'TEMPLATE', 'CRYPTO', ['WETH', 'cbBTC'], -0.026, 0.061],
  ] as const) {
    await prisma.strategy.create({
      data: {
        id,
        slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id}`,
        name,
        description: `${name} description`,
        kind,
        category: cat,
        template: id === 1 ? 'rebalance' : 'momentum',
        params: {},
        assets: [...assets],
        creatorAddr: OWNER,
        signerAddr: OWNER,
        creatorShareBps: 1000,
        revealWindowSec: 3600,
        metadataURI: 'x',
        ret30d: new Prisma.Decimal(ret),
        hold30d: new Prisma.Decimal(hold),
        maxDrawdown30d: new Prisma.Decimal(-0.05),
        followers: id,
        aumUsd: new Prisma.Decimal(100 * id),
        commitCount: 2,
        missedCount: id === 3 ? 1 : 0,
        registeredTx: tx(id),
        registeredAt: new Date(now - 86_400_000),
      },
    });
  }
  await prisma.vault.create({
    data: {
      address: VAULT,
      ownerAddr: OWNER,
      createdTx: tx(99),
      createdAt: new Date(now - 3_600_000),
      followingId: 2,
      allocationUsd: new Prisma.Decimal(1000),
      maxSlippageBps: 100,
      dailyLimitUsd: new Prisma.Decimal(2000),
      drawdownBps: 2000,
      navUsd: new Prisma.Decimal(1000),
      isHouse: true,
    },
  });
  // receipt 1: revealed + executed (valid preimage)
  const signal = { tokenIn: USDG, tokenOut: WETH, sizeBps: 2500, promptHash: `0x${'0'.repeat(64)}` } as const;
  const salt = tx(42);
  const hash = hashSignal({
    chainId: 4663,
    registry: REGISTRY,
    strategyId: 2,
    nonce: 0,
    signal,
    salt: salt as `0x${string}`,
  });
  const c1 = await prisma.commit.create({
    data: {
      strategyId: 2,
      nonce: 0,
      hash,
      status: 'REVEALED',
      committedAt: new Date(now - 1_800_000),
      committedL2Block: 100n,
      commitTx: tx(1000),
      revealDeadline: new Date(now + 1_800_000),
      revealedAt: new Date(now - 1_000_000),
      revealTx: tx(1001),
      revealBlock: 105n,
      tokenIn: USDG,
      tokenOut: WETH,
      sizeBps: 2500,
      promptHash: signal.promptHash,
      salt,
      priceInAtCommit: new Prisma.Decimal(1),
      priceOutAtCommit: new Prisma.Decimal(2000),
      matchStatus: 'MATCH',
    },
  });
  await prisma.execution.create({
    data: {
      vaultAddr: VAULT,
      commitId: c1.id,
      strategyId: 2,
      nonce: 0,
      tokenIn: USDG,
      tokenOut: WETH,
      amountIn: new Prisma.Decimal('250000000'),
      amountOut: new Prisma.Decimal('124800000000000000'),
      valueUsd: new Prisma.Decimal(250),
      minOut: new Prisma.Decimal('123750000000000000'),
      slippageVsOracleBps: 16,
      txHash: tx(1002),
      logIndex: 3,
      blockNumber: 101n,
      executedAt: new Date(now - 1_700_000),
    },
  });
  // receipt 2: missed
  await prisma.commit.create({
    data: {
      strategyId: 3,
      nonce: 0,
      hash: tx(77),
      status: 'MISSED',
      committedAt: new Date(now - 7_200_000),
      committedL2Block: 90n,
      commitTx: tx(2000),
      revealDeadline: new Date(now - 3_600_000),
      missedTx: tx(2001),
      missedBlock: 140n,
      matchStatus: 'PENDING',
    },
  });
  await prisma.globalStat.create({
    data: {
      id: 1,
      receiptsPrinted: 2,
      strategiesLive: 3,
      missedReveals: 1,
      tvlUsd: new Prisma.Decimal(1000),
    },
  });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await drop?.();
});

describe('public API', () => {
  it('GET /health', async () => {
    const r = await app.inject('/health');
    expect(r.statusCode).toBe(200);
    expect(r.json().db).toBe(true);
  });

  it('GET /stats', async () => {
    const r = await app.inject('/stats');
    const s = statsSchema.parse(r.json());
    expect(s).toMatchObject({ receiptsPrinted: 2, strategiesLive: 3, missedReveals: 1, tvlUsd: '1000.00' });
    expect(r.headers['cache-control']).toBe('public, max-age=10');
  });

  it('GET /strategies sorts and filters', async () => {
    const all = strategyListSchema.parse((await app.inject('/strategies')).json());
    expect(all.items.map((s) => s.id)).toEqual([2, 1, 3]); // vs hold: 4.2, 1.9, -8.7
    expect(all.items[0]).toMatchObject({
      ret30d: 11.4,
      hold30d: 7.2,
      vsHold: 4.2,
      market: 'ETH / USDG',
      house: true,
    });
    expect(all.items.find((s) => s.id === 1)!.market).toBe('7 stock tokens');
    expect(all.totals).toMatchObject({ count: 3, followers: 6, aumUsd: '600.00' });
    const crypto = strategyListSchema.parse(
      (await app.inject('/strategies?category=crypto&sort=ret')).json(),
    );
    expect(crypto.items.map((s) => s.id)).toEqual([2, 3]);
    const paged = strategyListSchema.parse((await app.inject('/strategies?limit=1')).json());
    expect(paged.nextCursor).toBe('1');
    expect((await app.inject('/strategies?sort=bogus')).statusCode).toBe(400);
  });

  it('GET /strategies/:idOrSlug by id and slug, 404 otherwise', async () => {
    const byId = (await app.inject('/strategies/2')).json();
    expect(byId.name).toBe('ETH Trend');
    expect(byId.houseVault).toBe(VAULT);
    const bySlug = (await app.inject(`/strategies/${byId.slug}`)).json();
    expect(bySlug.id).toBe(2);
    const missing = await app.inject('/strategies/999');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('NOT_FOUND');
  });

  it('GET /receipts/:id verifies the reveal and lists executions', async () => {
    const r = await app.inject('/receipts/1');
    expect(r.statusCode).toBe(200);
    const d = receiptDetailSchema.parse(r.json());
    expect(d.side).toBe('BUY');
    expect(d.asset).toBe('WETH');
    expect(d.executionList).toHaveLength(1);
    expect(d.checks.map((c) => c.id)).toEqual([
      'commit_found',
      'reveal_matches',
      'executed_after_commit',
      'price_within_oracle',
      'balance_changed_correctly',
    ]);
    expect(d.checks.every((c) => c.ok === true)).toBe(true);
    expect(Number(d.fillPriceUsd)).toBeCloseTo(2003.2, 1);
    expect(r.headers['cache-control']).toBe('public, max-age=3600');
    // same receipt by hash and by strategyId-nonce
    expect((await app.inject(`/receipts/${d.hash}`)).json().receiptNo).toBe(d.receiptNo);
    expect((await app.inject('/receipts/2-0')).json().receiptNo).toBe(d.receiptNo);
  });

  it('GET /receipts/:id flags missed reveals', async () => {
    const d = receiptDetailSchema.parse((await app.inject('/receipts/2')).json());
    expect(d.status).toBe('MISSED');
    expect(d.checks[1]).toMatchObject({ id: 'reveal_matches', ok: false, title: 'Reveal missed' });
    expect(d.signal).toBeNull();
  });

  it('GET /receipts errors are explicit', async () => {
    expect((await app.inject('/receipts/abc')).json().error.code).toBe('BAD_ID');
    expect((await app.inject('/receipts/999')).statusCode).toBe(404);
  });

  it('GET /receipts/latest and /strategies/:id/receipts', async () => {
    const latest = (await app.inject('/receipts/latest?limit=8')).json();
    expect(latest.items.map((i: { receiptNo: number }) => i.receiptNo)).toEqual([2, 1]);
    const forS = (await app.inject('/strategies/2/receipts')).json();
    expect(forS.items).toHaveLength(1);
  });

  it('GET /vaults/:owner and /vaults/house', async () => {
    const v = (await app.inject(`/vaults/${OWNER.toUpperCase().replace('0X', '0x')}`)).json();
    expect(v).toMatchObject({ address: VAULT, followingId: 2, followingName: 'ETH Trend', isHouse: true });
    expect((await app.inject('/vaults/0x3333333333333333333333333333333333333333')).statusCode).toBe(404);
    expect((await app.inject('/vaults/nope')).statusCode).toBe(400);
    const house = (await app.inject('/vaults/house')).json();
    expect(house.items[0]).toMatchObject({ address: VAULT, strategyName: 'ETH Trend' });
  });

  it('GET /templates and /config/chain', async () => {
    const t = templateListSchema.parse((await app.inject('/templates')).json());
    expect(t.items.map((x) => x.id)).toEqual([
      'momentum',
      'meanrev',
      'ma_cross',
      'rsi',
      'dip',
      'rebalance',
      'rotation',
      'ai_news',
    ]);
    const c = chainConfigSchema.parse((await app.inject('/config/chain')).json());
    expect(c.chainId).toBe(4663);
    expect(c.tokens).toHaveLength(13);
    expect(c.registry).toBe(REGISTRY);
  });

  it('GET /strategies/:id/equity returns an (empty) series', async () => {
    const e = (await app.inject('/strategies/2/equity?range=30d')).json();
    expect(e.points).toEqual([]);
    expect(e.basis).toBe('live');
  });

  it('unknown routes return a JSON error', async () => {
    const r = await app.inject('/nope');
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('NOT_FOUND');
  });
});

describe('websocket topics', () => {
  it('routes events to receipts / strategy / vault subscribers', () => {
    expect(topicsOf({ type: 'receipt.committed', data: { strategyId: 3 } })).toEqual([
      'receipts',
      'strategy:3',
    ]);
    expect(topicsOf({ type: 'vault.event', data: { vault: '0xABC' } })).toEqual(['vault:0xabc']);
  });
});
