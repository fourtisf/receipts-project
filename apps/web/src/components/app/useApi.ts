'use client';

import { useQuery } from '@tanstack/react-query';
import { geoSchema, strategyListSchema, type Geo, type StrategyList } from '@receipts/shared';
import { fetchApi } from '@/lib/api.client';

/** Active strategies for the follow picker. */
export function useStrategyList() {
  return useQuery<StrategyList>({
    queryKey: ['strategies', 'all'],
    queryFn: ({ signal }) => fetchApi('/strategies?limit=100&sort=vs', strategyListSchema, signal),
    staleTime: 30_000,
  });
}

/** Stock-token geoblock (GET /geo). Unknown country → notice shown, copy allowed. */
export function useGeo() {
  return useQuery<Geo>({
    queryKey: ['geo'],
    queryFn: ({ signal }) => fetchApi('/geo', geoSchema, signal),
    staleTime: 5 * 60_000,
    retry: 0,
  });
}

/** STOCK and MIXED strategies trade Robinhood Stock Tokens. */
export const tradesStocks = (category: string) => category === 'STOCK' || category === 'MIXED';
