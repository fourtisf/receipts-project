import { decodeEventLog, type Address, type Hex, type TransactionReceipt } from 'viem';
import type { Redis } from 'ioredis';
import { Prisma, type PrismaClient } from '@receipts/db';
import {
  aiPromptHash,
  baseToken,
  hashSignal,
  tokenByAddress,
  tokenBySymbol,
  ZERO_HASH,
  type Signal,
} from '@receipts/shared';
import { erc20Abi, receiptsVaultAbi, signalRegistryAbi } from '@receipts/shared/abi';
import type { SignalOut } from '@receipts/strategies';
import type { Client } from '../chain.js';
import type { Logger } from '../log.js';
import { withKeyLock, type KeyedWallet } from './keys.js';
import { SecretBox, randomSalt } from './secrets.js';

export interface AiArtifactInput {
  model: string;
  prompt: string;
  inputs: unknown;
  output: unknown;
}

interface StoredSecret {
  signal: Signal;
  salt: Hex;
  ai: AiArtifactInput | null;
}

export interface ExecutorDeps {
  prisma: PrismaClient;
  client: Client;
  redis: Redis;
  log: Logger;
  registry: Address;
  chainId: number;
  executor: KeyedWallet | null;
  signers: Map<string, KeyedWallet>;
  box: SecretBox;
  alert: (
    level: 'info' | 'warn' | 'critical',
    kind: string,
    message: string,
    data?: Record<string, unknown>,
  ) => Promise<void>;
  /** operator slippage buffer on top of the simulated fill (D-010) */
  operatorBufferBps?: number;
}

export type VaultPlan =
  | { vault: Address; amountIn: bigint; minOut: bigint; simulatedOut: bigint }
  | { vault: Address; skip: string };

const BPS = 10_000n;

/**
 * Commit → execute → reveal pipeline (WORKER.md §4) for one signal of one strategy run by our signers.
 * Safety properties:
 *  - the encrypted salt + signal are stored BEFORE the commit transaction is sent, so a crash can always be revealed
 *    (recoverPending) — a missed reveal would be public forever;
 *  - executions only for vaults that follow the strategy, are not paused and have our executor as operator;
 *    sizes clamp to the remaining daily limit, balance and allocation headroom; each is simulated first;
 *  - nothing here can move funds anywhere but inside the vault (contract-enforced).
 */
export class Executor {
  private readonly buffer: bigint;

  constructor(private readonly d: ExecutorDeps) {
    this.buffer = BigInt(d.operatorBufferBps ?? 50);
  }

  toSignal(sig: SignalOut, ai: AiArtifactInput | null): Signal {
    const base = baseToken();
    const asset = tokenBySymbol(sig.asset);
    if (!asset || asset.kind === 'base') throw new Error(`Unknown or base asset ${sig.asset}`);
    const promptHash = ai ? aiPromptHash(ai.prompt, ai.inputs) : ZERO_HASH;
    return sig.side === 'BUY'
      ? { tokenIn: base.address, tokenOut: asset.address, sizeBps: sig.sizeBps, promptHash }
      : { tokenIn: asset.address, tokenOut: base.address, sizeBps: sig.sizeBps, promptHash };
  }

  /** Full pipeline. Returns the committed nonce. */
  async run(strategyId: number, sig: SignalOut, ai: AiArtifactInput | null = null): Promise<number> {
    const { nonce, commitBlock } = await this.commit(strategyId, this.toSignal(sig, ai), ai);
    await this.waitForBlockAfter(commitBlock);
    if (this.d.executor) await this.executeAll(strategyId, nonce, this.toSignal(sig, ai));
    await this.reveal(strategyId, nonce);
    return nonce;
  }

