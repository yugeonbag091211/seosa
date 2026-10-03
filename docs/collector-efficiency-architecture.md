# Collector daily efficiency: design and audit

Part 1 describes what this change implements. Part 2 is the read-only audit of the baseline
(`main` at `dea0f06`) that motivated it; its line references describe that baseline.

## Part 1 — Implementation (2026-10-03)

Everything is behind `PRICE_QUERY_LEDGER=1` (GitHub Actions variable for the collector, Vercel
environment for `/api/cron`). With the flag unset the code paths are the pre-change ones. The
schema is additive: `supabase/migrations/20261003003832_collector_daily_efficiency.sql`.

### Components

| Piece | File | Role |
| --- | --- | --- |
| Failure taxonomy | `api/_collector-failure.js` | One vocabulary + retry lists for providers, ledger, progress and SQL |
| Query ledger | `api/_collector-query.js` | Canonical query identity; atomic claim → begin → finish around every collector/cron provider request |
| Daily product progress | `api/_collector-progress.js` | Per target, per provider, per KST day: attempts, success, failure, queries, backoff |
| Provider wrappers | `api/_coupang.js`, `api/_adpick.js` | `runProviderQuery` + typed `failureReason` at each failure site |
| Collector | `scripts/collect-all-prices.js` | Preflight, progress-ordered queue, per-call evaluation records, metrics |
| Cron | `api/cron.js` | Confirmed cron writes become daily success (ledger also gates its searches) |
| Diagnostic probe | `scripts/coupang-probe.js` | Now one call through `searchCoupang` (cache, quota, circuit); the header-variant raw probe that bypassed them was removed |

### Query identity (JS = SQL)

`queryIdentity(keyword) = normalizeQuery(keyword.trim().slice(0, 80))` — the 80-character cap is
what the providers actually send. `normalizeQuery`: NFKC → remove zero-width/format characters
(U+00AD, U+180E, U+200B–U+200D, U+2060–U+2064, U+FEFF) → C0/C1 controls become spaces → any
whitespace run becomes one space → trim → lower case → NFKC.

Merged: `"삼성   갤럭시 버즈3"`, `" 삼성 갤럭시 버즈3 "`, NBSP/U+3000/tab/NEL separators, full-width
digits, NFD Hangul, zero-width spaces, letter case. Not merged: `A+B`/`A B`, `128GB`/`256GB`,
`버즈3`/`버즈 3`, `삼성갤럭시`/`삼성 갤럭시`, `USB-C`/`USB C` — punctuation and spacing between
tokens can change what a shopping search returns, so they stay distinct.

SQL never re-normalizes. `collector_query_claim` rejects an identity that is not canonical
(`IS NFKC NORMALIZED`, no ASCII upper case, no edge/double space, no control character — all
locale-independent) and recomputes `sha256(normalized_query)`; a mismatched hash is rejected.
Tests run 200k random strings through the JS canonical invariants and 400 JS identities through
the real SQL guard (PGlite 17; PostgreSQL 15 in CI).

### Claim lifecycle (provider + KST date + query identity)

```
claim ──► cached        same-day completed answer: reused, no request
      ├─► inflight      another process holds an unexpired claim, or its request began and never
      │                 finished (uncertain): never re-requested today
      ├─► daily_done    2 requests used, or a non-retryable failure (AUTH_ERROR, INVALID_PRODUCT, …)
      ├─► deferred      retryable failure inside its ≥2-minute backoff
      └─► claimed ──► begin (immediately before fetch; fails if lease/token/date/2-request cap
                       is wrong) ──► fetch ──► finish(completed | failed | deferred)
```

- Atomicity: `INSERT … ON CONFLICT DO NOTHING` + `SELECT … FOR UPDATE` in one RPC. A concurrent
  claimer blocks on the unique key / row lock and then sees the committed state. `begin` is a
  conditional `UPDATE` on the owner token, so even a stolen/expired claim cannot start a second
  request. Proven with 16 parallel backends holding open transactions (PostgreSQL service in CI).
- In-process coalescing: two groups in one collector process that resolve to the same identity
  share one in-flight promise; the follower is a cache reuse, not a request.
