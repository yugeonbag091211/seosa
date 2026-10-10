import { isEmail } from './format.ts';

/*
 * Outward links shown on the 마이 screen. Pure, so tests can pin them.
 *
 *   privacy / terms / support — standalone pages served by the web (vercel.json rewrites /privacy,
 *                     /terms and /support). They open in the system browser. /support is also the
 *                     App Store «Support URL»: it always opens, even on a device without a mail app,
 *                     and carries the address, the inquiry types and the off-app deletion guide.
 *   supportEmail    — support@seosa.ai.kr (ImprovMX → operator inbox), the address the web policy
 *                     pages publish. It is the default because EAS builds do not see a gitignored .env:
 *                     a store build without EXPO_PUBLIC_SUPPORT_EMAIL must still show the real address.
 *                     A valid EXPO_PUBLIC_SUPPORT_EMAIL overrides it; anything else is ignored.
 */
export type Links = { site: string; privacy: string; terms: string; support: string; supportEmail: string; supportMailto: string };

export const SITE = 'https://seosa.ai.kr';
export const SUPPORT_EMAIL = 'support@seosa.ai.kr';

export function buildLinks(env: { supportEmail?: string } = {}): Links {
  const configured = String(env.supportEmail || '').trim();
  const email = isEmail(configured) ? configured : SUPPORT_EMAIL;
  return {
    site: SITE,
    privacy: `${SITE}/privacy`,
    terms: `${SITE}/terms`,
    support: `${SITE}/support`,
    supportEmail: email,
    supportMailto: `mailto:${email}`,
  };
}
