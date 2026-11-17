/**
 * Re-verifies every address in config/robinhood.json on-chain (HANDOFF §6) — run before any mainnet step.
 *
 *   RPC_URL=https://... pnpm check-config
 *
 * Checks: chain id; router is SwapRouter02 with WETH9 = config WETH; every token's decimals; every feed answers > 0,
 * reports 8 decimals and the expected description, and how stale it is; every non-base token has a Uniswap V3 pool
 * vs USDG at the pinned fee tier with liquidity and USDG in it. Exits 1 on any hard failure.
 */
import { config as loadDotenv } from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, getAddress, type Address } from 'viem';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadDotenv({ path: resolve(root, '.env') });
const cfg = JSON.parse(readFileSync(resolve(root, 'config/robinhood.json'), 'utf8')) as {
  chainId: number;
  router: string;
  stable: string;
  tokens: {
    symbol: string;
    address: string;
    decimals: number;
    feed: string;
    feedDescription: string;
    maxStaleness: number;
    feeTier?: number;
  }[];
};
const rpc = process.env.CHECK_RPC_URL ?? process.env.RPC_URL ?? 'https://robinhood.drpc.org';
const client = createPublicClient({
  transport: http(rpc, { retryCount: 6, retryDelay: 1500, timeout: 30_000 }),
});

const fn = (name: string, inputs: string[], outputs: string[]) =>
  ({
    type: 'function',
    name,
    stateMutability: 'view',
    inputs: inputs.map((type) => ({ type })),
    outputs: outputs.map((type) => ({ type })),
  }) as const;
const ABI = {
  decimals: [fn('decimals', [], ['uint8'])],
  symbol: [fn('symbol', [], ['string'])],
  balanceOf: [fn('balanceOf', ['address'], ['uint256'])],
  description: [fn('description', [], ['string'])],
  latest: [fn('latestRoundData', [], ['uint80', 'int256', 'uint256', 'uint256', 'uint80'])],
  factory: [fn('factory', [], ['address'])],
  weth9: [fn('WETH9', [], ['address'])],
  getPool: [fn('getPool', ['address', 'address', 'uint24'], ['address'])],
  liquidity: [fn('liquidity', [], ['uint128'])],
};

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.log(`  ✗ ${msg}`);
};
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const warn = (msg: string) => console.log(`  ! ${msg}`);
const read = <T>(address: string, abi: readonly unknown[], functionName: string, args: unknown[] = []) =>
  client.readContract({
    address: address as Address,
    abi: abi as never,
    functionName: functionName as never,
    args: args as never,
  }) as Promise<T>;

async function main() {
  console.log(`RPC ${rpc.replace(/\/\/([^/]+)\/.+/, '//$1/…')}`);
  const chainId = await client.getChainId();
  chainId === cfg.chainId ? ok(`chain id ${chainId}`) : fail(`chain id ${chainId} ≠ ${cfg.chainId}`);

  const base = cfg.tokens.find((t) => t.symbol === cfg.stable)!;
  const weth = cfg.tokens.find((t) => t.symbol === 'WETH');
  console.log(`\nRouter ${cfg.router}`);
  const uniFactory = await read<Address>(cfg.router, ABI.factory, 'factory').catch(() => null);
  uniFactory ? ok(`factory() = ${uniFactory}`) : fail('router has no factory() — not SwapRouter02?');
  const weth9 = await read<Address>(cfg.router, ABI.weth9, 'WETH9').catch(() => null);
  if (weth)
    weth9 && getAddress(weth9) === getAddress(weth.address)
      ? ok(`WETH9() = config WETH`)
      : fail(`WETH9() ${weth9} ≠ config WETH ${weth.address}`);

  const now = BigInt(Math.floor(Date.now() / 1000));
  for (const t of cfg.tokens) {
    console.log(`\n${t.symbol}  ${t.address}`);
    try {
      const code = await client.getCode({ address: t.address as Address });
      if (!code || code === '0x') fail('token has no code');
      const dec = await read<number>(t.address, ABI.decimals, 'decimals');
      dec === t.decimals ? ok(`decimals ${dec}`) : fail(`decimals ${dec} ≠ config ${t.decimals}`);
      const sym = await read<string>(t.address, ABI.symbol, 'symbol').catch(() => '?');
      ok(`symbol() "${sym}"`);
    } catch (e) {
      fail(`token read failed: ${String(e).slice(0, 120)}`);
    }
    try {
      const [, answer, , updatedAt] = await read<[bigint, bigint, bigint, bigint, bigint]>(
        t.feed,
        ABI.latest,
        'latestRoundData',
      );
      answer > 0n ? ok(`feed answer ${answer}`) : fail(`feed answer ${answer} ≤ 0`);
      const fd = await read<number>(t.feed, ABI.decimals, 'decimals');
      fd === 8 ? ok('feed decimals 8') : warn(`feed decimals ${fd} (vault handles any ≤ 36)`);
      const desc = await read<string>(t.feed, ABI.description, 'description');
      desc === t.feedDescription
        ? ok(`feed "${desc}"`)
        : fail(`feed description "${desc}" ≠ "${t.feedDescription}"`);
      const age = Number(now - updatedAt);
      age <= t.maxStaleness
        ? ok(`fresh (${Math.round(age / 60)} min old, limit ${Math.round(t.maxStaleness / 3600)} h)`)
        : warn(
            `stale now: ${Math.round(age / 3600)} h old (limit ${Math.round(t.maxStaleness / 3600)} h) — expected for stock feeds on weekends`,
          );
    } catch (e) {
      fail(`feed read failed: ${String(e).slice(0, 120)}`);
    }
    if (t.feeTier && uniFactory) {
      try {
        const pool = await read<Address>(uniFactory, ABI.getPool, 'getPool', [
          t.address,
          base.address,
          t.feeTier,
        ]);
        if (!pool || /^0x0{40}$/i.test(pool)) {
          fail(`no Uniswap V3 pool vs ${base.symbol} at fee ${t.feeTier}`);
        } else {
          const liq = await read<bigint>(pool, ABI.liquidity, 'liquidity');
          const usd = await read<bigint>(base.address, ABI.balanceOf, 'balanceOf', [pool]);
          liq > 0n
            ? ok(`pool ${pool} (fee ${t.feeTier}) liquidity ${liq}`)
            : fail(`pool ${pool} has zero liquidity`);
          const usdWhole = Number(usd / 10n ** BigInt(base.decimals));
          usdWhole > 0
            ? ok(`pool holds ${usdWhole.toLocaleString('en-US')} ${base.symbol}`)
            : fail('pool holds no USDG');
          if (usdWhole < 20_000) warn('shallow pool: keep trade sizes small');
        }
      } catch (e) {
        fail(`pool check failed: ${String(e).slice(0, 120)}`);
      }
    }
  }
  console.log(
    failures
      ? `\n✗ ${failures} problem(s). Fix config/robinhood.json before deploying.`
      : '\n✓ config/robinhood.json matches the chain.',
  );
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
