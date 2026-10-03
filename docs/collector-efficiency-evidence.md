# Collector efficiency evidence

Evidence date: 2026-10-03 KST. Baseline `main` = `dea0f069cb5cd643b930e708a09a05310fdfbc90`.
Replay period: seven complete KST days, **2026-09-26 through 2026-10-02**.

## Method and limits

Production access was **read-only**: SELECT through PostgREST/read-only transactions on the
provider call logs (`coupang_api_calls`, `adpick_api_calls`), `price_job_state`, `products` and
catalog metadata. No shopping-API request, collector dispatch, lock change, migration or data
write was made. (One mistaken RPC call during the session hit a function that does not exist in
production — HTTP 404, no effect; the new RPCs were confirmed absent from the PostgREST schema.)

Saved fixtures contain aggregates only (no query text, affiliate links, credentials or customer
data): `reports/collector-efficiency-baseline.json` (aggregate evidence),
`reports/collector-efficiency-final-replay.json` (final-code replay).

Not recoverable from history: response bodies and per-request matched products. Therefore the
**request savings are measured, but product gains and collection-rate gains are not**: saving a
request does not prove an extra product would be found. `price_job_state` is a mutable snapshot,
so the attempt counts of 09-27 (resume provenance reset) are not trustworthy as daily totals.

## Request replay with the final code

`scripts/replay-collector-ledger.js` reads every logged collector call and applies the final
policy call by call with the shipped `queryIdentity` and failure taxonomy: success reused for the
rest of the KST day; a retryable failure gets one more request ≥ 2 minutes later (max 2 per
query/day); AUTH/INVALID terminal; an unfinished (`pending`) request never repeated.
`success_at_risk` counts suppressed calls whose real answer was a success after an earlier
failure (calls the policy would have lost).

### Seven days (historical) — collector calls (`source=collect`)

| | Before | After (final policy) | Change |
| --- | ---: | ---: | ---: |
| Search requests | 34,639 | 33,592 | −1,047 (−3.02%) |
| Unique provider/identity/day | 33,583 | 33,583 | 0 |
| Duplicate requests | 1,056 | 9 | −1,047 (−99.15%) |
| Duplicate ratio | 3.0486% | 0.0268% | −3.02 points |
| `success_at_risk` | — | 0 | no real success suppressed |

Coupang 20,521 → 19,791 (−730); ADPICK 14,118 → 13,801 (−317). The 9 remaining duplicates are
bounded retries after real failures. Including the Vercel cron (`collect,cron`, the full ledger
scope): 34,707 → 33,634 (−1,073), duplicates 1,082 → 9.

The independent aggregate-histogram replay (`scripts/replay-collector-efficiency.js`) gives the
same totals (1,047 saved; 33,583 unique), so the two methods agree.

Canonicalization effect: 19 identity merges over seven days (Coupang query strings differing only
in case/spacing/width), 10 of them in the last three days. ADPICK had none.

### Last three days (current state) — 2026-09-30 … 10-02

| | Before | After | Change |
| --- | ---: | ---: | ---: |
| Search requests | 16,540 | 16,530 | −10 (−0.06%) |
| Duplicate requests | 12 | 2 | −10 |
| Duplicate ratio | 0.0726% | 0.0121% | |

Most historical duplicates (09-27 Coupang 372, 09-29 Coupang 283 / ADPICK 239) happened before
the 09-29 checkpoint/day-cache fixes. **In the current code path duplicates are already ≈0.07% of
requests; this change removes about 3 requests per day there.** The historical seven-day figure
must not be presented as the current improvement.

## API budget (collector calls per KST day)

| Day | Coupang (cap 3,400) | ADPICK (workflow cap 3,000) |
| --- | ---: | ---: |
| 09-26 | 3,400 | 1,102 |
| 09-27 | 3,400 | 1,876 |
| 09-28 | 202 (old 10/hour gate) | 1,800 |
| 09-29 | 3,319 | 3,000 |
| 09-30 | 3,400 | 2,228 |
| 10-01 | 3,400 | 2,240 |
| 10-02 | 3,400 | 1,872 |

