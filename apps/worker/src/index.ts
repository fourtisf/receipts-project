import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { getPrisma, disconnectPrisma } from '@receipts/db';
import { loadEnv, on } from './env.js';
import { log } from './log.js';
import { makePublicClient } from './chain.js';
import { Publisher } from './pubsub.js';
import { Indexer } from './indexer/indexer.js';
import { runPrices } from './jobs/prices.js';
import { runStats } from './jobs/stats.js';
import { startPipeline } from './pipeline/index.js';

const env = loadEnv();
const prisma = getPrisma();
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const connection = { url: env.REDIS_URL } as ConnectionOptions;
const client = makePublicClient(env);
const publisher = new Publisher(redis);

let stopping = false;
const stops: (() => Promise<void>)[] = [];

await prisma.$queryRaw`SELECT 1`;
log.info(
  { chainId: env.CHAIN_ID, registry: env.REGISTRY_ADDRESS, factory: env.FACTORY_ADDRESS },
  'worker starting',
);

const heartbeat = setInterval(
  () => void redis.set('worker:heartbeat', Date.now().toString(), 'EX', 120),
  10_000,
);

// ── indexer (continuous loop)
if (on(env.RUN_INDEXER)) {
  if (!env.REGISTRY_ADDRESS || !env.FACTORY_ADDRESS) {
    log.warn('REGISTRY_ADDRESS / FACTORY_ADDRESS not set: indexer disabled until contracts are deployed');
  } else {
    const indexer = new Indexer(
      prisma,
      client,
      {
        registry: env.REGISTRY_ADDRESS,
        factory: env.FACTORY_ADDRESS,
        startBlock: env.START_BLOCK,
        confirmations: env.CONFIRMATIONS,
        chunk: env.INDEXER_CHUNK,
        reorgRewind: env.REORG_REWIND,
        houseVaults: env.HOUSE_VAULTS,
        houseCreators: env.HOUSE_CREATORS,
        explorerUrl: env.EXPLORER_URL,
        chainId: env.CHAIN_ID,
      },
      log,
      publisher,
    );
    void (async () => {
      let backoff = env.INDEXER_POLL_MS;
      while (!stopping) {
        try {
          const r = await indexer.tick();
          if (r) {
            await redis.set('chain:head', r.head.toString());
            if (r.logs > 0 || r.reorg)
              log.info({ from: r.from.toString(), to: r.to.toString(), logs: r.logs }, 'indexed');
          }
          backoff = env.INDEXER_POLL_MS;
          // catch up quickly when behind
          await sleep(r && r.to < r.head - BigInt(env.CONFIRMATIONS) ? 50 : env.INDEXER_POLL_MS);
        } catch (err) {
          log.error({ err: String(err) }, 'indexer tick failed');
          backoff = Math.min(backoff * 2, 60_000);
          await sleep(backoff);
        }
      }
    })();
  }
}

// ── scheduled jobs on BullMQ (one queue per job type)
function schedule(name: string, everyMs: number, fn: () => Promise<unknown>): void {
  const queue = new Queue(name, { connection });
  void queue.upsertJobScheduler(
    `${name}-every`,
    { every: everyMs },
    { name, opts: { removeOnComplete: 50, removeOnFail: 200 } },
  );
  const worker = new Worker(
    name,
    async () => {
      await fn();
    },
    { connection, concurrency: 1 },
  );
  worker.on('failed', (_job, err) => log.error({ job: name, err: String(err) }, 'job failed'));
  stops.push(async () => {
    await worker.close();
    await queue.close();
  });
}

if (on(env.RUN_PRICES)) schedule('prices', 60_000, () => runPrices(prisma, client));
if (on(env.RUN_STATS)) schedule('stats', 5 * 60_000, () => runStats(prisma, client));

// ── runner / executor / revealer / missed / alerts (M5)
stops.push(await startPipeline({ env, prisma, client, redis, connection, publisher, log, schedule }));

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'worker stopping');
  clearInterval(heartbeat);
  for (const s of stops) await s().catch(() => undefined);
  await disconnectPrisma();
  redis.disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
