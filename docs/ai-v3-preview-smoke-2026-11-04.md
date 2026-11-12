# 서사 AI v3 — 보호된 Preview 실측 기록 (2026-11-04)

## 실행 조건
- Branch commit: `321aa4dae9253351eb9555d64fcacf149b0aaece`.
- Vercel deployment: `dpl_DAZiPXef2P7kckczHSwNLi13tN53` (READY, Preview).
- API: `POST /api/ai?v=3` via authenticated Vercel CLI.
- Preview branch variables: `ENABLE_AI_V3=1`, `SEOSA_DB_READONLY=1`, `AI_V3_MODEL=gpt-4.1-mini`.
- Existing Production: `dpl_A8C4e4kDvj8a5i887iCVusr55Tr4`, commit `718fe7f` (unchanged).
- Client requests: 3 v3 prompts, 1 legacy Preview prompt. GPT/merchant token usage/cost was NOT measured.

## Actual online responses

| Request | HTTP / API | Raw fetched | Validator accepted | Cards | Assessment |
| --- | --- | ---: | ---: | ---: | --- |
| 아이패드 추천해줘 | 200 / 200 | 40 | 12 | 4 | Technical success, but high-price and second-hand listings included, price freshness uncertain |
| 80만원 이하 사무용 노트북 추천해줘. 게이밍 제외 | 200 / 200 | 13 | 0 | 0 | Fail-closed/no useful recommendation; unknown delivery totals are currently excluded by budget gate |
| 아이패드와 갤럭시탭 비교해줘 | 200 / 200 | 80 | 15 | 4 | At least two brands shown; answer is generic and does not meaningfully compare specifications |

**Measurement caveat:** `stats.inspected` counts all fetched rows; the current `validateCandidates` examines at most 48 rows when there are multiple query buckets, so 80/15 is not a complete 80-item judgment. Do not treat it as an accuracy rate.

## Existing AI comparison (not a fair accuracy A/B)

Calling the legacy `POST /api/ai` on the same Preview with `question: "아이패드 추천해줘"` returned a degraded response with `verify.search="failed"`, `dbRpcBlocked=2`; product search was blocked by the read-only Preview safety environment. Therefore an end-to-end old-v3 accuracy comparison was **not achieved**. This should not be characterized as the old Production AI failing that question.

## Action items
1. Surface actual reject reason counts in Preview-only debug metrics (do not leak internal data to users).
2. Correct validated-count accounting and balance comparison candidates from both query buckets.
3. Resolve missing/unknown shipping-cost representation without inventing free shipping; use explicit merchant evidence only.
4. Generate a *useful, grounded* comparison answer instead of a generic static acknowledgment, while keeping card/price claims server-authored.
5. Test conversation follow-ups in live Preview, and evaluate with fresh unseen holdouts as well as historical failures.
6. Instrument actual model usage, token cost and provider calls with a strict budget before broader evaluation.
7. Use equivalent production-safe conditions for A/B. No Production deployment before review/approval.

## Offline coverage
The pre-Preview offline suite completed 21/21. These are mock and unit tests, **not** a measure of real recommendation accuracy.