Coupang spends its whole daily budget; it attempts ~99% of its targets, the rest of the budget
goes to recovery passes (today's run: ladder r1 49 calls → 5 products, hint 7 → 0, facet 5 → 0).
ADPICK is limited by run time at 5 requests/minute, not by the daily cap: its unattempted targets
are `stopCause=time`.

## Product outcomes (actual collector reports, all daily targets in the denominator)

| KST date | Targets | Today's price (all sources) | Raw success | Attempted | Attempt coverage | Collector success / attempted |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 09-29 | 12,716 | 7,213 | 56.72% | 12,229 | 96.17% | 7,158 / 12,229 = 58.53% |
| 09-30 | 13,034 | 7,114 | 54.58% | 12,499 | 95.90% | 7,099 / 12,499 = 56.80% |
| 10-01 | 13,231 | 6,952 | 52.54% | 12,516 | 94.60% | 6,719 / 12,516 = 53.68% |
| 10-02 | 13,116 | 6,194 | 47.22% | 11,355 | 86.57% | 6,152 / 11,355 = 54.18% |
| 10-03 (in progress, 10:49) | 13,175 | 5,954 | 45.19% | 11,377 | 86.35% | 5,946 / 11,377 = 52.26% |

(09-26…09-28 are in `reports/collector-efficiency-baseline.json`; 09-27/09-28 were disturbed by a
resume reset and the old hourly Coupang gate.)

### Where 10-02 lost products (13,116 targets)

| Bucket | Coupang | ADPICK | Total | Share of targets |
| --- | ---: | ---: | ---: | ---: |
| Collected (collector) | 2,276 | 3,876 | 6,152 | 46.9% |
| **Searched, target not in the answer (NO_MATCH)** | 2,237 | 2,354 | **4,591** | **35.0%** |
| Not attempted (ADPICK run time) | 30 | 1,731 | 1,761 | 13.4% |
| Product found, tracked option absent (OPTION_MISMATCH) | 612 | 0 | 612 | 4.7% |
| Transport/API errors (all seven days, requests) | 11 | 4 | 15 requests | ~0% |
| Empty answers (NO_RESULT, seven days, requests) | 0 | 72 | 72 requests | small |

The last three complete days together: 39,381 targets, collector success 19,970 (50.7%),
attempted 36,370 (92.4%), not found 14,630 (37.1%), option mismatch 1,770 (4.5%), not attempted
3,011 (7.6%).

### Is NO_MATCH a response-size problem? (10-03 state, read-only)

Coupang returns ≤ 10 items per search, ADPICK ≤ 20. Grouping today's attempted targets by their
search keyword:

| | Groups ≤ limit: collected / not found / option | Groups > limit: collected / not found / option |
| --- | --- | --- |
| Coupang (2,584 groups, 36 over 10) | 1,988 / 1,985 / 539 | 295 / 370 / 88 |
| ADPICK (1,618 groups, 7 over 20) | 3,659 / 2,332 / 0 | 77 / 166 / 0 |

84% of Coupang and 93% of ADPICK not-found targets are in groups that fit in one answer. The
loss is **search recall** — the target does not rank for its own keyword (query quality, ranking,
or a delisted/re-listed product ID) — not the per-response cap, transport errors, or duplicates.

## What the saved requests can buy

Measured yields today: ADPICK first pass 338 products / 245 requests (1.38 per request); Coupang
recovery ladder 5 / 49 (0.10 per request).

- Historical seven days: 1,047 requests saved (730 Coupang, 317 ADPICK). If re-spent at those
  yields: ≈ 73 Coupang + ≈ 437 ADPICK additional product *attempt slots* as an upper bound —
  most of them on 09-27/09-29, before the 09-29 fixes.
- Current state: 10 requests in three days (Coupang 10, ADPICK 0) → about 1 product, ≈ 0.01
  percentage points.

These are attempt capacities, not collected prices; an additional attempt succeeds at the attempt
success rate at best (~54%).

## 85–90% judgment

- **This change alone:** no measurable movement toward 90%. It closes the remaining duplicate and
  race paths (≈3 requests/day today), makes retries bounded and typed, and gives a persistent,
  cross-process daily progress and honest metrics. It does not find products that searches do
  not return.
- **What it would take:** on 10-02, 90% means 11,805 of 13,116 — a gap of 5,611 products. Even
  attempting every target at the current attempt success (~54%) reaches ~54%. The levers are
  (1) search recall for NO_MATCH targets (4,591; e.g. queries from the product's own exact
  title/model, detection of delisted IDs reported separately — never removed from the
  denominator), (2) ADPICK coverage within its 5/minute limit (1,761), (3) Coupang option
  recovery (612). Accuracy gates (exact product ID + `vendorItemId`) must stay as they are.
- **Largest bottleneck: NO_MATCH (search recall), ~35% of all daily targets.**

## Reproduce

```powershell
node scripts/replay-collector-efficiency.js            # aggregate replay (offline)
node scripts/test-collector-efficiency-replay.js       # 12 replay tests (offline)
node scripts/replay-collector-ledger.js 2026-09-26 2026-10-02 --sources collect   # SELECT-only, needs DB env
```
