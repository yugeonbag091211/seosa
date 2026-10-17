import { digits } from './format.ts';
import type { Product } from './types.ts';

const SEOSA_ORIGIN = 'https://seosa.ai.kr';

/** Public server-rendered SEOSA product URL used by web share cards and mobile sharing. */
export function productShareUrl(productId: string): string {
  const id = String(productId || '').trim();
  return id ? `${SEOSA_ORIGIN}/p/${encodeURIComponent(id)}` : SEOSA_ORIGIN;
}

/**
 * One payload for both platforms. Android reliably shares `message`; iOS can also use `url`.
 * We intentionally share the SEOSA product page, never a merchant affiliate URL.
 */
export function productShareContent(
  product: Pick<Product, 'productId' | 'title'>,
  currentPrice: number,
): { title: string; message: string; url: string } {
  const title = String(product.title || '').trim() || 'SEOSA 상품';
  const url = productShareUrl(product.productId);
  const price = Number.isFinite(currentPrice) && currentPrice > 0
    ? `현재 ${digits(Math.round(currentPrice))}원`
    : '';

  return {
    title,
    url,
    message: [title, price, 'SEOSA에서 가격 추이 보기', url].filter(Boolean).join('\n'),
  };
}
