import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { secure } from './storage';
import { createSessionStore } from './sessionStore';
import { isSessionUsable } from './sessionModel';
import type { Session } from './types';

type Status = 'loading' | 'signedOut' | 'signedIn';

type SessionValue = {
  status: Status;
  session: Session | null;
  /** The token for an API call, or undefined when signed out / expired (guest AI then). */
  token: () => string | undefined;
  signIn: (s: Session) => Promise<void>;
  /**
   * User-initiated, after the server answered 401, or after account deletion: forget the
   * token on this device. Resolves false if secure storage still holds it afterwards.
   */
  signOut: () => Promise<boolean>;
};

const Ctx = createContext<SessionValue | null>(null);
const store = createSessionStore(secure);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<Status>('loading');

  useEffect(() => {
    let alive = true;
    store.load().then(s => {
      if (!alive) return;
      setSession(s);
      setStatus(s ? 'signedIn' : 'signedOut');
    });
    return () => { alive = false; };
  }, []);

  const signIn = useCallback(async (s: Session) => {
    await store.save(s);
    setSession(s);
    setStatus('signedIn');
  }, []);

  const signOut = useCallback(async () => {
    const removed = await store.clear();
    setSession(null);
    setStatus('signedOut');
    return removed;
  }, []);

  const token = useCallback(() => (isSessionUsable(session) ? session.token : undefined), [session]);

  const value = useMemo(() => ({ status, session, token, signIn, signOut }), [status, session, token, signIn, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
