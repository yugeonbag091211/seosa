-- 수집기 «캐시 힌트» 를 DB 안에서 고른다 — 검색 캐시를 통째로 내려받지 않는다.
--
-- ── 왜 ────────────────────────────────────────────────────────────────
-- scripts/collect-all-prices.js 의 cacheHintQueries 는 아직 못 잡은 상품을 «예전에 그 상품을
-- 돌려준 검색어» 로 다시 찾는다. 지금은 그걸 위해 coupang_search_cache · adpick_search_cache 의
-- (keyword, items) 를 전부 읽는다. 2026-10-21 Neon 테스트 브랜치에서 잰 텍스트 크기:
--     coupang_search_cache  3,613행  35.0MB
--     adpick_search_cache   2,607행  16.6MB
-- 회수 패스가 도는 실행마다 약 52MB 가 DB 밖으로 나간다. Neon Free 공용망 전송 한도는
-- 월 5GB 다(Supabase Free 도 5GB 였고, 그 한도를 넘겨 서비스가 막혔다).
--
-- 이 함수는 같은 판정을 DB 안에서 하고 «찾는 상품의 (상품 ID, 검색어들)» 만 돌려준다.
--
-- ── 결과가 예전과 «같아야» 하는 이유 · 맞춘 것 ───────────────────────────
-- 수집기는 힌트 목록의 «순서» 대로 검색어를 부른다(예산이 남는 만큼). 그래서 순서도 같아야 한다.
--   · 행 순서   예전 키셋 스캔은 keyword 오름차순(DB 기본 정렬 규칙) → 같은 정렬로 고른다.
--   · 상품 순서 처음 나타난 (keyword, items 안 위치) 순서.
--   · 검색어    앞뒤 공백을 지운 값, 빈 값 제외, 상품별 중복 제외(처음 나온 순서).
--   · 쿠팡 상품 ID   items[].productId 를 문자열로.
--   · ADPICK 상품 ID sha256(commissionlink) 16진수 — api/_shop.adpickProductId 와 같다.
-- 캐시의 «가격» 은 돌려주지 않는다(예전과 같다 — 검색어만 쓴다).
--
-- ── 결과 모양 ─────────────────────────────────────────────────────────
-- jsonb 배열 [[product_id, [검색어, ...]], ...]. 스칼라 하나라 PostgREST db-max-rows(1,000)에
-- 잘리지 않고, jsonb 객체와 달리 순서가 보존된다.
--
-- ── 적용 ──────────────────────────────────────────────────────────────
-- additive. 표·데이터를 바꾸지 않는다. 미적용이면 수집기는 예전 전체 스캔으로 돈다(동작 동일).
-- 같은지 검증: scripts/migration/test-neon-cache-hints.js (트랜잭션 안에서 만들고 되돌린다).
-- 되돌리기: drop function if exists public.search_cache_hints(text, text[]);

create or replace function public.search_cache_hints(p_mall text, p_ids text[])
returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $$
  with want as (
    select distinct w.pid from unnest(p_ids) as w(pid) where w.pid is not null and w.pid <> ''
  ),
  hits as (
    select c.keyword as raw_kw, btrim(c.keyword) as kw, e.ord, (e.v ->> 'productId') as pid
      from public.coupang_search_cache c
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(c.items) = 'array' then c.items else '[]'::jsonb end
      ) with ordinality as e(v, ord)
     where p_mall = '쿠팡'
    union all
    select c.keyword, btrim(c.keyword), e.ord,
           encode(sha256(convert_to(e.v ->> 'commissionlink', 'UTF8')), 'hex')
      from public.adpick_search_cache c
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(c.items) = 'array' then c.items else '[]'::jsonb end
      ) with ordinality as e(v, ord)
     where p_mall = 'ADPICK' and coalesce(e.v ->> 'commissionlink', '') <> ''
  ),
  matched as (
    select h.* from hits h join want w on w.pid = h.pid where h.kw <> ''
  ),
  firsts as (
    select pid, raw_kw, ord
      from (select pid, raw_kw, ord, row_number() over (partition by pid order by raw_kw, ord) as rn from matched) x
     where rn = 1
  ),
  keywords as (
    select pid, jsonb_agg(kw order by first_raw) as kws
      from (select pid, kw, min(raw_kw) as first_raw from matched group by pid, kw) y
     group by pid
  )
  select coalesce(jsonb_agg(jsonb_build_array(f.pid, k.kws) order by f.raw_kw, f.ord), '[]'::jsonb)
    from firsts f join keywords k using (pid)
$$;

comment on function public.search_cache_hints(text, text[]) is
  'Collector cache hints computed in-DB: [[product_id, [keyword...]]] in the order the legacy keyset scan produced. Read-only.';

revoke all on function public.search_cache_hints(text, text[]) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.search_cache_hints(text, text[]) to service_role';
  end if;
end $$;
