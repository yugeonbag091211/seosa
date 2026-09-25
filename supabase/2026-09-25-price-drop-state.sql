-- ══════════════════════════════════════════════════════════════════
--  2026-09-25  가격 하락 조회를 «요청마다 30일 재계산» 에서 «세대별 상태표» 로
--
--  ★ 데이터를 지우지 않는다. 새 표 둘(price_drop_state · price_drop_state_meta),
--    시퀀스 하나, 함수들, 뷰 하나(price_drop_top_fast)를 더할 뿐이다.
--    price_history · products · 기존 뷰 price_drop_top 은 한 줄도 바꾸지 않는다.
--    가격 수집 경로(트리거 포함)에 아무것도 걸지 않는다.
--    전부 if not exists / or replace 라 여러 번 실행해도 안전하다.
--
--  ★ 적용만으로는 아무것도 바뀌지 않는다. /api/init 은 PRICE_DROP_SOURCE=state
--    일 때만 새 뷰를 읽는다. 운영 순서는 docs/seosa2/price-drop-state.md.
-- ══════════════════════════════════════════════════════════════════

-- ── 무엇이 터졌나 (운영 실측) ─────────────────────────────────────
--   /api/init 의 select … from price_drop_top order by drop_pct desc limit 200 이
--   #84 뒤에도 3/3 HTTP 500 (8,642–8,688 ms, SQLSTATE 57014). PR #86 RPC 도 7초에 취소.
--   둘 다 «요청마다 price_history 최근 30일 전체를 옵션별로 순위 매기는» 계산이 남아 있었다.
--
-- ── 무엇으로 바꾸는가 ─────────────────────────────────────────────
--   옵션 키 (product_id, mall, vendor_item_id) 마다 한 행: 최신·직전 관측(날짜·가격),
--   전체 기간 최저가, 하락률. 기존 뷰의 30일 창은 아래로만 막혀 있으므로
--   «전체 중 최신 2개» 의 직전 관측이 창 안이면 곧 «창 안의 최신 2개» 다 →
--   창은 조회 시점에 prev_date >= current_date - 30 으로만 건다.
--
-- ── 왜 «세대(gen)» 인가 — 원자적 전체 재구성 ─────────────────────
--   전체 재구성은 PostgREST 한도 때문에 여러 트랜잭션(배치)으로 나뉜다. 같은 표를
--   제자리에서 고치면 재구성 도중(특히 빈 표에서 시작할 때) 절반만 채운 결과가 보인다.
--   그래서 재구성은 새 세대 번호로 쓰고, 읽기(price_drop_top_fast)는 메타의
--   published_gen 행만 본다. 모든 배치가 끝나고 검증 게이트를 통과했을 때만
--   published_gen 한 칸을 바꾼다(한 행 UPDATE = 원자적). 직전 세대는 남겨 두어
--   price_drop_state_rollback_publish() 로 즉시 되돌린다.
--   비교한 다른 방식:
--     · staging 표 → 한 트랜잭션에서 delete+insert 복사: 공개 때마다 전체 복사·팽창
--     · 표 RENAME 교체: 뷰는 OID 로 묶여 이름을 따라가지 않고, ACCESS EXCLUSIVE 잠금
--     · 구체화 뷰 REFRESH CONCURRENTLY: 배치로 못 나누고 매번 8초+ 전체 계산
--
-- ── 증분으로 정확히 따라가는 변경 / 탐지해서 재구성으로 넘기는 변경 ──
--   증분(price_drop_state_refresh_recent)은 «고른 상품을 원장에서 통째로 다시 계산» 한다.
--   고르는 기준:
--     · recorded_date >= current_date - p_days  → 수집기·/api/search 의 오늘 기록, 같은 날 재수집
--     · id > id_watermark - 10000               → 과거 날짜 가져오기(backfill)까지 모든 INSERT
--   원장에 흔적이 남지 않는 변경은 탐지한다:
--     · 삭제: pg_stat_user_tables.n_tup_del 이 늘면 needs_rebuild
--     · 과거 행 수정(가격 정정·옵션 번호 변경): 표본 검증(price_drop_state_verify)이
--       어긋남을 찾으면 needs_rebuild. 표본에 안 걸린 수정은 일일 전체 재구성이 상한(≤1일)
--   needs_rebuild 이면 갱신 스크립트가 원자적 전체 재구성을 돈다.
--
-- ── 기존 뷰와 같은 결과인가 ───────────────────────────────────────
--   · vendor_item_id = '__LEGACY__' 와 NULL 은 빠진다
--   · recorded_date 가 NULL 인 관측은 순위에서 빠지지만 최저가에는 들어간다
--   · (product_id, mall, vendor_item_id, recorded_date) UNIQUE 라 같은 날 동률이 없다
--   · drop_pct 산식, is_all_time_low, products 내부 조인 그대로

