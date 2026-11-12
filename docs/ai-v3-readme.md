# 서사 AI v3 — independent proof-of-concept

- Branch: `feat/ai-v3-clean-20261104` (based on Production baseline 718fe7f).
- Endpoint: `POST /api/ai?v=3`, dispatched to `api/_ai-v3-route.js` in Preview only. Normal `/api/ai` is unchanged. This reuses the existing function slot to respect the Vercel Hobby 12-function limit.
- Default: **OFF**, even on Vercel. Explicitly set `ENABLE_AI_V3=1` in a protected Preview environment only.
- No changes to collectors, databases, affiliate-link builders, 5,000-question runner or existing AI.
- Offline tests: `node scripts/test-ai-v3.js`. Previous protected Preview online tests are documented in `docs/ai-v3-preview-smoke-2026-11-04.md`. Do not equate those results with a full live accuracy benchmark.

## Design

1. OpenAI Responses API strict `search_products` function call extracts category, keyword, budget and merchant rules.
2. Server reads the `products` DB table (`select` only). Exact-title queries are followed by bounded, partial-keyword/title retrieval when word order differs. Relevance favors matching title evidence. When `SEOSA_DB_READONLY=1`, a DB miss returns no items rather than calling remote merchants whose global quota leases require write RPCs. Outside read-only mode, a DB miss may use the existing seller-search adapters.
3. The server sanitizes listings and checks type, merchant, used/accessory status, exclusions, and budget. Where delivery is unknown, a listing-price-under-budget candidate is **provisional**, never called a verified all-in purchase price.
4. For comparisons, each named product is checked separately and receives an equal share of candidates. The model can select only IDs provided by the server.
5. The server builds all factual card claims from product records. It can summarize actual displayed-price differences, but must warn when shipping is unknown or generations/options differ. No model-generated price or model name reaches the UI.
6. GPT calls and token usage are counted in the Preview response; exact API charges require independent pricing/account verification.

**Current limitations:** no storefront integration, no server-side conversation persistence (client may return bounded state and short history), no full feature parity, no independent live merchant QA, incomplete category taxonomy and delivery-cost coverage. If shipping costs are missing and a total-budget limit is given, candidates are deliberately held back rather than marked as compliant. A clean structured interface is not itself proof of superior recommendation quality.

## Example request

```json
{
  "message": "80만 원 이하 사무용 노트북 추천해 줘",
  "history": [],
  "state": {}
}
```

The reply contains `answer`, `cards`, `state`, and `stats`. Send `state` back on the next request. Product data in `state` must not be trusted.

## Model configuration (protected Preview only)

- `ENABLE_AI_V3=1`
- `OPENAI_API_KEY=<secret stored in Vercel env>`
- `AI_V3_MODEL=<verified Responses API model supporting function calling and structured output>`

For a current model selection, confirm compatibility and price on the official OpenAI documentation. Do not put keys in the repo. The endpoint has a minimal in-memory rate limit, **not** global quota enforcement; before any public release, add persistent authentication, shared rate limiting, usage cost caps and telemetry. Obtain permission before paid requests.

## Release gates

Offline unit tests → mock end-to-end → protected Preview GPT + provider real requests → independent holdout set (not just historical FAILs) → old-v3 online A/B against the same questions → user-approved rollout only. Preserve all original 5,000-question baseline records.

## Product identity and evidence gate (v3 iteration)

- A separate pure module `api/_ai-v3-identity.js` now extracts **explicitly user-specified** model family, number/series, variant, generation, storage, RAM, screen size, chip and network type.
- Only attributes present in the customer's utterance or the bounded conversation state become mandatory. The LLM-generated query itself does **not** create a new model requirement.
- Candidates with conflicting or absent evidence are excluded, with separate `identity_mismatch` and `identity_unverified` counts. No product ID can be introduced by the LLM.
- Seller-title evidence is exposed as `titleEvidence`, with `specEvidenceSource=seller_listing_title_only`; this is **not a verified manufacturer specification database**.
- Comparison text can cite fields common to both seller titles, and expressly declines ungrounded performance claims.
- `scripts/test-ai-v3-identity.js` tests independent examples including user model changes and unknown/mismatched attributes.

**Important limitations:** Filter precision is intentionally prioritized over recall. Short or incomplete seller titles can yield no recommendation even when the merchandise is actually compatible. No authoritative technical-spec verification or availability confirmation exists yet; customer-facing language must not claim otherwise. Before release, strengthen manufacturer/GTIN/vendor-item identity and review seller-title parsing across many unseen categories.
