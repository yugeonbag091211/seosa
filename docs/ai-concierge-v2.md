# AI Concierge v2 — GPT 중심 쇼핑 에이전트

2026-10-18 · 기본값 **꺼짐** (`AI_CONCIERGE_V2_ENABLED` 미설정 = 기존 v1 그대로)

## 왜

v1 은 코드가 검색·랭킹·결정(`_decision`)을 끝내고 GPT 는 그 결론을 문장으로 옮겼다. 검증에 하나라도 걸리면 GPT 답 전체를 결정론 문장으로 바꿨다. 오프라인 재현(같은 코드, 모델 응답만 대역)으로 확인한 실패:

| 질문 | v1 에서 일어나는 일 | 원인 |
|---|---|---|
| 성능좋고 가장 가성비인 노트북 최저가 | `priority: "price"` 하나만 남고 "성능"이 사라진다 | `_shopintent.parseConstraints` 의 PRIORITY_RE 첫 일치 |
| (추천 직후) 지금 사는 게 좋을까? | "지금 조건에 맞는 상품을 찾지 못했어요." · degraded | 지식 질문(B)으로 분류 → 상품 0 → `noCatalog`. 상품이 있어도 `unsupportedPriceDecision` 이 «지금 사도» 같은 문장을 근거와 무관하게 항상 실패로 친다 |
| 두 번째 거 지금 사도 돼? | 쿠팡에 "번째" 를 검색 | 기억은 1위 하나(air2)뿐, 정규식이 "번째"를 검색어로 뽑음 |

## 구조

```
사용자 질문
  → api/ai.js (인증·레이트리밋·입력 상한 — 기존 그대로)
  → 플래그 on? ── no ─→ v1 (변경 없음)
        │ yes
  → api/_agent.js
      1. 서명 기억(aim1) + 화면 상품 → 서버 카탈로그로 다시 확인 → R01·O01·V01
      2. OpenAI Responses API + function calling (최대 4 라운드, store:false)
           search_products · get_product_details · get_price_history · compare_products
           (api/_agenttools.js — 기존 _shop.searchAll · loadStats · _deal · canonical 재사용)
      3. GPT 가 비교·판단 → JSON { answer, product_ids, primary_id, followups }
      4. 검증(api/_agentverify.js) → 문제 있으면 1회 재작성 → 남으면 문장 단위 제거 → 그래도 안 되면 확인된 사실만의 안전한 답
      5. 카드 = GPT 가 고른 ID → 서버 레지스트리의 검증된 행 → 기존 toCard (가격·이미지·제휴 링크 전부 서버 값)
      6. 응답 = v1 과 같은 필드 + engine:'v2'. 기억 토큰은 topRecommendationRef 로 (웹·앱 수정 없음)
```

- 결정론 점수로 1위를 정하지 않는다. 검색 결과 순서는 공급자 관련도 그대로이고, 부속·조건 밖 상품만 뒤로 보내며 표시한다.
- 모델은 상품을 이번 요청의 레지스트리 ID 로만 가리킨다. 레지스트리에 없는 ID 는 카드가 되지 않는다.
- 상품명은 판매자 데이터로 다룬다 — 지시문 구간 제거(`displayTitle`) + 경고, 답변에 옮기면 검증에서 잡힌다.
- OpenAI 400(요청 형식)·시간 초과는 v1 의 OpenAI 쿨다운을 걸지 않는다. 인증·쿼터·5xx 는 같이 쓴다.
- 뉴스·SEOSA 분석 질문, OpenAI 키 없음·쿨다운, 첫 3.5초 안의 실패는 v1 이 이어받는다.

## 켜기 · 끄기 · 되돌리기

| 설정 | 동작 |
|---|---|
| `AI_CONCIERGE_V2_ENABLED` 미설정 | v1. 단 Production 이 아닌 배포에서 요청 헤더 `x-seosa-ai-engine: v2` 가 있으면 그 요청만 v2 |
| `AI_CONCIERGE_V2_ENABLED=1` | 모든 요청 v2 |
| `AI_CONCIERGE_V2_ENABLED=0` | 강제 v1 (헤더도 무시 — 킬 스위치) |