begin;
set local lock_timeout = '2s';

-- 첫 판(세대 없는 상태표)을 적용한 테스트 환경이면 멈춘다 — 파생 데이터라 ROLLBACK 뒤 다시 적용.
do $$
begin
  if to_regclass('public.price_drop_state') is not null
     and not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'price_drop_state' and column_name = 'gen') then
    raise exception 'price_drop_state 첫 판이 있다 — supabase/2026-09-25-price-drop-state.ROLLBACK.sql 을 먼저 실행할 것 (원장에서 다시 만드는 파생 데이터라 잃는 것이 없다)';
  end if;
end $$;

-- ── 1. 표 ──────────────────────────────────────────────────────────
create sequence if not exists public.price_drop_state_gen_seq;

create table if not exists public.price_drop_state (
  gen             bigint      not null,
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
  primary key (gen, product_id, mall, vendor_item_id)
);
comment on table public.price_drop_state is
  '옵션 키별 최신·직전 관측과 전체 최저가 (세대별). price_history 에서 다시 계산만 한다(원본 아님). '
  '읽기는 price_drop_top_fast (published_gen 만).';

-- 홈 «가격 하락» 상위 200 — 공개 세대 안에서 drop_pct 내림차순으로 읽고 멈춘다.
create index if not exists price_drop_state_rank_idx
  on public.price_drop_state (gen, drop_pct desc)
  where prev_date is not null;

create table if not exists public.price_drop_state_meta (
  id                   integer     primary key default 1 check (id = 1),
  published_gen        bigint,
  previous_gen         bigint,
  building_gen         bigint,
  building_owner       text,
  building_cursor      text,
  building_done        boolean     not null default false,
  building_started     timestamptz,
  building_heartbeat   timestamptz,
  building_max_id      bigint,
  building_del_count   bigint,
  id_watermark         bigint,
  del_count_seen       bigint,
  needs_rebuild        boolean     not null default true,
  needs_rebuild_reason text        not null default 'not initialized',
  needs_rebuild_at     timestamptz not null default now(),
  last_recent_at       timestamptz,
  last_recent_ms       integer,
  last_recent_products integer,
  last_publish_at      timestamptz,
  last_publish         jsonb,
  last_verify_at       timestamptz,
  last_verify          jsonb
);
insert into public.price_drop_state_meta (id) values (1) on conflict (id) do nothing;

alter table public.price_drop_state enable row level security;
alter table public.price_drop_state_meta enable row level security;
revoke all on table public.price_drop_state from public, anon, authenticated;
revoke all on table public.price_drop_state_meta from public, anon, authenticated;
revoke all on sequence public.price_drop_state_gen_seq from public, anon, authenticated;
grant select, insert, update, delete on table public.price_drop_state to service_role;
grant select, update on table public.price_drop_state_meta to service_role;
grant usage, select on sequence public.price_drop_state_gen_seq to service_role;

