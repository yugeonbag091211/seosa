# 서사 AI v3.2 — 온라인 50문항 실측 결과 (2026-11-10)

**배포:** Preview `seosa-kqa0p0ixf-seosa.vercel.app`, 수정 코드 `d07c345`. Production 변경 없음.
**방법:** 사전 등록된 H01–H49 및 H56을 실제 OpenAI·Neon Preview API로 재실행. 기존 개발·검증에 사용된 문항이므로 신규 블라인드 평가가 아닌 *온라인 회귀 검증*.

## 판정 비교

| 항목 | 이전 Preview ca13e10 | 수정 Preview d07c345 |
|---|---:|---:|
| PASS | 34 | 34 |
| FAIL | 3 | 1 |
| UNVERIFIED | 13 | 15 |
| 추천 카드 총수 | 111 | 106 |
| 조건 위반 카드 | 8 | 0 |
| 잘못된 추천이 발생한 질문 | 2 | 0 |

## 실측 운영값

- HTTP 200: 50/50; 검색 실행: 50/50
- 모델: gpt-4.1-mini; GPT 호출: 85회; 입력 61453토큰; 출력 5581토큰; 총 67034토큰
- 평균 응답: 2792ms; p50: 2757ms; p95: 4079ms
- 모델 토큰 단가 기준 예산 추정: $0.03351 (GPT-4.1 mini 공개 입력 $0.40/1M·출력 $1.60/1M, 캐시 할인 미반영). 청구서 실측 아님; Vercel/DB 등 외부 비용 제외.

## 이전 실행 대비 판정이 바뀐 사례

| ID | 이전 | 현재 | 원인 요약 |
|---|---|---|---|
| H46 | FAIL (WRONG_CARDS) | UNVERIFIED (CORRECT_NO_RESULT) | - |
| H56 | FAIL (WRONG_CARDS) | UNVERIFIED (CORRECT_NO_RESULT) | - |

## 남은 실패

- **H47** 로보락 S8 로봇청소기 가격 비교 — MISSED_AVAILABLE: MISSED_AVAILABLE

## 전체 문항별 판정

| ID | Verdict | Outcome | 카드 | HTTP | 응답 ms |
|---|---|---|---:|---:|---:|
| H01 | PASS | CORRECT_CARDS | 3 | 200 | 2883 |
| H02 | PASS | CORRECT_CARDS | 4 | 200 | 2461 |
| H03 | PASS | CORRECT_CARDS | 4 | 200 | 3011 |
| H04 | PASS | CORRECT_CARDS | 2 | 200 | 2644 |
| H05 | PASS | CORRECT_CARDS | 4 | 200 | 2892 |
| H06 | PASS | CORRECT_CARDS | 4 | 200 | 3190 |
| H07 | PASS | CORRECT_CARDS | 4 | 200 | 3921 |
| H08 | PASS | CORRECT_CARDS | 4 | 200 | 3311 |
| H09 | PASS | CORRECT_CARDS | 2 | 200 | 2766 |
| H10 | PASS | CORRECT_CARDS | 3 | 200 | 2586 |
| H11 | UNVERIFIED | INSUFFICIENT_EVIDENCE | 0 | 200 | 2611 |
| H12 | PASS | CORRECT_CARDS | 4 | 200 | 4792 |
| H13 | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 1655 |
| H14 | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 2312 |
| H15 | UNVERIFIED | INSUFFICIENT_EVIDENCE | 0 | 200 | 1973 |
| H16 | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 2404 |
| H17 | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 2533 |
| H18 | PASS | CORRECT_CARDS | 1 | 200 | 3826 |
| H19 | PASS | CORRECT_CARDS | 2 | 200 | 2920 |
| H20 | PASS | CORRECT_CARDS | 1 | 200 | 3888 |
| H21 | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 1797 |
| H22 | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 2446 |
| H23 | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 2276 |
| H24 | PASS | CORRECT_CARDS | 3 | 200 | 3135 |
| H25 | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 1323 |
| H26 | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 1918 |
| H27 | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 2035 |
| H28 | PASS | CORRECT_CARDS | 1 | 200 | 4079 |
| H29 | PASS | CORRECT_CARDS | 4 | 200 | 3477 |
| H30 | PASS | CORRECT_CARDS | 4 | 200 | 2786 |
| H31 | PASS | CORRECT_CARDS | 4 | 200 | 3246 |
| H32 | PASS | CORRECT_CARDS | 4 | 200 | 2871 |
| H33 | PASS | CORRECT_CARDS | 4 | 200 | 3218 |
| H34 | PASS | CORRECT_CARDS | 1 | 200 | 3322 |
| H35 | PASS | CORRECT_CARDS | 1 | 200 | 3438 |
| H36 | PASS | CORRECT_CARDS | 4 | 200 | 2456 |
| H37 | PASS | CORRECT_CARDS | 2 | 200 | 2423 |
| H38 | PASS | CORRECT_CARDS | 4 | 200 | 2904 |
| H39 | PASS | CORRECT_CARDS | 4 | 200 | 4261 |
| H40 | UNVERIFIED | INSUFFICIENT_EVIDENCE | 0 | 200 | 1241 |
| H41 | PASS | CORRECT_CARDS | 4 | 200 | 3705 |
| H42 | PASS | CORRECT_CARDS | 1 | 200 | 2738 |
| H43 | PASS | CORRECT_CARDS | 4 | 200 | 2270 |
| H44 | PASS | CORRECT_CARDS | 4 | 200 | 3127 |
| H45 | PASS | CORRECT_CARDS | 4 | 200 | 2757 |
| H46 | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 1864 |
| H47 | FAIL | MISSED_AVAILABLE | 0 | 200 | 2201 |
| H48 | PASS | CORRECT_CARDS | 3 | 200 | 3117 |
| H49 | PASS | CORRECT_CARDS | 4 | 200 | 2682 |
| H56 | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 1932 |

## 한계

- 정답표(H47의 로보락 S8 기본형/파생형 포함)는 기존 기준을 그대로 사용. 상품 존재 여부가 확인되지 않은 미검증을 성공으로 간주하지 않음.
- 모델별 실제 청구 금액 및 인프라 비용은 별도 계측값이 없음. 평가기의 오탐·누락 가능성은 남아 있음.
- 데이터베이스 조회 결과는 판매 사이트의 실시간 재고·배송·결제 총액을 증명하지 않음.
