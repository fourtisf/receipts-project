import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, type PrismaClient } from '@receipts/db';
import { createTestDb } from '@receipts/db/testing';
import { Indexer } from '../src/indexer/indexer.js';
import { Publisher } from '../src/pubsub.js';
import { log } from '../src/log.js';
import type { Client } from '../src/chain.js';

const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
let prisma: PrismaClient;
let drop: () => Promise<void>;

/** Fake chain: block hashes are `canon-<n>` (or `fork-<n>` before the reorg), no logs, contract reads fail. */
function fakeClient(head: bigint, hashOf: (n: bigint) => string): Client {
  return {
    getBlockNumber: async () => head,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
      hash: hashOf(blockNumber),
      timestamp: 1_800_000_000n,
    }),
    getLogs: async () => [],
    readContract: async () => {
      throw new Error('no contract');
    },
  } as unknown as Client;
}

beforeAll(async () => {
  const db = await createTestDb();
  prisma = db.prisma;
  drop = db.drop;
  await prisma.strategy.create({
    data: {
      id: 1,
      slug: 's-1',
      name: 'S',
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
      registeredAt: new Date(),
      registeredBlock: 100n,
    },
  });
  await prisma.vault.create({
    data: {
      address: '0xv',
      ownerAddr: '0xo',
      createdTx: tx(2),
      createdAt: new Date(),
      createdBlock: 100n,
      maxSlippageBps: 100,
      dailyLimitUsd: new Prisma.Decimal(1),
      drawdownBps: 1000,
    },
  });
  const keep = await prisma.commit.create({
    data: {
      strategyId: 1,
      nonce: 0,
      hash: tx(10),
      status: 'REVEALED',
      committedAt: new Date(),
      committedL2Block: 105n,
      commitTx: tx(11),
      revealDeadline: new Date(),
      revealTx: tx(12),
      revealBlock: 125n,
      revealedAt: new Date(),
      tokenIn: '0xa',
      tokenOut: '0xb',
      sizeBps: 100,
      matchStatus: 'MATCH',
    },
  });
  await prisma.commit.create({
    data: {
      strategyId: 1,
      nonce: 1,
      hash: tx(20),
      status: 'COMMITTED',
      committedAt: new Date(),
      committedL2Block: 121n,
      commitTx: tx(21),
      revealDeadline: new Date(),
    },
  });
  await prisma.execution.create({
    data: {
      vaultAddr: '0xv',
      commitId: keep.id,
      strategyId: 1,
      nonce: 0,
      tokenIn: '0xa',
      tokenOut: '0xb',
      amountIn: new Prisma.Decimal(1),
      amountOut: new Prisma.Decimal(1),
      valueUsd: new Prisma.Decimal(1),
      minOut: new Prisma.Decimal(1),
      slippageVsOracleBps: 0,
      txHash: tx(13),
      logIndex: 0,
      blockNumber: 122n,
      executedAt: new Date(),
    },
  });
  for (const id of ['registry', 'factory', 'vaults']) {
    await prisma.indexerCursor.create({ data: { id, lastBlock: 130n, lastBlockHash: 'fork-130' } });
  }
}, 120_000);

afterAll(async () => {
  await drop?.();
});

describe('indexer reorg handling', () => {
  it('rolls back above the fork point and re-indexes from there', async () => {
    const client = fakeClient(140n, (n) => `canon-${n}`); // block 130 hash changed → reorg
    const indexer = new Indexer(
      prisma,
      client,
      {
        registry: '0x000000000000000000000000000000000000dead',
        factory: '0x000000000000000000000000000000000000beef',
        startBlock: 1n,
        confirmations: 3,
        chunk: 2000,
        reorgRewind: 10,
        houseVaults: [],
        houseCreators: [],
        explorerUrl: 'https://x',
        chainId: 4663,
      },
      log,
      new Publisher(null),
    );
    const r = await indexer.tick();
    expect(r?.reorg).toBe(true);
    expect(r?.from).toBe(121n); // rolled back to 120, then indexes 121..137
    expect(r?.to).toBe(137n);

    expect(await prisma.execution.count()).toBe(0); // block 122 > 120
    const c0 = await prisma.commit.findUnique({ where: { strategyId_nonce: { strategyId: 1, nonce: 0 } } });
    expect(c0).toMatchObject({ status: 'COMMITTED', revealTx: null, tokenIn: null, matchStatus: 'PENDING' }); // reveal at 125 undone
    expect(
      await prisma.commit.findUnique({ where: { strategyId_nonce: { strategyId: 1, nonce: 1 } } }),
    ).toBeNull(); // committed at 121
    expect(await prisma.strategy.count()).toBe(1); // registered at 100, survives
    const cur = await prisma.indexerCursor.findUnique({ where: { id: 'registry' } });
    expect(cur).toMatchObject({ lastBlock: 137n, lastBlockHash: 'canon-137' });
  });

  it('does nothing when there is no new safe block', async () => {
    const client = fakeClient(140n, (n) => `canon-${n}`);
    const indexer = new Indexer(
      prisma,
      client,
      {
        registry: '0x000000000000000000000000000000000000dead',
        factory: '0x000000000000000000000000000000000000beef',
        startBlock: 1n,
        confirmations: 3,
        chunk: 2000,
        reorgRewind: 10,
        houseVaults: [],
        houseCreators: [],
        explorerUrl: 'https://x',
        chainId: 4663,
      },
      log,
      new Publisher(null),
    );
    expect(await indexer.tick()).toBeNull();
  });
});
