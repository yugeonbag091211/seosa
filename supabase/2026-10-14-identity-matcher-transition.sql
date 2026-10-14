-- ============================================================================
-- Product Identity — canonical matcher transition (2026-10-14)
--
-- 왜 필요한가
--   Phase 5 소비자는 ACTIVE 그룹 구성원의 저장된 식별 스냅숏·canonical 키가 «지금 파서» 의 결과와
--   같을 때만 그 그룹을 보여 준다(fail-closed). matcher 가 바뀌면(PR #141) 같은 제목의 스냅숏·키가
--   달라지므로, 배포 순간 기존 ACTIVE 그룹이 화면에서 사라진다.
--
-- 방식 — 다음 버전을 «옆에» 두고, 두 버전을 모두 검증해 읽는다
--   STAGE     새 matcher 로 전부 재검증(all-pairs MATCH)한 그룹에만 next_* 를 채운다.
--             기존 canonical_key · identity · identity_snapshot 은 건드리지 않는다 → 지금 운영 코드는 영향 없다.
--   (배포)    새 소비자는 «현재 스냅숏 == 저장 스냅숏» 이면 기존 값, 아니면 «현재 스냅숏 == next 스냅숏» 일 때
--             next 값으로 검증해 보여 준다. 둘 다 아니면 fail-closed.
--   FINALIZE  next_* 를 기존 자리로 옮기고 이전 값은 previous_* 에 남긴다(한 트랜잭션).
--   ABORT     FINALIZE 전에 next_* 를 지운다.
--   REVERT    FINALIZE 뒤 되돌린다 — previous_* 를 기존 자리로, 지금 값을 next_* 로(옛 코드·새 코드 모두 읽힌다).
--
-- 안전장치
--   · additive only — 컬럼은 모두 nullable, 표 하나·함수 다섯 추가. products · price_history 를 바꾸지 않는다.
--   · 모든 쓰기는 compare-and-set: 그룹 행 for update, 구성원 집합·스냅숏·상품 제목(for share)이 계획과 같을 때만.
--   · 키 충돌(다른 그룹의 canonical_key / next_canonical_key)은 거절한다.
--   · rollout_key 는 처음 키로 고정된다 — 키가 바뀌어도 rollout 비율·허용 목록 노출이 넓어지거나 끊기지 않는다.
--   · 감사 기록(canonical_identity_transitions)은 수정·삭제할 수 없다.
--   · 함수는 service_role 전용, search_path 고정.
-- ============================================================================

alter table public.canonical_product_groups
  add column if not exists rollout_key text,
  add column if not exists next_canonical_key text,
  add column if not exists next_identity jsonb,
  add column if not exists next_confidence_tier text,
  add column if not exists next_matcher_version text,
  add column if not exists next_plan_hash text,
  add column if not exists next_staged_at timestamptz,
  add column if not exists previous_canonical_key text,
  add column if not exists previous_identity jsonb,
  add column if not exists previous_confidence_tier text,
  add column if not exists previous_matcher_version text,
  add column if not exists transitioned_at timestamptz;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.canonical_product_groups'::regclass
      and conname = 'canonical_product_groups_next_tier_check'
  ) then
    alter table public.canonical_product_groups
      add constraint canonical_product_groups_next_tier_check
      check (next_confidence_tier is null or next_confidence_tier in ('A', 'B'));
  end if;
  -- next_* 는 전부 있거나 전부 없다 — 반쯤 쓰인 다음 버전을 소비자가 읽지 않게.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.canonical_product_groups'::regclass
      and conname = 'canonical_product_groups_next_complete_check'
  ) then
    alter table public.canonical_product_groups
      add constraint canonical_product_groups_next_complete_check
      check (
        (next_canonical_key is null) = (next_identity is null)
        and (next_canonical_key is null) = (next_confidence_tier is null)
        and (next_canonical_key is null) = (next_matcher_version is null)
        and (next_canonical_key is null) = (next_plan_hash is null)
      );
  end if;
end $$;

create unique index if not exists canonical_product_groups_next_key_idx
  on public.canonical_product_groups (next_canonical_key)
  where next_canonical_key is not null;

