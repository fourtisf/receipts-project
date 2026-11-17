import type { Commit, Execution, Prisma, Strategy, Vault, VaultEvent } from '@receipts/db';
import {
  baseToken,
  explorerTx,
  hashSignal,
  tokenByAddress,
  tokenBySymbol,
  type ReceiptCheck,
  type ReceiptDetail,
  type ReceiptSummary,
  type StrategyListItem,
} from '@receipts/shared';
import { templateById } from '@receipts/strategies';

export function pct(d: Prisma.Decimal | null | undefined): number | null {
  if (d === null || d === undefined) return null;
  return Math.round(Number(d.toString()) * 10_000) / 100;
}

export function decStr(d: Prisma.Decimal | null | undefined, frac?: number): string {
  if (d === null || d === undefined) return '0';
  return frac === undefined ? d.toFixed() : d.toFixed(frac);
}

export function source(txHash: string, blockNumber: bigint | number | string) {
  return { txHash, blockNumber: blockNumber.toString(), explorerUrl: explorerTx(txHash) };
}

const LABEL: Record<string, string> = { WETH: 'ETH', cbBTC: 'cbBTC' };

/** Human market label as in the prototype: "ETH / USDG", "SPY, QQQ", "7 stock tokens". */
export function marketLabel(assets: readonly string[]): string {
  if (assets.length === 0) return 'Unspecified';
  if (assets.length === 1) return `${LABEL[assets[0]!] ?? assets[0]} / USDG`;
  const kinds = new Set(assets.map((a) => tokenBySymbol(a)?.kind));
  if (assets.length > 3)
    return kinds.size === 1 && kinds.has('stock')
      ? `${assets.length} stock tokens`
      : `${assets.length} assets`;
  return assets.map((a) => LABEL[a] ?? a).join(', ');
}

export function strategyItem(s: Strategy, houseVault?: string | null): StrategyListItem {
  const ret = pct(s.ret30d);
  const hold = pct(s.hold30d);
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    kind: s.kind,
    category: s.category,
    template: s.template,
    templateName: templateById(s.template)?.name ?? (s.template === 'external' ? 'External' : s.template),
    market: marketLabel(s.assets),
    assets: s.assets,
    creator: s.creatorAddr,
    modelId: s.modelId,
    ret30d: ret,
    hold30d: hold,
    vsHold: ret !== null && hold !== null ? Math.round((ret - hold) * 100) / 100 : null,
    maxDrawdown30d: pct(s.maxDrawdown30d),
    receipts: s.commitCount,
    missed: s.missedCount,
    followers: s.followers,
    aumUsd: decStr(s.aumUsd, 2),
    creatorShareBps: s.creatorShareBps,
    house: s.kind === 'HOUSE' || Boolean(houseVault),
    active: s.active,
  };
}

type CommitWithRelations = Commit & { strategy: Strategy; executions: Execution[] };

function sideOf(c: Commit): { side: 'BUY' | 'SELL' | null; asset: string | null } {
  if (!c.tokenIn || !c.tokenOut) return { side: null, asset: null };
  const base = baseToken().address.toLowerCase();
  if (c.tokenIn === base) return { side: 'BUY', asset: tokenByAddress(c.tokenOut)?.symbol ?? null };
  if (c.tokenOut === base) return { side: 'SELL', asset: tokenByAddress(c.tokenIn)?.symbol ?? null };
  return { side: null, asset: null };
}

/** Fill price in USD per asset unit, volume-weighted over executions (decimals from config tokens). */
function fillPrice(
  c: CommitWithRelations,
  side: 'BUY' | 'SELL' | null,
  decimalsOf: (addr: string) => number,
): string | null {
  if (!side || c.executions.length === 0) return null;
  let usd = 0;
  let qty = 0;
  for (const e of c.executions) {
    if (side === 'BUY') {
      usd += Number(e.valueUsd.toString());
      qty += Number(e.amountOut.toString()) / 10 ** decimalsOf(e.tokenOut);
    } else {
      qty += Number(e.amountIn.toString()) / 10 ** decimalsOf(e.tokenIn);
      usd += Number(e.amountOut.toString()) / 10 ** decimalsOf(e.tokenOut);
    }
  }
  return qty > 0 ? (usd / qty).toFixed(6) : null;
}

