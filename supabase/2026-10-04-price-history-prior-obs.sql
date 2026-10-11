-- ══════════════════════════════════════════════════════════════════
--  2026-10-04  홈 «오늘의 하락» 의 직전 관측을 소수 호출로 (읽기 전용 함수 1개)
--
--  ★ 데이터를 바꾸지 않는다. 표·인덱스·행을 만들거나 지우지 않는다.
--    STABLE 함수 하나를 더할 뿐이다. create or replace 라 몇 번 실행해도 안전하다.
--  ★ 적용 전에도 사이트는 그대로 돈다. 함수가 없으면 api/hotdeals.js 가
--    product_id 조각 조회(동시 6 · 시간 예산 · 초과 시 취소)로 폴백한다.
--  ★ 쓰기 잠금이 없다 — 수집 cron 시간대(KST 00~08시)에 실행해도 된다.
-- ══════════════════════════════════════════════════════════════════

-- ── 왜 필요한가 ───────────────────────────────────────────────────────
--
--   view=today-drop 은 오늘 관측된 계열마다 «오늘 이전의 가장 최근 관측» 이
--   필요하다. PostgREST 로는 계열별 «마지막 한 행» 을 고를 수 없어서,
--   상품 id 를 URL 에 실어 조각 단위로 원장 행을 통째로 받아 JS 에서 골랐다.
--   2026-10-04 독립 리뷰(Codex) 측정:
--     오늘 4,136 id → 79 질의 · 최대 12,000 id → 214 질의 · 동시 25
--   이 함수는 DISTINCT ON 으로 계열당 한 행만 돌려준다. id 는 POST 본문으로
--   가므로 URL 길이 제한도 없다 → 500 id 당 1 호출.
--
-- ── 판정 규칙 ─────────────────────────────────────────────────────────
--
--   계열 = (product_id, mall, vendor_item_id) — price_history 의 저장 단위와 같다.
--   p_since ≤ recorded_at < p_before 중 가장 최근 한 행.
--   api/hotdeals.js pickPriorRows 가 JS 에서 하던 선택과 같다.

create or replace function public.price_history_prior_obs(
  p_ids    text[],
  p_before timestamptz,
  p_since  timestamptz
)
returns setof public.price_history
language sql
stable
security invoker
set search_path = public
set statement_timeout = '5s'
as $$
  select distinct on (h.product_id, h.mall, h.vendor_item_id) h.*
    from public.price_history h
   where h.product_id = any(p_ids)
     and h.recorded_at <  p_before
     and h.recorded_at >= p_since
   order by h.product_id, h.mall, h.vendor_item_id, h.recorded_at desc
$$;

revoke execute on function public.price_history_prior_obs(text[], timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.price_history_prior_obs(text[], timestamptz, timestamptz)
  to service_role;

-- PostgREST 가 새 함수를 바로 보게 한다 (없으면 수 분 뒤에 반영된다).
notify pgrst, 'reload schema';

-- ── 확인 (적용 후, 읽기 전용) ───────────────────────────────────────
--   select count(*) from public.price_history_prior_obs(
--     array['<오늘 관측된 product_id 몇 개>'], now() - interval '1 day', now() - interval '9 days');
--   → 계열당 한 행 이하.
--
-- ── 되돌리기 ──────────────────────────────────────────────────────
--   drop function if exists public.price_history_prior_obs(text[], timestamptz, timestamptz);
--   notify pgrst, 'reload schema';
--   (함수만 사라진다. 오늘의 하락은 자동으로 조각 조회 폴백으로 돌아간다.)
