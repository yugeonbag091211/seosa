/*
 * Push notifications — prepared, not enabled.
 *
 * Nothing here asks for permission, registers a device or talks to a server, and
 * expo-notifications is deliberately not installed (it would add POST_NOTIFICATIONS to the
 * Android manifest; app.json even blocks that permission today).
 *
 * What exists server-side now: e-mail price alerts (api/alerts.js, sent by api/cron.js).
 * Turning on push needs, in order:
 *   1. a device-token table + an authenticated register/unregister endpoint (new API — needs approval);
 *   2. the cron sender to fan out to push as well as e-mail, using the same alert rows;
 *   3. here: install expo-notifications, remove POST_NOTIFICATIONS from blockedPermissions,
 *      ask for permission only after the user sets an alert (never on launch).
 *
 * The message kinds below are the ones the product wants; the server will own the text and
 * the numbers — the app only renders what it receives.
 */

export type PriceAlertKind =
  | 'target_reached'   // "저장한 상품 가격이 89,000원으로 떨어졌어요."
  | 'all_time_low'     // "오늘 최저가를 기록했어요."
  | 'big_drop';        // "가격이 10% 이상 하락했어요."

export type PriceAlertPayload = {
  kind: PriceAlertKind;
  productId: string;
  mall: string;
  vendorItemId: string;
  /** Server-written text. */
  title: string;
  body: string;
};

export const PUSH_ENABLED = false as const;

/** Where a tapped notification would lead: the product detail for that exact option. */
export function routeForAlert(p: PriceAlertPayload): string {
  const key = [p.productId, p.mall, p.vendorItemId].filter((v, i) => i < 2 || v).join('|');
  return `/product/${encodeURIComponent(key)}`;
}
