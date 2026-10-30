'use strict';

/*
 * ADPICK local/global quotas MUST still be acquired inside searchAdpick.
 * This computes ONLY an upper bound on how long the AI can wait for an
 * existing quota slot; it never retries or requests an extra provider call.
 * Keep a short reserve for fetching current items and the AI answer stage.
 */
const MAX_GRACE_MS = 3500;
const MAX_HTTP_MS = 10000;
function pacingForSearchCap(searchCapMs) {
  const cap = Number.isFinite(Number(searchCapMs)) ? Math.max(1, Math.floor(Number(searchCapMs))) : 1;
  const reserve = Math.min(2500, Math.floor(cap / 4));
  const timeoutMs = Math.max(1, Math.min(MAX_HTTP_MS, cap - reserve));
  const maxWaitMs = Math.max(0, Math.min(MAX_GRACE_MS, cap - reserve - timeoutMs));
  return { maxWaitMs, timeoutMs };
}
module.exports = { pacingForSearchCap, MAX_GRACE_MS, MAX_HTTP_MS };
