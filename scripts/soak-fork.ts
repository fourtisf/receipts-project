/**
 * M5 soak on an anvil fork: the real Executor runs commit → execute → reveal for alternating signals while the real
 * worker indexes; includes a crash between commit and reveal (recovered on "restart"). At the end it checks:
 *   - zero missed reveals for our strategy,
 *   - every execution references a commit and sits in a later L2 block than it,
 *   - the mismatch detector passes (every executed receipt is MATCH),
 *   - no indexer errors in AlertLog.
 *
 *   SOAK_MINUTES=3 pnpm tsx scripts/soak-fork.ts        (the launch soak is 48 h on mainnet-fork / mainnet)
 * Uses anvil's public dev keys only.
 */
import { randomBytes } from 'node:crypto';
import { createPublicClient, http, type Address } from 'viem';
import { robinhoodChain } from '../packages/shared/src/index.js';
import { Executor } from '../apps/worker/src/pipeline/executor.js';
import { makeWallet } from '../apps/worker/src/pipeline/keys.js';
import { SecretBox } from '../apps/worker/src/pipeline/secrets.js';
import { log } from '../apps/worker/src/log.js';
import { DB, E2E_SCHEMA, KEYS, REDIS, RPC, pub, setupFork, startProc, waitFor } from './lib/fork-setup.js';
import { Redis } from 'ioredis';

const MINUTES = Number(process.env.SOAK_MINUTES ?? 3);

async function main() {
  const { registry, factory, strategyId, startBlock, prisma } = await setupFork();
  const env = {
    DATABASE_URL: DB,
    REDIS_URL: REDIS,
    RPC_URL: RPC,
    REGISTRY_ADDRESS: registry,
    FACTORY_ADDRESS: factory,
    START_BLOCK: (startBlock - 5n).toString(),
    CONFIRMATIONS: '0',
    INDEXER_POLL_MS: '500',
    RUN_PRICES: '1',
    RUN_STATS: '0',
    RUN_RUNNER: '0',
    RUN_EXECUTOR: '0',
    RUN_MISSED: '0',
    LOG_LEVEL: 'warn',
  };
  const worker = startProc('worker', 'apps/worker/src/index.ts', env);
  process.on('exit', () => worker.kill('SIGTERM'));

  const redis = new Redis(REDIS, { maxRetriesPerRequest: null });
  const client = createPublicClient({
    chain: robinhoodChain(RPC),
    transport: http(RPC, { timeout: 60_000 }),
  });
  const signer = makeWallet(RPC, KEYS.signer);
  const executorKey = makeWallet(RPC, KEYS.operator);
  const box = new SecretBox(randomBytes(32).toString('hex'));
  const alerts: string[] = [];
  const mk = () =>
    new Executor({
      prisma,
      client: client as never,
      redis,
      log,
      registry: registry as Address,
      chainId: 4663,
      executor: executorKey,
      signers: new Map([[signer.address, signer]]),
      box,
      alert: async (_l, kind, msg) => {
        alerts.push(`${kind}: ${msg}`);
      },
    });
  const executor = mk();
  // anvil auto-mines only on transactions; a live L2 produces blocks continuously (dev compose: --block-time 2)
  const miner = setInterval(
    () => void pub.request({ method: 'evm_mine' as never, params: [] as never }).catch(() => undefined),
    1000,
  );
  await waitFor(async () => (await prisma.strategy.count()) > 0, 60_000, 'strategy indexed');

  const end = Date.now() + MINUTES * 60_000;
  let signals = 0;
  let side: 'BUY' | 'SELL' = 'BUY';
  const assets = ['WETH', 'cbBTC'];
  let crashed = false;
  while (Date.now() < end) {
    const asset = assets[signals % 2 === 0 ? 0 : 1]!;
    const sizeBps = side === 'BUY' ? 1000 + (signals % 5) * 500 : 10_000;
    if (!crashed && signals === 3) {
      // crash after commit, before execute/reveal; a fresh Executor ("restart") must recover and reveal it
      await executor.commit(
        strategyId_n(strategyId),
        executor.toSignal({ side, asset, sizeBps, reason: 'crash test' }, null),
        null,
      );
      crashed = true;
      await mk().recoverPending();
      console.log('→ crash test: pending commit recovered and revealed');
    } else {
      await executor.run(strategyId_n(strategyId), { side, asset, sizeBps, reason: 'soak' });
    }
    signals++;
    if (signals % 2 === 0) side = side === 'BUY' ? 'SELL' : 'BUY';
    await pub.request({ method: 'evm_mine' as never, params: [] as never });
    await new Promise((r) => setTimeout(r, 2000));
  }

  // let the indexer catch up
  await waitFor(
    async () => (await prisma.commit.count({ where: { status: 'REVEALED' } })) >= signals,
    60_000,
    'all reveals indexed',
  );
  await new Promise((r) => setTimeout(r, 3000));

  const commits = await prisma.commit.findMany({ include: { executions: true }, orderBy: { nonce: 'asc' } });
  const missed = commits.filter((c) => c.status !== 'REVEALED').length;
  const execs = commits.flatMap((c) => c.executions.map((e) => ({ c, e })));
  const late = execs.filter(({ c, e }) => e.blockNumber <= c.committedL2Block).length;
  const mismatches = commits.filter((c) => c.matchStatus === 'MISMATCH');
  const pendingMatch = commits.filter((c) => c.matchStatus === 'PENDING').length;
  const openSecrets = await prisma.secretSalt.count({ where: { revealedAt: null } });
  const alertRows = await prisma.alertLog.findMany();

  console.log(
    `→ soak ${MINUTES} min: ${signals} signals, ${commits.length} receipts, ${execs.length} executions`,
  );
  console.log(`   missed reveals: ${missed}`);
  console.log(`   executions not after their commit: ${late}`);
  console.log(
    `   mismatches: ${mismatches.length}${mismatches.length ? ' ' + mismatches.map((m) => m.matchNote).join(' | ') : ''}`,
  );
  console.log(`   match results: ${JSON.stringify(countBy(commits.map((c) => c.matchStatus)))}`);
  console.log(`   unrevealed secrets: ${openSecrets}, alerts: ${alerts.length + alertRows.length}`);

  clearInterval(miner);
  worker.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${E2E_SCHEMA}" CASCADE`); // only this run's schema
  await prisma.$disconnect();
  redis.disconnect();
  const ok =
    missed === 0 &&
    late === 0 &&
    mismatches.length === 0 &&
    pendingMatch === 0 &&
    openSecrets === 0 &&
    commits.length === signals;
  console.log(ok ? '✓ SOAK passed' : '✗ SOAK FAILED');
  process.exit(ok ? 0 : 1);
}

function strategyId_n(id: bigint): number {
  return Number(id);
}

function countBy(xs: string[]): Record<string, number> {
  return xs.reduce<Record<string, number>>((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
