import { formatEther, parseEther, type Address } from 'viem';
import { Prisma, type PrismaClient } from '@receipts/db';
import type { Redis } from 'ioredis';
import type { Client } from '../chain.js';
import type { WorkerEnv } from '../env.js';
import type { Logger } from '../log.js';

type Level = 'info' | 'warn' | 'critical';

/** Writes an AlertLog row (delivered to Telegram by `deliverAlerts`). `dedupeKey` suppresses repeats for `ttlSec`. */
export async function raiseAlert(
  prisma: PrismaClient,
  redis: Redis | null,
  log: Logger,
  level: Level,
  kind: string,
  message: string,
  data?: Record<string, unknown>,
  dedupe?: { key: string; ttlSec: number },
): Promise<void> {
  if (dedupe && redis && (await redis.set(`alert:${dedupe.key}`, '1', 'EX', dedupe.ttlSec, 'NX')) !== 'OK')
    return;
  log[level === 'critical' ? 'error' : level === 'warn' ? 'warn' : 'info']({ kind, ...data }, message);
  await prisma.alertLog.create({
    data: { level, kind, message, data: (data ?? {}) as Prisma.InputJsonObject },
  });
}

/** Sends unsent alerts to Telegram (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID). Without a token they stay in AlertLog. */
export async function deliverAlerts(
  prisma: PrismaClient,
  env: WorkerEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return 0;
  const rows = await prisma.alertLog.findMany({
    where: { sentAt: null },
    orderBy: { createdAt: 'asc' },
    take: 20,
  });
  let sent = 0;
  for (const a of rows) {
    const icon = a.level === 'critical' ? '🚨' : a.level === 'warn' ? '⚠️' : 'ℹ️';
    const res = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: `${icon} [${a.kind}] ${a.message}`,
        disable_web_page_preview: true,
      }),
    }).catch(() => null);
    if (res?.ok) {
      await prisma.alertLog.update({ where: { id: a.id }, data: { sentAt: new Date() } });
      sent++;
    } else break; // retry next run
  }
  return sent;
}

/** WORKER.md §7 health checks: low gas, indexer lag, tx failure rate. */
export async function runHealthChecks(deps: {
  prisma: PrismaClient;
  client: Client;
  redis: Redis;
  env: WorkerEnv;
  log: Logger;
  keys: Address[];
}): Promise<void> {
  const { prisma, client, redis, env, log, keys } = deps;
  const min = parseEther(env.MIN_GAS_BALANCE_ETH);
  for (const k of keys) {
    const bal = await client.getBalance({ address: k }).catch(() => null);
    if (bal !== null && bal < min) {
      await raiseAlert(
        prisma,
        redis,
        log,
        'warn',
        'low_gas',
        `Low gas on ${k}: ${formatEther(bal)} ETH (min ${env.MIN_GAS_BALANCE_ETH})`,
        { address: k },
        { key: `low_gas:${k}`, ttlSec: 6 * 3600 },
      );
    }
  }
  const cursor = await prisma.indexerCursor.findUnique({ where: { id: 'registry' } });
  if (cursor && env.REGISTRY_ADDRESS) {
    const lagMs = Date.now() - cursor.updatedAt.getTime();
    const head = await redis.get('chain:head');
    const lagBlocks = head ? Number(BigInt(head) - cursor.lastBlock) : 0;
    if (lagMs > 120_000 && lagBlocks > env.CONFIRMATIONS + 5) {
      await raiseAlert(
        prisma,
        redis,
        log,
        'warn',
        'indexer_lag',
        `Indexer is ${Math.round(lagMs / 1000)} s / ${lagBlocks} blocks behind`,
        { lagBlocks },
        { key: 'indexer_lag', ttlSec: 1800 },
      );
    }
  }
  const bucket = Math.floor(Date.now() / 900_000);
  const [ok, fail] = await Promise.all([redis.get(`tx:ok:${bucket}`), redis.get(`tx:fail:${bucket}`)]);
  const o = Number(ok ?? 0);
  const f = Number(fail ?? 0);
  if (o + f >= 5 && f / (o + f) > 0.1) {
    await raiseAlert(
      prisma,
      redis,
      log,
      'warn',
      'tx_failed',
      `Transaction failure rate ${Math.round((100 * f) / (o + f))}% in the last 15 min (${f}/${o + f})`,
      {},
      { key: `tx_failed:${bucket}`, ttlSec: 900 },
    );
  }
}
