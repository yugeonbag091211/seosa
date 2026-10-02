/*
 * Search autocomplete, the web's Auto module (public/index.html [25]).
 *
 * There is no server autocomplete endpoint. Like the web, candidates come only from what
 * SEOSA actually has: popular keywords (search_stats via /api/init) and this device's recent
 * searches. Nothing is generated, and product titles are not chopped into suggestions.
 */

/** Same normalization as the web Auto.key and api/_search.js: NFKC, lowercase, letters/digits/Hangul only. */
export function suggestKey(value: string): string {
  let t = String(value ?? '');
  if (t.normalize) t = t.normalize('NFKC');
  return t.toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
}

export type Suggestion = { keyword: string; kind: 'recent' | 'popular' };

export function suggestions(input: string, recent: readonly string[], popular: readonly string[], limit = 6): Suggestion[] {
  const key = suggestKey(input);
  if (!key) return [];
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  const add = (keyword: string, kind: Suggestion['kind']) => {
    const k = suggestKey(keyword);
    if (!k || seen.has(k) || k === key || !k.includes(key)) return;
    seen.add(k);
    out.push({ keyword, kind });
  };
  recent.forEach(k => add(k, 'recent'));
  popular.forEach(k => add(k, 'popular'));
  // Prefix matches first, keeping source order otherwise.
  return out
    .map((s, i) => ({ s, i, prefix: suggestKey(s.keyword).startsWith(key) ? 0 : 1 }))
    .sort((a, b) => a.prefix - b.prefix || a.i - b.i)
    .slice(0, limit)
    .map(x => x.s);
}

/** Recent searches: newest first, case/space-insensitive dedupe, capped. */
export function pushRecent(list: readonly string[], keyword: string, max = 10): string[] {
  const k = keyword.trim().slice(0, 80);
  if (!k) return [...list];
  const key = suggestKey(k);
  return [k, ...list.filter(s => suggestKey(s) !== key)].slice(0, max);
}
