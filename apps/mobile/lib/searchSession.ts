// Type-only import keeps this module loadable by the node test runner (no extensionless runtime import).
import type { ApiError, Product } from './api';

function isAbort(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as Partial<ApiError>).kind === 'aborted';
}

/** After this long, the screen says the search is taking a while (cache-miss searches measured 3.7–9.4s). */
export const SLOW_NOTICE_MS = 8_000;

export type SearchOutcome =
  | { status: 'success'; keyword: string; items: Product[] }
  | { status: 'error'; keyword: string; error: unknown }
  /** Nothing to show: empty keyword, duplicate of the running search, cancelled, or replaced by a newer search. */
  | { status: 'ignored' };

export type Timers = {
  set: (callback: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const defaultTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type Running = { keyword: string; controller: AbortController; slowTimer: unknown };

/**
 * One search at a time, owned by the search screen.
 *
 * - The same keyword while it is running is ignored: a search can trigger provider calls and
 *   server writes, so a second identical request buys nothing.
 * - A different keyword replaces the running one (the old response is dropped, never shown).
 * - Nothing is retried automatically.
 * - `cancel()` aborts the running request; call it when the screen unmounts.
 */
export function createSearchSession(options: {
  search: (keyword: string, signal: AbortSignal) => Promise<Product[]>;
  onSlow?: (keyword: string) => void;
  slowMs?: number;
  timers?: Timers;
}) {
  const timers = options.timers || defaultTimers;
  const slowMs = options.slowMs ?? SLOW_NOTICE_MS;
  let current: Running | null = null;

  function stop(entry: Running) {
    timers.clear(entry.slowTimer);
    entry.controller.abort();
  }

  function cancel() {
    if (!current) return;
    const entry = current;
    current = null;
    stop(entry);
  }

  async function run(rawKeyword: string): Promise<SearchOutcome> {
    const keyword = String(rawKeyword || '').trim();
    if (!keyword) return { status: 'ignored' };
    if (current && current.keyword === keyword) return { status: 'ignored' };
    if (current) cancel();

    const entry: Running = { keyword, controller: new AbortController(), slowTimer: null };
    entry.slowTimer = timers.set(() => { if (current === entry) options.onSlow?.(keyword); }, slowMs);
    current = entry;
    try {
      const items = await options.search(keyword, entry.controller.signal);
      if (current !== entry) return { status: 'ignored' };
      return { status: 'success', keyword, items };
    } catch (error) {
      if (current !== entry) return { status: 'ignored' };
      if (isAbort(error)) return { status: 'ignored' };
      return { status: 'error', keyword, error };
    } finally {
      if (current === entry) {
        timers.clear(entry.slowTimer);
        current = null;
      }
    }
  }

  return {
    run,
    cancel,
    get runningKeyword(): string | null { return current ? current.keyword : null; },
  };
}
