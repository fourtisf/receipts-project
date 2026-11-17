/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════╗
 * ║  DEV ONLY — inserts SAMPLE strategies, commits, executions, equity points and vaults  ║
 * ║  into the LOCAL development database so the web screens can be rendered and checked.  ║
 * ║  None of this is real: hashes, txs and numbers are generated. Never run it against    ║
 * ║  staging or production. It refuses to run when NODE_ENV=production or when           ║
 * ║  DATABASE_URL does not point at localhost.                                            ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════╝
 *
 *   pnpm tsx scripts/seed-dev.ts            # aborts if the dev DB already has strategies
 *   pnpm tsx scripts/seed-dev.ts --reset    # wipes the receipt/strategy/vault tables of the DEV DB first
 *
 * Revealed sample receipts use a real `hashSignal` preimage against REGISTRY_ADDRESS (default
 * 0x000000000000000000000000000000000000dEaD). Start the API with the same REGISTRY_ADDRESS to see
 * "Reveal matches the commit":   REGISTRY_ADDRESS=0x000000000000000000000000000000000000dEaD pnpm --filter api dev
 */
import { config as loadDotenv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  hashSignal,
  modelHashOf,
  tokenBySymbol,
  baseToken,
  slugify,
  ZERO_HASH,
} from '../packages/shared/src/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadDotenv({ path: resolve(root, '.env') });

if (process.env.NODE_ENV === 'production') {
  console.error('seed-dev: refusing to run with NODE_ENV=production. This script inserts SAMPLE data.');
  process.exit(1);
}
const DB_URL = process.env.DATABASE_URL ?? '';
if (!/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(DB_URL)) {
  console.error('seed-dev: DATABASE_URL must point at a local Postgres (127.0.0.1/localhost). Aborting.');
  process.exit(1);
}

const REGISTRY = (process.env.REGISTRY_ADDRESS ||
  '0x000000000000000000000000000000000000dEaD') as `0x${string}`;
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 4663);
const reset = process.argv.includes('--reset');
const prisma = new PrismaClient();

// ───────────────────────── deterministic randomness

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r0 = rng(20261117);
const hex = (n: number, r = r0) => {
  let s = '';
  for (let i = 0; i < n; i++) s += '0123456789abcdef'[Math.floor(r() * 16)];
  return s;
};
const h32 = (r = r0) => `0x${hex(64, r)}` as `0x${string}`;
const addr = (r = r0) => `0x${hex(40, r)}`;

// ───────────────────────── sample universe

const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Robinhood Chain L2 blocks ≈ 4/s; anchor "now" near the dev fork head. */
const HEAD_BLOCK = 116_500_000;
const blockAt = (t: number) => BigInt(HEAD_BLOCK - Math.floor((NOW - t) / 250));

const PRICES: Record<string, number> = {
  NVDA: 141.88,
  AAPL: 229.4,
  MSFT: 418.2,
  META: 572.1,
  TSLA: 251.3,
  GOOGL: 176.2,
  AMZN: 201.5,
  COIN: 206.75,
  SPY: 588.9,
  QQQ: 507.4,
  WETH: 3412.5,
  cbBTC: 91840,
};

const HOUSE_CREATOR = '0x7a1c0de5e1f0a8b3c4d5e6f708192a3b4c5d6e7f';
const HOUSE_SIGNER = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';

interface SampleStrategy {
  id: number;
  name: string;
  kind: 'HOUSE' | 'TEMPLATE' | 'AI';
  category: 'CRYPTO' | 'STOCK' | 'MIXED';
  template: string;
  assets: string[];
  ret: number; // target 30d return (fraction)
  hold: number;
  vol: number;
  share: number; // bps
  commits: number;
  missed: number[]; // nonces that missed their reveal
  pendingLast: boolean;
  description: string;
  modelId?: string;
  params: Record<string, number | string | string[]>;
}

