-- Add a *client-observed* channel label to existing click events.
-- This is NOT Coupang Partners official click/purchase/commission evidence.
-- Non-destructive; preserves all existing events and conversions.
ALTER TABLE public.funnel_events
  ADD COLUMN IF NOT EXISTS sub_id text NOT NULL DEFAULT '';

COMMENT ON COLUMN public.funnel_events.sub_id IS
  'Browser-reported SUBID on affiliate_click only. Untrusted diagnostic signal; NOT provider-verified traffic or sale.';

CREATE INDEX IF NOT EXISTS funnel_channel_click_idx
  ON public.funnel_events (event_date DESC, sub_id, source)
  WHERE event = 'affiliate_click' AND sub_id <> '';

-- Existing funnel_events RLS remains enabled. No public policy is added.
-- No raw affiliate URL, IP, user agent, email or cookie is stored.
