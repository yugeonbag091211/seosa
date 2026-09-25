-- ══════════════════════════════════════════════════════════════════
--  2026-09-25  가격 하락 조회를 «요청마다 30일 재계산» 에서 «옵션별 상태표» 로
--
--  ★ 데이터를 지우지 않는다. 새 표 둘(price_drop_state · price_drop_state_meta),
--    함수 셋, 뷰 하나(price_drop_top_fast)를 더할 뿐이다.
--    price_history · products · 기존 뷰 price_drop_top 은 한 줄도 바꾸지 않는다.
--    가격 수집 경로(트리거 포함)에 아무것도 걸지 않는다.
--    전부 if not exists / or replace 라 여러 번 실행해도 안전하다.
--
--  ★ 적용만으로는 아무것도 바뀌지 않는다. /api/init 은 PRICE_DROP_SOURCE=state
--    일 때만 새 뷰를 읽는다. 순서: 적용 → 전체 재구성(scripts/refresh-price-drop-state.js
--    --full) → VERIFY.sql 로 기존 뷰와 대조 → 환경변수.
-- ══════════════════════════════════════════════════════════════════

-- ── 무엇이 터졌나 (운영 실측) ─────────────────────────────────────
--
--   /api/init 이 홈 첫 화면마다 던지는
--     select … from price_drop_top order by drop_pct desc limit 200
--   이 #84 뷰 교체 뒤에도 3/3 HTTP 500 (8,642–8,688 ms, SQLSTATE 57014).
--   PR #86 의 «상위 후보 먼저» RPC 도 운영에서 7초 한도에 취소됐다.
--   둘 다 «요청 때마다 price_history 의 최근 30일 전체를 옵션별로 순위 매기는»
--   계산을 남겨 두었기 때문이다. 원장이 커질수록 다시 느려진다.
--
-- ── 무엇으로 바꾸는가 ─────────────────────────────────────────────
--
--   옵션 키 (product_id, mall, vendor_item_id) 마다 한 행:
--     latest  = 날짜가 가장 늦은 관측     (price, recorded_date)
--     prev    = 그 바로 앞 관측           (price, recorded_date)
--     all_time_low = 그 키의 전체 기간 최저가
--
--   기존 뷰의 30일 창은 «recorded_date >= current_date - 30 인 관측이 2개 이상일 때
--   가장 늦은 2개» 다. 창은 아래로만 막혀 있으므로 «전체 중 가장 늦은 2개» 의
--   prev 가 창 안에 있으면 둘 다 창 안이고 곧 창의 상위 2개와 같다. prev 가 창
--   밖이면 창에는 관측이 1개 이하라 기존 뷰에서도 빠진다.
--   → 창은 조회 시점에 prev_date >= current_date - 30 으로만 거르면 된다.
--     날짜가 지나 창에서 빠지는 것은 상태표를 다시 쓰지 않아도 조회가 알아서 반영한다.
--
--   상태표가 바뀌어야 하는 때는 «그 키에 관측이 추가·수정·삭제될 때» 뿐이다.
--   수집기(와 /api/search)는 오늘 날짜로만 쓴다 → 최근 며칠에 기록이 있는 상품만
--   원장에서 다시 계산하면 된다(증분). 오래된 날짜를 고치는 일(가져오기·정리
--   스크립트)은 전체 재구성(키셋 배치)이 따라잡는다.
--
--   ★ 원장에서 «다시 계산» 한다 — 이전 상태에 차분을 더하지 않는다.
--     같은 입력이면 몇 번 돌려도 같은 결과(멱등)이고, 어긋나면 재구성이 복구다.
--
-- ── 기존 뷰와 같은 결과인가 (지켜야 할 세부) ─────────────────────
--   · vendor_item_id = '__LEGACY__' 와 NULL 은 빠진다 (기존: vendor_item_id <> '__LEGACY__')
--   · recorded_date 가 NULL 인 관측은 순위(latest/prev)에서 빠지지만 최저가에는 들어간다
--   · (product_id, mall, vendor_item_id, recorded_date) UNIQUE 라 같은 날 동률이 없다
--   · drop_pct 산식, is_all_time_low(현재가 <= 전체 최저가), products 내부 조인 그대로
--   · order by drop_pct desc 의 동률 순서는 기존 뷰도 정해져 있지 않다