alter table public.canonical_product_members
  add column if not exists next_identity_snapshot jsonb,
  add column if not exists previous_identity_snapshot jsonb;

create table if not exists public.canonical_identity_transitions (
  id                     bigserial primary key,
  group_id               bigint not null references public.canonical_product_groups(id),
  action                 text not null,
  from_canonical_key     text not null,
  to_canonical_key       text not null,
  from_matcher_version   text,
  to_matcher_version     text,
  plan_hash              text,
  operator_identifier    text not null,
  member_snapshot        jsonb not null default '[]'::jsonb,
  created_at             timestamptz not null default now(),
  constraint canonical_identity_transitions_action_check
    check (action in ('STAGE', 'FINALIZE', 'ABORT', 'REVERT'))
);

create index if not exists canonical_identity_transitions_group_idx
  on public.canonical_identity_transitions (group_id, created_at desc);

create or replace function public.canonical_identity_transitions_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'canonical identity transition audit is append-only' using errcode = '42501';
end;
$$;
revoke all on function public.canonical_identity_transitions_immutable() from public, anon, authenticated;

do $$ begin
  if not exists (
    select 1 from pg_catalog.pg_trigger
    where tgrelid = 'public.canonical_identity_transitions'::regclass
      and tgname = 'canonical_identity_transitions_no_change' and not tgisinternal
  ) then
    create trigger canonical_identity_transitions_no_change
      before update or delete on public.canonical_identity_transitions
      for each row execute function public.canonical_identity_transitions_immutable();
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- STAGE — 다음 버전만 쓴다. canonical_key · identity · identity_snapshot 은 그대로다.
-- p_members: [{offer_key, source_mall, product_id, vendor_item_id, title,
--              identity_snapshot(지금 저장값과 같아야 함), next_identity_snapshot}]
-- ----------------------------------------------------------------------------
create or replace function public.canonical_identity_transition_stage(
  p_group_id bigint,
  p_expected_canonical_key text,
  p_next_canonical_key text,
  p_next_identity jsonb,
  p_next_confidence_tier text,
  p_next_matcher_version text,
  p_plan_hash text,
  p_operator text,
  p_members jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_group public.canonical_product_groups%rowtype;
  v_row public.canonical_product_members%rowtype;
  v_product public.products%rowtype;
  v_member jsonb;
  v_count integer;
begin
  if p_operator is null or p_operator = '' or p_plan_hash is null or p_plan_hash = ''
    or p_next_canonical_key is null or p_next_canonical_key = '' or p_next_identity is null
    or p_next_confidence_tier is null or p_next_confidence_tier not in ('A', 'B')
    or p_next_matcher_version is null or p_next_matcher_version = ''
    or p_members is null or pg_catalog.jsonb_typeof(p_members) <> 'array' then
    raise exception 'canonical transition payload invalid' using errcode = '22023';
  end if;

  select * into v_group
  from public.canonical_product_groups
  where id = p_group_id
  for update;
  if not found or v_group.status <> 'ACTIVE' or v_group.canonical_key <> p_expected_canonical_key then
    return pg_catalog.jsonb_build_object('status', 'CONFLICT_GROUP_CHANGED');
  end if;
  if v_group.next_canonical_key is not null then
    if v_group.next_canonical_key = p_next_canonical_key and v_group.next_plan_hash = p_plan_hash then
      return pg_catalog.jsonb_build_object('status', 'ALREADY_STAGED');
    end if;
    return pg_catalog.jsonb_build_object('status', 'CONFLICT_ALREADY_STAGED');
  end if;

  perform 1 from public.canonical_product_members where group_id = p_group_id for update;
  select count(*) into v_count from public.canonical_product_members where group_id = p_group_id;
  if v_count < 2 or v_count <> pg_catalog.jsonb_array_length(p_members) then
    return pg_catalog.jsonb_build_object('status', 'CONFLICT_MEMBER_SET_CHANGED');
  end if;

  for v_member in select value from pg_catalog.jsonb_array_elements(p_members)
  loop
    select * into v_row
    from public.canonical_product_members
    where group_id = p_group_id and offer_key = v_member->>'offer_key';
    if not found
      or v_row.source_mall is distinct from v_member->>'source_mall'
      or v_row.product_id is distinct from v_member->>'product_id'
      or v_row.vendor_item_id is distinct from coalesce(v_member->>'vendor_item_id', '')
      or v_row.identity_snapshot is distinct from v_member->'identity_snapshot'
      or pg_catalog.jsonb_typeof(v_member->'next_identity_snapshot') is distinct from 'object' then
      return pg_catalog.jsonb_build_object('status', 'CONFLICT_MEMBER_SET_CHANGED');
    end if;
    select * into v_product
    from public.products
    where mall = v_row.source_mall and product_id = v_row.product_id
    for share;
    if not found
      or v_product.title is distinct from v_member->>'title'
      or coalesce(v_product.vendor_item_id, '') is distinct from coalesce(v_member->>'vendor_item_id', '') then
      return pg_catalog.jsonb_build_object('status', 'STALE_PRODUCT_CHANGED');
    end if;
  end loop;

  if exists (
    select 1 from public.canonical_product_groups cg
    where cg.id <> p_group_id
      and (cg.canonical_key = p_next_canonical_key or cg.next_canonical_key = p_next_canonical_key)
  ) then
    return pg_catalog.jsonb_build_object('status', 'CONFLICT_CANONICAL_KEY_EXISTS');
  end if;

  update public.canonical_product_groups
  set next_canonical_key = p_next_canonical_key,
      next_identity = p_next_identity,
      next_confidence_tier = p_next_confidence_tier,
      next_matcher_version = p_next_matcher_version,
      next_plan_hash = p_plan_hash,
      next_staged_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  where id = p_group_id;

  for v_member in select value from pg_catalog.jsonb_array_elements(p_members)
  loop
    update public.canonical_product_members
    set next_identity_snapshot = v_member->'next_identity_snapshot'
    where group_id = p_group_id and offer_key = v_member->>'offer_key';
  end loop;

  insert into public.canonical_identity_transitions (
    group_id, action, from_canonical_key, to_canonical_key, from_matcher_version, to_matcher_version,
    plan_hash, operator_identifier, member_snapshot
  ) values (
    p_group_id, 'STAGE', v_group.canonical_key, p_next_canonical_key, v_group.matcher_version,
    p_next_matcher_version, p_plan_hash, p_operator, p_members
  );
  return pg_catalog.jsonb_build_object('status', 'STAGED');
end;
$$;

-- ----------------------------------------------------------------------------
-- FINALIZE — next_* 를 기존 자리로. 이전 값은 previous_* 에. rollout_key 는 처음 키로 고정.
-- UPDATE 의 오른쪽 식은 모두 «바꾸기 전» 행 값을 읽는다(동시 대입).
-- ----------------------------------------------------------------------------
create or replace function public.canonical_identity_transition_finalize(
  p_group_id bigint,
  p_expected_next_canonical_key text,
  p_expected_plan_hash text,
  p_operator text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_group public.canonical_product_groups%rowtype;
  v_missing integer;
  v_members jsonb;
begin
  if p_operator is null or p_operator = '' then
    raise exception 'canonical transition operator missing' using errcode = '22023';
  end if;
  select * into v_group
  from public.canonical_product_groups
  where id = p_group_id
  for update;
  if not found or v_group.status <> 'ACTIVE'
    or v_group.next_canonical_key is distinct from p_expected_next_canonical_key
    or v_group.next_plan_hash is distinct from p_expected_plan_hash then
    return pg_catalog.jsonb_build_object('status', 'CONFLICT_NOT_STAGED');
  end if;

  perform 1 from public.canonical_product_members where group_id = p_group_id for update;
  select count(*) into v_missing
  from public.canonical_product_members
  where group_id = p_group_id and next_identity_snapshot is null;
  if v_missing > 0 then
    return pg_catalog.jsonb_build_object('status', 'CONFLICT_MEMBER_SET_CHANGED');
  end if;
  if exists (
    select 1 from public.canonical_product_groups cg
    where cg.id <> p_group_id and cg.canonical_key = v_group.next_canonical_key
  ) then
    return pg_catalog.jsonb_build_object('status', 'CONFLICT_CANONICAL_KEY_EXISTS');
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'offer_key', offer_key, 'identity_snapshot', identity_snapshot)), '[]'::jsonb)
  into v_members
  from public.canonical_product_members where group_id = p_group_id;

  insert into public.canonical_identity_transitions (
    group_id, action, from_canonical_key, to_canonical_key, from_matcher_version, to_matcher_version,
    plan_hash, operator_identifier, member_snapshot
  ) values (
    p_group_id, 'FINALIZE', v_group.canonical_key, v_group.next_canonical_key, v_group.matcher_version,
    v_group.next_matcher_version, v_group.next_plan_hash, p_operator, v_members
  );

  update public.canonical_product_groups
  set rollout_key = coalesce(rollout_key, canonical_key),
      previous_canonical_key = canonical_key,
      previous_identity = identity,
      previous_confidence_tier = confidence_tier,
      previous_matcher_version = matcher_version,
      canonical_key = next_canonical_key,
      identity = next_identity,
      confidence_tier = next_confidence_tier,
      matcher_version = next_matcher_version,
      next_canonical_key = null,
      next_identity = null,
      next_confidence_tier = null,
      next_matcher_version = null,
      next_plan_hash = null,
      next_staged_at = null,
      transitioned_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  where id = p_group_id;

  update public.canonical_product_members
  set previous_identity_snapshot = identity_snapshot,
      identity_snapshot = next_identity_snapshot,
      next_identity_snapshot = null
  where group_id = p_group_id;
  return pg_catalog.jsonb_build_object('status', 'FINALIZED');
