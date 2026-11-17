import { z } from 'zod';

/**
 * API contract shared by apps/api (validates every response) and apps/web (parses every response).
 * Money: decimal strings. Percentages: numbers with 2 decimals. Addresses: lowercase.
 */

export const hexAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'Expected a 0x-prefixed 20-byte address')
  .transform((s) => s.toLowerCase() as `0x${string}`);
export const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'Expected a 0x-prefixed 32-byte hex value');
export const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'Expected a decimal string');

export const sourceSchema = z.object({
  txHash: z.string(),
  blockNumber: z.string(),
  explorerUrl: z.string(),
});
export type Source = z.infer<typeof sourceSchema>;

export const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

// ───────────────────────── stats

export const statsSchema = z.object({
  receiptsPrinted: z.number().int(),
  strategiesLive: z.number().int(),
  missedReveals: z.number().int(),
  tvlUsd: decimalString,
  updatedAt: z.string(),
});
export type Stats = z.infer<typeof statsSchema>;

// ───────────────────────── strategies

export const strategyKind = z.enum(['HOUSE', 'TEMPLATE', 'AI']);
export const strategyCategory = z.enum(['CRYPTO', 'STOCK', 'MIXED']);

export const strategyListItemSchema = z.object({
  id: z.number().int(),
  slug: z.string(),
  name: z.string(),
  kind: strategyKind,
  category: strategyCategory,
  template: z.string(),
  templateName: z.string(),
  market: z.string(),
  assets: z.array(z.string()),
  creator: z.string(),
  modelId: z.string().nullable(),
  ret30d: z.number().nullable(),
  hold30d: z.number().nullable(),
  vsHold: z.number().nullable(),
  maxDrawdown30d: z.number().nullable(),
  receipts: z.number().int(),
  missed: z.number().int(),
  followers: z.number().int(),
  aumUsd: decimalString,
  creatorShareBps: z.number().int(),
  house: z.boolean(),
  active: z.boolean(),
});
export type StrategyListItem = z.infer<typeof strategyListItemSchema>;

export const strategyListSchema = z.object({
  items: z.array(strategyListItemSchema),
  nextCursor: z.string().nullable(),
  totals: z.object({ count: z.number().int(), followers: z.number().int(), aumUsd: decimalString }),
});
export type StrategyList = z.infer<typeof strategyListSchema>;

export const strategyDetailSchema = strategyListItemSchema.extend({
  description: z.string(),
  params: z.record(z.unknown()),
  signer: z.string(),
  modelHash: z.string().nullable(),
  revealWindowSec: z.number().int(),
  metadataURI: z.string(),
  commitCount: z.number().int(),
  revealCount: z.number().int(),
  registered: sourceSchema,
  registeredAt: z.string(),
  registry: z.string().nullable(),
  houseVault: z.string().nullable(),
});
export type StrategyDetail = z.infer<typeof strategyDetailSchema>;

export const equityPointSchema = z.object({ at: z.string(), equity: z.number(), hold: z.number() });
export const equitySchema = z.object({
  points: z.array(equityPointSchema),
  basis: z.enum(['live', 'paper', 'mixed']),
});
export type EquityPoint = z.infer<typeof equityPointSchema>;

// ───────────────────────── receipts

export const commitStatus = z.enum(['COMMITTED', 'REVEALED', 'MISSED']);
export const matchStatus = z.enum(['PENDING', 'MATCH', 'MISMATCH', 'NO_EXECUTION']);

export const executionSchema = z.object({
  vault: z.string(),
  tokenIn: z.string(),
  tokenOut: z.string(),
  tokenInSymbol: z.string().nullable(),
  tokenOutSymbol: z.string().nullable(),
  amountIn: decimalString,
  amountOut: decimalString,
  valueUsd: decimalString,
  minOut: decimalString,
  slippageVsOracleBps: z.number().int(),
  executedAt: z.string(),
  source: sourceSchema,
});
export type Execution = z.infer<typeof executionSchema>;

