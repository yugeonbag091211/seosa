import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { KEYS, kv } from './storage';
import { isSaved as inList, removeSaved, restoreSaved, toggleSaved, type SavedItem } from './savedModel';
import { pushRecent } from './suggest';
import type { Product, ProductIdentity } from './types';

/*
 * On-device data: saved products and recent searches. Loaded once, written on every change.
 * Nothing here is sent to the server (see lib/savedModel.ts for why cloud sync waits).
 */

type LocalValue = {
  ready: boolean;
  saved: SavedItem[];
  isSaved: (id: ProductIdentity) => boolean;
  toggleSaved: (p: Product) => boolean;
  removeSaved: (id: ProductIdentity) => void;
  recent: string[];
  addRecent: (keyword: string) => void;
  clearRecent: () => void;
};

const Ctx = createContext<LocalValue | null>(null);

export function LocalDataProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState<SavedItem[]>([]);
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    Promise.all([kv.get<unknown>(KEYS.saved, []), kv.get<unknown>(KEYS.recentSearches, [])]).then(([s, r]) => {
      if (!alive) return;
      // Merge, don't replace: a search or save made while storage was still loading must survive.
      const stored = Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string' && !!x).slice(0, 10) : [];
      setSaved(prev => restoreSaved([...prev, ...(Array.isArray(s) ? s : [])]));
      setRecent(prev => [...prev].reverse().reduce((acc, k) => pushRecent(acc, k), stored));
      setReady(true);
    });
    return () => { alive = false; };
  }, []);

  // Storage follows state. Writing only after the first load keeps an empty initial state from wiping it.
  useEffect(() => { if (ready) kv.set(KEYS.saved, saved); }, [ready, saved]);
  useEffect(() => { if (ready) kv.set(KEYS.recentSearches, recent); }, [ready, recent]);

  /** Returns whether the product is saved after the toggle. */
  const toggle = useCallback((p: Product) => {
    const willSave = !inList(saved, p);
    setSaved(prev => toggleSaved(prev, p));
    return willSave;
  }, [saved]);

  const remove = useCallback((id: ProductIdentity) => setSaved(prev => removeSaved(prev, id)), []);

  const addRecent = useCallback((keyword: string) => setRecent(prev => pushRecent(prev, keyword)), []);
  const clearRecent = useCallback(() => setRecent([]), []);

  const isSaved = useCallback((id: ProductIdentity) => inList(saved, id), [saved]);

  const value = useMemo(() => ({ ready, saved, isSaved, toggleSaved: toggle, removeSaved: remove, recent, addRecent, clearRecent }),
    [ready, saved, isSaved, toggle, remove, recent, addRecent, clearRecent]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLocalData(): LocalValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useLocalData outside LocalDataProvider');
  return v;
}
