import type { PrismaClient } from '@receipts/db';
import { usdDec } from '@receipts/db';
import { TOKENS } from '@receipts/shared';
import { readFeeds, type Client } from '../chain.js';

/** WORKER.md §2: snapshot every Chainlink feed; a row is inserted only when the round changes. */
export async function runPrices(prisma: PrismaClient, client: Client): Promise<number> {
  const rounds = await readFeeds(client, TOKENS);
  if (rounds.length === 0) return 0;
  const res = await prisma.pricePoint.createMany({
    data: rounds.map((r) => ({
      token: r.token.symbol,
      feed: r.token.feed.toLowerCase(),
      priceUsd: usdDec(r.price18),
      roundId: r.roundId.toString(),
      updatedAt: new Date(Number(r.updatedAt) * 1000),
    })),
    skipDuplicates: true,
  });
  return res.count;
}
