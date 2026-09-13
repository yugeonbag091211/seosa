export type Product = {
  title: string;
  lprice: number;
  mall: string;
  mallLabel?: string;
  image?: string;
  productId?: string;
  vendorItemId?: string;
};

export type PricePoint = { date: string; price: number };
export type Deal = { verdict: string; label: string; reasons: string[]; cautions: string[] };
export type ProductDetail = { product: Product; points: PricePoint[]; deal: Deal | null };
export type PriceHistory = { points: PricePoint[]; deal: Deal | null };
export type HomeDeal = {
  title: string;
  price: number;
  mall: string;
  image?: string;
  productId?: string;
  status: string;
  reason?: string;
  checkedAt?: string;
};

export const API_TIMEOUTS = { searchMs: 25_000, detailMs: 15_000, homeMs: 12_000 } as const;
export type ApiTimeouts = { searchMs: number; detailMs: number; homeMs: number };

function isProduct(value: unknown): value is Product {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<Product>;
  return typeof item.title === 'string' && Number.isFinite(item.lprice) && typeof item.mall === 'string';
}

function isPoints(value: unknown): value is PricePoint[] {
  return Array.isArray(value) && value.every(point => point && typeof point.date === 'string' && Number.isFinite(point.price));
}

function isDeal(value: unknown): value is Deal | null {
  if (value == null) return true;
  if (typeof value !== 'object') return false;
  const deal = value as Partial<Deal>;
  return typeof deal.verdict === 'string' && typeof deal.label === 'string' && Array.isArray(deal.reasons) && Array.isArray(deal.cautions);
}

function isHomeDeal(value: unknown): value is HomeDeal {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<HomeDeal>;
  return typeof item.title === 'string' && Number.isFinite(item.price) && typeof item.mall === 'string' && typeof item.status === 'string';
}

/** Deal text is rendered directly; a non-string entry would crash a <Text> child, so only strings survive. */
function cleanDeal(deal: Deal | null | undefined): Deal | null {
  if (!deal) return null;
  const strings = (list: unknown[]) => list.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
  return { verdict: deal.verdict, label: deal.label, reasons: strings(deal.reasons), cautions: strings(deal.cautions) };
}

/**
 * List responses: one malformed row should not hide every good result, so malformed rows are dropped.
 * A non-empty list with no usable row still means the contract broke and is reported as such.
 */
function usableItems<T>(items: unknown[], isValid: (value: unknown) => value is T, message: string): T[] {
  const valid = items.filter(isValid);
  if (items.length > 0 && valid.length === 0) throw new ApiError('invalid_response', message);
  return valid;
}

export type ApiErrorKind = 'unavailable' | 'network' | 'timeout' | 'invalid_response' | 'not_found' | 'request' | 'aborted';

export class ApiError extends Error {
  kind: ApiErrorKind;
  status?: number;

  constructor(kind: ApiErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}

export function userMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return '정보를 불러오지 못했어요. 다시 시도해 주세요.';
  switch (error.kind) {
    case 'unavailable': return '지금은 상품 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.';
    case 'network': return '네트워크 연결을 확인한 뒤 다시 시도해 주세요.';
    case 'timeout': return '응답을 기다렸지만 완료되지 않았어요. 다시 시도해 주세요.';
    case 'not_found': return '상품 정보를 찾을 수 없어요.';
    case 'invalid_response': return '받은 정보를 읽지 못했어요. 다시 시도해 주세요.';
    case 'request': return error.message;
    case 'aborted': return '';
  }
}

export function apiBaseUrl(value: string = process.env.EXPO_PUBLIC_API_BASE_URL || 'https://seosa.ai.kr'): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new ApiError('request', 'API 주소를 확인해 주세요.'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname))) {
    throw new ApiError('request', 'API 주소를 확인해 주세요.');
  }
  return url.origin + url.pathname.replace(/\/$/, '');
}

