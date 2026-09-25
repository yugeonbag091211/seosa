#!/usr/bin/env node
'use strict';
/*
 * SEOSA 2.0 기초 — 라우팅 · 계열 로더 · 배포 상한 · 기존 경로 보존. 완전 오프라인.
 *
 * 여기서 고정하는 것
 *   1) 새 라우트는 api/_v2router.js 표에 적힌 호스트에서만 열린다
 *   2) __route 가 없거나 표에 없으면 기존 핸들러가 한 글자도 다르지 않게 돈다
 *   3) 서버리스 함수는 12개 그대로다 (Vercel Hobby 상한)
 *   4) vercel.json 이 표의 모든 라우트를 올바른 호스트로 보낸다
 *   5) _series.loadSeries 의 곡선이 /api/history 와 점 단위로 같다
 */

const fs = require('fs');
const path = require('path');
const kit = require('./_v2-testkit');
const { db, state, T, mkReq, mkRes, fetchCalls } = kit.setup('test-v2-foundation');

const ROOT = path.resolve(__dirname, '..');
const router = require('../api/_v2router');
const series = require('../api/_series');
const history = require('../api/history');
const alerts = require('../api/alerts');

async function main() {
  /* ── 1. 라우트 표 ─────────────────────────────────────────── */
  T.section('라우트 표');
  const names = Object.keys(router.ROUTES);
  T.check(names.length === 6, '여섯 기능이 전부 표에 있다', names);
  T.check(names.every(n => /^\.\/_[\w-]+$/.test(router.ROUTES[n].module)),
    '모든 모듈이 api/_*.js — 서버리스 함수로 세지 않는다');
  T.check(names.every(n => ['history', 'alerts', 'ai'].indexOf(router.ROUTES[n].host) > -1),
    '호스트는 기존 함수 셋 중 하나');
  T.check(router.routeOf(mkReq({ query: { __route: 'timing' } }), 'history') === 'timing', 'history 가 timing 을 받는다');
  T.check(router.routeOf(mkReq({ query: { __route: 'timing' } }), 'alerts') === null,
    'alerts 는 timing 을 받지 않는다 (public 라우트를 private 함수로 우회 금지)');
  T.check(router.routeOf(mkReq({ query: { __route: 'waitroom' } }), 'history') === null,
    'history 는 waitroom 을 받지 않는다 (개인 데이터 라우트를 public CORS 로 우회 금지)');
  T.check(router.routeOf(mkReq({ query: { __route: 'batch' } }), 'history') === null, '기존 batch 라우트는 표 밖');
  T.check(router.routeOf(mkReq({ query: { __route: '__proto__' } }), 'history') === null, '__proto__ 같은 키로 표를 뚫지 못한다');
  T.check(router.routeOf(mkReq({ query: {} }), 'history') === null, '__route 없으면 null');

  /* 모듈 없음 판정 — 모듈 «안의» require 실패와 가른다 */
  {
    let own = null, inner = null;
    try { require('../api/_v2-does-not-exist'); } catch (e) { own = e; }
    T.check(router._internal.isOwnModuleMissing(
      Object.assign(new Error("Cannot find module './_timing-api'\nRequire stack:\n- x"), { code: 'MODULE_NOT_FOUND' }),
      './_timing-api'), '모듈 파일 자체가 없으면 NOT_READY 로 본다');
    inner = Object.assign(new Error("Cannot find module './_helper'\nRequire stack:\n- /api/_timing-api.js"), { code: 'MODULE_NOT_FOUND' });
    T.check(!router._internal.isOwnModuleMissing(inner, './_timing-api'),
      '모듈 안의 다른 require 실패는 NOT_READY 로 숨기지 않는다');
    T.check(own && own.code === 'MODULE_NOT_FOUND', '(대조) 없는 모듈은 MODULE_NOT_FOUND');
  }

  /* ── 2. 호스트 훅 — 새 라우트만 넘기고 기존 경로는 그대로 ───────── */
  T.section('호스트 훅');
  db.products = [{ product_id: '111', mall: '쿠팡', vendor_item_id: 'V1', title: '테스트 상품', lprice: 10000,
    link: 'https://link.coupang.com/a?itemId=1&vendorItemId=V1', collected_at: new Date().toISOString() }];
  db.price_history = kit.historyRows({ productId: '111', prices: [12000, 11000, 10000] });

  {
    const res = mkRes();
    await history(mkReq({ query: { productId: '111', mall: '쿠팡' } }), res);
    T.check(Array.isArray(res.body) && res.body.length === 3, '기존 /api/history 단건 조회는 배열 그대로', res.body);
  }
  {
    const res = mkRes();
    await history(mkReq({ query: { __route: 'batch', keys: JSON.stringify(['111|쿠팡']) } }), res);
    T.check(res.body && Array.isArray(res.body['111|쿠팡']), '기존 batch 라우트 그대로', res.body);
  }
  {
    const res = mkRes();
    await history(mkReq({ query: { __route: 'timing' } }), res);
    const code = res.body && res.body.code;
    T.check(res.body && res.body.error !== '상품명 없음' && (code === 'NOT_READY' || code === 'BAD_INPUT'),
      'history?__route=timing 은 기존 단건 조회로 새지 않는다', res.body);
  }
  {
    const res = mkRes();
    await alerts(mkReq({ method: 'GET', query: {} }), res);
    T.check(res.statusCode === 400 && /이메일/.test(res.body && res.body.error), '기존 /api/alerts 는 그대로', res.body);
  }
  {
    const res = mkRes();
    await alerts(mkReq({ method: 'GET', query: { __route: 'timing' } }), res);
    T.check(res.statusCode === 400 && /이메일/.test(res.body && res.body.error),
      'alerts?__route=timing 은 v2 로 가지 않고 기존 경로를 탄다', res.body);
  }
  {
    const res = mkRes();
    await alerts(mkReq({ method: 'GET', query: { __route: 'waitroom' } }), res);
    const code = res.body && res.body.code;
    T.check(res.body && (code === 'NOT_READY' || res.statusCode === 401 || code === 'WAITROOM_NOT_READY'),
      'alerts?__route=waitroom 은 v2 로 넘어간다', res.body);
  }
  {
    // ai.js 는 무겁다 — 훅이 첫 줄에 있는지 소스로 확인하고, 실제 호출도 한 번 한다.
    const src = fs.readFileSync(path.join(ROOT, 'api', 'ai.js'), 'utf8');
    const body = src.slice(src.indexOf('module.exports = async function handler'));
    const hookAt = body.indexOf("routeOf(req, 'ai')");
    const corsAt = body.indexOf('applyCors(');
    T.check(hookAt > -1 && hookAt < corsAt, 'ai.js 훅이 기존 코드보다 앞에 있다');
    const ai = require('../api/ai');
    const res = mkRes();
    await ai(mkReq({ method: 'POST', query: { __route: 'investigate' }, body: {} }), res);
    const code = res.body && res.body.code;
    T.check(code === 'NOT_READY' || code === 'BAD_INPUT', 'ai?__route=investigate 는 v2 로 넘어간다', res.body);
  }

  /* ── 3. 배포 상한과 rewrite ───────────────────────────────── */
  T.section('배포 상한 · vercel.json');
  const fnFiles = fs.readdirSync(path.join(ROOT, 'api')).filter(f => f.endsWith('.js') && !f.startsWith('_'));
  T.check(fnFiles.length === 12, `서버리스 함수 12개 그대로 (Hobby 상한)`, fnFiles);
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  names.forEach(n => {
    const r = (vercel.rewrites || []).find(x => x.source === `/api/${n}`);
    const want = `/api/${router.ROUTES[n].host}?__route=${n}`;
    T.check(r && r.destination === want, `/api/${n} → ${want}`, r);
  });
  const catchAll = vercel.rewrites.findIndex(x => x.source === '/((?!api/).*)');
  const lastV2 = Math.max.apply(null, names.map(n => vercel.rewrites.findIndex(x => x.source === `/api/${n}`)));
  T.check(catchAll > lastV2, 'v2 rewrite 가 정적 파일 catch-all 보다 앞에 있다');

  /* ── 4. 계열 로더 ────────────────────────────────────────── */
  T.section('_series.loadSeries');
  db.products = [
    { product_id: '222', mall: '쿠팡', vendor_item_id: '', title: '옵션 상품', lprice: 15900,
      link: 'https://link.coupang.com/a?itemId=9&vendorItemId=9009', collected_at: new Date().toISOString() }
  ];
  const mine = kit.historyRows({ productId: '222', vendorItemId: '9009', prices: [16900, 15900, 15900, 15500, 15900], startId: 100 });
  const other = kit.historyRows({ productId: '222', vendorItemId: '9002', prices: [242100, null, 222390, null, null], startId: 200 });
  // 같은 날 같은 옵션 두 번 — 최저가 한 점으로 접혀야 한다
  const dup = Object.assign({}, mine[2], { id: 300, price: 15400, recorded_at: mine[2].recorded_at.replace('03:00', '05:00') });
  db.price_history = mine.concat(other, [dup]);

  const s = await series.loadSeries({ productId: '222', mall: '쿠팡' });
  T.check(s.vendorItemId === '9009', 'vendorItemId 가 없으면 카탈로그 link 에서 채운다', s.vendorItemId);
  T.check(s.rawRows.length === 8, 'rawRows 에는 다른 옵션까지 남는다 (이상 탐지용)', s.rawRows.length);
  T.check(s.rows.every(r => r.vendor_item_id === '9009'), 'rows 는 이 옵션만');
  T.check(s.points.length === 5 && s.points[2].price === 15400, '같은 날 여러 행은 최저가 한 점', s.points);
  T.check(s.rawRows.every((r, i, a) => i === 0 || String(a[i - 1].recorded_at) <= String(r.recorded_at)), 'rawRows 는 시간 오름차순');
  T.check(s.product && s.product.title === '옵션 상품', '카탈로그 행을 함께 준다');

  {
    const res = mkRes();
    await history(mkReq({ query: { productId: '222', mall: '쿠팡', vendorItemId: '9009' } }), res);
    T.check(JSON.stringify(res.body) === JSON.stringify(s.points), '/api/history 곡선과 점 단위로 같다',
      { history: res.body, series: s.points });
  }
  {
    const none = await series.loadSeries({ productId: '' });
    T.check(none.points.length === 0 && none.product === null, 'productId 없으면 빈 계열 (throw 하지 않는다)');
    const s2 = await series.loadSeries({ productId: '222', mall: '쿠팡', vendorItemId: 'V404' });
    T.check(s2.rows.length === 0, '다른 옵션 기록만 있으면 남의 가격을 빌려 오지 않는다 (sameVendorRows ②)');
  }
  {
    state.failNext.price_history = 'boom';
    await T.throws(() => series.loadSeries({ productId: '222' }), 'price_history 조회 실패는 throw (핸들러가 fail 로 처리)');
  }
  T.check(series.readKey({ productId: '1;drop' }) === null, 'readKey 는 이상한 식별자를 받지 않는다');
  T.check(JSON.stringify(series.readKey({ pid: '123', mall: '쿠팡' })) === JSON.stringify({ productId: '123', mall: '쿠팡', vendorItemId: '' }),
    'readKey 는 pid 별칭도 받는다');

  /* ── 5. 기록 쓰기 없음 · 외부 호출 없음 ─────────────────────── */
  T.section('안전');
  T.check(state.writes.filter(w => ['products', 'price_history'].indexOf(w.table) > -1).length === 0,
    '가격 원장·카탈로그에 한 행도 쓰지 않았다');
  T.check(fetchCalls.length === 0, '외부 호출 0회', fetchCalls);

  /* ── 6. 러너 · 화면 ─────────────────────────────────────── */
  T.section('러너 · 화면');
  const { discover } = require('./test-seosa2');
  T.check(discover().indexOf('test-v2-foundation.js') > -1, '러너가 test-v2-*.js 를 찾는다');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  T.check(/node scripts\/test-seosa2\.js/.test(pkg.scripts.test), 'npm test 체인에 러너가 있다');
  const vercelRoutes = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  T.check(['api/ai.js', 'api/history.js', 'api/alerts.js'].every(p =>
    vercelRoutes.functions[p] && vercelRoutes.functions[p].includeFiles === 'api/_*.js'),
  'Vercel 호스트 함수는 동적 라우트 모듈을 런타임에 포함한다');
  ['index.html', 'v2.css', 'v2.js'].forEach(f =>
    T.check(fs.existsSync(path.join(ROOT, 'public', 'v2', f)), `public/v2/${f} 존재`));
  {
    // V2.session() — index.html 이 저장하는 expiresAt(ISO 문자열)을 제대로 읽는가
    const vm = require('vm');
    const src = fs.readFileSync(path.join(ROOT, 'public', 'v2', 'v2.js'), 'utf8');
    const sessionOf = stored => {
      const store = { seosa_token: JSON.stringify(stored) };
      const ctx = { localStorage: { getItem: k => store[k] || null, setItem() {} }, document: { addEventListener() {} } };
      ctx.window = ctx;
      vm.createContext(ctx);
      vm.runInContext(src, ctx);
      return ctx.V2.session();
    };
    T.check(!!sessionOf({ token: 't', expiresAt: new Date(Date.now() + 86400000).toISOString() }), '만료 전 토큰(ISO)은 로그인 상태');
    T.check(!sessionOf({ token: 't', expiresAt: new Date(Date.now() - 1000).toISOString() }), '만료된 토큰(ISO)은 로그아웃 상태');
    T.check(!sessionOf({ token: 't', expiresAt: Date.now() - 1000 }), '만료된 토큰(숫자)도 로그아웃 상태');
    T.check(sessionOf({ expiresAt: '' }) === null, '토큰 없으면 null');
  }
  /*
   * 홈페이지 진입점 (2026-09-24, 별도 승인 PR — scripts/test-v2-extension.js 에 상세 계약).
   * 배포 전에는 "링크 자체가 없다" 가 계약이었다. 이제 ③⑤⑥이 운영에 있으므로,
   * "허브(/v2/index.html) 하나로만, 기존 부가 기능 메뉴 안에서" 로 계약을 좁힌다 —
   * 개별 기능 딥링크·새 헤더 요소가 없다는 것은 test-v2-extension.js 가 자세히 고정한다.
   */
  const home = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  T.check((home.match(/href="\/v2\/index\.html"/g) || []).length === 1,
    '기존 홈 화면(index.html)은 SEOSA 2.0 허브(/v2/index.html) 하나만 링크한다 (개별 기능 무수정)');
  T.check(['/v2/investigator.html', '/v2/cart.html', '/v2/anomaly.html'].every(p => home.includes(p)),
    '기존 홈은 준비된 조사관·장바구니·이상 패턴으로 연결된다');
  T.check(!home.includes('/v2/timing.html') && !home.includes('/v2/waitroom.html'),
    '준비 전 타이밍·대기실은 기존 홈에서 공개하지 않는다');

  T.done();
}

main().catch(e => { console.error(e); process.exitCode = 1; });
