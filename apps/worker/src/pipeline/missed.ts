import type { Address } from 'viem';
import type { PrismaClient } from '@receipts/db';
import type { Redis } from 'ioredis';
import { signalRegistryAbi } from '@receipts/shared/abi';
import type { Client } from '../chain.js';
import type { Logger } from '../log.js';
import { withKeyLock, type KeyedWallet } from './keys.js';
import { shortErr } from './executor.js';

/**
 * WORKER.md §5: mark every expired, unrevealed commit as missed — for any strategy, not only ours — so the public
 * record stays honest. Anyone may call markMissed; we pay the gas.
 */
export async function runMissed(deps: {
  prisma: PrismaClient;
  client: Client;
  redis: Redis;
  log: Logger;
  registry: Address;
  sender: KeyedWallet | null;
}): Promise<number> {
  const { prisma, client, redis, log, registry, sender } = deps;
  if (!sender) return 0;
  const expired = await prisma.commit.findMany({
    where: { status: 'COMMITTED', revealDeadline: { lt: new Date(Date.now() - 30_000) } },
    take: 50,
    orderBy: { revealDeadline: 'asc' },
  });
  let marked = 0;
  for (const c of expired) {
    try {
      const onchain = await client.readContract({
        address: registry,
        abi: signalRegistryAbi,
        functionName: 'commitOf',
        args: [BigInt(c.strategyId), BigInt(c.nonce)],
      });
      if (onchain.status !== 1) continue; // already revealed / missed; the indexer will catch up
      if (BigInt(Math.floor(Date.now() / 1000)) <= onchain.revealDeadline) continue;
      await withKeyLock(redis, sender.address, async () => {
        const hash = await sender.wallet.writeContract({
          address: registry,
          abi: signalRegistryAbi,
          functionName: 'markMissed',
          args: [BigInt(c.strategyId), BigInt(c.nonce)],
          account: sender.wallet.account!,
          chain: sender.wallet.chain,
        });
        await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
      });
      marked++;
      log.warn({ strategyId: c.strategyId, nonce: c.nonce }, 'marked missed');
    } catch (err) {
      log.error({ strategyId: c.strategyId, nonce: c.nonce, err: shortErr(err) }, 'markMissed failed');
    }
  }
  return marked;
}
