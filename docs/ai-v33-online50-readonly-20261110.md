# 서사 AI v3.3 — 온라인 50문항 실제 Preview 회귀 검증

**실행일:** 2026-11-10 (KST). **배포:** `https://seosa-9n66r7m5w-seosa.vercel.app` (runtime commit `2558604`).
**검색 모드:** DB-first (실제 OpenAI + Neon 읽기 전용). 제휴 판매처 API live-first 미활성. 프로덕션 미변경.
**문항:** 기존 독립 진단용으로 먼저 고정됐던 F01–F20, D01–D20, I01–I10의 같은 50문항을 **재사용**. 그 이후 일부 문항을 보고 코드가 수정됐으므로 이번 점수는 독립 블라인드가 아닌 회귀 검증이다.

## 독립 평가기 재채점 및 PASS_ONLY 출시 기준

| 항목 | 2026-11-10 이전 원본 1174635 | 새 Preview 2558604 |
|---|---:|---:|
| PASS | 25 | 29 |
| FAIL | 6 | 1 |
| UNVERIFIED | 19 | 20 |
| strict 출시 성공률 (UNVERIFIED도 실패) | 50% | 58% |
| 총 추천 카드 | 42 | 36 |
| 잘못된 카드 | 6 | 0 |
| 카드 오류가 발생한 질문 | 4 | 0 |

## API, GPT, 지연 실측
- HTTP 200: **50/50**. 실패 HTTP: 0
- GPT 호출: **69**, 입력: **35056**, 출력: **3466**, 합계: **38522** 토큰.
- 평균 응답시간: **2431ms**, p50: **1937ms**, p95: **4330ms**.
- 평균 DB 읽기 쿼리: 9.06, 최대 14.
- 쿠팡/ADPICK live-first: **미실행 (0 search batch)**. 이 결과로 실시간 검색 우선 전략의 성공률·한도·비용을 평가할 수 없다.
- 결제 총액/재고/배송비는 이 테스트로 검증되지 않는다. GPT 청구서 실제 비용은 미계측.

## 판정 변동

| ID | 이전 | 이번 | 새로운 근거·원인 |
|---|---|---|---|
| F05 | FAIL (WRONG_CARDS) | PASS (CORRECT_CARDS) | 추가 사유 없음 |
| F08 | FAIL (WRONG_CARDS) | PASS (CORRECT_CARDS) | 추가 사유 없음 |
| F13 | FAIL (WRONG_CARDS) | PASS (CORRECT_CARDS) | 추가 사유 없음 |
| F14 | FAIL (MISSED_AVAILABLE) | PASS (CORRECT_CARDS) | 추가 사유 없음 |
| D09 | FAIL (WRONG_CARDS) | UNVERIFIED (CORRECT_NO_RESULT) | 추가 사유 없음 |

## 여전히 불합격 (진단 FAIL / UNVERIFIED)

- **F11**: FAIL / MISSED_AVAILABLE; MISSED_AVAILABLE
- **D01**: UNVERIFIED / CORRECT_NO_RESULT; 판정 근거 추가 확인 필요
- **D02**: UNVERIFIED / CORRECT_NO_RESULT; 판정 근거 추가 확인 필요
- **D03**: UNVERIFIED / CORRECT_NO_RESULT; 판정 근거 추가 확인 필요
- **D04**: UNVERIFIED / CORRECT_NO_RESULT; 판정 근거 추가 확인 필요
- **D05**: UNVERIFIED / CORRECT_NO_RESULT; 판정 근거 추가 확인 필요
- **D06**: UNVERIFIED / CORRECT_NO_RESULT; 판정 근거 추가 확인 필요
- **D07**: UNVERIFIED / CORRECT_NO_RESULT; 판정 근거 추가 확인 필요
- **D08**: UNVERIFIED / CORRECT_NO_RESULT; 판정 근거 추가 확인 필요
- **D09**: UNVERIFIED / CORRECT_NO_RESULT; 판정 근거 추가 확인 필요
- **D10**: UNVERIFIED / CORRECT_NO_RESULT; 판정 근거 추가 확인 필요
- **D11**: UNVERIFIED / CORRECT_NO_RESULT; 판정 근거 추가 확인 필요
- **D12**: UNVERIFIED / CORRECT_NO_RESULT; 판정 근거 추가 확인 필요
- **D13**: UNVERIFIED / CORRECT_NO_RESULT; 판정 근거 추가 확인 필요
- **D14**: UNVERIFIED / CORRECT_NO_RESULT; 판정 근거 추가 확인 필요
- **D15**: UNVERIFIED / CORRECT_NO_RESULT; 판정 근거 추가 확인 필요
- **D16**: UNVERIFIED / CORRECT_NO_RESULT; 판정 근거 추가 확인 필요
- **D17**: UNVERIFIED / CORRECT_NO_RESULT; 판정 근거 추가 확인 필요
- **D18**: UNVERIFIED / CORRECT_NO_RESULT; 판정 근거 추가 확인 필요
- **D19**: UNVERIFIED / CORRECT_NO_RESULT; 판정 근거 추가 확인 필요
- **D20**: UNVERIFIED / CORRECT_NO_RESULT; 판정 근거 추가 확인 필요