- Lease 180 s (covers the longest provider slot wait, Coupang 120 s). An expired claim that never
  began is reclaimable; one that began is not (the request may have reached the provider).
- Fail closed: if the ledger RPC errors after a passed preflight, no request is sent.
- Cache payload: only matching fields (`productId`, `vendorItemId`, prices, link …), ≤ 20 items,
  ≤ 160 KB, fetched on the same KST day; invalid/corrupt payloads are never reused and get one
  bounded repair request. Interactive search (`source=search`) is not ledgered.

### Failure taxonomy and retry policy

| Reason | Meaning | Same query again today | Product |
| --- | --- | --- | --- |
| `RATE_LIMIT` | 429, quota/budget, minute limit | once more, ≥ 2 min later (max 2 requests) | deferred; no attempt if no request left |
| `NETWORK_ERROR` | DNS, reset, fetch failed (request left) | once more, ≥ 2 min later | ≤ 3 transient failures/day |
| `TIMEOUT` | abort, HTTP 408/504 | once more, ≥ 2 min later | ≤ 3 transient failures/day |
| `SOURCE_ERROR` | 5xx, unparsable body | once more, ≥ 2 min later | ≤ 3 transient failures/day |
| `UNKNOWN` | unclassified | once more, ≥ 2 min later | ≤ 3 transient failures/day |
| `AUTH_ERROR` | 401/403, missing/invalid key, access-denied page | never | terminal for the day if its own request got it; a circuit opened by another request is not recorded against it |
| `INVALID_PRODUCT` | no search phrase, HTTP 400/rCode 400, no price | never | terminal for the day |
| `NO_RESULT` | provider answered with zero items | never (answer reused) | alternates via the existing bounded ladder |
| `NO_MATCH` | answer had items, none with the target ID | never (answer reused) | alternates via the existing bounded ladder (≤ 16 queries/day backstop) |
| `OPTION_MISMATCH` / `AMBIGUOUS_MATCH` | product present, tracked option absent | never | exactly one alternate query after the first miss |
| `WRITE_REJECTED` | matched, write refused by `recordPrices` integrity guard | — | terminal for the day (a failed history write is not this) |

Lists are defined once in `api/_collector-failure.js`; the SQL repeats them and a test parses the
migration to keep both equal. Providers type failures where the cause is known (HTTP status,
`AbortError`, missing key, HTML denial page); messages are parsed only as a fallback.

### Daily product progress

`collector_product_progress` (source, KST date, product key; Coupang keys include the tracked
`vendorItemId`, so a changed option never inherits another option's success). Columns:
`attempted_at`, `success_at` (monotonic), `failure_reason` (terminal reasons sticky),
`attempt_count`, `transient_failures`, `mismatch_at`, `queries` (evaluated identities),
`last_query`, `last_status`, `next_retry_at`, idempotent `event_ids`.

One event per target per call:
- request failed → `attempted = apiCalled`, `transient_failures++` for retryable reasons, backoff;
- real answer evaluated (fresh or reused) → `attempted`, `evaluated`, reason
  `MATCH`/`NO_RESULT`/`NO_MATCH`/`OPTION_MISMATCH`/…, query appended;
- confirmed `price_history` row → success; integrity refusal → `WRITE_REJECTED`.
Not recorded: another process's in-flight claim, ledger outage, circuit-open `AUTH_ERROR`, and
fan-out (cross-match) misses — an incidental appearance in another query's answer must not
consume the target's own query or alternate budget. Fan-out successes are recorded (exact ID +
option, unchanged `pickOption`).

### Scheduler

Every run (regular, V3, legacy, manual catch-up) loads the day's progress from the DB and builds
the queue from it, not from a cursor. Priority: 0 never actually attempted → 1 transient retry
after backoff → 2 option alternate → 3 other evaluated → 4 success → 5 blocked. The sort is
stable, so inside a priority the V3 planner order (daily-first, expected yield, starvation lane)
is kept. A group whose targets were all covered by fan-out is skipped before calling. Products
with today's exact-option price are skipped regardless of who wrote it.

### Metrics (`efficiencyMetrics`, console `[EFFICIENCY:…]`, report email)

