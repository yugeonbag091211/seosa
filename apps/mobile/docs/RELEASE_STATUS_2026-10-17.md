# SEOSA Mobile Release Status — 2026-10-17

This snapshot supersedes stale status statements in `STORE_READINESS.md` where they conflict with the current repository state.

## Current release baseline

- App version: `1.0.0`
- iOS bundle identifier: `kr.ai.seosa`
- Android package: `kr.ai.seosa`
- Expo SDK: 57 (`expo ~57.0.30` after #161)
- React Native: `0.86.3`
- API origin: `https://seosa.ai.kr`
- OTA updates: disabled
- EAS build version source: `remote`
- Production build numbers: `autoIncrement: true`

## Completed on 2026-10-17

- Price alert target presets added and merged (#156).
- Exact-option alerts now reject target prices at or above the displayed current price, preventing immediate noisy alerts (#157).
- Android AI composer now uses explicit `KeyboardAvoidingView` padding so the composer stays above the software keyboard; regression coverage added (#158).
- EAS production versioning changed from local/manual to remote/automatic to prevent duplicate App Store / Play build numbers; regression coverage added (#159).
- Tests, Mobile Check, and AI security validation passed for the release-setting changes before merge.

## Progress on 2026-10-18 — web-parity implementation

- #164 merged: within-run collector pre-covered skip + 33 offline regressions (server-only).
- #165 merged: native home navigation, six quick-search shortcuts, community hotdeal list and `/community` route; the app reads the existing web server's `/api/hotdeals?view=external&limit=60`.
- #166 merged: current-first NO_MATCH recovery-round prioritization with unchanged rate limits and option-matching logic (server-only, live outcome not established).
- #167 merged: native `/categories` screen with six search shortcuts and dynamic popular keywords.
- Mobile TypeScript, ESLint, native API parser tests, original mobile regression suite and root web/AI CI passed for each mobile merge.
- Community-discovered products are labeled **verification pending** unless the API says both `verified=true` and `communityOnly=false`. The app opens the original HTTPS community post, not a synthesized affiliate URL.
- No on-device smoke tests, EAS cloud builds, App Store / Play Console submissions, signing changes, or native affiliate-channel policy approval were performed by these PRs.

### Ready for operator action

1. On a developer device with repository access: `cd apps/mobile && npm ci && npm run check`.
2. Authenticate **the owner's** Expo account: `npx eas-cli@latest login` then `npx eas-cli@latest init`; review and commit `extra.eas.projectId` in `app.json` before building. **This step remains blocked because the linked account/project is missing**, and this document cannot initialize it.
3. Run `npx eas-cli@latest build --profile preview --platform android` for an installable APK, then complete `docs/DEVICE_SMOKE_CHECKLIST.md` on a physical Galaxy device.
4. Compare the final native visuals and taps against the current `https://seosa.ai.kr` site on 390×844 and 360×800 devices, including light/dark themes and large fonts.
5. Confirm the affiliate partners' rules for native app distribution, then review store accounts, privacy declarations and signing before production AAB/IPA.

## Store SDK requirements

As verified on 2026-10-17 against current official platform documentation:

- Google Play requires new apps and updates to target Android API 36 from 2026-08-31. Expo SDK 57 targets API 36, so no SDK 58 upgrade is required for this rule.
- App Store Connect requires builds made with Xcode 26 or later and the iOS 26 SDK or later from 2026-04-28. Current Expo SDK 57 EAS images use Xcode 26.4+, so no SDK 58 upgrade is required for this rule.
- Do not upgrade to SDK 58 immediately before the first store release unless a concrete SDK 57 blocker appears.

## Code/config status

### Ready

- App icon, Android adaptive icon, monochrome icon, light/dark splash assets.
- No camera, microphone, location, contacts, storage, media, overlay, notification, or vibration runtime permission requested by the app configuration.
- In-app account deletion flow.
- Privacy policy, terms, support, support-email navigation in the app.
- Affiliate disclosure in relevant shopping surfaces.
- Exact-option product identity for alerts and price history.
- Search, saved products, price drops, product detail, AI concierge, sharing, price alerts.
- EAS production API origin fixed to `https://seosa.ai.kr`.
- EAS remote build versioning with production auto-increment.

### Deliberately deferred

- SDK 57 patch refresh was completed and merged in #161 on 2026-10-17. Re-run `npx expo install --check` in the authenticated development checkout immediately before the first device build; update dependency/lockfile together only if any drift remains.
- SDK 58 migration. Defer until after the first release unless required by a concrete issue.

## Hard blocker: EAS project linkage

The repository currently has no `extra.eas.projectId` in `app.json`. EAS CLI therefore has no linked Expo project yet. The first cloud build cannot be started non-interactively until the project is created or linked under the owner's Expo account.

On an authenticated development machine:

```bash
cd apps/mobile
npx eas-cli@latest whoami
# If not authenticated:
npx eas-cli@latest login

# Create or link the EAS project. This writes extra.eas.projectId to app.json.
npx eas-cli@latest init

# Refresh compatible SDK 57 package patches as one set.
npx expo install --fix
npm run check
```

Review and commit the resulting `app.json`, `package.json`, and lockfile changes before building.

## First-build sequence

Do not begin with store submission. Prove the installable binary first.

```bash
cd apps/mobile

# Android installable APK for physical-device smoke testing.
npx eas-cli@latest build --profile preview --platform android

# After Android smoke tests pass, create store artifacts.
npx eas-cli@latest build --profile production --platform android
npx eas-cli@latest build --profile production --platform ios
```

Production builds use remote monotonically increasing developer-facing build numbers.

## Physical-device checks still required

### Android

- Install the preview APK on a Galaxy device.
- AI composer remains visible while the keyboard opens/closes.
- Search input and numeric target-price keyboard dismiss correctly.
- Product detail, price chart, save, share, target alert, AI concierge.
- Purchase link opens the intended merchant path without losing affiliate attribution.
- Dark mode, larger system font, rotation/foldable behavior where available.

### iOS

- Test on a real iPhone or TestFlight build.
- Modal/sheet navigation and keyboard behavior.
- Share sheet and external merchant link handling.
- Login, target alert, account deletion, dark mode, larger text.
- Confirm no unexpected privacy-manifest warning after the first App Store Connect upload.

## External/operator blockers

- Expo account authentication and EAS project initialization.
- Apple Developer / App Store Connect account and signing credentials.
- Google Play Console developer account and any account-specific testing requirement shown by Play Console.
- Store screenshots and store-listing metadata captured from the final build.
- Final Data Safety / App Privacy declarations in the store consoles.
- Final Coupang response confirming the allowed native-app affiliate-link/channel behavior. Do not alter merchant-link behavior speculatively before that response.

## Release gate

A store submission is allowed only when all of the following are true:

1. `npm run check` passes after the final Expo dependency state is committed.
2. EAS project is linked and `extra.eas.projectId` is committed.
3. Android preview APK passes the physical-device smoke test.
4. Android and iOS production builds complete successfully.
5. Merchant affiliate-link behavior has been verified against the partner policy/response.
6. Store privacy/data declarations match the production app and server behavior.
