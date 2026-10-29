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
