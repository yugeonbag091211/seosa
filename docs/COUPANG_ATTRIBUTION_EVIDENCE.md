# SEOSA Coupang channel evidence — click != order != commission

Updated 2026-11-19 KST. This feature is *monetization measurement*, not shopping AI development.

## Current scope and baseline

- The live site uses `COUPANG_CHANNEL_ROLLOUT=1`, `COUPANG_CHANNEL_MODE=canary`,
  `COUPANG_CHANNEL_SUBID=SEOSA2026`, `COUPANG_CHANNEL_CANARY_PERCENT=10`.
- Canary cohort = deterministic 10% of distinct normalized search keyword buckets.
  It is NOT 10% of all visitors or existing product links.
- On 2026-11-19, the live Search API returned an affiliate link bearing `subId=SEOSA2026`;
  the separate channel cache contained 1 row; the 3,300 legacy search cache rows and
  26,137 legacy Coupang product rows were unchanged.
- The last-seven-day funnel before this change recorded 27 Coupang `affiliate_click`
  events: hotdeal 16, product 8, AI 2, home 1; **search 0**. These events
  have no channel dimension, so their SUBID attribution is **unknown**.
- `conversions` contained **0 imported records**; the Coupang orders importer
  stays `verified:false` because order field shape and cancellation semantics
  were never confirmed. Zero imported conversions is NOT proof of zero sales.

## The new field and its evidence grade

Migration: `supabase/2026-11-19-coupang-click-evidence.sql`

Adds `funnel_events.sub_id` (empty by default) and a partial index. Existing data are
preserved. The public browser sends `sid=SEOSA2026` only on a
`Track.affiliate` click of a validated, genuinely tagged Coupang `link.coupang.com/re/AFF...`
URL. Product pages use the same rule for future tagged URLs.

The unauthenticated `/api/stats` endpoint forwards the hint only to the funnel recorder.
The server accepts only the configured channel ID, only for `affiliate_click`,
only when the merchant is `쿠팡`, and only with a recognized source.
Arbitrary IDs are discarded. **A user can still forge a request**, so
these are client-reported *diagnostic* counts, not tamper-proof proof of merchant
acceptance. Raw URLs, IPs, device fingerprints or new personal fields are NOT saved.

The existing admin-only `/api/stats?report=1` exposes
`funnel.clientReportedChannelClicks`:

```json
{
  "basis": "browser_unverified",
  "byChannel": { "SEOSA2026": 1 },
  "bySource": { "search": 1 }
}
```

The example above is a **shape illustration**, NOT a claimed real click.
The existing `gmv`, `commissionRevenue`, `conversionsPending`,
`conversionCoverage` contracts remain unchanged. In particular, internal clicks
must NEVER be multiplied by a conversion rate to produce fake revenue.

## Release safety

1. Review and merge this PR only after local tests + GitHub CI are green.
2. Apply the non-destructive migration **before** deploying the new server code.
   Query: `SELECT count(*) FROM public.funnel_events`; baseline retained, RLS unchanged.
3. Redeploy the exact reviewed main SHA; keep the 10% canary settings unchanged.
4. Check homepage, `/api/init`, `/api/search`, product page, JS console,
   Vercel errors and legacy Coupang listing count.
5. **Do not create fake click events in Production just to check the counter.**
   Wait for genuine user interactions and inspect the private admin report / DB.
6. Independently compare Coupang Partners > Reports > Performance, filtering
   by channel ID `SEOSA2026` after the partner reporting window. The
   partner report—not this browser event—is the authority for recognized
   clicks, orders, fees and cancellations.
7. If new errors or empty search results appear, turn off the deployment or
   set `COUPANG_CHANNEL_ROLLOUT=0` and redeploy; neither restores nor modifies
   existing catalogue links because they never changed.

## Expansion gate (still NOT approved)

Do not switch `COUPANG_CHANNEL_MODE=full`, modify the 26,137 stored links,
or rewrite historic affiliate URLs until (a) a *genuine* channel-attributed
click appears in the Coupang Partners report; (b) all production/Actions
writers and option IDs are audited; (c) partner-issued replacement URLs are
used instead of adding the SUBID to old URLs; and (d) rollback can restore
all observed routes. Product/hotdeal links currently carry the legacy
attribution for the stored products.

## Data freshness — separate quality issue

A read-only November 19 audit found 18,032 of 26,137 Coupang catalogue items
last collected more than 7 days ago (12,107 older than 30 days). This does
not itself mean the current displayed prices are wrong: the product page
already uses separate fresh-observation and stale filtering. Make further
collector changes only after verifying the active quota/gate and the product
display's actual freshness constraints; never force a provider flood to
"refresh" all rows.
