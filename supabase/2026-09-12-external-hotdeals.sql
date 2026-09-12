-- ============================================================================
-- 2026-09-12 External Hotdeal Radar
-- Apply manually in Supabase SQL Editor. Application deploys must not run this.
-- This migration is additive: products, price_history, and hotdeals are untouched.
-- ============================================================================

create table if not exists external_hotdeals (
  id                         bigserial primary key,
  source                     text not null,
  source_post_id             text not null,
  source_url                 text not null,
  canonical_source_url       text not null default '',

  title                      text not null,
  normalized_title           text not null,
  price                      integer not null check (price > 0),
  original_price             integer,
  mall                       text not null default '',
  product_url                text not null default '',
  canonical_product_url      text not null default '',
  image_url                  text not null default '',
  posted_at                  timestamptz not null,
  fetched_at                 timestamptz not null default now(),

  -- Matching is intentionally nullable. A weak guess must not become identity.
  matched_product_id         text,
  matched_mall               text not null default '',
  matched_vendor_item_id     text not null default '',
  match_confidence           numeric(4,3) not null default 0,
  match_method               text not null default 'none',

  -- Verification snapshot. price_history remains the source of truth.
  deal_score                 smallint not null default 0 check (deal_score between 0 and 100),
  verification_status        text not null default 'UNMATCHED',
  price_vs_30d_avg           numeric(7,2),
  price_vs_90d_low           numeric(7,2),
  average_30d                integer,
  low_30d                    integer,
  low_90d                    integer,
  previous_price             integer,
  history_observation_count  integer not null default 0,
  history_last_observed_at   date,

  -- Cross-source display grouping. Every source row is retained.
  group_key                  text not null default '',
  is_primary                 boolean not null default true,
  source_count               integer not null default 1,
  sources                    jsonb not null default '[]'::jsonb,
  metadata                   jsonb not null default '{}'::jsonb,
  last_verified_at           timestamptz not null default now(),

  constraint external_hotdeals_original_price_check
    check (original_price is null or original_price > price),
  constraint external_hotdeals_match_confidence_check
    check (match_confidence between 0 and 1)
);

-- Provider identity is the primary idempotency key.
create unique index if not exists external_hotdeals_source_post_key
  on external_hotdeals (source, source_post_id);

-- Canonical URL accelerates audit/dedupe lookups. The runtime folds duplicate
-- URLs before upsert; provider identity remains the single conflict target.
create index if not exists external_hotdeals_source_url_idx
  on external_hotdeals (source, canonical_source_url)
  where canonical_source_url <> '';

create index if not exists external_hotdeals_verified_list_idx
  on external_hotdeals (deal_score desc, posted_at desc)
  where is_primary and deal_score >= 60
    and verification_status in ('STRONG_DEAL', 'GOOD_DEAL', 'INTEREST');

create index if not exists external_hotdeals_product_idx
  on external_hotdeals (matched_product_id, posted_at desc)
  where matched_product_id is not null;

create index if not exists external_hotdeals_group_idx
  on external_hotdeals (group_key) where group_key <> '';

comment on table external_hotdeals is
  'External Hotdeal Radar discovery, matching, and verification snapshots. price_history is authoritative.';
comment on column external_hotdeals.matched_product_id is
  'Nullable by design. Set only when match_confidence is at least 0.75.';
comment on column external_hotdeals.price_vs_90d_low is
  'Percent distance from the 90-day observed low. Negative means cheaper than that low.';

-- Server-only table: no anon/authenticated policies are created.
alter table external_hotdeals enable row level security;
notify pgrst, 'reload schema';

-- Verification examples (read only):
-- select source, verification_status, count(*) from external_hotdeals group by 1,2;
-- select count(*) from external_hotdeals where matched_product_id is null and match_confidence >= .75;

-- Rollback (manual only):
-- drop table if exists external_hotdeals;
