import type { SavedItem } from './savedModel.ts';
import type { PricePoint, Product, TodayDrop } from './types.ts';

/*
 * Rows from other lists turned into the Product the detail screen opens. Pure, so the flow tests
 * can prove the option identity and the affiliate link travel unchanged from list to buy button.
 */

/** A today-drop card as a Product for the detail screen — its price is the server's current price. */
export function dropAsProduct(d: TodayDrop): Product {
  return {
    productId: d.productId, mall: d.mall, vendorItemId: d.vendorItemId,
    title: d.title, price: d.currentPrice, mallLabel: d.mallLabel, image: d.image, link: d.link,
    listPrice: 0, savePct: 0, collectedAt: d.recordedAt, isRocket: null, trust: null,
    priceChange: { prevPrice: d.previousPrice, dropAmount: d.dropAmount, dropPct: d.dropPct, isAllTimeLow: false },
    // AI 가 서버에서 적어 주는 「다른 모델」 라벨만 쓰므로, 다른 자리에서 만든 Product 는 비워 둔다.
    identityNote: '',
  };
}

/** A saved item as a Product. Until the detail screen loads history, it shows the newest price we can date. */
export function savedAsProduct(item: SavedItem, latest: PricePoint | null): Product {
  return {
    productId: item.productId, mall: item.mall, vendorItemId: item.vendorItemId,
    title: item.title, mallLabel: item.mallLabel, image: item.image, link: item.link,
    price: latest ? latest.price : item.savedPrice,
    collectedAt: latest ? latest.date : item.savedAt,
    listPrice: 0, savePct: 0, isRocket: null, trust: null, priceChange: null,
    identityNote: '',
  };
}
