# 가격 하락 함수 적용·롤백 절차 (준비본)

**상태: 미적용.** 이 문서는 절차만 정리한다. 운영 프로젝트 식별, 권한·보안 검토,
별도 운영 승인과 격리 환경 검증 전에는 어떤 DDL도 실행하지 않는다. 기존 상품·가격
이력·뷰를 수정하거나 삭제하지 않는다. 후보 SQL은
[`supabase/2026-11-24-price-drop-for-products.sql`](../../supabase/2026-11-24-price-drop-for-products.sql)이다.

## 적용 전 확인

1. 배포 환경 설정에서 실제 검색 API가 사용할 DB 프로젝트·브랜치·호출 역할을 확인한다.
   `_supabase.js` 기본은 Supabase이며 Neon은 별도 환경변수로 전환한다. 다른 프로젝트에
   함수가 없다는 과거 관찰만으로 현재 운영 대상이 같다고 가정하지 않는다.
2. DB 소유자와 보안 담당자가 범위 및 시간대를 승인하고, 복구·모니터링 담당자와 실행
   환경을 지정한다. 연결 비밀값은 로그나 명령 기록에 남기지 않는다. SQL 원본과 현재
   `price_drop_top`의 정의·컬럼·형식·인덱스를 비교한다. 이미 같은 시그니처의 함수가
   있거나 정의가 변경됐다면 `CREATE OR REPLACE`를 실행하지 말고 중단한다. 다음은
   읽기 전용 확인이다.

   ```sql
   select to_regprocedure('public.price_drop_for_products(text[])') as existing_function;
   select pg_get_viewdef('public.price_drop_top'::regclass, true) as view_definition;
   select table_name, column_name, data_type from information_schema.columns
    where table_schema = 'public' and table_name in ('price_history', 'products', 'price_drop_top')
    order by table_name, ordinal_position;
   ```

3. 독립된 비운영 DB에서 동일한 뷰·권한·데이터 경계(빈 배열, 관측 0/1/2회, 여러
   옵션과 판매처, 중복 행, 최근 30일 경계)를 사용해 설치 및 제거를 시험한다. 함수와
   뷰를 동일한 호출 역할로 양방향 `EXCEPT ALL` 비교하고 결과가 모두 0인지 확인한다.
   같은 날짜에 여러 관측이 있으면 `row_number`의 정렬 동률이 비결정적일 수 있으므로
   반복 비교의 차이를 조사한다. 표본 일치는 전체 동등성 증명이 아니다.
4. Supabase의 `public` 함수는 기본 실행 권한 때문에 Data API에 노출될 수 있다.
   이 함수는 기본 `SECURITY INVOKER`이며 호출 역할의 테이블 권한과 RLS를 따른다.
   앱에 필요한 실제 역할 및 기존 뷰와의 가시성을 확인하고 최소 권한을 검토한다.
   권한 오류를 해결하려고 `SECURITY DEFINER`로 바꾸지 않는다. Neon 역할과 권한은
   별도로 확인한다. PostgREST 스키마 캐시와 Neon 어댑터의 반환 행 제한도 검증한다.
5. 비운영 환경에서 기존 뷰와 실제 함수 호출의 `EXPLAIN (ANALYZE, BUFFERS)` 및
   앱 RPC·네트워크 포함 검색 지연을 같은 ID 묶음으로 비교한다. `EXPLAIN ANALYZE`는
   실제 쿼리를 실행하므로 허용된 읽기 작업량과 비용 한도 안에서만 실시한다.
   2026-11-24 읽기 전용 표본에서 Neon 100 ID/100행, Supabase 34 ID/33행은
   본문과 뷰가 같았다. Neon 18 ID 서버 SQL은 뷰 409.845~423.050ms, 미설치 본문
   0.852~1.075ms였다. 설치된 함수나 전체 검색 응답의 성능을 뜻하지 않는다.

## 승인 후 적용 예시 — 지금 실행하지 않음

