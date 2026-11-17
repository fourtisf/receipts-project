import type { ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@receipts/db';
import type { Client } from '../chain.js';
import type { WorkerEnv } from '../env.js';
import type { Logger } from '../log.js';
import type { Publisher } from '../pubsub.js';

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

/** Runner, executor (commit → execute → reveal), missed-marker and alerts. Implemented in M5. */
export async function startPipeline(_deps: PipelineDeps): Promise<() => Promise<void>> {
  return async () => undefined;
}