const STRATS: SampleStrategy[] = [
  {
    id: 1,
    name: 'Mag7 Rebalance',
    kind: 'HOUSE',
    category: 'STOCK',
    template: 'rebalance',
    assets: ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA'],
    ret: 0.068,
    hold: 0.049,
    vol: 0.007,
    share: 1000,
    commits: 41,
    missed: [],
    pendingLast: true,
    description:
      'Holds AAPL, MSFT, NVDA, GOOGL, AMZN, META and TSLA tokens in equal weight and rebalances every Monday at the US open.',
    params: { schedule: 'weekly', driftPct: 5 },
  },
  {
    id: 2,
    name: 'ETH Trend 4h',
    kind: 'TEMPLATE',
    category: 'CRYPTO',
    template: 'momentum',
    assets: ['WETH'],
    ret: 0.114,
    hold: 0.072,
    vol: 0.016,
    share: 1500,
    commits: 52,
    missed: [],
    pendingLast: false,
    description:
      'Buys ETH when it breaks its 3-day high while above the 50-period average. Exits on a 6% trailing stop.',
    params: { windowHours: 72, trailingStopPct: 6, sizePct: 100 },
  },
  {
    id: 3,
    name: 'News Desk',
    kind: 'AI',
    category: 'STOCK',
    template: 'ai_news',
    assets: ['NVDA', 'TSLA', 'COIN'],
    ret: 0.089,
    hold: 0.033,
    vol: 0.013,
    share: 2000,
    commits: 37,
    missed: [11],
    pendingLast: true,
    modelId: 'Llama 3.1 70B, open weights',
    description:
      'Reads earnings headlines and filings every hour and trades three stock tokens. Each signal commits the model name and a hash of the exact prompt.',
    params: { schedule: 'hourly' },
  },
  {
    id: 4,
    name: 'SPY / QQQ Rotation',
    kind: 'HOUSE',
    category: 'STOCK',
    template: 'rotation',
    assets: ['SPY', 'QQQ'],
    ret: 0.041,
    hold: 0.038,
    vol: 0.005,
    share: 1000,
    commits: 26,
    missed: [],
    pendingLast: false,
    description: 'Holds whichever of SPY and QQQ has the stronger 20-day trend, checked every Friday close.',
    params: { lookbackDays: 20, schedule: 'weekly' },
  },
  {
    id: 5,
    name: 'BTC Snapback',
    kind: 'TEMPLATE',
    category: 'CRYPTO',
    template: 'meanrev',
    assets: ['cbBTC'],
    ret: 0.032,
    hold: 0.056,
    vol: 0.011,
    share: 1000,
    commits: 29,
    missed: [],
    pendingLast: false,
    description:
      'Buys when BTC sits more than 2 standard deviations under its 48-hour average and sells back at the average.',
    params: { maWindowHours: 48, entrySigma: 2, stopPct: 8, sizePct: 50 },
  },
  {
    id: 6,
    name: 'Dip in Uptrend',
    kind: 'TEMPLATE',
    category: 'CRYPTO',
    template: 'dip',
    assets: ['WETH', 'cbBTC'],
    ret: -0.026,
    hold: 0.061,
    vol: 0.018,
    share: 2500,
    commits: 33,
    missed: [4, 17, 30],
    pendingLast: false,
    description:
      'Buys sharp dips while the 200-period trend points up. It is losing this month and stays listed like every other strategy.',
    params: { trendHours: 200, dipWindowHours: 24, depthSigma: 2, trailingStopPct: 7, sizePct: 50 },
  },
];

/** Random walk from 0 that ends exactly at `target` (fraction), as an index series starting at 100. */
function curve(n: number, target: number, vol: number, r: () => number): number[] {
  const v = [0];
  for (let i = 1; i < n; i++) v.push(v[i - 1]! + (r() - 0.5) * vol * 0.45);
  const end = v[n - 1]!;
  return v.map((x, i) => 100 * (1 + x - (end * i) / (n - 1) + (target * i) / (n - 1)));
}

function maxDrawdown(series: number[]): number {
  let peak = -Infinity;
  let dd = 0;
  for (const x of series) {
    peak = Math.max(peak, x);
    dd = Math.min(dd, (x - peak) / peak);
  }
  return dd;
}

const dec = (x: number | string) => new Prisma.Decimal(x);
/** integer token amount = qty × 10^decimals, exact enough for sample data without float overflow. */
const units = (qty: number, decimals: number) =>
  decimals >= 6
    ? (BigInt(Math.round(qty * 1e6)) * 10n ** BigInt(decimals - 6)).toString()
    : BigInt(Math.round(qty * 10 ** decimals)).toString();

