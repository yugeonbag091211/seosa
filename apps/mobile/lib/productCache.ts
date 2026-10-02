import { productKey } from './identity.ts';
import type { Product } from './types.ts';

/*
 * Hands the tapped row to the detail screen.
 *
 * The detail screen must show the same option the user tapped. Re-resolving it from the
 * catalog by productId alone can land on another option (the catalog keeps one row per
 * product+mall), so the row travels with the navigation instead. The route carries only
 * the option key; this map holds the row for the app's lifetime (bounded).
 */
const MAX = 300;
const rows = new Map<string, Product>();

export function rememberProduct(p: Product): string {
  const key = productKey(p);
  if (!key) return '';
  rows.delete(key);
  rows.set(key, p);
  if (rows.size > MAX) rows.delete(rows.keys().next().value as string);
  return key;
}

export function recallProduct(key: string): Product | null {
  return rows.get(key) || null;
}
