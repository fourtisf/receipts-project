import { createPublicClient, getAbiItem, http, type Address, type Hex, type Log } from 'viem';
import { hashSignal, type ReceiptCheck } from '@receipts/shared';
import { receiptsVaultAbi, signalRegistryAbi, vaultFactoryAbi } from '@receipts/shared/abi';

const REVEALED = getAbiItem({ abi: signalRegistryAbi, name: 'Revealed' });
const EXECUTED = getAbiItem({ abi: receiptsVaultAbi, name: 'Executed' });
/** eth_getLogs range per request (public RPCs cap ranges around 10k blocks). */
const CHUNK = 9_000n;
const MAX_CHUNKS = 40;

export interface ChainCheck extends ReceiptCheck {
  /** Where this check's evidence came from. */
  source: 'chain' | 'api';
}

export interface ChainVerification {
  rpcHost: string;
  checks: ChainCheck[];
  /** Executed events from genuine factory vaults. */
  executions: number;
  /** Executed events from contracts that are not vaults of this factory (ignored). */
  ignored: number;
}

export interface VerifyInput {
  rpcUrl: string;
  chainId: number;
  registry: Address;
  factory: Address | null;
  strategyId: number;
  nonce: number;
  /** Optional block hints from the API (where to look first); the data itself is always read from the chain. */
  hints?: { revealBlock?: bigint | null; executionBlocks?: bigint[] };
  /** The API's own price check, shown as-is (recomputing historic Chainlink prices needs an archive node). */
  apiPriceCheck?: ReceiptCheck | null;
}

const STATUS = ['None', 'Committed', 'Revealed', 'Missed'] as const;

export function rpcHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Verifies a receipt straight from Robinhood Chain: the commit from `commitOf`, the revealed signal + salt from the
 * `Revealed` log, hashSignal recomputed locally, and every `Executed` log (later L2 block, output ≥ enforced minimum,
 * same pair and direction as the signal) from contracts that are real vaults of the factory.
 */
