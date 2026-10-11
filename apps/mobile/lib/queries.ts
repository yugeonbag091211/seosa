import { QueryClient, useQuery } from '@tanstack/react-query';
import { api } from './config';
import { isRetryable } from './api';
import { productKey } from './identity';
import type { ProductIdentity } from './types';

/*
 * React Query: one cache for every screen, so the home list, the drops tab and the detail
 * screen never fetch the same thing twice in a row.
 *
 * staleTime mirrors the server's edge cache (cachePublic s-maxage) — refetching sooner
 * would only get the same CDN copy. Only transient failures are retried, once.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => count < 1 && isRetryable(error),
      refetchOnWindowFocus: false,
      gcTime: 30 * 60 * 1000,
    },
  },
});

const MIN = 60 * 1000;

export function useTodayDrops() {
  return useQuery({ queryKey: ['todayDrops'], queryFn: ({ signal }) => api.todayDrops(signal), staleTime: 2 * MIN });
}

export function useHomeFeed() {
  return useQuery({ queryKey: ['home'], queryFn: ({ signal }) => api.home(signal), staleTime: 5 * MIN });
}

export function useSearch(keyword: string) {
  const q = keyword.trim();
  return useQuery({
    queryKey: ['search', q],
    queryFn: ({ signal }) => api.search(q, signal),
    enabled: q.length > 0,
    staleTime: 5 * MIN,
    // Each search can cost a Coupang call server-side; never retry a search automatically.
    retry: false,
  });
}

export function usePriceHistory(id: ProductIdentity | null) {
  const key = id ? productKey(id) : '';
  return useQuery({
    queryKey: ['history', key],
    queryFn: ({ signal }) => api.history(id!, signal),
    enabled: !!key,
    staleTime: 5 * MIN,
  });
}

export function useLatestPrices(keys: readonly string[]) {
  const sorted = [...keys].sort();
  return useQuery({
    queryKey: ['historyBatch', sorted.join(',')],
    queryFn: ({ signal }) => api.historyBatch(sorted, signal),
    enabled: sorted.length > 0,
    staleTime: 5 * MIN,
  });
}

export function useCatalogProduct(id: ProductIdentity | null, enabled: boolean) {
  return useQuery({
    queryKey: ['catalog', id ? productKey(id) : ''],
    queryFn: ({ signal }) => api.productById(id!.productId, id!.mall, signal),
    enabled: enabled && !!id,
    staleTime: 5 * MIN,
  });
}
