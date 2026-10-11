import { productKey, sameProduct } from './identity.ts';
import { safeUrl } from './parse.ts';
import type { PricePoint, Product, ProductIdentity } from './types.ts';

/*
 * Saved products (찜). Pure list operations; persistence lives in lib/saved.tsx.
 *
 * Stored on the device only in this version. The web keeps its own list in localStorage and
 * syncs it through POST /api/sync, which REPLACES the whole list for that email — writing from
 * the app would silently overwrite what the user saved on the web. Cloud sync therefore waits
 * for a merge-safe design (see docs/ARCHITECTURE.md).
 *
 * Every item keeps the full option identity (productId + mall + vendorItemId), so two options
 * of one Coupang page stay two items with two histories.
 */

export const SAVED_LIMIT = 200;   // the web's wish limit (Sync.cleanList(obj.wish, 200))

export type SavedItem = ProductIdentity & {
  title: string;
  mallLabel: string;
  image: string;
  link: string;
  /** Price on screen when the user saved it, and when. Shown as such — never as today's price. */
  savedPrice: number;
  savedAt: string;
};

export function toSavedItem(p: Product, now: Date = new Date()): SavedItem {
  return {
    productId: p.productId,
    mall: p.mall,
    vendorItemId: p.vendorItemId || '',
    title: p.title,
    mallLabel: p.mallLabel || p.mall,
    image: p.image,
    link: p.link,
    savedPrice: p.price,
    savedAt: now.toISOString(),
  };
}

export function isSaved(list: readonly SavedItem[], id: ProductIdentity): boolean {
  return list.some(s => sameProduct(s, id));
}

/** Adds to the front, or removes when already saved. Returns a new list. */
export function toggleSaved(list: readonly SavedItem[], p: Product, now: Date = new Date()): SavedItem[] {
  if (isSaved(list, p)) return list.filter(s => !sameProduct(s, p));
  return [toSavedItem(p, now), ...list].slice(0, SAVED_LIMIT);
}

export function removeSaved(list: readonly SavedItem[], id: ProductIdentity): SavedItem[] {
  return list.filter(s => !sameProduct(s, id));
}

/** Reads what was stored, keeping only well-formed items (storage can hold anything after an upgrade). */
export function restoreSaved(value: unknown): SavedItem[] {
  if (!Array.isArray(value)) return [];
  const out: SavedItem[] = [];
  for (const v of value) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    const productId = typeof o.productId === 'string' ? o.productId : '';
    const mall = typeof o.mall === 'string' ? o.mall : '';
    const title = typeof o.title === 'string' ? o.title : '';
    const savedPrice = typeof o.savedPrice === 'number' && o.savedPrice > 0 ? o.savedPrice : 0;
    if (!productId || !mall || !title || !savedPrice) continue;
    const item: SavedItem = {
      productId, mall, title, savedPrice,
      vendorItemId: typeof o.vendorItemId === 'string' ? o.vendorItemId : '',
      mallLabel: typeof o.mallLabel === 'string' && o.mallLabel ? o.mallLabel : mall,
      image: safeUrl(o.image),
      link: safeUrl(o.link),
      savedAt: typeof o.savedAt === 'string' ? o.savedAt : '',
    };
    if (!isSaved(out, item)) out.push(item);
    if (out.length >= SAVED_LIMIT) break;
  }
  return out;
}

export type SavedStatus = {
  /** The latest server observation for this option, or null when the server has none. */
  latest: PricePoint | null;
  /** latest − savedPrice (negative = cheaper now). null without a latest point. */
  change: number | null;
};

export function savedStatus(item: SavedItem, points: readonly PricePoint[] | undefined): SavedStatus {
  const latest = points && points.length ? points[points.length - 1] : null;
  return { latest, change: latest ? latest.price - item.savedPrice : null };
}

export const savedKey = productKey;
