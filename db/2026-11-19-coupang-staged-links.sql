-- Staged, option-accurate partner-issued links. Never rewrite products or price_history.
-- Apply only after reviewing the migration; the app safely falls back if absent.
CREATE TABLE IF NOT EXISTS public.coupang_channel_deeplinks (
  product_id text NOT NULL CHECK (product_id ~ '^[0-9]{7,13}$'),
  item_id text NOT NULL CHECK (item_id ~ '^[0-9]{7,14}$'),
  vendor_item_id text NOT NULL CHECK (vendor_item_id ~ '^[0-9]{7,14}$'),
  sub_id text NOT NULL CHECK (sub_id = 'SEOSA2026'),
  original_url text NOT NULL CHECK (original_url LIKE 'https://www.coupang.com/vp/products/%'),
  landing_url text NOT NULL CHECK (landing_url LIKE 'https://link.coupang.com/re/AFF%'),
  issued_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, item_id, vendor_item_id, sub_id)
);
CREATE INDEX IF NOT EXISTS coupang_channel_links_lookup
  ON public.coupang_channel_deeplinks (sub_id, product_id, vendor_item_id);
ALTER TABLE public.coupang_channel_deeplinks ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.coupang_channel_deeplinks IS
  'Only provider-issued SEOSA2026 links; not sales evidence and not historical price links.';
