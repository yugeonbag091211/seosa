# ③ AI 쇼핑 조사관 — 설계 노트

`POST /api/investigate { question }` → 여러 상품을 조건으로 거르고 비교한 보고서. `api/ai.js`(AI Concierge 함수) 안의 `__route` 로 산다.

## 흐름

```
질문 ─ parseQuestion ─┬ _intent.extractQuery      검색어 (Concierge 정규식 경로와 같다)
                      ├ _shopintent.parseConstraints  예산·우선순위
                      ├ parseExclusions            "삼성 제외" · "LG 빼고"
                      ├ parseSpecRules             "1.5kg 이하" · "램 16GB 이상" · "20L"
                      └ _specs.wantedFeatures      노이즈캔슬링·무선…
products (최대 200) ─ prefilter ─ 카테고리 · 판매 중(최근 확인) · 부속품 · 제외어
price_history (최대 24개 × 90일, 페이지) ─ evaluate ─ 가격 검증 · 제목 사양 · 조건 위반/미확인
_shopintent.rankItems (Concierge 순서) → 기능 확인 수 · 미확인 수 · 가격 검증 순 보정
prosAndCons (근거: comparison/title/price_history/deal_engine) → summarize → groundCheck
```

## 잘못된 정보를 막는 장치

| 위험 | 장치 |
|---|---|
| 사양 오독 | `_specs` 정규식 수정 (1.19kg→19kg, "그램 17"→램 17GB 등) + 근거 글자가 제목에 실제로 있을 때만 사용 |
| 기능 부재 단정 | 제목에 없으면 `unverifiedFeatures` — "확인되지 않았어요 (없다는 뜻은 아니에요)" |
| 옛 가격 | 원장 최근 관측으로 검증, 3일 초과·카탈로그 불일치면 `verified:false` + 주의 문구 |
| 지어낸 숫자 | `groundCheck` — 요약의 모든 숫자·날짜가 후보 데이터 안에 있어야 한다. 실패 시 숫자 없는 요약으로 교체 |
| 잘린 숫자 | `cutTitle` — 낱말 경계에서 자른다 ("램 16GB" → "램 1…" 이 실제로 근거 검사에 잡혔다) |

## 비용 · 호출

- LLM 호출 0회, 외부 쇼핑 API 0회 (기본값). 요청당 DB: products 1회 + price_history 최대 3~6회(10개씩·페이지).
- `INVESTIGATOR_LIVE_SEARCH=1` 이면 카탈로그에서 0건일 때만 `_shop.searchAll` 1회 (기존 캐시·분당 상한). **운영에서 켜려면 승인 필요** — 쿠팡 호출이 늘어난다.

## 한계

- SEOSA 가 이미 가격을 기록하는 상품만 조사한다 — 카탈로그 밖 상품은 못 찾는다(실시간 검색 꺼짐).
- 사양은 상품명뿐이다. 상세 페이지 사양은 읽지 않는다.
- 문장은 결정론 템플릿이라 자연스러움은 LLM 답보다 덜하다. 대신 같은 질문이면 같은 보고서다.
