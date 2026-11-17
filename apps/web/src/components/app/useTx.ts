'use client';

import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';
import type {
  Abi,
  Address,
  ContractFunctionArgs,
  ContractFunctionName,
  SimulateContractParameters,
  TransactionReceipt,
} from 'viem';
import { useChainConfig } from '@/lib/chain-config';
import { txErrorMessage } from '@/lib/errors';
import { useToast } from '@/components/Toast';

type WriteFn<A extends Abi> = ContractFunctionName<A, 'nonpayable' | 'payable'>;

export interface TxCall<A extends Abi, F extends WriteFn<A>> {
  address: Address;
  abi: A;
  functionName: F;
  args: ContractFunctionArgs<A, 'nonpayable' | 'payable', F>;
}

export interface TxOptions {
  /** Shown after confirmation. */
  success?: string;
  /** Step label for multi-transaction flows, e.g. "Step 2 of 3". */
  step?: string;
  /** Skip query invalidation (multi-step flows invalidate once at the end). */
  quiet?: boolean;
}

/**
 * Runs one user-signed transaction: simulate first (so a revert is explained before the wallet opens), ask the wallet
 * to sign, wait for the receipt, toast the result with a Blockscout link. Returns the receipt, or null on failure.
 */
export function useTx() {
  const { address } = useAccount();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const qc = useQueryClient();
  const toast = useToast();
  const cfg = useChainConfig();
  const [busy, setBusy] = useState<string | null>(null);

  const run = useCallback(
    async <A extends Abi, F extends WriteFn<A>>(
      label: string,
      call: TxCall<A, F>,
      opts: TxOptions = {},
    ): Promise<TransactionReceipt | null> => {
      if (!address || !client) {
        toast({ message: 'Connect your wallet first.', tone: 'error' });
        return null;
      }
      const prefix = opts.step ? `${opts.step}: ` : '';
      setBusy(label);
      try {
        const params = { ...call, account: address } as unknown as SimulateContractParameters;
        const sim = await client.simulateContract(params);
        toast({ message: `${prefix}confirm “${label}” in your wallet…`, duration: 0 });
        const hash = await writeContractAsync(sim.request as Parameters<typeof writeContractAsync>[0]);
        const href = `${cfg.explorer}/tx/${hash}`;
        toast({ message: `${prefix}${label}: waiting for the block…`, href, duration: 0 });
        const receipt = await client.waitForTransactionReceipt({ hash });
        if (receipt.status !== 'success') {
          toast({ message: `${label} reverted on-chain. Nothing changed.`, tone: 'error', href });
          return null;
        }
        toast({ message: opts.success ?? `${label}: confirmed.`, tone: 'ok', href });
        if (!opts.quiet) await qc.invalidateQueries();
        return receipt;
      } catch (e) {
        toast({ message: txErrorMessage(e), tone: 'error' });
        return null;
      } finally {
        setBusy(null);
      }
    },
    [address, client, writeContractAsync, toast, cfg.explorer, qc],
  );

  return { run, busy };
}
