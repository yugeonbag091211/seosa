#!/usr/bin/env node
/*
 * Neon(테스트 브랜치) 위에서 로컬 dev 서버를 띄워 실제 API 를 두드려 보는 회귀 스모크 — 읽기 전용.
 *
 *   (with-neon 래퍼가 NEON_DATABASE_URL · R2_* 를 프로세스 환경으로만 넣는다)
 *   node scripts/migration/smoke-neon-preview.js
 *
 * 공급자 키(쿠팡·ADPICK·LLM·Resend)는 넣지 않는다 — 외부 호출 0회로 «DB 로만 되는 화면» 을 본다.
 * 각 응답의 상태 · 시간 · 바이트 · 핵심 모양을 찍는다. 바이트는 Neon 전송량 추정의 바닥 자료다.
 */
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const ALLOWED_HOSTS = new Set([
  'ep-gentle-art-aoaa97v4.c-2.ap-southeast-1.aws.neon.tech',
  'ep-gentle-art-aoaa97v4-pooler.c-2.ap-southeast-1.aws.neon.tech'
]);
const PORT = 3197;
const BASE = `http://127.0.0.1:${PORT}`;

function shape(body, type) {
  if (!/json/.test(type || '')) return `${type || '?'} · ${/<title>([^<]{0,60})/.exec(body) ? /<title>([^<]{0,60})/.exec(body)[1] : ''}`.trim();
  try {
    const j = JSON.parse(body);
    if (Array.isArray(j)) return `array(${j.length})`;
    return Object.entries(j).slice(0, 8).map(([k, v]) => Array.isArray(v) ? `${k}[${v.length}]` : (v && typeof v === 'object') ? `${k}{}` : `${k}=${String(v).slice(0, 24)}`).join(' ');
  } catch (_) { return 'invalid json'; }
}