대상과 역할을 확인하고 함수가 없는 경우에만 담당자가 격리 환경에서 먼저 검증한 동일
절차를 적용한다. 다음은 **Supabase 서비스 역할을 사용하는 경우의 psql 예시**이며,
`service_role` 등 역할명은 실제 권한 검토 결과와 맞아야 한다. 파일은 psql에서 볼 수
있는 저장소 루트 기준이다. `CREATE`, 공개 실행 권한 회수와 필요한 권한 부여를 같은
트랜잭션에 둬 중간에 공개 함수가 노출되지 않게 한다. 별도 DB에서 다른 역할을 쓴다면
해당 DB에 맞는 실행 권한 계획을 사전에 작성한다.

```sql
\set ON_ERROR_STOP on
BEGIN;
\i supabase/2026-11-24-price-drop-for-products.sql
REVOKE ALL ON FUNCTION public.price_drop_for_products(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.price_drop_for_products(text[]) TO service_role;
COMMIT;
```

적용 후 호출 역할에서 실행 권한과 underlying 테이블/RLS를 확인하고, 비인가 역할이
실행할 수 없는지 확인한다. 아래 표본 비교에서 `'<id-1>'` 등은 승인된 테스트 ID로
바꾸고 같은 배열을 양쪽에 쓴다. 각각의 차이 건수는 0이어야 한다.

```sql
WITH ids AS (SELECT ARRAY['<id-1>', '<id-2>']::text[] AS v),
f AS (SELECT x.* FROM ids, LATERAL public.price_drop_for_products(ids.v) x),
v AS (SELECT p.product_id, p.mall, p.current_price, p.prev_price, p.all_time_low,
             p.drop_amount, p.drop_pct, p.is_all_time_low, p.link
        FROM public.price_drop_top p, ids WHERE p.product_id = ANY(ids.v))
SELECT 'function_only' AS difference, count(*) FROM (SELECT * FROM f EXCEPT ALL SELECT * FROM v) d
UNION ALL
SELECT 'view_only', count(*) FROM (SELECT * FROM v EXCEPT ALL SELECT * FROM f) d;
```

PostgREST에서 실제 앱 역할로 RPC 호출과 뷰 폴백을 확인하고 행·지연·오류율을 관찰한다.
함수 부재를 이미 `dropRpcMissing`으로 기억한 실행 인스턴스는 계속 뷰를 사용할 수 있으므로
안전한 인스턴스 교체 및 스키마 캐시 갱신 방법을 배포 담당자가 별도 계획한다. 승인 없이
환경변수 변경, 배포 또는 DB 함수 호출을 자동화하지 않는다.

## 승인 후 롤백 — 지금 실행하지 않음

1. 운영자가 승인한 설정 변경 및 배포 절차로 `SEOSA_PRICE_DROP_RPC=0`을 적용해 새
   인스턴스가 뷰를 쓰도록 한다. 설정 변경 자체만으로 기존 실행 인스턴스가 즉시 바뀐다고
   가정하지 않는다. 적용·전파 완료와 검색 응답 및 뷰 오류율을 확인한다.
2. 위 적용에서 **새로 만든 함수임이 확인된 경우에만**, 적절한 소유자 권한과 별도 승인으로
   다음을 실행한다. 기존 함수가 있었다면 중단하고 보관한 기존 정의·권한의 복원 계획을
   별도로 검토한다. 함수 삭제는 상품·가격 이력 데이터 삭제가 아니다.

   ```sql
   DROP FUNCTION IF EXISTS public.price_drop_for_products(text[]);
   ```

3. 검색 결과와 오류·지연을 관찰하고 함수가 없을 때 뷰로 전환되는지 확인한다. 예상과
   다르면 추가 변경을 중단하고 담당자가 조사한다. 모든 변경·확인 시각과 실행자를 기록한다.

참고: [Supabase database functions](https://supabase.com/docs/guides/database/functions),
[Securing your API](https://supabase.com/docs/guides/api/securing-your-api),
[CLI v3 변경 사항](https://supabase.com/changelog/supabase-cli-v3).