export function receiptSummary(c: CommitWithRelations, decimalsOf: (addr: string) => number): ReceiptSummary {
  const { side, asset } = sideOf(c);
  const value = c.executions.reduce((acc, e) => acc + Number(e.valueUsd.toString()), 0);
  const oracle = side === 'BUY' ? c.priceOutAtCommit : side === 'SELL' ? c.priceInAtCommit : null;
  const slip =
    c.executions.length > 0
      ? Math.round(c.executions.reduce((a, e) => a + e.slippageVsOracleBps, 0) / c.executions.length)
      : null;
  return {
    receiptNo: c.receiptNo,
    strategyId: c.strategyId,
    strategyName: c.strategy.name,
    strategySlug: c.strategy.slug,
    nonce: c.nonce,
    hash: c.hash,
    status: c.status,
    matchStatus: c.matchStatus,
    committedAt: c.committedAt.toISOString(),
    revealDeadline: c.revealDeadline.toISOString(),
    revealedAt: c.revealedAt?.toISOString() ?? null,
    tokenInSymbol: c.tokenIn ? (tokenByAddress(c.tokenIn)?.symbol ?? null) : null,
    tokenOutSymbol: c.tokenOut ? (tokenByAddress(c.tokenOut)?.symbol ?? null) : null,
    sizeBps: c.sizeBps,
    side,
    asset,
    executions: c.executions.length,
    valueUsd: value.toFixed(2),
    oraclePriceUsd: oracle ? oracle.toFixed(6) : null,
    fillPriceUsd: fillPrice(c, side, decimalsOf),
    slippageBps: slip,
    committedL2Block: c.committedL2Block.toString(),
  };
}

export interface CheckContext {
  chainId: number;
  registry: string | null;
  /** max slippage (bps) in force for a vault at a block */
  slippageLimitAt: (vault: string, block: bigint) => number;
}

/** checks[] exactly in the order of API.md. */
export function receiptChecks(c: CommitWithRelations, ctx: CheckContext): ReceiptCheck[] {
  const checks: ReceiptCheck[] = [];
  checks.push({
    id: 'commit_found',
    ok: true,
    title: 'Commit found on-chain',
    detail: `Hash ${c.hash} committed in L2 block ${c.committedL2Block.toString()}.`,
    txHash: c.commitTx,
  });

  if (c.status === 'REVEALED' && c.tokenIn && c.tokenOut && c.sizeBps !== null && c.salt && c.promptHash) {
    let ok = false;
    if (ctx.registry) {
      const h = hashSignal({
        chainId: ctx.chainId,
        registry: ctx.registry as `0x${string}`,
        strategyId: c.strategyId,
        nonce: c.nonce,
        signal: {
          tokenIn: c.tokenIn as `0x${string}`,
          tokenOut: c.tokenOut as `0x${string}`,
          sizeBps: c.sizeBps,
          promptHash: c.promptHash as `0x${string}`,
        },
        salt: c.salt as `0x${string}`,
      });
      ok = h.toLowerCase() === c.hash.toLowerCase();
    }
    checks.push({
      id: 'reveal_matches',
      ok,
      title: ok ? 'Reveal matches the commit' : 'Reveal does not match the commit',
      detail: ok
        ? 'Recomputed hashSignal(chainId, registry, strategy, nonce, signal, salt) equals the committed hash.'
        : 'The recomputed hash differs from the committed hash.',
      ...(c.revealTx ? { txHash: c.revealTx } : {}),
    });
  } else if (c.status === 'MISSED') {
    checks.push({
      id: 'reveal_matches',
      ok: false,
      title: 'Reveal missed',
      detail: `Not revealed before ${c.revealDeadline.toISOString()}. Counted as a missed reveal forever.`,
      ...(c.missedTx ? { txHash: c.missedTx } : {}),
    });
  } else {
    checks.push({
      id: 'reveal_matches',
      ok: null,
      title: 'Waiting for reveal',
      detail: `The signal stays hidden until it is revealed (deadline ${c.revealDeadline.toISOString()}).`,
    });
  }

  if (c.executions.length === 0) {
    checks.push({
      id: 'executed_after_commit',
      ok: null,
      title: 'No vault executed this signal',
      detail: 'Paper signal: performance uses the Chainlink price at the commit block.',
    });
    checks.push({
      id: 'price_within_oracle',
      ok: null,
      title: 'No fills to compare',
      detail: 'Nothing was swapped.',
    });
    checks.push({
      id: 'balance_changed_correctly',
      ok: null,
      title: 'No balance changes',
      detail: 'Nothing was swapped.',
    });
    return checks;
  }

  const late = c.executions.filter((e) => e.blockNumber <= c.committedL2Block);
  checks.push({
    id: 'executed_after_commit',
    ok: late.length === 0,
    title: late.length === 0 ? 'Executed after the commit' : 'Execution not after the commit',
    detail:
      late.length === 0
        ? `All ${c.executions.length} execution(s) are in later L2 blocks than the commit.`
        : `${late.length} execution(s) are not in a later L2 block than the commit.`,
    txHash: c.executions[0]!.txHash,
  });

  const outside = c.executions.filter(
    (e) => e.slippageVsOracleBps > ctx.slippageLimitAt(e.vaultAddr, e.blockNumber),
  );
  const worst = Math.max(...c.executions.map((e) => e.slippageVsOracleBps));
  checks.push({
    id: 'price_within_oracle',
    ok: outside.length === 0,
    title: outside.length === 0 ? 'Fills within the oracle limit' : 'Fill outside the oracle limit',
    detail: `Worst fill was ${(worst / 100).toFixed(2)}% from the Chainlink price at its block.`,
  });

  const bad = c.executions.filter((e) => e.amountOut.lt(e.minOut));
  checks.push({
    id: 'balance_changed_correctly',
    ok: bad.length === 0,
    title: bad.length === 0 ? 'Balances changed correctly' : 'Balance change below minimum',
    detail:
      bad.length === 0
        ? 'Every Executed event delivered at least the enforced minimum output to the vault.'
        : `${bad.length} execution(s) delivered less than the enforced minimum.`,
    txHash: c.executions[0]!.txHash,
  });
  return checks;
}

