# SEOSA2026 purchase-link rollout: staged, proof-gated, reversible

As of 2026-11-19 KST, the official Coupang report has **not yet proven a positive SEOSA2026 click**. Do not claim 100%, enable production switches, or mutate historical product URLs.

## Scope
- Server-only table coupang_channel_deeplinks, keyed by (product_id,item_id,vendor_item_id,sub_id).
- Option-safe link overlay for hotdeals, today's drops, deal detail, product page, product JSON.
- Original products.link, price_history.link, hotdeals.affiliate_url remain unchanged.
- Explicit kill switch COUPANG_LINKS_ROLLOUT=1 with valid COUPANG_LINKS_PERCENT between 1 and 100, plus a real positive official SEOSA2026 click in coupang_partner_channel_daily.
- Stable hash buckets for 5 -> 25 -> 100% rollout; ambiguous/missing/wrong option or DB errors fail closed to legacy.
- The staging script defaults to dry-run, performs at most one explicit API call per run with --execute and at most 25 product URLs; all provider results must be validated.

## Required operating sequence
1. After **2026-11-20 16:00 KST**, verify an official positive 20261119 channel click in Coupang Partners with sub ID SEOSA2026.
   - node scripts/diag-coupang-partner-report.js --date=20261119 --kind=clicks
   - A browser-observed click and HTTP 200 without positive official channel data are NOT proof.
2. Only after the official report is positive, import the report (never fake rows).
   - node scripts/sync-coupang-partner-daily.js --date=20261119 (dry-run)
   - node scripts/sync-coupang-partner-daily.js --date=20261119 --write (only after review)
3. Review and apply db/2026-11-19-coupang-staged-links.sql via controlled migration. Confirm private server-only access and RLS.
4. Stage exactly one known product using existing securely configured partner credentials.
   - node scripts/stage-coupang-channel-links.js --productId=8423575385 --limit=1 (dry-run)
   - node scripts/stage-coupang-channel-links.js --productId=8423575385 --limit=1 --execute (provider call, no write)
   - node scripts/stage-coupang-channel-links.js --productId=8423575385 --limit=1 --execute --write (verified provider result, isolated table only)
   - Each --execute incurs one API request. Do not loop or retry blindly; respect rate limits.
5. Deploy the new code with COUPANG_LINKS_ROLLOUT unset or 0, smoke test production, then stage a small high-click set.
6. Only with partner attribution evidence, activate COUPANG_LINKS_ROLLOUT=1, COUPANG_LINKS_PERCENT=5, COUPANG_CHANNEL_SUBID=SEOSA2026. Verify live hotdeal/product links, p95, runtime errors, and next-day partner credit before 25% and 100%.
7. Do NOT enable COUPANG_CHANNEL_MODE=full for all background writers without separate Vercel + GitHub Actions audit; do not mutate historical catalog links.

## Quota / rollback
The Coupang Partners guide lists Search 10 requests/hour, Reports 50/hour, and other APIs 100/hour. These limits can change. Do not mass-issue 26,144 deeplinks without an approved pacing plan. Roll back by setting COUPANG_LINKS_ROLLOUT=0 and redeploying. Historical links are never overwritten.

## Tests
- node scripts/test-coupang-link-overlay.js
- node scripts/test-coupang-channel-staging.js
- node scripts/test-coupang-partner-daily.js
- node scripts/test-hotdeal-api.js
- node scripts/test-product-page.js

100% completion requires real provider-recognized clicks, verified coverage of intended buying routes and production rollback/smoke results. Offline tests alone do not prove this.
