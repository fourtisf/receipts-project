import type { Address, Hex } from 'viem';
import { Prisma, type PrismaClient, type VaultEventType, usdDec, dec } from '@receipts/db';
import {
  TOKENS,
  baseToken,
  explorerTx,
  metadataHashFromUri,
  slugify,
  strategyMetadataSchema,
  tokenByAddress,
  tokenBySymbol,
  type TokenInfo,
} from '@receipts/shared';
import { receiptsVaultAbi, signalRegistryAbi } from '@receipts/shared/abi';
import { mapLimit, readFeed, readFeeds, tokenDecimals, type Client } from '../chain.js';
import type { Logger } from '../log.js';
import type { Publisher } from '../pubsub.js';
import { bigintReplacer } from '../pubsub.js';
import { matchCheck } from './match.js';
import type { IndexerConfig } from './indexer.js';

export interface DecodedLog {
  source: 'registry' | 'factory' | 'vault';
  address: Address;
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  blockHash: Hex;
  txHash: Hex;
  logIndex: number;
}

const ZERO32 = `0x${'0'.repeat(64)}`;

const vaultEventType: Record<string, VaultEventType> = {
  Deposited: 'DEPOSITED',
  Withdrawn: 'WITHDRAWN',
  Followed: 'FOLLOWED',
  Unfollowed: 'UNFOLLOWED',
  AllocationChanged: 'ALLOCATION',
  LimitsChanged: 'LIMITS',
  PausedChanged: 'PAUSED',
  OperatorChanged: 'OPERATOR',
  TokenEnabled: 'TOKEN',
  BreakerTripped: 'BREAKER',
  PeakReset: 'PEAK_RESET',
  MarksFrozen: 'MARKS_FROZEN',
  MarksReset: 'MARKS_RESET',
  FeesSettled: 'FEES_SETTLED',
  FeeDeferred: 'FEE_DEFERRED',
};

/** JSON-safe copy of decoded event args (bigint → string, addresses lowercase). */
export function jsonArgs(args: Record<string, unknown>): Prisma.InputJsonObject {
  return JSON.parse(
    JSON.stringify(args, (k, v) => {
      const b = bigintReplacer(k, v);
      return typeof b === 'string' && /^0x[0-9a-fA-F]{40}$/.test(b) ? b.toLowerCase() : b;
    }),
  ) as Prisma.InputJsonObject;
}

export function categoryOf(assets: readonly string[]): 'CRYPTO' | 'STOCK' | 'MIXED' {
  const kinds = new Set(
    assets
      .map((s) => tokenBySymbol(s)?.kind)
      .filter((k): k is 'crypto' | 'stock' => k === 'crypto' || k === 'stock'),
  );
  if (kinds.size === 1) return kinds.has('stock') ? 'STOCK' : 'CRYPTO';
  return kinds.size === 0 ? 'CRYPTO' : 'MIXED';
}

