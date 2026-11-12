# SEOSA AI v3.3 — 2026-11-12 retrieval/feedback engineering sprint

## Goal and scope
Increase **real strict PASS_ONLY** recommendation success while maintaining product safety and verifiable evidence. This is a local code-change sprint in the isolated worktree `C:\Users\yugeo\seosa-v33-audit-20261112` on branch `audit/ai-v33-20261112`. Production and GitHub PR #230 were **not changed or merged**.

## Architecture
```
User question + conversation state
  -> existing OpenAI planning / v3.3 core (not replaced)
  -> searchCatalog(query, exact identity, category, budget)
      -> opt-in live-first seller search (provider quota safety remains unchanged)
      -> Neon Postgres read-only catalog, latest-first / bounded facets
      -> candidate identity, price, shipping, provenance validation
  -> decision + grounded cards + stats.retrieval (live-first and DB-first)
  -> offline sanitized evidence + independent reviewed oracle
      -> FAIL/UNVERIFIED queue -> tested source patch -> new frozen holdout
      -> manual rollout approval only
```

## Implemented, real files
- `api/_ai-v3-catalog.js`: initial title, conjunctive and bounded-price DB reads now order `collected_at` DESC before SQL `LIMIT 40` where supported. The original broad page could fill with older products before fresh matches. For `loadProductsByIds`, latest-first query and first-wins same SKU select the newest record rather than silently selecting the oldest duplicate on displayed-card follow-ups.
- `api/_ai-v3-catalog.js` + `api/_ai-v3-core.js`: DB-first retrieval now returns privacy-safe `_retrieval` counters and real `_queries` even for read-only empty results; core aggregates DB-first/live-first provenance with true strategy, source counts and queries. No LLM claims about fresh price added.
- `scripts/test-ai-v33-improvement-20261112.js`: direct fake-DB tests and property checks for latest rows, duplicate SKU, budget, shipping, stale source and provenance.
- `scripts/ai-v33-eval/feedback-evidence.js`: fail-closed, independent-grade-only verdicts. Drop raw user query, answer, card titles/IDs from exported evidence. Keep enumerated source counts, rejection codes, token counts, p95 and metered costs only. No auto-training, autonomous production writes, or secret leak.
- `scripts/ai-v33-eval/feedback-report.js`: offline JSONL evidence import and optional review labels. Supports `--responses`, `--reviews` and `--output`, generates strict PASS_ONLY, review queue, p95, known/unknown costs.
- `scripts/test-ai-v33-feedback-20261112.js`: privacy, oracle integrity, UNVERIFIED and strict-rate properties.
- `package.json` + `package-lock.json`: `fast-check@4.8.0` (MIT open source: https://github.com/dubzzz/fast-check) and `npm run test:ai-v33-improvement`.
- `.github/workflows/ai-v33-improvement.yml`: bounded offline regression CI. Not yet run on GitHub since this branch is local.
- `reports/ai-v33-improvement-20261112/read-only-evidence-summary.json`: sanitized 10-case demonstration from previously captured read-only results. Because no separately supplied reviewed grade file exists, **all 10 are UNVERIFIED in this new pipeline**, not new algorithmic failures. Historical originally graded results are unchanged.

## Verified offline baseline and after
Before changes on the working branch: v3.3 live-first supplier contract **20/20** + full-engine **5/5**.
After changes: new improvement **6/6** plus 200 generated fast-check inputs, feedback **5/5** plus 100 generated inputs; existing live-first **20/20**, full-engine **5/5**, v3.1 engine **62/62**, v3.2 root-cause **26/26**, no-result evidence **12/12**. Total **136 passed named cases + 300 generated checks**, all simulated/local. No new paid LLM or merchant calls. Full `npm test` also finished with **exit code 0**, ~15,616 console lines, and additional offline mock-LLM suites including 1,000 cases and 3,600 layered checks. These large mock counts are NOT independent online PASS_ONLY evidence.
Run: `npm run test:ai-v33-improvement`.
Import: `node scripts/ai-v33-eval/feedback-report.js --responses reports/ai-v33-readonly-preview-20261110/smoke10-2558604-sanitized.jsonl --output reports/ai-v33-improvement-20261112/read-only-evidence-summary.json`.
Optional reviews file: one JSONL object per case such as `{"id":"N011","reviewed":true,"verdict":"FAIL","reason":"wrong_model"}` but labels MUST come from independent human-reviewed evidence. Never infer PASS from HTTP 200, card count, or AI self-assessment.

## What this DOES NOT prove
- It does not prove more online matches, a new PASS_ONLY uplift, accurate stock, total checkout cost, or actual Coupang/ADPICK live-first success. The 2026-11-10 reused 50-question read-only regression remained **29 PASS / 1 FAIL / 20 UNVERIFIED = 58% strict**, and was a contaminated/reused sample, not independent launch proof.
- The v3.3 seller API route still cannot safely run in existing DB-read-only preview, because quota leases/cache need isolated writable state; no bypass was made.
- `pgvector` (https://github.com/pgvector/pgvector) was reviewed but **not installed**: Neon extension and isolated schema/resources unverified. Do not mutate production DB or make embedding calls for this.
- `promptfoo` (https://github.com/promptfoo/promptfoo) was reviewed but not installed because existing independent evaluation machinery is already in the repository; adding a second evaluator without a stable oracle would not itself improve actual recommendation quality.
- New `ORDER BY collected_at` patterns require isolated EXPLAIN/index and p95 benchmarking before launch. If slow, add measured index or rework the query safely, not deploy blindly.
- No database migrations, env/secrets changes, external provider searches, GitHub push, PR merge, or production deployment in this sprint.
- Claude Code CLI 2.1.306 was found, but its local OAuth session had expired; these changes were authored directly through Desktop Commander.

## Next release gates
1. Run full `npm test`, syntax, GitHub CI; repair verified regressions in this branch.
2. Use an isolated writable provider quota-lease/cache DB and bounded, authorized seller credentials for live-first API tests.
3. Freeze **new** independent holdout and grade via reviewer/DB oracle; do not change labels after seeing results. Count UNVERIFIED as non-PASS.
4. Compare DB-first/live-first paired questions: PASS_ONLY, exact model and card errors, zero-results, source freshness, p50/p95, provider requests/quota, GPT tokens, shipping and actual billed dollars.
5. Manual review and controlled rollout only if strict quality increases without wrong-card regressions, then have a rollback plan.