| Metric | Definition |
| --- | --- |
| Raw Success Rate | today's exact-option `price_history` rows / all daily targets (no-phrase targets included) |
| Attempt Coverage | attempted targets / all daily targets |
| Attempt Success Rate | successful / attempted |
| attempted | a request started for the target (even if it failed or timed out), or a real same-day answer was evaluated for it |
| not attempted | queued only, claim refused, rate-gate/budget skip, another process in flight |
| searchCalls | outgoing provider requests (`confirmed_request_count`); ledger reuses are `ledgerCacheReuses`, never requests |
| duplicateSearchCalls | requests beyond the first for the same provider/identity/day (bounded retries) |
| uncertainRequestIntents | `begin` without `finish` (crash between fetch and response) |
| failureProducts | non-successful targets by reason; `UNATTEMPTED` separate |

`searchMetricScope=daily_ledger_since_enable` (whole provider/day ledger, cron included) when
the flag is on; `current_run` otherwise. Metric failures never stop collection (`null`).

### Rollout, failure modes, rollback

1. Apply the migration (explicit approval) → run `supabase/2026-10-03-collector-daily-efficiency.VERIFY.sql`
   (section 6 exercises claim/begin/canonical/hash inside a rolled-back transaction).
2. Set `PRICE_QUERY_LEDGER=1` in Actions variables, then in Vercel.
3. Startup preflight: if the tables are unreadable or the expiry RPC fails, the run logs a warning
   and takes the pre-ledger path (`report.queryLedger = 'fallback'`) instead of collecting nothing.
4. Mid-run: a progress write failure stops the lane's further calls (`stopCause=progress`) but
   still saves matched prices; a ledger failure fails closed per call.
5. Rollback: flag off everywhere (enough on its own). Optional `…ROLLBACK.sql` drops only the new
   tables/functions; catalog, `price_history`, job state and caches are untouched (tested).

Known limits: an uncertain request (crash after `begin`) blocks that identity for the rest of the
day; in-process coalescing does not apply across processes (the SQL claim does); `OPTION_MISMATCH`
alternates are capped at one, stricter than the in-run 3-consecutive-miss rule it coexists with.

## Part 2 — Baseline audit (before this change)

Audit date: 2026-10-03 KST. Baseline: `dea0f069cb5cd643b930e708a09a05310fdfbc90` on `main`.
Line references describe that baseline. All investigation was read-only; no collector cycle, probe, migration, lock release, or production data mutation was performed.

### Execution paths and daily order

| Path | Schedule / trigger | Behavior and shared state |
| --- | --- | --- |
| `.github/workflows/daily-prices.yml:70-97` | 48 scheduled opportunities/day: KST 00:00-08:30 every 30 minutes; 09:05-23:35 at :05/:35; also manual dispatch | Runs the V3 gate, `collect-all-prices.js`, alerts, and summary. Jobs can be delayed or dropped, so this is an opportunity schedule rather than a guaranteed execution order. |
| `scripts/v3-canary-gate.js:39-53` | Before each Actions collector | Enables V3 from 2026-09-26, unless an operator switch, same-day kill marker, or state-read error disables it. It writes an environment flag, not production data. |
| `scripts/collect-all-prices.js:4521-4550` | Regular and manually invoked catch-up use the same entry point | Reads `price_job_state`, atomically acquires the collector CAS lock, and skips a live owner. Default run deadline is 50 minutes and never crosses KST midnight (`:476`, `:569`). |
| `scripts/collect-all-prices.js:4857-4882` | V3 or legacy branch | V3 runs Coupang and ADPICK lanes concurrently with independent budgets; legacy runs Coupang first and ADPICK afterward. Both use `runMallCollection`. |
| `vercel.json:169-172`, `api/cron.js:131-247` | UTC 18:00 / KST 03:00 daily | Billing renewal first; then hero, monthly curation, TODAY_PICKS and demand keywords within 45 seconds, concurrency 3. Calls `searchAll` and `saveProducts`; does not use the collector job lock or per-target resume state. |
| `.github/workflows/hotdeals.yml:27-29` | KST 08:50, 09:20, 21:20 | Internal price-history hotdeal evaluation plus the separate ADPICK hotdeal feed. Its hotdeal lock is separate. Existing criteria are outside this change. |
| `.github/workflows/external-hotdeals.yml:12`, `scripts/collect-external-hotdeals.js:706-722` | Every 15 minutes | External deals can request provider searches through `_shop` for safe affiliate matching. They share provider rate limiters/caches, not collector resume state. |
| `.github/workflows/conversions.yml:24-43`, `scripts/import-conversions.js:82-100` | Manual only | ADPICK report import has separate operation logging. Coupang conversion import is explicitly unverified and disabled; collector searches do not consume a Report API budget. |
| `scripts/observe-cron.js`, `scripts/v3-canary-report.js`, `scripts/verify-adpick-rate.js`, `scripts/audit-price-engine.js` | Manual investigator/audit tools | Read-only DB/log analysis. No separately named scheduled investigator or catch-up implementation exists in the tracked tree. |
| `scripts/coupang-probe.js:58-69`, `:102-110` | Manual diagnostic exception | Direct signed raw fetch bypasses provider cache, DB quota, and circuit state. Maximum 4 requests with 2.5-second gaps, but no request timeout. It must not be used for coverage investigation under this task's rules. |

