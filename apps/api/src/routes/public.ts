import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@receipts/db';
import {
  TOKENS,
  tokenByAddress,
  statsSchema,
  strategyListSchema,
  strategyDetailSchema,
  equitySchema,
  receiptListSchema,
  receiptDetailSchema,
  vaultSchema,
  houseVaultListSchema,
  templateListSchema,
  chainConfigSchema,
  explorerAddress,
  robinhoodConfig,
} from '@receipts/shared';
import { TEMPLATES } from '@receipts/strategies';
import {
  decStr,
  receiptDetail,
  receiptSummary,
  source,
  strategyItem,
  vaultOut,
  type CheckContext,
} from '../lib/serialize.js';
import { ApiError, send } from '../lib/http.js';

const decimalsOf = (addr: string) => tokenByAddress(addr)?.decimals ?? 18;

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, env } = app.deps;

  // ───────────────────────── stats

  app.get('/stats', async (_req, reply) => {
    const g = await prisma.globalStat.findUnique({ where: { id: 1 } });
    const out = {
      receiptsPrinted: g?.receiptsPrinted ?? (await prisma.commit.count()),
      strategiesLive: g?.strategiesLive ?? (await prisma.strategy.count({ where: { active: true } })),
      missedReveals: g?.missedReveals ?? (await prisma.commit.count({ where: { status: 'MISSED' } })),
      tvlUsd: decStr(g?.tvlUsd, 2),
      updatedAt: (g?.updatedAt ?? new Date()).toISOString(),
    };
    return send(reply, statsSchema, out, 10);
  });

  // ───────────────────────── strategies

  const listQuery = z.object({
    category: z.enum(['crypto', 'stock', 'ai', 'all']).default('all'),
    sort: z.enum(['vs', 'ret', 'dd', 'vaults']).default('vs'),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.coerce.number().int().min(0).default(0),
  });

  app.get('/strategies', async (req, reply) => {
    const q = parseQuery(listQuery, req.query);
    const where: Prisma.StrategyWhereInput =
      q.category === 'crypto'
        ? { category: 'CRYPTO' }
        : q.category === 'stock'
          ? { category: { in: ['STOCK', 'MIXED'] } }
          : q.category === 'ai'
            ? { kind: 'AI' }
            : {};
    const all = await prisma.strategy.findMany({ where });
    const houseVaults = await prisma.vault.findMany({
      where: { isHouse: true },
      select: { followingId: true, address: true },
    });
    const houseBy = new Map(houseVaults.map((v) => [v.followingId, v.address]));
    const items = all.map((s) => strategyItem(s, houseBy.get(s.id) ?? null));
    const num = (x: number | null) => (x === null ? -Infinity : x);
    items.sort((a, b) => {
      switch (q.sort) {
        case 'ret':
          return num(b.ret30d) - num(a.ret30d);
        case 'dd':
          return num(b.maxDrawdown30d) - num(a.maxDrawdown30d); // closest to 0 first
        case 'vaults':
          return b.followers - a.followers;
        default:
          return num(b.vsHold) - num(a.vsHold);
      }
    });
    const page = items.slice(q.cursor, q.cursor + q.limit);
    const totals = {
      count: items.length,
      followers: items.reduce((a, s) => a + s.followers, 0),
      aumUsd: all.reduce((a, s) => a.add(s.aumUsd), new Prisma.Decimal(0)).toFixed(2),
    };
    const next = q.cursor + q.limit < items.length ? String(q.cursor + q.limit) : null;
    return send(reply, strategyListSchema, { items: page, nextCursor: next, totals }, 10);
  });

  async function findStrategy(idOrSlug: string) {
    const s = /^\d+$/.test(idOrSlug)
      ? await prisma.strategy.findUnique({ where: { id: Number(idOrSlug) } })
      : await prisma.strategy.findUnique({ where: { slug: idOrSlug } });
    if (!s) throw new ApiError(404, 'NOT_FOUND', `No strategy "${idOrSlug}". Check the id or browse /app.`);
    return s;
  }

  app.get('/strategies/:idOrSlug', async (req, reply) => {
    const { idOrSlug } = req.params as { idOrSlug: string };
    const s = await findStrategy(idOrSlug);
    const house = await prisma.vault.findFirst({ where: { isHouse: true, followingId: s.id } });
    const out = {
      ...strategyItem(s, house?.address ?? null),
      description: s.description,
      params: (s.params ?? {}) as Record<string, unknown>,
      signer: s.signerAddr,
      modelHash: s.modelHash,
      revealWindowSec: s.revealWindowSec,
      metadataURI: s.metadataURI,
      commitCount: s.commitCount,
      revealCount: s.revealCount,
      registered: source(s.registeredTx, s.registeredBlock),
      registeredAt: s.registeredAt.toISOString(),
      registry: env.REGISTRY_ADDRESS ?? null,
      houseVault: house?.address ?? null,
    };
    return send(reply, strategyDetailSchema, out, 10);
  });

  app.get('/strategies/:idOrSlug/equity', async (req, reply) => {
    const { idOrSlug } = req.params as { idOrSlug: string };
    const { range } = parseQuery(
      z.object({ range: z.enum(['7d', '30d', '90d', 'all']).default('30d') }),
      req.query,
    );
    const s = await findStrategy(idOrSlug);
    const days = range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : 3650;
    const since = new Date(Date.now() - days * 86_400_000);
    const pts = await prisma.equityPoint.findMany({
      where: { strategyId: s.id, at: { gte: since } },
      orderBy: { at: 'asc' },
    });
    // downsample to ≤ 240 points for the chart
    const stride = Math.max(1, Math.ceil(pts.length / 240));
    const sampled = pts.filter((_, i) => i % stride === 0 || i === pts.length - 1);
    // rebase the window to 100
    const e0 = sampled[0] ? Number(sampled[0].equity) : 100;
    const h0 = sampled[0] ? Number(sampled[0].hold) : 100;
    const points = sampled.map((p) => ({
      at: p.at.toISOString(),
      equity: Math.round((Number(p.equity) / e0) * 10_000) / 100,
      hold: Math.round((Number(p.hold) / h0) * 10_000) / 100,
    }));
    const live = await prisma.execution.count({ where: { strategyId: s.id } });
    const revealed = await prisma.commit.count({ where: { strategyId: s.id, status: 'REVEALED' } });
    const basis = live === 0 ? 'paper' : live >= revealed ? 'live' : 'mixed';
    return send(reply, equitySchema, { points, basis }, 60);
  });

  const pageQuery = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.coerce.number().int().min(0).optional(),
  });
  const receiptInclude = { strategy: true, executions: true } as const;

  app.get('/strategies/:idOrSlug/receipts', async (req, reply) => {
    const { idOrSlug } = req.params as { idOrSlug: string };
    const q = parseQuery(pageQuery, req.query);
    const s = await findStrategy(idOrSlug);
    const rows = await prisma.commit.findMany({
      where: { strategyId: s.id, ...(q.cursor !== undefined ? { receiptNo: { lt: q.cursor } } : {}) },
      orderBy: { receiptNo: 'desc' },
      take: q.limit + 1,
      include: receiptInclude,
    });
    const items = rows.slice(0, q.limit).map((c) => receiptSummary(c, decimalsOf));
    const next = rows.length > q.limit ? String(rows[q.limit - 1]!.receiptNo) : null;
    return send(reply, receiptListSchema, { items, nextCursor: next }, 10);
  });

  // ───────────────────────── receipts

  app.get('/receipts/latest', async (req, reply) => {
    const { limit } = parseQuery(
      z.object({ limit: z.coerce.number().int().min(1).max(50).default(8) }),
      req.query,
    );
    const rows = await prisma.commit.findMany({
      orderBy: { receiptNo: 'desc' },
      take: limit,
      include: receiptInclude,
    });
    return send(
      reply,
      receiptListSchema,
      { items: rows.map((c) => receiptSummary(c, decimalsOf)), nextCursor: null },
      10,
    );
  });

  app.get('/receipts/:idOrHash', async (req, reply) => {
    const { idOrHash } = req.params as { idOrHash: string };
    const include = { ...receiptInclude, aiArtifact: true } as const;
    let c;
    if (/^\d+$/.test(idOrHash)) {
      c = await prisma.commit.findUnique({ where: { receiptNo: Number(idOrHash) }, include });
    } else if (/^0x[0-9a-fA-F]{64}$/.test(idOrHash)) {
      // the hash is not unique on-chain (anyone can copy one): prefer the earliest commit
      c = await prisma.commit.findFirst({
        where: { hash: idOrHash.toLowerCase() },
        orderBy: { receiptNo: 'asc' },
        include,
      });
    } else if (/^\d+-\d+$/.test(idOrHash)) {
      const [sid, nonce] = idOrHash.split('-').map(Number) as [number, number];
      c = await prisma.commit.findUnique({
        where: { strategyId_nonce: { strategyId: sid, nonce } },
        include,
      });
    } else {
      throw new ApiError(
        400,
        'BAD_ID',
        'Use a receipt number (48213), a commit hash (0x…64 hex) or strategyId-nonce (3-17).',
      );
    }
    if (!c)
      throw new ApiError(
        404,
        'NOT_FOUND',
        `No receipt "${idOrHash}" yet. New commits appear within seconds of confirmation.`,
      );

    const limitsCache = new Map<string, number>();
    const vaultRows = await prisma.vault.findMany({
      where: { address: { in: c.executions.map((e) => e.vaultAddr) } },
    });
    const limitEvents = await prisma.vaultEvent.findMany({
      where: { vaultAddr: { in: c.executions.map((e) => e.vaultAddr) }, type: 'LIMITS' },
      orderBy: [{ blockNumber: 'asc' }, { logIndex: 'asc' }],
    });
    const ctx: CheckContext = {
      chainId: env.CHAIN_ID,
      registry: env.REGISTRY_ADDRESS ?? null,
      slippageLimitAt: (vault, block) => {
        const key = `${vault}:${block}`;
        const hit = limitsCache.get(key);
        if (hit !== undefined) return hit;
        const last = limitEvents.filter((e) => e.vaultAddr === vault && e.blockNumber <= block).at(-1);
        const v =
          Number((last?.data as { maxSlippageBps?: string | number } | undefined)?.maxSlippageBps ?? NaN) ||
          vaultRows.find((r) => r.address === vault)?.maxSlippageBps ||
          500;
        limitsCache.set(key, v);
        return v;
      },
    };
    const out = receiptDetail(c, ctx, decimalsOf);
    const terminal = c.status !== 'COMMITTED' && c.matchStatus !== 'PENDING';
    return send(reply, receiptDetailSchema, out, terminal ? 3600 : 10);
  });

  // ───────────────────────── vaults

  app.get('/vaults/house', async (_req, reply) => {
    const rows = await prisma.vault.findMany({ where: { isHouse: true }, orderBy: { createdAt: 'asc' } });
    const names = await prisma.strategy.findMany({
      where: { id: { in: rows.map((v) => v.followingId).filter((x): x is number => x !== null) } },
      select: { id: true, name: true },
    });
    const items = rows.map((v) => ({
      address: v.address,
      strategyId: v.followingId,
      strategyName: names.find((n) => n.id === v.followingId)?.name ?? null,
      navUsd: v.navUsd.toFixed(2),
      explorerUrl: explorerAddress(v.address),
    }));
    return send(reply, houseVaultListSchema, { items }, 30);
  });

  app.get('/vaults/:owner', async (req, reply) => {
    const { owner } = req.params as { owner: string };
    if (!/^0x[0-9a-fA-F]{40}$/.test(owner))
      throw new ApiError(400, 'BAD_ADDRESS', 'Use a 0x-prefixed wallet or vault address.');
    const a = owner.toLowerCase();
    const v = await prisma.vault.findFirst({
      where: { OR: [{ ownerAddr: a }, { address: a }] },
      include: { events: { orderBy: [{ blockNumber: 'desc' }, { logIndex: 'desc' }], take: 50 } },
    });
    if (!v)
      throw new ApiError(404, 'NO_VAULT', 'This wallet has no vault yet. Create one from the Vault page.');
    const name = v.followingId
      ? ((await prisma.strategy.findUnique({ where: { id: v.followingId } }))?.name ?? null)
      : null;
    return send(reply, vaultSchema, vaultOut(v, name), 5);
  });

  // ───────────────────────── templates, metadata, config

  app.get('/templates', async (_req, reply) =>
    send(
      reply,
      templateListSchema,
      { items: TEMPLATES.map((t) => ({ ...t, assets: { ...t.assets, allowed: [...t.assets.allowed] } })) },
      300,
    ),
  );

  app.get('/metadata/:hash', async (req, reply) => {
    const { hash } = req.params as { hash: string };
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash))
      throw new ApiError(400, 'BAD_HASH', 'Metadata ids are 0x-prefixed keccak256 hashes.');
    const doc = await prisma.metadataDoc.findUnique({ where: { hash: hash.toLowerCase() } });
    if (!doc) throw new ApiError(404, 'NOT_FOUND', 'Unknown metadata hash.');
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return doc.json;
  });

  app.get('/config/chain', async (_req, reply) => {
    const out = {
      chainId: env.CHAIN_ID,
      name: robinhoodConfig.name,
      explorer: env.EXPLORER_URL,
      rpcUrl: env.PUBLIC_RPC_URL,
      registry: env.REGISTRY_ADDRESS ?? null,
      factory: env.FACTORY_ADDRESS ?? null,
      router: robinhoodConfig.router.toLowerCase(),
      maxDailyLimitUsd: app.deps.chain ? await app.deps.chain.maxDailyLimitUsd() : null,
      geoblockStocks: env.GEOBLOCK_STOCKS.length > 0,
      tokens: TOKENS.map((t) => ({
        symbol: t.symbol,
        address: t.address.toLowerCase(),
        feed: t.feed.toLowerCase(),
        kind: t.kind,
        feeTier: t.feeTier,
        maxStaleness: t.maxStaleness,
      })),
    };
    return send(reply, chainConfigSchema, out, 300);
  });
}

function parseQuery<T extends z.ZodTypeAny>(schema: T, q: unknown): z.infer<T> {
  const r = schema.safeParse(q ?? {});
  if (!r.success) {
    throw new ApiError(
      400,
      'BAD_QUERY',
      r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  return r.data;
}

export type { FastifyReply };
