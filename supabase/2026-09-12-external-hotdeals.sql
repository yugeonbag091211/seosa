-- ============================================================================
-- 2026-09-12 External Hotdeal Radar  (revised 2026-09-13 after validation audit)
-- Apply manually in Supabase SQL Editor. Application deploys must not run this.
-- Additive: products, price_history, and hotdeals are untouched.
-- Re-runnable: a database that already ran the 2026-09-12 first draft is
-- upgraded in place by the ALTER statements below (no-ops on a fresh database).
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
  -- No foreign key: catalog tooling re-keys/retires products rows and a community
  -- snapshot must not block that. matched_* columns keep the evidence instead.
  matched_product_id         text,
  matched_mall               text not null default '',
  matched_vendor_item_id     text not null default '',
  match_confidence           numeric(4,3) not null default 0,
  match_method               text not null default 'none',

  -- Verification snapshot. price_history remains the source of truth.
  deal_score                 smallint not null default 0 check (deal_score between 0 and 100),
  verification_status        text not null default 'UNMATCHED',
  verification_reasons       jsonb not null default '[]'::jsonb,
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
  -- Set by the collector only when shadow mode is off for this source.
  is_exposed                 boolean not null default false,
  metadata                   jsonb not null default '{}'::jsonb,
  last_verified_at           timestamptz not null default now(),

  constraint external_hotdeals_original_price_check
    check (original_price is null or original_price > price),
  constraint external_hotdeals_match_confidence_check
    check (match_confidence between 0 and 1)
);

-- Upgrade path for the first draft (no-op on a fresh table).
alter table external_hotdeals add column if not exists verification_reasons jsonb not null default '[]'::jsonb;
alter table external_hotdeals add column if not exists is_exposed boolean not null default false;

-- Invariants enforced by the database, not only by the collector.
alter table external_hotdeals drop constraint if exists external_hotdeals_source_check;
alter table external_hotdeals add constraint external_hotdeals_source_check
  check (source ~ '^[a-z0-9][a-z0-9-]{1,48}$');

alter table external_hotdeals drop constraint if exists external_hotdeals_status_check;
alter table external_hotdeals add constraint external_hotdeals_status_check
  check (verification_status in ('UNMATCHED', 'SUSPICIOUS_PRICE', 'INSUFFICIENT_HISTORY',
                                 'NOT_QUALIFIED', 'INTEREST', 'GOOD_DEAL', 'STRONG_DEAL'));

alter table external_hotdeals drop constraint if exists external_hotdeals_match_check;
alter table external_hotdeals add constraint external_hotdeals_match_check
  check (matched_product_id is null or match_confidence >= 0.75);

-- An exposed row is always a matched, verified, primary row.
alter table external_hotdeals drop constraint if exists external_hotdeals_exposure_check;
alter table external_hotdeals add constraint external_hotdeals_exposure_check
  check (not is_exposed or (
    is_primary and matched_product_id is not null and match_confidence >= 0.75
    and deal_score >= 60 and verification_status in ('INTEREST', 'GOOD_DEAL', 'STRONG_DEAL')
  ));

-- Provider identity is the primary idempotency key.
create unique index if not exists external_hotdeals_source_post_key
  on external_hotdeals (source, source_post_id);

-- Canonical URL accelerates audit/dedupe lookups. The runtime folds duplicate
-- URLs before upsert; provider identity remains the single conflict target.
create index if not exists external_hotdeals_source_url_idx
  on external_hotdeals (source, canonical_source_url)
  where canonical_source_url <> '';

-- Public list: GET /api/hotdeals?view=external (is_exposed + recent posted_at).
drop index if exists external_hotdeals_verified_list_idx;
create index if not exists external_hotdeals_exposed_list_idx
  on external_hotdeals (deal_score desc, posted_at desc)
  where is_exposed;

-- Collector regrouping: recent rows for the matched products of one batch.
create index if not exists external_hotdeals_product_idx
  on external_hotdeals (matched_product_id, posted_at desc)
  where matched_product_id is not null;

-- Per-source shadow audits and retention.
create index if not exists external_hotdeals_source_posted_idx
  on external_hotdeals (source, posted_at desc);

create index if not exists external_hotdeals_group_idx
  on external_hotdeals (group_key) where group_key <> '';

comment on table external_hotdeals is
  'External Hotdeal Radar discovery, matching, and verification snapshots. price_history is authoritative.';
comment on column external_hotdeals.matched_product_id is
  'Nullable by design. Set only when match_confidence is at least 0.75.';
comment on column external_hotdeals.price_vs_90d_low is
  'Percent distance from the 90-day observed low. Negative means cheaper than that low.';
comment on column external_hotdeals.is_exposed is
  'False in shadow mode. The API also requires EXTERNAL_HOTDEAL_PUBLIC=1.';

-- Server-only table: RLS on, no policies, no client grants.
alter table external_hotdeals enable row level security;
revoke all on table external_hotdeals from anon, authenticated;
revoke all on sequence external_hotdeals_id_seq from anon, authenticated;
notify pgrst, 'reload schema';

-- Verification examples (read only):
-- select source, verification_status, is_exposed, count(*) from external_hotdeals group by 1,2,3;
-- select count(*) from external_hotdeals where matched_product_id is null and match_confidence >= .75;
-- select source, source_post_id, title, price, match_confidence, deal_score, verification_reasons
--   from external_hotdeals where posted_at > now() - interval '3 days' order by deal_score desc limit 50;

-- Rollback (manual only):
-- drop table if exists external_hotdeals;
