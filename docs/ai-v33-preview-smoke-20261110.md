# 서사 AI v3.3 — 안전한 Preview 실제 API 회귀 검증

기준 일시: 2026-11-10 (Asia/Seoul)

## 실행 대상

- 코드 SHA: `2558604f3e3063a0bb32762bc3661627c1975f74`.
- Vercel Preview: `https://seosa-9n66r7m5w-seosa.vercel.app` (deployment `dpl_HcXSqtFMozNy4sFNmzz1RLpX6mok`, **READY**, target Preview).
- 실행 주체: 사용자 승인 Desktop Commander의 기존 `scripts/ai-v32-eval/run-live.js --cases smoke`.
- 네트워크: 실제 OpenAI 호출 + Neon 상품 DB 읽기.
- **중요:** 기존 개발 Preview의 `SEOSA_DB_READONLY=1`을 유지함. 실시간 판매처 API는 호출하지 않았고, `AI_V3_SEARCH_STRATEGY=live-first` 환경변수를 해당 배포에 설정하지 않았음. 따라서 **DB-first 역호환 회귀검증**이며 v3.3 실시간 판매처 개선 성능으로 간주할 수 없음.

## 측정 결과

| 항목 | 값 |
|---|---:|
| 실행 문항 | 10 |
| HTTP 200 | 10/10 |
| 독립 평가기 PASS | 10 |
| FAIL | 0 |
| UNVERIFIED | 0 |
| strict PASS_ONLY 출시 성공률 | 100% (이 10문항 한정) |
| 추천 카드 | 26 |
| 조건 위반 카드 | 0 |
| GPT 호출 | 18 |
| 입력 토큰 | 11,415 |
| 출력 토큰 | 990 |
| 합계 토큰 | 12,405 |
| 평균 응답 | 3,477ms |
| p50 | 2,609ms |
| p95 | 6,808ms |
| 평균 DB 조회 | 7.2회 |
| 공급자 실시간 검색 배치 | **0** (DB-first/read-only Preview) |

10문항 중 9개는 상품 검색, 1개는 비쇼핑 설명형 질문. 과거에 사용한 테스트 ID를 재실행한 회귀검증이며 신규 블라인드 샘플이 아니다.

## 원본 증거 및 해석

- [민감한 링크/전체 상태를 제거한 10문항별 JSONL](https://github.com/yugeonbag091211/seosa/blob/feat/ai-v33-live-first-20261110/reports/ai-v33-readonly-preview-20261110/smoke10-2558604-sanitized.jsonl)
- 개발 PC의 완전한 로컬 원본: `reports/ai-v33-readonly-preview-20261110/smoke10-2558604.jsonl`, 동일 접두어 `-graded.jsonl` 및 `-graded-summary.json`.
- 담당 코드: `api/_ai-v3-catalog.js`, `api/_ai-v3-core.js`, `api/_ai-v3-route.js`.
- 제품 API 연동 여부를 증명할 출처/제한 로그가 없으므로, 이 결과로 실시간 우선 검색의 실제 FAIL 감소를 주장하면 안 된다.
- 별도 독립 Preview 환경에서 공급자 quota lease를 안전하게 사용하도록 분리한 뒤 실제 쿠팡·ADPICK API 검색 및 paired DB-first/live-first 비교가 다음 단계다.

**Production 배포는 진행하지 않음.** v3.3 PR은 Draft이고 feature flag는 기본 꺼짐 상태로 유지.
