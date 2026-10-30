'use strict';

/*
 * "No matching products were returned" differs from "no supplier could be
 * checked". A supplier may return a genuine HTTP-200 empty result while the
 * legacy combined 'from' field says 'none' because the other supplier failed.
 * Never present stale-cache items as current-price evidence.
 */
function selectFreshEvidence(search = {}) {
  const list = Array.isArray(search.items) ? search.items : [];
  const current = source => source === 'api' || source === 'cache';
  const freshItems = list.filter(it => current((it && it._source) || search.from));
  if (freshItems.length) return { ok: true, items: freshItems, reason: 'fresh-items' };

  // The optional flag is populated by _shop.searchAll and represents either
  // provider returning a verified fresh response, even if the other failed.
  // Older test stubs without the flag retain the existing 'from' behavior.
  if (search.freshAnswered === true || (search.freshAnswered == null && current(search.from))) {
    return { ok: true, items: [], reason: 'no-matching-current-items' };
  }
  if (list.length || search.from === 'stale-cache') {
    return { ok: false, items: [], reason: 'stale-or-unverified-source' };
  }
  return { ok: false, items: [], reason: search.blocked ? 'blocked' : 'search-unavailable' };
}

module.exports = { selectFreshEvidence };
