import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatAiText } from '../lib/aiText.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sources(dir = ROOT, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (['node_modules', 'dist', '.expo', 'assets', 'tests'].includes(name)) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) sources(p, out);
    else if (/\.(tsx?|jsx?|json|mjs)$/.test(name) && name !== 'package-lock.json') out.push(p);
  }
  return out;
}

test('no server secret or server-only env name appears anywhere in the app', () => {
  const banned = [
    /service_role/i, /SUPABASE_(SERVICE|SECRET|KEY|URL)/, /COUPANG_(ACCESS|SECRET)/, /ADPICK_(KEY|SECRET|API)/,
    /AUTH_SECRET|SIGNING_KEY|CRON_SECRET|ADMIN_TOKEN/, /GEMINI_API_KEY|GROQ_API_KEY|OPENROUTER_API_KEY|RESEND_API_KEY/,
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,          // JWT-shaped literal
    /\bsk-[A-Za-z0-9]{20,}/,
    /process\.env\.(?!EXPO_PUBLIC_)[A-Z_]+/,                  // only EXPO_PUBLIC_* may be read
  ];
  const hits = [];
  for (const file of sources()) {
    const text = fs.readFileSync(file, 'utf8');
    for (const re of banned) if (re.test(text)) hits.push(`${path.relative(ROOT, file)} ~ ${re}`);
  }
  assert.deepEqual(hits, []);
});

test('the app asks for no Android permission and blocks the ones SEOSA never needs', () => {
  const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8')).expo;
  assert.deepEqual(app.android.permissions, []);
  for (const p of ['CAMERA', 'RECORD_AUDIO', 'ACCESS_FINE_LOCATION', 'READ_CONTACTS']) {
    assert.ok(app.android.blockedPermissions.includes(`android.permission.${p}`), p);
  }
  const plist = JSON.stringify(app.ios.infoPlist || {});
  assert.equal(/UsageDescription/.test(plist), false, 'no iOS permission prompts');
});

test('the app never talks to Supabase directly', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies).some(d => d.includes('supabase')), false);
  const hits = sources().filter(f => /supabase\.co|createClient\(/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(hits, []);
});

test('AI text: bold pairs and list items like the web, nothing else interpreted', () => {
  const blocks = formatAiText('결론: **지금 사세요**\n- 30일 평균보다 **12%** 낮아요\n<b>태그</b> 그대로');
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[0].spans, [{ text: '결론: ', bold: false }, { text: '지금 사세요', bold: true }]);
  assert.equal(blocks[1].kind, 'item');
  assert.equal(blocks[2].spans[0].text, '<b>태그</b> 그대로');
  assert.deepEqual(formatAiText('**열린 별표'), [{ kind: 'line', spans: [{ text: '**열린 별표', bold: false }] }]);
});
