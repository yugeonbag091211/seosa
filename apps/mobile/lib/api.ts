import { parseAiAnswer, parseDeal, parsePoints, parseProducts, parseTodayDrops } from './parse.ts';
import type { AiAnswer, HomeFeed, PriceHistory, PricePoint, Product, ProductIdentity, SearchResult, SearchSource, Session, TodayDrop } from './types.ts';

/*
 * SEOSA API client. Pure (no React Native import) so node tests drive it with a fake fetch.
 *
 * It calls exactly the endpoints the web calls, with the same parameters:
 *   GET  /api/search?keyword=                     검색 (쿠팡·ADPICK, 서버 캐시)
 *   GET  /api/history?productId=&mall=&vendorItemId=&deal=1   가격 이력 + 서버 판정
 *   GET  /api/hotdeals?view=today-drop&limit=60   오늘 가격 하락 (웹 홈과 같은 목록)
 *   GET  /api/init                                 인기 검색어 · 오늘의 셀렉션
 *   POST /api/auth                                 이메일 인증 코드 → 토큰
 *   POST /api/ai                                   AI 컨시어지
 * No endpoint, limit or parameter is invented here, and nothing writes except auth/AI,
 * which the web writes the same way.
 */

export type ApiErrorKind =
  | 'network' | 'timeout' | 'unavailable' | 'rate_limited' | 'unauthorized'
  | 'bad_request' | 'not_found' | 'invalid_response' | 'aborted';

export class ApiError extends Error {
  kind: ApiErrorKind;
  status: number;
  /** Seconds, from Retry-After, when the server sent one. */
  retryAfter: number;

  constructor(kind: ApiErrorKind, message: string, status = 0, retryAfter = 0) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** What the user reads. Server 5xx text is never shown (it can carry internal details); 4xx text is written for users. */
export function userMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return '정보를 불러오지 못했어요. 다시 시도해 주세요.';
  switch (error.kind) {
    case 'network': return '네트워크 연결을 확인한 뒤 다시 시도해 주세요.';
    case 'timeout': return '응답이 늦어지고 있어요. 다시 시도해 주세요.';
    case 'unavailable': return '지금은 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.';
    case 'rate_limited': return error.message || '요청이 많아요. 잠시 후 다시 시도해 주세요.';
    case 'unauthorized': return '로그인이 만료됐어요. 다시 로그인해 주세요.';
    case 'bad_request': return error.message || '요청을 처리하지 못했어요.';
    case 'not_found': return '정보를 찾을 수 없어요.';
    case 'invalid_response': return '받은 정보를 읽지 못했어요. 다시 시도해 주세요.';
    case 'aborted': return '';
  }
}

/** Retrying helps only for transient failures. A 4xx will fail the same way again. */
export function isRetryable(error: unknown): boolean {
  return error instanceof ApiError && (error.kind === 'network' || error.kind === 'timeout' || error.kind === 'unavailable');
}

export const TIMEOUTS = {
  search: 25_000,   // Coupang + ADPICK + DB write on a cache miss
  history: 15_000,
  drops: 15_000,    // cold miss measured ~6 s
  init: 20_000,     // cold miss measured 13–14.5 s (2026-09-28); edge-cached for 5 min otherwise
  auth: 15_000,
  ai: 30_000,       // the web's CHAT_TIMEOUT_MS
} as const;

export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError('bad_request', 'API 주소를 확인해 주세요.'); }
  const local = /^(localhost|127\.0\.0\.1|10\.0\.2\.2|192\.168\.\d+\.\d+)$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new ApiError('bad_request', 'API 주소는 https 여야 해요.');
  }
  return url.origin;
}

type RequestOptions = {
  method?: 'GET' | 'POST';
  query?: Record<string, string>;
  body?: unknown;
  token?: string;
  timeoutMs: number;
  signal?: AbortSignal;
};

type RawResponse = { status: number; headers: { get(name: string): string | null }; body: unknown };

export type ApiClient = ReturnType<typeof createApi>;

