import { decodeHtmlEntities } from './text.ts';
import type { AiAnswer, Deal, DealStats, PriceChange, PricePoint, Product, TodayDrop, Trust, TrustReason } from './types.ts';

/*
 * Server payload → app types. Pure.
 *
 * The rule throughout: a row the app cannot fully trust is dropped, never patched.
 * A product without an id, a price of 0, a drop whose numbers do not add up — each is
 * left off the screen rather than shown with a made-up or default value.
 */

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : NaN);
const positive = (v: unknown): number => { const n = num(v); return n > 0 ? n : 0; };

/** Only absolute http(s) URLs pass (the web's Fmt.safeUrl). The string itself is returned untouched. */
export function safeUrl(value: unknown): string {
  const s = typeof value === 'string' ? value.trim() : '';
  return /^https?:\/\//i.test(s) ? s : '';
}

function parseTrust(value: unknown): Trust | null {
  if (!isObj(value) || typeof value.level !== 'string' || typeof value.label !== 'string') return null;
  const reasons: TrustReason[] = Array.isArray(value.reasons)
    ? value.reasons.filter(isObj).map(r => ({ kind: str(r.kind), text: str(r.text) })).filter(r => r.text)
    : [];
  return { level: value.level, label: value.label, reasons };
}

/**
 * The drop badge is only kept when the server row describes the very price on this card.
 * The view it comes from can lag the live search price; a mismatch means the badge would
 * talk about a different observation, so it is dropped (the web shows it on dropPct alone).
 */
function parsePriceChange(value: unknown, price: number): PriceChange | null {
  if (!isObj(value)) return null;
  const prevPrice = positive(value.prevPrice);
  const currentPrice = positive(value.currentPrice);
  const dropAmount = positive(value.dropAmount);
  const dropPct = positive(value.dropPct);
  if (!prevPrice || !currentPrice || !dropPct || currentPrice !== price || prevPrice <= currentPrice) return null;
  return { prevPrice, dropAmount: dropAmount || prevPrice - currentPrice, dropPct, isAllTimeLow: value.isAllTimeLow === true };
}

/** A product row (search, /api/init, AI items). */
export function parseProduct(value: unknown): Product | null {
  if (!isObj(value)) return null;
  const productId = str(value.productId).trim();
  const mall = str(value.mall).trim();
  const title = decodeHtmlEntities(str(value.title).trim());
  const price = positive(value.lprice);
  if (!productId || !mall || !title || !price) return null;
  const listPrice = positive(value.oprice);
  const savePct = positive(value.savePct);
  return {
    productId,
    mall,
    vendorItemId: str(value.vendorItemId).trim(),
    title,
    price,
    mallLabel: decodeHtmlEntities(str(value.mallLabel).trim()) || mall,
    image: safeUrl(value.image),
    link: safeUrl(value.link),
    listPrice: listPrice > price ? listPrice : 0,
    savePct: listPrice > price ? savePct : 0,
    collectedAt: str(value.collectedAt),
    isRocket: typeof value.isRocket === 'boolean' ? value.isRocket : null,
    trust: parseTrust(value.trust),
    priceChange: parsePriceChange(value.priceChange, price),
  };
}

export function parseProducts(value: unknown): Product[] {
  return Array.isArray(value) ? value.map(parseProduct).filter((p): p is Product => !!p) : [];
}

/**
 * «오늘 가격 하락» card. Every number must be present, positive and consistent with the others
 * (previous − current = amount, within a won). Otherwise the card is dropped.
 */
export function parseTodayDrop(value: unknown): TodayDrop | null {
  if (!isObj(value)) return null;
  const productId = str(value.productId).trim();
  const mall = str(value.mall).trim();
  const title = decodeHtmlEntities(str(value.title).trim());
  const currentPrice = positive(value.currentPrice);
  const previousPrice = positive(value.previousPrice);
  const dropAmount = positive(value.dropAmount);
  const dropPct = positive(value.dropPct);
  if (!productId || !mall || !title || !currentPrice || !previousPrice || !dropAmount || !dropPct) return null;
  if (previousPrice <= currentPrice) return null;
  if (Math.abs(previousPrice - currentPrice - dropAmount) > 1) return null;
  return {
    id: str(value.id) || `${productId}|${mall}|${str(value.vendorItemId)}`,
    productId,
    mall,
    vendorItemId: str(value.vendorItemId).trim(),
    title,
    image: safeUrl(value.image),
    mallLabel: decodeHtmlEntities(str(value.mallLabel).trim()) || mall,
    link: safeUrl(value.link),
    currentPrice,
    previousPrice,
    dropAmount,
    dropPct,
    verified: value.verified === true,
    recordedAt: str(value.recordedAt),
    previousAt: str(value.previousAt),
  };
}

export function parseTodayDrops(value: unknown): TodayDrop[] {
  const items = isObj(value) && Array.isArray(value.items) ? value.items : [];
  return items.map(parseTodayDrop).filter((d): d is TodayDrop => !!d);
}

/** Ascending daily points; unreadable or non-positive points are dropped, duplicates keep the lowest (server rule). */
export function parsePoints(value: unknown): PricePoint[] {
  if (!Array.isArray(value)) return [];
  const byDate = new Map<string, number>();
  for (const p of value) {
    if (!isObj(p)) continue;
    const date = str(p.date);
    const price = positive(p.price);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !price) continue;
    const cur = byDate.get(date);
    if (cur === undefined || price < cur) byDate.set(date, price);
  }
  return [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, price]) => ({ date, price }));
}

function parseStats(value: unknown): DealStats | null {
  if (!isObj(value)) return null;
  return {
    low: positive(value.low),
    high: positive(value.high),
    avg7: positive(value.avg7),
    avg30: positive(value.avg30),
    historyDays: positive(value.historyDays),
    count: positive(value.count),
  };
}

export function parseDeal(value: unknown): Deal | null {
  if (!isObj(value) || typeof value.verdict !== 'string' || typeof value.label !== 'string') return null;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : []);
  return {
    verdict: value.verdict,
    label: value.label,
    reasons: strings(value.reasons),
    cautions: strings(value.cautions),
    stats: parseStats(value.stats),
  };
}

export function parseAiAnswer(value: unknown): AiAnswer | null {
  if (!isObj(value) || typeof value.text !== 'string') return null;
  const change = isObj(value.recommendationChange) && value.recommendationChange.changed === true
    ? str(value.recommendationChange.cause)
    : null;
  return {
    text: value.text,
    items: parseProducts(value.items),
    // Plain strings, as the web renders them (public/index.html Chat.renderFollowups).
    followups: Array.isArray(value.followups)
      ? value.followups.map(f => str(f).slice(0, 60)).filter(Boolean).slice(0, 4)
      : [],
    guest: value.guest === true,
    topProductId: str(value.topProductId),
    topRecommendationRef: str(value.topRecommendationRef),
    turnSig: str(value.turnSig),
    recommendationChanged: change,
  };
}