  async commit(
    strategyId: number,
    signal: Signal,
    ai: AiArtifactInput | null,
  ): Promise<{ nonce: number; commitBlock: bigint }> {
    const { prisma, client, registry, box } = this.d;
    const strategy = await prisma.strategy.findUnique({ where: { id: strategyId } });
    if (!strategy) throw new Error(`Strategy ${strategyId} not indexed`);
    const signer = this.d.signers.get(strategy.signerAddr.toLowerCase());
    if (!signer) throw new Error(`No signer key for strategy ${strategyId}`);

    return withKeyLock(this.d.redis, signer.address, async () => {
      const s = await client.readContract({
        address: registry,
        abi: signalRegistryAbi,
        functionName: 'strategyOf',
        args: [BigInt(strategyId)],
      });
      if (!s.active) throw new Error(`Strategy ${strategyId} is inactive`);
      if (s.signer.toLowerCase() !== signer.address)
        throw new Error(`Signer rotated for strategy ${strategyId}`);
      const nonce = s.commitCount;
      const salt = randomSalt();
      const hash = hashSignal({ chainId: this.d.chainId, registry, strategyId, nonce, signal, salt });
      const onchain = await client.readContract({
        address: registry,
        abi: signalRegistryAbi,
        functionName: 'hashSignal',
        args: [BigInt(strategyId), nonce, signal, salt],
      });
      if (onchain.toLowerCase() !== hash.toLowerCase())
        throw new Error('Local hashSignal differs from SignalRegistry.hashSignal — refusing to commit');

      const secret: StoredSecret = { signal, salt, ai };
      await prisma.secretSalt.upsert({
        where: { strategyId_nonce: { strategyId, nonce: Number(nonce) } },
        create: {
          strategyId,
          nonce: Number(nonce),
          signalEnc: box.encrypt(JSON.stringify(secret)),
          saltEnc: box.encrypt(salt),
        },
        update: {
          signalEnc: box.encrypt(JSON.stringify(secret)),
          saltEnc: box.encrypt(salt),
          revealedAt: null,
        },
      });

      const txHash = await signer.wallet.writeContract({
        address: registry,
        abi: signalRegistryAbi,
        functionName: 'commit',
        args: [BigInt(strategyId), hash],
        account: signer.wallet.account!,
        chain: signer.wallet.chain,
      });
      const rcpt = await this.wait(txHash, 'commit');
      const ev = this.findEvent(rcpt, 'Committed');
      if (!ev || BigInt(ev.nonce as bigint) !== nonce)
        throw new Error(`Commit receipt nonce mismatch for strategy ${strategyId}`);
      this.d.log.info({ strategyId, nonce: Number(nonce), tx: txHash }, 'committed');
      return { nonce: Number(nonce), commitBlock: rcpt.blockNumber };
    });
  }

  private findEvent(rcpt: TransactionReceipt, name: string): Record<string, unknown> | null {
    for (const l of rcpt.logs) {
      if (l.address.toLowerCase() !== this.d.registry.toLowerCase()) continue;
      try {
        const e = decodeEventLog({ abi: signalRegistryAbi, data: l.data, topics: l.topics as never });
        if (e.eventName === name) return e.args as unknown as Record<string, unknown>;
      } catch {
        /* other event */
      }
    }
    return null;
  }

  private async wait(hash: Hex, what: string): Promise<TransactionReceipt> {
    const rcpt = await this.d.client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    await this.d.redis.incr(
      `tx:${rcpt.status === 'success' ? 'ok' : 'fail'}:${Math.floor(Date.now() / 900_000)}`,
    );
    if (rcpt.status !== 'success') throw new Error(`${what} reverted (${hash})`);
    return rcpt;
  }

  /** Waits until the chain is past `block` (the vault requires a later L2 block than the commit). */
  async waitForBlockAfter(block: bigint, timeoutMs = 120_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if ((await this.d.client.getBlockNumber()) > block) return;
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error('Timed out waiting for the next L2 block');
  }

  /** Sizing + simulation for one vault. Never throws: returns a skip reason instead. */
  async planVault(vault: Address, strategyId: number, nonce: number, signal: Signal): Promise<VaultPlan> {
    const { client } = this.d;
    const executor = this.d.executor;
    if (!executor) return { vault, skip: 'no executor key' };
    const read = <T>(functionName: string, args: unknown[] = []) =>
      client.readContract({
        address: vault,
        abi: receiptsVaultAbi,
        functionName: functionName as never,
        args: args as never,
      }) as Promise<T>;
    try {
      const [following, paused, operator, remaining, allocation] = await Promise.all([
        read<bigint>('followingId'),
        read<boolean>('paused'),
        read<string>('operator'),
        read<bigint>('remainingDailyUsd'),
        read<bigint>('allocationUsd'),
      ]);
      if (Number(following) !== strategyId) return { vault, skip: 'no longer following' };
      if (paused) return { vault, skip: 'paused' };
      if (operator.toLowerCase() !== executor.address) return { vault, skip: 'operator revoked or changed' };
      const base = baseToken();
      const isBuy = signal.tokenIn.toLowerCase() === base.address.toLowerCase();
      const balance = (await client.readContract({
        address: signal.tokenIn,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [vault],
      })) as bigint;
      const priceIn = await read<bigint>('priceUsd', [signal.tokenIn]); // strict: reverts when stale (weekend stocks)
      const decIn = isBuy ? base.decimals : (tokenByAddress(signal.tokenIn)?.decimals ?? 18);
      const unitIn = 10n ** BigInt(decIn);
      const usable = (remaining * 999n) / 1000n; // keep a hair under the window for rounding
      let amountIn: bigint;
      if (isBuy) {
        const exposure = await read<bigint>('exposureUsd');
        let usd = (allocation * BigInt(signal.sizeBps)) / BPS;
        const headroom = allocation > exposure ? allocation - exposure : 0n;
        if (usd > headroom) usd = headroom;
        if (usd > usable) usd = usable;
        amountIn = (usd * unitIn) / priceIn;
        if (amountIn > balance) amountIn = balance;
      } else {
        amountIn = (balance * BigInt(signal.sizeBps)) / BPS;
        const maxByLimit = (usable * unitIn) / priceIn;
        if (amountIn > maxByLimit) amountIn = maxByLimit;
      }
      if (amountIn === 0n) return { vault, skip: 'size clamps to zero (limit, balance or allocation)' };
      const sim = await client.simulateContract({
        account: executor.address,
        address: vault,
        abi: receiptsVaultAbi,
        functionName: 'executeSignal',
        args: [BigInt(nonce), signal.tokenIn, signal.tokenOut, amountIn, 0n],
      });
      const out = sim.result as bigint;
      if (out === 0n) return { vault, skip: 'drawdown breaker would trip (no swap)' };
      return { vault, amountIn, simulatedOut: out, minOut: (out * (BPS - this.buffer)) / BPS };
    } catch (err) {
      return { vault, skip: `simulation reverted: ${shortErr(err)}` };
    }
  }

