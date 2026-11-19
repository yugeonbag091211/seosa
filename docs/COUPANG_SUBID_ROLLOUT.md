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

No paid API requests are made by these tests.

## Optional ONE live verification (not performed in this PR)
From a machine with the project's configured `.env.local`, run **once**:
```sh
node scripts/diag-coupang-subid-once.js --live-once
```
This makes at most one API search through the existing quota guard. It does not write catalog/cache/conversion rows. The quota ledger may record the request, as it does for normal searches. Never paste API credentials or the whole `.env.local` into chat. The output alone does not prove revenue attribution: corroborate in Coupang's channel report after genuine visitors click.

**This PR must stay Draft and must not be merged on offline testing alone.**

## Actual live diagnostic — 2026-11-19 KST

Executed **once** on the authorized Windows PC in an isolated Git worktree, using existing local credentials and the production quota guard. Command: `node -r <existing local dotenv preload> scripts/diag-coupang-subid-once.js --live-once`.

Observed output (secrets and the full affiliate link intentionally not copied):

- Search keyword: `에어팟 프로 3`; channel requested: `SEOSA2026`.
- Upstream search: **HTTP 200**, `from=api`, `error=null`, `blocked=false`, `apiCalled=true`.
- Normalized response: **1 item returned** (upstream gave 10 raw rows, collapsed to 8 unique products).
- First product ID: `9369201576`.
- Affiliate URL: host `link.coupang.com`, path `/re/AFFSDP`, `classifyCoupang().ok=true`.
- Returned link contained a case-insensitive `subId` query key. **Partner-side report attribution has NOT been verified.**
- No write to the `products` or `coupang_search_cache` tables. The existing gate records API usage as designed.
- Existing `main`/Production links and existing local development branch were not modified.

**Next gate:** show genuine traffic in `SEOSA2026` channel report before a full rollout. Historical purchases or clicks in the default Coupang channel cannot be assumed to originate from SEOSA.