Observed on GitHub Actions: run `37082649099` was in progress on the baseline at 2026-10-03 09:34 KST. No production validation cycle was launched. Historical comments about manual catch-up refer to the same collector with altered environment settings, not another tracked script.

### Target creation and denominator

`collector_eligible_products()` retains the existing permanent tracking policy: products with history before 2026-09-17 UTC, or later observations from `search`, `ai`, `cron`, or `import` (`supabase/2026-09-19-collector-eligible-catalog.sql:63-74`). A `collect` observation alone does not promote a bulk seed product into the daily tier.

The existing target-page function includes every supported-mall daily target plus one deterministic hash rotation bucket, normally one of seven. It assigns `daily` or `rotation` without overlap (`supabase/2026-09-22-collector-target-keyset.sql:239-256`). Target reads use bounded keyset pages and an eligible cache; they do not require transferring the entire catalog on normal runs (`scripts/collect-all-prices.js:1481`, `:1593`). These selection rules must remain unchanged for an honest before/after comparison.

`runMallCollection` currently builds `collectible` only from explicit keywords or a nonempty title-derived search phrase, and reports `targetProducts = collectible.length` (`:2660-2681`). Products without either are separately logged as `noPhraseTotal`. New raw success/attempt metrics must use the original daily target rows, including those failures, rather than silently adopting this smaller denominator.

### Existing accuracy and efficiency safeguards

- All normal provider searches pass through `api/_coupang.js` or `api/_adpick.js`; `_shop.searchAll` invokes both wrappers (`api/_shop.js:282-289`).
- Both providers already persist normalized response items in a DB cache and enforce same-KST-day freshness. Collector cache TTL is 24 hours (`scripts/collect-all-prices.js:130-135`, `:784-789`, `:1016-1021`); ordinary interactive cache TTL is 6 hours.
- Search result fan-out already exists for both first and recovery passes. `absorbCrossMatches` examines exact product IDs across the day's target set and only adopts uncovered targets (`:3012-3053`, `:3461-3462`, `:3979-3980`). It does not use fuzzy title similarity to inflate collection.
- Coupang matching requires exact `product_id` and `vendorItemId`; ADPICK uses its existing stable selling-unit product ID (`:659-681`). Matching uses uncollapsed `allItems` so a tracked option is not discarded by display option collapsing (`:3448-3456`).
- `recordPrices` checks the target option again immediately before the write (`api/_shop.js:713-724`). The collector counts success only after `recordedKeys` confirms a history write (`scripts/collect-all-prices.js:3350-3367`).
- V3 already orders P0 unattempted first, P1 cached recovery hints, P2 temporary failures, then P3 facet/ladder recovery; P4 successes are skipped (`:3587-3595`). Default primary group cap is disabled (`:3653-3655`).
- Both collector modes have heartbeat checkpoints (default every 90 seconds) and a live lock with default TTL 80 minutes (`:122-123`, `:1813`, `:2074`). Same-target V3-to-legacy transitions preserve success/attempt IDs (`:4571-4575`). Existing live locks must never be force-released.

### Actual configured API budgets