begin;
set local lock_timeout = '2s';

-- ── 1. 상태표 ─────────────────────────────────────────────────────
create table if not exists public.price_drop_state (
  product_id      text        not null,
  mall            text        not null,
  vendor_item_id  text        not null,
  latest_date     date        not null,
  latest_price    integer,
  prev_date       date,
  prev_price      integer,
  all_time_low    integer,
  drop_pct        numeric     not null default 0,
  computed_at     timestamptz not null default now(),
  primary key (product_id, mall, vendor_item_id)
);
comment on table public.price_drop_state is
  '옵션 키별 최신·직전 관측과 전체 최저가. price_history 에서 다시 계산만 한다(원본 아님). '
  'price_drop_state_refresh_recent / price_drop_state_rebuild_batch 만 쓴다.';

-- 홈 «가격 하락» 상위 200 — drop_pct 내림차순으로 인덱스를 걸어 멈춘다.
create index if not exists price_drop_state_rank_idx
  on public.price_drop_state (drop_pct desc)
  where prev_date is not null;

-- 갱신 기록 (한 행). 신선도 확인과 재구성 커서.
create table if not exists public.price_drop_state_meta (
  id                  integer     primary key default 1 check (id = 1),
  last_recent_at      timestamptz,
  last_recent_ms      integer,
  last_recent_keys    integer,
  last_full_started   timestamptz,
  last_full_finished  timestamptz,
  full_cursor         text
);
insert into public.price_drop_state_meta (id) values (1) on conflict (id) do nothing;

alter table public.price_drop_state enable row level security;
alter table public.price_drop_state_meta enable row level security;
revoke all on table public.price_drop_state from public, anon, authenticated;
revoke all on table public.price_drop_state_meta from public, anon, authenticated;
grant select, insert, update, delete on table public.price_drop_state to service_role;
grant select, insert, update on table public.price_drop_state_meta to service_role;

-- ── 2. 상품 묶음 하나를 원장에서 다시 계산 ─────────────────────────
--
--   p_product_ids 의 모든 옵션 키를 price_history 에서 다시 계산해 upsert 하고,
--   더 이상 원장에 (날짜 있는) 관측이 없는 키는 지운다.
--   (product_id, …) 로 시작하는 기존 인덱스를 탄다 — 원장 전체를 훑지 않는다.
--   값이 같으면 쓰지 않는다(불필요한 갱신·WAL 을 만들지 않는다).
create or replace function public.price_drop_state_apply(p_product_ids text[])
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_upserted integer := 0;
  v_deleted  integer := 0;
