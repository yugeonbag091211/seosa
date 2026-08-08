#!/usr/bin/env node
/*
 * 출시 전 사용자 시나리오 점검.
 *
 *   node scripts/test-e2e.js
 *
 * 쿠팡은 가짜 서버로 대체한다(COUPANG_API_HOST). 실제 쿠팡 호출 0회.
 * 전역 차단 상태도 건드리지 않는다(COUPANG_DISABLE_GLOBAL_GATE=1).
 *
 * Supabase 는 실제 DB 를 쓴다. 테스트가 만든 행은
 *   products.keyword    = E2E_KEYWORD
 *   price_history.title = E2E_KEYWORD 로 시작
 *   alerts.email        = E2E_EMAIL
 * 뿐이고, 끝나면 전부 지운다. 실제 데이터는 읽기만 한다.
 */
'use strict';

process.env.COUPANG_DISABLE_GLOBAL_GATE = '1';

const http = require('http');
const path = require('path');
const fs   = require('fs');

const root = path.resolve(__dirname, '..');
for (const f of ['.env.local', '.env']) {
  const p = path.join(root, f);
  if (fs.existsSync(p)) { require('dotenv').config({ path: p, quiet: true }); break; }
}

const E2E_KEYWORD = '이엔이테스트이어폰';   // 실제 상품명에 없을 법한 조합
const E2E_EMAIL   = 'e2e-probe@seosa.test';

let pass = 0, fail = 0;
const results = [];
function check(ok, label, detail) {
  results.push({ ok, label, detail });
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
}

/* ── 가짜 쿠팡 ────────────────────────────────────────────────── */
let coupangMode = 'ok';
const coupang = http.createServer((req, res) => {
  if (coupangMode === 'denied') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<html><body><p>Sorry! Access denied</p></body></html>');
  }
  const kw = decodeURIComponent((req.url.match(/keyword=([^&]*)/) || [])[1] || '');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    rCode: '0',
    data: {
      productData: [
        { productId: 990001, productName: kw + ' 프로 노이즈캔슬링', productPrice: 89000,
          productUrl: 'https://link.coupang.com/e2e/1', productImage: 'https://img/1.jpg' },
        { productId: 990002, productName: kw + ' 라이트', productPrice: 39000,
          productUrl: 'https://link.coupang.com/e2e/2', productImage: 'https://img/2.jpg' },
        // 검색어와 무관한 항목 — 관련도 필터가 걸러야 한다
        { productId: 990003, productName: '펩시 제로슈거 라임 355ml 24입', productPrice: 19900,
          productUrl: 'https://link.coupang.com/e2e/3', productImage: 'https://img/3.jpg' }
      ]
    }
  }));
});

/* ── 앱 서버 (dev-server 와 같은 방식으로 핸들러 직접 로드) ──── */
function wrapRes(raw) {
  let status = 200;
  const res = Object.create(raw);
  res.status = c => { status = c; return res; };
  res.json = d => { raw.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); raw.end(JSON.stringify(d)); };
  res.setHeader = raw.setHeader.bind(raw);
  res.end = b => { if (!raw.headersSent) raw.writeHead(status); raw.end(b); };
  return res;
}

