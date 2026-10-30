# AI integration validation — 2026-10-29

The integration starts from main `120efe41` (including collector PR #203) and merges PR #197 at `ffe8e6a`. PR #205's three product-type fixes and handler regressions are already present in that PR. Collector code is unchanged from main.

## Offline evidence

These are real handler executions with a mock GPT, fixed search catalog and in-memory database. They are not measurements of actual GPT or marketplace behavior. The 1,000 questions are distinct actual strings sent to the handler; the summary records category membership and the corpus hash. One hundred injected false-current-price responses are spread across categories; the 200 evidence cases below also include specifications and history and are not all price-only cases.

| Area | Questions | Pass | Fail | Unverified |
| --- | ---: | ---: | ---: | ---: |
| Budget | 150 | 150 | 0 | 0 |
| Product identification | 350 | 350 | 0 | 0 |
| Comparison | 100 | 100 | 0 | 0 |
| Conversation memory | 150 | 150 | 0 | 0 |
| Security | 50 | 50 | 0 | 0 |
| Price and specification evidence | 200 | 200 | 0 | 0 |

See `offline-results.jsonl` and `offline-summary.json` for individual results and composition. Before fixes the same corpus failed 15 questions; exact questions, expected behavior and responses are preserved in `initial-failures.jsonl`. They involved conversational lead-ins being treated as product terms, references to alternatives, remembering both comparison targets, and a reference to a selected option. The same 15 questions subsequently passed without relaxing their assertions.

An additional 200-question holdout passed 200/200 after the fixes, and 20 new product-type handler questions passed 20/20. These strings do not overlap the 1,000 questions, but the 200-question holdout shares the fixture catalog and mock infrastructure, so it is not independent live-marketplace evidence. The extra 20 have their own fixture catalog. See `holdout-200.jsonl`, its summary, and `scripts/test-ai-product-type-holdout.js`.

The existing three price-source failures came from a test for a constant removed by PR #202; the replacement checks the actual rendered seller-specific source and the uncertainty and checkout guidance. The 18 AI price-evidence failures came from historical fixture dates aging past the current-price freshness limit. The fixture clock is scoped to the historical cases, and separate freshness boundary, invalid-date and stale-price rejection checks remain enforced.

The complete `npm test` chain passed, as did `test-regression` (85/85). The additional release suite initially failed four assertions because its recovery fixture fell inside the existing five-minute double-charge protection window. Its clock-relative fixture and boundary checks were corrected without changing billing behavior or reducing the assertions; the release suite then passed 123/123. The new 20-question product-type holdout was run separately after being added to the npm chain. All of these checks used mocks.

The budget exception is currently limited to explicit support and non-support of noise cancellation in the candidate titles. Missing features are treated as unknown. Ambiguous tablet bundle titles may be rejected conservatively.

## Live verification

Real GPT calls: 0. Actual shopping-search calls: 0. API spend: $0.00. The new branch has no verified isolated Preview database configuration, and the available Preview is protected. Real E2E is unverified; do not merge or deploy on the basis of mock results. Never use production data writes or bypass deployment protection for these tests.
