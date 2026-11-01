# SEOSA AI — real marketplace read-only QA (2026-10-30)

## Test environments and limits

- Draft PR #206 was never merged or pushed to Production.
- Two separate Vercel Preview QA branches ran `scripts/verify-ai-live.js` with an explicit max LLM budget of USD 1 and **mandatory `SEOSA_DB_READONLY=1` guard**.
- The scripts used the real AI handler plus genuine ADPICK search; the global Coupang acquisition RPC was *not* whitelisted or bypassed. The read-only guard blocked it.
- The temporary buildCommands that ran paid tests were deleted from both QA branches immediately after test completion.
- Real product search data is not a guarantee of current checkout price. Some cached price observations were around 10 days old.

## Pilot A — 10 unique shopping questions

- Deployment: `dpl_9W3GiypQsYiifToQm6TALhqfRVZa` (QA commit `0afe59d4c196fbd62a2bf2bed05f4a3625cf36a9`).
- 10 distinct prompts across earbuds, gaming headsets, mice, keyboards, speakers, monitors, vacuum cleaners, laptops, power banks and air fryers.
- **8 real ADPICK HTTP-200 searches**, **2 search failures due the instance's 3/min rate limiter** (vacuum and air fryer). Coupang vendor calls: **0**, intentionally blocked by global quota/readonly protections.
- **10/10** budget-cap checks and **10/10** read-only guard instrumentation checks passed.
- The script's `20 PASS / 0 FAIL` reflects exactly those twenty checks, **NOT** ten successful merchant lookups. Actual merchant-search coverage was **8/10**.
- Blocked DB writes recorded: **16**; blocked RPC attempts: **11**. Stored database writes: zero.
- Estimated GPT cost: **USD 0.005496**.
- Actual data quality issues observed: a mixed earbud/voice-amplifier/hair-dryer campaign listing surfaced as a recommended SKU; clothing/heating and customization-service offers appeared in power-bank cards. These are real ranking/type-gate defects, not price-cap violations.
- Paid buildCommand removed at commit `9d5274a395236527988edf0f74246d736ce9e868`.

## Remediation

- Reject obvious mixed-category promotional collections rather than treating a roundup as a single offer.
- Reject winter-heating apparel/packs and made-to-order customization services when a standalone portable battery was requested.
- Add an opt-in strict live-search validation flag to `scripts/verify-ai-live.js`; it checks `verify.search='found'` **and positive-priced actual cards**. A safe no-result explanation during vendor throttling is NOT scored as a real merchant integration success.
- Core source commit: `6d56aa304a49744a05961586273760d9a9f68c5f`; deterministic tests included in normal CI.

## Pilot B — focused two-case actual vendor verification after remediation

- Deployment: `dpl_4aZq3bi6r6xTHXzYCZzZPg5cxJmi` (QA commit `7f8be86872a4dc99cd92f5fd99260ec52dc32e44`).
- Query 1, earbuds <= KRW 150,000: ADPICK HTTP 200; the irrelevant mixed-brand/cross-category campaign was absent from the returned recommendation cards; budget and readonly checks passed.
- Query 2, power banks <= KRW 70,000: ADPICK HTTP 200; a Samsung 20,000mAh power bank was returned; heating clothing/DIY service false positives were removed. Budget and readonly checks passed.
- **2/2 confirmed real merchant lookups**, **6/6 specific assertions PASS** (merchant result + budget + readonly for each question).
- Blocked writes: **4**; blocked RPC attempts: **3**, with no actual DB writes.
- Estimated GPT cost: **USD 0.001193**; temporary paid buildCommand removed at `4442200b9b9058937794bdd369b8cc22e6388475`.

## Release status

**Keep PR #206 Draft and Production unchanged.** The 100-question real-GPT fixed-catalog evaluation reached 98/100 overall and 98/98 among model-invoking cases in a separate run; this does **not** validate every actual merchant category. The two-case focused real-merchant test confirms these regressions were resolved on ADPICK only; the Coupang global limiter remained closed. Remaining gates include safe multi-merchant coverage, realistic throttling/retry handling without violating provider quotas, larger product-type relevance audits, and confidence/price freshness monitoring.