const app = http.createServer(async (rawReq, rawRes) => {
  const u = new URL(rawReq.url, 'http://x');
  rawReq.query = Object.fromEntries(u.searchParams);
  const chunks = [];
  for await (const c of rawReq) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  try { rawReq.body = raw ? JSON.parse(raw) : {}; } catch (e) { rawReq.body = {}; }

  const name = u.pathname.replace(/^\/api\//, '');
  const res = wrapRes(rawRes);
  try {
    await require(path.join(root, 'api', name + '.js'))(rawReq, res);
  } catch (e) {
    console.error('handler error', name, e.message);
    if (!rawRes.headersSent) res.status(500).json({ error: e.message });
  }
});

/* ── 실행 ─────────────────────────────────────────────────────── */
let BASE;
const req = async (p, o) => {
  const r = await fetch(BASE + p, o);
  let b = null;
  try { b = await r.json(); } catch (e) { b = null; }
  return { status: r.status, body: b, headers: r.headers };
};

async function cleanup(supabase) {
  await supabase.from('products').delete().eq('keyword', E2E_KEYWORD);
  await supabase.from('price_history').delete().in('product_id', ['990001', '990002', '990003']);
  await supabase.from('alerts').delete().eq('email', E2E_EMAIL);
  await supabase.from('user_data').delete().eq('email', E2E_EMAIL);
  await supabase.from('profiles').delete().eq('email', E2E_EMAIL);
  await supabase.from('coupang_search_cache').delete().eq('keyword', E2E_KEYWORD);
  await supabase.from('search_stats').delete().eq('keyword', E2E_KEYWORD);
}

(async () => {
  await new Promise(r => coupang.listen(0, r));
  process.env.COUPANG_API_HOST = 'http://127.0.0.1:' + coupang.address().port;
  process.env.COUPANG_ACCESS_KEY = process.env.COUPANG_ACCESS_KEY || 'test';
  process.env.COUPANG_SECRET_KEY = process.env.COUPANG_SECRET_KEY || 'test';

  await new Promise(r => app.listen(0, r));
  BASE = 'http://127.0.0.1:' + app.address().port;

  const supabase = require(path.join(root, 'api', '_supabase.js'));
  const { issueToken } = require(path.join(root, 'api', '_auth.js'));

  await cleanup(supabase);   // 이전 실행 잔여물 제거

  /* ══ A. 상품 검색 ══════════════════════════════════════════ */
  console.log('\n[A] 사용자가 상품을 검색한다');
  coupangMode = 'ok';
  let r = await req('/api/search?keyword=' + encodeURIComponent(E2E_KEYWORD));
  check(r.status === 200, '검색 성공', 'HTTP ' + r.status);
  check(Array.isArray(r.body) && r.body.length > 0, '상품이 반환됨', (r.body || []).length + '건');
  check(r.headers.get('x-seosa-source') === 'api', '가격 출처 헤더 = api',
        'X-Seosa-Source: ' + r.headers.get('x-seosa-source'));
  check((r.body || []).every(p => p.lprice > 0), '모든 상품에 가격이 있음');
  check(!(r.body || []).some(p => /펩시/.test(p.title)), '검색어와 무관한 상품 제외됨',
        '반환: ' + (r.body || []).map(p => p.title.slice(0, 14)).join(' / '));

  const { data: savedP } = await supabase.from('products').select('product_id, lprice').eq('keyword', E2E_KEYWORD);
  check((savedP || []).length === 2, 'products 저장됨 (무관 상품 제외)', (savedP || []).length + '행');
  const today = new Date().toISOString().slice(0, 10);
  const { data: savedH } = await supabase.from('price_history')
    .select('product_id').in('product_id', ['990001', '990002']).eq('recorded_date', today);
  check((savedH || []).length === 2, 'price_history 오늘자 기록됨', (savedH || []).length + '행');

  /* ══ B. 찜 / 개인 데이터 ═══════════════════════════════════ */
  console.log('\n[B] 사용자가 찜을 추가하고 클라우드에 저장한다');
  const wish = { wish: [{ title: '테스트 상품', productId: '990001', mall: '쿠팡' }], viewed: [], searches: [] };

  r = await req('/api/sync?email=' + encodeURIComponent(E2E_EMAIL),
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(wish) });
  check(r.status === 401 && r.body.needsAuth, '인증 없이 저장 → 401 + needsAuth', 'HTTP ' + r.status);

  r = await req('/api/sync?email=' + encodeURIComponent(E2E_EMAIL));
  check(r.status === 401, '인증 없이 조회 → 401');

  const token = issueToken(E2E_EMAIL);
  const AUTH = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };

  r = await req('/api/sync?email=' + encodeURIComponent(E2E_EMAIL),
    { method: 'POST', headers: AUTH, body: JSON.stringify(wish) });
  check(r.status === 200 && r.body.success, '인증 후 저장 성공', 'HTTP ' + r.status);

  r = await req('/api/sync?email=' + encodeURIComponent(E2E_EMAIL), { headers: AUTH });
  check(r.status === 200 && r.body.success && r.body.data.wish.length === 1,
        '저장한 찜이 그대로 조회됨', JSON.stringify(r.body.data.wish).slice(0, 50));

  const otherToken = issueToken('someone-else@seosa.test');
  r = await req('/api/sync?email=' + encodeURIComponent(E2E_EMAIL),
    { headers: { Authorization: 'Bearer ' + otherToken } });
  check(r.status === 401, '남의 토큰으로 접근 → 401', r.body && r.body.error);

  /* ══ C. 가격 알림 ══════════════════════════════════════════ */
  console.log('\n[C] 사용자가 가격 알림을 신청한다');
  const alertBody = {
    email: E2E_EMAIL, title: E2E_KEYWORD + ' 프로 노이즈캔슬링',
    targetPrice: 50000, currentPrice: 89000, mall: '쿠팡',
    link: 'https://link.coupang.com/e2e/1', productId: '990001'
  };

  r = await req('/api/alerts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(alertBody) });
  check(r.status === 401, '인증 없이 알림 신청 → 401');

  r = await req('/api/alerts', { method: 'POST', headers: AUTH, body: JSON.stringify(alertBody) });
  check(r.status === 200 && r.body.success, '인증 후 알림 신청 성공', 'HTTP ' + r.status);

  const { data: al } = await supabase.from('alerts').select('*').eq('email', E2E_EMAIL);
  check((al || []).length === 1, 'alerts 저장됨');
  check((al || []).length === 1 && al[0].target_price === 50000, '목표가 정확히 저장', String((al[0] || {}).target_price));
  check((al || []).length === 1 && al[0].sent === false, '미발송 상태로 저장 (내일 판정 대상)');

  r = await req('/api/alerts?email=' + encodeURIComponent(E2E_EMAIL), { headers: AUTH });
  check(r.status === 200 && Array.isArray(r.body) && r.body.length === 1, '내 알림 조회됨');

  /* ══ D. 쿠팡 장애 ══════════════════════════════════════════ */
  console.log('\n[D] 쿠팡 API 장애가 발생한다');
  const beforeCount = (await supabase.from('price_history')
    .select('id', { count: 'exact', head: true }).eq('recorded_date', today)).count;

  coupangMode = 'denied';
  // 캐시가 남아 있으면 stale-cache 로 응답한다. 캐시를 지우고 완전 장애를 만든다.
  await supabase.from('coupang_search_cache').delete().eq('keyword', E2E_KEYWORD);

  r = await req('/api/search?keyword=' + encodeURIComponent(E2E_KEYWORD + '없는상품'));
  check(r.status === 200, '장애 중에도 500 이 아니라 정상 응답', 'HTTP ' + r.status);
  check(Array.isArray(r.body) && r.body.length === 0, '상품 0건 반환');
  check(r.headers.get('x-seosa-blocked') === '1', '차단 헤더 전달 (프론트가 안내 문구 표시)',
        'X-Seosa-Blocked: ' + r.headers.get('x-seosa-blocked'));

  const afterCount = (await supabase.from('price_history')
    .select('id', { count: 'exact', head: true }).eq('recorded_date', today)).count;
  check(afterCount === beforeCount, '장애 중 허위 가격이 저장되지 않음',
        `오늘자 행 ${beforeCount} → ${afterCount}`);

  /* ══ 정리 ══════════════════════════════════════════════════ */
  await cleanup(supabase);
  const { data: leftP } = await supabase.from('products').select('id').eq('keyword', E2E_KEYWORD);
  const { data: leftA } = await supabase.from('alerts').select('id').eq('email', E2E_EMAIL);
  console.log('\n[정리] 테스트 데이터 제거 — products ' + (leftP || []).length + '행 / alerts ' + (leftA || []).length + '행 남음');

  coupang.close(); app.close();
  console.log(`\n════ 결과: ${pass} PASS / ${fail} FAIL ════\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('오류:', e.message, e.stack); coupang.close(); app.close(); process.exit(1); });
