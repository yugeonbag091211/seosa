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

/** Parses a key back. Only used for route params, which the app itself produced. */
export function parseProductKey(key: string): ProductIdentity | null {
  const parts = String(key || '').split('|');
  if (parts.length < 2 || !parts[0]) return null;
  return { productId: parts[0], mall: parts[1], vendorItemId: parts.slice(2).join('|') };
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