되돌리기는 환경변수만 바꾸면 된다. 데이터·스키마 변경 없음.

선택 조정: `AI_V2_MODEL`(기본 `OPENAI_MODEL`), `AI_V2_REASONING_EFFORT`(기본: Luna 는 `none`), `AI_V2_BUDGET_MS`(26000), `AI_V2_ROUND_TIMEOUT_MS`(12000),
`AI_V2_ANSWER_RESERVE_MS`(9000 — 검색 뒤 최종 답변 몫), `AI_V2_REWRITE_MIN_MS`(6500 — 이보다 적게 남으면 재작성 대신 문장 걷기),
`AI_V2_MAX_OUTPUT_TOKENS`(900), `AI_V2_FINAL_ROUND_TIMEOUT_MS`(16000 — 도구 결과가 실린 뒤 차례). 전부 범위 밖 값은 무시하고 기본값을 쓴다.

## 2026-10-19 Preview 실측(gpt-5.1)으로 고친 것

| 증상 (실측) | 원인 | 고침 |
|---|---|---|
| "100만원 이하 … 3개" 에 102.9만·112.8만 원 카드 | ① AI 검색이 같은 쿠팡 호출의 10건 중 6건만 읽음 ② 검색 1회 ③ v2 검증기에 예산 검사 없음 | 10건 읽기(호출 수 같음) · 예산·사양 조건이면 첫 차례에 검색어 2개 병렬 · 예산 안 후보가 모자라면 `coverage` 로 다시 찾으라고 알림 · 예산 초과 카드·«예산 안» 오언급 검사(`over_budget`) |
| price·spec 오류 → 재작성 → 그래도 걸려 문장 삭제 | 검증기 오탐 다수(예산 올리기 제안, 예산 대비 차액, "(+99,000원)", 날짜 "19만", 지켜볼 기준가, "램8G", 39.6cm↔15.6인치, 그램15, 질문·가정 문장, 인용 부정 …) + 재작성 지시가 값만 주고 문장을 안 짚음 | 각 오탐을 실측 문장으로 고정([E1]·[E8]) — 같은 꼴의 틀린 값은 계속 잡는다 · 재작성 지시에 «문제 문장» 과 상품명 사양·예산 상태 |
| 지어낸 CPU·GPU 모델("i5" → "i5-13420H") | 단위가 없어 사양 검사가 못 봄 | `chip` 검사(상품명·pcSpecs 와 대조) |
| 부속으로 잘못 표시된 노트북 | 공용 productFocus 의 약한 감점(0.85, "대용량 배터리")을 부속으로 봄 | 0.8 미만만 부속, CPU 가 적힌 컴퓨터는 본품 |
| 20초, 마지막 차례 시간 초과 | 관측 저장(1.2초)이 검색 경로에, 검색 뒤 답변 몫 없음, 1200 토큰 답변 | 저장은 기다리지 않음(응답 전 짧게 drain) · 답변 몫 9초 확보 · 900 토큰 · 출력 없는 시간 초과는 1회 재시도 |
| 시간 초과 시 «확인된 정보» 답이 예산 초과·중고를 나열 | safe 목록이 예산·상태를 안 봄 | 예산 안·새 상품만 |

측정: `reports/ai-agent-v1-v2-live-2026-10-19-p0-{before,after,after2,after3,after4}.{md,json}`, 요약 `reports/ai-concierge-v2-p0-2026-10-19.md`, 비교 `node scripts/compare-ai-agent-live.js <before.json> <after.json>`.

## Preview 에서 시험

0. 2026-10-19: `OPENAI_API_KEY`·`OPENAI_MODEL`(gpt-5.1)·`AI_CONCIERGE_V2_ENABLED` 가 **이 브랜치의 Preview 에만** 추가됐다.
   `ADPICK_API_KEY` 는 여전히 Production 전용이라 Preview 의 v2 검색은 쿠팡만 찾는다(도구 결과 `searched: "쿠팡"`).
   2026-10-18 기록: `OPENAI_API_KEY`·`OPENAI_MODEL`·`ADPICK_API_KEY`·`GROQ_API_KEY` 는 **Production 전용**(Sensitive)이다.
   Preview 에는 OpenAI 키가 없어서 v2 는 `nokey` 로 v1 에 넘기고, v1 은 무료 OpenRouter 사슬로 답한다.
   Sensitive 값은 CLI 로 읽거나 복사할 수 없다 — 대시보드에서 OPENAI_API_KEY(+OPENAI_MODEL)의 대상에
   Preview(가능하면 이 브랜치만)를 추가한 뒤 Preview 를 다시 배포해야 v2 를 실제 OpenAI 로 잴 수 있다.
