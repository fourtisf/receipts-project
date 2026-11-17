import { Prisma, PrismaClient } from '@prisma/client';

export * from '@prisma/client';

let client: PrismaClient | undefined;

/** One PrismaClient per process. */
export function getPrisma(): PrismaClient {
  if (!client) {
    client = new PrismaClient({
      log: process.env.PRISMA_LOG === '1' ? ['query', 'warn', 'error'] : ['warn', 'error'],
    });
  }
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}

/** bigint (uint256 / fixed point) → Prisma.Decimal without float conversion. */
export function dec(v: bigint | string | number): Prisma.Decimal {
  return new Prisma.Decimal(typeof v === 'bigint' ? v.toString() : v);
}

/** USD bigint with 18 decimals → Prisma.Decimal(38,18). */
export function usdDec(v: bigint): Prisma.Decimal {
  return new Prisma.Decimal(v.toString()).div(new Prisma.Decimal('1e18'));
}

/** Prisma.Decimal (any scale) → plain decimal string (no exponent). */
export function decStr(v: Prisma.Decimal | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v.toFixed();
}
