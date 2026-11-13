# AI v3 rollout setup

The web and mobile clients opt into the rollout through `/api/ai?v=3`. Other callers of `/api/ai` continue to use the legacy path. The rollout defaults to zero and requires `ENABLE_AI_V3=1` and `AI_V3_ROLLOUT_PERCENT` between 0 and 100. Setting either the enable flag off or the percentage to zero routes all opted-in traffic to legacy.

Before enabling a cohort:

1. Review and apply the two migrations in `supabase/migrations` to the intended database. They have not been applied by this change. The monitor fails closed to legacy if its table is unavailable. Profile data uses a service-role-only table with row-level security enabled.
2. Configure `OPENAI_API_KEY`, the existing `AI_V3_MODEL`, and stable, private `AI_V3_STATE_SECRET` and `AI_V3_PROFILE_SECRET` values. The latter two have existing server-secret fallbacks, but dedicated stable values avoid coupling profile identity and state verification to other key rotation. Rotating the profile secret without migrating IDs makes old profiles inaccessible to reads and account deletion.
3. Verify the price-history schema, migrations, provider configuration, monitoring, and a representative conversation in a non-production environment. Start with a small rollout percentage and inspect the `ai_request` logs and `x-ai-version` header.

The shared monitor uses a five-minute window and requires at least ten v3 samples; more than 10% failures routes new requests to legacy. It retries the cohort after failed samples age out. If monitoring is unavailable, the route falls back to legacy. The monitor event table is append-only; operators must arrange retention appropriate to their deployment before sustained production traffic.

Signed state is capped at 4 KB. If no signing secret is configured, signed state is unavailable; configure the dedicated state secret before rollout. Anonymous cohorts persist for a browser tab or mounted mobile concierge session; authenticated cohorts use the server-verified account identity.
