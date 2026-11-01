# SEOSA AI — ADPICK 반복 검색 핫 캐시 및 실제 API 검증
검증일: 2026-11-01 (KST)

## 변경 범위
- `api/_adpick-hot-cache.js`: 20초 내 **실제 API 성공 결과**만 128개 키까지 프로세스 메모리에서 재사용. `source=ai/search`에서만 허용.
- 기존 저장형 Supabase 캐시, 인스턴스 분당 3회 및 전역 8회 한도, singleflight 동시 검색 중복 제거 구조를 유지.
- `forceRefresh`, `useCache:false`, `source=collect`는 우회 없이 기존 정상 조회·수집 경로 사용.
- 요청별 `cacheTtlMs`가 20초보다 짧다면 짧은 값을 존중한다. 0ms 또는 더 짧은 TTL로 읽는 요청이 다른 요청의 유효한 캐시 엔트리를 삭제하지 않는다.
- 서울 기준 자정(KST 날짜 변경)에 엔트리 즉시 무효화. 응답 상품은 복사해 다른 요청의 변경 전파 방지.
- `api/_adpick.js`에서 `hotCacheHits` 계측; 기존 실 API 호출 카운터는 그대로. 무효 응답·stale-cache·한도 실패는 절대 보관하지 않음.

## 독립 검사 표

| 범위 | 성공 | 실패 | 실제 API |
|---|---:|---:|---:|
| 100개의 **서로 다른 검색어 캐시 키** 모의검사 | 100 | 0 | 0회 |
| TTL·maxEntries·강제갱신·수집기 예외·KST 자정·객체 복사 경계검사 | 17 | 0 | 0회 |
| 중복 요청 메모리 가짜 서버 검사 | 11단언 | 0 | 0회 |
| **실제 ADPICK 요청 + 20초 캐시 재사용** | 5단언 | 0 | **1회** |

위 100개는 **캐시 키 테스트**이며 서로 다른 AI 쇼핑 질문 100회, 실제 GPT 100회 또는 실제 판매처 요청 100회가 아니다.

### 실제 판매처 단발 검증
- 읽기 전용 Preview 브랜치: `eval/seosa-adpick-hotcache-readonly-20261101`
- 실행 SHA: `9102c0732c8f6ddfbc670616d9e49de80a808685`
- Vercel 배포 ID: `dpl_AN1CqpZTL8v9hcURWNruyWTzdA7A`
- 실제 검색어: `아이리버 오픈형 무선 이어폰`
- 첫 검색: `from=api`, 실제 판매처 상품 **20개**, 외부 API 호출 **1회**.
- 같은 검색어 두 번째 검색: `from=cache`, `hotCache=true`, 실 API 추가 호출 **0회**.
- `QA_SUMMARY`: **5 PASS / 0 FAIL**, `hotCacheHits=1`, `blockedWrites=2`, `blockedRpc=1`, 실제 DB 쓰기 0건. LLM 호출 0회.
- 유료/시험 buildCommand는 별도 시험 브랜치 `66b60ea7791532df1f7c81e550bb24f970dedb8c`에서 제거함. PR 본 브랜치에는 QA buildCommand가 없음.

## 미해결 항목·배포 게이트
- 같은 인스턴스에서 짧은 시간 동일 검색어 반복 시의 API 절약만 확인했다. 실제 Vercel 여러 인스턴스 간에는 이 메모리 캐시를 공유하지 않음(그 경우 기존 DB 캐시 경로 사용).
- **서로 다른 캐시 미적중 검색어**를 짧게 연속 입력하면 로컬 3회/분·전역 8회/분의 원래 제약이 남는다. 이를 무시하거나 100% 가용성을 주장하지 않음.
- 다른 상품·판매처를 실제 동시에 질의하는 스트레스, 쿠팡 실 API E2E, 가격 최신성·결제 최종가 검증은 별도 출시 관문.
- PR #206은 Draft, main 미병합, Production 변경 없음.
