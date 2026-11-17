/**
 * Web happy path on an anvil fork of Robinhood Chain (M4 acceptance):
 *   connect → sign in → create vault → deposit → follow → pause → revoke bot → withdraw (while paused + revoked).
 *
 *   pnpm --filter web e2e:fork            # starts a FRESH fork, deploys, runs worker + API + web, runs Playwright
 *   E2E_KEEP=1 pnpm --filter web e2e:fork # same, but keeps everything running for manual testing (Ctrl+C to stop)
 *
 * Env: UPSTREAM_RPC_URL (fork source, default https://robinhood.drpc.org), FORK_PORT (8546), WEB_PORT (3005).
 * Uses anvil's public dev keys only. Never touches the normal dev database: a fresh Postgres schema per run.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, '../..');
const FORK_PORT = Number(process.env.FORK_PORT ?? 8546);
const WEB_PORT = Number(process.env.WEB_PORT ?? 3005);
const RPC = `http://127.0.0.1:${FORK_PORT}`;
const UPSTREAM = process.env.UPSTREAM_RPC_URL ?? 'https://robinhood.drpc.org';
const KEEP = process.env.E2E_KEEP === '1';
// anvil dev account #5: a fresh wallet with no vault
const WALLET_KEY = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba';
process.env.FORK_RPC_URL = RPC; // read by scripts/lib/fork-setup at import time

const procs: ChildProcess[] = [];
function start(name: string, cmd: string, args: string[], env: Record<string, string>, cwd: string) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (d: Buffer) => process.env.E2E_VERBOSE && process.stdout.write(`[${name}] ${d}`);
  p.stdout!.on('data', out);
  p.stderr!.on('data', (d: Buffer) => {
    const s = d.toString();
    if (process.env.E2E_VERBOSE || /error/i.test(s)) process.stderr.write(`[${name}] ${s}`);
  });
  procs.push(p);
  return p;
}
function stopAll() {
  for (const p of procs.reverse()) if (p.exitCode === null) p.kill('SIGTERM');
}
process.on('exit', stopAll);
process.on('SIGINT', () => {
  stopAll();
  process.exit(130);
});

async function until(fn: () => Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  const t0 = Date.now();
  // 1. fresh fork
  const anvilBin = [resolve(homedir(), '.foundry/bin/anvil'), 'anvil'].find((p) => p === 'anvil' || existsSync(p))!;
  start(
    'anvil',
    anvilBin,
    // `--chain-id` first: this private fork must not match a global `pkill -f "anvil --fork-url"`
    [
      '--chain-id', '4663',
      '--fork-url', UPSTREAM,
      '--port', String(FORK_PORT),
      '--host', '127.0.0.1',
      '--block-time', '1',
      '--fork-retry-backoff', '3000',
      '--retries', '30',
      '--compute-units-per-second', '25',
    ],
    {},
    webDir,
  );
  await until(
    async () =>
      (
        await fetch(RPC, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }),
        })
      ).ok,
    60_000,
    'anvil',
  );
  console.log(`→ fresh fork of ${UPSTREAM} on ${RPC}`);

  // 2. deploy registry + factory, register a strategy, fund the fresh test wallet with USDG
  const fork = await import('../../../../scripts/lib/fork-setup.js');
  const { createWalletClient, http, parseUnits, toHex } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');
  const { registry, factory, strategyId, startBlock, prisma, usdg, weth } = await fork.setupFork();
  const wallet = privateKeyToAccount(WALLET_KEY).address;
  const uniFactory = (await fork.pub.readContract({
    address: (await import('../../../../packages/shared/src/index.js')).ROUTER_ADDRESS,
    abi: [{ type: 'function', name: 'factory', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }],
    functionName: 'factory',
  })) as `0x${string}`;
  const pool = (await fork.pub.readContract({
    address: uniFactory,
    abi: [
      {
        type: 'function',
        name: 'getPool',
        stateMutability: 'view',
        inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }],
        outputs: [{ type: 'address' }],
      },
    ],
    functionName: 'getPool',
    args: [weth.address, usdg.address, weth.feeTier],
  })) as `0x${string}`;
  await fork.pub.request({ method: 'anvil_impersonateAccount' as never, params: [pool] as never });
  await fork.pub.request({ method: 'anvil_setBalance' as never, params: [pool, toHex(10n ** 18n)] as never });
  const wp = createWalletClient({ chain: fork.chain, transport: http(RPC), account: pool });
  const fund = await wp.writeContract({
    address: usdg.address,
    abi: fork.erc20,
    functionName: 'transfer',
    args: [wallet, parseUnits('500', 6)],
    chain: fork.chain,
    account: pool,
  });
  await fork.pub.waitForTransactionReceipt({ hash: fund });
  await fork.pub.request({ method: 'anvil_stopImpersonatingAccount' as never, params: [pool] as never });
  console.log(`→ test wallet ${wallet} funded with 500 USDG (no vault yet)`);

  // 3. worker (indexer) + API against this deployment
  const appDomain = `localhost:${WEB_PORT}`;
  const env = {
    DATABASE_URL: fork.DB,
    REDIS_URL: fork.REDIS,
    RPC_URL: RPC,
    PUBLIC_RPC_URL: RPC,
    REGISTRY_ADDRESS: registry,
    FACTORY_ADDRESS: factory,
    SIGNER_ADDRESS_TEMPLATE: fork.acct(fork.KEYS.signer),
    START_BLOCK: (startBlock - 5n).toString(),
    CONFIRMATIONS: '0',
    INDEXER_POLL_MS: '500',
    API_PORT: String(fork.API_PORT),
    APP_DOMAIN: appDomain,
    RUN_PRICES: '0',
    RUN_STATS: '0',
    RUN_RUNNER: '0',
    RUN_EXECUTOR: '0',
    RUN_MISSED: '0',
    LOG_LEVEL: 'warn',
  };
  start('worker', 'pnpm', ['exec', 'tsx', 'apps/worker/src/index.ts'], { ...env, NODE_ENV: 'development' }, fork.root);
  // NODE_ENV=test only lifts the API rate limit (all e2e traffic comes from 127.0.0.1)
  start('api', 'pnpm', ['exec', 'tsx', 'apps/api/src/index.ts'], { ...env, NODE_ENV: 'test' }, fork.root);
  await until(async () => (await fetch(`http://127.0.0.1:${fork.API_PORT}/health`)).ok, 60_000, 'api');
  await until(
    async () => (await fetch(`http://127.0.0.1:${fork.API_PORT}/strategies/${strategyId}`)).ok,
    60_000,
    'indexed strategy',
  );
  console.log(`→ worker + API on :${fork.API_PORT}, strategy ${strategyId} indexed`);

  // 4. web (isolated dev server)
  const webEnv = {
    API_INTERNAL_URL: `http://127.0.0.1:${fork.API_PORT}`,
    NEXT_PUBLIC_RPC_URL: RPC,
    APP_DOMAIN: appDomain,
    NEXT_DIST_DIR: '.next-e2e',
    NEXT_TELEMETRY_DISABLED: '1',
  };
  start('web', 'pnpm', ['exec', 'next', 'dev', '-p', String(WEB_PORT)], webEnv, webDir);
  const base = `http://localhost:${WEB_PORT}`;
  await until(async () => (await fetch(`${base}/app/vault`)).ok, 240_000, 'web');
  await fetch(`${base}/app/s/${strategyId}`); // warm up the routes the test visits
  console.log(`→ web on ${base} (${Math.round((Date.now() - t0) / 1000)} s setup)`);

  const testEnv = {
    E2E_BASE_URL: base,
    E2E_RPC_URL: RPC,
    E2E_WALLET_KEY: WALLET_KEY,
    E2E_REGISTRY: registry,
    E2E_FACTORY: factory,
    E2E_STRATEGY_ID: String(strategyId),
    E2E_USDG: usdg.address,
  };
  let code = 0;
  if (KEEP) {
    console.log('E2E_KEEP=1: everything stays up. Test wallet key (anvil #5):', WALLET_KEY);
    console.log(JSON.stringify(testEnv, null, 2));
    await new Promise(() => undefined);
  } else {
    code = await new Promise<number>((res) => {
      const pw = spawn('pnpm', ['exec', 'playwright', 'test', '-c', 'playwright.fork.config.ts'], {
        cwd: webDir,
        env: { ...process.env, ...testEnv },
        stdio: 'inherit',
      });
      pw.on('exit', (c) => res(c ?? 1));
    });
  }

  stopAll();
  await new Promise((r) => setTimeout(r, 1500));
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${fork.E2E_SCHEMA}" CASCADE`); // this run's own schema only
  await prisma.$disconnect();
  console.log(code === 0 ? `✓ fork e2e passed in ${Math.round((Date.now() - t0) / 1000)} s` : '✗ fork e2e failed');
  process.exit(code);
}

main().catch((e) => {
  console.error(e);
  stopAll();
  process.exit(1);
});
