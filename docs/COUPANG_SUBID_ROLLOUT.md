# Coupang Partners SEOSA2026: verified API, staged channel rollout

## Status (2026-11-19 KST)

**DRAFT ONLY. No Production code, environment variables, database data or existing affiliate links have been changed.**

- Coupang Partners channel ID `SEOSA2026` was created in the partner UI.
- A single real Coupang Search API request with `subId=SEOSA2026` returned **HTTP 200** and a provider-generated `link.coupang.com/re/AFFSDP` affiliate URL containing an explicit `subId` query parameter. `classifyCoupang().ok=true`.
- One returned sample product ID: `9369201576`. The request consumed **one** provider call through the existing search gate. No product/cache/conversion rows were written.
- Production inventory on this date (read-only Neon): **26,137 Coupang products**, **zero** with an explicit SUBID in the saved link; **3,300 legacy Coupang keyword cache rows**.
- This proves Search API parameter acceptance and tagged-link generation, **not** channel-attributed clicks, orders or commissions. Never assume the earlier default-channel purchases came from SEOSA.
- Partner account approval status and reports showing a real SEOSA2026 click are **not yet verified**.

## Why channel cache must be separate

`coupang_search_cache.keyword` is a legacy plain-keyword primary key and is also used by price-collector hint queries, including the `search_cache_hints` RPC. Prefixing the keyword with a SUBID would contaminate collector search terms.

This PR proposes a new `coupang_channel_search_cache` table keyed by `(sub_id, keyword)`, with the same JSONB items and freshness fields. Migration source: `supabase/2026-11-19-coupang-channel-cache.sql`. **File committed; SQL not executed.** No changes to the legacy cache. If the new cache is unavailable, tagged search fails closed rather than reading an untagged cached link or repeatedly hammering the provider.

The collector's hint lookup only consults the channel table when full-channel mode is active; in search-only canary mode the collector continues to use the legacy cache and existing provider budget.

## Feature-switch contract (all OFF by default)

### Stage 0 — existing legacy behavior

With `COUPANG_CHANNEL_ROLLOUT` unset or different from `1`:
- Search/collector/cron/AI use legacy requests and legacy cache.
- Persisted catalogue, home promotions, product pages and histories remain unchanged.
- No new database table is queried or modified.

### Stage 1 — approved search-only canary

**Prerequisites:** migration applied after backup; Preview smoke tests; GitHub CI; account/channel readiness confirmed. Set these four environment variables **only in the intended Vercel environment**, not globally:

```
COUPANG_CHANNEL_ROLLOUT=1
COUPANG_CHANNEL_MODE=canary
COUPANG_CHANNEL_SUBID=SEOSA2026
COUPANG_CHANNEL_CANARY_PERCENT=5
```

This selects **5% of distinct search keyword hash buckets**, *not 5% of users or page views*. The same keyword is consistently either inside or outside the cohort. Allowed values for the percentage are integers 1–100. API requests carry the provider-supported `subId`; response URLs must have both the correct partner `lptag` and matching SUBID. They are never invented by manipulating old links.

In canary mode:
- Only `source='search'` in the selected keyword buckets receives channel-tagged URLs.
- Search responses may send those URLs to real users, enabling a genuine channel report to be inspected later.
- `_shop.saveProducts` and direct `recordPrices({source:'search'})` explicitly exclude tagged canary observations. **No tagged URL is saved to existing `products` or `price_history`.**
- Cron, AI and GitHub Actions collectors still use legacy links and legacy cache. Existing ~26K saved Coupang products remain untouched.
- Channel queries use the separate `coupang_channel_search_cache` with no fallback to legacy URLs.
- The existing global Coupang rate limiter and circuit breaker continue to apply.
- If reports are delayed, do not claim attribution before they appear.

**Rollback:** remove `COUPANG_CHANNEL_ROLLOUT` or set it to `0` for that Vercel environment and redeploy. User searches return to legacy caching without reverting catalogue rows (none were modified by the canary). Existing already-shared channel-tagged URLs remain valid; previously recorded clicks are not undone.

### Stage 2 — full channel rollout (NOT approved)

Do not enable until all of the following are demonstrated:
- [ ] Genuine `SEOSA2026` channel click reported in Coupang Partners with a verified source and time window; later attributed orders/commissions verified from the partner, not inferred from site click events.
- [ ] Migration applied, permissions checked and new cache can read/write in target environment.
- [ ] All writer environments audited: Vercel Production search and cron, GitHub Actions price collectors, volatile collector, manual scripts and any long-running processes.
- [ ] Existing `products.link` and `price_history.link` overwrite/coexistence policy reviewed. Concurrent legacy writers may overwrite tagged product links. Merely switching one environment is **not safe**.
- [ ] Every purchase route validated: home / hero, books, search, /p/ product pages, hot deals, saved items, SEO pages, historic cards; option `vendorItemId`, itemId, and partner `lptag` must remain correct.
- [ ] Affiliate disclosures and final account approval confirmed.
- [ ] Coordinated rollout and rollback window agreed, with channel-specific click report comparisons after activation.

Only after completing the gates may the responsible operator set the matching values in **all** writers:

```
COUPANG_CHANNEL_ROLLOUT=1
COUPANG_CHANNEL_MODE=full
COUPANG_CHANNEL_SUBID=SEOSA2026
COUPANG_CHANNEL_ALL_WRITERS_ACK=1
```

`COUPANG_CHANNEL_ALL_WRITERS_ACK` prevents an accidental single-env full switch without explicit acknowledgement, but does not technically verify that all remote writers have been configured. Full-mode rollback must consider already-updated catalogue rows; it is **not** an instant restoration of the 26,137 legacy URLs.

## Verification

Offline, no provider quota and no production database writes:

```sh
node scripts/test-coupang.js
node scripts/test-coupang-channel-cache.js
node scripts/test-coupang-canary-save.js
node scripts/test-collector-hint-options.js
node scripts/test-affiliate-integrity.js
```

The canary/cache checks run in the repository's `npm test` chain. Full `npm test` currently has unrelated failing policy-page assertions and disabled cron-schedule expectations on main; do not claim the whole suite is green until those are independently resolved.

### One-time live API diagnostic — already completed 2026-11-19

Executed once in an isolated Git worktree on the authorized Windows PC with locally configured credentials:

```sh
node scripts/diag-coupang-subid-once.js --live-once
```

Result: `from='api'`, `error=null`, `blocked=false`, `apiCalled=true`, tagged provider URL generated, exit code `0`. No reason to repeat the upstream probe merely to re-prove this fact. Never paste live API credentials into chat, code review or job logs.

## Costs and cautions

- No paid AI call, new hosting plan or mandatory third-party subscription is introduced.
- A new channel cache table adds storage/queries and canary misses may generate some **additional provider API calls** within existing hard limits. This has not been cost-quantified.
- The PR is Draft and not approved for Production merge or environment activation at this stage.