end;
$$;

-- ----------------------------------------------------------------------------
-- ABORT — FINALIZE 전에 다음 버전을 지운다(기존 값은 처음부터 그대로다).
-- ----------------------------------------------------------------------------
create or replace function public.canonical_identity_transition_abort(
  p_group_id bigint,
  p_expected_next_canonical_key text,
  p_operator text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_group public.canonical_product_groups%rowtype;
begin
  if p_operator is null or p_operator = '' then
    raise exception 'canonical transition operator missing' using errcode = '22023';
  end if;
  select * into v_group
  from public.canonical_product_groups
  where id = p_group_id
  for update;
  if not found or v_group.next_canonical_key is distinct from p_expected_next_canonical_key then
    return pg_catalog.jsonb_build_object('status', 'CONFLICT_NOT_STAGED');
  end if;
  perform 1 from public.canonical_product_members where group_id = p_group_id for update;

  insert into public.canonical_identity_transitions (
    group_id, action, from_canonical_key, to_canonical_key, from_matcher_version, to_matcher_version,
    plan_hash, operator_identifier
  ) values (
    p_group_id, 'ABORT', v_group.canonical_key, v_group.next_canonical_key, v_group.matcher_version,
    v_group.next_matcher_version, v_group.next_plan_hash, p_operator
  );
  update public.canonical_product_groups
  set next_canonical_key = null, next_identity = null, next_confidence_tier = null,
      next_matcher_version = null, next_plan_hash = null, next_staged_at = null,
      updated_at = pg_catalog.now()
  where id = p_group_id;
  update public.canonical_product_members
  set next_identity_snapshot = null
  where group_id = p_group_id;
  return pg_catalog.jsonb_build_object('status', 'ABORTED');
end;
$$;

-- ----------------------------------------------------------------------------
-- REVERT — FINALIZE 를 되돌린다. previous_* → 기존 자리, 지금 값 → next_*.
-- 되돌린 뒤에는 옛 코드(기존 자리)와 새 코드(next 자리) 모두 이 그룹을 읽는다.
-- ----------------------------------------------------------------------------
create or replace function public.canonical_identity_transition_revert(
  p_group_id bigint,
  p_expected_canonical_key text,
  p_operator text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_group public.canonical_product_groups%rowtype;
  v_missing integer;
  v_members jsonb;
begin
  if p_operator is null or p_operator = '' then
    raise exception 'canonical transition operator missing' using errcode = '22023';
  end if;
  select * into v_group
  from public.canonical_product_groups
  where id = p_group_id
  for update;
  if not found or v_group.status <> 'ACTIVE' or v_group.canonical_key <> p_expected_canonical_key
    or v_group.previous_canonical_key is null or v_group.next_canonical_key is not null then
    return pg_catalog.jsonb_build_object('status', 'CONFLICT_NOT_REVERTIBLE');
  end if;
  perform 1 from public.canonical_product_members where group_id = p_group_id for update;
  select count(*) into v_missing
  from public.canonical_product_members
  where group_id = p_group_id and previous_identity_snapshot is null;
  if v_missing > 0 then
    return pg_catalog.jsonb_build_object('status', 'CONFLICT_MEMBER_SET_CHANGED');
  end if;
  if exists (
    select 1 from public.canonical_product_groups cg
    where cg.id <> p_group_id
      and (cg.canonical_key = v_group.previous_canonical_key or cg.next_canonical_key = v_group.previous_canonical_key)
  ) then
    return pg_catalog.jsonb_build_object('status', 'CONFLICT_CANONICAL_KEY_EXISTS');
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'offer_key', offer_key, 'identity_snapshot', identity_snapshot)), '[]'::jsonb)
  into v_members
  from public.canonical_product_members where group_id = p_group_id;

  insert into public.canonical_identity_transitions (
    group_id, action, from_canonical_key, to_canonical_key, from_matcher_version, to_matcher_version,
    plan_hash, operator_identifier, member_snapshot
  ) values (
    p_group_id, 'REVERT', v_group.canonical_key, v_group.previous_canonical_key, v_group.matcher_version,
    v_group.previous_matcher_version, 'revert', p_operator, v_members
  );

  update public.canonical_product_groups
  set next_canonical_key = canonical_key,
      next_identity = identity,
      next_confidence_tier = confidence_tier,
      next_matcher_version = matcher_version,
      next_plan_hash = 'revert:' || canonical_key,
      next_staged_at = pg_catalog.now(),
      canonical_key = previous_canonical_key,
      identity = previous_identity,
      confidence_tier = previous_confidence_tier,
      matcher_version = previous_matcher_version,
      previous_canonical_key = null,
      previous_identity = null,
      previous_confidence_tier = null,
      previous_matcher_version = null,
      transitioned_at = null,
      updated_at = pg_catalog.now()
  where id = p_group_id;

  update public.canonical_product_members
  set next_identity_snapshot = identity_snapshot,
      identity_snapshot = previous_identity_snapshot,
      previous_identity_snapshot = null
  where group_id = p_group_id;
  return pg_catalog.jsonb_build_object('status', 'REVERTED');