export async function verifyOnChain(input: VerifyInput): Promise<ChainVerification> {
  const client = createPublicClient({ transport: http(input.rpcUrl, { timeout: 12_000, batch: true }) });
  const chainId = await client.getChainId();
  if (chainId !== input.chainId) throw new Error(`the RPC serves chain ${chainId}, not ${input.chainId}`);
  const id = BigInt(input.strategyId);
  const nonce = BigInt(input.nonce);
  const commit = await client.readContract({
    address: input.registry,
    abi: signalRegistryAbi,
    functionName: 'commitOf',
    args: [id, nonce],
  });
  const status = STATUS[commit.status] ?? 'None';
  if (status === 'None' || /^0x0+$/.test(commit.hash))
    throw new Error(`no commit for strategy ${input.strategyId}, nonce ${input.nonce} on this registry`);
  const latest = await client.getBlockNumber();
  const from = commit.committedL2Block;

  async function scan<T extends Log>(
    fetch: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
    hints: bigint[],
    until: bigint,
    stopAtFirst: boolean,
  ): Promise<T[]> {
    const seen = new Map<string, T>();
    for (const b of hints)
      for (const l of await fetch(b, b)) seen.set(`${l.transactionHash}:${l.logIndex}`, l);
    if (seen.size > 0 && stopAtFirst) return [...seen.values()];
    let lo = from;
    for (let i = 0; i < MAX_CHUNKS && lo <= until; i++) {
      const hi = lo + CHUNK - 1n < until ? lo + CHUNK - 1n : until;
      for (const l of await fetch(lo, hi)) seen.set(`${l.transactionHash}:${l.logIndex}`, l);
      if (seen.size > 0 && stopAtFirst) break;
      lo = hi + 1n;
    }
    return [...seen.values()];
  }

  const checks: ChainCheck[] = [
    {
      id: 'commit_found',
      ok: true,
      title: 'Commit found on-chain',
      detail: `commitOf(${input.strategyId}, ${input.nonce}) returns hash ${commit.hash}, L2 block ${commit.committedL2Block}, status ${status}.`,
      source: 'chain',
    },
  ];

  // reveal → recompute the hash locally
  let revealBlock: bigint | null = null;
  let signal: { tokenIn: Address; tokenOut: Address; sizeBps: number; promptHash: Hex } | null = null;
  if (status === 'Revealed') {
    const logs = await scan(
      (fromBlock, toBlock) =>
        client.getLogs({ address: input.registry, event: REVEALED, args: { id, nonce }, fromBlock, toBlock }),
      input.hints?.revealBlock ? [input.hints.revealBlock] : [],
      latest,
      true,
    );
    const log = logs[0];
    if (
      !log ||
      !log.args.tokenIn ||
      !log.args.tokenOut ||
      log.args.sizeBps === undefined ||
      !log.args.promptHash ||
      !log.args.salt
    ) {
      checks.push({
        id: 'reveal_matches',
        ok: false,
        title: 'Reveal log not found',
        detail: 'The registry says Revealed, but no Revealed event was found in the scanned range.',
        source: 'chain',
      });
    } else {
      revealBlock = log.blockNumber;
      signal = {
        tokenIn: log.args.tokenIn,
        tokenOut: log.args.tokenOut,
        sizeBps: log.args.sizeBps,
        promptHash: log.args.promptHash,
      };
      const recomputed = hashSignal({
        chainId,
        registry: input.registry,
        strategyId: id,
        nonce,
        signal,
        salt: log.args.salt,
      });
      const ok = recomputed.toLowerCase() === commit.hash.toLowerCase();
      checks.push({
        id: 'reveal_matches',
        ok,
        title: ok ? 'Reveal matches the commit' : 'Reveal does not match the commit',
        detail: `hashSignal recomputed in your browser from the Revealed event (block ${log.blockNumber}) = ${recomputed}${ok ? ', equal to the committed hash.' : `, but the commit is ${commit.hash}.`}`,
        txHash: log.transactionHash ?? undefined,
        source: 'chain',
      });
    }
  } else if (status === 'Missed') {
    checks.push({
      id: 'reveal_matches',
      ok: false,
      title: 'Reveal missed',
      detail:
        'The registry marks this commit Missed: it was not revealed before its deadline. That stays on the record.',
      source: 'chain',
    });
  } else {
    checks.push({
      id: 'reveal_matches',
      ok: null,
      title: 'Waiting for reveal',
      detail: `Not revealed yet; the deadline is ${new Date(Number(commit.revealDeadline) * 1000).toISOString()}.`,
      source: 'chain',
    });
  }

  // executions (any address, then keep only genuine vaults of the factory)
  const until = revealBlock ?? latest;
  const execLogs = await scan(
    (fromBlock, toBlock) =>
      client.getLogs({ event: EXECUTED, args: { strategyId: id, nonce }, fromBlock, toBlock }),
    input.hints?.executionBlocks ?? [],
    until,
    false,
  );
  let genuine = execLogs;
  let ignored = 0;
  if (input.factory && execLogs.length > 0) {
    const addrs = [...new Set(execLogs.map((l) => l.address.toLowerCase() as Address))];
    const owners = await Promise.all(
      addrs.map((a) =>
        client.readContract({ address: a, abi: receiptsVaultAbi, functionName: 'owner' }).catch(() => null),
      ),
    );
    const real = new Set<string>();
    await Promise.all(
      addrs.map(async (a, i) => {
        const owner = owners[i];
        if (!owner) return;
        const v = await client
          .readContract({
            address: input.factory!,
            abi: vaultFactoryAbi,
            functionName: 'vaultOf',
            args: [owner],
          })
          .catch(() => null);
        if (v && v.toLowerCase() === a) real.add(a);
      }),
    );
    genuine = execLogs.filter((l) => real.has(l.address.toLowerCase()));
    ignored = execLogs.length - genuine.length;
  }

  if (genuine.length === 0) {
    checks.push({
      id: 'executed_after_commit',
      ok: null,
      title: 'No vault executed this signal',
      detail: `No Executed event from a vault of this factory between L2 block ${from} and ${until}.${ignored ? ` ${ignored} event(s) from other contracts were ignored.` : ''}`,
      source: 'chain',
    });
  } else {
    const late = genuine.filter((l) => l.blockNumber !== null && l.blockNumber <= from);
    const pairBad = signal
      ? genuine.filter(
          (l) =>
            l.args.tokenIn?.toLowerCase() !== signal!.tokenIn.toLowerCase() ||
            l.args.tokenOut?.toLowerCase() !== signal!.tokenOut.toLowerCase(),
        )
      : [];
    const ok = late.length === 0 && pairBad.length === 0;
    checks.push({
      id: 'executed_after_commit',
      ok,
      title: ok
        ? 'Executed after the commit'
        : late.length
          ? 'Execution not after the commit'
          : 'Execution differs from the signal',
      detail: `${genuine.length} Executed event(s) from genuine vaults; ${late.length === 0 ? 'all in later L2 blocks than the commit' : `${late.length} not after the commit`}${signal ? (pairBad.length === 0 ? '; same pair and direction as the revealed signal' : `; ${pairBad.length} with a different pair or direction`) : ''}.${ignored ? ` ${ignored} event(s) from other contracts were ignored.` : ''}`,
      txHash: genuine[0]!.transactionHash ?? undefined,
      source: 'chain',
    });
  }

  if (input.apiPriceCheck) checks.push({ ...input.apiPriceCheck, source: 'api' });

  if (genuine.length > 0) {
    const short = genuine.filter((l) => (l.args.amountOut ?? 0n) < (l.args.minOutEnforced ?? 0n));
    checks.push({
      id: 'balance_changed_correctly',
      ok: short.length === 0,
      title: short.length === 0 ? 'Balances changed correctly' : 'Balance change below minimum',
      detail:
        short.length === 0
          ? 'Every Executed event delivered at least the enforced minimum output (amountOut ≥ minOutEnforced).'
          : `${short.length} execution(s) delivered less than the enforced minimum.`,
      txHash: genuine[0]!.transactionHash ?? undefined,
      source: 'chain',
    });
  } else {
    checks.push({
      id: 'balance_changed_correctly',
      ok: null,
      title: 'No balance changes',
      detail: 'Nothing was swapped.',
      source: 'chain',
    });
  }

  return { rpcHost: rpcHost(input.rpcUrl), checks, executions: genuine.length, ignored };
}
