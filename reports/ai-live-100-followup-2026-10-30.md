# SEOSA AI 100-question follow-up — 2026-10-30

Scope: PR #206 Draft branch; no production deployment or paid API re-run in this change.

## Confirmed QA issues

- The earlier 100-question report remains **92 PASS / 8 FAIL-or-unverified**, from actual GPT calls against a fixed product catalog.
- R2-208 has an invalid reference label. The user's requirement is a 14-inch LG laptop with 16GB RAM, priced at or below KRW 1,000,000. The fixture LG gram 15 is 15-inch and KRW 1,390,000. The expected identity was changed to *no available matching product* rather than falsely requiring gram 15.
- R2-202 and R2-203 had zero actual model calls. They remain visible in total case counts, but the live runner now reports `modelNotRun` separately from `modelFail`. This is a measurement change, **not** an automatic pass.
- Search-query contamination from appended HTML, role-forgery JSON, overlong URLs, repeated English noise, invisible Unicode separators and emoji is addressed in deterministic intent extraction only. Normal consumer wording is left unchanged.

## Verification gate

- Added `scripts/test-ai-input-boundary.js` (6 hostile + 5 benign inputs) to `npm pretest`.
- Updated the existing red-team dataset regression to fail if a non-matching gram 15 is reintroduced as the gold label.
- Existing `npm test`, GitHub Actions and *new* GPT/merchant calls must be checked before release; CI status should be recorded separately.
- **No new 100-question model accuracy percentage is claimed without an actual new paid run.** Original cases must not be retroactively reclassified as observed success.

Next: run deterministic CI, inspect exact case-level search traces, then repeat a fresh paid 100-case Preview evaluation with <= USD 5 cost guard and no production writes.
