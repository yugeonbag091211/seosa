import type { Session } from './types.ts';

/*
 * Login session. SEOSA does not use Supabase Auth: /api/auth mails a 6-digit code and returns
 * an HMAC-signed token (api/_auth.js, 30 days). The server is the only judge of validity;
 * the app keeps the token in the OS keychain/keystore (expo-secure-store) and drops it
 * when it has expired or when the server answers 401.
 */

/** Tokens are opaque to the app. Only the shape is checked — never decoded or trusted for identity. */
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{16,2048}$/;

export function isSessionUsable(s: Session | null | undefined, now: number = Date.now()): s is Session {
  if (!s || typeof s.token !== 'string' || !TOKEN_RE.test(s.token)) return false;
  if (typeof s.email !== 'string' || !s.email) return false;
  if (s.expiresAt) {
    const t = Date.parse(s.expiresAt);
    if (Number.isFinite(t) && t <= now) return false;
  }
  return true;
}

export function restoreSession(raw: string | null, now: number = Date.now()): Session | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Session;
    const s = { token: String(v.token || ''), email: String(v.email || ''), expiresAt: String(v.expiresAt || '') };
    return isSessionUsable(s, now) ? s : null;
  } catch {
    return null;
  }
}

/** "ab***@gmail.com" for display. */
export function maskEmail(email: string): string {
  const [user, domain] = String(email || '').split('@');
  if (!domain) return '';
  return `${user.slice(0, 2)}${'*'.repeat(Math.max(1, Math.min(4, user.length - 2)))}@${domain}`;
}
