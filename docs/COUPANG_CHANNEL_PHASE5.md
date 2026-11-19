# SEOSA Coupang Phase 5 — verified partner evidence and catalog rollout gate

Status on **2026-11-19 KST**: official API connectivity and deeplink issuance verified;
**actual positive SEOSA2026 partner-reported click is still pending next-day reporting**.
Do not mark 100% or enable full catalog rollout before evidence.

## Observed evidence, strictly ordered

1. **Provider-issued Search link**: Search API returned a link with
   `lptag=AF8789251` and `subId=SEOSA2026`. The user separately showed a
   final Coupang landing URL preserving `subid=SEOSA2026`.
   This proves transmission, not partner credit or a purchase.
2. **Official reports (read-only, 2026-11-19)**:
   `GET /v2/providers/affiliate_open_api/apis/openapi/v1/reports/{clicks,orders,commission,cancels}`
   returned HTTP 200 and rCode 0 for the target channel. The current-day
   November 19 report had no channel rows, as expected before its
   **November 20 ~16:00 KST** official reporting update.
   For November 18 the target channel had no rows (canary began November 19).
   Account-wide November 18 reports contained ordinary data (5 click rows,
   1 aggregate commission row) but those are **not** evidence for SEOSA2026.
   Never import those totals as the new channel's.
3. **Provider-issued catalog deeplink**: exactly ONE authorized POST to
   `/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink` for
   `productId=8423575385`, `itemId=24367268877`,
   `vendorItemId=94530587273` returned HTTP 200/rCode 0 and one
   provider-issued `landingUrl` carrying the expected SUBID and vendor item.
   Short URL generation succeeded. **No affiliate URL was clicked; no DB links changed.**
4. **Official aggregate reporting data model**: new isolated
   `coupang_partner_channel_daily`, keyed by (report_date,sub_id);
   server-only with RLS enabled. Never confuse it with
   `conversions` (which requires verified order IDs and cancellation
   lifecycles). The admin report's `partnerChannelDaily` field is
   separate from `clientReportedChannelClicks` and from `gmv`.
5. **No artificial figures**: zero rows in the partner report table mean
   **not yet imported/unknown**, never "zero sales". No fake click, payment,
   commission, or order was generated.

## How to check official channel clicks after 2026-11-20 16:00 KST

On an authorized machine with the credentials already securely configured:

```sh
node scripts/diag-coupang-partner-report.js --date=20261119 --kind=clicks
node scripts/diag-coupang-partner-report.js --date=20261119 --kind=commission
node scripts/sync-coupang-partner-daily.js --date=20261119
```

The new sync defaults to dry-run. If **both signed reports succeed**, include
only `SEOSA2026` rows, and the reporting date is mature, a deliberate
`--write` will upsert the provider's true daily aggregate into the isolated
new table. Never use `--write` just because an endpoint is HTTP 200 when data
are absent. The partner-side click should also be confirmed in the portal
with Channel ID SEOSA2026. Official reports are preliminary until settled.

Import with the explicit write switch ONLY after verifying report output:

```sh
node scripts/sync-coupang-partner-daily.js --date=20261119 --write
```

## Full catalog and high-click route migration (NOT ACTIVE)

- Most customer purchase clicks are on hotdeals and product pages, which
  still use the legacy provider-issued affiliate links.
- DO NOT change `COUPANG_CHANNEL_MODE=full` yet: that requires all
  Vercel and GitHub Actions writers to switch atomically; it also changes
  collector cache/hints and historical price-link expectations.
- DO NOT mass-mutate the `products.link` or `price_history.link`
  records; current option IDs must be preserved.
- The correct link strategy is per **(productId,itemId,vendorItemId)** using
  the official Coupang deeplink endpoint with `subId=SEOSA2026`,
  then verifying returned `originalUrl`, `landingUrl`,
  `lptag`, SUBID, and vendor option. Stage links in isolated storage,
  roll out first to low volume on hotdeals/product pages with a kill switch,
  and validate genuine partner credited clicks before widening.
- Never merely append or modify `subid` on an old affiliate URL. Never
  count local frontend `affiliate_click` events as provider-recognized
  revenue.

## Rollback

Leave production's 10%-of-keywords Search canary unchanged until verified
positive channel clicks. Existing persisted product and historical price links
are untouched. To stop the channel search experiment, set
`COUPANG_CHANNEL_ROLLOUT=0` and redeploy (or revert the feature commit).
The report aggregation scripts have no live automation and by default
never write.
