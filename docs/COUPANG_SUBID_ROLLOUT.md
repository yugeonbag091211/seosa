# Coupang Partners SEOSA2026 channel attribution — safe diagnostic

## Goal
Prove that the *Search API* accepts Coupang Partners channel/subId `SEOSA2026` and generates affiliate URLs that can be attributed to the SEOSA channel **before** touching Production links.

## Why this is not a switch to flip
- Coupang's Partners guide calls Channel ID `SUBID` and shows channel-specific reporting.
- `api/_coupang.js` previously sent `keyword` + `limit` only.
- The existing `coupang_search_cache` is keyed by **keyword**, not (keyword, channel).
- The `products` catalogue, older hot deals, homepage/book promotional links, and browser-saved links may already hold URLs generated before the channel existed.
- Changing the query alone cannot retroactively reattribute historic clicks or old stored URLs.

## What this branch does
1. `buildSearchRequest(keyword, limit, host, subId)` optionally includes `subId` in both the exact request URL and HMAC signed query.
2. `searchCoupang(keyword, {source:'diag',useCache:false,subId:'SEOSA2026'})` permits **isolated diagnostics only**. Ordinary search/collection cannot pass `subId`; requesting it on cached calls is rejected.
3. Offline mock-server regression checks opt-in channel, signature match, rejection of ordinary/cached injection, and unchanged legacy requests.

**No environment variables, cron schedules, data migrations, existing persisted links, or Production release behavior are modified.**

## Evidence needed for a full rollout
- [ ] Confirm API accepts one isolated `subId=SEOSA2026` query without `rCode=400`, account limit, or block. Do not repeat probes unnecessarily.
- [ ] Compare partner-generated `SEOSA2026` short URL and API-generated URL; verify merchant/option match and `lptag` ownership. Do not infer attribution solely from a displayed URL.
- [ ] Confirm at least one genuine click appears under the `SEOSA2026` channel in Coupang Partners' own channel report (the report may be delayed).
- [ ] Design a channel-separated cache key/storage schema. Do not reuse keyword-only cached affiliate URLs when channel is enabled.
- [ ] Inventory and migrate/refresh stored `products.link` and all hard-coded homepage, book, hot deal, and cached client URLs safely; do not modify `lptag` or append guessed URL parameters to old affiliate URLs.
- [ ] Validate all affected buy paths (search, /p/, hot deals, home, historic products) and keep option `vendorItemId` invariant.
- [ ] Audit consent/disclosure and confirm Coupang partner program approval.
- [ ] Roll out gradually with a rollback plan; compare SEOSA2026 channel-specific reports against site's *outbound* click metrics, never equate clicks to sales.

## Run offline check
```sh
node scripts/test-coupang.js
node scripts/test-affiliate-integrity.js
```

No paid API requests are made by these tests. **This PR must stay Draft and must not be merged on offline testing alone.**
