import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { KEYS, secure } from './storage';
import { isSessionUsable, restoreSession } from './sessionModel';
import type { Session } from './types';

type Status = 'loading' | 'signedOut' | 'signedIn';

type SessionValue = {
  status: Status;
  session: Session | null;
  /** The token for an API call, or undefined when signed out / expired (guest AI then). */
  token: () => string | undefined;
  signIn: (s: Session) => Promise<void>;
  /** User-initiated, or after the server answered 401: forget the token on this device. */
  signOut: () => Promise<void>;
};

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<Status>('loading');

  useEffect(() => {
    let alive = true;
    secure.get(KEYS.session).then(raw => {
      if (!alive) return;
      const s = restoreSession(raw);
      if (raw && !s) secure.remove(KEYS.session);   // expired or unreadable: do not keep it around
      setSession(s);
      setStatus(s ? 'signedIn' : 'signedOut');
    });
    return () => { alive = false; };
  }, []);

  const signIn = useCallback(async (s: Session) => {
    if (!isSessionUsable(s)) throw new Error('invalid session');
    await secure.set(KEYS.session, JSON.stringify(s));
    setSession(s);
    setStatus('signedIn');
  }, []);

  const signOut = useCallback(async () => {
    await secure.remove(KEYS.session);
    setSession(null);
    setStatus('signedOut');
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
