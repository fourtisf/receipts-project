import { describe, expect, it, vi } from 'vitest';
import { SecretBox, randomSalt } from '../src/pipeline/secrets.js';
import { binance, coinbase, usMarketOpen } from '../src/pipeline/market.js';
import { deliverAlerts } from '../src/pipeline/alerts.js';
import { Runner } from '../src/pipeline/runner.js';
import { loadEnv } from '../src/env.js';
import { log } from '../src/log.js';
import { modelHashOf } from '@receipts/shared';
import type { PrismaClient, Strategy } from '@receipts/db';
import type { Redis } from 'ioredis';

const KEY = 'a'.repeat(64);

describe('SecretBox', () => {
  it('round-trips and authenticates', () => {
    const box = new SecretBox(KEY);
    const salt = randomSalt();
    const enc = box.encrypt(salt);
    expect(enc).not.toContain(salt.slice(2, 20));
    expect(box.decrypt(enc)).toBe(salt);
    const tampered = Buffer.from(enc, 'base64');
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    expect(() => box.decrypt(tampered.toString('base64'))).toThrow();
    expect(() => new SecretBox('b'.repeat(64)).decrypt(enc)).toThrow();
  });
  it('rejects bad keys', () => {
    expect(() => new SecretBox('short')).toThrow(/32 bytes/);
    expect(() => new SecretBox(undefined)).toThrow();
  });
});

describe('market data', () => {
  const now = Date.UTC(2026, 10, 17, 12);
  it('parses Coinbase candles (newest first) into ascending hourly candles', async () => {
    const f = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            [1794916800, 1, 3, 2, 2.5, 10],
            [1794913200, 0.5, 2, 1, 2, 5],
          ]),
        ),
    );
    const c = await coinbase(f as unknown as typeof fetch, 'ETH-USD', 2, now);
    expect(c.map((x) => x.c)).toEqual([2, 2.5]);
    expect(c[0]).toMatchObject({ o: 1, h: 2, l: 0.5 });
  });
  it('parses Binance klines', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify([[1000, '1', '2', '0.5', '1.5', '9']])));
    expect(await binance(f as unknown as typeof fetch, 'ETHUSDT', 1, now)).toEqual([
      { t: 1000, o: 1, h: 2, l: 0.5, c: 1.5, v: 9 },
    ]);
  });
  it('knows US market hours', () => {
    expect(usMarketOpen(Date.UTC(2026, 10, 17, 15, 0))).toBe(true); // Tue 10:00 New York
    expect(usMarketOpen(Date.UTC(2026, 10, 17, 13, 0))).toBe(false); // 08:00 New York
    expect(usMarketOpen(Date.UTC(2026, 10, 21, 16, 0))).toBe(false); // Saturday
  });
});

describe('alerts', () => {
  it('delivers unsent alerts to Telegram and marks them sent', async () => {
    const rows = [{ id: 'a1', level: 'critical', kind: 'mismatch', message: 'm' }];
    const update = vi.fn(async () => ({}));
    const prisma = { alertLog: { findMany: vi.fn(async () => rows), update } } as unknown as PrismaClient;
    const env = loadEnv({ DATABASE_URL: 'postgres://x', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: 'c' });
    const f = vi.fn(async () => new Response('{}', { status: 200 }));
    expect(await deliverAlerts(prisma, env, f as unknown as typeof fetch)).toBe(1);
    expect(update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { sentAt: expect.any(Date) } });
    expect(await deliverAlerts(prisma, loadEnv({ DATABASE_URL: 'postgres://x' }))).toBe(0);
  });
});

describe('AI decisions', () => {
  const strategy = {
    id: 9,
    assets: ['NVDA'],
    template: 'ai_news',
    modelHash: modelHashOf('llama-3.1-70b'),
    params: { promptTemplate: 'Trade {assets}. Answer JSON.' },
  } as unknown as Strategy;
  const base = {
    prisma: {} as PrismaClient,
    redis: {} as Redis,
    log,
    market: { hourly: async () => [] },
    signerAddresses: new Set<string>(),
    enqueue: async () => undefined,
  };

  it('commits the exact prompt and answer, only for the committed model', async () => {
    const env = loadEnv({
      DATABASE_URL: 'postgres://x',
      AI_BASE_URL: 'https://ai.example/v1',
      AI_MODEL: 'llama-3.1-70b',
    });
    const f = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: '{"action":"buy","asset":"NVDA","sizeBps":2000,"reason":"beat"}' } },
            ],
          }),
        ),
    );
    const r = new Runner({ ...base, env, fetchImpl: f as unknown as typeof fetch });
    const out = await r.decideAi(
      strategy,
      strategy.params as Record<string, string>,
      { NVDA: [{ t: 1, o: 1, h: 1, l: 1, c: 1 }] },
      { cash: 1, units: {}, entry: {} },
      Date.UTC(2026, 10, 17, 15),
    );
    expect(out?.signal).toMatchObject({ side: 'BUY', asset: 'NVDA', sizeBps: 2000 });
    expect(out?.ai.prompt).toBe('Trade NVDA. Answer JSON.');
    expect(out?.ai.model).toBe('llama-3.1-70b');

    const other = new Runner({
      ...base,
      env: loadEnv({ DATABASE_URL: 'postgres://x', AI_BASE_URL: 'https://ai.example/v1', AI_MODEL: 'gpt-x' }),
      fetchImpl: f as unknown as typeof fetch,
    });
    expect(await other.decideAi(strategy, {}, {}, { cash: 1, units: {}, entry: {} }, 0)).toBeNull();
  });
});
