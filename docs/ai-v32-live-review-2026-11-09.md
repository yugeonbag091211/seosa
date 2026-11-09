# SEOSA AI v3.2 | 2026-11-09 Preview live validation and repairs

## Scope, immutable evidence
- Deployed baseline: Vercel Preview `seosa-6kmicw60w-seosa.vercel.app`, Git commit `9214df4`. This is NOT production.
- Original 200-question baseline, independently regraded with v3.2 evaluator: PASS 113 / FAIL 43 / UNVERIFIED 44. Previously filed 125/7/68 used older scoring and is NOT directly comparable.
- Original 70 holdout questions and oracle labels were registered in commit `d16bf9b`, before this run. Do not retroactively edit the original labels.
- Live result: `reports/ai-v32-online-20261109/holdout70-v32-existing.jsonl`, 70/70 HTTP 200; 120 model calls, 90,948 input + 7,473 output = 98,421 tokens; mean 2,614 ms, p95 4,158 ms; 145 presented cards.
- Raw initial evaluation before independent evaluator bug fixes: PASS 47 / FAIL 5 / UNVERIFIED 18. After correcting clearly false evaluator flags in H08/H37, same **unchanged live output** regrades to PASS 48 / FAIL 4 / UNVERIFIED 18. This is reevaluation, NOT a second deployment or fresh experiment.
- No definitive USD cost from recorded provider billing; tokens alone are not a verified cost.

## Five initial fails and adjudication
| Case | Finding | Classification / next verification |
|---|---|---|
| H11 bare Galaxy Tab S10 FE Plus 256 GB Wi-Fi | Model chose `none` without search despite specific SKU; fix promotes sufficiently specific bare device queries | Real intent error; new Preview must search, though exact purchasable SKU availability is not established |
| H37 Galaxy Tab S9 FE keyboard case | Title explicitly lists S10 FE / S9 FE / S9 compatibility, but independent checker expected the product-family prefix before each token | Evaluator false positive; accept explicit set member while rejecting wrong S8 FE |
| H38 wireless keyboard and mouse set under 30,000 KRW | Model treated combo as mouse and returned no recommendation | Real omission; Neon catalog SELECT on 2026-11-09 showed genuine bundle listings, plus misleading accessories/wired offers to exclude |
| H47 Roborock S8 price comparison | 32 candidates rejected, mostly wrong model, and no verified exact plain S8 found | **Oracle dispute**: original label FIND says S8 Pro/MaxV/Plus family is permissible while explicitly noting no plain S8. Do not weaken exact-variant guard or silently change holdout label; pending human adjudication |
| H51 Marshall Emberton III Bluetooth speaker | Two returned listings showed only 'portable' in the title, without Bluetooth evidence | Inadequately grounded attribute under title-only policy; repair rejects insufficiently evidenced listings |

H08 independent evaluator initially misread `프렌즈샵` as camera lens accessory `렌즈`; require lexical boundaries.

## Live root-cause evidence
- Read-only Neon SQL: `products` has 11 price-filtered lexical keyboard+mouse set matches under 30,000 KRW, but includes receiver replacement, wrist-rest, and wired options. Verified examples with title evidence: iPlex wireless RK-2000 set 13,090 KRW, iRiver WS101 wireless combo 24,900 KRW, iNote KM777R wireless combo 29,900 KRW. Prices are database snapshots, not live sell-through verification.
- Read-only Neon search for single base Roborock S8, excluding obvious variants and accessories, yielded no confirmed plain S8 device; this does not prove exhaustive unavailability.
- Historical root-cause oracle covers original 68 UNVERIFIED: 56 catalog, 12 follow-ups; 42/56 catalog searches with lexical matches, 40 with eligible samples and 14 zero matches. Conditions need independent audit before declaring a retrieval defect.

## 2026-11-09 repair strategy
- Deterministic shopping intent for bare exact SKU; do not turn generic or informational questions into searches.
- Bundle-aware keyboard+mouse category and validation; reject one-item, receiver, accessory offerings.
- For Bluetooth speakers, do not infer wireless from a brand/model name or 'portable' alone; require title evidence.
- Evaluator fixes independent of API for `프렌즈샵` and explicit Galaxy Tab compatibility sets.
- Temporary Vercel share-authenticated Preview runner supports exact UTF-8 Korean POSTs; never log share link or bypass token.
- Run the original 70 again only as a separate new-run experiment after deployment and record any gains/failures; preserve the initial results and registered labels. No Production deployment or database writes.

## Local tests
- New targeted regression 8/8 PASS; v3.2 root-cause 26/26; existing engine 62/62, v3 core 40/40, v3.1 verdict 12/12, catalog 13/13, identity 48/48. Total explicitly observed: 209/209, some suites overlap in behavioral coverage. All are offline and cannot substitute for Preview.

## Post-patch first Preview (commit a522a39)
- Preview `seosa-ojuksmu58-seosa.vercel.app` READY; six cases (H08, H11, H37, H38, H47, H51) all HTTP 200.
- Independent evaluator after correcting the combo accessory-tail false positive: PASS 4, FAIL 2 (H11 shopping not searched; H47 disputed FIND oracle), no verified wrong cards in 12 shown.
- H38 successfully returned real keyboard/mouse bundles, but original independent evaluator had called the descriptive phrase `PC 액세서리` a principal part; fixed separately without relaxing hard rejection of stand-alone replacement parts.
- H11 remained no-search under a model-planned comparison with an empty second subject. Follow-on fix routes only a **specific user-named SKU** without comparison language to ordinary search; preserve older regression for vague `가격 좀 알려줘` with invalid compare state.
- Do not claim these follow-on fixes are deployed until the next Preview check.