export class Handlers {
  private blockTimes = new Map<bigint, Date>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly client: Client,
    private readonly cfg: IndexerConfig,
    private readonly log: Logger,
    private readonly publisher: Publisher,
  ) {}

  async processBatch(logs: readonly DecodedLog[]): Promise<void> {
    if (logs.length === 0) return;
    const blocks = [...new Set(logs.map((l) => l.blockNumber))].filter((b) => !this.blockTimes.has(b));
    await mapLimit(blocks, 4, async (b) => {
      const blk = await this.client.getBlock({ blockNumber: b });
      this.blockTimes.set(b, new Date(Number(blk.timestamp) * 1000));
    });
    if (this.blockTimes.size > 5000) this.blockTimes.clear();

    const touchedStrategies = new Set<number>();
    const touchedVaults = new Set<string>();
    const revealed: { strategyId: number; nonce: number }[] = [];

    // phase A: vault rows first (a vault's constructor events precede VaultCreated in the same tx)
    for (const l of logs) if (l.eventName === 'VaultCreated') await this.onVaultCreated(l);

    // phase B: everything in chain order
    for (const l of logs) {
      if (l.source === 'registry') {
        const id = Number(l.args.id as bigint);
        switch (l.eventName) {
          case 'StrategyRegistered':
            await this.onStrategyRegistered(l);
            break;
          case 'Committed':
            await this.onCommitted(l);
            break;
          case 'Revealed':
            await this.onRevealed(l);
            revealed.push({ strategyId: id, nonce: Number(l.args.nonce as bigint) });
            break;
          case 'Missed':
            await this.onMissed(l);
            break;
          case 'MetadataChanged':
            await this.mergeMetadata(id, l.args.metadataURI as string);
            break;
          default:
            break; // SignerChanged / ActiveChanged / CreatorShareLowered: refreshed from chain below
        }
        if (Number.isFinite(id) && id > 0) touchedStrategies.add(id);
      } else if (l.source === 'vault') {
        await this.onVaultEvent(l);
        touchedVaults.add(l.address);
      }
    }

    await mapLimit([...touchedStrategies], 3, (id) => this.refreshStrategy(id));
    await mapLimit([...touchedVaults], 3, (a) => this.refreshVault(a as Address));
    for (const r of revealed) await this.runMatchCheck(r.strategyId, r.nonce);
  }

  private at(l: DecodedLog): Date {
    return this.blockTimes.get(l.blockNumber) ?? new Date();
  }

  // ───────────────────────── registry

  async onStrategyRegistered(l: DecodedLog): Promise<void> {
    const id = Number(l.args.id as bigint);
    const creator = (l.args.creator as string).toLowerCase();
    const modelHash = (l.args.modelHash as string).toLowerCase();
    const uri = l.args.metadataURI as string;
    const meta = await this.resolveMetadata(uri, creator, modelHash);
    const user = await this.prisma.user.findUnique({ where: { address: creator } });
    const data = {
      slug: slugify(meta.name, id),
      name: meta.name,
      description: meta.description,
      kind: meta.kind,
      category: categoryOf(meta.assets),
      template: meta.template,
      params: meta.params as Prisma.InputJsonValue,
      assets: meta.assets,
      creatorAddr: creator,
      creatorUserId: user?.id ?? null,
      signerAddr: (l.args.signer as string).toLowerCase(),
      modelId: meta.modelId,
      modelHash: modelHash === ZERO32 ? null : modelHash,
      creatorShareBps: Number(l.args.creatorShareBps),
      revealWindowSec: Number(l.args.revealWindow),
      metadataURI: uri,
      registeredTx: l.txHash,
      registeredAt: this.at(l),
      registeredBlock: l.blockNumber,
    };
    await this.prisma.strategy.upsert({ where: { id }, create: { id, ...data }, update: data });
  }

  /** Metadata from our content-addressed store; foreign or invalid URIs get neutral defaults. */
  async resolveMetadata(uri: string, creator: string, modelHash: string) {
    const hash = metadataHashFromUri(uri);
    const doc = hash ? await this.prisma.metadataDoc.findUnique({ where: { hash } }) : null;
    const parsed = doc ? strategyMetadataSchema.safeParse(doc.json) : null;
    const m = parsed?.success ? parsed.data : null;
    const isAi = modelHash !== ZERO32;
    // Never call a strategy "AI" without a committed model hash; HOUSE only for configured house creators.
    let kind: 'HOUSE' | 'TEMPLATE' | 'AI' = isAi ? 'AI' : 'TEMPLATE';
    if (m?.kind === 'HOUSE' && this.cfg.houseCreators.includes(creator as `0x${string}`)) kind = 'HOUSE';
    const assets = (m?.assets ?? []).filter((s) => tokenBySymbol(s));
    return {
      name: m?.name ?? 'Unnamed strategy',
      description: m?.description ?? 'Registered on-chain without Receipts metadata.',
      template: m?.template ?? 'external',
      params: m?.params ?? {},
      assets,
      kind,
      modelId: isAi ? (m?.modelId ?? null) : null,
    };
  }

  async mergeMetadata(id: number, uri: string): Promise<void> {
    const s = await this.prisma.strategy.findUnique({ where: { id } });
    if (!s) return;
    const meta = await this.resolveMetadata(uri, s.creatorAddr, s.modelHash ?? ZERO32);
    await this.prisma.strategy.update({
      where: { id },
      data: {
        name: meta.name,
        slug: slugify(meta.name, id),
        description: meta.description,
        template: meta.template,
        params: meta.params as Prisma.InputJsonValue,
        assets: meta.assets,
        category: categoryOf(meta.assets),
        kind: meta.kind,
        metadataURI: uri,
      },
    });
  }

  async onCommitted(l: DecodedLog): Promise<void> {
    const strategyId = Number(l.args.id as bigint);
    const nonce = Number(l.args.nonce as bigint);
    const strategy = await this.prisma.strategy.findUnique({ where: { id: strategyId } });
    if (!strategy) {
      this.log.warn({ strategyId }, 'commit for unknown strategy (registered before START_BLOCK?)');
      return;
    }
    const data = {
      hash: (l.args.hash as string).toLowerCase(),
      committedAt: this.at(l),
      committedL2Block: l.args.l2Block as bigint,
      commitTx: l.txHash,
      revealDeadline: new Date(Number(l.args.revealDeadline as bigint) * 1000),
    };
    const c = await this.prisma.commit.upsert({
      where: { strategyId_nonce: { strategyId, nonce } },
      create: { strategyId, nonce, status: 'COMMITTED', ...data },
      update: data,
    });
    // Chainlink snapshot at the commit block (paper performance + receipt checks)
    const tokens = this.snapshotTokens(strategy.assets);
    const rounds = await readFeeds(this.client, tokens, l.blockNumber);
    if (rounds.length) {
      await this.prisma.pricePoint.createMany({
        data: rounds.map((r) => ({
          token: r.token.symbol,
          feed: r.token.feed.toLowerCase(),
          priceUsd: usdDec(r.price18),
          roundId: r.roundId.toString(),
          updatedAt: new Date(Number(r.updatedAt) * 1000),
        })),
        skipDuplicates: true,
      });
    }
    this.publisher.push({
      type: 'receipt.committed',
      data: { receiptNo: c.receiptNo, strategyId, nonce, hash: data.hash, txHash: l.txHash },
    });
  }

  private snapshotTokens(assets: readonly string[]): TokenInfo[] {
    const set = new Map<string, TokenInfo>();
    const b = baseToken();
    set.set(b.symbol, b);
    for (const s of assets) {
      const t = tokenBySymbol(s);
      if (t) set.set(t.symbol, t);
    }
    return set.size > 1 ? [...set.values()] : [...TOKENS];
  }

  async onRevealed(l: DecodedLog): Promise<void> {
    const strategyId = Number(l.args.id as bigint);
    const nonce = Number(l.args.nonce as bigint);
    const commit = await this.prisma.commit.findUnique({
      where: { strategyId_nonce: { strategyId, nonce } },
    });
    if (!commit) return;
    const tokenIn = (l.args.tokenIn as string).toLowerCase();
    const tokenOut = (l.args.tokenOut as string).toLowerCase();
    const [pin, pout] = await Promise.all([
      this.priceAt(tokenIn, commit.committedAt, commit.committedL2Block),
      this.priceAt(tokenOut, commit.committedAt, commit.committedL2Block),
    ]);
    const c = await this.prisma.commit.update({
      where: { id: commit.id },
      data: {
        status: 'REVEALED',
        tokenIn,
        tokenOut,
        sizeBps: Number(l.args.sizeBps),
        promptHash: (l.args.promptHash as string).toLowerCase(),
        salt: (l.args.salt as string).toLowerCase(),
        revealedAt: this.at(l),
        revealTx: l.txHash,
        revealBlock: l.blockNumber,
        priceInAtCommit: pin,
        priceOutAtCommit: pout,
      },
    });
    this.publisher.push({
      type: 'receipt.revealed',
      data: { receiptNo: c.receiptNo, strategyId, nonce, txHash: l.txHash },
    });
  }

  /** Chainlink price valid at the commit: latest stored round with updatedAt ≤ commit time, else an archive read. */
  private async priceAt(tokenAddr: string, at: Date, block: bigint): Promise<Prisma.Decimal | null> {
    const t = tokenByAddress(tokenAddr);
    if (!t) return null;
    const p = await this.prisma.pricePoint.findFirst({
      where: { feed: t.feed.toLowerCase(), updatedAt: { lte: at } },
      orderBy: { updatedAt: 'desc' },
    });
    if (p) return p.priceUsd;
    const r = await readFeed(this.client, t, block);
    return r ? usdDec(r.price18) : null;
  }

  async onMissed(l: DecodedLog): Promise<void> {
    const strategyId = Number(l.args.id as bigint);
    const nonce = Number(l.args.nonce as bigint);
    const c = await this.prisma.commit.updateMany({
      where: { strategyId, nonce },
      data: { status: 'MISSED', missedTx: l.txHash, missedBlock: l.blockNumber },
    });
    if (c.count) {
      const row = await this.prisma.commit.findUnique({ where: { strategyId_nonce: { strategyId, nonce } } });
      this.publisher.push({
        type: 'receipt.missed',
        data: { receiptNo: row?.receiptNo, strategyId, nonce, txHash: l.txHash },
      });
    }
  }

  async refreshStrategy(id: number): Promise<void> {
    const exists = await this.prisma.strategy.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return;
    try {
      const s = await this.client.readContract({
        address: this.cfg.registry,
        abi: signalRegistryAbi,
        functionName: 'strategyOf',
        args: [BigInt(id)],
      });
      await this.prisma.strategy.update({
        where: { id },
        data: {
          signerAddr: s.signer.toLowerCase(),
          active: s.active,
          creatorShareBps: s.creatorShareBps,
          commitCount: Number(s.commitCount),
          revealCount: Number(s.revealCount),
          missedCount: Number(s.missedCount),
        },
      });
    } catch (err) {
      this.log.warn({ id, err: String(err) }, 'refreshStrategy failed');
    }
  }

  // ───────────────────────── factory + vaults

  async onVaultCreated(l: DecodedLog): Promise<void> {
    const address = (l.args.vault as string).toLowerCase();
    const owner = (l.args.owner as string).toLowerCase();
    const base = {
      ownerAddr: owner,
      createdTx: l.txHash,
      createdAt: this.at(l),
      createdBlock: l.blockNumber,
      isHouse: this.cfg.houseVaults.includes(address as `0x${string}`),
    };
    await this.prisma.vault.upsert({
      where: { address },
      create: { address, ...base, maxSlippageBps: 0, dailyLimitUsd: dec(0), drawdownBps: 0 },
      update: base,
    });
    await this.prisma.vaultEvent.upsert({
      where: { txHash_logIndex: { txHash: l.txHash, logIndex: l.logIndex } },
      create: {
        vaultAddr: address,
        type: 'CREATED',
        data: { owner },
        txHash: l.txHash,
        logIndex: l.logIndex,
        blockNumber: l.blockNumber,
        at: this.at(l),
      },
      update: {},
    });
    await this.refreshVault(address as Address);
  }

  async onVaultEvent(l: DecodedLog): Promise<void> {
    const type = vaultEventType[l.eventName];
    const at = this.at(l);
    if (type) {
      await this.prisma.vaultEvent.upsert({
        where: { txHash_logIndex: { txHash: l.txHash, logIndex: l.logIndex } },
        create: {
          vaultAddr: l.address,
          type,
          data: jsonArgs(l.args),
          txHash: l.txHash,
          logIndex: l.logIndex,
          blockNumber: l.blockNumber,
          at,
        },
        update: {},
      });
      this.publisher.push({
        type: 'vault.event',
        data: { vault: l.address, type, txHash: l.txHash, args: jsonArgs(l.args) },
      });
    }
    if (l.eventName === 'Executed') await this.onExecuted(l, at);
    if (l.eventName === 'BreakerTripped' && this.cfg.houseVaults.includes(l.address as `0x${string}`)) {
      await this.alert('warn', 'breaker_house', `Breaker tripped on house vault ${l.address}`, {
        txHash: l.txHash,
      });
    }
  }

  async onExecuted(l: DecodedLog, at: Date): Promise<void> {
    const strategyId = Number(l.args.strategyId as bigint);
    const nonce = Number(l.args.nonce as bigint);
    const commit = await this.prisma.commit.findUnique({
      where: { strategyId_nonce: { strategyId, nonce } },
    });
    if (!commit) {
      this.log.warn({ strategyId, nonce, tx: l.txHash }, 'execution without indexed commit');
      return;
    }
    const tokenIn = (l.args.tokenIn as string).toLowerCase();
    const tokenOut = (l.args.tokenOut as string).toLowerCase();
    const amountOut = l.args.amountOut as bigint;
    const valueUsd = l.args.valueUsd as bigint;
    const slippage = await this.slippageVsOracle(tokenOut, valueUsd, amountOut, l.blockNumber);
    const e = await this.prisma.execution.upsert({
      where: { txHash_logIndex: { txHash: l.txHash, logIndex: l.logIndex } },
      create: {
        vaultAddr: l.address,
        commitId: commit.id,
        strategyId,
        nonce,
        tokenIn,
        tokenOut,
        amountIn: dec(l.args.amountIn as bigint),
        amountOut: dec(amountOut),
        valueUsd: usdDec(valueUsd),
        minOut: dec(l.args.minOutEnforced as bigint),
        slippageVsOracleBps: slippage,
        txHash: l.txHash,
        logIndex: l.logIndex,
        blockNumber: l.blockNumber,
        executedAt: at,
      },
      update: {},
    });
    this.publisher.push({
      type: 'receipt.executed',
      data: {
        receiptNo: commit.receiptNo,
        strategyId,
        nonce,
        vault: l.address,
        executionId: e.id,
        txHash: l.txHash,
      },
    });
  }

  /** Bps the fill was below the oracle at that block (negative = better than oracle). */
  private async slippageVsOracle(
    tokenOut: string,
    valueUsd: bigint,
    amountOut: bigint,
    block: bigint,
  ): Promise<number> {
    const t = tokenByAddress(tokenOut);
    if (!t) return 0;
    const r = await readFeed(this.client, t, block);
    if (!r) return 0;
    const decimals = await tokenDecimals(this.client, t.address).catch(() => null);
    if (decimals === null) return 0;
    const expected = (valueUsd * 10n ** BigInt(decimals)) / r.price18;
    if (expected === 0n) return 0;
    const bps = ((expected - amountOut) * 10_000n) / expected;
    return Number(bps > 100_000n ? 100_000n : bps < -100_000n ? -100_000n : bps);
  }

  async refreshVault(address: Address): Promise<void> {
    const read = <T>(functionName: string): Promise<T> =>
      this.client.readContract({
        address,
        abi: receiptsVaultAbi,
        functionName: functionName as never,
      }) as Promise<T>;
    try {
      const [
        followingId,
        allocationUsd,
        maxSlippageBps,
        dailyLimitUsd,
        drawdownBps,
        paused,
        operator,
        peak,
        hwm,
      ] = await Promise.all([
        read<bigint>('followingId'),
        read<bigint>('allocationUsd'),
        read<number>('maxSlippageBps'),
        read<bigint>('dailyLimitUsd'),
        read<number>('drawdownBps'),
        read<boolean>('paused'),
        read<string>('operator'),
        read<bigint>('peakNav'),
        read<bigint>('hwmNav'),
      ]);
      const nav = await read<bigint>('navLenient').catch(() => null);
      const fid = Number(followingId);
      const strategyExists =
        fid > 0 ? await this.prisma.strategy.findUnique({ where: { id: fid }, select: { id: true } }) : null;
      await this.prisma.vault.update({
        where: { address },
        data: {
          followingId: strategyExists ? fid : null,
          allocationUsd: usdDec(allocationUsd),
          maxSlippageBps,
          dailyLimitUsd: usdDec(dailyLimitUsd),
          drawdownBps,
          paused,
          operator:
            operator.toLowerCase() === '0x0000000000000000000000000000000000000000'
              ? null
              : operator.toLowerCase(),
          peakNavUsd: usdDec(peak),
          hwmNavUsd: usdDec(hwm),
          ...(nav !== null ? { navUsd: usdDec(nav) } : {}),
        },
      });
    } catch (err) {
      this.log.warn({ address, err: String(err) }, 'refreshVault failed');
    }
  }

  async refreshAllFromChain(): Promise<void> {
    const strategies = await this.prisma.strategy.findMany({ select: { id: true } });
    await mapLimit(strategies, 3, (s) => this.refreshStrategy(s.id));
    const vaults = await this.prisma.vault.findMany({ select: { address: true } });
    await mapLimit(vaults, 3, (v) => this.refreshVault(v.address as Address));
  }

  // ───────────────────────── match check

  /** Vault allocation in force at a block: last FOLLOWED / ALLOCATION event at or before it. */
  private async allocationAt(vault: string, block: bigint): Promise<bigint | null> {
    const ev = await this.prisma.vaultEvent.findFirst({
      where: { vaultAddr: vault, type: { in: ['FOLLOWED', 'ALLOCATION'] }, blockNumber: { lte: block } },
      orderBy: [{ blockNumber: 'desc' }, { logIndex: 'desc' }],
    });
    const v = (ev?.data as { allocationUsd?: string } | undefined)?.allocationUsd;
    return v !== undefined ? BigInt(v) : null;
  }

  async runMatchCheck(strategyId: number, nonce: number): Promise<void> {
    const c = await this.prisma.commit.findUnique({
      where: { strategyId_nonce: { strategyId, nonce } },
      include: { executions: true },
    });
    if (!c || c.status !== 'REVEALED' || !c.tokenIn || !c.tokenOut || c.sizeBps === null) return;
    const execs = await Promise.all(
      c.executions.map(async (e) => ({
        vault: e.vaultAddr,
        tokenIn: e.tokenIn,
        tokenOut: e.tokenOut,
        valueUsd: BigInt(e.valueUsd.mul('1e18').toFixed(0)),
        allocationUsd: await this.allocationAt(e.vaultAddr, e.blockNumber),
      })),
    );
    const r = matchCheck(
      { tokenIn: c.tokenIn, tokenOut: c.tokenOut, sizeBps: c.sizeBps },
      baseToken().address,
      execs,
    );
    await this.prisma.commit.update({
      where: { id: c.id },
      data: { matchStatus: r.status, matchNote: r.note },
    });
    if (r.status === 'MISMATCH') {
      await this.alert('critical', 'mismatch', `Receipt #${c.receiptNo} mismatch: ${r.note}`, {
        strategyId,
        nonce,
        revealTx: c.revealTx ? explorerTx(c.revealTx) : null,
      });
    }
  }

  async alert(
    level: 'info' | 'warn' | 'critical',
    kind: string,
    message: string,
    data?: Record<string, unknown>,
  ) {
    this.log[level === 'critical' ? 'error' : level === 'warn' ? 'warn' : 'info']({ kind, ...data }, message);
    await this.prisma.alertLog.create({
      data: { level, kind, message, data: (data ?? {}) as Prisma.InputJsonObject },
    });
  }
}
