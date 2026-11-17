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
import type { Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
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

type Fork = typeof import('../../../../scripts/lib/fork-setup.js');

/**
 * The free upstream RPC serves recent state only, and anvil fetches storage lazily. Run the whole happy path once from
 * the test wallet inside an evm snapshot, then revert: anvil keeps the upstream slots it fetched (balances, allowances,
 * freeze flags, feeds, Multicall3) while the chain state returns to "fresh wallet, no vault".
 */
async function warmUp(fork: Fork, wallet: `0x${string}`, factory: `0x${string}`, strategyId: bigint) {
  const { createWalletClient, http, parseUnits } = await import('viem');
  const abi = await import('../../../../packages/shared/src/abi/index.js');
  const shared = await import('../../../../packages/shared/src/index.js');
  const snap = (await fork.pub.request({ method: 'evm_snapshot' as never, params: [] as never })) as string;
  const w = createWalletClient({ chain: fork.chain, transport: http(RPC), account: wallet });
  const send = async (address: `0x${string}`, contractAbi: Abi, functionName: string, args: unknown[]) => {
    const hash = await w.writeContract({
      address,
      abi: contractAbi,
      functionName,
      args,
      chain: fork.chain,
      account: wallet,
    } as never);
    await fork.pub.waitForTransactionReceipt({ hash });
  };
  try {
    await fork.pub.getCode({ address: '0xcA11bde05977b3631167028862bE2a173976CA11' });
    await send(factory, abi.vaultFactoryAbi as Abi, 'createVault', [100, 500n * 10n ** 18n, 1500]);
    const vault = (await fork.pub.readContract({
      address: factory,
      abi: abi.vaultFactoryAbi,
      functionName: 'vaultOf',
      args: [wallet],
    })) as `0x${string}`;
    const keep = new Set(['USDG', 'WETH', 'cbBTC', 'NVDA', 'AAPL', 'SPY', 'QQQ']); // the UI's default selection
    for (const t of shared.TOKENS)
      if (!keep.has(t.symbol))
        await send(vault, abi.receiptsVaultAbi as Abi, 'setTokenEnabled', [t.address, false]);
    const usdg = shared.baseToken().address;
    await send(usdg, abi.erc20Abi as Abi, 'approve', [vault, parseUnits('100', 6)]);
    await send(vault, abi.receiptsVaultAbi as Abi, 'deposit', [parseUnits('100', 6)]);
    await send(vault, abi.receiptsVaultAbi as Abi, 'follow', [strategyId, 60n * 10n ** 18n]);
    await send(vault, abi.receiptsVaultAbi as Abi, 'setPaused', [true]);
    await send(vault, abi.receiptsVaultAbi as Abi, 'setOperator', [
      '0x0000000000000000000000000000000000000000',
    ]);
    await send(vault, abi.receiptsVaultAbi as Abi, 'withdraw', [usdg, parseUnits('40', 6), wallet]);
    await Promise.all(
      shared.TOKENS.flatMap((t) => [
        fork.pub
          .readContract({ address: t.address, abi: abi.erc20Abi, functionName: 'balanceOf', args: [vault] })
          .catch(() => 0n),
        fork.pub
          .readContract({
            address: vault,
            abi: abi.receiptsVaultAbi,
            functionName: 'priceUsd',
            args: [t.address],
          })
          .catch(() => 0n),
      ]),
    );
  } finally {
    await fork.pub.request({ method: 'evm_revert' as never, params: [snap] as never });
  }
}

const anvilBin = [resolve(homedir(), '.foundry/bin/anvil'), 'anvil'].find(
  (p) => p === 'anvil' || existsSync(p),
)!;

function startAnvil(): ChildProcess {
  // `--chain-id` first: this private fork must not match a global `pkill -f "anvil --fork-url"`
  return start(
    'anvil',
    anvilBin,
    [
      '--chain-id',
      '4663',
      '--fork-url',
      UPSTREAM,
      '--port',
      String(FORK_PORT),
      '--host',
      '127.0.0.1',
      '--block-time',
      '1',
      '--fork-retry-backoff',
      '1000',
      '--retries',
      '10',
    ],
    {},
    webDir,
  );
}

async function dropSchema(url: string, schema: string) {
  const { PrismaClient } = await import('@prisma/client');
  const p = new PrismaClient({ datasources: { db: { url } } });
  await p.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined); // this run's own schema
  await p.$disconnect();
}

/**
 * Touches, right after the fork starts, every upstream account / storage slot the run will need, so anvil caches them
 * while the upstream still serves the fork block. Contract and vault addresses are deterministic (nonces).
 */
