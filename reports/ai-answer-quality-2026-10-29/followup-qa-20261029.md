# PR #206 follow-up QA — verified at commit 1787e01 (2026-10-29)

## Scope and safety

- Changes are on Draft branch `codex/ai-integration-release` only. No Production deployment or database writes.
- External GPT calls: **0**. Actual shopping API calls: **0**. External API cost: **$0**.
- The evaluation ran actual `api/ai.js` with deterministic mock model responses, fixed catalog and in-memory data. These results **do not establish live quality**.
- The collector changes from merged PR #203 were not edited. Exact `productId` + `vendorItemId` matching was made stricter in the answer-quality evaluator.

## Changes in this follow-up

1. `api/ai.js`: if a request for an exact, server-verified product listing price receives the model fallback "확인된 상품 카드에서 상품명과 가격을 확인해 주세요", replace the deflection with a direct answer using the verified card's amount and explicit listing-vs-checkout distinction.
2. `scripts/audit-ai-answer-quality.js`: do not use prices, specs or discount notes from a different search candidate to support the selected product. Only evidence with exact matching product ID and vendor item ID can support selected-product assertions. Unselected candidates can support a clearly labeled, verified **over-budget relaxation** when no card was selected.
3. `api/_concierge.js`: do not list explicitly excluded/refurbished offers among the recommended alternatives.
4. `scripts/test-ai-answer-quality.js`: negative controls require the grader to fail a different candidate's price/spec and fabricated budget-relaxation amounts; positive controls check exact card price and real over-budget arithmetic; handler checks direct price answer from a vague model fallback.
5. `api/ai.js`: added safeguards against replacing unverified specification/history requests with unhelpful generic recommendations, and an explicit price-future uncertainty notice. Some history-question paths **remain unresolved**, as indicated below.

## Test outcomes

| Test category | Number | Pass | Fail | Unverified | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| Distinct offline functional questions | 1,000 | 1,000 | 0 | 0 | Mock GPT / fixture shopping |
| Additional offline holdout functional questions | 200 | 200 | 0 | 0 | Mock GPT / fixture shopping |
| Independent offline new functional questions | 50 | 50 | 0 | 0 | Mock GPT / fixture shopping |
| **Offline answer-quality rubric, same 1,250 questions** | **1,250** | **1,235** | **15** | **0** | Stronger option-scoped evidence checks |
| Live GPT / real shopping E2E | 50 planned | 0 | 0 | 50 | No isolated authenticated Preview DB established |

The functional-pass counts and answer-quality pass counts are **different measures and cannot be merged**. The older report of 1,250/1,250 answer-quality PASS is superseded for the rerun of the current checkout by the **1,235/1,250** result. No score threshold was lowered.

Quality failure breakdown:
- **14** history/timing questions receive price/recommendation content without answering the requested price history/cheapness question, e.g. “에어팟 프로 2세대 가격 떨어진 거 맞아?” and “코웨이 공기청정기 AP-1019C 이 가격이면 싼 편이야?”. Their question-satisfaction criterion is FAIL.
- **1** conversational follow-up “예산은 그대로 두고 필립스 모델만” contains `5.5L` not grounded for the selected Philips option, so price/spec-evidence criterion is FAIL.
- Final negative-control regression itself passed; the 15 failures are **real gaps detected by the stronger rubric, not forced into PASS**.

## Delivery gate

**Not production-ready.** PR remains Draft and unmerged. Required next actions:
- Diagnose the actual history/timing route that bypasses the current end-of-answer safeguards; fix the returned answer with verified option-level price history, or transparently say evidence is insufficient.
- Fix option carryover contamination in the Philips follow-up; preserve user excludes, option IDs and budget.
- Rerun all original 1,250 plus new unseen holdout and inspect full answers.
- Establish Preview authorization and a verified isolated read-only/test DB before any live GPT/real shopping E2E. Run at least 50 diverse real GPT questions within $5 only after safe setup.
- Obtain green GitHub checks for the latest head and review the answer text before merge. Do **not** deploy Production without separate approval.


## Resolution addendum — 2026-10-29, follow-up 15/15 repaired

**Current code head at reproduction time:** `7e7d863` (all changes stayed on Draft PR #206; no production deployment). This addendum supersedes the **1,235/1,250** count above for the *regenerated latest-code results*.

### Root causes and corrections

- The 14 history-answer failures were caused by model/fallback prose giving only a recommendation or listing price, without answering whether a price had fallen or was cheap. The final server answer gate also had incorrectly escaped `\\s` regular expressions, so several phrasings were not detected. Corrected the regex, required evidence-backed history text from a verified exact offer (productId + vendorItemId), and kept explicit uncertainty when observation data is insufficient. When a verified listing price is displayed but history inference is unsupported, the answer includes that observed listing price without treating it as a checkout total or proven trend.
- The 15th failure involved a 120,000 KRW Philips-only follow-up. The correct Philips offer at 139,000 KRW was removed by the budget filter, but the remaining Cosori/Cuckoo tier-2 mismatched offers were retained as candidate `items` (even with `cards=[]`). The model could then reuse Cosori's 5.5L/99,000 KRW. New budget handling converts an all-over-budget exact-brand/model request into an explicit `BUDGET` no-result answer instead of treating the cheaper other-brand products as matches. No product/card identity was relaxed.
- The independent rubric previously evaluated the inherited-budget follow-up with no `budgetMax` because the user said "예산은 그대로" rather than repeating 120,000 KRW. The rubric now retrieves only the **last explicit user budget from the same test conversation** and permits only explicitly described, product/vendor-verified over-budget candidate prices and correct arithmetic, with exact-brand matching for "필립스 모델만". Added negative controls that reject a different brand's 99,000 KRW and unsupported budget arithmetic.

### Latest isolated mock/fixture QA

| Area | Questions | Function pass | Answer-quality pass | Fail |
| --- | ---: | ---: | ---: | ---: |
| Original distinct handler questions | 1,000 | 1,000 | 1,000 | 0 |
| Independent holdout | 200 | 200 | 200 | 0 |
| Additional independent questions | 50 | 50 | 50 | 0 |
| **Total** | **1,250** | **1,250** | **1,250** | **0** |

The 14 exact history questions and the 4-turn Philips conversation are now dedicated handler-level regression tests. Additional negative controls cover incorrectly borrowed catalog prices/specs and inherited-budget claims. Tests were run against `api/ai.js` with mock GPT, fixture shopping and an in-memory DB, not the real GPT/shopping environment. **Actual GPT calls: 0; real shopping API calls: 0; external API cost: $0; Production deployments: 0.** Latest QA reports were regenerated in an isolated Vercel sandbox using:

```bash
node scripts/test-ai-answer-quality.js
node scripts/eval-ai-1000-distinct.js --out reports/ai-answer-quality-2026-10-29/offline-1000-after
node scripts/eval-ai-independent-holdout-2026.js --out reports/ai-answer-quality-2026-10-29/holdout-200-after.jsonl
node scripts/eval-ai-answer-quality-new-questions.js
node scripts/audit-ai-answer-quality.js --out /tmp/qa-final.jsonl
```

**Important artifact qualification:** These refreshed answer-level JSONL outputs were generated in the sandbox and are reproducible with the commands above; the older JSONL files already committed to the branch were not overwritten via GitHub's file API by this QA addendum. Reviewers must regenerate them before citing individual current-answer transcripts. A 100% rule-based score still does not establish human-level quality or live GPT correctness. PR #206 remains Draft; production deployment is not authorized.