end;
$$;

comment on column public.canonical_product_groups.rollout_key is
  'First canonical key of the group. Rollout percentage and allowlist use it so a matcher transition neither widens nor drops exposure.';
comment on column public.canonical_product_groups.next_canonical_key is
  'Canonical key under the next matcher, staged only after all members re-validated (all-pairs MATCH). Read by the dual-read consumer.';
comment on table public.canonical_identity_transitions is
  'Append-only audit of STAGE / FINALIZE / ABORT / REVERT matcher transitions.';

alter table public.canonical_identity_transitions enable row level security;
revoke all on table public.canonical_identity_transitions from anon, authenticated;
grant select, insert on table public.canonical_identity_transitions to service_role;
revoke all on sequence public.canonical_identity_transitions_id_seq from anon, authenticated;
grant usage, select on sequence public.canonical_identity_transitions_id_seq to service_role;

revoke all on function public.canonical_identity_transition_stage(bigint,text,text,jsonb,text,text,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.canonical_identity_transition_finalize(bigint,text,text,text) from public, anon, authenticated;
revoke all on function public.canonical_identity_transition_abort(bigint,text,text) from public, anon, authenticated;
revoke all on function public.canonical_identity_transition_revert(bigint,text,text) from public, anon, authenticated;
grant execute on function public.canonical_identity_transition_stage(bigint,text,text,jsonb,text,text,text,text,jsonb) to service_role;
grant execute on function public.canonical_identity_transition_finalize(bigint,text,text,text) to service_role;
grant execute on function public.canonical_identity_transition_abort(bigint,text,text) to service_role;
grant execute on function public.canonical_identity_transition_revert(bigint,text,text) to service_role;

notify pgrst, 'reload schema';