| Limit | Baseline implementation / configuration | Evidence |
| --- | --- | --- |
| Coupang Search hard cap | 50 per rolling minute | `api/_coupang.js:36`; DB `supabase/2026-09-28-coupang-minute-quota.sql:87-89` |
| Coupang all-API hard cap | 100 per rolling minute | `_coupang.js:37`; DB migration `:81-83` |
| Coupang operating cap | Search 35/min, all API 80/min, interactive reserve 15/min, collector max 15/min, env may lower | `_coupang.js:40-45` |
| Coupang collector gap and budgets | 4 seconds; 700 calls/run; 3,400 calls/KST day | `collect-all-prices.js:166`, `:206`, `:272` |
| ADPICK search hard cap | 10/min/key; DB acquire rejects requested values above 10 | `2026-09-23-adpick-rate-limiter.sql:68-70` |
| ADPICK ordinary process / shared search | 3/min with 10-second gap; shared 8/min, bounded to 10 | `_adpick.js:51-57` |
| ADPICK scheduled collector | 5/min with 12-second gap; 400/run; 3,000/day workflow override | `daily-prices.yml:158-159`, `:170`; `collect-all-prices.js:276` |
| ADPICK manual default daily budget | 740 unless explicitly configured | `collect-all-prices.js:145` |
| Recovery sub-budget | 630 calls/run for facet+ladder; hints excluded from sub-budget but still inside provider/run/day/deadline limits | `collect-all-prices.js:367`, `:3827-3829` |

Several historical workflow comments still mention 6-second Coupang gaps or 20/min totals. The executable settings above supersede those comments. The September 28 DB migration supersedes the older 10/hour Search function; it uses one advisory transaction lock to reserve shared minute slots. No new implementation should increase these budgets. Actual deployed settings and rate-limit responses require operational evidence, not assuming all migrations are applied.

### Remaining duplication and resume gaps

1. Provider cache keys are exact trimmed strings (`_coupang.js:555`, `:377-379`; `_adpick.js:378`, `:201-203`). Unicode, case, and repeated whitespace variants are not shared. Preserve meaningful model punctuation and options when normalizing identity; do not collapse distinct variants merely to save calls.
2. Cache access is read-before-request followed by upsert (`_coupang.js:566-567`, `:607-617`, `:722`; `_adpick.js:385-386`, `:412-423`, `:510`). Rate-limit admission is atomic, but a query is not atomically claimed. Two independent workers can both miss the cache and request the same query, including concurrent promises in one process that read before a preceding write completes.
3. Vercel cron explicitly sets `forceRefresh: true` for both providers (`api/cron.js:39-42`) and uses no global target progress. It can repeat an earlier regular collector query even with same-day results. Ordinary interactive searches can also refresh after six hours; cache policy must distinguish a deliberate live refresh from needless background repetition.
4. `price_job_state` is a single mutable snapshot, not a query ledger or per-target progress table. Primary success is inferred from attempted IDs/cursor. The recovery query list is truncated to the last 3,000 entries (`collect-all-prices.js:3498`, `:4475`), so old same-day attempts can disappear even while the target catalog grows. New process/mode/target-policy combinations can lose query history independently of response cache.
5. Product attempts are recorded only on successful transport (`:3430-3435`, `:3959-3964`). Network/timeout requests that actually left the process are omitted from attempted coverage. Nonrequests rejected by a budget/rate gate must remain unattempted; those two cases need an explicit `apiCalled` signal.
6. `collectedTodayKeys` is read for scheduler skipping only when `!isNewDay` (`:3074`). An absent/reset local state can therefore requery products already collected through another path that KST day. The global history/progress lookup must run independently of the local resume signature.
7. Group success adopts a matching product even if already observed by earlier fan-out; the original first-pass group can remain queued later in the same run. Skip groups with no still-unattempted/uncovered target and re-check before calling, while retaining accurate cursor and coverage accounting.
8. Stale-cache rejection drops the provider's root failure reason (`:806-808`, analogous ADPICK path). A quota denial becomes `staleCache` rather than `RATE_LIMIT`. Preserve typed failure and `apiCalled` through wrappers and retry decisions.
9. Failed primary queries persist as bare keywords (`:2868`), losing failure class, count and retry time. There is a per-run retry pass (`:3599-3638`) but no explicit same-day per-query retry cap across later jobs. Recovery transport failures do not enter `alreadyTried` (`:3933-3956`, `:3983-3984`), so subsequent jobs can repeat them.
10. Provider-only blocks disable all V3 features for the rest of the day (`:1927-1935`; `v3-canary-gate.js:50-51`). This also reduces healthy ADPICK parallel collection time. A completed October 2 Actions log explicitly showed the gate disabled due to Coupang block. Changing this behavior should retain anomaly/lock/invariant protections and require regression evidence.

