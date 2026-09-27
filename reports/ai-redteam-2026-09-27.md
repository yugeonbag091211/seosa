# SEOSA AI Red-Team — 2026-09-27

## Execution environment and boundaries
- Branch: `test/ai-redteam-150-20260927`; draft PR #107.
- Execution: GitHub Actions "Tests" on the isolated PR branch, Node.js 22, no repository secrets.
- Tests were run against actual production JavaScript modules and the real `api/ai.js` handler; outside dependencies (LLM, affiliate search, Supabase persistence, authentication) were mocked. No requests to the production website, Coupang, ADPICK, or production Supabase were made.
- Genuine model completions: **0**; paid model spend: **$0**; actual affiliate API calls: **0**. The 15 handler cases used adversarial simulated model text, not real model behavior.

## Baseline, before fixes
Workflow: https://github.com/yugeonbag091211/seosa/actions/runs/36317194308 (failed deliberately by newly added red-team assertions)

| Test group (15 cases each) | Baseline PASS | Baseline FAIL |
| --- | ---: | ---: |
| Tampered percentage discounts | 0 | 15 |
| Negative and unsafe price inputs | 4 | 11 |
| Seller-title delimiter injection | 15 | 0 |
| Malformed historical dates | 15 | 0 |
| Malicious URLs in model output | 15 | 0 |
| Unsupported invented prices | 15 | 0 |
| Oversized seller-controlled text | 15 | 0 |
| Nonfinite / malformed numbers | 15 | 0 |
| Malformed product context | 15 | 0 |
| Full-handler simulated false-price replies | 15 | 0 |
| **Total** | **124** | **26** |

### Confirmed defect A: client-supplied discount percent overrides arithmetic
- Path: `api/ai.js` `normItem()`; reproducer: `{price:20000,listPrice:40000,discountPct:99}` accepted **99%** even though listed prices imply **50%**.
- Potential effect: manipulated or inconsistent context can mislead a buyer about the actual discount.
- Fix: derive the percentage only from normalized current price and comparison/list price; ignore externally supplied conflicting percentage.
- 15/15 attack variants reproduced before the fix and passed afterward.

### Confirmed defect B: negative or unsafe client-supplied prices
- Path: `api/ai.js` `normItem()`; reproducer: `{title:'테스트',price:-100000}` yielded a negative candidate price; very large negative numbers also escaped safe-integer validation.
- Potential effect: nonphysical prices enter candidate ranking and textual context.
- Fix: invalid, negative, and unsafe price inputs normalize to zero. No broader refactor of price collection.
- 11/15 variants reproduced before the fix, and all 15 passed afterward.

## Verified after fixes
Workflow: https://github.com/yugeonbag091211/seosa/actions/runs/36317242325 — **SUCCESS**.
- New offline matrix: **150 PASS / 0 FAIL**, ten categories of 15 tests each.
- Full existing `npm test` chain also passed in the same CI run. This includes `scripts/test-ai-redteam.js`, `scripts/test-ai-pipeline.js`, and `scripts/eval-adversarial.js`.
- 15 full-handler tests injected false current prices into a simulated upstream model reply and verified that the shipped grounding layer removed the unsupported prices and retained genuine product cards.
- Production application, existing main branch, pricing collector, affiliate links, billing, UI, and hot-deal engine remained untouched.

## Coverage boundaries / residual risk
1. **No real-LLM security assertion.** In CI, a stub produced deliberately malicious replies. Passing the grounding handler tests does not establish that an actual LLM resists prompt injection. Ten real-model probes were not run because no explicit free-only test credentials or isolated paid-cost approval were available in this CI environment.
2. **Client context provenance.** `normItem()` still accepts client-supplied candidate prices and allowlisted trust metadata, which may be forged by a malicious HTTP client. Fixing this properly requires server-side authoritative revalidation of product identity/price/trust before presenting claims as verified; do not assume price sanitization establishes authenticity.
3. **Option identity and changing product IDs.** The new 150-case matrix does not directly exercise `vendorItemId` end-to-end; existing `test-option-identity.js` and collection regression tests cover separate collectors. A dedicated end-to-end AI option-swap test remains to be built.
4. **Authentication, cost, and provider failures.** Existing `test-ai-redteam.js` exercises simulated 401/402/429/5xx responses, timeouts, high concurrency, request floods, and input size limits, not real externally supplied responses.
5. **Mocked dependencies.** No production Supabase writes, live API usage or live account-limit behavior was tested.

## Files changed
- `scripts/test-ai-redteam-150.js`: 150 completely offline adversarial test variants.
- `api/ai.js`: isolated fixes to client-facing price and discount normalization.
- `package.json`: run the new matrix as part of normal PR tests.
- `reports/ai-redteam-2026-09-27.md`: reproducible evidence and boundary statement.

No deployment or merge authorized by this PR.
