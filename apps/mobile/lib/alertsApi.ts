import { ApiError, displayableServerText, normalizeBaseUrl } from './api.ts';
import type { Product } from './types.ts';

export type PriceAlertRecord = {
  title: string;
  targetPrice: number;
  currentPrice: number;
  link: string;
  image: string;
  mall: string;
  productId: string;
  vendorItemId: string;
  sent: boolean;
  onDeal: boolean;
};

type AlertsFetch = typeof fetch;

type Options = {
  baseUrl: string;
  fetchImpl?: AlertsFetch;
  timeoutMs?: number;
};

function text(value: unknown, max = 2000): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function positiveInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function parseAlert(value: unknown): PriceAlertRecord | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const title = text(row.title, 300).trim();
  if (!title) return null;
  return {
    title,
    targetPrice: positiveInt(row.targetPrice),
    currentPrice: positiveInt(row.currentPrice),
    link: text(row.link),
    image: text(row.image),
    mall: text(row.mall, 100),
    productId: text(row.productId, 100),
    vendorItemId: text(row.vendorItemId, 200).trim(),
    sent: row.sent === true || row.sent === 'Y',
    onDeal: row.onDeal === true,
  };
}

export function createAlertsApi(options: Options) {
  const base = normalizeBaseUrl(options.baseUrl);
  const doFetch = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || 15_000;

  async function request(method: 'GET' | 'POST' | 'DELETE', email: string, token: string, body?: unknown): Promise<unknown> {
    if (!email || !token) throw new ApiError('unauthorized', '');
    const url = new URL(base + '/api/alerts');
    if (method === 'GET') url.searchParams.set('email', email);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await doFetch(url.toString(), {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      let payload: unknown = null;
      try { payload = await response.json(); } catch { payload = null; }
      const serverText = payload && typeof payload === 'object'
        ? displayableServerText((payload as { error?: unknown }).error)
        : '';
      const retryAfter = Number(response.headers.get('Retry-After')) || 0;

      if (response.status >= 500) throw new ApiError('unavailable', serverText, response.status, retryAfter);
      if (response.status === 429) throw new ApiError('rate_limited', serverText, 429, retryAfter);
      if (response.status === 401) throw new ApiError('unauthorized', serverText, 401);
      if (response.status >= 400) throw new ApiError('bad_request', serverText, response.status);
      if (payload === null) throw new ApiError('invalid_response', '', response.status);
      return payload;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (timedOut) throw new ApiError('timeout', '');
      throw new ApiError('network', '');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async list(email: string, token: string): Promise<PriceAlertRecord[]> {
      const payload = await request('GET', email, token);
      if (!Array.isArray(payload)) throw new ApiError('invalid_response', '');
      return payload.map(parseAlert).filter((row): row is PriceAlertRecord => !!row);
    },

    async save(args: {
      email: string;
      token: string;
      product: Pick<Product, 'productId' | 'vendorItemId' | 'title' | 'link' | 'image' | 'mall'>;
      currentPrice: number;
      targetPrice: number;
    }): Promise<void> {
      const vendorItemId = String(args.product.vendorItemId || '').trim();
      if (!vendorItemId) {
        throw new ApiError('bad_request', '이 상품 옵션은 아직 가격 알림을 지원하지 않아요.');
      }
      const targetPrice = positiveInt(args.targetPrice);
      if (!targetPrice) throw new ApiError('bad_request', '목표 가격을 1원 이상 입력해 주세요.');
      const currentPrice = positiveInt(args.currentPrice);
      if (currentPrice > 0 && targetPrice >= currentPrice) {
        throw new ApiError('bad_request', '목표 가격은 현재 표시 가격보다 낮게 입력해 주세요.');
      }

      const payload = await request('POST', args.email, args.token, {
        email: args.email,
        title: args.product.title,
        targetPrice,
        currentPrice,
        link: args.product.link,
        image: args.product.image,
        mall: args.product.mall,
        productId: args.product.productId,
        vendorItemId,
        onDeal: false,
      });
      if (!payload || typeof payload !== 'object' || (payload as { success?: unknown }).success !== true) {
        throw new ApiError('invalid_response', '');
      }
    },

    async remove(email: string, token: string, title: string): Promise<void> {
      const payload = await request('DELETE', email, token, { email, title });
      if (!payload || typeof payload !== 'object' || (payload as { success?: unknown }).success !== true) {
        throw new ApiError('invalid_response', '');
      }
    },
  };
}
