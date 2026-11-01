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

export function useCommunityDeals() {
  return useQuery({ queryKey: ['communityDeals'], queryFn: ({ signal }) => api.communityDeals(signal), staleTime: 2 * MIN });
}

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
    // Never serve an incomplete supplier response as fresh for 5 more minutes.
    // Avoid automatic background refetch; the user may retry explicitly.
    staleTime: query => (query.state.data?.partialResults || query.state.data?.blocked
      || query.state.data?.source === 'stale-cache') ? 0 : 5 * MIN,
    refetchOnWindowFocus: false,
    // A partial response is expired for freshness but must not auto-spend
    // another merchant API call every time the user reopens the search tab.
    refetchOnMount: false,
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