  async executeAll(
    strategyId: number,
    nonce: number,
    signal: Signal,
  ): Promise<{ sent: number; skipped: number; failed: number }> {
    const executor = this.d.executor!;
    const vaults = await this.d.prisma.vault.findMany({
      where: { followingId: strategyId, paused: false, operator: executor.address },
      select: { address: true },
    });
    const plans: VaultPlan[] = [];
    for (const v of vaults) plans.push(await this.planVault(v.address as Address, strategyId, nonce, signal));
    const go = plans.filter((p): p is Extract<VaultPlan, { amountIn: bigint }> => 'amountIn' in p);
    for (const p of plans)
      if ('skip' in p)
        this.d.log.info({ strategyId, nonce, vault: p.vault, reason: p.skip }, 'vault skipped');

    let failed = 0;
    await withKeyLock(this.d.redis, executor.address, async () => {
      // send all without waiting (nonce manager orders them), then await receipts: one slow vault never blocks others
      const hashes: { vault: Address; hash: Hex | null }[] = [];
      for (const p of go) {
        try {
          const hash = await executor.wallet.writeContract({
            address: p.vault,
            abi: receiptsVaultAbi,
            functionName: 'executeSignal',
            args: [BigInt(nonce), signal.tokenIn, signal.tokenOut, p.amountIn, p.minOut],
            account: executor.wallet.account!,
            chain: executor.wallet.chain,
          });
          hashes.push({ vault: p.vault, hash });
        } catch (err) {
          failed++;
          this.d.log.warn({ vault: p.vault, err: shortErr(err) }, 'executeSignal send failed');
        }
      }
      const results = await Promise.allSettled(hashes.map((h) => this.wait(h.hash!, 'executeSignal')));
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          failed++;
          this.d.log.warn({ vault: hashes[i]!.vault, err: shortErr(r.reason) }, 'executeSignal failed');
        }
      });
    });
    this.d.log.info(
      { strategyId, nonce, sent: go.length, skipped: plans.length - go.length, failed },
      'executions done',
    );
    return { sent: go.length, skipped: plans.length - go.length, failed };
  }

  /** Reveals a commit from the stored secret; retries until the deadline, alerting when it gets close. */
  async reveal(strategyId: number, nonce: number): Promise<boolean> {
    const { prisma, client, registry, box } = this.d;
    const row = await prisma.secretSalt.findUnique({ where: { strategyId_nonce: { strategyId, nonce } } });
    if (!row || row.revealedAt) return Boolean(row?.revealedAt);
    const secret = JSON.parse(box.decrypt(row.signalEnc)) as StoredSecret;
    const strategy = await prisma.strategy.findUnique({ where: { id: strategyId } });
    const signer = strategy ? this.d.signers.get(strategy.signerAddr.toLowerCase()) : undefined;
    const sender = signer ?? this.d.executor; // anyone holding the preimage may reveal
    if (!sender) throw new Error('No key available to reveal');

    for (let attempt = 0; ; attempt++) {
      const c = await client.readContract({
        address: registry,
        abi: signalRegistryAbi,
        functionName: 'commitOf',
        args: [BigInt(strategyId), BigInt(nonce)],
      });
      if (c.status === 2) return this.markRevealed(row.id, strategyId, nonce, secret);
      if (c.status !== 1) {
        if (c.status === 3)
          await this.d.alert(
            'critical',
            'reveal_risk',
            `Strategy ${strategyId} nonce ${nonce} was marked missed`,
          );
        return false;
      }
      const now = Math.floor(Date.now() / 1000);
      const deadline = Number(c.revealDeadline);
      if (now > deadline) {
        await this.d.alert(
          'critical',
          'reveal_risk',
          `Reveal deadline passed for strategy ${strategyId} nonce ${nonce}`,
        );
        return false;
      }
      try {
        await withKeyLock(this.d.redis, sender.address, async () => {
          const hash = await sender.wallet.writeContract({
            address: registry,
            abi: signalRegistryAbi,
            functionName: 'reveal',
            args: [BigInt(strategyId), BigInt(nonce), secret.signal, secret.salt],
            account: sender.wallet.account!,
            chain: sender.wallet.chain,
          });
          await this.wait(hash, 'reveal');
          this.d.log.info({ strategyId, nonce, tx: hash }, 'revealed');
        });
        return this.markRevealed(row.id, strategyId, nonce, secret);
      } catch (err) {
        if (deadline - now < 600) {
          await this.d.alert(
            'critical',
            'reveal_risk',
            `Reveal for strategy ${strategyId} nonce ${nonce} failing ${Math.floor((deadline - now) / 60)} min before the deadline: ${shortErr(err)}`,
          );
        }
        await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt)));
      }
    }
  }

  private async markRevealed(
    id: string,
    strategyId: number,
    nonce: number,
    secret: StoredSecret,
  ): Promise<boolean> {
    await this.d.prisma.secretSalt.update({ where: { id }, data: { revealedAt: new Date() } });
    if (secret.ai) await this.publishAi(strategyId, nonce, secret.ai);
    return true;
  }

  /** Publishes the AI prompt + inputs + output once revealed (keccak must equal the revealed promptHash). */
  async publishAi(strategyId: number, nonce: number, ai: AiArtifactInput): Promise<void> {
    for (let i = 0; i < 30; i++) {
      const commit = await this.d.prisma.commit.findUnique({
        where: { strategyId_nonce: { strategyId, nonce } },
      });
      if (commit) {
        const promptHash = aiPromptHash(ai.prompt, ai.inputs);
        await this.d.prisma.aiArtifact.upsert({
          where: { commitId: commit.id },
          create: {
            commitId: commit.id,
            model: ai.model,
            prompt: ai.prompt,
            inputs: ai.inputs as Prisma.InputJsonValue,
            output: ai.output as Prisma.InputJsonValue,
            promptHash,
            publishedAt: new Date(),
          },
          update: { publishedAt: new Date() },
        });
        return;
      }
      await new Promise((r) => setTimeout(r, 2000)); // wait for the indexer
    }
    this.d.log.warn({ strategyId, nonce }, 'AI artifact not published yet: commit not indexed');
  }

  /** Crash recovery: reveal every stored secret whose commit is still open; drop secrets of commits never mined. */
  async recoverPending(): Promise<void> {
    const pending = await this.d.prisma.secretSalt.findMany({ where: { revealedAt: null } });
    for (const p of pending) {
      try {
        const s = await this.d.client.readContract({
          address: this.d.registry,
          abi: signalRegistryAbi,
          functionName: 'strategyOf',
          args: [BigInt(p.strategyId)],
        });
        if (BigInt(p.nonce) >= s.commitCount) {
          // commit transaction never landed: the nonce will be reused by the next commit
          await this.d.prisma.secretSalt.delete({ where: { id: p.id } });
          continue;
        }
        await this.reveal(p.strategyId, p.nonce);
      } catch (err) {
        this.d.log.error({ strategyId: p.strategyId, nonce: p.nonce, err: shortErr(err) }, 'recovery failed');
      }
    }
  }
}

/** One-line error, including the decoded custom error name (e.g. DailyLimitExceeded) when viem has it. */
export function shortErr(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  let decoded = '';
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur; i++) {
    const c = cur as {
      data?: { errorName?: string; args?: readonly unknown[] };
      reason?: string;
      cause?: unknown;
    };
    if (c.data?.errorName) {
      decoded = `${c.data.errorName}(${(c.data.args ?? []).map(String).join(', ')})`;
      break;
    }
    if (c.reason) {
      decoded = c.reason;
      break;
    }
    cur = c.cause;
  }
  const head = (e?.shortMessage ?? e?.message ?? String(err)).split('\n')[0]!;
  return (decoded ? `${decoded} — ${head}` : head).slice(0, 300);
}
