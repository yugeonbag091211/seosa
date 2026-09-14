export type TrustReason = { kind: string; text: string };
export type Trust = { level: string; label: string; summary: string; reasons: TrustReason[] };

export type Product = {
  title: string;
  lprice: number;
  mall: string;
  mallLabel?: string;
  image?: string;
  productId?: string;
  vendorItemId?: string;
  // Optional fields the web cards also read. Absent values are simply not shown.
  link?: string;
  oprice?: number;
  savePct?: number;
  isAllTimeLow?: boolean;
  isRocket?: boolean | null;
  collectedAt?: string;
  trust?: Trust | null;
};

/** GET /api/init — the same read-only, edge-cached payload the web home renders. */
export type HomeFeed = {
  keywords: string[];
  drops: Product[];
  daily: { keyword: string; products: Product[] } | null;
  monthly: { month: number | null; title: string; subtitle: string; products: Product[] } | null;
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

/** Trust is optional context; anything malformed becomes null instead of failing the response. */
function cleanTrust(value: unknown): Trust | null {
  if (!value || typeof value !== 'object') return null;
  const trust = value as Partial<Trust>;
  if (typeof trust.level !== 'string' || typeof trust.label !== 'string') return null;
  const reasons = Array.isArray(trust.reasons)
    ? trust.reasons.filter((r): r is TrustReason => !!r && typeof r === 'object' && typeof (r as TrustReason).text === 'string')
      .map(r => ({ kind: typeof r.kind === 'string' ? r.kind : '', text: r.text }))
    : [];
  return { level: trust.level, label: trust.label, summary: typeof trust.summary === 'string' ? trust.summary : '', reasons };
}

/** Keeps the required fields as validated and drops optional fields of the wrong type. */
function cleanProduct(item: Product): Product {
  const out: Product = { title: item.title, lprice: item.lprice, mall: item.mall };
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  out.mallLabel = str(item.mallLabel);
  out.image = str(item.image);
  out.productId = str(item.productId);
  out.vendorItemId = str(item.vendorItemId);
  out.link = str(item.link);
  out.oprice = num(item.oprice);
  out.savePct = num(item.savePct);
  out.collectedAt = str(item.collectedAt);
  if (typeof item.isAllTimeLow === 'boolean') out.isAllTimeLow = item.isAllTimeLow;
  if (typeof item.isRocket === 'boolean') out.isRocket = item.isRocket;
  const trust = cleanTrust(item.trust);
  if (trust) out.trust = trust;
  for (const key of Object.keys(out) as (keyof Product)[]) if (out[key] === undefined) delete out[key];
  return out;
}

/**
 * Recovers the exact Product a list card was showing from a router param (the caller JSON-encodes
 * it before navigating). Coupang packs unrelated options under one productId+mall, distinguished
 * only by vendorItemId — refetching by productId+mall alone can land on the wrong option's title,
 * price, and history, so the product detail screen carries the tapped card's data forward instead
 * of re-resolving it from scratch. Malformed or missing input is not an error here, just "unknown".
 */
export function productFromParam(value: string | undefined): Product | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isProduct(parsed) ? cleanProduct(parsed) : null;
  } catch {
    return null;
  }
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
      return usableItems(data, isProduct, 'Invalid search product').map(cleanProduct);
    },
    async product(id: string, mall?: string, signal?: AbortSignal): Promise<ProductDetail> {
      const data = await get('/api/history', { __route: 'product', pid: id, ...(mall ? { mall } : {}) }, timeouts.detailMs, signal) as Partial<ProductDetail>;
      if (!data || !isProduct(data.product) || data.product.productId !== id || !isPoints(data.points) || !isDeal(data.deal)) throw new ApiError('invalid_response', 'Invalid product response');
      return { product: cleanProduct(data.product), points: data.points, deal: cleanDeal(data.deal) };
    },
    async history(product: Product, signal?: AbortSignal): Promise<PriceHistory> {
      if (!product.productId) throw new ApiError('request', '상품 식별자가 없어요.');
      const data = await get('/api/history', { productId: product.productId, mall: product.mall, vendorItemId: product.vendorItemId || '', deal: '1' }, timeouts.detailMs, signal) as Partial<PriceHistory>;
      if (!data || !isPoints(data.points) || !isDeal(data.deal)) throw new ApiError('invalid_response', 'Invalid history response');
      return { points: data.points, deal: cleanDeal(data.deal) };
    },
    /**
     * Web home data (핫딜 · 오늘의 셀렉션 · 이달의 추천 · 인기 검색어).
     * Read-only on the server and cached at the edge for 5 minutes. Each section is filtered on its own;
     * the whole response is only rejected when nothing usable remains in a non-empty payload.
     */
    async home(signal?: AbortSignal): Promise<HomeFeed> {
      const data = await get('/api/init', {}, timeouts.homeMs, signal) as Record<string, unknown> | null;
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ApiError('invalid_response', 'Invalid home response');
      const list = (value: unknown) => (Array.isArray(value) ? value : []);
      const products = (value: unknown) => list(value).filter(isProduct).map(cleanProduct);

      const rawDrops = list(data.priceDrop);
      const daily = data.daily && typeof data.daily === 'object' ? data.daily as Record<string, unknown> : null;
      const monthly = data.monthly && typeof data.monthly === 'object' ? data.monthly as Record<string, unknown> : null;
      const rawDaily = daily ? list(daily.products) : [];
      const rawMonthly = monthly ? list(monthly.products) : [];

      const feed: HomeFeed = {
        keywords: list(data.popular)
          .map(row => (row && typeof row === 'object' ? (row as { keyword?: unknown }).keyword : row))
          .filter((k): k is string => typeof k === 'string' && k.trim() !== ''),
        drops: products(rawDrops),
        daily: daily && typeof daily.keyword === 'string' ? { keyword: daily.keyword, products: products(rawDaily) } : null,
        monthly: monthly && typeof monthly.title === 'string' ? {
          month: typeof monthly.month === 'number' ? monthly.month : null,
          title: monthly.title,
          subtitle: typeof monthly.subtitle === 'string' ? monthly.subtitle : '',
          products: products(rawMonthly),
        } : null,
      };
      const offered = rawDrops.length + rawDaily.length + rawMonthly.length;
      const usable = feed.drops.length + (feed.daily?.products.length || 0) + (feed.monthly?.products.length || 0);
      if (offered > 0 && usable === 0) throw new ApiError('invalid_response', 'Invalid home response');
      return feed;
    },
    async homeDeals(signal?: AbortSignal): Promise<HomeDeal[]> {
      const data = await get('/api/hotdeals', { source: 'internal-history', limit: '4', sort: 'score' }, timeouts.homeMs, signal) as { items?: unknown };
      if (!data || !Array.isArray(data.items)) throw new ApiError('invalid_response', 'Invalid hotdeal response');
      return usableItems(data.items, isHomeDeal, 'Invalid hotdeal response');
    },
  };
}

export const api = createApiClient();