export function receiptDetail(
  c: CommitWithRelations & {
    aiArtifact: {
      model: string;
      prompt: string;
      inputs: unknown;
      output: unknown;
      promptHash: string;
      publishedAt: Date | null;
    } | null;
  },
  ctx: CheckContext,
  decimalsOf: (addr: string) => number,
): ReceiptDetail {
  const s = receiptSummary(c, decimalsOf);
  return {
    ...s,
    commit: source(c.commitTx, c.committedL2Block),
    reveal: c.revealTx ? source(c.revealTx, c.revealBlock ?? 0n) : null,
    missed: c.missedTx ? source(c.missedTx, c.missedBlock ?? 0n) : null,
    signal:
      c.status === 'REVEALED' && c.tokenIn && c.tokenOut && c.sizeBps !== null
        ? {
            tokenIn: c.tokenIn,
            tokenOut: c.tokenOut,
            sizeBps: c.sizeBps,
            promptHash: c.promptHash ?? '',
            salt: c.salt ?? '',
          }
        : null,
    prices: {
      tokenInAtCommit: c.priceInAtCommit ? c.priceInAtCommit.toFixed() : null,
      tokenOutAtCommit: c.priceOutAtCommit ? c.priceOutAtCommit.toFixed() : null,
    },
    matchNote: c.matchNote,
    executionList: c.executions
      .sort((a, b) =>
        a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
      )
      .map((e) => ({
        vault: e.vaultAddr,
        tokenIn: e.tokenIn,
        tokenOut: e.tokenOut,
        tokenInSymbol: tokenByAddress(e.tokenIn)?.symbol ?? null,
        tokenOutSymbol: tokenByAddress(e.tokenOut)?.symbol ?? null,
        amountIn: e.amountIn.toFixed(),
        amountOut: e.amountOut.toFixed(),
        valueUsd: e.valueUsd.toFixed(),
        minOut: e.minOut.toFixed(),
        slippageVsOracleBps: e.slippageVsOracleBps,
        executedAt: e.executedAt.toISOString(),
        source: source(e.txHash, e.blockNumber),
      })),
    checks: receiptChecks(c, ctx),
    registry: ctx.registry,
    chainId: ctx.chainId,
    // AI prompt and inputs are public only once revealed (never before)
    ai:
      c.aiArtifact && c.status === 'REVEALED' && c.aiArtifact.publishedAt
        ? {
            model: c.aiArtifact.model,
            prompt: c.aiArtifact.prompt,
            inputs: c.aiArtifact.inputs,
            output: c.aiArtifact.output,
            promptHash: c.aiArtifact.promptHash,
          }
        : null,
  };
}

export function vaultEventOut(e: VaultEvent) {
  return {
    type: e.type,
    data: (e.data ?? {}) as Record<string, unknown>,
    at: e.at.toISOString(),
    source: source(e.txHash, e.blockNumber),
  };
}

export function vaultOut(v: Vault & { events: VaultEvent[] }, followingName: string | null) {
  return {
    address: v.address,
    owner: v.ownerAddr,
    followingId: v.followingId,
    followingName,
    allocationUsd: v.allocationUsd.toFixed(),
    maxSlippageBps: v.maxSlippageBps,
    dailyLimitUsd: v.dailyLimitUsd.toFixed(),
    drawdownBps: v.drawdownBps,
    paused: v.paused,
    operator: v.operator,
    navUsd: v.navUsd.toFixed(),
    peakNavUsd: v.peakNavUsd.toFixed(),
    hwmNavUsd: v.hwmNavUsd.toFixed(),
    isHouse: v.isHouse,
    created: source(v.createdTx, v.createdBlock),
    events: v.events.map(vaultEventOut),
  };
}
