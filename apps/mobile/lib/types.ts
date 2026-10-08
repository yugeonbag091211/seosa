/*
 * Shapes the app reads from the SEOSA API. Field names match the server exactly
 * (api/_shop.toClientProduct, api/hotdeals.toTodayDropItem, api/history.publicDeal)
 * so a value never changes meaning between the web and the app.
 */

/**
 * The key that identifies a sellable unit. All three parts matter:
 *   productId     — the product page (Coupang) or a hash of the commission link (ADPICK)
 *   mall          — backend mall id ('쿠팡' | 'ADPICK' | legacy). Never the display label.
 *   vendorItemId  — the option actually sold (Coupang). Always '' for ADPICK.
 * Coupang packs different options under one productId, so dropping vendorItemId mixes their prices.
 */
export type ProductIdentity = {
  productId: string;
  mall: string;
  vendorItemId: string;
};

export type TrustReason = { kind: string; text: string };
export type Trust = { level: string; label: string; reasons: TrustReason[] };

/** A product row as search, /api/init and the AI return it. `price` is the server's `lprice`. */
export type Product = ProductIdentity & {
  title: string;
  price: number;
  /** Display name of the mall (ADPICK rows carry the partner mall name here). */
  mallLabel: string;
  image: string;
  /** Affiliate URL exactly as the server gave it. Opened as-is, never rebuilt. */
  link: string;
  /** List price when the provider gives one (Coupang only). 0 when unknown. */
  listPrice: number;
  savePct: number;
  /** When this price was observed (ISO). '' for live search results. */
  collectedAt: string;
  isRocket: boolean | null;
  trust: Trust | null;
  /** Server-judged recent drop (api/_facets.attachPriceChange). Only kept when it describes this exact price. */
  priceChange: PriceChange | null;
};

export type PriceChange = { prevPrice: number; dropAmount: number; dropPct: number; isAllTimeLow: boolean };

/** One card of «오늘 가격 하락» (GET /api/hotdeals?view=today-drop). Every number is the server's. */
export type TodayDrop = ProductIdentity & {
  id: string;
  title: string;
  image: string;
  mallLabel: string;
  link: string;
  currentPrice: number;
  previousPrice: number;
  dropAmount: number;
  dropPct: number;
  /** Passed the stricter hot-deal engine too («SEOSA 검증»). */
  verified: boolean;
  recordedAt: string;
  previousAt: string;
};

export type PricePoint = { date: string; price: number };

export type DealStats = {
  low: number;
  high: number;
  avg7: number;
  avg30: number;
  historyDays: number;
  count: number;
};

/** Server verdict (api/history.js publicDeal). Rendered verbatim; the app never rephrases or recomputes it. */
export type Deal = {
  verdict: string;
  label: string;
  reasons: string[];
  cautions: string[];
  stats: DealStats | null;
};

export type PriceHistory = { points: PricePoint[]; deal: Deal | null };

/** Where the search prices came from (X-Seosa-Source). */
export type SearchSource = 'api' | 'cache' | 'stale-cache' | 'none' | '';

export type SearchResult = {
  items: Product[];
  source: SearchSource;
  /** Coupang was rate-limited or unavailable; the results may be older. */
  blocked: boolean;
  /** Only filled when there are no results. */
  corrected: string;
  suggestions: string[];
};

export type HomeFeed = {
  popular: string[];
  daily: { keyword: string; products: Product[] } | null;
};

export type Session = { token: string; email: string; expiresAt: string };

export type AiTurn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; sig?: string };

export type AiAnswer = {
  text: string;
  items: Product[];
  followups: string[];
  guest: boolean;
  topProductId: string;
  topRecommendationRef: string;
  turnSig: string;
  recommendationChanged: string | null;
};
