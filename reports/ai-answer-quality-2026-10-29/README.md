# AI answer quality review — 2026-10-29

## Scope and method

- PR #206 is based on current `main` at `120efe41` and includes merged collector PR #203. No collector code was changed here.
- PR #197 is 84 commits ahead and 6 behind current `main`, and GitHub reports it as conflicted. PR #205 adds the three Production product-type guards and their handler tests; those guards were already present in the PR #206 base. The fixes in this task extend them.
- The previous 1,000-question and 200-question reports were truncated. Full baseline responses were reconstructed from PR #206 base `f20cb76` by running its real handler, deterministic mock GPT, and fixture catalog. These reconstructed responses are explicitly labeled in the JSONL; they are not actual GPT transcripts.
- The final static rubric evaluates accuracy, question satisfaction, price/spec evidence, conversation consistency, and a rule-based naturalness screen independently for every question. Naturalness is not a human or independent-model judgment.
- The 50-question corpus is new and text-disjoint from both original corpora. All model answers and shopping data in these runs are mocks/fixtures.

## Results

| Set | Questions | Function pass | Quality pass | Quality fail | Unverified | Actual GPT calls | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Existing distinct questions | 1,000 | 1,000 | 1,000 | 0 | 0 | 0 | $0 |
| Existing independent holdout | 200 | 200 | 200 | 0 | 0 | 0 | $0 |
| New independent questions | 50 | 50 | 50 | 0 | 0 | 0 | $0 |
| **Combined static answer review** | **1,250** | **1,250** | **1,250** | **0** | **0** | **0** | **$0** |

Each of the five static criteria passed 1,250/1,250. This is offline evidence only and does not establish live-model answer quality.

## Baseline issues found

The review found 89 distinct baseline questions with at least one static quality failure. Failure reasons overlap:

- 11 answers contradicted an exact product card by saying no matching product was found.
- 44 price answers did not distinguish listing price from checkout total.
- 14 stock questions omitted that live stock was not checked.
- 20 non-comparison follow-up turns returned multiple product cards.
- 4 budget answers omitted an in-budget candidate or the reason for not choosing it.
- 1 answer included amounts unsupported by the question, cards, or price evidence.

The required six checkout-price contradictions are pinned in `scripts/test-ai-answer-quality.js`. The complete before/after answers, cards, price notes, search evidence, separate criterion verdicts, and failure causes are in `quality-review.jsonl`.

## Existing 21 test failures

The repository report identified the original 3 price-source test failures as a test that still expected a constant removed by PR #202. It now checks the actual rendered source by seller, the unknown discount/shipping treatment, and checkout guidance. The original 18 AI price-evidence failures were date-dependent historical fixtures that had aged out of the current-price freshness window. Their fixture clock is scoped to the recorded date; the freshness boundary, invalid-date, and stale-price rejection assertions remain.

The price-provenance answer assertion also now expects the verified listing/checkout caveat to be appended while requiring the captured answer itself to remain intact. No grounding assertion was removed.

## Verification and artifacts

- `npm test`: passed with GPT, marketplace, and database credentials cleared for the local run; answer-quality pretest included.
- `node scripts/eval-ai-1000-distinct.js`: 1,000/1,000.
- `node scripts/eval-ai-independent-holdout-2026.js`: 200/200.
- New independent questions: 50/50; mocked model calls 50, actual GPT 0, external shopping 0, DB writes 0, cost $0.
- Preview is SSO protected and no safe Preview credentials are configured. Actual GPT and shopping E2E remain unverified; the protection was not bypassed.
- Production was not deployed. PR #206 remains a Draft deployment candidate pending safe live verification and review.

Artifacts:

- `quality-review.jsonl` and `quality-review.summary.json`: 1,250 full question-level records and rubric summary.
- `offline-1000-after/`: latest 1,000-question handler run and summary.
- `holdout-200-after.jsonl` and summary: latest 200-question holdout.
- `new-independent-50.jsonl` and summary: new disjoint questions and results.