export const receiptCheckSchema = z.object({
  id: z.enum([
    'commit_found',
    'reveal_matches',
    'executed_after_commit',
    'price_within_oracle',
    'balance_changed_correctly',
  ]),
  ok: z.boolean().nullable(), // null = not applicable yet (e.g. not revealed)
  title: z.string(),
  detail: z.string(),
  txHash: z.string().optional(),
});
export type ReceiptCheck = z.infer<typeof receiptCheckSchema>;

export const receiptSummarySchema = z.object({
  receiptNo: z.number().int(),
  strategyId: z.number().int(),
  strategyName: z.string(),
  strategySlug: z.string(),
  nonce: z.number().int(),
  hash: z.string(),
  status: commitStatus,
  matchStatus: matchStatus,
  committedAt: z.string(),
  revealDeadline: z.string(),
  revealedAt: z.string().nullable(),
  tokenInSymbol: z.string().nullable(),
  tokenOutSymbol: z.string().nullable(),
  sizeBps: z.number().int().nullable(),
  side: z.enum(['BUY', 'SELL']).nullable(),
  asset: z.string().nullable(),
  executions: z.number().int(),
  valueUsd: decimalString,
  oraclePriceUsd: decimalString.nullable(),
  fillPriceUsd: decimalString.nullable(),
  slippageBps: z.number().int().nullable(),
  committedL2Block: z.string(),
});
export type ReceiptSummary = z.infer<typeof receiptSummarySchema>;

export const receiptListSchema = z.object({
  items: z.array(receiptSummarySchema),
  nextCursor: z.string().nullable(),
});

export const receiptDetailSchema = receiptSummarySchema.extend({
  commit: sourceSchema,
  reveal: sourceSchema.nullable(),
  missed: sourceSchema.nullable(),
  signal: z
    .object({
      tokenIn: z.string(),
      tokenOut: z.string(),
      sizeBps: z.number().int(),
      promptHash: z.string(),
      salt: z.string(),
    })
    .nullable(),
  prices: z.object({
    tokenInAtCommit: decimalString.nullable(),
    tokenOutAtCommit: decimalString.nullable(),
  }),
  matchNote: z.string().nullable(),
  executionList: z.array(executionSchema),
  checks: z.array(receiptCheckSchema),
  registry: z.string().nullable(),
  chainId: z.number().int(),
  ai: z
    .object({
      model: z.string(),
      prompt: z.string(),
      inputs: z.unknown(),
      output: z.unknown(),
      promptHash: z.string(),
    })
    .nullable(),
});
export type ReceiptDetail = z.infer<typeof receiptDetailSchema>;

// ───────────────────────── vaults

export const vaultEventSchema = z.object({
  type: z.string(),
  data: z.record(z.unknown()),
  at: z.string(),
  source: sourceSchema,
});

export const vaultSchema = z.object({
  address: z.string(),
  owner: z.string(),
  followingId: z.number().int().nullable(),
  followingName: z.string().nullable(),
  allocationUsd: decimalString,
  maxSlippageBps: z.number().int(),
  dailyLimitUsd: decimalString,
  drawdownBps: z.number().int(),
  paused: z.boolean(),
  operator: z.string().nullable(),
  navUsd: decimalString,
  peakNavUsd: decimalString,
  hwmNavUsd: decimalString,
  isHouse: z.boolean(),
  created: sourceSchema,
  events: z.array(vaultEventSchema),
});
export type Vault = z.infer<typeof vaultSchema>;

export const houseVaultSchema = z.object({
  address: z.string(),
  strategyId: z.number().int().nullable(),
  strategyName: z.string().nullable(),
  navUsd: decimalString,
  explorerUrl: z.string(),
});
export const houseVaultListSchema = z.object({ items: z.array(houseVaultSchema) });

// ───────────────────────── templates, metadata, config, health

export const templateParamSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['number', 'percent', 'hours', 'days', 'assets', 'select', 'text']),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  default: z.union([z.number(), z.string(), z.array(z.string())]),
  options: z.array(z.string()).optional(),
  help: z.string().optional(),
});
export const templateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  ai: z.boolean(),
  assets: z.object({ min: z.number().int(), max: z.number().int(), allowed: z.array(z.string()) }),
  params: z.array(templateParamSchema),
});
export type Template = z.infer<typeof templateSchema>;
export const templateListSchema = z.object({ items: z.array(templateSchema) });

