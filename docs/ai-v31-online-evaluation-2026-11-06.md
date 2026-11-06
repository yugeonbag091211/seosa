# SEOSA AI v3.1 — 온라인 100문항 검증 보고서

- 날짜: 2026-11-06 (KST)
- 검증 브랜치: feat/ai-v31-engine-20261106
- 검증 커밋: 509027673dcc7eb1070111e95dd84cae13c71c68
- Vercel Preview: https://seosa-f5q64wvy9-seosa.vercel.app (접근 보호)
- Neon: migration-test-20261020 / seosa_v3_reader, 읽기 전용
- Production 미변경
- 실제 GPT와 상품 DB에 서로 다른 질문 100개를 전송

## 결과

| 기준 | v3 기존 100문항 | v3.1 최신 100문항 |
|---|---:|---:|
| 자동 PASS | 74 | 79 |
| 자동 FAIL | 2 | 3 |
| 자동 미검증 | 24 | 18 |
| 재검토 PASS | 72 | 79 |
| 재검토 FAIL | 12 | 3 |
| 재검토 미검증 | 16 | 18 |

재검토 수치는 코드 검사와 상품 제목 기반의 명백한 모순·부품·요금제 조건 검사 결과다. 판매처 최종 가격, 진품 여부, 배송비, 실제 재고를 모두 검증한 최종 구매 정확도는 아니다.
같은 100문항을 사용했지만 GPT 출력은 비결정적이고 DB가 갱신되므로 관측치의 직접 비교는 주의가 필요하다.

## 실제 사용량

| 지표 | 값 |
|---|---:|
| GPT 호출 | 177 |
| 입력 토큰 | 156636 |
| 출력 토큰 | 12362 |
| 소요 초 | 581 |

모델 gpt-4.1-mini. 과금내역은 별도 확인 전이므로 달러 비용은 확정하지 않는다.

## 확정 FAIL

| ID | 질문 | 사유 |
|---|---|---|
| Q029 | 100만원 이하 태블릿 뭐가 좋아? | shopping_request_not_searched |
| Q092 | 그중 12만원 이상으로만 골라줘 | shopping_request_not_searched, min_budget_state_wrong |
| Q093 | 그중에서 한 개만 추천해줘 | min_budget_state_wrong, card1:below_min_budget |

## 미검증

| ID | 질문 | 보류 사유 |
|---|---|---|
| Q015 | 갤럭시 버즈 FE 추천해줘 | 적합한 결과가 0개이거나 검색 누락 여부 미확인 |
| Q023 | 갤럭시탭 S9 FE 256GB 제품 추천 | 적합한 결과가 0개이거나 검색 누락 여부 미확인 |
| Q026 | 아이패드 10세대 64GB 추천 | 적합한 결과가 0개이거나 검색 누락 여부 미확인 |
| Q027 | 갤럭시탭 S10 256GB 추천 | 적합한 결과가 0개이거나 검색 누락 여부 미확인 |
| Q031 | 아이폰 16 128GB 신품 추천 | 적합한 결과가 0개이거나 검색 누락 여부 미확인 |
| Q032 | 아이폰 16e 128GB 찾아줘 | 적합한 결과가 0개이거나 검색 누락 여부 미확인 |
| Q033 | 아이폰 16 프로 128GB 추천 | 적합한 결과가 0개이거나 검색 누락 여부 미확인 |
| Q034 | 아이폰 15 128GB 추천해줘 | 적합한 결과가 0개이거나 검색 누락 여부 미확인 |
| Q035 | 아이폰 16 프로 맥스 256GB 추천 | 적합한 결과가 0개이거나 검색 누락 여부 미확인 |
| Q036 | 갤럭시 S24 256GB 추천해줘 | 적합한 결과가 0개이거나 검색 누락 여부 미확인 |
| Q038 | 100만원 이하 스마트폰 추천해줘 | 적합한 결과가 0개이거나 검색 누락 여부 미확인 |
| Q039 | 중고 빼고 휴대폰 80만원 이하로 골라줘 | 적합한 결과가 0개이거나 검색 누락 여부 미확인 |
| Q044 | 맥북 에어 M4 256GB 추천 | 적합한 결과가 0개이거나 검색 누락 여부 미확인 |
| Q045 | 맥북 프로 M4 512GB 추천 | 적합한 결과가 0개이거나 검색 누락 여부 미확인 |
| Q047 | 삼성 갤럭시북 15인치 찾아줘 | 적합한 결과가 0개이거나 검색 누락 여부 미확인 |
| Q053 | 5만원 이하 외장 SSD 추천 | 적합한 결과가 0개이거나 검색 누락 여부 미확인 |
| Q066 | LG 27인치 모니터 추천 | 적합한 결과가 0개이거나 검색 누락 여부 미확인 |
| Q067 | 삼성 모니터 24인치 찾아줘 | 적합한 결과가 0개이거나 검색 누락 여부 미확인 |

