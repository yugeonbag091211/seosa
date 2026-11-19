-- SEOSA / Coupang Partners channel-scoped search cache.
-- IMPORTANT: This migration is only a reviewed proposal. It has NOT been
-- executed on Production. Existing coupang_search_cache and products remain
-- untouched. Apply only after a reversible backup and approved rollout.
--
-- Why a separate table instead of changing keyword PK?
-- The price collector's search_cache_hints RPC and its keyword scan expect
-- plain search keywords. Putting "subId:keyword" into the legacy table can
-- silently create bogus queries, use additional provider quota and corrupt
-- affiliate attribution.
CREATE TABLE IF NOT EXISTS public.coupang_channel_search_cache (
  sub_id text NOT NULL CHECK (sub_id ~ '^[A-Za-z0-9]{8,20}$'),
  keyword text NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  req_limit integer NOT NULL DEFAULT 0,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coupang_channel_search_cache_pkey PRIMARY KEY (sub_id, keyword)
);

COMMENT ON TABLE public.coupang_channel_search_cache IS
  'Coupang Search cache isolated per partner SUBID. No legacy-cache fallback.';

CREATE INDEX IF NOT EXISTS coupang_channel_search_cache_fetched_at_idx
  ON public.coupang_channel_search_cache (fetched_at);

-- No RLS/policy change or destructive DML to existing tables is included.
-- Backend is server-only. Ensure the configured database owner/service role
-- has necessary table privileges before enabling COUPANG_CHANNEL_ROLLOUT.
