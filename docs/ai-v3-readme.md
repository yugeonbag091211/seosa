# 서사 AI v3 — independent proof-of-concept

- Branch: `feat/ai-v3-clean-20261104` (based on Production baseline 718fe7f).
- Endpoint: `POST /api/ai-v3`. Not connected to the storefront UI or the existing `/api/ai`.
- Default: **OFF**, even on Vercel. Explicitly set `ENABLE_AI_V3=1` in a protected Preview environment only.
- No changes to collectors, databases, affiliate-link builders, 5,000-question runner or existing AI.
- Network tests were NOT executed; use `node scripts/test-ai-v3.js` for isolated mock tests.

## Design

1. OpenAI Responses API strict `search_products` function call extracts category, keyword, budget and merchant rules.
2. Server reads the existing `products` DB table first through the Supabase/Neon adapter (`select` only). When no catalog rows match, it falls back to `searchAll` on Coupang/ADPICK (without calling saveProducts).
3. Server sanitizes listings, checks type, merchant, budget including *known* shipping and exclusion.
4. OpenAI is allowed only to choose the IDs supplied by the server.
5. The server creates the answer and cards from the selected verified list. Model-generated factual listing text is never displayed.

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
