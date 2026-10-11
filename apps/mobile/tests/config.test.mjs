import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * The config the store build will actually ship — after every config plugin ran — not just app.json.
 *
 * Why: app.json can be clean while a plugin injects something. expo-secure-store adds
 * NSFaceIDUsageDescription by default and the Android template adds VIBRATE; neither is used by SEOSA
 * (found 2026-10-10 with `expo config --type introspect`). This test runs the same introspection.
 * Library manifests (expo-image: ACCESS_NETWORK_STATE; expo-file-system: storage, blocked here)
 * merge later in Gradle and are covered by blockedPermissions.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function introspect() {
  const cli = path.join(ROOT, 'node_modules', 'expo', 'bin', 'cli');
  const out = execFileSync(process.execPath, [cli, 'config', '--type', 'introspect', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, EXPO_NO_TELEMETRY: '1' } });
  return JSON.parse(out.slice(out.indexOf('{')));
}

test('built config: identity, versions, no permission prompts, only INTERNET on Android', { timeout: 150_000 }, () => {
  const c = introspect();
  // Identity and versions (Play needs versionCode, App Store needs buildNumber; both rise with each upload).
  assert.equal(c.name, 'SEOSA');
  assert.equal(c.ios.bundleIdentifier, 'kr.ai.seosa');
  assert.equal(c.android.package, 'kr.ai.seosa');
  assert.match(c.version, /^\d+\.\d+\.\d+$/);
  assert.ok(Number.isInteger(c.android.versionCode) && c.android.versionCode >= 1);
  assert.match(String(c.ios.buildNumber), /^\d+$/);
  assert.equal(c.scheme, 'seosa');

  // iOS: no purpose strings at all (no camera, photos, location, contacts, Face ID…), HTTPS only.
  const plist = c.ios.infoPlist;
  assert.deepEqual(Object.keys(plist).filter(k => /UsageDescription$/.test(k)), []);
  assert.equal(plist.ITSAppUsesNonExemptEncryption, false);
  assert.equal(c.ios.supportsTablet, false, 'iPad runs the iPhone layout (no iPad screenshots, no split-screen layouts)');
  // App Transport Security is not checked here: introspection fills Info.plist from a stand-in
  // (NSAllowsArbitraryLoads: true). The real prebuild template (expo/template.tgz) ships false.

  // Android: every requested permission is INTERNET; everything else in the manifest is a removal.
  const perms = c._internal.modResults.android.manifest.manifest['uses-permission'] || [];
  const kept = perms.filter(p => p.$['tools:node'] !== 'remove').map(p => p.$['android:name']);
  const removed = perms.filter(p => p.$['tools:node'] === 'remove').map(p => p.$['android:name']);
  assert.deepEqual(kept, ['android.permission.INTERNET']);
  for (const p of ['CAMERA', 'RECORD_AUDIO', 'ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION', 'READ_CONTACTS', 'READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE', 'READ_MEDIA_IMAGES', 'READ_MEDIA_VIDEO', 'SYSTEM_ALERT_WINDOW', 'POST_NOTIFICATIONS', 'VIBRATE']) {
    assert.ok(removed.includes(`android.permission.${p}`), `${p} is removed from the merged manifest`);
  }
  // SecureStore's own backup rules keep the token out of Android Auto Backup restores.
  const app = c._internal.modResults.android.manifest.manifest.application[0].$;
  assert.equal(app['android:dataExtractionRules'], '@xml/secure_store_data_extraction_rules');
});
