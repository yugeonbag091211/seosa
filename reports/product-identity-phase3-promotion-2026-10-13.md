# Product Identity Phase 3 — High-confidence Promotion (2026-10-13)

## Scope and starting state

Phase 1 and Phase 2 were present on `main` at `232af2d35163f7b1b64f3c2ef12c3eb3f623b574` (Phase 2 PR #135). Work started on the existing `codex/product-identity-phase3` checkout with a clean tree. No existing edits or untracked files were present. The work keeps Phase 3 manual and adds no search, AI, product-detail, price, hot-deal, collector, mobile, or UI consumer.

## Existing pipeline audit

Phase 3 reuses `api/_offeridentity.js` parsing, context-aware pair matching, clustering, and the Phase 2 shadow snapshot. Shadow membership is evidence only; each candidate is reparsed from current `products` rows and all member pairs are checked again with the current matcher. `verifyGroups` also remains the Phase 2 all-pairs invariant.

The real `identity_shadow_runs.id=1` is completed with 100 parsed offers, one two-member group, one MATCH pair, zero all-pairs violations, and zero errors. Both members are the same displayed merchant (Coupang), so the real group is `REJECT_NOT_CROSS_MERCHANT`; its Tier B titles also omit the explicit manufacturer model code from one member. The promotion test pins both the actual cross-merchant rejection and the separate missing-model HOLD case.

## Schema and DB safety

Two additive migrations were applied to the production project:

- `supabase/2026-10-13-identity-promotion.sql` creates the canonical group, member, and promotion audit tables.
- `supabase/2026-10-13-identity-promotion-indexes.sql` indexes the Phase 3 foreign-key lookups reported by the Supabase performance advisor.

The schema has RLS enabled, no `anon` or `authenticated` table/sequence privileges, and the required `service_role` privileges. No policies are intentional for this server-only pattern; the security advisor reports the three new tables as “RLS enabled, no policy” at INFO level. After both migrations, all three canonical tables contained zero rows. Supabase confirmed the three foreign-key indexes exist; no new unindexed-foreign-key finding remains.

At the pre-migration and immediate post-schema snapshots, `products=71,207` and `price_history=273,254`; the schema migration changed neither. At the end of the longer read-only catalog evaluation, `products` remained 71,207 and `price_history` was 273,475, an increase of 221 during the observation window. This increase is consistent with concurrent normal collection, but the exact cause was not traced. The Phase 3 evaluator is read-only and both migrations contain no production-table DML. The canonical tables still had 0 groups, 0 members, and 0 audit rows.

## Promotion contract

Decisions are `PROMOTE`, `HOLD`, or `REJECT`. Only completed runs are eligible. The default write path is off; a production write requires both `IDENTITY_PROMOTION_ENABLED=true` and `--write`, plus a fixed `--run-id` and `--max-promotions` cap. The runner defaults to read-only and has no scheduled workflow.

- **Tier A:** exact common GTIN or exact common manufacturer model number, with every pair MATCH and no hard conflict.
- **Tier B:** every member needs the same explicit brand, family words, and model anchor. Generation-only anchors and multi-model listings are held. Exact model-number evidence upgrades the group to Tier A.
- **Missing attributes:** one-sided model number, model, variant, storage, memory, color, quantity, condition, region, year, or size evidence produces HOLD. Partial model numbers also remain HOLD.
- **Cross-merchant:** a group must have at least two distinct displayed merchants. Same-merchant groups are rejected for promotion.
- **Canonical key:** SHA-256 over deterministic normalized known identity fields; unknown values are omitted.
- **Existing groups:** all old and new member pairs are rechecked. A hard conflict suspends the existing group and keeps every member for audit. A no-match, incomplete snapshot, or unverified write also fails closed.
- **Audit ordering:** the candidate stays SUSPENDED until its members are verified and the PROMOTE audit row is written successfully. An audit write failure leaves the group SUSPENDED for idempotent retry.

## Full catalog evaluation

A read-only SQL stream of the current 71,207 `products` rows was evaluated locally through the Phase 1 clustering and Phase 3 promotion gate. No product titles or product IDs are retained in this report. All 71,207 rows parsed; parse failures were 0.

| Phase 2 re-evaluation | Count |
|---|---:|
| All groups | 70,736 |
| Multi-offer groups | 406 |
| Cross-displayed-merchant groups | 294 |
| Same-displayed-merchant groups | 112 |
| MATCH / REVIEW / NO_MATCH pairs | 542 / 3,765 / 78,223 |
| All-pairs violations | **0** |

| Phase 3 decision | Count |
|---|---:|
| PROMOTE | 167 |
| HOLD | 127 |
| REJECT | 112 |
| Tier A / Tier B groups | 217 / 189 |
| Missing-model HOLD | 5 |
| Missing-storage / missing-variant HOLD | 0 / 0 |
| Hard-conflict REJECT | 0 |

The prior Phase 2 report recorded 403 multi-offer and 291 cross-merchant groups for its earlier catalog snapshot. The current read produced 406 and 294 with the same 71,207 row count. The catalog can change in place without changing row count, so this report uses only the current evaluation and does not treat the prior figures as current Phase 3 results.

## Manual audit and adversarial validation

All 167 current PROMOTE candidates were eligible for review; the deterministic 100-group sample (60% of candidates) was manually inspected by title, displayed merchant, model/model number, variant, storage, color, quantity, condition, transaction type, evidence, and promotion reason. Observed false positives: **0/100**. The raw audit sample was temporary and is not included in the repository.

The Phase 3 negative suite rechecks accessory vs product, iPhone Pro/Pro Max and storage, Galaxy Buds standard/Pro, MX Master 3/3S, Dyson V15/Detect, quantity, new/used, purchase/rental, and genuine/compatible/OEM/replica cases. Bridge-poisoning and non-transitive pair fixtures verify every pair. Cluster-poisoning keeps the existing canonical member set intact and suspends on hard conflict or missing current products.

Five temporary policy mutations were tested and removed: missing-model gate, storage gate, cross-merchant gate, all-pairs loop, and hard-conflict collection. All five were killed by their intended tests. No mutant file remains.

## Idempotency, suspension, and consumers

The fake-PostgREST write test creates 1 group / 2 members / 1 audit row, then reruns with the same totals. An audit-write failure leaves the new group SUSPENDED and retains its members. Existing conflict and missing-member tests retain all member rows while suspending and recording the reason. Repository-wide consumer-zero tests allow only schema, maintenance scripts, migration verification, tests, and this report to name the canonical tables.

## Validation status

- `npm test`: passed (exit 0). The full repository test chain, including its AI, intent, search, identity, and adversarial suites, completed.
- `npm run test:release`: 120 PASS / 0 FAIL.
- `npm run test:all`: passed (exit 0), including the full test chain, regression suite, and release suite.
- `npm run test:regression`: 85 PASS / 0 FAIL. Its first sandbox-only attempt blocked localhost mock-server fetches (`EACCES`); rerunning with loopback access passed all Y2/R2 cases.
- `npm run test:search`: intent regression 151/151 PASS; dev red-team 2,311/2,311 PASS, 0 FAIL.
- `npm run test:identity-shadow`: 119 PASS / 0 FAIL.
- `npm run test:identity-promotion`: 73 PASS / 0 FAIL; all five intended policy mutations were killed by their tests and removed.
- `npm run verify:migrations`: 77 OK / 0 FAIL / 1 warning. The warning is that this checkout has no local Supabase credentials, so the optional live schema probe was skipped; static additive-migration checks passed.

No dedicated `lint`, `build`, or `typecheck` script is defined in `package.json`. The ordinary CLI production `--dry-run --run-id 1 --explain` could not connect because this checkout has no local `SUPABASE_URL` or `SUPABASE_SECRET_KEY`; the production-linked dry-run runner and capped live write path therefore remain unverified. The completed full-catalog evaluation above used the authorized read-only Supabase connector and the local pure matcher. No Phase 3 canonical row was written to production.

## Activation and rollback

After a completed shadow run is available, run a pinned dry-run first:

```bash
npm run identity:promotion -- --dry-run --run-id <completed-run-id> --explain
```

Only after review, use a small cap and an explicit opt-in for a manual write:

```bash
IDENTITY_PROMOTION_ENABLED=true npm run identity:promotion -- --write --run-id <completed-run-id> --max-promotions 1
```

Disable writes by removing or setting `IDENTITY_PROMOTION_ENABLED=false`. No consumer depends on these tables, so this stops Phase 3 writes immediately. Keep the tables and audit rows for traceability; this work adds no destructive rollback SQL.

## Readiness

The promotion policy, migrations, full catalog evaluation, 100-group audit, consumer-zero check, and offline write/idempotency tests are complete. Merge readiness is blocked until the production-linked CLI dry-run and a capped live writer verification can run with an authorized local Supabase environment. No live candidate was written because the saved production run 1 has no cross-merchant candidate.
