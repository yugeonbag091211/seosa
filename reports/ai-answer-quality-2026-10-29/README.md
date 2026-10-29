# AI answer quality review — 2026-10-29

## Scope and evidence

- The review is for PR #206 on `codex/ai-integration-release`, whose starting head is `2297cfd`. Current `main` includes collector PR #203; no collector source file was changed, and no Production deployment or database write was made.
- The existing 1,250-question set consists of the original 1,000, the independent 200-question holdout, and 50 independent new questions. A further 50 fully disjoint questions were run after the fixes. Each generated report stores question text, answer text, cards, product and vendor item IDs, search/price-history evidence, rubric verdicts, and cause details where applicable.
- The original 1,000- and 200-question reports truncated answers. Their full before-fix answers were reconstructed from PR #206 base `f20cb76` by running that handler with deterministic mock GPT and fixture shopping. They are explicitly labeled as reconstructed mock answers, not live GPT transcripts.
- Five independent static criteria evaluate accuracy, question satisfaction, price/spec evidence, conversation consistency, and naturalness. Naturalness is a strict rule-based surface screen, not a human or independent-model judgment. Injected defective answers are tested to ensure the rubric returns FAIL.
- All shopping data in these runs are fixtures. Actual GPT calls, real shopping requests, and database writes were zero.

## Results

| Set | Questions | Function pass | Quality pass | Quality fail | Unverified | Actual GPT calls | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Existing distinct questions | 1,000 | 1,000 | 1,000 | 0 | 0 | 0 | $0 |
| Existing independent holdout | 200 | 200 | 200 | 0 | 0 | 0 | $0 |
| Independent set included in the 1,250 | 50 | 50 | 50 | 0 | 0 | 0 | $0 |
| **Existing set reviewed** | **1,250** | **1,250** | **1,250** | **0** | **0** | **0** | **$0** |
| Additional fully disjoint fresh set | 50 | 50 | 50 | 0 | 0 | 0 | $0 |
| **Total offline unique questions** | **1,300** | **1,300** | **1,300** | **0** | **0** | **0** | **$0** |

Each of the five criteria passed 1,250/1,250 existing questions and 50/50 fresh questions. Functional and quality verdicts are tracked separately; a functional pass cannot override an answer-quality failure.

## Baseline defects and fixes

The static review found at least one quality defect in 559 of the 1,200 reconstructed prior answers; one answer can have several reasons:

- 11 answers contradicted an exact product card by saying no matching product was found. They are pinned in handler-level regressions, and all 11 before/after records are in `no-match-contradictions-before-after.jsonl`.
- 44 price answers did not distinguish listing price from checkout total; the response now labels the observed listing price and explains that coupons, card benefits, and shipping can change the actual amount.
- 142 Korean particle mismatches, 151 repeated card/title-price banners, and 153 comparisons without an actionable selection basis were detected and fixed or blocked by output checks.
- Other baseline defects included unsupported price-history claims, missing stock-check caveats, unaddressed specs/history questions, and multiple cards on non-comparison follow-ups. Exact causes and evidence are recorded per question.

The answer-quality test injects deliberately contradictory, unsupported, repetitive, ungrammatical, and incomplete answers and requires FAIL. The evaluator does not relax thresholds to make a run pass.

## Existing 21 price/security failures

The three price-source failures came from a test expecting a constant removed by PR #202. The tests now check the rendered source by seller, unknown discount/shipping treatment, and checkout guidance. The 18 AI price-evidence failures used historical fixtures whose dates had aged beyond the current-price window. Their fixture clock is scoped to the recorded date; freshness boundaries and invalid/stale-price rejection remain enforced.

## Verification and limitations

- `npm test`: PASS (exit 0), including the answer-quality pretest and full repository regression suite. Product/vendor ID exact matching and price freshness checks remain in the suite.
- `node scripts/audit-ai-answer-quality.js`: 1,250/1,250 function and answer-quality pass; all five criteria 1,250/1,250. The 50 fresh questions separately pass function and quality 50/50 and each criterion 50/50.
- Targeted contradiction/evaluator-injection, comparison, tablet/headset type, budget, memory, price/spec-provenance, and intent regressions pass.
- No safely authenticated, isolated Preview environment was available: the Preview is SSO protected and the branch has no safe Preview credentials. We did not bypass authentication. Live GPT and actual shopping E2E are **unverified**; the requested minimum of 50 real GPT calls was not run. Actual external cost: **$0**.
- PR #206 remains Draft. Production has not been deployed. Live answer quality cannot be claimed from mock results, so Production deployment is not cleared by this report.

## Artifacts

- `quality-review.jsonl` and `.summary.json`: the existing 1,250-question before/after review, all five criterion verdicts, cards, search evidence, price history, and failure causes.
- `no-match-contradictions-before-after.jsonl`: all 11 product-card/no-result contradictions with original and corrected answers.
- `offline-1000-after/` and `holdout-200-after.jsonl`: the 1,000-question and 200-question handler runs.
- `new-independent-50.jsonl` and `.summary.json`: the 50 new questions included in the existing 1,250 set.
- `fresh-independent-50.jsonl` and `.summary.json`: the additional 50 fully disjoint questions and their per-question five-criterion results.
