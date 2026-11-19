-- Official Coupang Partners aggregated reporting, separated from order-level conversions.
-- Additive and read-only until verified partner rows exist. No fake conversions.
CREATE TABLE IF NOT EXISTS public.coupang_partner_channel_daily (
  report_date date NOT NULL,
  sub_id text NOT NULL CHECK (sub_id ~ '^[A-Za-z0-9]{8,20}$'),
  clicks bigint NULL CHECK (clicks IS NULL OR clicks >= 0),
  orders bigint NULL CHECK (orders IS NULL OR orders >= 0),
  cancels bigint NULL CHECK (cancels IS NULL OR cancels >= 0),
  gmv numeric(18,2) NULL,
  commission numeric(18,2) NULL,
  partner_report_source text NOT NULL DEFAULT 'coupang_partners_reporting_api',
  fetched_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coupang_partner_channel_daily_pkey PRIMARY KEY (report_date, sub_id)
);
ALTER TABLE public.coupang_partner_channel_daily ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS coupang_partner_channel_daily_fetched_idx
  ON public.coupang_partner_channel_daily (fetched_at DESC);
COMMENT ON TABLE public.coupang_partner_channel_daily IS
  'Official Coupang Partners DAILY AGGREGATE clicks/earnings. Not individual conversions, not finalized payout and not browser-reported clicks.';
-- No anon/authenticated grants or RLS policies; server-only.