async function main() {
  const existing = await prisma.strategy.count();
  if (existing > 0 && !reset) {
    console.error(
      `seed-dev: the dev DB already has ${existing} strategies. Re-run with --reset to wipe and reseed.`,
    );
    process.exit(1);
  }
  if (reset) {
    // DEV DB only (guarded above). Order respects foreign keys.
    await prisma.$transaction([
      prisma.execution.deleteMany(),
      prisma.aiArtifact.deleteMany(),
      prisma.vaultEvent.deleteMany(),
      prisma.vault.deleteMany(),
      prisma.commit.deleteMany(),
      prisma.equityPoint.deleteMany(),
      prisma.strategy.deleteMany(),
      prisma.globalStat.deleteMany(),
    ]);
  }
  if ((await prisma.commit.count()) === 0) {
    // sample receipt numbers in the same range as the prototype (DEV DB only)
    await prisma.$executeRawUnsafe(`ALTER SEQUENCE "Commit_receiptNo_seq" RESTART WITH 48100`);
  }

  const usdg = baseToken();

  // ── vaults (two public house vaults + a few follower vaults)
  interface SampleVault {
    address: string;
    owner: string;
    following: number;
    nav: number;
    peak: number;
    limit: number;
    slip: number;
    dd: number;
    house: boolean;
    paused?: boolean;
  }
  const vaults: SampleVault[] = [
    {
      address: addr(),
      owner: addr(),
      following: 1,
      nav: 25_412.37,
      peak: 25_980.1,
      limit: 5000,
      slip: 100,
      dd: 1500,
      house: true,
    },
    {
      address: addr(),
      owner: addr(),
      following: 4,
      nav: 18_204.9,
      peak: 18_310.44,
      limit: 4000,
      slip: 80,
      dd: 1200,
      house: true,
    },
    // anvil dev account #0, so connecting the well-known dev wallet shows a vault
    {
      address: addr(),
      owner: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      following: 2,
      nav: 2_480,
      peak: 2_611.5,
      limit: 500,
      slip: 100,
      dd: 1500,
      house: false,
    },
    {
      address: addr(),
      owner: addr(),
      following: 2,
      nav: 9_120.55,
      peak: 9_400,
      limit: 1500,
      slip: 150,
      dd: 2000,
      house: false,
    },
    {
      address: addr(),
      owner: addr(),
      following: 3,
      nav: 4_310.2,
      peak: 4_310.2,
      limit: 1000,
      slip: 100,
      dd: 1500,
      house: false,
    },
    {
      address: addr(),
      owner: addr(),
      following: 3,
      nav: 1_005.75,
      peak: 1_120,
      limit: 300,
      slip: 200,
      dd: 2500,
      house: false,
      paused: true,
    },
    {
      address: addr(),
      owner: addr(),
      following: 6,
      nav: 640.1,
      peak: 712.3,
      limit: 200,
      slip: 150,
      dd: 2000,
      house: false,
    },
  ];

  // ── strategies + equity
  for (const s of STRATS) {
    const r = rng(s.id * 7919);
    const n = 30 * 24 + 1;
    const eq = curve(n, s.ret, s.vol, r);
    const hd = curve(n, s.hold, s.vol * 1.1, rng(s.id * 104729));
    const following = vaults.filter((v) => v.following === s.id);
    const created = NOW - 45 * DAY - s.id * 3 * HOUR;
    await prisma.strategy.create({
      data: {
        id: s.id,
        slug: slugify(s.name, s.id),
        name: s.name,
        description: s.description,
        kind: s.kind,
        category: s.category,
        template: s.template,
        params: s.params,
        assets: s.assets,
        creatorAddr: s.kind === 'HOUSE' ? HOUSE_CREATOR : addr(r),
        signerAddr: HOUSE_SIGNER,
        modelId: s.modelId ?? null,
        modelHash: s.modelId ? modelHashOf(s.modelId) : null,
        creatorShareBps: s.share,
        revealWindowSec: s.template === 'ai_news' ? 7200 : 3600,
        metadataURI: `http://localhost:3000/api/metadata/${h32(r)}`,
        commitCount: s.commits,
        revealCount: s.commits - s.missed.length - (s.pendingLast ? 1 : 0),
        missedCount: s.missed.length,
        ret30d: dec((eq[n - 1]! / eq[0]! - 1).toFixed(6)),
        hold30d: dec((hd[n - 1]! / hd[0]! - 1).toFixed(6)),
        maxDrawdown30d: dec(maxDrawdown(eq).toFixed(6)),
        followers: following.length,
        aumUsd: dec(following.reduce((a, v) => a + v.nav, 0).toFixed(2)),
        registeredTx: h32(r),
        registeredAt: new Date(created),
        registeredBlock: blockAt(created),
      },
    });
    await prisma.equityPoint.createMany({
      data: eq.map((e, i) => ({
        strategyId: s.id,
        at: new Date(NOW - (n - 1 - i) * HOUR),
        equity: dec(e.toFixed(8)),
        hold: dec(hd[i]!.toFixed(8)),
      })),
    });
  }

  for (const v of vaults) {
    const created = NOW - 40 * DAY + Math.floor(r0() * 10 * DAY);
    const blk = blockAt(created);
    const strat = STRATS.find((s) => s.id === v.following)!;
    await prisma.vault.create({
      data: {
        address: v.address,
        ownerAddr: v.owner,
        createdTx: h32(),
        createdAt: new Date(created),
        createdBlock: blk,
        followingId: v.following,
        allocationUsd: dec(Math.round(v.nav * 0.9)),
        maxSlippageBps: v.slip,
        dailyLimitUsd: dec(v.limit),
        drawdownBps: v.dd,
        paused: v.paused ?? false,
        operator: HOUSE_SIGNER,
        navUsd: dec(v.nav.toFixed(2)),
        peakNavUsd: dec(v.peak.toFixed(2)),
        hwmNavUsd: dec(v.peak.toFixed(2)),
        isHouse: v.house,
      },
    });
    const ev = (i: number, type: Prisma.VaultEventCreateManyInput['type'], data: Prisma.InputJsonObject) => ({
      vaultAddr: v.address,
      type,
      data,
      txHash: h32(),
      logIndex: i,
      blockNumber: blk + BigInt(i * 40),
      at: new Date(created + i * 10_000),
    });
    const depositUsd = Math.round(v.peak);
    const events = [
      ev(0, 'CREATED', { owner: v.owner }),
      ev(1, 'LIMITS', {
        maxSlippageBps: v.slip,
        dailyLimitUsd: (BigInt(v.limit) * 10n ** 18n).toString(),
        drawdownBps: v.dd,
      }),
      ev(2, 'DEPOSITED', {
        from: v.owner,
        amount: (BigInt(depositUsd) * 10n ** BigInt(usdg.decimals)).toString(),
        valueUsd: (BigInt(depositUsd) * 10n ** 18n).toString(),
      }),
      ev(3, 'FOLLOWED', {
        strategyId: String(v.following),
        allocationUsd: (BigInt(Math.round(v.nav * 0.9)) * 10n ** 18n).toString(),
        creatorShareSnapshot: strat.share,
      }),
    ];
    if (v.paused) events.push(ev(4, 'PAUSED', { paused: true }));
    await prisma.vaultEvent.createMany({ data: events });
  }

  // ── commits (receipts), chronological across strategies so receipt numbers increase with time
  interface Row {
    s: SampleStrategy;
    nonce: number;
    at: number;
  }
  const rows: Row[] = [];
  for (const s of STRATS) {
    const r = rng(s.id * 31337);
    const span = 30 * DAY;
    for (let k = 0; k < s.commits; k++) {
      const isLast = k === s.commits - 1;
      const at =
        isLast && s.pendingLast
          ? NOW - (5 + s.id) * 60_000
          : NOW - span + (span * (k + r() * 0.6)) / s.commits;
      rows.push({ s, nonce: k, at: Math.min(at, NOW - 4 * 60_000 - s.id * 23_000) });
    }
  }
  rows.sort((a, b) => a.at - b.at);
  // nonces must increase with time inside a strategy
  for (const s of STRATS) {
    const mine = rows.filter((x) => x.s.id === s.id);
    mine.forEach((x, i) => (x.nonce = i));
  }

  let receipts = 0;
  let missedTotal = 0;
  for (const { s, nonce, at } of rows) {
    const r = rng(s.id * 1000 + nonce);
    const committedL2Block = blockAt(at);
    const isPending = s.pendingLast && nonce === s.commits - 1;
    const isMissed = s.missed.includes(nonce);
    const deadline = at + (s.template === 'ai_news' ? 7200 : 3600) * 1000;
    const asset = s.assets[Math.floor(r() * s.assets.length)]!;
    const side: 'BUY' | 'SELL' = r() > 0.45 ? 'BUY' : 'SELL';
    const token = tokenBySymbol(asset)!;
    const tokenIn = side === 'BUY' ? usdg.address.toLowerCase() : token.address.toLowerCase();
    const tokenOut = side === 'BUY' ? token.address.toLowerCase() : usdg.address.toLowerCase();
    const sizeBps = 500 + Math.floor(r() * 19) * 500;
    const oracle = PRICES[asset]! * (1 + (r() - 0.5) * 0.04);
    const promptHash = s.kind === 'AI' ? h32(r) : ZERO_HASH;
    const salt = h32(r);
    const commitTx = h32(r);
    receipts++;

    if (isPending || isMissed) {
      if (isMissed) missedTotal++;
      await prisma.commit.create({
        data: {
          strategyId: s.id,
          nonce,
          hash: h32(r),
          status: isMissed ? 'MISSED' : 'COMMITTED',
          committedAt: new Date(at),
          committedL2Block,
          commitTx,
          revealDeadline: new Date(deadline),
          missedTx: isMissed ? h32(r) : null,
          missedBlock: isMissed ? blockAt(deadline + 90_000) : null,
          matchStatus: 'PENDING',
        },
      });
      continue;
    }

    const hash = hashSignal({
      chainId: CHAIN_ID,
      registry: REGISTRY,
      strategyId: s.id,
      nonce,
      signal: {
        tokenIn: tokenIn as `0x${string}`,
        tokenOut: tokenOut as `0x${string}`,
        sizeBps,
        promptHash,
      },
      salt,
    });
    const following = vaults.filter((v) => v.following === s.id && !v.paused);
    const revealAt = at + 40_000 + Math.floor(r() * 120_000);
    const c = await prisma.commit.create({
      data: {
        strategyId: s.id,
        nonce,
        hash,
        status: 'REVEALED',
        committedAt: new Date(at),
        committedL2Block,
        commitTx,
        revealDeadline: new Date(deadline),
        revealedAt: new Date(revealAt),
        revealTx: h32(r),
        revealBlock: blockAt(revealAt),
        tokenIn,
        tokenOut,
        sizeBps,
        promptHash,
        salt,
        priceInAtCommit: dec((side === 'BUY' ? 1 : oracle).toFixed(8)),
        priceOutAtCommit: dec((side === 'BUY' ? oracle : 1).toFixed(8)),
        matchStatus: following.length > 0 ? 'MATCH' : 'NO_EXECUTION',
      },
    });
    let li = 0;
    for (const v of following) {
      const valueUsd = Math.round((80 + r() * 900) * 100) / 100;
      const slipBps = Math.floor(r() * 12);
      const fill = side === 'BUY' ? oracle * (1 + slipBps / 10_000) : oracle * (1 - slipBps / 10_000);
      const qty = valueUsd / (side === 'BUY' ? fill : oracle);
      const amountIn = side === 'BUY' ? units(valueUsd, usdg.decimals) : units(qty, token.decimals);
      const amountOut = side === 'BUY' ? units(qty, token.decimals) : units(qty * fill, usdg.decimals);
      const execAt = at + 4_000 + li * 1500;
      await prisma.execution.create({
        data: {
          vaultAddr: v.address,
          commitId: c.id,
          strategyId: s.id,
          nonce,
          tokenIn,
          tokenOut,
          amountIn: dec(amountIn),
          amountOut: dec(amountOut),
          valueUsd: dec(valueUsd.toFixed(2)),
          minOut: dec(((BigInt(amountOut) * BigInt(10_000 - v.slip)) / 10_000n).toString()),
          slippageVsOracleBps: slipBps,
          txHash: h32(r),
          logIndex: li++,
          blockNumber: blockAt(execAt) + 1n,
          executedAt: new Date(execAt),
        },
      });
    }
  }

  await prisma.globalStat.create({
    data: {
      id: 1,
      receiptsPrinted: receipts,
      strategiesLive: STRATS.length,
      missedReveals: missedTotal,
      tvlUsd: dec(vaults.reduce((a, v) => a + v.nav, 0).toFixed(2)),
    },
  });

  console.log(
    `seed-dev: inserted ${STRATS.length} SAMPLE strategies, ${receipts} receipts (${missedTotal} missed), ${vaults.length} vaults.`,
  );
  console.log(
    `seed-dev: revealed hashes use registry ${REGISTRY}; start the API with REGISTRY_ADDRESS=${REGISTRY}.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
