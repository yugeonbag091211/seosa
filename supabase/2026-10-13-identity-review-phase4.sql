-- ============================================================================
-- Product Identity Phase 4 — administrator human review queue.
-- Additive only. No products, price_history, or existing canonical rows are changed.
-- ============================================================================

alter table public.canonical_product_groups
  add column if not exists approval_source text not null default 'AUTO_PROMOTION';

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.canonical_product_groups'::regclass
      and conname = 'canonical_product_groups_approval_source_check'
  ) then
    alter table public.canonical_product_groups
      add constraint canonical_product_groups_approval_source_check
      check (approval_source in ('AUTO_PROMOTION', 'HUMAN_REVIEW'));
  end if;
end $$;

create table if not exists public.identity_review_queue (
  id                          bigserial primary key,
  source_shadow_run_id        bigint not null references public.identity_shadow_runs(id),
  source_shadow_group_id      bigint not null references public.identity_shadow_groups(id),
  group_key                   text not null,
  status                      text not null default 'PENDING',
  priority                    text not null default 'LOW',
  reason_codes                text[] not null default '{}',
  promotion_policy_version    text not null,
  matcher_id                  text not null,
  matcher_version             text not null,
  candidate_hash              text not null,
  canonical_identity_snapshot jsonb not null default '{}'::jsonb,
  member_snapshot             jsonb not null default '[]'::jsonb,
  claimed_by                  text,
  claimed_at                  timestamptz,
  claim_expires_at            timestamptz,
  resolution_reason_code      text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  resolved_at                 timestamptz,
  constraint identity_review_queue_status_check
    check (status in ('PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'DEFERRED', 'STALE')),
  constraint identity_review_queue_priority_check check (priority in ('HIGH', 'MEDIUM', 'LOW')),
  constraint identity_review_queue_member_snapshot_check
    check (jsonb_typeof(member_snapshot) = 'array' and jsonb_array_length(member_snapshot) >= 2),
  constraint identity_review_queue_candidate_unique
    unique (group_key, promotion_policy_version, matcher_version, candidate_hash)
);

create index if not exists identity_review_queue_status_priority_idx
  on public.identity_review_queue (status, priority, created_at);
create index if not exists identity_review_queue_source_run_idx
  on public.identity_review_queue (source_shadow_run_id, source_shadow_group_id);

create table if not exists public.identity_review_decisions (
  id                       bigserial primary key,
  review_queue_id          bigint not null references public.identity_review_queue(id),
  decision                 text not null,
  reviewer_identifier      text not null,
  reason_code              text not null,
  note                     text not null default '',
  matcher_version          text not null,
  promotion_policy_version text not null,
  before_snapshot          jsonb not null,
  after_snapshot           jsonb not null,
  created_at               timestamptz not null default now(),
  constraint identity_review_decisions_decision_check
    check (decision in ('APPROVE', 'REJECT', 'DEFER')),
  constraint identity_review_decisions_note_size_check check (length(note) <= 1000)
);

create index if not exists identity_review_decisions_queue_history_idx
  on public.identity_review_decisions (review_queue_id, created_at desc, id desc);
create index if not exists identity_review_decisions_suppression_idx
  on public.identity_review_decisions (decision, matcher_version, promotion_policy_version, review_queue_id);

create or replace function public.identity_review_decisions_immutable()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'identity review decisions are immutable' using errcode = '42501';
end;
$$;
revoke all on function public.identity_review_decisions_immutable() from public, anon, authenticated;

do $$ begin
  if not exists (
    select 1 from pg_catalog.pg_trigger
    where tgrelid = 'public.identity_review_decisions'::regclass
      and tgname = 'identity_review_decisions_no_update' and not tgisinternal
  ) then
    create trigger identity_review_decisions_no_update
      before update or delete on public.identity_review_decisions
      for each row execute function public.identity_review_decisions_immutable();
  end if;
end $$;

create or replace function public.identity_review_resolve(
  p_queue_id bigint,
  p_reviewer text,
  p_decision text,
  p_reason_code text,
  p_note text,
  p_matcher_version text,
  p_candidate_hash text,
  p_member_snapshot jsonb,
  p_after_snapshot jsonb,
  p_canonical_key text,
  p_canonical_identity jsonb,
  p_confidence_tier text,
  p_canonical_members jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_queue public.identity_review_queue%rowtype;
  v_product public.products%rowtype;
  v_member jsonb;
  v_row_count integer;
  v_canonical_id bigint;
  v_new_status text;
  v_before jsonb;
  v_after jsonb;
begin
  select * into v_queue
  from public.identity_review_queue
  where id = p_queue_id
  for update;

  if not found or v_queue.status <> 'IN_REVIEW' or v_queue.claimed_by <> p_reviewer
    or v_queue.claim_expires_at is null or v_queue.claim_expires_at <= pg_catalog.now() then
    return pg_catalog.jsonb_build_object('status', 'CONFLICT');
  end if;
  if p_decision not in ('APPROVE', 'REJECT', 'DEFER') then
    raise exception 'decision not allowed' using errcode = '22023';
  end if;
  if p_note is null or pg_catalog.length(p_note) > 1000 then
    raise exception 'note too long' using errcode = '22023';
  end if;
  if (p_decision = 'APPROVE' and p_reason_code not in (
        'APPROVE_MISSING_ATTRIBUTE_VERIFIED', 'APPROVE_IDENTICAL_MODEL_BY_EXTERNAL_LABEL', 'APPROVE_EXACT_CONFIGURATION'))
    or (p_decision = 'REJECT' and p_reason_code not in (
        'REJECT_DIFFERENT_MODEL', 'REJECT_DIFFERENT_VARIANT', 'REJECT_DIFFERENT_STORAGE', 'REJECT_BUNDLE_DIFFERENCE', 'REJECT_NOT_SAME_PRODUCT'))
    or (p_decision = 'DEFER' and p_reason_code not in (
        'DEFER_INSUFFICIENT_EVIDENCE', 'DEFER_NEED_MODEL_NUMBER', 'DEFER_NEED_OPTION_INFO')) then
    raise exception 'reason code not allowed' using errcode = '22023';
  end if;
  if v_queue.matcher_version <> p_matcher_version
    or v_queue.candidate_hash <> p_candidate_hash
    or v_queue.member_snapshot is distinct from p_member_snapshot then
    update public.identity_review_queue set status = 'STALE', resolved_at = pg_catalog.now(),
      updated_at = pg_catalog.now(), resolution_reason_code = 'STALE_REVIEW_SNAPSHOT_CHANGED'
    where id = v_queue.id;
    return pg_catalog.jsonb_build_object('status', 'STALE');
  end if;

  -- Lock and compare the identity-bearing product columns so a concurrent catalog edit
  -- cannot slip between API revalidation and the canonical write.
  for v_member in select value from pg_catalog.jsonb_array_elements(p_member_snapshot)
  loop
    v_row_count := 0;
    for v_product in select * from public.products
    where product_id = v_member->>'product_id'
      and mall = v_member->>'source_mall'
      and coalesce(vendor_item_id, '') = coalesce(v_member->>'vendor_item_id', '')
    for share
    loop
      v_row_count := v_row_count + 1;
    end loop;
    if v_row_count <> 1
      or v_product.title is distinct from v_member->>'title'
      or coalesce(v_product.mall_label, '') is distinct from coalesce(v_member->>'mall_label', '')
      or coalesce(v_product.vendor_item_id, '') is distinct from coalesce(v_member->>'vendor_item_id', '') then
      update public.identity_review_queue set status = 'STALE', resolved_at = pg_catalog.now(),
        updated_at = pg_catalog.now(), resolution_reason_code = 'STALE_PRODUCT_SNAPSHOT_CHANGED'
      where id = v_queue.id;
      return pg_catalog.jsonb_build_object('status', 'STALE');
    end if;
  end loop;

  if p_decision = 'APPROVE' then
    if p_canonical_key is null or p_canonical_key = '' or p_canonical_identity is null
      or p_confidence_tier not in ('A', 'B')
      or pg_catalog.jsonb_typeof(p_canonical_members) <> 'array'
      or pg_catalog.jsonb_array_length(p_canonical_members) <> pg_catalog.jsonb_array_length(v_queue.member_snapshot) then
      raise exception 'canonical approval payload invalid' using errcode = '22023';
    end if;
    if exists (
      select 1 from public.canonical_product_members cm
      join pg_catalog.jsonb_array_elements(p_canonical_members) m
        on cm.source_mall = m.value->>'source_mall' and cm.product_id = m.value->>'product_id'
    ) then
      return pg_catalog.jsonb_build_object('status', 'CONFLICT_EXISTING_CANONICAL_MEMBERSHIP');
    end if;
    if exists (select 1 from public.canonical_product_groups cg where cg.canonical_key = p_canonical_key) then
      return pg_catalog.jsonb_build_object('status', 'CONFLICT_CANONICAL_KEY_EXISTS');
    end if;
    insert into public.canonical_product_groups (
      canonical_key, status, identity, confidence_tier, promotion_policy_version,
      matcher_id, matcher_version, source_shadow_run_id, suspension_reason_codes, approval_source
    ) values (
      p_canonical_key, 'ACTIVE', p_canonical_identity, p_confidence_tier,
      v_queue.promotion_policy_version, v_queue.matcher_id, v_queue.matcher_version,
      v_queue.source_shadow_run_id, '{}', 'HUMAN_REVIEW'
    ) returning id into v_canonical_id;

    for v_member in select value from pg_catalog.jsonb_array_elements(p_canonical_members)
    loop
      insert into public.canonical_product_members (
        group_id, product_id, source_mall, mall, vendor_item_id, offer_key,
        identity_snapshot, evidence, source_shadow_run_id
      ) values (
        v_canonical_id, v_member->>'product_id', v_member->>'source_mall', v_member->>'mall',
        coalesce(v_member->>'vendor_item_id', ''), v_member->>'offer_key',
        coalesce(v_member->'identity_snapshot', '{}'::jsonb),
        coalesce(v_member->'evidence', '[]'::jsonb), v_queue.source_shadow_run_id
      );
    end loop;
    v_after := coalesce(p_after_snapshot, '{}'::jsonb) || pg_catalog.jsonb_build_object(
      'status', 'APPROVED', 'canonical_group_id', v_canonical_id, 'approval_source', 'HUMAN_REVIEW');
    v_new_status := 'APPROVED';
  elsif p_decision = 'REJECT' then
    v_after := coalesce(p_after_snapshot, '{}'::jsonb) || pg_catalog.jsonb_build_object('status', 'REJECTED');
    v_new_status := 'REJECTED';
  else
    v_after := coalesce(p_after_snapshot, '{}'::jsonb) || pg_catalog.jsonb_build_object('status', 'DEFERRED');
    v_new_status := 'DEFERRED';
  end if;

  v_before := pg_catalog.jsonb_build_object(
    'status', v_queue.status, 'reason_codes', v_queue.reason_codes,
    'canonical_identity_snapshot', v_queue.canonical_identity_snapshot,
    'member_snapshot', v_queue.member_snapshot, 'candidate_hash', v_queue.candidate_hash);
  insert into public.identity_review_decisions (
    review_queue_id, decision, reviewer_identifier, reason_code, note,
    matcher_version, promotion_policy_version, before_snapshot, after_snapshot
  ) values (
    v_queue.id, p_decision, p_reviewer, p_reason_code, p_note,
    v_queue.matcher_version, v_queue.promotion_policy_version, v_before, v_after
  );
  update public.identity_review_queue set status = v_new_status, resolution_reason_code = p_reason_code,
    resolved_at = pg_catalog.now(), updated_at = pg_catalog.now()
  where id = v_queue.id;
  return pg_catalog.jsonb_build_object('status', v_new_status, 'canonical_group_id', v_canonical_id);
end;
$$;

alter table public.identity_review_queue enable row level security;
alter table public.identity_review_decisions enable row level security;
revoke all on table public.identity_review_queue from anon, authenticated;
revoke all on table public.identity_review_decisions from anon, authenticated;
grant select, insert, update on table public.identity_review_queue to service_role;
grant select, insert on table public.identity_review_decisions to service_role;
grant usage, select on sequence public.identity_review_queue_id_seq to service_role;
grant usage, select on sequence public.identity_review_decisions_id_seq to service_role;
revoke all on sequence public.identity_review_queue_id_seq from anon, authenticated;
revoke all on sequence public.identity_review_decisions_id_seq from anon, authenticated;

revoke all on function public.identity_review_resolve(bigint,text,text,text,text,text,text,jsonb,jsonb,text,jsonb,text,jsonb) from public, anon, authenticated;
grant execute on function public.identity_review_resolve(bigint,text,text,text,text,text,text,jsonb,jsonb,text,jsonb,text,jsonb) to service_role;

notify pgrst, 'reload schema';
