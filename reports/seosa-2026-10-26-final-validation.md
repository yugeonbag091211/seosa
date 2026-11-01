# SEOSA PR #197 final validation — 2026-10-26

## Status at 2026-10-26 11:04 KST

PR #197 remains open as Draft. Its Preview build is ready. Production was not changed because real GPT plus marketplace E2E has not been verified. The noon and evening scheduled collector runs have not occurred yet.

| Workstream | Result | Production |
|---|---|---|
| 1. AI integration | Code and CI checks passed; real Preview E2E remains blocked | No merge or deployment |
| 2. AI evaluation | Offline suites passed after fixes; real GPT E2E remains unverified | No live calls; $0.00 |
| 3. Price collection and email | Schedule precheck only; both runs are still in the future | No run, price write, or email claimed |

## PR, commits, and deployments

- PR: [#197](https://github.com/yugeonbag091211/seosa/pull/197), open, Draft, mergeable.
- Validated head: `1a7d08cc8f79e838690cf462be4cc25007419ac9` (`test(ai): add independent holdout and harden followups`).
- GitHub Actions for that commit: Tests #379, AI security validation #248, Collector Regression #62, and Mobile Check #55 all completed successfully. Vercel status is successful.
- Preview deployment: `dpl_Bu4vYWKXrJZvy6CF8pGc7Gdu5sdJ`, READY at `seosa-4x4ntrw6o-seosa.vercel.app`.
- Preview branch has `SEOSA_DB_READONLY=1` configured to prevent Preview database writes.
- Production remains at commit `5cce850d8ea7d38cfa28413638e1a0c2b10e3406`, deployment `dpl_ofK5DTt54sUBVjSaqsCmq2fcV9Wj`.

## Installation and regression tests

- `npm ci`: passed after retrying with the required network permission; 71 packages added, 0 vulnerabilities. The first sandboxed attempt terminated with npm's `Exit handler never called` error and left dependencies incomplete; the successful clean install restored them.
- `npm test`: passed with exit code 0 after the clean install. The sandboxed run could not bind the local mock HTTP server in `test-coupang.js`; the same full suite passed when run with local loopback permission. The test suite makes no live Coupang/API or database writes.
- Direct checks passed: `test-offer-identity` 437/437 (0 false positives, 0 false negatives), `test-identity` 51/51, `test-ai-integration-1026` 45/45, `test-price-volatility`, `test-volatile-report`, `test-ai-comparison-holdout` 100/100, and `test-ai-budget-scope` 30/30.
- GitHub Mobile Check passed; no mobile feature development was done.

## AI evaluation results

These suites use the real application handler with mock GPT and fixture search/catalog data. They are offline evaluations, not evidence of live GPT or live marketplace behavior.

| Evaluation | Questions | Pass | Fail | Unverified | Pass rate |
|---|---:|---:|---:|---:|---:|
| Existing distinct corpus | 1,000 | 1,000 | 0 | 0 | 100% |
| Existing holdout | 185 | 185 | 0 | 0 | 100% |
| New independent holdout, first run | 200 | 164 | 36 | 0 | 82% |
| New independent holdout, after fixes | 200 | 200 | 0 | 0 | 100% |
| Requested real GPT + marketplace Preview cases | 10 planned | 0 | 0 | 10 | N/A |

The new holdout contains 200 unique prompts and has zero overlap with the existing 1,185-question corpus. Its first-run failures exposed search-action wording gaps, product/option fixture alias gaps, natural comparison forms that the parser rejected, and a follow-up that lost the prior budget cap. The relevant parser and follow-up behavior was fixed; the same holdout then passed 200/200. First-run and final JSONL results and summaries are stored alongside this report.

Actual GPT calls: **0**. Actual AI API spend: **$0.00**. Offline tests recorded 0 external search calls and 0 database writes.

## Real Preview E2E blocker

The new Preview is behind Vercel Deployment Protection. A request to create a temporary share link that would allow anyone with the link to access the Preview for 23 hours was rejected by automatic approval review because it would widen access. No alternate protection bypass was attempted. The normal browser inspection also stopped when Computer Use could not establish the current browser URL with sufficient confidence to enforce policy.

Therefore, live GPT, actual Coupang/ADPICK search, option/price correctness, live follow-up behavior, and actual API usage/cost are unverified. The PR must stay Draft and Production must not be updated until an authorized, normally authenticated Preview session or another approved access method permits the E2E checks.

## Scheduled price collection and email

- `.github/workflows/volatile-prices.yml` remains scheduled for 12:05 and 19:05 KST (03:05 and 10:05 UTC) on `main`. Schedule and budgets were not changed; no manual dispatch was started.
- At the report timestamp, both scheduled slots were still in the future. No run, API call count, product count, database write, price change, option mismatch, hold, lock conflict, quota result, or email can be reported yet.
- `test-volatile-report.js` passed its local regression checks, but the local environment has no Resend, shop, or database credentials. This does not verify a live send or inbox delivery.
- After each scheduled run, inspect the GitHub Actions run and its logs, confirm API usage and product/option outcomes, separately verify DB writes and actual changed prices, then inspect the Resend response and recipient inbox if available. Report email submission and inbox arrival as separate results.

## Production gate

Do not mark this release complete, convert the PR to Ready, merge, or promote the Preview to Production until real Preview E2E passes. The Production commit and deployment above remain unchanged. The scheduled collector and email workstream also remains incomplete until both actual scheduled runs and their effects are inspected.
