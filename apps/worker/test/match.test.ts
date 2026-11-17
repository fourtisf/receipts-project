import { describe, expect, it } from 'vitest';
import { matchCheck } from '../src/indexer/match.js';

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const NVDA = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
const usd = (n: number) => BigInt(Math.round(n * 100)) * 10n ** 16n;

describe('matchCheck', () => {
  const buy = { tokenIn: USDG, tokenOut: WETH, sizeBps: 2500 };

  it('NO_EXECUTION without executions', () => {
    expect(matchCheck(buy, USDG, []).status).toBe('NO_EXECUTION');
  });

  it('MATCH for the right pair and size', () => {
    const r = matchCheck(buy, USDG, [
      { vault: '0xv1', tokenIn: USDG, tokenOut: WETH, valueUsd: usd(250), allocationUsd: usd(1000) },
    ]);
    expect(r).toEqual({ status: 'MATCH', note: null });
  });

  it('MATCH with a note when clamped below the signal size', () => {
    const r = matchCheck(buy, USDG, [
      { vault: '0xv1', tokenIn: USDG, tokenOut: WETH, valueUsd: usd(100), allocationUsd: usd(1000) },
    ]);
    expect(r.status).toBe('MATCH');
    expect(r.note).toContain('clamped');
  });

  it('MISMATCH when oversized beyond 2%', () => {
    const r = matchCheck(buy, USDG, [
      { vault: '0xv1', tokenIn: USDG, tokenOut: WETH, valueUsd: usd(256), allocationUsd: usd(1000) },
    ]);
    expect(r.status).toBe('MISMATCH');
    const ok = matchCheck(buy, USDG, [
      { vault: '0xv1', tokenIn: USDG, tokenOut: WETH, valueUsd: usd(255), allocationUsd: usd(1000) },
    ]);
    expect(ok.status).toBe('MATCH');
  });

  it('MISMATCH on wrong token or direction', () => {
    expect(
      matchCheck(buy, USDG, [
        { vault: '0xv1', tokenIn: USDG, tokenOut: NVDA, valueUsd: usd(10), allocationUsd: null },
      ]).status,
    ).toBe('MISMATCH');
    expect(
      matchCheck(buy, USDG, [
        { vault: '0xv1', tokenIn: WETH, tokenOut: USDG, valueUsd: usd(10), allocationUsd: null },
      ]).status,
    ).toBe('MISMATCH');
  });

  it('MISMATCH on an invalid revealed size', () => {
    expect(
      matchCheck({ ...buy, sizeBps: 0 }, USDG, [
        { vault: '0xv1', tokenIn: USDG, tokenOut: WETH, valueUsd: usd(1), allocationUsd: null },
      ]).status,
    ).toBe('MISMATCH');
  });

  it('sells are only checked for pair and direction', () => {
    const sell = { tokenIn: WETH, tokenOut: USDG, sizeBps: 10_000 };
    expect(
      matchCheck(sell, USDG, [
        { vault: '0xv1', tokenIn: WETH, tokenOut: USDG, valueUsd: usd(999), allocationUsd: usd(1) },
      ]).status,
    ).toBe('MATCH');
  });
});