async function hit(label, urlPath, opts = {}, expect = s => s === 200) {
  const t0 = Date.now();
  let r, body = '';
  try {
    r = await fetch(BASE + urlPath, { ...opts, signal: AbortSignal.timeout(60000) });
    body = await r.text();
  } catch (e) {
    console.log(`  FAIL ${label.padEnd(30)} ${e.message}`);
    return { ok: false };
  }
  const ms = Date.now() - t0;
  const ok = expect(r.status, body);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label.padEnd(30)} ${String(r.status).padEnd(4)} ${String(ms).padStart(6)}ms ${String(Buffer.byteLength(body)).padStart(8)}B  ${shape(body, r.headers.get('content-type'))}`);
  return { ok, status: r.status, body, ms };
}

async function main() {
  const host = new URL(process.env.NEON_DATABASE_URL || 'postgres://x').hostname;
  if (!ALLOWED_HOSTS.has(host) || process.env.VERCEL_ENV !== 'preview') throw new Error('격리된 테스트 브랜치(Preview)에서만 돈다');

  const root = path.join(__dirname, '..', '..');
  // 공급자 키는 일부러 비운다(상속 차단).
  const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'development' };
  for (const k of Object.keys(env)) if (/^(SUPABASE_|COUPANG_|ADPICK_|OPENAI|OPENROUTER|GROQ|GEMINI|ANTHROPIC|RESEND|TOSS_|SENTRY)/.test(k)) delete env[k];
  const server = spawn(process.execPath, [path.join(root, 'scripts', 'dev-server.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });

  let passed = 0, failed = 0;
  const count = r => { if (r.ok) passed++; else failed++; return r; };
  try {
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      try { const r = await fetch(BASE + '/', { signal: AbortSignal.timeout(2000) }); if (r.status === 200) break; } catch (_) { /* 아직 */ }
    }
    console.log('[읽기 화면]');
    count(await hit('홈 HTML', '/', {}, s => s === 200));
    count(await hit('/api/init (홈 데이터)', '/api/init', {}, (s, b) => s === 200 && !/error/i.test(b.slice(0, 40))));
    // 공급자 키를 일부러 뺐다 → 검색 캐시(24h 지남)도 못 쓰므로 «지금은 못 불러온다(503)» 로 닫혀야 한다.
    // 캐시 적중 · 저장까지의 DB 경로는 test-neon-search-ai-sandbox.js 가 본다.
    count(await hit('/api/search 키 없음 → 503 닫힘', '/api/search?keyword=' + encodeURIComponent('에어팟'), {}, (s, b) => s === 503 && /불러오지 못했어요/.test(b)));
    count(await hit('/api/hotdeals', '/api/hotdeals', {}, s => s === 200));
    count(await hit('/api/history 단건(R2+Neon)', '/api/history?productId=7912306911&mall=' + encodeURIComponent('쿠팡'), {}, (s, b) => s === 200 && JSON.parse(b).length > 10));
    count(await hit('/api/history deal+fair', '/api/history?productId=7912306911&mall=' + encodeURIComponent('쿠팡') + '&deal=1&fair=1', {}, (s, b) => s === 200 && /"points"\s*:\s*\[/.test(b)));
    count(await hit('/api/history-batch', '/api/history-batch?ids=' + encodeURIComponent('7912306911|쿠팡'), {}, s => s === 200 || s === 400));
    count(await hit('/api/radar', '/api/radar', {}, s => s === 200));
    count(await hit('/api/alternatives', '/api/alternatives?pid=7912306911&mall=' + encodeURIComponent('쿠팡'), {}, s => s === 200 || s === 404));
    count(await hit('/p/7912306911 상품 페이지', '/p/7912306911', {}, (s, b) => s === 200 && b.includes('7912306911')));
    count(await hit('/category 허브', '/category', {}, s => s === 200));
    const idx = count(await hit('/sitemap.xml', '/sitemap.xml', {}, (s, b) => s === 200 && /<sitemapindex|<urlset/.test(b)));
    const file = idx.body && /\/sitemaps\/([^<\s]+)/.exec(idx.body);
    if (file) count(await hit('/sitemaps/' + file[1].slice(0, 20), '/sitemaps/' + file[1], {}, (s, b) => s === 200 && /<urlset/.test(b)));
    count(await hit('/api/stats 잘못된 요청 → 400', '/api/stats', {}, s => s === 400));
    count(await hit('/api/rec', '/api/rec', {}, s => s < 500));

    console.log('\n[회원 · 보안 경계 — 로그인 없이]');
    count(await hit('/api/alerts 토큰 없음 → 401', '/api/alerts?email=probe%40probe.invalid', {}, s => s === 401 || s === 403));
    count(await hit('/api/sync 토큰 없음 → 401', '/api/sync?resource=profile&email=probe%40probe.invalid', {}, s => s === 401 || s === 403));
    // CRON_SECRET 이 없는 로컬에서는 «설정 없음» 으로 닫힌다(실행하지 않는다) — 그게 맞는 동작이다.
    count(await hit('/api/cron 비밀 없음 → 닫힘', '/api/cron', {}, (s, b) => s === 401 || s === 403 || (s === 500 && /CRON_SECRET/.test(b))));
    count(await hit('/api/payment GET → 4xx', '/api/payment', {}, s => s >= 400 && s < 500));
    count(await hit('/api/auth 잘못된 요청 → 4xx', '/api/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, s => s >= 400 && s < 500));
    // LLM 키를 넣지 않았으므로 /api/ai 본 경로는 여기서 보지 않는다 — DB 쪽은 test-neon-search-ai-sandbox.js 가 본다.
    console.log('  SKIP /api/ai                        (LLM 키 없음 — DB 경로는 test-neon-search-ai-sandbox.js)');
  } finally {
    server.kill();
  }
  const errs = log.split('\n').filter(l => /Error|error|실패|FAIL/.test(l) && !/RESEND|SENTRY|SSL modes/.test(l)).slice(0, 12);
  if (errs.length) { console.log('\n[서버 로그의 오류 줄 (최대 12)]'); errs.forEach(l => console.log('  ' + l.slice(0, 200))); }
  console.log('\n====================================================');
  console.log(`결과: ${passed} PASS / ${failed} FAIL`);
  if (failed) process.exitCode = 1;
}

main().catch(e => { console.error('SMOKE_FAILED ' + e.message); process.exitCode = 1; });
