# Supabase 의존성 전수 조사 (2026-10-21)

기준 커밋: `c66e9f4`(main) 위의 `claude/seosa-neon-r2-migration-80da39`. 조사 방법은 정적 탐색과 실측입니다.
- 정적 탐색: `require('./_supabase')`, `@supabase/supabase-js`, `SUPABASE_*`, `/rest/v1|storage/v1`, `.from()/.rpc()` 체인 추적
- 실측: 격리된 Neon 테스트 브랜치(`migration-test-20261020`)의 읽기 전용 스키마 조회

## 1. 결론 요약

| 구분 | 내용 | Neon 전환 방법 | 위험 |
|---|---|---|---|
| DB 접근 | api 29개 + scripts 12개(운영 경로)가 모두 `api/_supabase.js` 프록시를 거쳐 `.from()/.rpc()` 사용 | 프록시 한 곳에서 Neon 호환 계층(`api/_neonpg.js`)으로 교체(스위치) | 낮음: 한 곳만 바뀜 |
| supabase-js 직접 사용 | `api/_global-circuit.js`(AI 공급자 회로) | 같은 스위치로 Neon 클라이언트 사용(수정 완료) | 낮음 |
| Supabase Storage | `api/_imagecache.js`(ADPICK 사진 캐시, 이미 비활성·버킷 미적용) | Neon 모드에서 `storage`가 없어 스스로 꺼짐(동작 동일) | 없음 |
| Supabase Auth | **사용 안 함**. 자체 `auth_codes` + HMAC 토큰 | 변경 불필요 | 없음 |
| Realtime/Edge Functions | 사용 안 함 | — | 없음 |
| RLS/역할 | 45개 표 모두 RLS 켜짐, 정책 0개(서버가 service_role로 우회하던 구조) | Neon `neondb_owner`가 표 소유자이며 BYPASSRLS → 같은 동작 | 낮음 |
| SQL 함수(RPC) | 45개 복원. `auth.uid()`·`request.jwt` 등 Supabase 전용 참조 **0건**(실측) | 그대로 사용 | 낮음 |
| 확장 | `plpgsql`만 사용(pg_net·pg_cron·pg_trgm 없음) | — | 없음 |
| `SUPABASE_SECRET_KEY` | **DB 키이면서 서명 키 재료**. `AUTH_SECRET`이 없으면 로그인 토큰(`_auth`)·AI 서명(`_aicontext`)·**토스 customerKey**(`_billing`)를 이 값으로 파생 | **Vercel에서 지우면 안 됨**(지우면 전원 로그아웃·정기결제 키 불일치) | **높음: 절차로 관리** |
| GitHub Actions | 5개 workflow의 9개 step이 `SUPABASE_URL/SECRET_KEY` 사용 | 저장소 Variables로 켜는 Neon 스위치 추가(기본값은 지금과 동일) | 낮음 |

## 2. 위험도 순 작업 단계(실제 진행 순서)

1. **(완료) 어댑터 충실도**: PostgREST와 같은 값을 돌려주게 수정. 기본 경로(Supabase)에는 영향 없음
2. **(완료) Supabase 직접 의존 모듈**: `_global-circuit`, 진단 출력
3. **(완료) 가격 그래프 R2+Neon 통합**: 기본값 꺼짐, 켜도 실패 시 DB로 대체
4. **(완료) 수집기 스위치·DB 경로 검증**: workflow는 Variables가 비면 지금과 동일
5. **(완료) 전송량 최대 원인 제거**: 캐시 힌트 DB 계산(추가형 SQL, 미적용 시 동작 동일)
6. **(사용자 승인 필요) 전환**: Neon 브랜치 확정 → Vercel/GitHub 환경변수 → 관찰

## 3. 파일별 사용 표·RPC

쓰기 수는 `.insert/.upsert/.update/.delete` 호출 개수입니다.

