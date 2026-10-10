import type { ProductIdentity } from './types.ts';

/*
 * Option-level identity, identical to the web's histKey() (public/index.html) and the
 * server's splitKey() (api/history.js): "<productId>|<mall>" plus "|<vendorItemId>" when known.
 *
 * Everything that stores, dedupes or looks up a product goes through here, so two options of
 * one Coupang page can never collapse into one saved item or one price history.
 */
export function productKey(p: ProductIdentity): string {
  if (!p || !p.productId) return '';
  const base = `${p.productId}|${p.mall || ''}`;
  return p.vendorItemId ? `${base}|${p.vendorItemId}` : base;
}

export function sameProduct(a: ProductIdentity | null | undefined, b: ProductIdentity | null | undefined): boolean {
  if (!a || !b || !a.productId || !b.productId) return false;
  return a.productId === b.productId && (a.mall || '') === (b.mall || '') && (a.vendorItemId || '') === (b.vendorItemId || '');
}

/**
 * Parses a key back. Route params are normally the app's own, but a seosa:// deep link can carry
 * anything, so oversized parts and control characters are refused rather than sent to the API.
 */
export function parseProductKey(key: string): ProductIdentity | null {
  const raw = String(key || '');
  if (raw.length > 400 || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  const parts = raw.split('|');
  if (parts.length < 2 || !parts[0]) return null;
  const id = { productId: parts[0], mall: parts[1], vendorItemId: parts.slice(2).join('|') };
  if (id.productId.length > 128 || id.mall.length > 40 || id.vendorItemId.length > 128) return null;
  return id;
}

/** The backend mall id for Coupang. Display labels (mallLabel) are never compared against this. */
export const COUPANG = '쿠팡';
export const ADPICK = 'ADPICK';

/**
 * A Coupang row without an option id cannot be tied to one sellable unit. The server's AI
 * context check refuses it (api/_aicontext.matchCatalog 'option-missing'); the app shows its
 * history only as the server resolves it and never guesses an option.
 */
export function hasCompleteIdentity(p: ProductIdentity): boolean {
  if (!p.productId || !p.mall) return false;
  return p.mall !== COUPANG || !!p.vendorItemId;
}