begin
  if p_product_ids is null or cardinality(p_product_ids) = 0 then
    return jsonb_build_object('upserted', 0, 'deleted', 0);
  end if;

  -- 한 문장(데이터 변경 CTE)으로 계산 · 삭제 · upsert 를 같은 스냅숏에서 한다.
  -- 지우는 키(calc 에 없음)와 쓰는 키(calc 에 있음)는 겹치지 않는다.
  with src as (
    select h.product_id, h.mall, h.vendor_item_id, h.price, h.recorded_date
      from public.price_history h
     where h.product_id = any(p_product_ids)
       and h.vendor_item_id <> '__LEGACY__'
  ),
  lows as (
    select s.product_id, s.mall, s.vendor_item_id, min(s.price) as all_time_low
      from src s
     group by s.product_id, s.mall, s.vendor_item_id
  ),
  ranked as (
    select s.product_id, s.mall, s.vendor_item_id, s.price, s.recorded_date,
           row_number() over (
             partition by s.product_id, s.mall, s.vendor_item_id
             order by s.recorded_date desc
           ) as rn
      from src s
     where s.recorded_date is not null
  ),
  top2 as (
    select r.product_id, r.mall, r.vendor_item_id,
           max(r.recorded_date) filter (where r.rn = 1) as latest_date,
           max(r.price)         filter (where r.rn = 1) as latest_price,
           max(r.recorded_date) filter (where r.rn = 2) as prev_date,
           max(r.price)         filter (where r.rn = 2) as prev_price
      from ranked r
     where r.rn <= 2
     group by r.product_id, r.mall, r.vendor_item_id
  ),
  calc as materialized (
    select t.product_id, t.mall, t.vendor_item_id,
           t.latest_date, t.latest_price, t.prev_date, t.prev_price,
           l.all_time_low,
           case
             when t.prev_price > 0 and t.latest_price < t.prev_price
             then round((1.0 - t.latest_price::numeric / t.prev_price::numeric) * 100::numeric, 1)
             else 0::numeric
           end as drop_pct
      from top2 t
      join lows l using (product_id, mall, vendor_item_id)
  ),
  -- 지울 키 = (이 상품들의 기존 상태 키) − (다시 계산한 키). EXCEPT(해시)로 구한다.
  -- NOT EXISTS (… from calc) 로 쓰면 CTE 행 수 추정이 틀려 중첩 루프가 되고,
  -- 운영 규모 합성 데이터에서 증분 갱신이 0.3초 → 13초로 느려졌다.
  gone as (
    select s.product_id, s.mall, s.vendor_item_id
      from public.price_drop_state s
     where s.product_id = any(p_product_ids)
    except
    select c.product_id, c.mall, c.vendor_item_id from calc c
  ),
  removed as (
    delete from public.price_drop_state d
     using gone g
     where d.product_id = g.product_id and d.mall = g.mall and d.vendor_item_id = g.vendor_item_id
    returning 1
  ),
  written as (
    -- order by: 동시 실행이 생겨도 같은 순서로 잠가 교착을 피한다.
    insert into public.price_drop_state as d
           (product_id, mall, vendor_item_id, latest_date, latest_price, prev_date, prev_price,
            all_time_low, drop_pct, computed_at)
    select c.product_id, c.mall, c.vendor_item_id, c.latest_date, c.latest_price, c.prev_date, c.prev_price,
           c.all_time_low, c.drop_pct, now()
      from calc c
     order by c.product_id, c.mall, c.vendor_item_id
    on conflict (product_id, mall, vendor_item_id) do update
       set latest_date = excluded.latest_date, latest_price = excluded.latest_price,
           prev_date = excluded.prev_date, prev_price = excluded.prev_price,
           all_time_low = excluded.all_time_low, drop_pct = excluded.drop_pct,
           computed_at = excluded.computed_at
     where (d.latest_date, d.latest_price, d.prev_date, d.prev_price, d.all_time_low, d.drop_pct)
           is distinct from
           (excluded.latest_date, excluded.latest_price, excluded.prev_date, excluded.prev_price,
            excluded.all_time_low, excluded.drop_pct)
    returning 1
  )
  select (select count(*) from written)::integer, (select count(*) from removed)::integer
    into v_upserted, v_deleted;

  return jsonb_build_object('upserted', v_upserted, 'deleted', v_deleted);
end;
$$;

-- ── 3. 증분: 최근 p_days 일에 기록이 있는 상품만 ───────────────────
--
--   수집기와 /api/search 는 오늘(KST) 날짜로 upsert 한다. recorded_date 가
--   UTC·KST 어느 쪽으로 잘려도 current_date - 2 안에 든다.
--   price_history_recorded_date_idx (recorded_date) 를 탄다.
--   ★ 권고 잠금으로 동시 갱신을 한 번으로 줄인다 (collector_refresh_eligible 과 같은 방식).
create or replace function public.price_drop_state_refresh_recent(p_days integer default 2)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '60s'
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_ids     text[];
  v_result  jsonb;
  v_ms      integer;
begin
  if not pg_try_advisory_xact_lock(hashtext('price_drop_state_refresh')::bigint) then
    return jsonb_build_object('refreshed', false, 'skipped', 'another refresh in progress');
  end if;

  select array_agg(distinct h.product_id order by h.product_id) into v_ids
    from public.price_history h
   where h.recorded_date >= current_date - greatest(coalesce(p_days, 2), 1)
     and h.vendor_item_id <> '__LEGACY__';

  v_result := public.price_drop_state_apply(coalesce(v_ids, '{}'::text[]));
  v_ms := (extract(epoch from clock_timestamp() - v_started) * 1000)::integer;

  update public.price_drop_state_meta
     set last_recent_at = v_started, last_recent_ms = v_ms,
         last_recent_keys = coalesce(cardinality(v_ids), 0)
   where id = 1;

  return v_result || jsonb_build_object('refreshed', true, 'products', coalesce(cardinality(v_ids), 0),
                                        'elapsed_ms', v_ms);
