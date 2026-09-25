# price_drop_top_candidates RPC rollback plan

The RPC is additive: it creates one function and grants execution to `service_role`. It does not replace the `price_drop_top` view, add indexes, or modify product or price-history data.

## Apply sequence

1. Confirm the Production API deployment still uses the existing view.
2. Apply the RPC migration only after explicit Production database approval. Wrap it in a transaction with `SET LOCAL lock_timeout = '2s'`; it only changes function metadata and grants. If a catalog lock cannot be acquired within two seconds, let the transaction fail and retry only after inspecting the blocker.
3. Verify function identity, exact return-column types, and role grants using catalog queries. Do not call the RPC against Production until approval also covers the API deployment.
4. Merge/deploy the API only after CI and Preview pass and the function is confirmed present.
5. Compare a single low-volume Production `/api/init` response and Postgres logs with the pre-deployment timeout baseline. Stop if latency or errors worsen.

## Rollback

First revert and deploy the API change so it no longer calls the function. Confirm the new API deployment has stopped invoking it. Only then remove the additive function:

```sql
BEGIN;
SET LOCAL lock_timeout = '2s';
DROP FUNCTION IF EXISTS public.price_drop_top_candidates(integer);
NOTIFY pgrst, 'reload schema';
COMMIT;
```

If the lock timeout fires, roll back the transaction and inspect database activity before retrying. The prior `price_drop_top` view was never changed, so reverting the API restores the previous query path without a view/data rollback. That previous path is known to time out in Production; keep the affected home section empty with the existing logged DB-error handling until a replacement has been approved and verified.

## Risk notes

- No table rewrite or index build is involved. Function DDL and grant changes briefly take PostgreSQL catalog locks; the explicit two-second lock timeout prevents waiting behind a conflicting DDL transaction.
- The candidate RPC preserves the existing 30-day current/previous price calculation and applies the same option key. Only the all-time-minimum work is delayed until after the top-`p_limit` candidates are bounded.
- This document does not authorize Production SQL, merge, or deployment.
