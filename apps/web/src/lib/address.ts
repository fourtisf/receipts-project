import { getAddress } from 'viem';
import { short } from './format';

/** EIP-55 checksum for display (addresses are lowercase in the API). */
export function checksum(a: string): string {
  try {
    return getAddress(a);
  } catch {
    return a;
  }
}

/** Short checksummed address: "0x3F9a…C21e". */
export function shortAddr(a: string | null | undefined): string {
  return a ? short(checksum(a), 6, 4) : '—';
}