export function createApi(options: { baseUrl: string; fetchImpl?: typeof fetch }) {
  const base = normalizeBaseUrl(options.baseUrl);
  const doFetch = options.fetchImpl || fetch;

  async function request(path: string, opts: RequestOptions): Promise<RawResponse> {
    if (opts.signal?.aborted) throw new ApiError('aborted', '');
    const url = new URL(base + path);
    Object.entries(opts.query || {}).forEach(([k, v]) => url.searchParams.set(k, v));

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, opts.timeoutMs);

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

    try {
      const res = await doFetch(url.toString(), {
        method: opts.method || 'GET',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
      let body: unknown = null;
      try { body = await res.json(); } catch { body = null; }
      const serverText = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error : '';
      const retryAfter = Number(res.headers.get('Retry-After')) || 0;

      if (res.status >= 500) throw new ApiError('unavailable', '', res.status, retryAfter);
      if (res.status === 429) throw new ApiError('rate_limited', serverText, 429, retryAfter);
      if (res.status === 401) throw new ApiError('unauthorized', serverText, 401);
      if (res.status === 404) throw new ApiError('not_found', serverText, 404);
      if (res.status >= 400) throw new ApiError('bad_request', serverText, res.status);
      if (body === null) {
        if (timedOut) throw new ApiError('timeout', '');
        if (opts.signal?.aborted) throw new ApiError('aborted', '');
        throw new ApiError('invalid_response', '', res.status);
      }
      return { status: res.status, headers: res.headers, body };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (timedOut) throw new ApiError('timeout', '');
      if (opts.signal?.aborted) throw new ApiError('aborted', '');
      throw new ApiError('network', '');
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  function decodeHeaderList(value: string | null): string[] {
    if (!value) return [];
    return value.split('|').map(s => { try { return decodeURIComponent(s); } catch { return ''; } }).filter(Boolean);
  }

  return {
    baseUrl: base,

    async search(keyword: string, signal?: AbortSignal): Promise<SearchResult> {
      const q = keyword.trim().slice(0, 80);
      if (!q) throw new ApiError('bad_request', '검색어를 입력해 주세요.');
      const r = await request('/api/search', { query: { keyword: q }, timeoutMs: TIMEOUTS.search, signal });
      if (!Array.isArray(r.body)) throw new ApiError('invalid_response', '', r.status);
      const items = parseProducts(r.body);
      if (r.body.length > 0 && items.length === 0) throw new ApiError('invalid_response', '', r.status);
      const source = (r.headers.get('X-Seosa-Source') || '') as SearchSource;
      let corrected = '';
      try { corrected = decodeURIComponent(r.headers.get('X-Seosa-Correct') || ''); } catch { corrected = ''; }
      return {
        items,
        source,
        blocked: r.headers.get('X-Seosa-Blocked') === '1',
        corrected,
        suggestions: decodeHeaderList(r.headers.get('X-Seosa-Suggest')),
      };
    },

    /** Same call as the web price modal: option-level history plus the server's verdict. */
    async history(id: ProductIdentity, signal?: AbortSignal): Promise<PriceHistory> {
      if (!id.productId) return { points: [], deal: null };
      const query: Record<string, string> = { productId: id.productId, mall: id.mall || '', deal: '1' };
      if (id.vendorItemId) query.vendorItemId = id.vendorItemId;
      const r = await request('/api/history', { query, timeoutMs: TIMEOUTS.history, signal });
      const body = r.body as { points?: unknown; deal?: unknown } | unknown[];
      if (Array.isArray(body)) return { points: parsePoints(body), deal: null };
      if (!body || typeof body !== 'object' || !Array.isArray(body.points)) throw new ApiError('invalid_response', '', r.status);
      return { points: parsePoints(body.points), deal: parseDeal(body.deal) };
    },

    /**
     * Latest points for several saved products at once — the web's Wish.refreshPrices call.
     * Keys are lib/identity.productKey values; the server narrows each to its option.
     */
    async historyBatch(keys: readonly string[], signal?: AbortSignal): Promise<Record<string, PricePoint[]>> {
      const list = [...new Set(keys.filter(Boolean))].slice(0, 100);
      if (!list.length) return {};
      const r = await request('/api/history-batch', { query: { keys: JSON.stringify(list) }, timeoutMs: TIMEOUTS.history, signal });
      if (!r.body || typeof r.body !== 'object' || Array.isArray(r.body)) throw new ApiError('invalid_response', '', r.status);
      const out: Record<string, PricePoint[]> = {};
      for (const k of list) out[k] = parsePoints((r.body as Record<string, unknown>)[k]);
      return out;
    },

    /**
     * Deep-link lookup (seosa.ai.kr/p/<pid>): the catalog row for a product id.
     * The catalog keeps one row per (productId, mall), i.e. one option. The caller must compare the
     * returned vendorItemId with the one it was asked about before showing this price.
     */
    async productById(productId: string, mall: string, signal?: AbortSignal): Promise<{ product: Product; points: PricePoint[] } | null> {
      const query: Record<string, string> = { __route: 'product', pid: productId };
      if (mall) query.mall = mall;
      try {
        const r = await request('/api/history', { query, timeoutMs: TIMEOUTS.history, signal });
        const b = r.body as { product?: unknown; points?: unknown };
        const product = parseProducts([b?.product])[0];
        if (!product || product.productId !== productId) throw new ApiError('invalid_response', '', r.status);
        return { product, points: parsePoints(b.points) };
      } catch (error) {
        if (error instanceof ApiError && error.kind === 'not_found') return null;
        throw error;
      }
    },

    /** The web home's «오늘 가격 하락» list, same query (public/index.html Api.call getHotdeals). */
    async todayDrops(signal?: AbortSignal): Promise<TodayDrop[]> {
      const r = await request('/api/hotdeals', { query: { view: 'today-drop', limit: '60' }, timeoutMs: TIMEOUTS.drops, signal });
      if (!r.body || typeof r.body !== 'object' || !Array.isArray((r.body as { items?: unknown }).items)) {
        throw new ApiError('invalid_response', '', r.status);
      }
      return parseTodayDrops(r.body);
    },

    /** Popular keywords and today's selection. `priceDrop` from this payload is legacy and not read (the web doesn't either). */
    async home(signal?: AbortSignal): Promise<HomeFeed> {
      const r = await request('/api/init', { timeoutMs: TIMEOUTS.init, signal });
      const b = r.body as { popular?: unknown; daily?: unknown };
      if (!b || typeof b !== 'object') throw new ApiError('invalid_response', '', r.status);
      const popular = Array.isArray(b.popular)
        ? b.popular.map(p => (p && typeof p === 'object' ? (p as { keyword?: unknown }).keyword : p))
          .filter((k): k is string => typeof k === 'string' && k.trim() !== '' && !k.startsWith('__')).slice(0, 12)
        : [];
      const d = b.daily as { keyword?: unknown; products?: unknown } | undefined;
      const daily = d && typeof d === 'object' && typeof d.keyword === 'string'
        ? { keyword: d.keyword, products: parseProducts(d.products) } : null;
      return { popular, daily };
    },

    /** Step 1: mail a 6-digit code. The code itself never comes back. */
    async requestCode(email: string): Promise<{ expiresInSec: number }> {
      const r = await request('/api/auth', { method: 'POST', body: { email }, timeoutMs: TIMEOUTS.auth });
      const b = r.body as { sent?: unknown; expiresInSec?: unknown };
      if (b?.sent !== true) throw new ApiError('invalid_response', '', r.status);
      return { expiresInSec: Number(b.expiresInSec) || 600 };
    },

    /** Step 2: exchange the code for the server-signed token (30 days, api/_auth.js). */
    async verifyCode(email: string, code: string): Promise<Session> {
      const r = await request('/api/auth', { method: 'POST', body: { email, code }, timeoutMs: TIMEOUTS.auth });
      const b = r.body as { token?: unknown; email?: unknown; expiresAt?: unknown };
      if (typeof b?.token !== 'string' || !b.token) throw new ApiError('invalid_response', '', r.status);
      return { token: b.token, email: typeof b.email === 'string' ? b.email : email, expiresAt: typeof b.expiresAt === 'string' ? b.expiresAt : '' };
    },

    /**
     * AI concierge. Without a token the server answers in guest mode, like the web.
     * The body comes from lib/ai.ts buildAiRequest, which carries selectors only.
     */
    async ask(body: unknown, token: string | undefined, signal?: AbortSignal): Promise<AiAnswer> {
      const r = await request('/api/ai', { method: 'POST', body, token, timeoutMs: TIMEOUTS.ai, signal });
      const answer = parseAiAnswer(r.body);
      if (!answer) throw new ApiError('invalid_response', '', r.status);
      return answer;
    },
  };
}