-- ── 2. 상품 묶음 하나를 원장에서 다시 계산해 세대 p_gen 에 쓴다 ────
--   (product_id, …) 로 시작하는 기존 인덱스를 탄다 — 원장 전체를 훑지 않는다.
--   값이 같으면 쓰지 않는다. 한 문장(데이터 변경 CTE)이라 같은 스냅숏에서 계산·삭제·upsert.
create or replace function public.price_drop_state_apply(p_gen bigint, p_product_ids text[])
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
  if p_gen is null or p_product_ids is null or cardinality(p_product_ids) = 0 then
    return jsonb_build_object('upserted', 0, 'deleted', 0);
  end if;

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
  -- 지울 키 = (이 상품들의 기존 키) − (다시 계산한 키). EXCEPT(해시)로 구한다.
  -- NOT EXISTS (… from calc) 로 쓰면 CTE 행 수 추정이 틀려 중첩 루프가 되고,
  -- 운영 규모 합성 데이터에서 증분 갱신이 0.3초 → 13초로 느려졌다.
  gone as (
    select s.product_id, s.mall, s.vendor_item_id
      from public.price_drop_state s
     where s.gen = p_gen and s.product_id = any(p_product_ids)
    except
    select c.product_id, c.mall, c.vendor_item_id from calc c
  ),
  removed as (
    delete from public.price_drop_state d
     using gone g
     where d.gen = p_gen
       and d.product_id = g.product_id and d.mall = g.mall and d.vendor_item_id = g.vendor_item_id
    returning 1
  ),
  written as (
    -- order by: 동시 실행이 생겨도 같은 순서로 잠가 교착을 피한다.
    insert into public.price_drop_state as d
           (gen, product_id, mall, vendor_item_id, latest_date, latest_price, prev_date, prev_price,
            all_time_low, drop_pct, computed_at)
    select p_gen, c.product_id, c.mall, c.vendor_item_id, c.latest_date, c.latest_price, c.prev_date, c.prev_price,
           c.all_time_low, c.drop_pct, now()
      from calc c
     order by c.product_id, c.mall, c.vendor_item_id
    on conflict (gen, product_id, mall, vendor_item_id) do update
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

-- 원장 삭제 누계 (pg_stat). 늘었으면 증분이 볼 수 없는 삭제가 있었다는 뜻이다.
create or replace function public.price_drop_state_del_count()
returns bigint
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select coalesce((select n_tup_del from pg_catalog.pg_stat_user_tables
                    where relid = 'public.price_history'::regclass), 0)::bigint;
$$;

-- ── 3. 표본 검증 — 기존 뷰를 부르지 않는다 ────────────────────────
--   고른 키마다 price_history 에서 그 키의 행만(인덱스) 읽어 독립적으로 다시 계산해 대조한다.
--   표본: 사용자에게 보이는 상위(drop_pct) · 무작위 · 30일 경계 ±1일 · 최근 원장 기록(누락 탐지).
--   «대기 중»(id_watermark 뒤 새 행, 마지막 증분 뒤 recorded_at) 키는 어긋나도 따로 센다 —
--   아직 증분이 안 돈 것일 뿐 잘못된 공개가 아니다.
--   공개 세대에서 어긋남(대기 제외)이 나오면 needs_rebuild 를 세운다 (p_record=false 면 아무것도 쓰지 않는다).
create or replace function public.price_drop_state_verify(p_gen bigint default null, p_sample integer default 100,
                                                           p_record boolean default true)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '30s'
as $$
declare
  m        public.price_drop_state_meta%rowtype;
  v_gen    bigint;
  v_n      integer := least(greatest(coalesce(p_sample, 100), 1), 1000);
  v_out    jsonb;
  v_view   bigint;
  v_expect bigint;
begin
  select * into m from public.price_drop_state_meta where id = 1;
  v_gen := coalesce(p_gen, m.published_gen);
  if v_gen is null then
    return jsonb_build_object('ok', false, 'reason', 'no generation');
  end if;

  with keys as (
    (select s.product_id, s.mall, s.vendor_item_id, 'top' as src
       from public.price_drop_state s
      where s.gen = v_gen and s.prev_date is not null and s.prev_date >= current_date - 30
      order by s.drop_pct desc limit v_n)
    union
    (select s.product_id, s.mall, s.vendor_item_id, 'random'
       from public.price_drop_state s where s.gen = v_gen order by random() limit v_n)
    union
    (select s.product_id, s.mall, s.vendor_item_id, 'boundary'
       from public.price_drop_state s
      where s.gen = v_gen and s.prev_date between current_date - 31 and current_date - 29 limit v_n)
    union
    (select h.product_id, h.mall, h.vendor_item_id, 'ledger'
       from public.price_history h
      where h.recorded_date >= current_date - 1 and h.vendor_item_id <> '__LEGACY__'
      order by h.id desc limit v_n)
  ),
  k as (select distinct product_id, mall, vendor_item_id from keys),
  chk as (
    select k.product_id, k.mall, k.vendor_item_id,
           s.product_id is not null as in_state,
           s.latest_date, s.latest_price, s.prev_date, s.prev_price, s.all_time_low, s.drop_pct,
           e.latest_date as e_latest_date, e.latest_price as e_latest_price,
           e.prev_date as e_prev_date, e.prev_price as e_prev_price, lo.low as e_low,
           pend.pending
      from k
      left join public.price_drop_state s
        on s.gen = v_gen and s.product_id = k.product_id and s.mall = k.mall and s.vendor_item_id = k.vendor_item_id
      cross join lateral (
        select max(t.recorded_date) filter (where t.rn = 1) as latest_date,
               max(t.price)         filter (where t.rn = 1) as latest_price,
               max(t.recorded_date) filter (where t.rn = 2) as prev_date,
               max(t.price)         filter (where t.rn = 2) as prev_price
          from (select h.price, h.recorded_date, row_number() over (order by h.recorded_date desc) as rn
                  from public.price_history h
                 where h.product_id = k.product_id and h.mall = k.mall and h.vendor_item_id = k.vendor_item_id
                   and h.recorded_date is not null
                 order by h.recorded_date desc
                 limit 2) t
      ) e
      cross join lateral (
        select min(h.price) as low from public.price_history h
         where h.product_id = k.product_id and h.mall = k.mall and h.vendor_item_id = k.vendor_item_id
           and h.vendor_item_id <> '__LEGACY__'
      ) lo
      cross join lateral (
        select exists (
          select 1 from public.price_history h
           where h.product_id = k.product_id and h.mall = k.mall and h.vendor_item_id = k.vendor_item_id
             and (h.id > coalesce(m.id_watermark, 0) or h.recorded_at > coalesce(m.last_recent_at, '-infinity'::timestamptz))
        ) as pending
      ) pend
  ),
  judged as (
    select c.*,
           case
             when c.e_latest_date is null and not c.in_state then null
             when c.e_latest_date is null then 'extra'
             when not c.in_state then 'missing'
             when (c.latest_date, c.latest_price, c.prev_date, c.prev_price, c.all_time_low)
                  is distinct from (c.e_latest_date, c.e_latest_price, c.e_prev_date, c.e_prev_price, c.e_low)
               then 'values'
             when c.drop_pct is distinct from (
                    case when c.e_prev_price > 0 and c.e_latest_price < c.e_prev_price
                         then round((1.0 - c.e_latest_price::numeric / c.e_prev_price::numeric) * 100::numeric, 1)
                         else 0::numeric end)
               then 'drop_pct'
             else null
           end as kind
      from chk c
  )
  select jsonb_build_object(
           'gen', v_gen,
           'checked', count(*),
           'mismatches', count(*) filter (where kind is not null and not pending),
           'pending', count(*) filter (where kind is not null and pending),
           'kinds', coalesce(jsonb_object_agg(kind, n) filter (where kind is not null), '{}'::jsonb),
           'examples', coalesce((select jsonb_agg(x) from (
               select jsonb_build_object('product_id', j.product_id, 'mall', j.mall, 'vendor_item_id', j.vendor_item_id,
                                         'kind', j.kind, 'pending', j.pending,
                                         'state', jsonb_build_array(j.latest_date, j.latest_price, j.prev_date, j.prev_price, j.all_time_low),
                                         'ledger', jsonb_build_array(j.e_latest_date, j.e_latest_price, j.e_prev_date, j.e_prev_price, j.e_low)) as x
                 from judged j where j.kind is not null limit 10) q), '[]'::jsonb),
           'products', coalesce((select jsonb_agg(distinct j.product_id) from judged j where j.kind is not null), '[]'::jsonb))
    into v_out
    from (select kind, pending, count(*) over (partition by kind) as n from judged) z;

  -- 공개 결과의 중복: products 조인이 한 키를 여러 행으로 늘리지 않는가
  select count(*) into v_view
    from public.price_drop_state s
    join public.products p on p.product_id = s.product_id and p.mall = s.mall
   where s.gen = v_gen and s.prev_date >= current_date - 30;
  select count(*) into v_expect
    from public.price_drop_state s
   where s.gen = v_gen and s.prev_date >= current_date - 30
     and exists (select 1 from public.products p where p.product_id = s.product_id and p.mall = s.mall);
  v_out := v_out || jsonb_build_object('window_rows', v_expect, 'joined_rows', v_view,
                                       'duplicates', v_view - v_expect);
  v_out := v_out || jsonb_build_object('ok', (v_out->>'mismatches')::int = 0 and v_view = v_expect);

  if p_record and v_gen = m.published_gen then
    update public.price_drop_state_meta
       set last_verify_at = now(), last_verify = v_out,
           needs_rebuild = needs_rebuild or not (v_out->>'ok')::boolean,
           needs_rebuild_reason = case when (v_out->>'ok')::boolean then needs_rebuild_reason
                                       else 'verify mismatch: ' || (v_out->>'kinds') end,
           needs_rebuild_at = case when (v_out->>'ok')::boolean or needs_rebuild then needs_rebuild_at else now() end
     where id = 1;
  end if;
  return v_out;
end;
$$;

-- ── 4. 증분 ───────────────────────────────────────────────────────
--   공개 세대(와 재구성 중인 세대)에 최근 기록된 상품 · id 워터마크 뒤 INSERT 된 상품을 다시 계산.
--   ★ 재구성 배치·공개와 같은 권고 잠금(대기형)으로 한 번에 하나만 쓴다 — 서로 다른 스냅숏의
--     계산이 뒤섞여 오래된 값이 새 값을 덮는 일을 막는다. 중복 크론은 줄을 서서 차례로 돈다(멱등).
create or replace function public.price_drop_state_refresh_recent(p_days integer default 2, p_id_overlap integer default 10000)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '60s'
as $$
declare
  m         public.price_drop_state_meta%rowtype;
  v_started timestamptz := clock_timestamp();
  v_max     bigint;
  v_ids     text[];
  v_pub     jsonb;
  v_build   jsonb := null;
  v_del     bigint;
  v_ms      integer;
begin
  perform pg_advisory_xact_lock(hashtext('price_drop_state')::bigint);
  select * into m from public.price_drop_state_meta where id = 1 for update;
  if m.published_gen is null then
    return jsonb_build_object('refreshed', false, 'reason', 'not initialized', 'needs_rebuild', true);
  end if;

  select coalesce(max(h.id), 0) into v_max from public.price_history h;
  select array_agg(distinct x.product_id order by x.product_id) into v_ids
    from (
      select h.product_id from public.price_history h
       where h.recorded_date >= current_date - greatest(coalesce(p_days, 2), 1)
      union
      -- 과거 날짜 가져오기까지. 커밋 순서가 id 순서와 다를 수 있어 p_id_overlap(기본 10,000)행을
      -- 겹쳐 다시 본다(멱등). 운영 수집은 하루 약 5천 행이라 이틀 치 여유다.
      select h.product_id from public.price_history h
       where h.id > coalesce(m.id_watermark, v_max) - greatest(coalesce(p_id_overlap, 10000), 0)
    ) x;

  v_pub := public.price_drop_state_apply(m.published_gen, coalesce(v_ids, '{}'::text[]));
  if m.building_gen is not null then
    v_build := public.price_drop_state_apply(m.building_gen, coalesce(v_ids, '{}'::text[]));
  end if;

  v_del := public.price_drop_state_del_count();
  v_ms := (extract(epoch from clock_timestamp() - v_started) * 1000)::integer;
  update public.price_drop_state_meta
     set id_watermark = v_max,
         last_recent_at = v_started, last_recent_ms = v_ms,
         last_recent_products = coalesce(cardinality(v_ids), 0),
         needs_rebuild = needs_rebuild or (del_count_seen is not null and v_del <> del_count_seen),
         needs_rebuild_reason = case
           when needs_rebuild then needs_rebuild_reason
           when del_count_seen is not null and v_del <> del_count_seen
             then format('price_history 삭제 탐지 (n_tup_del %s → %s)', del_count_seen, v_del)
           else needs_rebuild_reason end,
         needs_rebuild_at = case
           when not needs_rebuild and del_count_seen is not null and v_del <> del_count_seen then now()
           else needs_rebuild_at end
   where id = 1;

  select * into m from public.price_drop_state_meta where id = 1;
  return jsonb_build_object('refreshed', true, 'gen', m.published_gen, 'products', coalesce(cardinality(v_ids), 0),
                            'published', v_pub, 'building', v_build, 'elapsed_ms', v_ms,
                            'needs_rebuild', m.needs_rebuild, 'needs_rebuild_reason', m.needs_rebuild_reason);
end;
$$;

-- ── 5. 원자적 전체 재구성: 시작 → 배치 → 공개 ─────────────────────
--   소유 토큰(p_owner)과 하트비트로 «한 번에 한 재구성» 을 지킨다.
--   · 다른 소유자가 10분 안에 하트비트를 남겼으면 busy (중복 크론)
--   · 10분 넘게 조용하면 멈춘 것으로 보고 커서에서 이어받는다 (중간 장애)
--   · 빼앗긴 쪽의 다음 배치는 'lost build ownership' 로 실패한다
create or replace function public.price_drop_state_rebuild_start(p_owner text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '30s'
as $$
declare
  m     public.price_drop_state_meta%rowtype;
  v_gen bigint;
begin
  if coalesce(p_owner, '') = '' then raise exception 'price_drop_state: owner required'; end if;
  select * into m from public.price_drop_state_meta where id = 1 for update;
  if m.building_gen is not null then
    if m.building_owner = p_owner then
      return jsonb_build_object('started', true, 'gen', m.building_gen, 'cursor', m.building_cursor, 'resumed', true);
    end if;
    if m.building_heartbeat > now() - interval '10 minutes' then
      return jsonb_build_object('started', false, 'busy', true, 'gen', m.building_gen,
                                'heartbeat', m.building_heartbeat);
    end if;
    update public.price_drop_state_meta
       set building_owner = p_owner, building_heartbeat = now()
     where id = 1;
    return jsonb_build_object('started', true, 'gen', m.building_gen, 'cursor', m.building_cursor,
                              'resumed', true, 'takeover', true);
  end if;

  v_gen := nextval('public.price_drop_state_gen_seq');
  update public.price_drop_state_meta
     set building_gen = v_gen, building_owner = p_owner, building_cursor = '', building_done = false,
         building_started = now(), building_heartbeat = now(),
         building_max_id = (select coalesce(max(h.id), 0) from public.price_history h),
         building_del_count = public.price_drop_state_del_count()
   where id = 1;
  return jsonb_build_object('started', true, 'gen', v_gen, 'cursor', '', 'resumed', false);
end;
$$;

create or replace function public.price_drop_state_rebuild_step(p_gen bigint, p_owner text, p_limit integer default 3000)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '60s'
as $$
declare
  m        public.price_drop_state_meta%rowtype;
  v_limit  integer := least(greatest(coalesce(p_limit, 3000), 1), 20000);
  v_ids    text[];
  v_last   text;
  v_final  boolean;
  v_gone   integer := 0;
  v_result jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('price_drop_state')::bigint);
  select * into m from public.price_drop_state_meta where id = 1 for update;
  if m.building_gen is distinct from p_gen or m.building_owner is distinct from p_owner then
    raise exception 'price_drop_state: lost build ownership (gen %, owner %)', p_gen, p_owner;
  end if;
  if m.building_done then
    return jsonb_build_object('done', true, 'gen', p_gen, 'products', 0);
  end if;

  select array_agg(x.product_id order by x.product_id) into v_ids
    from (select distinct h.product_id from public.price_history h
           where h.product_id > coalesce(m.building_cursor, '')
           order by h.product_id limit v_limit) x;
  v_final := coalesce(cardinality(v_ids), 0) < v_limit;
  v_last := case when v_ids is null then null else v_ids[cardinality(v_ids)] end;

  -- 이 구간에서 원장에서 통째로 사라진 상품 (증분이 이 세대에 써 두었을 수 있다)
  delete from public.price_drop_state d
   where d.gen = p_gen and d.product_id > coalesce(m.building_cursor, '')
     and (v_final or d.product_id <= v_last)
     and (v_ids is null or d.product_id <> all(v_ids));
  get diagnostics v_gone = row_count;

  v_result := public.price_drop_state_apply(p_gen, coalesce(v_ids, '{}'::text[]));

  update public.price_drop_state_meta
     set building_cursor = coalesce(v_last, building_cursor), building_done = v_final, building_heartbeat = now()
   where id = 1;
  return v_result || jsonb_build_object('done', v_final, 'gen', p_gen, 'products', coalesce(cardinality(v_ids), 0),
                                        'removed', v_gone, 'cursor', coalesce(v_last, m.building_cursor));
end;
$$;

--   공개 게이트 — 전부 통과해야만 published_gen 을 바꾼다. 하나라도 실패하면 예외(롤백)로
--   기존 공개 세대는 그대로이고 재구성 세대도 남는다(원인 확인 뒤 다시 공개하거나 abort).
--     1) 모든 배치 완료
--     2) 따라잡기: 재구성 시작 뒤 기록된 상품(최근 창 ∪ 시작 시 max id 뒤 INSERT)을 다시 계산
--     3) 행 수: 공개 중인 세대의 p_min_ratio 미만으로 줄면 거부 (반쪽 재구성 방지)
--     4) 표본 검증: 어긋난 상품을 한 번 다시 계산한 뒤에도(동시 쓰기 흡수) 어긋나면 거부
create or replace function public.price_drop_state_publish(p_gen bigint, p_owner text, p_min_ratio numeric default 0.9,
                                                            p_id_overlap integer default 10000)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '60s'
