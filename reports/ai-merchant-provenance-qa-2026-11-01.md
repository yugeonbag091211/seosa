# SEOSA AI /api/search — 쿠팡·ADPICK 혼합 출처 및 가격 신선도 검증

검증일: 2026-11-01 (KST)
대상 PR: #206 (Draft; main 미병합; Production 미배포)
코드 커밋: `dea4e6fbf879dc11415aeaa9efa404aaa8f68077`

## 원인과 조치
이전 `_shop.searchAll`의 `from`은 쿠팡만 대표했는데, `/api/search`는 그 값을 전체 응답의 `X-Seosa-Source`와 CDN 5분 캐시 여부에 사용했다.

- 쿠팡 API + ADPICK stale-cache: 오래된 ADPICK 가격이 있어도 전체 출처가 api로 표시되고 CDN에 저장될 위험.
- 쿠팡 none + ADPICK API: 상품은 정상 도착했어도 출처가 none으로 표시될 위험.
- 부분 공급자 장애: 신선한 한쪽 응답을 5분 CDN 캐시에 저장하면 다른 공급자가 복구된 뒤에도 반쪽 상품 목록이 지속될 위험.

수정:
1. `api/_shop.js`가 두 판매처의 `providerSources`, `providerBlocked` 정보를 별도로 반환한다. 기존 내부 `from` 계약은 유지한다.
2. `api/_search-provenance.js`에서 화면에 실제 노출된 상품의 `_source`를 기준으로 출처를 판정한다. 하나라도 stale이면 `stale-cache` 경고를 유지해 구버전 클라이언트에도 안전하게 표시한다.
3. `api/search.js`는 표시된 상품에 stale가 섞인 경우 `X-Seosa-Partial-Stale: 1`을 설정한다. 두 공급자가 모두 신선하고 실제로 노출된 상품이 있을 때만 Edge 캐시를 허용한다. 부분 공급원 장애 또는 stale 응답은 `no-store`.
4. `public/index.html`은 혼합 응답에 대해 '일부 쇼핑몰의 최신 가격을 확인하지 못했어요' 경고를 표시한다.
5. 기존 vm 핸들러 테스트가 새 의존성을 주입하도록 회귀검사를 보강한다.

## 검증표

| 검사 | 요청/조합 | 성공 | 실패 | 실제 API |
|---|---:|---:|---:|---|
| 공급자 상태 매트릭스 및 추가 예외 | 69 | 69 | 0 | 0 |
| /api/search HTTP 헤더 + 화면 메시지 모의검사 | 9 | 9 | 0 | 0 |
| 격리 Preview 실제 ADPICK 검증 | 5 단언 | 5 | 0 | ADPICK 1, 쿠팡 0 |
| GitHub 자동검사 (Tests, AI security, Collector Regression, Mobile Check) | 4 워크플로 | 4 | 0 | 테스트별 격리 |

검사 69건은 **판매처 출처 상태 조합의 오프라인 테스트**이며, 서로 다른 69개 실제 쇼핑 질문이나 69회 실제 API 호출이 아니다.

## 실제 판매처 검증 증거

- 검증 브랜치: `eval/seosa-dual-source-provenance-live-20261101`
- 1회성 Preview 검증 SHA: `7860c56e37cb2055c7fe589c74b048de13fa8873`
- Vercel 배포: `dpl_BnDsgoxXC3WmcmiUqWV5mdLswMUi`
- 공급자 상태: `{"coupang":"none","adpick":"api"}`
- 결과: **9개 상품**, 표시 출처 `api`, Edge 캐시 `false`, 실제 ADPICK 호출 1회.
- 계측: **5 PASS / 0 FAIL**, `blockedWrites=2`, `blockedRpc=2`, 읽기 전용 모드, 운영 DB 쓰기 0.
- 검증 브랜치의 일시적 `vercel.json buildCommand` 제거 커밋: `35e3ef2d59b04b2e70968fafb160ca0b66205019`.
- Live GPT 호출 0회: 본 검사는 추천 문장 품질이 아니라 쇼핑 공급원 출처와 가격 상태 검증이다.

## 남은 출시 관문

- Supabase 읽기 전용 보호가 전역 쿠팡 예약 RPC를 막기 때문에 **실제 쿠팡 제휴 API 0회**. 둘 다 신선한 실 API를 받는 E2E는 미검증.
- ADPICK 3회/분 로컬 및 8회/분 전역 한도, 캐시 미적중 연속 검색 문제는 별도.
- 판매처 표시 판매가와 실제 옵션 선택 후 최종 결제 금액의 일치율, 대규모 동시 사용자 트래픽, 현재가 시점 정확도는 추가 관찰 필요.
- **PR #206 Draft 유지. Production 배포 및 원장 쓰기 없음.**
