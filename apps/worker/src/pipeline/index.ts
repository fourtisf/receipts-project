import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Address } from 'viem';
import type { PrismaClient } from '@receipts/db';
import type { SignalOut } from '@receipts/strategies';
import type { Client } from '../chain.js';
import { on, type WorkerEnv } from '../env.js';
import type { Logger } from '../log.js';
import type { Publisher } from '../pubsub.js';
import { makeWallet, parseSignerKeys, type KeyedWallet } from './keys.js';
import { SecretBox } from './secrets.js';
import { Executor, type AiArtifactInput } from './executor.js';
import { Runner } from './runner.js';
import { makeMarketData } from './market.js';
import { runMissed } from './missed.js';
import { deliverAlerts, raiseAlert, runHealthChecks } from './alerts.js';

export interface PipelineDeps {
  env: WorkerEnv;
  prisma: PrismaClient;
  client: Client;
  redis: Redis;
  connection: ConnectionOptions;
  publisher: Publisher;
  log: Logger;
  schedule: (name: string, everyMs: number, fn: () => Promise<unknown>) => void;
}

interface ExecJob {
  strategyId: number;
  signal: SignalOut;
  ai: AiArtifactInput | null;
}

/** Runner, executor (commit → execute → reveal), missed-marker and alerts (WORKER.md §3–§7). */
export async function startPipeline(d: PipelineDeps): Promise<() => Promise<void>> {
  const { env, prisma, client, redis, log, schedule, connection } = d;
  const stops: (() => Promise<void>)[] = [];
  const alert = (
    level: 'info' | 'warn' | 'critical',
    kind: string,
    message: string,
    data?: Record<string, unknown>,
  ) => raiseAlert(prisma, redis, log, level, kind, message, data);

  const executorKey: KeyedWallet | null = env.EXECUTOR_PRIVATE_KEY
    ? makeWallet(env.RPC_URL, env.EXECUTOR_PRIVATE_KEY)
    : null;
  const signerKeys = parseSignerKeys(env.RPC_URL, env.SIGNER_PRIVATE_KEYS);
  const signers = new Map(signerKeys.map((k) => [k.address, k]));
  log.info(
    { executor: executorKey?.address ?? null, signers: [...signers.keys()] },
    'pipeline keys loaded (addresses only)',
  );

  // alerts + health (no keys needed)
  schedule('alerts', 30_000, () => deliverAlerts(prisma, env));
  schedule('health', 5 * 60_000, () =>
    runHealthChecks({
      prisma,
      client,
      redis,
      env,
      log,
      keys: [executorKey?.address, ...signers.keys()].filter(Boolean) as Address[],
    }),
  );

  if (!env.REGISTRY_ADDRESS) {
    log.warn('REGISTRY_ADDRESS not set: runner / executor / missed disabled');
    return async () => undefined;
  }
  const registry = env.REGISTRY_ADDRESS;

  if (on(env.RUN_MISSED)) {
    schedule('missed', 5 * 60_000, () =>
      runMissed({ prisma, client, redis, log, registry, sender: executorKey ?? signerKeys[0] ?? null }),
    );
  }

  if (signers.size === 0 || !env.SALT_ENCRYPTION_KEY) {
    if (on(env.RUN_RUNNER) || on(env.RUN_EXECUTOR)) {
      log.warn(
        'SIGNER_PRIVATE_KEYS or SALT_ENCRYPTION_KEY not set: runner / executor disabled (indexer + API keep working)',
      );
    }
    return async () => {
      for (const s of stops) await s();
    };
  }

  const box = new SecretBox(env.SALT_ENCRYPTION_KEY);
  const executor = new Executor({
    prisma,
    client,
    redis,
    log,
    registry,
    chainId: env.CHAIN_ID,
    executor: executorKey,
    signers,
    box,
    alert,
  });

  if (on(env.RUN_EXECUTOR)) {
    await executor.recoverPending(); // never leave a commit unrevealed across restarts
    const queue = new Queue<ExecJob>('executor', { connection });
    const worker = new Worker<ExecJob>(
      'executor',
      async (job) => {
        await executor.run(job.data.strategyId, job.data.signal, job.data.ai);
      },
      { connection, concurrency: 1 }, // one signal at a time: nonces and reveals stay ordered
    );
    worker.on('failed', (job, err) => {
      void alert(
        'warn',
        'tx_failed',
        `Signal for strategy ${job?.data.strategyId} failed: ${String(err).slice(0, 300)}`,
      );
    });
    stops.push(async () => {
      await worker.close();
      await queue.close();
    });
    // pending reveals sweep (e.g. after RPC hiccups)
    schedule('reveal-sweep', 60_000, () => executor.recoverPending());

    if (on(env.RUN_RUNNER)) {
      const runner = new Runner({
        prisma,
        redis,
        env,
        log,
        market: makeMarketData(env, prisma),
        signerAddresses: new Set(signers.keys()),
        enqueue: async (j) => {
          await queue.add('signal', j, { attempts: 1, removeOnComplete: 500, removeOnFail: 500 });
        },
      });
      schedule('runner', 5 * 60_000, () => runner.runOnce());
    }
  }

  return async () => {
    for (const s of stops) await s();
  };
}
