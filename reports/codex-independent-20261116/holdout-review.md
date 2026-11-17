# Frozen-code synthetic holdout evaluation

The single holdout run was performed after source and registered data were fixed in commit `e7349ef2db59f27e80b398e63a7cd3671e8d637a`, on 2026-11-16T04:30:25.875Z. Source, evaluator, lockfile and input hashes are in `holdout-run-e7349ef-20261116.json`. The evaluated 15 categories were disjoint from the 25 development categories, but all 40 categories use the same eight synthetic prompt templates. This is an unseen-category fixture evaluation, not an independent sample of real user language or provider inventory.

| Measure | Result |
| --- | ---: |
| Questions | 120 |
| PASS / FAIL / UNVERIFIED | 15 / 72 / 33 |
| Verifiable question accuracy, excluding UNVERIFIED | 17.24% (15/87) |
| Questions with zero displayed cards | 53 (44.17%) |
| Verified good / confirmed wrong / unverified among up to five displayed cards | 108 / 20 / 46 |
| Lower bound on displayed-card micro precision | 62.07% (108/174) |
| Fixed-five-slots P@5 lower bound | 18.00% (108/600) |
| Fixed-five-slots P@5 upper bound if every unknown were correct | 25.67% (154/600) |
| Recall@10 in the preselected fixture pool | 60.00% |
| Mock product upsert rows: confirmed wrong / unverified | 15 / 0 of 111 |
| Mock handler mean / p95 | 3.210 / 5.452 ms |
| External fetch attempts | 0 |

The output JSON names 62.07% `precision_at_5_lower_bound_percent`, but its denominator is the 174 actually displayed cards, not the 600 fixed-five slots. Both denominators are stated above rather than treating that value as conventional fixed-denominator P@5. The upper bound is hypothetical, not a verified score. Fixture recall uses only the five preselected candidates per question and cannot estimate catalog or supplier recall. Reported response times exclude real providers and databases.

The 72 FAIL questions consist of 53 with all known fixture targets missed and 19 with a confirmed wrong card shown. Among 20 wrong cards, 16 are accessories, two violate a brand exclusion and two mismatch the requested brand. Fifteen simulated upsert rows are accessories; repeated fan blades, blender blades, saucepan handles and slipper decorations across prompts are counted as rows and must not be represented as 15 distinct actual products.

For 72 missing target instances, the evaluator attributes 51 to the product gate, 20 to ranking or the score floor, and one to the simulated provider relevance filter. Reasons include `category_absent:와도` (15 target instances), `accessory:매트` against mattress titles (nine), `...에 쓸` as identity words, and `사양` or `동시에` treated as a category. A new-condition slipper was rejected as refurbished; the exact parsing cause requires confirmation. These counts are fixture diagnoses, not an inventory census. Some fixture titles repeat words and all prices are artificial; do not relax real price safeguards solely in response to them.

The real search handler, ranking, product gate and save logic ran with a stub provider and mocked database, trust augmentation, price-change augmentation, rate limit and network. No real Coupang, ADPICK, real DB, AI, or consumer-flow validation is established by this run. Product usage, price history, actual API cost, real response latency and full-catalog Recall remain unverified.

The question and answer files were hashed before development and their hashes were verified by the evaluator. The code and scoring logic were not changed after opening this holdout. If code or grading is changed based on these results, this run remains evidence only for the commit above; a new, independently registered holdout is required for a fresh independent score.
