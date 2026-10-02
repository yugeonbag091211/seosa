import { isEmail } from './format.ts';

/*
 * Outward links shown on the 마이 screen. Pure, so tests can pin them.
 *
 *   privacy / terms — standalone pages served by the web (vercel.json rewrites /privacy and /terms,
 *                     added in the policy-pages PR). They open in the system browser.
 *   support         — not decided yet. It comes only from EXPO_PUBLIC_SUPPORT_EMAIL at build time;
 *                     without it the screen shows "준비 중" and STORE_READINESS.md keeps it BLOCKED.
 *                     No address is written into the code.
 */
export type Links = { site: string; privacy: string; terms: string; support: string };

export const SITE = 'https://seosa.ai.kr';

export function buildLinks(env: { supportEmail?: string } = {}): Links {
  const email = String(env.supportEmail || '').trim();
  return {
    site: SITE,
    privacy: `${SITE}/privacy`,
    terms: `${SITE}/terms`,
    support: isEmail(email) ? `mailto:${email}` : '',
  };
}
