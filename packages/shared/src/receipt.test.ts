import { describe, expect, it } from 'vitest';
import { hashSignal, aiPromptHash, modelHashOf, ZERO_HASH } from './receipt.js';
import { displayUsd, formatFixed, parseFixed } from './money.js';
import { TOKENS, baseToken, tokenBySymbol, tokenByAddress, CHAIN_ID } from './chain.js';

describe('hashSignal', () => {
  it('matches SignalRegistry.hashSignal (vector from test_hashSignal_vector in Foundry)', () => {
    const h = hashSignal({
      chainId: 4663,
      registry: '0x000000000000000000000000000000000000dEaD',
      strategyId: 3,
      nonce: 17,
      signal: {
        tokenIn: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
        tokenOut: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
        sizeBps: 2500,
        promptHash: ZERO_HASH,
      },
      salt: `0x${'abc'.padStart(64, '0')}`,
    });
    expect(h).toBe('0xa796891e6a36fc4de061b5f208b4a12300e3fda17db5db6f60a4d10b9829b7ea');
  });

  it('changes with every field', () => {
    const base = {
      chainId: 4663,
      registry: '0x000000000000000000000000000000000000dEaD' as const,
      strategyId: 1,
      nonce: 0,
      signal: {
        tokenIn: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const,
        tokenOut: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as const,
        sizeBps: 1000,
        promptHash: ZERO_HASH,
      },
      salt: ZERO_HASH,
    };
    const h0 = hashSignal(base);
    expect(hashSignal({ ...base, nonce: 1 })).not.toBe(h0);
    expect(hashSignal({ ...base, chainId: 1 })).not.toBe(h0);
    expect(hashSignal({ ...base, signal: { ...base.signal, sizeBps: 1001 } })).not.toBe(h0);
  });

  it('ai hashes are keccak of utf8', () => {
    expect(modelHashOf('gpt-4o')).toMatch(/^0x[0-9a-f]{64}$/);
    expect(aiPromptHash('p', { a: 1 })).not.toBe(aiPromptHash('p', { a: 2 }));
  });
});

describe('money', () => {
  it('formats and parses fixed point without floats', () => {
    expect(formatFixed(123456789n, 6)).toBe('123.456789');
    expect(formatFixed(1_000_000n, 6)).toBe('1');
    expect(formatFixed(-1_500_000n, 6, 2)).toBe('-1.5');
    expect(parseFixed('123.456789', 6)).toBe(123456789n);
    expect(parseFixed('1.23456789', 6)).toBe(1234567n);
    expect(parseFixed('-2', 18)).toBe(-2n * 10n ** 18n);
    expect(() => parseFixed('1e5', 6)).toThrow();
  });

  it('displays USD', () => {
    expect(displayUsd('1234567.891')).toBe('$1,234,567.89');
    expect(displayUsd(2000n * 10n ** 18n)).toBe('$2,000.00');
    expect(displayUsd('-5')).toBe('-$5.00');
  });
});

describe('chain config', () => {
  it('loads 13 tokens with USDG as base', () => {
    expect(CHAIN_ID).toBe(4663);
    expect(TOKENS).toHaveLength(13);
    expect(baseToken().symbol).toBe('USDG');
    expect(baseToken().feeTier).toBe(0);
    expect(tokenBySymbol('nvda')?.kind).toBe('stock');
    expect(tokenBySymbol('WETH')?.kind).toBe('crypto');
    expect(tokenByAddress('0x0bd7d308f8e1639fab988df18a8011f41eacad73')?.symbol).toBe('WETH');
    for (const t of TOKENS) if (t.symbol !== 'USDG') expect([100, 500, 3000, 10000]).toContain(t.feeTier);
  });
});
