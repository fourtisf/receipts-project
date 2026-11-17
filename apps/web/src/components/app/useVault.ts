'use client';

import { useQuery } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import { vaultSchema, type Vault } from '@receipts/shared';
import { ClientApiError, fetchApi } from '@/lib/api.client';

/**
 * The connected wallet's vault from the indexer (`GET /vaults/:owner`). `vault === null` means the
 * wallet has no vault yet (API answers 404 NO_VAULT).
 */
export function useMyVault() {
  const { address, isConnected, status } = useAccount();
  const q = useQuery<Vault | null, ClientApiError>({
    queryKey: ['vault', address?.toLowerCase()],
    enabled: Boolean(address),
    refetchInterval: 15_000,
    queryFn: async ({ signal }) => {
      try {
        return await fetchApi(`/vaults/${address}`, vaultSchema, signal);
      } catch (e) {
        if (e instanceof ClientApiError && e.status === 404) return null;
        throw e;
      }
    },
  });
  return {
    address,
    isConnected,
    connecting: status === 'connecting' || status === 'reconnecting',
    vault: q.data,
    loading: q.isPending && Boolean(address),
    error: q.error,
  };
}
