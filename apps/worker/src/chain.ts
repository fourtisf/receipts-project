import { createPublicClient, fallback, http, type Address, type PublicClient } from 'viem';
import { robinhoodChain, TOKENS, type TokenInfo } from '@receipts/shared';
import { aggregatorV3Abi, erc20Abi } from '@receipts/shared/abi';
import type { WorkerEnv } from './env.js';

export type Client = PublicClient;

export function makePublicClient(env: Pick<WorkerEnv, 'RPC_URL' | 'RPC_URL_FALLBACK'>): Client {
  const transports = [http(env.RPC_URL, { retryCount: 4, retryDelay: 500, timeout: 20_000 })];
  if (env.RPC_URL_FALLBACK) transports.push(http(env.RPC_URL_FALLBACK, { retryCount: 4, retryDelay: 500 }));
  return createPublicClient({
    chain: robinhoodChain(env.RPC_URL),
    transport: transports.length > 1 ? fallback(transports) : transports[0]!,
    batch: { multicall: false },
  }) as Client;
}

/** Runs async tasks with a concurrency cap (keeps public / rate-limited RPCs happy). */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface FeedRound {
  token: TokenInfo;
  roundId: bigint;
  answer: bigint;
  updatedAt: bigint;
  /** price with 18 decimals */
  price18: bigint;
}

const feedDecimals = new Map<string, number>();

async function decimalsOf(client: Client, feed: Address): Promise<number> {
  const cached = feedDecimals.get(feed);
  if (cached !== undefined) return cached;
  const d = await client.readContract({ address: feed, abi: aggregatorV3Abi, functionName: 'decimals' });
  feedDecimals.set(feed, d);
  return d;
}

/** Reads a Chainlink feed, optionally at a historical block. Returns null on any failure. */
export async function readFeed(
  client: Client,
  token: TokenInfo,
  blockNumber?: bigint,
): Promise<FeedRound | null> {
  try {
    const [roundId, answer, , updatedAt] = await client.readContract({
      address: token.feed,
      abi: aggregatorV3Abi,
      functionName: 'latestRoundData',
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    });
    if (answer <= 0n) return null;
    const d = await decimalsOf(client, token.feed);
    const price18 = d <= 18 ? answer * 10n ** BigInt(18 - d) : answer / 10n ** BigInt(d - 18);
    return { token, roundId, answer, updatedAt, price18 };
  } catch {
    return null;
  }
}

const tokenDecimalsCache = new Map<string, number>();

/** ERC-20 decimals (cached; immutable in practice for the listed tokens). */
export async function tokenDecimals(client: Client, token: Address): Promise<number> {
  const key = token.toLowerCase();
  const cached = tokenDecimalsCache.get(key);
  if (cached !== undefined) return cached;
  const d = await client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' });
  tokenDecimalsCache.set(key, Number(d));
  return Number(d);
}

export async function readFeeds(client: Client, tokens: readonly TokenInfo[] = TOKENS, blockNumber?: bigint) {
  const rounds = await mapLimit(tokens, 4, (t) => readFeed(client, t, blockNumber));
  return rounds.filter((r): r is FeedRound => r !== null);
}

export function lower(a: string): Address {
  return a.toLowerCase() as Address;
}
