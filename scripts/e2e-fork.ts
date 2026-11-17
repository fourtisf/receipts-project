/**
 * M2 acceptance: on an anvil fork of Robinhood Chain, a scripted commit → execute → reveal shows up as one receipt
 * via GET /receipts/:id within 10 s, served by the real worker (indexer) and API processes.
 *
 *   anvil --fork-url $RPC_URL --chain-id 4663 &            # or docker compose -f deploy/docker-compose.dev.yml up -d
 *   pnpm tsx scripts/e2e-fork.ts
 *
 * Env: FORK_RPC_URL (default http://127.0.0.1:8545), E2E_DATABASE_URL (default …/receipts_e2e), REDIS_URL.
 * Uses anvil's well-known dev keys only (no real funds anywhere).
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type Abi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  robinhoodChain,
  TOKENS,
  ROUTER_ADDRESS,
  baseToken,
  tokenBySymbol,
  hashSignal,
  metadataHash,
  canonicalJson,
} from '../packages/shared/src/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RPC = process.env.FORK_RPC_URL ?? 'http://127.0.0.1:8545';
const E2E_SCHEMA = `e2e_${Date.now()}`;
const DB_BASE = process.env.E2E_DATABASE_URL ?? 'postgresql://receipts:receipts@127.0.0.1:5432/receipts_e2e';
// a fresh schema per run (created by `migrate deploy`, dropped at the end) — never touches other data
const DB = `${DB_BASE.split('?')[0]}?schema=${E2E_SCHEMA}`;
const REDIS = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const API_PORT = 4100;
// anvil default accounts (public test keys)
const KEYS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  owner: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  operator: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  signer: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  creator: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
} as const;

const chain = robinhoodChain(RPC);
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 60_000 }) });
const wallet = (k: Hex) =>
  createWalletClient({ chain, transport: http(RPC, { timeout: 60_000 }), account: privateKeyToAccount(k) });
const acct = (k: Hex) => privateKeyToAccount(k).address;

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(resolve(root, `packages/contracts/out/${file}/${name}.json`), 'utf8'));
  return { abi: j.abi, bytecode: j.bytecode.object };
}
const registryArt = artifact('SignalRegistry.sol', 'SignalRegistry');
const factoryArt = artifact('VaultFactory.sol', 'VaultFactory');
const vaultArt = artifact('ReceiptsVault.sol', 'ReceiptsVault');
const erc20 = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

async function send(k: Hex, address: Address, abi: Abi, functionName: string, args: unknown[] = []) {
  const w = wallet(k);
  const hash = await w.writeContract({
    address,
    abi,
    functionName,
    args,
    chain,
    account: w.account!,
  } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${functionName} reverted (${hash})`);
  return r;
}

async function deploy(k: Hex, art: { abi: Abi; bytecode: Hex }, args: unknown[] = []): Promise<Address> {
  const w = wallet(k);
  const hash = await w.deployContract({
    abi: art.abi,
    bytecode: art.bytecode,
    args,
    chain,
    account: w.account!,
  } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (!r.contractAddress) throw new Error('deploy failed');
  return r.contractAddress;
}

function startProc(name: string, script: string, env: Record<string, string>): ChildProcess {
  const p = spawn('pnpm', ['exec', 'tsx', script], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout!.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write(`[${name}] ${d}`));
  p.stderr!.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  return p;
}

async function main() {
  const t0 = Date.now();
  console.log(`→ fork at ${RPC}, chain ${await pub.getChainId()}, block ${await pub.getBlockNumber()}`);

  // fresh schema for this run
  execSync(`pnpm prisma migrate deploy`, {
    cwd: root,
    env: { ...process.env, DATABASE_URL: DB },
    stdio: 'ignore',
  });

  // 1. deploy
  const usdg = baseToken();
  const weth = tokenBySymbol('WETH')!;
  const registry = await deploy(KEYS.deployer, registryArt);
  const factory = await deploy(KEYS.deployer, factoryArt, [
    ROUTER_ADDRESS,
    registry,
    usdg.address,
    acct(KEYS.deployer),
    1000,
    2000n * 10n ** 18n,
    acct(KEYS.operator),
    TOKENS.map((t) => t.address),
    TOKENS.map((t) => t.feed),
    TOKENS.map((t) => t.maxStaleness),
    TOKENS.map((t) => t.feeTier),
  ]);
  const startBlock = await pub.getBlockNumber();
  console.log(`→ registry ${registry}, factory ${factory} (${Date.now() - t0} ms)`);

  // 2. metadata + strategy (creator) + vault (owner)
  const meta = {
    schema: 'receipts.strategy/1',
    name: 'E2E Momentum',
    description: 'End-to-end test strategy.',
    template: 'momentum',
    params: { window: 48, trailingStop: 8, size: 50 },
    assets: ['WETH'],
    kind: 'TEMPLATE',
    modelId: null,
  };
  const mhash = metadataHash(meta);
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: DB } } });
  await prisma.metadataDoc.create({
    data: {
      hash: mhash,
      json: JSON.parse(canonicalJson(meta)),
      creatorAddr: acct(KEYS.creator).toLowerCase(),
    },
  });

  const regRcpt = await send(KEYS.creator, registry, registryArt.abi, 'registerStrategy', [
    acct(KEYS.signer),
    2000,
    3600,
    `0x${'0'.repeat(64)}`,
    `http://localhost:${API_PORT}/metadata/${mhash}`,
  ]);
  const strategyId = 1n;
  await send(KEYS.owner, factory, factoryArt.abi, 'createVault', [100, 2000n * 10n ** 18n, 2000]);
  const vault = (await pub.readContract({
    address: factory,
    abi: factoryArt.abi,
    functionName: 'vaultOf',
    args: [acct(KEYS.owner)],
  })) as Address;

  // fund the owner with USDG from the WETH/USDG pool (impersonated on the fork)
  const uniFactory = (await pub.readContract({
    address: ROUTER_ADDRESS,
    abi: [
      {
        type: 'function',
        name: 'factory',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ type: 'address' }],
      },
    ],
    functionName: 'factory',
  })) as Address;
  const pool = (await pub.readContract({
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
  })) as Address;
  await pub.request({ method: 'anvil_impersonateAccount' as never, params: [pool] as never });
  await pub.request({ method: 'anvil_setBalance' as never, params: [pool, toHex(10n ** 18n)] as never });
  const wp = createWalletClient({ chain, transport: http(RPC), account: pool });
  const fundHash = await wp.writeContract({
    address: usdg.address,
    abi: erc20,
    functionName: 'transfer',
    args: [acct(KEYS.owner), parseUnits('1000', 6)],
    chain,
    account: pool,
  });
  await pub.waitForTransactionReceipt({ hash: fundHash });
  await pub.request({ method: 'anvil_stopImpersonatingAccount' as never, params: [pool] as never });

  await send(KEYS.owner, usdg.address, erc20 as unknown as Abi, 'approve', [vault, parseUnits('1000', 6)]);
  await send(KEYS.owner, vault, vaultArt.abi, 'deposit', [parseUnits('1000', 6)]);
  await send(KEYS.owner, vault, vaultArt.abi, 'follow', [strategyId, 1000n * 10n ** 18n]);
  console.log(
    `→ strategy ${strategyId} registered (block ${regRcpt.blockNumber}), vault ${vault} funded and following`,
  );

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

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, what: string) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${what}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