as $$
declare
  m          public.price_drop_state_meta%rowtype;
  v_max      bigint;
  v_ids      text[];
  v_catchup  jsonb;
  v_new      bigint;
  v_old      bigint;
  v_check    jsonb;
  v_retry    jsonb := null;
  v_fix      text[];
  v_cleaned  integer := 0;
  v_info     jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('price_drop_state')::bigint);
  select * into m from public.price_drop_state_meta where id = 1 for update;
  if m.building_gen is distinct from p_gen or m.building_owner is distinct from p_owner then
    raise exception 'price_drop_state: lost build ownership (gen %, owner %)', p_gen, p_owner;
  end if;
  if not m.building_done then
    raise exception 'price_drop_state: build % is not finished (cursor %)', p_gen, m.building_cursor;
  end if;

  select coalesce(max(h.id), 0) into v_max from public.price_history h;
  select array_agg(distinct x.product_id order by x.product_id) into v_ids
    from (select h.product_id from public.price_history h where h.recorded_date >= current_date - 2
          union
          select h.product_id from public.price_history h
           where h.id > coalesce(m.building_max_id, 0) - greatest(coalesce(p_id_overlap, 10000), 0)) x;
  v_catchup := public.price_drop_state_apply(p_gen, coalesce(v_ids, '{}'::text[]));

  select count(*) into v_new from public.price_drop_state where gen = p_gen;
  select count(*) into v_old from public.price_drop_state where gen = m.published_gen;
  if m.published_gen is not null and v_old > 0 and v_new < v_old * coalesce(p_min_ratio, 0.9) then
    raise exception 'price_drop_state: publish refused — rows % < % × % (gen % vs %)',
      v_new, v_old, p_min_ratio, p_gen, m.published_gen;
  end if;

  v_check := public.price_drop_state_verify(p_gen, 200);
  if (v_check->>'mismatches')::int + (v_check->>'pending')::int > 0 then
    select array_agg(value #>> '{}') into v_fix from jsonb_array_elements(v_check->'products');
    perform public.price_drop_state_apply(p_gen, coalesce(v_fix, '{}'::text[]));
    v_retry := public.price_drop_state_verify(p_gen, 200);
    if (v_retry->>'mismatches')::int > 0 then
      raise exception 'price_drop_state: publish refused — verify mismatches %', v_retry->'kinds';
    end if;
  end if;
  if (coalesce(v_retry, v_check)->>'duplicates')::int <> 0 then
    raise exception 'price_drop_state: publish refused — duplicate rows after products join';
  end if;

  -- 공개 세대·직전 세대만 남긴다
  delete from public.price_drop_state
   where gen <> p_gen and gen is distinct from m.published_gen;
  get diagnostics v_cleaned = row_count;

  v_info := jsonb_build_object('gen', p_gen, 'previous', m.published_gen, 'rows', v_new, 'previous_rows', v_old,
                               'catchup', v_catchup, 'verify', coalesce(v_retry, v_check), 'cleaned', v_cleaned,
                               'started', m.building_started, 'published_at', now());
  update public.price_drop_state_meta
     set previous_gen = published_gen, published_gen = p_gen,
         building_gen = null, building_owner = null, building_cursor = null, building_done = false,
         building_heartbeat = null,
         id_watermark = v_max,
         del_count_seen = building_del_count,
         -- 재구성 시작 «뒤» 에 세운 needs_rebuild 는 이 재구성이 해결하지 못했을 수 있다 → 남긴다
         needs_rebuild = needs_rebuild and needs_rebuild_at > building_started,
         last_publish_at = now(), last_publish = v_info
   where id = 1;
  return v_info;
end;
$$;

-- 직전 세대로 즉시 되돌린다 (새 세대가 틀렸다고 판단될 때). 재구성 없이 한 행 UPDATE.
create or replace function public.price_drop_state_rollback_publish()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  m public.price_drop_state_meta%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('price_drop_state')::bigint);
  select * into m from public.price_drop_state_meta where id = 1 for update;
  if m.previous_gen is null or not exists (select 1 from public.price_drop_state where gen = m.previous_gen) then
    raise exception 'price_drop_state: no previous generation to roll back to';
  end if;
  update public.price_drop_state_meta
     set published_gen = m.previous_gen, previous_gen = m.published_gen,
         needs_rebuild = true, needs_rebuild_reason = 'rolled back publish', needs_rebuild_at = now()
   where id = 1;
  return jsonb_build_object('published_gen', m.previous_gen, 'previous_gen', m.published_gen);