## 전체 100문항 결과

| ID | 질문 | 자동 | 재검토 | 상품 수 | 비고 |
|---|---|---|---|---:|---|
| Q001 | 15만원 이하 헤드셋 추천해줘 | PASS | PASS | 4 |  |
| Q002 | 12만원에서 15만원 사이의 무선 헤드폰 찾아줘 | PASS | PASS | 4 |  |
| Q003 | 게이밍 제외하고 블루투스 헤드셋 골라줘 | PASS | PASS | 4 |  |
| Q004 | 10만원 미만 헤드폰 있을까? | PASS | PASS | 4 |  |
| Q005 | 15만원 안에서 ANC 헤드폰 추천 | PASS | PASS | 4 |  |
| Q006 | 20만원 이하 노이즈캔슬링 헤드폰 추천 | PASS | PASS | 4 |  |
| Q007 | 가성비 무선 헤드셋 추천해줘 | PASS | PASS | 4 |  |
| Q008 | 게임용 아닌 공부할 때 쓸 헤드폰 추천 | PASS | PASS | 4 |  |
| Q009 | 12만~15만원 헤드셋 추천 | PASS | PASS | 4 |  |
| Q010 | 소니 블루투스 헤드폰 15만원 이하로 골라줘 | PASS | PASS | 4 |  |
| Q011 | 에어팟 4 ANC 추천해줘 | PASS | PASS | 3 |  |
| Q012 | 에어팟 프로 2세대 추천해줘 | PASS | PASS | 4 |  |
| Q013 | 에어팟 4 일반 모델 찾아줘 | PASS | PASS | 4 |  |
| Q014 | 에어팟 4세대 노이즈 캔슬링 버전 추천 | PASS | PASS | 1 |  |
| Q015 | 갤럭시 버즈 FE 추천해줘 | UNVERIFIED | UNVERIFIED | 0 |  |
| Q016 | 삼성 갤럭시 버즈3 프로 추천해줘 | PASS | PASS | 4 |  |
| Q017 | 10만원 이하 무선 이어폰 추천 | PASS | PASS | 4 |  |
| Q018 | 5만원대 가성비 블루투스 이어폰 | PASS | PASS | 4 |  |
| Q019 | 운동할 때 쓸 이어버드 추천해줘 | PASS | PASS | 4 |  |
| Q020 | 이어폰 본체만 추천해줘 케이스 말고 | PASS | PASS | 4 |  |
| Q021 | 갤럭시탭 S9 FE 128GB 찾아줘 | PASS | PASS | 1 |  |
| Q022 | 갤럭시탭 S9 FE+ 128GB 추천 | PASS | PASS | 3 |  |
| Q023 | 갤럭시탭 S9 FE 256GB 제품 추천 | UNVERIFIED | UNVERIFIED | 0 |  |
| Q024 | 아이패드 에어 M4 256GB 추천해줘 | PASS | PASS | 3 |  |
| Q025 | 아이패드 에어 M4 128GB 추천해줘 | PASS | PASS | 4 |  |
| Q026 | 아이패드 10세대 64GB 추천 | UNVERIFIED | UNVERIFIED | 0 |  |
| Q027 | 갤럭시탭 S10 256GB 추천 | UNVERIFIED | UNVERIFIED | 0 |  |
| Q028 | 11인치 아이패드 에어 M4 추천 | PASS | PASS | 4 |  |
| Q029 | 100만원 이하 태블릿 뭐가 좋아? | FAIL | FAIL | 0 | shopping_request_not_searched |
| Q030 | 아이패드 vs 갤럭시탭 가격 비교해줘 | PASS | PASS | 2 |  |
| Q031 | 아이폰 16 128GB 신품 추천 | UNVERIFIED | UNVERIFIED | 0 |  |
| Q032 | 아이폰 16e 128GB 찾아줘 | UNVERIFIED | UNVERIFIED | 0 |  |
| Q033 | 아이폰 16 프로 128GB 추천 | UNVERIFIED | UNVERIFIED | 0 |  |
| Q034 | 아이폰 15 128GB 추천해줘 | UNVERIFIED | UNVERIFIED | 0 |  |
| Q035 | 아이폰 16 프로 맥스 256GB 추천 | UNVERIFIED | UNVERIFIED | 0 |  |
| Q036 | 갤럭시 S24 256GB 추천해줘 | UNVERIFIED | UNVERIFIED | 0 |  |
| Q037 | 삼성 갤럭시 S25 256GB 신품 추천 | PASS | PASS | 1 |  |
| Q038 | 100만원 이하 스마트폰 추천해줘 | UNVERIFIED | UNVERIFIED | 0 |  |
| Q039 | 중고 빼고 휴대폰 80만원 이하로 골라줘 | UNVERIFIED | UNVERIFIED | 0 |  |
| Q040 | 아이폰 16과 갤럭시 S25 가격 비교해줘 | PASS | PASS | 2 |  |
| Q041 | 80만원 이하 가벼운 노트북 추천 | PASS | PASS | 2 |  |
| Q042 | 100만원 이하 대학생용 노트북 | PASS | PASS | 3 |  |
| Q043 | LG 그램 노트북 추천해줘 | PASS | PASS | 4 |  |
| Q044 | 맥북 에어 M4 256GB 추천 | UNVERIFIED | UNVERIFIED | 0 |  |
| Q045 | 맥북 프로 M4 512GB 추천 | UNVERIFIED | UNVERIFIED | 0 |  |
| Q046 | 게임용 제외하고 사무용 노트북 추천 | PASS | PASS | 4 |  |
| Q047 | 삼성 갤럭시북 15인치 찾아줘 | UNVERIFIED | UNVERIFIED | 0 |  |
| Q048 | 70만원부터 90만원까지 노트북 추천 | PASS | PASS | 4 |  |
| Q049 | 휴대성 좋은 윈도우 노트북 추천 | PASS | PASS | 4 |  |
| Q050 | 노트북 추천 하나만 해줘 | PASS | PASS | 1 |  |
| Q051 | 1TB 외장하드 추천해줘 | PASS | PASS | 4 |  |
| Q052 | 2TB 외장하드 추천해줘 | PASS | PASS | 4 |  |
| Q053 | 5만원 이하 외장 SSD 추천 | UNVERIFIED | UNVERIFIED | 0 |  |
| Q054 | 삼성 외장 SSD T7 1TB 추천 | PASS | PASS | 4 |  |
| Q055 | 씨게이트 외장하드 2TB 추천 | PASS | PASS | 1 |  |
| Q056 | 맥북 연결용 외장 SSD 추천 | PASS | PASS | 4 |  |
| Q057 | 휴대용 외장 하드디스크 추천 | PASS | PASS | 4 |  |
| Q058 | 10만원 이하 USB 외장하드 | PASS | PASS | 4 |  |
| Q059 | 500GB 외장하드 추천해줘 | PASS | PASS | 1 |  |
| Q060 | 2테라 데이터 백업용 외장하드 찾아줘 | PASS | PASS | 4 |  |
| Q061 | 20만원 이하 모니터 추천 | PASS | PASS | 4 |  |
| Q062 | 27인치 모니터 추천 | PASS | PASS | 4 |  |
| Q063 | 32인치 4K 모니터 찾아줘 | PASS | PASS | 4 |  |
| Q064 | 사무용 모니터 15만원 이하 | PASS | PASS | 4 |  |
| Q065 | 게이밍 아닌 눈 편한 모니터 추천 | PASS | PASS | 4 |  |
| Q066 | LG 27인치 모니터 추천 | UNVERIFIED | UNVERIFIED | 0 |  |
| Q067 | 삼성 모니터 24인치 찾아줘 | UNVERIFIED | UNVERIFIED | 0 |  |
| Q068 | 30만원 이하 144Hz 모니터 | PASS | PASS | 4 |  |
| Q069 | 작업용 듀얼 모니터 추천 | PASS | PASS | 4 |  |
| Q070 | 20만~30만원 모니터 추천 | PASS | PASS | 4 |  |
| Q071 | 10만원 이하 무선 키보드 추천 | PASS | PASS | 4 |  |
| Q072 | 로지텍 기계식 키보드 추천 | PASS | PASS | 4 |  |
| Q073 | 블루투스 키보드 찾아줘 | PASS | PASS | 4 |  |
| Q074 | 5만원 이하 마우스 추천 | PASS | PASS | 4 |  |
| Q075 | 로지텍 MX Master 마우스 추천 | PASS | PASS | 2 |  |
| Q076 | 사무용 무소음 마우스 추천 | PASS | PASS | 4 |  |
| Q077 | 15만원 이하 기계식 키보드 | PASS | PASS | 4 |  |
| Q078 | 아이패드용 블루투스 키보드 추천 | PASS | PASS | 3 |  |
| Q079 | 게이밍 말고 사무용 키보드 추천 | PASS | PASS | 4 |  |
| Q080 | 손목 편한 무선 마우스 찾아줘 | PASS | PASS | 3 |  |
| Q081 | 20만원 이하 공기청정기 추천 | PASS | PASS | 4 |  |
| Q082 | 침실용 소형 공기청정기 추천 | PASS | PASS | 4 |  |
| Q083 | 산업용 말고 집에서 쓸 공기청정기 | PASS | PASS | 4 |  |
| Q084 | 30만원 이하 공기청정기 찾아줘 | PASS | PASS | 4 |  |
| Q085 | 50만원 이하 로봇청소기 추천 | PASS | PASS | 4 |  |
| Q086 | 무선청소기 20만원 이하 추천 | PASS | PASS | 4 |  |
| Q087 | 작은 원룸용 청소기 찾아줘 | PASS | PASS | 4 |  |
| Q088 | 로보락 로봇청소기 추천 | PASS | PASS | 4 |  |
| Q089 | 부담 없는 가격의 공기청정기 하나 | PASS | PASS | 4 |  |
| Q090 | 집에서 쓸 청소기와 공기청정기 비교 | PASS | PASS | 2 |  |
| Q091 | 15만원 이하 비게이밍 헤드셋 추천해줘 | PASS | PASS | 4 |  |
| Q092 | 그중 12만원 이상으로만 골라줘 | FAIL | FAIL | 0 | shopping_request_not_searched, min_budget_state_wrong |
| Q093 | 그중에서 한 개만 추천해줘 | FAIL | FAIL | 1 | min_budget_state_wrong, card1:below_min_budget |
| Q094 | 아이패드 에어 M4 256GB 보여줘 | PASS | PASS | 3 |  |
| Q095 | 예산은 80만원이야 | PASS | PASS | 0 |  |
| Q096 | 128GB 말고 256GB로 골라줘 | PASS | PASS | 3 |  |
| Q097 | 갤럭시탭 S9 FE와 아이패드 에어 M4 비교해줘 | PASS | PASS | 2 |  |
| Q098 | 고마워! | PASS | PASS | 0 |  |
| Q099 | 에어팟 4 ANC 중고 말고 신품 추천 | PASS | PASS | 2 |  |
| Q100 | 15만원 이하 외장하드 중에 SSD 추천 | PASS | PASS | 3 |  |

## 남은 검증 과제

- 미검증 결과는 DB 상품·옵션·수집 품질을 읽기 전용으로 대조.
- 상품 옵션 가격·통신사 약정·배송비·정품 인증은 별도 데이터 출처 검증.
- 반복 사용한 100문항과 독립적인 새로운 홀드아웃 테스트 필요.
- 속도·API 토큰·Neon DB 쿼리량 회귀 확인.
- Production 반영 전 별도 승인, 기존 Production 변경 금지.

## 아티팩트

- ai-v31-online-evaluation-2026-11-06-results.jsonl: 질문별 카드명, 기록 가격, 서버 상태, 모델 사용량. 외부 클릭 URL/인증 토큰 제외.
- ai-v31-online-evaluation-2026-11-06-failures.jsonl: 실패만 분리 저장.
- 테스트 실행 스크립트: scripts/ai-v3-online-110-verify.js

이 보고서는 단일 Preview 배포의 관측 결과로 모든 상황에 대한 정확도 100%를 의미하지 않는다.
