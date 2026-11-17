import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, type PrismaClient } from '@receipts/db';
import { createTestDb } from '@receipts/db/testing';
import { runStats } from '../src/jobs/stats.js';
import type { Client } from '../src/chain.js';

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const H = 3_600_000;
const now = Date.UTC(2026, 10, 17, 12);
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
let prisma: PrismaClient;
let drop: () => Promise<void>;

beforeAll(async () => {
  const db = await createTestDb();
  prisma = db.prisma;
  drop = db.drop;
  await prisma.strategy.create({
    data: {
      id: 1,
      slug: 'eth-1',
      name: 'ETH',
      description: '',
      kind: 'TEMPLATE',
      category: 'CRYPTO',
      template: 'momentum',
      params: {},
      assets: ['WETH'],
      creatorAddr: '0x01',
      signerAddr: '0x02',
      creatorShareBps: 0,
      revealWindowSec: 3600,
      metadataURI: 'x',
      registeredTx: tx(1),
      registeredAt: new Date(now - 48 * H),
    },
  });
  // WETH 2000 → 2200 over 24h (hourly Chainlink rounds)
  for (let i = 0; i <= 24; i++) {
    await prisma.pricePoint.create({
      data: {
        token: 'WETH',
        feed: '0xfeed',
        priceUsd: new Prisma.Decimal(2000 + (200 * i) / 24),
        roundId: String(i),
        updatedAt: new Date(now - (24 - i) * H),
      },
    });
  }
  // paper BUY 100% at 2000, 24h ago
  await prisma.commit.create({
    data: {
      strategyId: 1,
      nonce: 0,
      hash: tx(9),
      status: 'REVEALED',
      committedAt: new Date(now - 24 * H),
      committedL2Block: 1n,
      commitTx: tx(10),
      revealDeadline: new Date(now - 23 * H),
      tokenIn: USDG,
      tokenOut: WETH,
      sizeBps: 10_000,
      priceOutAtCommit: new Prisma.Decimal(2000),
      priceInAtCommit: new Prisma.Decimal(1),
    },
  });
  await prisma.commit.create({
    data: {
      strategyId: 1,
      nonce: 1,
      hash: tx(11),
      status: 'MISSED',
      committedAt: new Date(now - 2 * H),
      committedL2Block: 2n,
      commitTx: tx(12),
      revealDeadline: new Date(now - H),
    },
  });
  await prisma.vault.create({
    data: {
      address: '0xv',
      ownerAddr: '0xo',
      createdTx: tx(2),
      createdAt: new Date(),
      followingId: 1,
      maxSlippageBps: 100,
      dailyLimitUsd: new Prisma.Decimal(2000),
      drawdownBps: 2000,
    },
  });
}, 120_000);

afterAll(async () => {
  await drop?.();
});

describe('stats job', () => {
  it('writes equity, KPIs, followers, AUM and global stats from indexed data', async () => {
    const client = { readContract: async () => 1234n * 10n ** 18n } as unknown as Client; // navLenient
    await runStats(prisma, client, now);
    const s = await prisma.strategy.findUniqueOrThrow({ where: { id: 1 } });
    expect(Number(s.ret30d)).toBeCloseTo(1.1 * 0.999 - 1, 6); // +10% minus 0.1% paper cost
    expect(Number(s.hold30d)).toBeCloseTo(0.1, 4);
    expect(Number(s.maxDrawdown30d)).toBeCloseTo(-0.001, 6); // the entry cost is the only dip
    expect(s.followers).toBe(1);
    expect(s.aumUsd.toFixed()).toBe('1234');
    const pts = await prisma.equityPoint.findMany({ where: { strategyId: 1 }, orderBy: { at: 'asc' } });
    expect(pts.length).toBe(26); // start point + 25 hourly marks
    expect(Number(pts.at(-1)!.equity)).toBeCloseTo(109.89, 2);
    const g = await prisma.globalStat.findUniqueOrThrow({ where: { id: 1 } });
    expect(g).toMatchObject({ receiptsPrinted: 2, strategiesLive: 1, missedReveals: 1 });
    expect(g.tvlUsd.toFixed()).toBe('1234');
  });
});