end;
$$;

-- 진행 중인 재구성을 버린다 (공개 세대는 그대로).
create or replace function public.price_drop_state_abort_build()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
set statement_timeout = '60s'
as $$
declare
  m public.price_drop_state_meta%rowtype;
  v_n integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('price_drop_state')::bigint);
  select * into m from public.price_drop_state_meta where id = 1 for update;
  if m.building_gen is null then return jsonb_build_object('aborted', false); end if;
  delete from public.price_drop_state where gen = m.building_gen;
  get diagnostics v_n = row_count;
  update public.price_drop_state_meta
     set building_gen = null, building_owner = null, building_cursor = null, building_done = false,
         building_heartbeat = null
   where id = 1;
  return jsonb_build_object('aborted', true, 'gen', m.building_gen, 'rows', v_n);
end;
$$;

revoke execute on function public.price_drop_state_apply(bigint, text[]) from public, anon, authenticated;
revoke execute on function public.price_drop_state_del_count() from public, anon, authenticated;
revoke execute on function public.price_drop_state_verify(bigint, integer, boolean) from public, anon, authenticated;
revoke execute on function public.price_drop_state_refresh_recent(integer, integer) from public, anon, authenticated;
revoke execute on function public.price_drop_state_rebuild_start(text) from public, anon, authenticated;
revoke execute on function public.price_drop_state_rebuild_step(bigint, text, integer) from public, anon, authenticated;
revoke execute on function public.price_drop_state_publish(bigint, text, numeric, integer) from public, anon, authenticated;
revoke execute on function public.price_drop_state_rollback_publish() from public, anon, authenticated;
revoke execute on function public.price_drop_state_abort_build() from public, anon, authenticated;
grant execute on function public.price_drop_state_apply(bigint, text[]) to service_role;
grant execute on function public.price_drop_state_del_count() to service_role;
grant execute on function public.price_drop_state_verify(bigint, integer, boolean) to service_role;
grant execute on function public.price_drop_state_refresh_recent(integer, integer) to service_role;
grant execute on function public.price_drop_state_rebuild_start(text) to service_role;
grant execute on function public.price_drop_state_rebuild_step(bigint, text, integer) to service_role;
grant execute on function public.price_drop_state_publish(bigint, text, numeric, integer) to service_role;
grant execute on function public.price_drop_state_rollback_publish() to service_role;
grant execute on function public.price_drop_state_abort_build() to service_role;

-- ── 6. 읽기: 기존 price_drop_top 과 같은 12컬럼, 공개 세대만 ───────
--   세대는 스칼라 부분질의로 고른다 — 상수처럼 인덱스 (gen, drop_pct desc) 를 타고 200행에서 멈춘다.
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
where s.gen = (select m.published_gen from public.price_drop_state_meta m where m.id = 1)
  and s.prev_date is not null
  and s.prev_date >= current_date - 30;

revoke all on table public.price_drop_top_fast from public, anon, authenticated;
grant select on table public.price_drop_top_fast to service_role;

commit;

notify pgrst, 'reload schema';
