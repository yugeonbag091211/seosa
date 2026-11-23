# SEOSA Managed Neon Auth — foundation (2026-11-23)

## Current state (not a login cutover)

- Neon project: `withered-dew-45175008`; default branch: `migration-test-20261020` (`br-polished-meadow-aonxdoap`).
- Existing application database: `neondb` — unchanged by this setup.
- New database: `seosa_auth` on the default branch; Neon Managed Better Auth (`better_auth`) provisioned there and `neon_auth` schema confirmed.
- Allowed application origin: `https://seosa.ai.kr`; localhost origin disabled.
- Managed Auth registrations **disabled pending app policy integration**, email verification required via OTP.
- Vercel **Preview** variables `NEON_AUTH_BASE_URL`, `NEON_AUTH_JWKS_URL` added. Production environment variables and deployment were not changed.
- `neon.ts` now declares Auth, reflecting its current service status. Before running `neon deploy` on **any** branch, use `neon config plan` and verify that it will not provision authentication against an unintended database (default is often `neondb`).

## Existing SEOSA authentication

SEOSA is a static HTML/vanilla JS site with Node.js Vercel functions, **not Next.js**. Its `POST /api/auth` uses a six-digit email code and then issues a custom signed `v1.*` Bearer token in `api/_auth.js`. `/api/sync`, `/api/alerts`, account deletion, account/profile, payment/plan, and other routes rely on that token and email identity. It requires `ageConfirmed === true` for new verification-code requests because the app does not support under-14 accounts.

Do **not** replace `/api/auth` or accept Neon Auth JWTs in existing endpoints without an explicitly tested identity migration. Managed Better Auth user IDs are not the existing SEOSA email-based IDs. A valid Neon token alone must never grant existing account ownership.

## Required application implementation for cutover

1. Select the sign-in method and implement an opt-in browser flow using the official `@neon/auth` wrapper and an app-compatible build process (the existing static app does not bundle npm browser imports).
2. Enforce the existing minimum-age acknowledgement at sign-up and configure account creation policy; keep sign-up disabled until ready.
3. Design an authenticated user-identity linking flow with email verification and revocation. Preserve existing account deletion, price alerts, saved products, subscriptions and payment ownership.
4. Validate trusted origins, cookie/CORS behavior, OTP email delivery, reset, session restoration, sign-out, error states and cross-browser behavior.
5. Test JWT verification (issuer, signature/JWKS, expiry) and per-resource authorization on protected server routes, not merely UI redirects.
6. Run staging tests and a reversible rollout with explicit production approval. Do not migrate historical password hashes or silently merge accounts.

## Rollout gate

Until the above is complete and validated, the **legacy SEOSA auth remains authoritative**. This PR is deliberately a foundation-only Draft, not an assertion that the end-user sign-in is integrated. Do not merge as a production-ready authentication change.
