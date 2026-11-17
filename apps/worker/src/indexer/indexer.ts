import { decodeEventLog, getAbiItem, toEventSelector, type Address, type Hex, type Log } from 'viem';
import type { PrismaClient } from '@receipts/db';
import { signalRegistryAbi, receiptsVaultAbi, vaultFactoryAbi } from '@receipts/shared/abi';
import type { Client } from '../chain.js';
import type { Logger } from '../log.js';
import type { Publisher } from '../pubsub.js';
import { Handlers, type DecodedLog } from './handlers.js';

export const STREAMS = ['registry', 'factory', 'vaults'] as const;

export interface IndexerConfig {
  registry: Address;
  factory: Address;
  startBlock: bigint;
  confirmations: number;
  chunk: number;
  reorgRewind: number;
  houseVaults: readonly string[];
  houseCreators: readonly string[];
  explorerUrl: string;
  chainId: number;
}

const vaultEventNames = [
  'Deposited',
  'Withdrawn',
  'Followed',
  'Unfollowed',
  'AllocationChanged',
  'LimitsChanged',
  'PausedChanged',
  'OperatorChanged',
  'TokenEnabled',
  'Executed',
  'BreakerTripped',
  'PeakReset',
  'MarksFrozen',
  'MarksReset',
  'FeesSettled',
  'FeeDeferred',
] as const;

/** topic0 for every vault event: vault logs are fetched by topic (scales to any number of vaults) and filtered. */
export const VAULT_TOPICS: Hex[] = vaultEventNames.map((name) =>
  toEventSelector(getAbiItem({ abi: receiptsVaultAbi, name }) as never),
);

export interface TickResult {
  from: bigint;
  to: bigint;
  logs: number;
  head: bigint;
  reorg: boolean;
}

/**
 * Reorg-safe event indexer (WORKER.md §1). Polls `eth_getLogs` in chunks up to `head − confirmations`, stores the
 * last processed block hash and, on mismatch, rolls back `reorgRewind` blocks and re-indexes. Every write is an
 * idempotent upsert, so a crash mid-batch simply replays the batch.
 */
