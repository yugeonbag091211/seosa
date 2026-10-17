import type { Product } from './types.ts';

export type SearchSort = 'relevance' | 'price' | 'drop';

/**
 * Reorders only the products the server already returned. It never expands the result set,
 * changes matching, or treats missing drop evidence as a discount.
 */
export function arrangeSearchResults(
  items: readonly Product[],
  sort: SearchSort = 'relevance',
): Product[] {
  if (sort === 'relevance') return [...items];

  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      if (sort === 'price') {
        if (a.item.price !== b.item.price) return a.item.price - b.item.price;
      } else {
        const aDrop = a.item.priceChange;
        const bDrop = b.item.priceChange;
        if (!aDrop && bDrop) return 1;
        if (aDrop && !bDrop) return -1;
        if (aDrop && bDrop) {
          if (aDrop.dropPct !== bDrop.dropPct) return bDrop.dropPct - aDrop.dropPct;
          if (aDrop.dropAmount !== bDrop.dropAmount) return bDrop.dropAmount - aDrop.dropAmount;
        }
      }
      return a.index - b.index;
    })
    .map(row => row.item);
}