1. Preview 배포에 `OPENAI_API_KEY` 가 있어야 한다(없으면 v2 는 조용히 v1 으로 넘어간다 — 응답에 `engine` 이 없다).
2. 요청 단위: `x-seosa-ai-engine: v2`, 디버그 지표는 `x-seosa-ai-debug: 1` (Production 에서는 둘 다 무시).
3. 화면에서 시험하려면 Preview 환경에만 `AI_CONCIERGE_V2_ENABLED=1`.
4. v1↔v2 비교: `AI_EVAL_BASE_URL=https://<preview> npm run eval:agent-live` → `reports/ai-agent-v1-v2-live-<날짜>.md`
   Preview 는 Vercel Authentication 으로 보호돼 있다(401). Vercel 프로젝트 설정 → Deployment Protection →
   «Protection Bypass for Automation» 비밀값을 `VERCEL_AUTOMATION_BYPASS_SECRET` 으로 넘기면 헤더로 보낸다.
   없으면 스크립트는 한 번 확인하고 멈춘다.
   비밀값 없이: Vercel CLI 로 로그인해 두고 `AI_EVAL_TRANSPORT=vercel-curl AI_EVAL_VERCEL_CWD=<.vercel 연결된 폴더>`
   로 실행하면 `vercel curl` 이 프로젝트의 우회 토큰을 스스로 붙인다(스크립트는 비밀값을 다루지 않는다).
   이 PC 처럼 호스트 이름이 한글이면 Vercel CLI 가 "ByteString" 오류로 죽는다 —
   `NODE_OPTIONS="--require ./scripts/_vercel-ascii-hostname.js" vercel login` (평가 스크립트는 자동 적용).
   ※ Git Bash 에서 `vercel curl /api/ai` 를 직접 치면 경로가 `C:/Program Files/Git/api/ai` 로 바뀐다 — `MSYS_NO_PATHCONV=1`.
   ※ `vercel curl --debug` 는 우회 토큰을 평문으로 찍는다 — 쓰지 말 것.

## 관측

로그 한 줄 `[ai:v2] {...}` — 질문 원문·이메일·상품명·키는 남기지 않는다.

`rounds` `toolCalls` `calls{도구별}` `inTok` `outTok` `cachedTok` `reasoningTok` `costUsd`(단가 등록 모델만 — gpt-5.1 은 표에 없어 0) `llmMs[]` `model` `firstIssues[]`(첫 검증에서 걸린 종류) `finalIssues[]` `rewrite` `outcome`(ok·rewritten·redacted·safe·provider-safe·fallback-v1) `cards` `invalidIds`(모델이 낸 무효 ID 수) `droppedUnmentioned` `memIn` `memVerified` `memOut` `budgetCap`(예산 상한을 읽었는가) `retried` `saveTimedOut` `overBudgetNoted` `ms`

Preview + `x-seosa-ai-debug: 1` 이면 `_debug.trace` 가 더 붙는다(로그에는 남지 않는다): 차례별 지연·토큰·도구, 도구별 검색어·예산·쿠팡 캐시 여부·검색/보강 ms·예산 안 개수, 첫 답변 원문과 걸린 값, 재작성 원문, 레지스트리 요약.

## 테스트

- `npm run test:agent` — 오프라인 191 검사(모델 역할은 스크립트, 그 밖은 production 코드). `npm test` 에 포함.
- `npm run eval:agent-live` — 실제 GPT 판단 품질·지연·비용. 비용 발생, Preview 대상.
  `AI_EVAL_SET=p0 AI_EVAL_ENGINES=v2` = 예산·사양 비교, 연속 대화 5문장, 공격 3종(14턴). 비용은 토큰 × 단가(기본 gpt-5.1 공개가).
