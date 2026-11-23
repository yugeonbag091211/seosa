# SEOSA Search Engine 2.1 — Sold-object / query-relative beta

Date: 2026-11-23.
Branch: codex/search21-sold-object-20261123.
Base commit: b5cf006.

**Status: locally implemented and tested; NOT deployed.**
No Production update, GitHub push/PR, Neon write, paid AI, or merchant API request occurred during this development.

## Goal and design

The initial Search2 MiniSearch text reranker could not distinguish a
MacBook Air M4 (computer) from MacBook Air M4 screen protectors,
a coffee machine from an instructional book, a monitor from a lamp,
or an actual power bank from a Wi-Fi rental bundled with one.

Search2.1 introduces ONE query-relative sold-object stage rather than
adding merchant- or brand-specific overrides or another multiplicative score.

1. Detect the kind of product requested, including explicit accessory intent.
2. Inspect the merchant title for sold-object evidence, host/compatibility
   wording, bundled items, and ordinary feature modifiers.
3. Rank confirmed wanted objects before unknowns, and confirmed other objects
   and services last. Do not delete any candidate.
4. If the corpus has no high-confidence wanted object, retain the original
   order. Within groups, preserve legacy relevance deciles and use MiniSearch
   only for text tie-breaking.

## Code

- api/_search2-object-relation.js: small commercial sold-object vocabulary
  and conservative relation evidence.
- api/_search21.js: read-only pure reranker, preserving all original objects,
  affiliate links, prices, counts, and model fields.
- api/search.js: explicit opt-in engine=mini21; existing default and
  engine=mini are unchanged, and beta cache is isolated.
- public/search2.html: optional v=21 page state for Search2.1 plus
  stale-price and partial-results warnings for both beta modes.
- scripts/test-search21-sold-object.js: direct 63-case contracts.
- scripts/test-search2-handler.js: default, mini, mini21, unknown-option
  integration tests against stubbed DB/vendor interfaces.
- scripts/search21/fixtures/captured-20261123-public-search-top10.json:
  20 queries from previous Production snapshots; public product titles,
  no customer data or affiliate URLs.
- scripts/search21-audit-captured.js: local development comparison.
- scripts/search21-preview.js: 127.0.0.1:17823 read-only comparison UI.
- scripts/search21-consumed-gold-dev-audit.js: optional historical
  A-F checks; requires SEOSA_STAGE2_LABEL_DIR.

## Verified offline

- 63/63 Search2.1 sold-object tests PASS.
- 13/13 existing Search2 canary tests PASS.
- API handler tests PASS for default, original beta, new beta, and
  unknown option. No extra DB writes, links/prices/IDs unchanged.
- Existing search dev redteam: 2,311/2,311 PASS.
- Affiliate integrity: 69/69 PASS.
- Search provenance handler: 10/10 PASS.
- Historical already-consumed Stage2 A-F labels: 1,549 clear cases;
  across 12 mapped types, 391 known gold MAIN, 366 recognized as
  wanted, 25 unknown, **0 incorrectly sent to incompatible**.
  Development-only and NOT a new independent holdout result.
- Twenty captured Production TOP-10 sets: 20/20 candidate preservation.
  Development-only heuristic wrong-object proxy count in top 3: 5 to 1,
  in top 5: 6 to 3. This proxy uses the same classifier to define wrong
  objects and MUST NOT be presented as real accuracy.
- Warm rerank of 10 candidates: p50 approx 0.224ms, p95 0.475ms,
  p99 0.709ms; in-process only, NOT API response latency.

## Reproduce safely

From this isolated worktree:

    npm ci --ignore-scripts --no-audit --no-fund
    node scripts/test-search21-sold-object.js
    node scripts/test-search2-canary.js
    node scripts/test-search2-handler.js
    npm run test:search
    node scripts/test-affiliate-integrity.js
    node scripts/search21-audit-captured.js
    node scripts/search21-preview.js

Visit on the connected PC: http://127.0.0.1:17823/
The page is offline only; it does not make merchant requests.

## Remaining issues and release gates

1. Retrieval is still insufficient. The sampled MacBook M4 top 10
   had only two real laptop listings and eight accessory listings.
   Reranking puts laptops first but cannot find absent laptops.
2. The current API has no reliably sourced merchant category metadata;
   title-only evidence has limits and needs review of uncertain matches.
3. Independent fresh human-reviewed type+relation accuracy, VERIFIED
   precision, MAIN-dangerous mistakes, top-10 quality, end-to-end
   latency, cache/rate limits and affiliate integrity remain required.
4. Production continues to run the old default and the Search2.0 beta.
   First test a Search2.1 Preview deployment, then only with approval
   release opt-in mini21, leaving the default untouched. A default
   replacement requires a separate explicit decision.

**No Stage2 acceptance gate has been passed by this work.**
