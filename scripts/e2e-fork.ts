/**
 * M2 acceptance: on an anvil fork of Robinhood Chain, a scripted commit → execute → reveal shows up as one receipt
 * via GET /receipts/:id within 10 s, served by the real worker (indexer) and API processes.
 *
 *   anvil --fork-url $RPC_URL --chain-id 4663 &            # or docker compose -f deploy/docker-compose.dev.yml up -d
 *   pnpm e2e:fork
 */
import { keccak256, parseUnits, toHex, type Hex } from 'viem';
import { hashSignal } from '../packages/shared/src/index.js';
import {
  API_PORT,
  DB,
  E2E_SCHEMA,
  KEYS,
  REDIS,
  RPC,
  pub,
  registryArt,
  root,
  send,
  setupFork,
  startProc,
  vaultArt,
  waitFor,
} from './lib/fork-setup.js';

async function main() {
  const t0 = Date.now();
  console.log(`→ fork at ${RPC}, chain ${await pub.getChainId()}, block ${await pub.getBlockNumber()}`);

  const { registry, factory, vault, strategyId, startBlock, prisma, usdg, weth } = await setupFork();

  // 3. start the real worker + API against this deployment
  const env = {
    DATABASE_URL: DB,
    REDIS_URL: REDIS,
    RPC_URL: RPC,
    REGISTRY_ADDRESS: registry,
    FACTORY_ADDRESS: factory,
    START_BLOCK: (startBlock - 5n).toString(),
    CONFIRMATIONS: '0',
    INDEXER_POLL_MS: '500',
    API_PORT: String(API_PORT),
    NODE_ENV: 'development',
    RUN_PRICES: '0',
    RUN_STATS: '0',
    RUN_RUNNER: '0',
    RUN_EXECUTOR: '0',
    RUN_MISSED: '0',
    LOG_LEVEL: 'warn',
  };
  const worker = startProc('worker', 'apps/worker/src/index.ts', env);
  const api = startProc('api', 'apps/api/src/index.ts', env);
  const cleanup = () => {
    worker.kill('SIGTERM');
    api.kill('SIGTERM');
  };
  process.on('exit', cleanup);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${API_PORT}/health`)).ok, 60_000, 'api health');

  // 4. commit → execute (next block) → reveal
  const signal = {
    tokenIn: usdg.address,
    tokenOut: weth.address,
    sizeBps: 2500,
    promptHash: `0x${'0'.repeat(64)}` as Hex,
  };
  const salt = keccak256(toHex(`e2e-${Date.now()}`));
  const nonce = 0n;
  const hash = hashSignal({ chainId: 4663, registry, strategyId, nonce, signal, salt });
  const onchain = await pub.readContract({
    address: registry,
    abi: registryArt.abi,
    functionName: 'hashSignal',
    args: [strategyId, nonce, signal, salt],
  });
  if (onchain !== hash) throw new Error(`hashSignal mismatch TS ${hash} vs chain ${onchain}`);

  const tStart = Date.now();
  await send(KEYS.signer, registry, registryArt.abi, 'commit', [strategyId, hash]);
  await pub.request({ method: 'evm_mine' as never, params: [] as never });
  const execRcpt = await send(KEYS.operator, vault, vaultArt.abi, 'executeSignal', [
    nonce,
    usdg.address,
    weth.address,
    parseUnits('250', 6),
    0n,
  ]);
  await send(KEYS.signer, registry, registryArt.abi, 'reveal', [strategyId, nonce, signal, salt]);
  console.log(`→ commit / execute (${execRcpt.transactionHash}) / reveal sent`);

  // 5. poll the API until the receipt is complete
  type R = {
    receiptNo: number;
    status: string;
    matchStatus: string;
    executionList: unknown[];
    checks: { id: string; ok: boolean | null }[];
  };
  let receipt: R | null = null;
  await waitFor(
    async () => {
      const res = await fetch(`http://127.0.0.1:${API_PORT}/receipts/${hash}`);
      if (!res.ok) return false;
      const r = (await res.json()) as R;
      if (r.status === 'REVEALED' && r.matchStatus !== 'PENDING' && r.executionList.length === 1) {
        receipt = r;
        return true;
      }
      return false;
    },
    30_000,
    'receipt',
  );
  const elapsed = Date.now() - tStart;
  const r = receipt as unknown as R;
  console.log(
    `→ receipt #${r.receiptNo}: ${r.status}, ${r.matchStatus}, ${r.executionList.length} execution`,
  );
  for (const c of r.checks) console.log(`   ${c.ok === true ? '✓' : c.ok === false ? '✗' : '·'} ${c.id}`);
  const allOk = r.checks.every((c) => c.ok === true);
  console.log(`→ visible via GET /receipts/:id ${elapsed} ms after the commit was sent`);

  cleanup();
  await new Promise((r) => setTimeout(r, 1500));
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${E2E_SCHEMA}" CASCADE`); // only this run's own schema
  await prisma.$disconnect();
  if (!allOk || r.matchStatus !== 'MATCH' || elapsed > 10_000) {
    console.error('✗ E2E FAILED');
    process.exit(1);
  }
  console.log(`✓ E2E passed in ${Date.now() - t0} ms total`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