export class Indexer {
  readonly handlers: Handlers;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly client: Client,
    private readonly cfg: IndexerConfig,
    private readonly log: Logger,
    private readonly publisher: Publisher,
  ) {
    this.handlers = new Handlers(prisma, client, cfg, log, publisher);
  }

  async cursor(): Promise<{ block: bigint; hash: string | null }> {
    const c = await this.prisma.indexerCursor.findUnique({ where: { id: 'registry' } });
    if (!c) return { block: this.cfg.startBlock > 0n ? this.cfg.startBlock - 1n : 0n, hash: null };
    return { block: c.lastBlock, hash: c.lastBlockHash || null };
  }

  private async saveCursor(block: bigint, hash: string): Promise<void> {
    await this.prisma.$transaction(
      STREAMS.map((id) =>
        this.prisma.indexerCursor.upsert({
          where: { id },
          create: { id, lastBlock: block, lastBlockHash: hash },
          update: { lastBlock: block, lastBlockHash: hash },
        }),
      ),
    );
  }

  /** One polling step. Returns null when there is nothing new to index. */
  async tick(): Promise<TickResult | null> {
    const head = await this.client.getBlockNumber();
    const safe = head - BigInt(this.cfg.confirmations);
    const cur = await this.cursor();
    let last = cur.block;
    const hash = cur.hash;

    let reorg = false;
    if (hash && last > 0n) {
      const b = await this.client.getBlock({ blockNumber: last }).catch(() => null);
      if (b && b.hash !== hash) {
        reorg = true;
        last = await this.rollback(last);
      }
    }

    const from = last + 1n;
    if (from > safe) return reorg ? { from, to: last, logs: 0, head, reorg } : null;
    const to = from + BigInt(this.cfg.chunk) - 1n < safe ? from + BigInt(this.cfg.chunk) - 1n : safe;

    const [coreLogs, vaultLogs] = await Promise.all([
      this.client.getLogs({ address: [this.cfg.registry, this.cfg.factory], fromBlock: from, toBlock: to }),
      this.client.getLogs({ topics: [VAULT_TOPICS] as never, fromBlock: from, toBlock: to } as never),
    ]);

    const decoded = await this.decode([...coreLogs, ...(vaultLogs as Log[])]);
    await this.handlers.processBatch(decoded);

    const toBlock = await this.client.getBlock({ blockNumber: to });
    await this.saveCursor(to, toBlock.hash ?? '');
    await this.publisher.flush();
    return { from, to, logs: decoded.length, head, reorg };
  }

  private async decode(logs: Log[]): Promise<DecodedLog[]> {
    const knownVaults = new Set(
      (await this.prisma.vault.findMany({ select: { address: true } })).map((v) => v.address.toLowerCase()),
    );
    const out: DecodedLog[] = [];
    const registry = this.cfg.registry.toLowerCase();
    const factory = this.cfg.factory.toLowerCase();
    // vaults created in this batch are known for their own events in the same batch
    for (const l of logs) {
      if (l.address.toLowerCase() !== factory) continue;
      try {
        const ev = decodeEventLog({ abi: vaultFactoryAbi, data: l.data, topics: l.topics as never });
        if (ev.eventName === 'VaultCreated')
          knownVaults.add((ev.args as { vault: string }).vault.toLowerCase());
      } catch {
        /* not ours */
      }
    }
    for (const l of logs) {
      const addr = l.address.toLowerCase();
      const abi =
        addr === registry
          ? signalRegistryAbi
          : addr === factory
            ? vaultFactoryAbi
            : knownVaults.has(addr)
              ? receiptsVaultAbi
              : null;
      if (!abi) continue;
      try {
        const ev = decodeEventLog({ abi, data: l.data, topics: l.topics as never });
        out.push({
          source: addr === registry ? 'registry' : addr === factory ? 'factory' : 'vault',
          address: addr as Address,
          eventName: ev.eventName,
          args: ev.args as unknown as Record<string, unknown>,
          blockNumber: l.blockNumber!,
          blockHash: l.blockHash!,
          txHash: l.transactionHash!,
          logIndex: l.logIndex!,
        });
      } catch {
        /* unknown event on a known contract: ignore */
      }
    }
    out.sort((a, b) =>
      a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
    );
    return out;
  }

  /** Rolls back everything above the fork point and refreshes state from the canonical chain. */
  async rollback(last: bigint): Promise<bigint> {
    const min = this.cfg.startBlock > 0n ? this.cfg.startBlock - 1n : 0n;
    const fork = last - BigInt(this.cfg.reorgRewind) > min ? last - BigInt(this.cfg.reorgRewind) : min;
    this.log.warn({ last: last.toString(), fork: fork.toString() }, 'reorg detected: rolling back');
    await this.prisma.$transaction([
      this.prisma.execution.deleteMany({ where: { blockNumber: { gt: fork } } }),
      this.prisma.vaultEvent.deleteMany({ where: { blockNumber: { gt: fork } } }),
      this.prisma.commit.updateMany({
        where: { revealBlock: { gt: fork } },
        data: {
          status: 'COMMITTED',
          revealedAt: null,
          revealTx: null,
          revealBlock: null,
          tokenIn: null,
          tokenOut: null,
          sizeBps: null,
          promptHash: null,
          salt: null,
          priceInAtCommit: null,
          priceOutAtCommit: null,
          matchStatus: 'PENDING',
          matchNote: null,
        },
      }),
      this.prisma.commit.updateMany({
        where: { missedBlock: { gt: fork } },
        data: { status: 'COMMITTED', missedTx: null, missedBlock: null },
      }),
    ]);
    // commits above the fork (and their executions, already deleted above) go away
    await this.prisma.aiArtifact.deleteMany({ where: { commit: { committedL2Block: { gt: fork } } } });
    await this.prisma.commit.deleteMany({ where: { committedL2Block: { gt: fork } } });
    await this.prisma.vault.deleteMany({
      where: { createdBlock: { gt: fork }, executions: { none: {} }, events: { none: {} } },
    });
    await this.prisma.equityPoint.deleteMany({ where: { strategy: { registeredBlock: { gt: fork } } } });
    await this.prisma.strategy.deleteMany({
      where: { registeredBlock: { gt: fork }, commits: { none: {} } },
    });
    const b = await this.client.getBlock({ blockNumber: fork });
    await this.saveCursor(fork, b.hash ?? '');
    // canonical state for everything that survived
    await this.handlers.refreshAllFromChain();
    return fork;
  }
}