### Failure and query-generation behavior

Current string classifiers distinguish option mismatch, blocked, rate limit, budget, timeout/API/DB errors, but do not provide one persistent typed classification covering `NO_RESULT`, `AMBIGUOUS_MATCH`, `INVALID_PRODUCT`, `SOURCE_ERROR`, and `UNKNOWN` (`:2534-2589`). Bare query retries also cannot distinguish a provider failure from a deterministic no-result response.

The existing safe query ladder already handles compressed titles, brands, models, nouns, trailing options, special punctuation and model-token splits (`api/_query.js:88-107`, `:198-236`, `:310-383`). It is finite: maximum 10 candidates and 48 characters. Collector recovery has up to 10 rounds, three cache hints/product, six facet calls/group with two consecutive dry responses stopping exploration (`collect-all-prices.js:390`, `:409`, `:467-470`). Option mismatch becomes terminal after three consecutive mismatches (`:465`, `:3327-3333`); incidental fan-out can still recover it without another paid call (`:3042-3047`).

Do not broadly shorten successful queries. Apply alternative generation only to failed targets, cap deterministic fallback exploration, and keep exact ID/option acceptance. A one-day ledger should block same-query `NO_RESULT` repeats, allow bounded transport retries after provider cooldown, and retain finite per-target alternative attempts. A successful same-day response may be reused for another target without charging an API call or claiming an observed live price outside that KST day.

### Integration points proposed by the audit (implemented in Part 1)

- Put atomic normalized query claim/result persistence in the provider wrappers so Actions, manual regular/legacy/catch-up, Vercel cron, and external search callers share the same protection. Key source by provider, not invocation label (`collect`, `cron`, etc.); invocation remains audit metadata. Claim failures must fail closed for the new feature, with staged rollout preserving existing deployment compatibility.
- Store minimal already-normalized item fields needed for exact matching and price evidence, including raw option IDs. Keep response retention short and scoped to a KST date. Explicit live refresh needs a separate, rate-limited freshness policy rather than an unconditional background bypass.
- Integrate per-target progress at `runMallCollection` entry, `processGroup`, `callAndMatch`, fan-out adoption, and the confirmed `recordedKeys` write point. Read same-day success before every mode and prioritize unattempted targets ahead of retry/alternative candidates. Count actual outgoing failures as attempts, while leaving rate/budget denials unattempted.
- Preserve `price_job_state` for the existing lock/checkpoint/rollback path; supplement it with progress instead of changing product selection or weakening accuracy gates. Track attempts, success, typed failure, bounded count, last query, status, and next retry time independently of transient worker snapshots.
- Add denominator-preserving raw success, attempted coverage, attempt success, paid unique-query efficiency, and duplicate-call counters, separately from existing per-pass attempt/cache-hit statistics. Unique query efficiency must count newly confirmed successful target keys, not response rows or rediscovered matches.
- Use a read-only seven-day replay for estimates. Caches retain only the latest response/query and current job state only the latest snapshot; they cannot alone prove which historical duplicate produced a new exact match. Actions logs duplicate collector stdout into the Coverage summary, so parse the actual collector step only. Report unknown response/matching evidence honestly and distinguish safe lower/upper bounds from measured gains.

### Operational limits of this audit

No collector run or diagnostic raw API probe was executed. No production target, product, history, API credential, lock, or RLS state was changed. Architecture findings are supported by the baseline code and read-only Actions status/log snapshots. Historical source data, actual duplicate counts, and the attainable 85-90% rate are a separate evidence/replay result; they must not be inferred solely from comments or a partial-day run.