/** Development builds only: path and outcome — never query parameters (search keywords) or response bodies. */
function devLog(path: string, outcome: string) {
  if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn(`[seosa api] ${path} → ${outcome}`);
}

export function createApiClient(fetcher: typeof fetch = fetch, timeoutOverrides: Partial<ApiTimeouts> = {}, baseUrl?: string) {
  const timeouts = { ...API_TIMEOUTS, ...timeoutOverrides };

  async function get(path: string, params: Record<string, string>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    try {
      return await send(path, params, timeoutMs, signal);
    } catch (error) {
      if (error instanceof ApiError && error.kind !== 'aborted') devLog(path, `${error.kind}${error.status ? ` ${error.status}` : ''}`);
      throw error;
    }
  }

  async function send(path: string, params: Record<string, string>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new ApiError('aborted', 'Request aborted');
    const url = new URL(apiBaseUrl(baseUrl) + path);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await fetcher(url.toString(), { method: 'GET', signal: controller.signal, headers: { Accept: 'application/json' } });
      // Every 5xx (not only the search 503) is a temporary server-side failure from the user's point of view.
      if (response.status >= 500) throw new ApiError('unavailable', 'Server unavailable', response.status);
      if (response.status === 404) throw new ApiError('not_found', 'Not found', 404);
      if (!response.ok) throw new ApiError('request', response.status === 400 ? '검색어를 다시 입력해 주세요.' : '요청을 처리하지 못했어요. 다시 시도해 주세요.', response.status);
      try { return await response.json(); }
      catch {
        if (timedOut) throw new ApiError('timeout', 'Request timed out');
        if (signal?.aborted) throw new ApiError('aborted', 'Request aborted');
        throw new ApiError('invalid_response', 'Invalid JSON');
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (timedOut) throw new ApiError('timeout', 'Request timed out');
      if (signal?.aborted) throw new ApiError('aborted', 'Request aborted');
      throw new ApiError('network', 'Network request failed');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  return {
    async search(keyword: string, signal?: AbortSignal): Promise<Product[]> {
      const data = await get('/api/search', { keyword: keyword.trim() }, timeouts.searchMs, signal);
      if (!Array.isArray(data)) throw new ApiError('invalid_response', 'Search response is not an array');
      return usableItems(data, isProduct, 'Invalid search product');
    },
    async product(id: string, mall?: string, signal?: AbortSignal): Promise<ProductDetail> {
      const data = await get('/api/history', { __route: 'product', pid: id, ...(mall ? { mall } : {}) }, timeouts.detailMs, signal) as Partial<ProductDetail>;
      if (!data || !isProduct(data.product) || data.product.productId !== id || !isPoints(data.points) || !isDeal(data.deal)) throw new ApiError('invalid_response', 'Invalid product response');
      return { product: data.product, points: data.points, deal: cleanDeal(data.deal) };
    },
    async history(product: Product, signal?: AbortSignal): Promise<PriceHistory> {
      if (!product.productId) throw new ApiError('request', '상품 식별자가 없어요.');
      const data = await get('/api/history', { productId: product.productId, mall: product.mall, vendorItemId: product.vendorItemId || '', deal: '1' }, timeouts.detailMs, signal) as Partial<PriceHistory>;
      if (!data || !isPoints(data.points) || !isDeal(data.deal)) throw new ApiError('invalid_response', 'Invalid history response');
      return { points: data.points, deal: cleanDeal(data.deal) };
    },
    async homeDeals(signal?: AbortSignal): Promise<HomeDeal[]> {
      const data = await get('/api/hotdeals', { source: 'internal-history', limit: '4', sort: 'score' }, timeouts.homeMs, signal) as { items?: unknown };
      if (!data || !Array.isArray(data.items)) throw new ApiError('invalid_response', 'Invalid hotdeal response');
      return usableItems(data.items, isHomeDeal, 'Invalid hotdeal response');
    },
  };
}

export const api = createApiClient();