| 파일 | 표 | RPC | 쓰기 |
|---|---|---|---|
| api/_account.js | subscriptions (+ 동적: 계정 삭제 대상 표들) | | 1 |
| api/_adpick.js | adpick_api_calls, adpick_search_cache | adpick_acquire(`_adpicklimit` 경유) | 2 |
| api/_aicontext.js | products | | 6 |
| api/_analytics.js | ai_usage, daily_metrics (+ 동적 count) | bump_metric, track_visit | 0 |
| api/_auth.js | auth_codes | auth_code_attempt | 9 |
| api/_billing.js | payments, subscriptions | | 11 |
| api/_canonicalconsumer.js | canonical 식별 그룹·구성원 표(Phase 5 승인 소비자), price_history, products | | 0 |
| api/_coupang.js | coupang_search_cache | coupang_acquire_v2, coupang_finish, coupang_block_seconds, coupang_prune, coupang_usage | 2 |
| api/_facets.js | price_drop_top(뷰) | | 0 |
| api/_funnel.js | conversions, funnel_events | | 1 |
| api/_global-circuit.js | (supabase-js 직접) | ai_circuit_gate/fail/success | — |
| api/_identityreview.js | identity_review_queue, products | identity_review_resolve | 4 |
| api/_imagecache.js | (Storage 버킷 product-images) | | — |
| api/_plan.js | subscriptions | | 0 |
| api/_pricestat.js | price_history | | 0 |
| api/_product-page.js | price_history, products | | 0 |
| api/_quality.js | coupang_api_calls (+ 동적) | | 0 |
| api/_radarapi.js | hotdeals, products | | 0 |
| api/_seo-pages.js | price_history, products | seo_sitemap_products | 1 |
| api/_shop.js | price_history, products | | 3 |
| api/_trust.js | price_history | | 0 |
| api/alerts.js | alerts | | 2 |
| api/cron.js | monthly_curation, search_stats | | 0 |
| api/history.js | price_history | | 0 |
| api/hotdeals.js | external_hotdeals, hotdeals, price_history, products | price_history_prior_obs | 0 |
| api/init.js | monthly_curation, price_drop_top, products, search_stats | | 0 |
| api/payment.js | payments, subscriptions | | 1 |
| api/rec.js | products | | 0 |
| api/search.js | products, search_stats | | 0 |
| api/stats.js | search_stats | increment_search_stat | 2 |
| api/sync.js | profiles, user_data(jsonb) | | 2 |
| scripts/collect-all-prices.js | price_history, products, price_job_state, coupang/adpick_api_calls·search_cache, collector_eligible_cache | collector_target_page/products/products_batch, collector_eligible_products, collector_refresh_eligible, search_cache_hints(신규) | 14 |
| scripts/collect-hotdeals.js | hotdeals, hotdeal_job_state, price_history, products | collector_eligible_products | 5 |
| scripts/collect-external-hotdeals.js | external_hotdeals, price_history, products | | 1 |
| scripts/check-alerts.js | alerts, price_history | | 2 |
| scripts/import-conversions.js | conversions | | 1 |
| scripts/run-offer-identity-*.js · run-identity-review-ingest.js · run-canonical-transition.js | identity_shadow_* · canonical 식별 표(승인 워커) · products | canonical 전환 RPC 4종(동적) | 16 |
| scripts/v3-canary-gate.js · observe-cron.js | price_job_state | | 0 |

나머지 scripts 약 20개(감사·검증·백필 도구)도 같은 프록시를 쓰므로 스위치만으로 Neon을 향합니다. 운영 일정에는 포함되지 않습니다.

## 4. 코드가 쓰는 PostgREST 기능과 어댑터 대응

`.from()` 체인 추적으로 확인한 사용 빈도: select 141 · eq 117 · order 55 · in 45 · limit 36 · update 35 · maybeSingle 28 · gte 20 · upsert 16 · range 13 · lt 9 · insert 7 · delete 4 · **abortSignal 4** · gt 4 · or 3 · not 1 · lte 1 · neq 1 · single 1. 관계 임베드·JSON 경로·캐스트를 쓰는 select는 **0건**입니다.

| 기능 | 기존 Neon 어댑터(d03dd63) | 지금 |
|---|---|---|
| `timestamptz`·`date` 값 | JS `Date` 객체 → `.slice()`·문자열 비교가 틀림. 수집기 잠금 CAS가 마이크로초를 잃음 | PostgREST 표기 문자열(`…T…+00:00`, 마이크로초 보존) |
| `int8`·`numeric` 값 | 문자열 → `a.id > b.id` 비교가 틀림 | number |
| jsonb 열에 배열 쓰기 | Postgres 배열 리터럴로 변환 → 22P02(찜·동기화 저장 실패) | 열 타입을 보고 JSON 텍스트로 저장 |
| `abortSignal()` | 없음 → hotdeals가 TypeError | 지원(AbortError 결과) |
| like의 `*` | 미변환(SEO 브랜드 접두 0건) | `%`로 변환 |
| `or()` 조건 수 | 80개 상한 → `/category`·사이트맵 503 | 바인드 한도 안에서 허용 |
| 500행 초과 쓰기 | 예외 | 나눠서 **한 트랜잭션**으로 실행 |
| `onConflict` 없는 upsert | 예외 | 기본키 사용(PostgREST와 같음) |
| `delete/update({count})` | 무시 | 영향 행 수 |
| `single/maybeSingle` 오류 | 자체 코드 | PGRST116 |
| 없는 함수 | 자체 코드 | PGRST202 (`_dberror` FUNCTION_MISSING) |
| RPC 인자 | 타입 추론에 맡김 | 선언 타입으로 캐스트, jsonb는 JSON 텍스트 |
| 행 상한 | 1,000(limit 없을 때만) | 1,000(운영 db-max-rows와 같게, limit가 더 커도) |
| 필터 없는 UPDATE/DELETE | 거절 | 거절(21000, Supabase pg-safeupdate와 같음) |
| 연결 오류 분류 | — | Neon 한도 초과·compute 정지 문구를 일시 장애로 분류 |

## 5. Neon에서 달라지는 운영 특성(코드 밖)

- **세션 설정 불가**: pooled 연결은 startup `options`의 `statement_timeout`을 `08P01`로 거절하고, `statement_timeout` 매개변수는 무시합니다(2026-10-21 실측). 문장 시간 제한은 역할 단위(`ALTER ROLE … SET statement_timeout`)로 걸어야 합니다. 지금 Neon 값은 `0`(무제한)입니다.
- **리전**: Neon은 `aws-ap-southeast-1`(싱가포르), Vercel 함수는 `iad1`(미국 동부)에서 실행 중입니다(운영 `x-vercel-id: icn1::iad1` 실측). 질의 1회 왕복이 서울↔싱가포르 약 75ms, iad1↔싱가포르는 약 200ms+로 추정됩니다. **Vercel 함수 리전을 `sin1`으로 옮기는 것을 권장**합니다(`neon-cutover-env.md`).
- **잠듦**: 5분간 요청이 없으면 compute가 잠들고, 깨어날 때 첫 연결에 수백 ms가 더 듭니다(실측 연결 450~680ms).