## 문항별 원본 평가

| ID | 기대값 | 판정 | 평가결과 | 카드 수 | HTTP | ms |
|---|---|---|---|---:|---:|---:|
| F01 | FIND | PASS | CORRECT_CARDS | 4 | 200 | 8651 |
| F02 | FIND | PASS | CORRECT_CARDS | 3 | 200 | 3525 |
| F03 | FIND | PASS | CORRECT_CARDS | 1 | 200 | 3048 |
| F04 | FIND | PASS | CORRECT_CARDS | 2 | 200 | 3232 |
| F05 | FIND | PASS | CORRECT_CARDS | 3 | 200 | 3188 |
| F06 | FIND | PASS | CORRECT_CARDS | 4 | 200 | 4330 |
| F07 | FIND | PASS | CORRECT_CARDS | 2 | 200 | 3151 |
| F08 | FIND | PASS | CORRECT_CARDS | 2 | 200 | 3462 |
| F09 | FIND | PASS | CORRECT_CARDS | 1 | 200 | 2736 |
| F10 | FIND | PASS | CORRECT_CARDS | 3 | 200 | 3711 |
| F11 | FIND | FAIL | MISSED_AVAILABLE | 0 | 200 | 1729 |
| F12 | FIND | PASS | CORRECT_CARDS | 1 | 200 | 2570 |
| F13 | FIND | PASS | CORRECT_CARDS | 1 | 200 | 2710 |
| F14 | FIND | PASS | CORRECT_CARDS | 1 | 200 | 3873 |
| F15 | FIND | PASS | CORRECT_CARDS | 1 | 200 | 2889 |
| F16 | FIND | PASS | CORRECT_CARDS | 2 | 200 | 2755 |
| F17 | FIND | PASS | CORRECT_CARDS | 1 | 200 | 2777 |
| F18 | FIND | PASS | CORRECT_CARDS | 2 | 200 | 3199 |
| F19 | FIND | PASS | CORRECT_CARDS | 1 | 200 | 3027 |
| F20 | FIND | PASS | CORRECT_CARDS | 1 | 200 | 2833 |
| D01 | NO_RESULT | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 1458 |
| D02 | NO_RESULT | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 2009 |
| D03 | NO_RESULT | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 1744 |
| D04 | NO_RESULT | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 1874 |
| D05 | NO_RESULT | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 1721 |
| D06 | NO_RESULT | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 2316 |
| D07 | NO_RESULT | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 7559 |
| D08 | NO_RESULT | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 2044 |
| D09 | NO_RESULT | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 1525 |
| D10 | NO_RESULT | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 1703 |
| D11 | NO_RESULT | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 1511 |
| D12 | NO_RESULT | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 1577 |
| D13 | NO_RESULT | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 1821 |
| D14 | NO_RESULT | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 2461 |
| D15 | NO_RESULT | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 1661 |
| D16 | NO_RESULT | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 1916 |
| D17 | NO_RESULT | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 1946 |
| D18 | NO_RESULT | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 1937 |
| D19 | NO_RESULT | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 1342 |
| D20 | NO_RESULT | UNVERIFIED | CORRECT_NO_RESULT | 0 | 200 | 1647 |
| I01 | NON_SHOPPING | PASS | CORRECT_NON_SHOPPING | 0 | 200 | 1348 |
| I02 | NON_SHOPPING | PASS | CORRECT_NON_SHOPPING | 0 | 200 | 1152 |
| I03 | NON_SHOPPING | PASS | CORRECT_NON_SHOPPING | 0 | 200 | 1647 |
| I04 | NON_SHOPPING | PASS | CORRECT_NON_SHOPPING | 0 | 200 | 1044 |
| I05 | NON_SHOPPING | PASS | CORRECT_NON_SHOPPING | 0 | 200 | 1055 |
| I06 | NON_SHOPPING | PASS | CORRECT_NON_SHOPPING | 0 | 200 | 1070 |
| I07 | NON_SHOPPING | PASS | CORRECT_NON_SHOPPING | 0 | 200 | 1464 |
| I08 | NON_SHOPPING | PASS | CORRECT_NON_SHOPPING | 0 | 200 | 1405 |
| I09 | NON_SHOPPING | PASS | CORRECT_NON_SHOPPING | 0 | 200 | 947 |
| I10 | NON_SHOPPING | PASS | CORRECT_NON_SHOPPING | 0 | 200 | 1257 |

### 해석상 주의

- 본 측정은 실제 온라인 OpenAI·Neon DB 회귀 테스트이지만, **실시간 제휴사 검색 결과가 아니다.**
- FAIL과 UNVERIFIED는 품질 출시 게이트에서 동일하게 실패로 계산하되, 진단 판정의 원인을 추적하기 위해 원본 세부 판정은 유지한다.
- 이전 오류를 고치는 데 사용한 같은 질문으로 다시 측정했으므로, 이번 성공률 상승을 독립 일반화 성능으로 표현할 수 없다.
- 실시간 제휴사 검색에는 생산 DB에 연결되지 않는 쿼터 관리·캐시 기록 및 호출 제한 검증이 별도로 필요하다.
