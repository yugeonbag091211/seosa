# 쿠팡 collector 1차 상향: 20회/분

기준 main: `9749341e796bc67fffdb3a38e151d7b3aa45f93d` (PR #116).
이 PR은 코드·테스트·운영 검증 계획만 준비한다. Production merge, migration 적용,
deploy, lock 해제, 데이터 삭제, 수동 대량 재수집은 별도 명시적 지시 전에는 실행하지 않는다.

## 정책 비교

| 항목 | 변경 전 | 변경 후 |
|---|---:|---:|
| collector/background 최대 | 15/min | 20/min |
| collector 최소 간격 | 4000ms | 3000ms |
| 실행당 실제 외부 호출 | 700 | 900 |
| KST 일일 collect-source 예산 | 3400 | 3400 |
| interactive 예약 | 15/min | 15/min |
| Search operating / hard | 35 / 50/min | 35 / 50/min |
| Global operating / hard | 80 / 100/min | 80 / 100/min |

`COUPANG_COLLECTOR_MAX_PER_MIN`, `COUPANG_COLLECT_MIN_GAP_MS`, `COUPANG_RUN_BUDGET`
기본값은 각각 20, 3000, 900이다. 환경변수로 collector를 더 보수적으로 낮출 수 있다.
이번 단계에서 collector 최대 20, 간격 최소 3000, run 최대 900, day 최대 3400을
코드에서도 고정해 실수로 25/min이나 더 큰 예산을 설정해도 초과하지 않는다.
`COUPANG_MIN_GAP_MS`는 기존 공용/interactive 간격이고 collector 전용 변수와 다르다.

## 안전 계약

- 캐시는 `_coupang.searchCoupang()`에서 슬롯·DB gate보다 먼저 확인한다.
  Cache hit에는 외부 fetch도 DB 호출 예약도 없다.
- `fetchCoupangAll()`은 실제 외부 호출과 in-flight 예약으로 run/day 초과를 막는다.
  HTTP 오류, timeout, 파싱 오류, rCode=400도 실제 호출이면 예산에 포함한다.
- 일일 snapshot 조회 실패/잘못된 count는 collector만 fail-closed로 멈춘다.
- 새 migration의 `coupang_acquire_v2()`는 기존 advisory transaction lock
  `8912042601` 안에서 rolling 60초 Search/global/background 카운터와 KST
  collect-source 3400 카운터를 검사한 뒤 한 행만 예약한다. Pending/error도 포함한다.
  예약 후 fetch 전에 프로세스가 죽으면 DB는 보수적으로 한 슬롯을 소비한다.
- Interactive는 `source='search'`로 Search operating 전량을 쓸 수 있다.
  Background 전체는 20회와 `operating - reserve` 양쪽을 넘을 수 없으며,
  collector 일일 예산 소진은 interactive를 거절하지 않는다.
- 로컬 리미터도 background 몫을 분리한다. 대기 collector는 미래 슬롯을 미리
  예약하지 않아 기존 짧은 간격의 interactive가 먼저 호출할 수 있다. DB에서
  거절한 슬롯은 반환해 반복 background 거절이 사용자 슬롯을 채우지 않게 한다.
  DB 대기 중 circuit가 열리면 예약을 보수적으로 남기고 추가 fetch를 취소한다.
- DB hard cap은 입력 환경변수와 별개로 Search 50/min, 전체 API 100/min이다.
  Supabase 오류/미예약 call ID는 외부 fetch를 허가하지 않는다.
- 잠금 획득 후 시각을 다시 읽고 `called_at`에 그 시각을 명시한다.
  이전의 `clock_timestamp()`/transaction-start `now()` 차이로 생긴 경계 오차를 없앤다.
- 기존 Retry-After, shared cooldown, circuit breaker, 무재시도 정책을 유지한다.
  DB RPC는 invoker·고정 search_path·postgres/service_role 실행 권한을 유지한다.
- ADPICK 설정, 공통 second-pass 630, UI, 상품/가격 이력은 변경하지 않는다.

## 변경 이력 및 읽기 전용 효율 감사

#111에서 Search operating 35와 collector 15를 명시 전달했고, #112에서 collector
간격 6초→4초와 run 500→700을 맞췄다. DB migration의 과거 기본값 20/5는 최신
앱이 명시적으로 전달하는 35/15를 대체하지 않았다. 이번 새 migration만 기본값을
35/20으로 맞추며 이미 적용된 과거 migration은 수정하지 않는다.

#116은 P0 미시도→P1 cache hint→P2 일시 실패→P3 facet/ladder 순서, P4 오늘 가격
보유 건너뛰기, 당일 캐시, 조건부 체크포인트 heartbeat를 도입했다. 현재 collector는
force refresh를 쓰지 않고, 당일 완료 그룹/성공 회수 검색어를 후속 cron에서 재사용한다.
Facet은 그룹당 최대 6회·연속 무수확 2회로 제한한다.

운영 DB 읽기 전용 기준선 (KST, 2026-10-01 조회):

| 날짜 | collector 호출 | 고유 키워드 | 추가 중복 호출 | API 성공 | collect 가격 확보 상품 | 확보 상품/호출 |
|---|---:|---:|---:|---:|---:|---:|
| 09-29 | 3319 | 3038 | 281 | 3312 | 2212 | 0.666 |
| 09-30 | 3400 | 3399 | 1 | 3399 | 2396 | 0.705 |
| 10-01 | 3400 | 3400 | 0 | 3400 | 2359 | 0.694 |

세 날짜의 collector HTTP 429·차단·rCode 오류는 모두 0이다. 별도 external-hotdeal
경로에는 10-01 rCode=400이 1건 있다. API 응답 상품은 약 8개/호출이지만 실제
가격 확보 상품은 약 0.7개/호출이므로 두 지표를 섞지 않는다.
10-01 snapshot은 진행 중이며 쿠팡 대상 5081개, collector 확보 2359개(46.43%),
무매칭 2099개, 옵션 불일치 586개였다. 과거 대상 분모 snapshot이 없어 과거 수집률은 추정하지 않는다.

별도 개선 후보이며 이번 PR에서는 구조를 바꾸지 않는다:

- 같은 실행 도중 교차매칭으로 완료된 뒤쪽 1차 그룹은 호출 직전 uncovered를
  다시 확인하지 않아 불필요한 검색이 발생할 수 있다. 실제 규모부터 측정한다.
- collector 예산/차단 precheck 뒤에는 신선한 캐시 회수도 중단된다.
- 공통 second-pass 630은 회수 위주 실행의 추가 병목이며 ADPICK에도 영향을 준다.
- API limit 10/offset 없음, exact-option 매칭, 50분/자정 마감, cache hint 전체 스캔,
  순차 DB 저장, Actions 예약 지연이 남는다.
- 기존 수동 `scripts/coupang-probe.js`는 DB gate를 거치지 않는 진단 도구다.
  이번 작업에서 실행하거나 변경하지 않았다. 검증 기간에는 이 도구를 사용하지 않고
  기존 로그와 읽기 전용 진단을 사용한다. 전체 수동 진단 통로의 gate 통합은 별도 후속 과제다.

속도상 이론 처리량은 20/15 = 약 33% 늘지만, 하루 호출량은 3400으로 동일하다.
최근 이틀은 이미 일일 예산을 소진했으므로 완료 시각·실행당 처리량 개선이 먼저
나타날 수 있으며 수집률 개선은 중복·매칭률·시간 예산에 달려 있다.

## 환경 설정 감사와 승인 후 적용 순서

GitHub Actions 저장소/환경 변수와 secrets 이름을 확인했다. 기존 쿠팡 quota 숫자
설정은 없으며, workflow에 목표값을 명시해 코드 기본값과 적용값을 맞춘다.
`COUPANG_MAX_PER_MIN`은 최신 모듈에서 읽지 않으므로 override하지 않는다.

Vercel은 연결 teams 조회 결과가 비어 있고 CLI 인증도 없어 실제 production
환경변수 값을 확인하지 못했다. `.vercel/project.json`도 없다. 이 부분은 배포 전
필수 확인 항목이다. 변수 값을 확인/수정하더라도 이 작업에서는 배포하지 않는다.

명시적 승인 후 순서:

1. 기존 minute-quota/search-path migration 적용 상태 확인. 새
   `supabase/migrations/20261001074444_coupang_collector_daily_budget.sql`만 적용하고
   함수 정의·권한·hard cap·daily cap을 읽기 전용으로 다시 확인한다.
   과거 bootstrap/schema.sql을 재실행하지 않는다.
2. Vercel production/preview 및 별도 catch-up 실행 환경을 점검한다.
   Search operating=35, Global operating=80, reserve=15, collector=20인지 확인한다.
   기존 collector=15/run=700/더 느린 gap override가 있으면 승인 범위에서 정리한다.
   새 collector gap 변수와 공용 `COUPANG_MIN_GAP_MS`를 혼동하지 않는다.
3. 승인된 코드/workflow를 적용하고 평소 scheduled cron을 관찰한다.
   추가 대량 재수집·강제 unlock 없이 첫 정상 실행과 3개 완전한 KST 날짜를 비교한다.
4. 문제가 생기면 collector=15, gap=4000, run=700으로 되돌리는 변경을 검토한다.
   Search35/reserve15/day3400/DB hard cap과 신규 DB 안전 보강은 유지한다.

## 관찰 지표와 중단 기준

| 지표 | 관찰 위치/해석 |
|---|---|
| 실제 external calls / 실행당 사용량 | collector 로그 `_coupangCalls`, 공용 모듈 `localStats.calls`; 캐시·거절 제외 |
| Search/background/global rolling calls/min 최고치 | DB `coupang_api_calls.called_at` 기준 정확한 60초 합계; 분 버킷 평균만 사용하지 않음 |
| HTTP 429 / rCode 오류 | 호출 원장 outcome/http_status/r_code와 provider 로그 |
| circuit breaker / Retry-After | provider `차단 감지`, `Retry-After` 로그와 shared state; 호출 원장만으로 발동 횟수를 추정하지 않음 |
| interactive quota denial | Vercel `source=search` SKIP/STALE-CACHE의 gate 거절 이유; DB에는 거절 행이 없음 |
| 사용자 검색 실패율 / latency | 동일 시간대 Vercel `/api/search` 오류율·p50/p95를 기존 기준선과 비교 |
| collector 성공률 / 호출당 회수 | provider API 성공률과 실제 unique exact-option 가격 확보/호출을 별도 계산 |
| 전체 가격 수집률 | 같은 대상 분모·상품 단위 결과 snapshot과 오늘 가격 보유를 비교 |
| 일일 사용량 | KST collect-source 3400; 전체 source 쿠팡 호출량은 별도 지표 |

Search>50/min, Global>100/min, background>20/min, run>900, collect day>3400,
DB gate 오류 후 외부 호출 진행은 즉시 조사/상향 중단 대상이다.
429·API 차단·interactive quota denial이 새로 나타나거나, 사용자 검색 실패 또는
p95 latency가 기존 범위를 벗어나 악화되면 원인을 분석하고 collector 상향을 되돌린다.
관찰을 위해 제공자에게 시험용 실호출을 추가하지 않는다.

## 2차 상향 조건

20→25는 자동으로 하지 않는다. 최소 3개 완전한 KST 날짜와 사용자 피크 구간에서
429=0, API 차단=0, interactive quota denial=0, 사용자 검색 실패/latency 악화 없음,
수집 성공률 개선, 전역 DB gate 정상 작동이 확인돼야 다음 PR을 검토한다.
그때만 Search operating 35→40, collector 20→25, reserve15 유지 및 이번 고정
20 ceiling의 별도 변경을 논의한다. 일일 예산은 별도 판단이며 이번에는3400을 유지한다.

## 자동 검증

`npm test`에 quota·Retry-After·collector 실제 외부 호출 예산 회귀를 포함한다.
실제 localhost HTTP server와 production API 래퍼로 대기 collector보다 interactive가
먼저 호출되고 반복 collector DB 거절 뒤에도 interactive가 허용되는지 확인한다.
`npm run test:coupang-db`는 `COUPANG_QUOTA_TEST_DATABASE_URL`로 지정한 loopback
테스트 서버에 매번 새 전용 DB를 만들고 실제 production SQL과 동시 clients를 실행한다.
Supabase 자격증명을 읽지 않으며 기존 DB/상품/이력을 변경하지 않는다.
CI는 secrets 없는 PostgreSQL 17 service에서 같은 DB 회귀를 항상 실행한다.

로컬 최종 검증 (2026-10-01):

| 명령 | PASS / FAIL |
|---|---:|
| `node scripts/test-coupang-quota.js` | 계약 suite 1 / 0 |
| `node scripts/test-coupang-retry-after.js` | 계약 suite 1 / 0 |
| `node scripts/test-coupang-collector-budget.js` | 41 / 0 |
| `node scripts/test-coupang-interactive-priority.js` | 26 / 0 |
| `npm run test:coupang-db` (격리 localhost PostgreSQL 18.4) | 68 / 0 |
| `node scripts/test-second-pass.js` | 160 / 0 |
| `node scripts/test-round-index.js` | 42 / 0 |
| `node scripts/test-collector-lock.js` | 9 / 0 |
| `node scripts/test-collector-scale.js` | 136 / 0 |
| `node scripts/test-collector-v3.js` | 141 / 0 |
| `node scripts/test-collector-coverage.js` | 117 / 0 |
| `node scripts/verify-migrations.js` | 75 / 0 (운영 자격증명 없음 경고 1) |
| `npm test` | 71개 명령 / 0 실패 |

전체 테스트와 실제 SQL 검증에 production 호출/자격증명은 사용하지 않았다.
