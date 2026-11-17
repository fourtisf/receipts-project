import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';

/** Mirrors ISignalRegistry.Signal. */
export interface Signal {
  tokenIn: Address;
  tokenOut: Address;
  sizeBps: number;
  promptHash: Hex;
}

export const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;

const signalTuple = {
  type: 'tuple',
  components: [
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'sizeBps', type: 'uint16' },
    { name: 'promptHash', type: 'bytes32' },
  ],
} as const;

/**
 * Exact off-chain mirror of SignalRegistry.hashSignal:
 *   keccak256(abi.encode(block.chainid, address(this), strategyId, nonce, signal, salt))
 * Used by the worker (commit), the API (receipt checks) and the browser (client-side verification).
 */
export function hashSignal(args: {
  chainId: number | bigint;
  registry: Address;
  strategyId: number | bigint;
  nonce: number | bigint;
  signal: Signal;
  salt: Hex;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint64' },
        signalTuple,
        { type: 'bytes32' },
      ],
      [
        BigInt(args.chainId),
        args.registry,
        BigInt(args.strategyId),
        BigInt(args.nonce),
        {
          tokenIn: args.signal.tokenIn,
          tokenOut: args.signal.tokenOut,
          sizeBps: args.signal.sizeBps,
          promptHash: args.signal.promptHash,
        },
        args.salt,
      ],
    ),
  );
}

/** keccak256(utf8(prompt + "\n" + JSON.stringify(inputs))) — the AI strategy promptHash (WORKER.md §3). */
export function aiPromptHash(prompt: string, inputs: unknown): Hex {
  const text = `${prompt}\n${JSON.stringify(inputs)}`;
  return keccak256(new TextEncoder().encode(text));
}

/** keccak256(utf8(modelId)) — committed on registerStrategy for AI strategies. */
export function modelHashOf(modelId: string): Hex {
  return keccak256(new TextEncoder().encode(modelId));
}
