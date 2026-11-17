import type { Address } from 'viem';
import { Prisma, type PrismaClient, usdDec } from '@receipts/db';
import { baseToken, tokenByAddress } from '@receipts/shared';
import { receiptsVaultAbi } from '@receipts/shared/abi';
import { mapLimit, tokenDecimals, type Client } from '../chain.js';
import { computeEquity, kpis, HOUR, type PriceSeries, type Trade } from '../stats/equity.js';

const DAY = 24 * HOUR;

/**
 * WORKER.md §6: equity curves, 30-day KPIs, followers / AUM per strategy, and GlobalStat.
 * Every number comes from indexed chain data (commits, reveals, executions, Chainlink rounds, vault NAV reads).
 */
export async function runStats(prisma: PrismaClient, client: Client, now = Date.now()): Promise<void> {
  await refreshVaultNavs(prisma, client);

  const series = await loadSeries(prisma, now - 120 * DAY);
  const base = baseToken().address.toLowerCase();
  const strategies = await prisma.strategy.findMany();

  for (const s of strategies) {
    const commits = await prisma.commit.findMany({
      where: { strategyId: s.id, status: 'REVEALED' },
      include: { executions: true },
      orderBy: { committedAt: 'asc' },
    });
    const first = await prisma.commit.findFirst({
      where: { strategyId: s.id },
      orderBy: { committedAt: 'asc' },
    });
    const trades: Trade[] = [];
    for (const c of commits) {
      if (!c.tokenIn || !c.tokenOut || c.sizeBps === null) continue;
      const isBuy = c.tokenIn === base;
      const asset = tokenByAddress(isBuy ? c.tokenOut : c.tokenIn);
      if (!asset || asset.kind === 'base') continue;
      let price = Number((isBuy ? c.priceOutAtCommit : c.priceInAtCommit)?.toString() ?? '0');
      let live = false;
      if (c.executions.length > 0) {
        // volume-weighted real fill price
        const dec = await tokenDecimals(client, asset.address).catch(() => 18);
        let usd = 0;
        let qty = 0;
        for (const e of c.executions) {
          if (isBuy) {
            usd += Number(e.valueUsd.toString());
            qty += Number(e.amountOut.toString()) / 10 ** dec;
          } else {
            qty += Number(e.amountIn.toString()) / 10 ** dec;
            usd += Number(e.amountOut.toString()) / 10 ** 6; // USDG has 6 decimals (checked in tests)
          }
        }
        if (qty > 0 && usd > 0) {
          price = usd / qty;
          live = true;
        }
      }
      trades.push({
        at: c.committedAt.getTime(),
        side: isBuy ? 'BUY' : 'SELL',
        asset: asset.symbol,
        sizeBps: c.sizeBps,
        price,
        live,
      });
    }

    const following = await prisma.vault.findMany({ where: { followingId: s.id } });
    const followers = following.length;
    const aum = following.reduce((acc, v) => acc.add(v.navUsd), new Prisma.Decimal(0));

    if (!first) {
      await prisma.strategy.update({ where: { id: s.id }, data: { followers, aumUsd: aum } });
      continue;
    }
    const start = first.committedAt.getTime();
    const eq = computeEquity(trades, series, s.assets, start, now);
    const k = kpis(eq.points);
    await prisma.$transaction([
      prisma.equityPoint.deleteMany({ where: { strategyId: s.id } }),
      prisma.equityPoint.createMany({
        data: eq.points.map((p) => ({
          strategyId: s.id,
          at: new Date(p.at),
          equity: new Prisma.Decimal(p.equity.toFixed(8)),
          hold: new Prisma.Decimal(p.hold.toFixed(8)),
        })),
      }),
      prisma.strategy.update({
        where: { id: s.id },
        data: {
          ret30d: k.ret === null ? null : new Prisma.Decimal(k.ret.toFixed(6)),
          hold30d: k.hold === null ? null : new Prisma.Decimal(k.hold.toFixed(6)),
          maxDrawdown30d: k.maxDrawdown === null ? null : new Prisma.Decimal(k.maxDrawdown.toFixed(6)),
          followers,
          aumUsd: aum,
        },
      }),
    ]);
  }

  const [receiptsPrinted, strategiesLive, missedReveals, tvl] = await Promise.all([
    prisma.commit.count(),
    prisma.strategy.count({ where: { active: true } }),
    prisma.commit.count({ where: { status: 'MISSED' } }),
    prisma.vault.aggregate({ _sum: { navUsd: true } }),
  ]);
  const data = {
    receiptsPrinted,
    strategiesLive,
    missedReveals,
    tvlUsd: tvl._sum.navUsd ?? new Prisma.Decimal(0),
  };
  await prisma.globalStat.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
}

async function loadSeries(prisma: PrismaClient, since: number): Promise<PriceSeries> {
  const rows = await prisma.pricePoint.findMany({
    where: { updatedAt: { gte: new Date(since) } },
    orderBy: { updatedAt: 'asc' },
    select: { token: true, priceUsd: true, updatedAt: true },
  });
  const series: PriceSeries = new Map();
  for (const r of rows) {
    const arr = series.get(r.token) ?? [];
    arr.push({ t: r.updatedAt.getTime(), p: Number(r.priceUsd.toString()) });
    series.set(r.token, arr);
  }
  return series;
}

/** TVL source: navLenient() of every vault (lenient so weekend-stale stock feeds still value positions). */
async function refreshVaultNavs(prisma: PrismaClient, client: Client): Promise<void> {
  const vaults = await prisma.vault.findMany({ select: { address: true } });
  await mapLimit(vaults, 4, async (v) => {
    try {
      const nav = await client.readContract({
        address: v.address as Address,
        abi: receiptsVaultAbi,
        functionName: 'navLenient',
      });
      await prisma.vault.update({ where: { address: v.address }, data: { navUsd: usdDec(nav) } });
    } catch {
      /* keep the last known NAV when feeds are unavailable */
    }
  });
}
