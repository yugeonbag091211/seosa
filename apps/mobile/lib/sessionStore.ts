import { isSessionUsable, restoreSession } from './sessionModel.ts';
import type { Session } from './types.ts';

/*
 * Where the login token lives between launches. Pure over a key-value store so tests can
 * stand in for SecureStore and prove: restart restores the session, logout and account
 * deletion leave nothing behind, an expired or unreadable token is dropped on load.
 */
export type SecureLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
};

export const SESSION_KEY = 'seosa.session.v1';

export function createSessionStore(store: SecureLike, key: string = SESSION_KEY) {
  const read = () => store.get(key).catch(() => null);

  /** Removes the token and checks it is really gone; falls back to overwriting it with ''. */
  async function clear(): Promise<boolean> {
    try { await store.remove(key); } catch { /* checked below */ }
    if (!(await read())) return true;
    try { await store.set(key, ''); } catch { /* reported below */ }
    return !(await read());
  }

  return {
    async load(now: number = Date.now()): Promise<Session | null> {
      const raw = await read();
      const s = restoreSession(raw, now);
      if (raw && !s) await clear();
      return s;
    },
    async save(s: Session): Promise<void> {
      if (!isSessionUsable(s)) throw new Error('invalid session');
      await store.set(key, JSON.stringify(s));
    },
    clear,
  };
}
