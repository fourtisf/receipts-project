import { createWalletClient, http, type Address, type Hex, type WalletClient } from 'viem';
import { privateKeyToAccount, nonceManager } from 'viem/accounts';
import type { Redis } from 'ioredis';
import { robinhoodChain } from '@receipts/shared';

export interface KeyedWallet {
  address: Address;
  wallet: WalletClient;
}

const PK = /^0x[0-9a-fA-F]{64}$/;

/** Builds wallet clients from private keys. Keys never leave this module and are never logged. */
export function makeWallet(rpcUrl: string, pk: string): KeyedWallet {
  const key = (pk.startsWith('0x') ? pk : `0x${pk}`) as Hex;
  if (!PK.test(key)) throw new Error('Invalid private key format (expected 32-byte hex).');
  const account = privateKeyToAccount(key, { nonceManager });
  const wallet = createWalletClient({
    account,
    chain: robinhoodChain(rpcUrl),
    transport: http(rpcUrl, { retryCount: 3, timeout: 30_000 }),
  });
  return { address: account.address.toLowerCase() as Address, wallet };
}

export function parseSignerKeys(rpcUrl: string, list: string | undefined): KeyedWallet[] {
  if (!list) return [];
  return list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((k) => makeWallet(rpcUrl, k));
}

/**
 * One sender per key across processes (WORKER.md "Keys and nonces"): a Redis lock with a TTL, held while a key sends.
 * PM2 runs exactly one worker, so contention is rare; the lock protects against an accidental second instance.
 */
export async function withKeyLock<T>(
  redis: Redis,
  address: string,
  fn: () => Promise<T>,
  ttlMs = 120_000,
): Promise<T> {
  const key = `lock:key:${address.toLowerCase()}`;
  const token = `${process.pid}-${Date.now()}-${Math.random()}`;
  const deadline = Date.now() + ttlMs;
  while ((await redis.set(key, token, 'PX', ttlMs, 'NX')) !== 'OK') {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for the nonce lock of ${address}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  try {
    return await fn();
  } finally {
    // release only if we still own it
    await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      key,
      token,
    );
  }
}