async function prefetch(fork: Fork, wallet: `0x${string}`) {
  const { getContractAddress, encodeFunctionData, parseAbi } = await import('viem');
  const shared = await import('../../../../packages/shared/src/index.js');
  const abi = await import('../../../../packages/shared/src/abi/index.js');
  const pub = fork.pub;
  const deployer = fork.acct(fork.KEYS.deployer);
  const owner = fork.acct(fork.KEYS.owner);
  const n = await pub.getTransactionCount({ address: deployer });
  const registry = getContractAddress({ from: deployer, nonce: BigInt(n) });
  const factory = getContractAddress({ from: deployer, nonce: BigInt(n + 1) });
  const ownerVault = getContractAddress({ from: factory, nonce: 1n });
  const testVault = getContractAddress({ from: factory, nonce: 2n });
  const people = [deployer, owner, wallet, ownerVault, testVault, registry, factory];
  const keys = Object.values(fork.KEYS).map((k) => fork.acct(k));
  const uni = parseAbi([
    'function factory() view returns (address)',
    'function getPool(address,address,uint24) view returns (address)',
  ]);
  const uniFactory = await pub.readContract({
    address: shared.ROUTER_ADDRESS,
    abi: uni,
    functionName: 'factory',
  });
  const usdg = shared.baseToken();
  const weth = shared.tokenBySymbol('WETH')!;
  const pool = await pub.readContract({
    address: uniFactory,
    abi: uni,
    functionName: 'getPool',
    args: [weth.address, usdg.address, weth.feeTier],
  });
  const ignore = () => undefined;
  const jobs: Promise<unknown>[] = [
    pub.getCode({ address: '0xcA11bde05977b3631167028862bE2a173976CA11' }),
    pub.getCode({ address: '0x0000000000000000000000000000000000000064' }), // ArbSys (L2Block)
    ...[...people, ...keys, pool].map((a) => pub.getBalance({ address: a })),
  ];
  for (const t of shared.TOKENS) {
    jobs.push(pub.readContract({ address: t.address, abi: abi.erc20Abi, functionName: 'decimals' }));
    jobs.push(
      pub.readContract({ address: t.feed, abi: abi.aggregatorV3Abi, functionName: 'latestRoundData' }),
    );
    jobs.push(pub.readContract({ address: t.feed, abi: abi.aggregatorV3Abi, functionName: 'decimals' }));
    for (const who of [...people, pool])
      jobs.push(
        pub.readContract({ address: t.address, abi: abi.erc20Abi, functionName: 'balanceOf', args: [who] }),
      );
  }
  for (const [o, s] of [
    [owner, ownerVault],
    [wallet, testVault],
  ] as const)
    jobs.push(
      pub.readContract({ address: usdg.address, abi: abi.erc20Abi, functionName: 'allowance', args: [o, s] }),
    );
  // transfer paths (pause / freeze flags of every party) via eth_call from the pool and from each holder
  for (const to of [owner, wallet, ownerVault, testVault]) {
    jobs.push(
      pub
        .call({
          account: pool,
          to: usdg.address,
          data: encodeFunctionData({ abi: abi.erc20Abi, functionName: 'transfer', args: [to, 1n] }),
        })
        .catch(ignore),
    );
  }
  for (const [from, to] of [
    [owner, ownerVault],
    [wallet, testVault],
    [ownerVault, owner],
    [testVault, wallet],
  ] as const) {
    jobs.push(
      pub
        .call({
          account: from,
          to: usdg.address,
          data: encodeFunctionData({ abi: abi.erc20Abi, functionName: 'approve', args: [to, 1n] }),
        })
        .catch(ignore),
    );
  }
  await Promise.all(jobs.map((j) => j.catch(ignore)));
}

