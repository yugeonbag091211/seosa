import { safeUrl } from './parse.ts';

/*
 * Outbound purchase links.
 *
 * The server gives each product its final affiliate URL (Coupang Partners productUrl, ADPICK
 * commission link, hot-deal dealUrl). Attribution lives in that URL, so the app:
 *   · opens it byte-for-byte — no re-encoding, no added query, no tracking redirect in between
 *     (the web deliberately avoids a relay for the same reason, public/index.html Shelf click);
 *   · hands it to the OS (Linking.openURL), so the Coupang/partner app or the default browser
 *     receives the same URL the web opens in a new tab;
 *   · refuses anything that is not absolute http(s).
 *
 * The React Native side lives in components/BuyButton.tsx; this file stays pure for tests.
 */

export type PurchaseTarget = { url: string; label: string } | null;

/** The URL to open, exactly as received, or null when the product has no usable link. */
export function purchaseTarget(link: string | undefined | null, mallLabel: string): PurchaseTarget {
  const url = safeUrl(link);
  if (!url) return null;
  return { url, label: mallLabel ? `${mallLabel}에서 보기` : '판매처에서 보기' };
}

/** The disclosure text shown wherever a purchase link is (web .aff-note, PR #113/#114). Keep it identical. */
export const AFFILIATE_NOTE = '이 페이지에는 제휴 링크가 포함되어 있으며, 구매 시 SEOSA가 일정 수수료를 제공받습니다.';
/** The Coupang Partners notice from the web footer. */
export const COUPANG_PARTNERS_NOTE = '본 서비스는 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받을 수 있습니다.';
