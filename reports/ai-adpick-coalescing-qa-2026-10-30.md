# SEOSA AI: ADPICK 중복 검색 방지 및 판매처별 검색 상태 검증

일자: 2026-10-30 (KST)
PR: #206 (Draft, 미병합, Production 미배포)
코드 SHA: `265458bdd6dde1bad126822e8231449904f1033f`

## 바뀐 내용

1. `api/_adpick.js`: 같은 프로세스 안에서 **동일 검색어·동일 source·limit·timeout·대기·캐시 정책**의 동시 호출이 겹치면 첫 요청의 완료를 기다리도록 singleflight 구현. 기존 제한기 `searchAdpickOnce`는 그대로 한 번만 실행. 명시적 `forceRefresh` 및 `useCache:false`는 공유 금지. 요청 완료 뒤 메모리 엔트리 즉시 삭제.
2. `api/_shop.js`: 쿠팡만 기준으로 결정하던 `from` 필드는 호환성을 위해 유지. 대신 공급자 둘 중 하나가 실제 API 또는 오늘의 신선한 캐시 결과를 돌려준 사실을 `freshAnswered`로 별도 반환.
3. `api/_ai-search-evidence.js`와 `api/ai.js`: 공급자별 신선한 상품만 취하고, **한 공급자는 장애 / 다른 공급자는 정상 0건**인 경우를 상품 미확인 장애와 구분. stale-cache는 현재가 추천에 절대 포함하지 않음.
4. `scripts/test-ai-search-evidence.js`, `scripts/test-adpick-coalescing.js`: 각각 12개 분류 케이스, 동시 동일 검색어·캐시·명시적 새로고침 계약을 검증. `package.json` pretest에 연결.

## 검증 표

| 시험 | 요청 | 성공 | 실패 | 외부 연결 |
|---|---:|---:|---:|---|
| 판매처별 검색 상태 회귀 | 12 | 12 | 0 | 없음 |
| ADPICK singleflight 메모리 모의 검증 | 10개 단언 | 10 | 0 | 없음. 2개 모의 fetch |
| 실제 ADPICK 쇼핑 카테고리 | 4 | 4 | 0 | 실제 4회 |
| 실제 검색·예산·DB 가드 3단언 × 4문항 | 12 | 12 | 0 | 실제 LLM·ADPICK |
| GitHub Tests / AI security / Collector Regression / Mobile Check | 4 워크플로 | 4 | 0 | 각 워크플로 격리 CI |

## 격리 실상품 테스트

동일한 20초 호출 간격 정책·읽기 전용 Preview에서 테스트:
- 15만원 이하 무선 이어폰
- 5만원 이하 무선 마우스
- 50만원 이하 무선 청소기
- 12만원 이하 에어프라이어

증거: Vercel Preview deployment `dpl_FGFz5G6GKsa5tr2jt5J6uUcjj8a9` / QA 브랜치 `eval/seosa-ai-coalescing-live-4-20261030` / 임시 평가 SHA `fcab0be80947c16d7c7e0a77978400dd62970418`.

**12 PASS / 0 FAIL**. 실제 판매처 응답에 양수 가격의 상품 카드가 있었고, 예산 상한 초과 상품은 없음.
- 최종 가드 `enabled=true, blockedWrites=8, blockedRpc=5, allowedRpc=0`. 운영 DB에 기록한 쓰기 0건.
- GPT 추정 비용 **USD 0.002901**, 상한 USD 0.50 미만.
- 시험 종료 즉시 유료 QA buildCommand 삭제: `25d3423dac4ae05248f2f8552d9d6bd43153c32b`. 이 시험용 수정은 PR 본 브랜치에 포함되지 않음.

## 한계와 Production 출시 관문

- 이번 실제 쇼핑 4문항은 **서로 다른 검색어를 20초 간격으로 순차 호출**한 것. 동시 요청 coalescing은 메모리 가짜 API로 검증했으므로 운영 환경의 실제 동시 트래픽 개선률은 아직 수치화되지 않음.
- ADPICK 인증 키는 수집기와 공유하므로 3회/분 로컬·8회/분 전역 제한을 임의 완화하지 않았음. 빠르게 다른 검색어를 보내는 경우 앞선 10문항 실험에서 8/10이었던 한계는 남음.
- DB 읽기 전용 검증에서 전역 ADPICK `adpick_acquire` 및 쿠팡 `coupang_acquire_v2` RPC는 막혔으므로 전역 동시성·실쿠팡 API 호출은 이번에도 확인하지 못함.
- 판매처 표기가와 실제 결제 가격 및 가격 기록 최신성은 별도 검증 필요.
- 절대적인 100% 정확도/가용성은 증명하지 않았음.

**최종 판단:** PR #206 Draft, Production 배포 보류. 다음은 실사용 부하/캐시 신선도 p95, 공식 전역 제한 유지한 쿠팡+ADPICK 통합 E2E 검증.
