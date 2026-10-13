-- ============================================================================
-- Product Identity Phase 3 — high-confidence canonical promotion
--
-- Additive, server-only candidate tables. This migration does not change or
-- reference products or price_history, and no application consumer is added.
-- ============================================================================

create table if not exists public.canonical_product_groups (
  id                         bigserial primary key,
  canonical_key              text not null unique,
  status                     text not null default 'SUSPENDED',
  identity                   jsonb not null default '{}'::jsonb,
  confidence_tier            text not null,
  promotion_policy_version   text not null,
  matcher_id                 text not null,
  matcher_version            text not null,
  source_shadow_run_id       bigint not null references public.identity_shadow_runs(id),
  suspension_reason_codes    text[] not null default '{}',
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  constraint canonical_product_groups_status_check
    check (status in ('ACTIVE', 'SUSPENDED', 'SUPERSEDED')),
  constraint canonical_product_groups_tier_check
    check (confidence_tier in ('A', 'B'))
);

create index if not exists canonical_product_groups_status_idx
  on public.canonical_product_groups (status, updated_at desc);

create table if not exists public.canonical_product_members (
  id                       bigserial primary key,
  group_id                 bigint not null references public.canonical_product_groups(id) on delete cascade,
  product_id               text not null,
  source_mall              text not null,
  mall                     text not null,
  vendor_item_id           text not null default '',
  offer_key                text not null,
  identity_snapshot        jsonb not null default '{}'::jsonb,
  evidence                 jsonb not null default '[]'::jsonb,
  source_shadow_run_id     bigint not null references public.identity_shadow_runs(id),
  created_at               timestamptz not null default now(),
  constraint canonical_product_members_product_once_idx
    unique (source_mall, product_id)
);

create index if not exists canonical_product_members_group_idx
  on public.canonical_product_members (group_id);
create index if not exists canonical_product_members_offer_idx
  on public.canonical_product_members (offer_key);

create table if not exists public.canonical_product_promotions (
  id                       bigserial primary key,
  shadow_run_id            bigint not null references public.identity_shadow_runs(id),
  shadow_group_id          bigint references public.identity_shadow_groups(id),
  evaluation_key           text not null,
  canonical_group_id       bigint references public.canonical_product_groups(id),
  decision                 text not null,
  reason_codes             text[] not null default '{}',
  policy_version           text not null,
  matcher_id               text not null,
  matcher_version          text not null,
  evaluated_at             timestamptz not null default now(),
  created_at               timestamptz not null default now(),
  constraint canonical_product_promotions_decision_check
    check (decision in ('PROMOTE', 'HOLD', 'REJECT')),
  constraint canonical_product_promotions_run_eval_policy_idx
    unique (shadow_run_id, evaluation_key, policy_version)
);

create index if not exists canonical_product_promotions_group_idx
  on public.canonical_product_promotions (canonical_group_id, evaluated_at desc);
create index if not exists canonical_product_promotions_decision_idx
  on public.canonical_product_promotions (decision, evaluated_at desc);

comment on table public.canonical_product_groups is
  'Phase 3 production-candidate product groups. No search, AI, detail, price, hotdeal, or mobile consumer reads this table.';
comment on column public.canonical_product_groups.canonical_key is
  'Deterministic SHA-256 of an exact strong identifier and known, normalized identity attributes; unknown fields are omitted.';
comment on table public.canonical_product_members is
  'Products-row references and identity evidence only; no products or price_history row is modified or referenced by FK.';
comment on table public.canonical_product_promotions is
  'Idempotent PROMOTE/HOLD/REJECT decisions and suspension evidence for each evaluated shadow candidate.';

alter table public.canonical_product_groups enable row level security;
alter table public.canonical_product_members enable row level security;
alter table public.canonical_product_promotions enable row level security;

revoke all on table public.canonical_product_groups from anon, authenticated;
revoke all on table public.canonical_product_members from anon, authenticated;
revoke all on table public.canonical_product_promotions from anon, authenticated;

grant select, insert, update on table public.canonical_product_groups to service_role;
grant select, insert, update on table public.canonical_product_members to service_role;
grant select, insert, update on table public.canonical_product_promotions to service_role;

revoke all on sequence public.canonical_product_groups_id_seq from anon, authenticated;
revoke all on sequence public.canonical_product_members_id_seq from anon, authenticated;
revoke all on sequence public.canonical_product_promotions_id_seq from anon, authenticated;
grant usage, select on sequence public.canonical_product_groups_id_seq to service_role;
grant usage, select on sequence public.canonical_product_members_id_seq to service_role;
grant usage, select on sequence public.canonical_product_promotions_id_seq to service_role;

notify pgrst, 'reload schema';