/** Metadata JSON stored at metadataURI (content-addressed, see MetadataDoc). */
export const strategyMetadataSchema = z.object({
  schema: z.literal('receipts.strategy/1'),
  name: z.string().min(3).max(60),
  description: z.string().max(600).default(''),
  template: z.string(),
  params: z.record(z.union([z.number(), z.string(), z.array(z.string())])),
  assets: z.array(z.string()).min(1).max(10),
  kind: strategyKind.default('TEMPLATE'),
  modelId: z.string().nullable().default(null),
});
export type StrategyMetadata = z.infer<typeof strategyMetadataSchema>;

export const chainConfigSchema = z.object({
  chainId: z.number().int(),
  name: z.string(),
  explorer: z.string(),
  rpcUrl: z.string(),
  registry: z.string().nullable(),
  factory: z.string().nullable(),
  router: z.string(),
  maxDailyLimitUsd: decimalString.nullable(),
  geoblockStocks: z.boolean(),
  tokens: z.array(
    z.object({
      symbol: z.string(),
      address: z.string(),
      feed: z.string(),
      kind: z.enum(['base', 'crypto', 'stock']),
      feeTier: z.number().int(),
      maxStaleness: z.number().int(),
    }),
  ),
});
export type ChainConfig = z.infer<typeof chainConfigSchema>;

export const healthSchema = z.object({
  ok: z.boolean(),
  indexerLagBlocks: z.number().nullable(),
  lastBlock: z.string().nullable(),
  db: z.boolean(),
  redis: z.boolean(),
});

// ───────────────────────── writes

export const backtestRequestSchema = z.object({
  template: z.string(),
  params: z.record(z.union([z.number(), z.string(), z.array(z.string())])),
  assets: z.array(z.string()).min(1).max(10),
});
export const backtestResultSchema = z.object({
  ret: z.number(),
  hold: z.number(),
  maxDrawdown: z.number(),
  winRate: z.number(),
  trades: z.number().int(),
  equity: z.array(z.object({ t: z.number(), equity: z.number(), hold: z.number() })),
  candles: z.number().int(),
  source: z.string(),
});
export type BacktestResult = z.infer<typeof backtestResultSchema>;

export const createStrategyRequestSchema = z.object({
  name: z.string().min(3).max(60),
  description: z.string().max(600).optional(),
  template: z.string(),
  params: z.record(z.union([z.number(), z.string(), z.array(z.string())])),
  assets: z.array(z.string()).min(1).max(10),
  creatorShareBps: z.number().int().min(0).max(3000),
});
export const createStrategyResponseSchema = z.object({
  metadataURI: z.string(),
  signer: z.string(),
  revealWindow: z.number().int(),
  modelHash: hex32,
  creatorShareBps: z.number().int(),
  registry: z.string(),
});

// ───────────────────────── websocket

export const wsEventSchema = z.object({
  type: z.enum([
    'receipt.committed',
    'receipt.executed',
    'receipt.revealed',
    'receipt.missed',
    'vault.event',
  ]),
  data: z.record(z.unknown()),
});
export type WsEvent = z.infer<typeof wsEventSchema>;

// ───────────────────────── auth + geo (additive, M4)

export const authNonceSchema = z.object({
  nonce: z.string(),
  /** SIWE domain / uri the API verifies (clients build the message with exactly these). */
  domain: z.string().optional(),
  uri: z.string().optional(),
});
export const authMeSchema = z.object({ address: z.string() });
/** GET /auth/session: always 200, `address: null` when signed out. */
export const authSessionSchema = z.object({ address: z.string().nullable() });

export const geoSchema = z.object({
  country: z.string().nullable(),
  stocksBlocked: z.boolean(),
  notice: z.string(),
});
export type Geo = z.infer<typeof geoSchema>;

/** Unsigned transaction returned by creator-only API routes (the creator signs it in the browser). */
export const txRequestSchema = z.object({
  tx: z.object({ to: z.string().nullable(), data: z.string() }),
  metadataURI: z.string().optional(),
});
