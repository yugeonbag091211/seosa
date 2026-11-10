# SEOSA AI v3.3 — live-first product retrieval experiment

Date: 2026-11-10 (Asia/Seoul)

## Objective
The user requested that an AI shopping recommendation search seller APIs **when the user asks**, rather than search the Neon products table first. This is an **isolated, opt-in feature** on `feat/ai-v33-live-first-20261110`. It must not be merged into Production without a safe provider-side live run, quota/cost verification and an independent holdout.

## Activation and safety
- Default (including Production): `AI_V3_SEARCH_STRATEGY` absent or any value besides `live-first` → legacy DB-first.
- Explicit opt-in: `AI_V3_SEARCH_STRATEGY=live-first` and `ENABLE_AI_V3=1`.
- **Critical**: With `SEOSA_DB_READONLY=1`, external merchant API calls are intentionally skipped because quota leases may require DB writes/RPC. The environment remains a safe **DB-only Preview**, even if live-first is selected.
- Do **not** disable `SEOSA_DB_READONLY` on a Preview sharing Production data merely to demonstrate live search. Real provider validation requires an independently isolated, safely writable quota-lease store and proper authorized provider credentials; never disclose or copy secrets into logs.
- Each user search group issues **at most one `searchAll()` call**, which already enforces the existing Coupang/ADPICK shared provider limiters/cache. Two-sided comparisons can have up to two search groups.
- Non-shopping questions never invoke the merchant search tool. No background search or change to existing scheduled harvest cadence.
- The provider request includes brand/model clues extracted from the **actual user's text**, not GPT-invented properties. Query is size-bounded.

## Retrieval behavior
1. Ask official merchant APIs through existing `api/_shop.js::searchAll`; accept only product cards whose per-item `_source` is `api` or nonexpired `cache`. Stale-cache products cannot be represented as freshly retrieved.
2. Pre-validate merchandise type, user-grounded brand/model, identity, wireless evidence where required, eligible price and known shipping fee; reject unpriced, refurbished (unless requested), malformed links and nonmatching listings.
3. If four distinct verified offers are available, return without DB queries.
4. If fewer than four are available, query the existing Neon catalog as a **read-only fallback**, retain only verifiable eligible rows, and de-duplicate with merchant API results first. The provider-observed offer takes precedence over the old DB price for an identical SKU.
5. A supplier outage with fallback hits returns eligible fallback offers; both sources unavailable yield an error (not an invented 'no products') where that condition can be confirmed. A partial valid live response survives a DB lookup error.
6. Final `createEngine` candidate checks run unchanged. The buyer is not promised shipping cost, actual checkout inventory or option-specific price when the provider did not verify those facts.

## Current verified evidence
- **Simulated provider and DB contract tests**: see `scripts/test-ai-v33-live-first-20261110.js`.
- **End-to-end engine path with injected fake seller provider**: see `scripts/test-ai-v33-full-engine-20261110.js`.
- Existing v3.2 guardrails, strict pass-only launch KPI and original frozen holdout data remain unchanged.
- No real Coupang/ADPICK provider requests have yet been counted as v3.3 live experiment results. A read-only Vercel Preview GET/POST does not prove live-first supplier functionality.

## Launch comparison requirements
Run a **paired, time-bounded online benchmark** on identical query sets (DB-first vs live-first) with disjoint/new holdout labels. Record per-case API provider source, actual provider calls, shared limiter blocks, response HTTP status, GPT calls, exact billed input/output tokens when available, p50/p95, incorrect card count, and launch PASS_ONLY success rate.

The historical independent fresh50 (25 PASS/6 FAIL/19 UNVERIFIED → strict launch 50%) is a **pre-change benchmark**, not a performance improvement claim. Only PASS counts toward release readiness.

Rollback: remove `AI_V3_SEARCH_STRATEGY=live-first`, without altering Production code or database.