end;
$$;

-- ── 4. 전체 재구성 (복구·초기 적재): product_id 키셋 배치 ─────────
--
--   p_after 다음 product_id 부터 p_limit 개를 다시 계산하고, 그 구간 안에서
--   원장에 더 이상 없는 상품의 상태 행을 지운다. 마지막 배치면 p_after 이후
--   전부를 정리한다. 돌려준 next_after 로 다시 부른다(null 이면 끝).
--   한 번에 한 구간만 다뤄 PostgREST 8초 한도 아래에 머문다.
create or replace function public.price_drop_state_rebuild_batch(
  p_after text default '',
  p_limit integer default 3000
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '60s'
as $$
declare
  v_after  text := coalesce(p_after, '');
  v_limit  integer := least(greatest(coalesce(p_limit, 3000), 1), 20000);
  v_ids    text[];
  v_last   text;
  v_final  boolean;
  v_result jsonb;
  v_gone   integer := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('price_drop_state_refresh')::bigint) then
    return jsonb_build_object('refreshed', false, 'skipped', 'another refresh in progress',
                              'next_after', v_after);
  end if;

  select array_agg(x.product_id order by x.product_id) into v_ids
    from (select distinct h.product_id
            from public.price_history h
           where h.product_id > v_after
           order by h.product_id
           limit v_limit) x;

  v_final := coalesce(cardinality(v_ids), 0) < v_limit;
  v_last := case when v_ids is null then null else v_ids[cardinality(v_ids)] end;

  -- 원장에서 통째로 사라진 상품의 상태 행
  delete from public.price_drop_state d
   where d.product_id > v_after
     and (v_final or d.product_id <= v_last)
     and (v_ids is null or d.product_id <> all(v_ids));
  get diagnostics v_gone = row_count;

  v_result := public.price_drop_state_apply(coalesce(v_ids, '{}'::text[]));

  update public.price_drop_state_meta
     set last_full_started = case when v_after = '' then now() else last_full_started end,
         last_full_finished = case when v_final then now() else last_full_finished end,
         full_cursor = case when v_final then null else v_last end
   where id = 1;

  return v_result || jsonb_build_object(
    'refreshed', true, 'products', coalesce(cardinality(v_ids), 0), 'removed_products_rows', v_gone,
    'next_after', case when v_final then null else v_last end);
end;
$$;

revoke execute on function public.price_drop_state_apply(text[]) from public, anon, authenticated;
revoke execute on function public.price_drop_state_refresh_recent(integer) from public, anon, authenticated;
revoke execute on function public.price_drop_state_rebuild_batch(text, integer) from public, anon, authenticated;
grant execute on function public.price_drop_state_apply(text[]) to service_role;
grant execute on function public.price_drop_state_refresh_recent(integer) to service_role;
grant execute on function public.price_drop_state_rebuild_batch(text, integer) to service_role;

-- ── 5. 읽기: 기존 price_drop_top 과 같은 12컬럼 ───────────────────
--   30일 창은 여기서만 건다 (prev_date 가 창 안 = 창 안 관측 2개 이상).
create or replace view public.price_drop_top_fast
with (security_invoker = true)
as
select
  s.product_id,
  s.mall,
  p.title,
  s.latest_price as current_price,
  s.prev_price,
  s.all_time_low,
  coalesce(s.prev_price - s.latest_price, 0) as drop_amount,
  s.drop_pct,
  s.latest_price <= s.all_time_low as is_all_time_low,
  p.link,
  p.image,
  p.mall_label
from public.price_drop_state s
join public.products p on p.product_id = s.product_id and p.mall = s.mall
where s.prev_date >= current_date - 30;

revoke all on table public.price_drop_top_fast from public, anon, authenticated;
grant select on table public.price_drop_top_fast to service_role;

commit;

notify pgrst, 'reload schema';

-- ── 되돌리기 ──────────────────────────────────────────────────────
--   먼저 Vercel PRICE_DROP_SOURCE 를 지우고(→ /api/init 이 기존 뷰로), 그다음
--   supabase/2026-09-25-price-drop-state.ROLLBACK.sql. 원장·상품·기존 뷰는 그대로다.