async function prepareChain(fork: Fork, wallet: `0x${string}`) {
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
  const t = Date.now();
  await prefetch(fork, wallet);
  console.log(`→ fresh fork of ${UPSTREAM} on ${RPC}, upstream state prefetched in ${Date.now() - t} ms`);

  const { createWalletClient, http, parseUnits, toHex, parseAbi } = await import('viem');
  const setup = await fork.setupFork();
  const uni = parseAbi([
    'function factory() view returns (address)',
    'function getPool(address,address,uint24) view returns (address)',
  ]);
  const shared = await import('../../../../packages/shared/src/index.js');
  const uniFactory = await fork.pub.readContract({
    address: shared.ROUTER_ADDRESS,
    abi: uni,
    functionName: 'factory',
  });
  const pool = await fork.pub.readContract({
    address: uniFactory,
    abi: uni,
    functionName: 'getPool',
    args: [setup.weth.address, setup.usdg.address, setup.weth.feeTier],
  });
  await fork.pub.request({ method: 'anvil_impersonateAccount' as never, params: [pool] as never });
  await fork.pub.request({ method: 'anvil_setBalance' as never, params: [pool, toHex(10n ** 18n)] as never });
  const wp = createWalletClient({ chain: fork.chain, transport: http(RPC), account: pool });
  const fund = await wp.writeContract({
    address: setup.usdg.address,
    abi: fork.erc20,
    functionName: 'transfer',
    args: [wallet, parseUnits('500', 6)],
    chain: fork.chain,
    account: pool,
  });
  await fork.pub.waitForTransactionReceipt({ hash: fund });
  await fork.pub.request({ method: 'anvil_stopImpersonatingAccount' as never, params: [pool] as never });
  console.log(`→ test wallet ${wallet} funded with 500 USDG (no vault yet)`);
  await warmUp(fork, wallet, setup.factory, setup.strategyId);
  console.log('→ happy path pre-flighted inside an evm snapshot (anvil caches the upstream state it needs)');
  return setup;
}

async function main() {
  const t0 = Date.now();
  // 0. web dev server first: it compiles while the fork and contracts are set up (pages read the API at request time)
  const appDomain = `localhost:${WEB_PORT}`;
  start(
    'web',
    'pnpm',
    ['exec', 'next', 'dev', '-p', String(WEB_PORT)],
    {
      API_INTERNAL_URL: `http://127.0.0.1:4100`,
      NEXT_PUBLIC_RPC_URL: RPC,
      APP_DOMAIN: appDomain,
      NEXT_DIST_DIR: '.next-e2e',
      NEXT_TELEMETRY_DISABLED: '1',
    },
    webDir,
  );
  void fetch(`http://localhost:${WEB_PORT}/app/vault`).catch(() => undefined);

  // 1–2. fresh fork → prefetch upstream state → deploy → fund → pre-flight. The free upstream only serves the last
  // ~100–200 blocks, so a fork goes stale for uncached slots within a minute; retry with a new fork if that bites.
  const fork = await import('../../../../scripts/lib/fork-setup.js');
  const wallet = privateKeyToAccount(WALLET_KEY).address;
  let ready: Awaited<ReturnType<typeof prepareChain>> | null = null;
  for (let attempt = 1; attempt <= 4 && !ready; attempt++) {
    const anvil = startAnvil();
    try {
      ready = await prepareChain(fork, wallet);
    } catch (e) {
      const stale = /Unknown state|failed to get (account|storage)/i.test(String(e));
      if (!stale || attempt === 4) throw e;
      console.log(`→ upstream state expired during setup (attempt ${attempt}); retrying on a fresh fork`);
      anvil.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 1500));
      await dropSchema(fork.DB, fork.E2E_SCHEMA);
    }
  }
  const { registry, factory, strategyId, startBlock, prisma, usdg } = ready!;

  // 3. worker (indexer) + API against this deployment
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
  start(
    'worker',
    'pnpm',
    ['exec', 'tsx', 'apps/worker/src/index.ts'],
    { ...env, NODE_ENV: 'development' },
    fork.root,
  );
  // NODE_ENV=test only lifts the API rate limit (all e2e traffic comes from 127.0.0.1)
  start('api', 'pnpm', ['exec', 'tsx', 'apps/api/src/index.ts'], { ...env, NODE_ENV: 'test' }, fork.root);
  await until(async () => (await fetch(`http://127.0.0.1:${fork.API_PORT}/health`)).ok, 60_000, 'api');
  await until(
    async () => (await fetch(`http://127.0.0.1:${fork.API_PORT}/strategies/${strategyId}`)).ok,
    60_000,
    'indexed strategy',
  );
  console.log(`→ worker + API on :${fork.API_PORT}, strategy ${strategyId} indexed`);

  // 4. web is already compiling (started first); wait for it and warm the routes the test visits
  const base = `http://localhost:${WEB_PORT}`;
  await until(async () => (await fetch(`${base}/app/vault`)).ok, 240_000, 'web');
  for (const route of ['/app/vault', `/app/s/${strategyId}`]) await fetch(`${base}${route}`);
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
  console.log(
    code === 0 ? `✓ fork e2e passed in ${Math.round((Date.now() - t0) / 1000)} s` : '✗ fork e2e failed',
  );
  process.exit(code);
}

main().catch((e) => {
  console.error(e);
  stopAll();
  process.exit(1);
});
