#!/usr/bin/env node
'use strict';
/*
 * SEOSA 2.0 ④ 브라우저 확장 + GET /api/lookup — 완전 오프라인.
 *
 * 여기서 고정하는 것
 *   1) parse.js 는 지원하는 상품 상세 페이지만 인정한다 (닮은 호스트·http·비상품 페이지 → null)
 *   2) manifest 는 최소 권한이다 — storage 하나 + https://seosa.ai.kr/* 하나, 상품 상세 페이지에서만 돈다
 *   3) 서비스 워커는 이 확장·지원 페이지·올바른 번호일 때만, seosa.ai.kr/api/lookup 에 «한 번», 쿠키 없이 나간다
 *   4) 콘텐츠 스크립트는 누르기 전에 아무것도 보내지 않고, 서버 문자열을 HTML 로 해석하지 않는다
 *   5) /api/lookup 은 EXACT · SIMILAR · NONE 을 가르고, 비슷한 상품의 기록을 이 상품의 기록으로 내보내지 않는다
 *   6) 다른 판매처 오퍼는 SEOSA HOT 과 같은 동일상품 관문(judgeSameProduct A + canMerge)을 넘은 것만
 *   7) 읽기 전용 · 외부 호출 0회
 *
 * ★ 이 파일은 네트워크를 부르지 않는다. 서비스 워커·콘텐츠 스크립트는 vm 샌드박스 안에서
 *   가짜 chrome · 가짜 네트워크 함수로 돌린다. 전역 네트워크 함수는 testkit 이 막아 둔 그대로다.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const kit = require('./_v2-testkit');
const { db, state, T, mkReq, mkRes, fetchCalls } = kit.setup('test-v2-extension');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const Parse = require('../extension/src/parse.js');
const L = require('../api/_lookup');
const lookupApi = require('../api/_lookup-api');
const history = require('../api/history');
const { kstToday } = require('../api/_kst');

const hex = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** 주석을 벗긴다 — 설명문에 적힌 낱말(innerHTML 등)을 코드로 오인하지 않기 위해. */
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ');

/* ==================================================================
 *  1) parse.js
 * ================================================================== */
function testParse() {
  T.section('parse.js — 상품 상세 주소만 인정한다');
  const p = Parse.parseProductUrl;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  T.check(same(p('https://www.coupang.com/vp/products/1001'),
    { site: 'coupang', productId: '1001', itemId: '', vendorItemId: '' }), '쿠팡 — 번호만 있는 주소');
  T.check(same(p('https://www.coupang.com/vp/products/1001?itemId=5001&vendorItemId=9001'),
    { site: 'coupang', productId: '1001', itemId: '5001', vendorItemId: '9001' }), '쿠팡 — itemId · vendorItemId');
  T.check(same(p('https://www.coupang.com/vp/products/1001?q=%EC%95%84&itemId=5001&searchId=abc&vendorItemId=9001&sourceType=srp#sdpReview'),
    { site: 'coupang', productId: '1001', itemId: '5001', vendorItemId: '9001' }), '쿠팡 — 다른 파라미터 · 조각(#) 이 섞여도');
  T.check(same(p('https://www.coupang.com/vp/products/1001/?vendorItemId=9001'),
    { site: 'coupang', productId: '1001', itemId: '', vendorItemId: '9001' }), '쿠팡 — 끝 슬래시 · vendorItemId 만');
  T.check((p('https://WWW.COUPANG.COM/vp/products/1001') || {}).productId === '1001', '호스트 대소문자는 URL 파서가 정규화한다');
  T.check((p('https://www.coupang.com/vp/products/1001?vendorItemId=abc') || {}).vendorItemId === '', '숫자가 아닌 vendorItemId 는 버린다 (고쳐 읽지 않는다)');
  T.check((p('https://www.coupang.com/vp/products/1001?itemId=1&itemId=2') || {}).itemId === '', '같은 키가 둘이면 모호하니 버린다');

  [
    'https://www.coupang.com/',
    'https://www.coupang.com/np/search?q=%EB%B2%84%EC%A6%88',
    'https://www.coupang.com/np/categories/178255',
    'https://www.coupang.com/vp/products/',
    'https://www.coupang.com/vp/products/abc',
    'https://www.coupang.com/vp/products/1001/reviews',
    'https://www.coupang.com/vp/products/123456789012345678901',
    'https://www.coupang.com/cart'
  ].forEach(u => T.check(p(u) === null, `상품 페이지가 아니면 null — ${u.replace('https://www.coupang.com', '')}`));

  [
    'https://www.coupang.com.evil.example/vp/products/1001',
    'https://evilcoupang.com/vp/products/1001',
    'https://coupang.com/vp/products/1001',
    'https://m.coupang.com/vm/products/1001',
    'https://www.coupang.co/vp/products/1001',
    'https://www.coupang.com@evil.example/vp/products/1001',
    'https://user:pw@www.coupang.com/vp/products/1001',
    'https://evil.example/?u=https://www.coupang.com/vp/products/1001',
    'https://evil.example/www.coupang.com/vp/products/1001',
    'https://www.coupang.com:8443/vp/products/1001',
    'https://www.11st.co.kr.evil.example/products/1234',
    'https://item.gmarket.co.kr.evil.example/Item?goodscode=1234'
  ].forEach(u => T.check(p(u) === null, `닮은/악성 호스트 → null — ${u}`));

  ['http://www.coupang.com/vp/products/1001', 'ftp://www.coupang.com/vp/products/1001',
    'javascript:alert(1)//www.coupang.com/vp/products/1001', 'data:text/html,x', '', null, undefined, 1001, {},
    'https://www.coupang.com/vp/products/1001?x=' + 'a'.repeat(3000)]
    .forEach(u => T.check(p(u) === null, `https 가 아니거나 문자열이 아니면 null — ${String(u).slice(0, 50)}`));

  T.check(same(p('https://www.11st.co.kr/products/1234567890'),
    { site: '11st', productId: '1234567890', itemId: '', vendorItemId: '' }), '11번가 상품 페이지');
  T.check((p('https://www.11st.co.kr/products/1234567890?trTypeCd=22&trCtgrNo=585021') || {}).site === '11st', '11번가 — 파라미터가 있어도');
  T.check(p('https://www.11st.co.kr/browsing/BestSeller.tmall') === null, '11번가 — 상품 페이지가 아니면 null');
  T.check(same(p('https://item.gmarket.co.kr/Item?goodscode=2345678901'),
    { site: 'gmarket', productId: '2345678901', itemId: '', vendorItemId: '' }), 'G마켓 상품 페이지');
  T.check((p('https://item.gmarket.co.kr/Item?goodsCode=2345678901&ver=1') || {}).productId === '2345678901', 'G마켓 — goodsCode 대소문자');
  T.check(p('https://item.gmarket.co.kr/Item') === null, 'G마켓 — 번호 없으면 null');
  T.check(p('https://item.gmarket.co.kr/Item?goodscode=abc') === null, 'G마켓 — 숫자 아닌 번호 null');
  T.check(p('https://item.gmarket.co.kr/Item/Detail?goodscode=1') === null, 'G마켓 — 다른 경로 null');

  T.check(Parse.productKey(p('https://www.coupang.com/vp/products/1?vendorItemId=2')) === 'coupang|1|2'
    && Parse.productKey(null) === '', 'productKey — 옵션까지 가른다');

  T.section('cleanTitle — 몰 이름 떼기 · 200자');
  const c = Parse.cleanTitle;
  T.check(c('삼성 버즈3 프로 - 쿠팡!') === '삼성 버즈3 프로', '"- 쿠팡!" 꼬리');
  T.check(c('Apple 2024 맥북 에어 13 M3 - 노트북 | 쿠팡') === 'Apple 2024 맥북 에어 13 M3', '"- 카테고리 | 쿠팡" 꼬리');
  T.check(c('[11번가] 코멧 물티슈 - 11번가') === '코멧 물티슈', '11번가 머리·꼬리');
  T.check(c('G마켓 - 코멧 물티슈') === '코멧 물티슈', 'G마켓 머리');
  T.check(c('LG - 코드제로 A9') === 'LG - 코드제로 A9', '상품명 안의 " - " 는 남긴다');
  T.check(c('  a\n\t  b\u0000c  ') === 'a b c', '제어문자 · 공백 접기');
  T.check(c('쿠팡!') === '' && c(null) === '' && c(undefined) === '', '몰 이름뿐이거나 비면 빈 문자열');
  T.check(c('가'.repeat(300)).length === 200, '200자 상한');
  const emo = c('😀'.repeat(250));
  T.check(Array.from(emo).length === 200 && !/[\ud800-\udbff]$/.test(emo), '이모지를 반으로 자르지 않는다');

  const samples = ['삼성 버즈3 프로 - 쿠팡!', 'Apple 2024 맥북 에어 13 M3 - 노트북 | 쿠팡', '[11번가] 코멧 물티슈 - 11번가',
    'G마켓 - 코멧 물티슈', 'LG - 코드제로 A9', '  a\n\t  b  ', '쿠팡!', '가'.repeat(300), '😀'.repeat(250), '지마켓: 상품'];
  T.check(samples.every(s => L.cleanTitle(s) === c(s)), '확장과 서버(api/_lookup.cleanTitle)가 같은 제목을 만든다',
    samples.filter(s => L.cleanTitle(s) !== c(s)));
}

/* ==================================================================
 *  2) manifest.json — 최소 권한
 * ================================================================== */
function testManifest() {
  T.section('manifest.json — 최소 권한 · 상품 상세 페이지만');
  const raw = fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8');
  let m = null;
  try { m = JSON.parse(raw); } catch (e) { /* 아래에서 실패 */ }
  T.check(!!m, 'JSON 으로 읽힌다');
  if (!m) return;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  T.check(m.manifest_version === 3, 'Manifest V3');
  T.check(m.name === 'SEOSA 가격 기록' && m.version === '0.1.0', '이름 · 버전');
  T.check(typeof m.description === 'string' && /[가-힣]/.test(m.description) && Array.from(m.description).length <= 132,
    '한국어 설명 (웹스토어 132자 이하)');
  T.check(same(m.permissions, ['storage']), 'permissions 는 정확히 ["storage"]', m.permissions);
  T.check(same(m.host_permissions, ['https://seosa.ai.kr/*']), 'host_permissions 는 정확히 ["https://seosa.ai.kr/*"]', m.host_permissions);
  ['optional_permissions', 'optional_host_permissions', 'externally_connectable', 'web_accessible_resources',
    'content_scripts_world', 'declarative_net_request', 'chrome_url_overrides', 'devtools_page', 'oauth2', 'key', 'update_url']
    .forEach(k => T.check(!(k in m), `${k} 없음`));
  const FORBIDDEN = ['tabs', 'activeTab', 'scripting', 'cookies', 'history', 'webRequest', 'webRequestBlocking',
    'webNavigation', 'declarativeNetRequest', 'bookmarks', 'downloads', 'management', 'nativeMessaging',
    'clipboardRead', 'clipboardWrite', 'geolocation', 'identity', 'topSites', 'debugger', 'proxy', 'privacy',
    'unlimitedStorage', 'background', 'alarms', 'notifications'];
  const perms = [].concat(m.permissions || [], m.host_permissions || []);
  T.check(FORBIDDEN.every(f => perms.indexOf(f) === -1), '위험 권한(tabs·activeTab·scripting·cookies·history·webRequest …) 없음');
  T.check(raw.indexOf('<all_urls>') === -1 && !/"\*:\/\/\*\/\*"|"https?:\/\/\*\//.test(raw), '<all_urls> · 모든 사이트 패턴 없음');

  T.check(m.background && m.background.service_worker === 'src/background.js', '서비스 워커 src/background.js');
  T.check(m.background && m.background.type !== 'module' && !m.background.scripts && !m.background.page,
    '고전 워커 (importScripts 사용) · MV2 배경 페이지 없음');

  const ALLOWED = ['https://www.coupang.com/vp/products/*', 'https://www.11st.co.kr/products/*', 'https://item.gmarket.co.kr/Item*'];
  const cs = Array.isArray(m.content_scripts) ? m.content_scripts : [];
  const matches = [].concat.apply([], cs.map(c => c.matches || []));
  T.check(cs.length > 0 && matches.length > 0 && matches.every(x => ALLOWED.indexOf(x) > -1),
    '모든 content_scripts match 가 상품 상세 패턴이다', matches);
  T.check(matches.indexOf('https://www.coupang.com/vp/products/*') > -1, '쿠팡 상품 상세는 반드시 포함');
  T.check(matches.every(x => /^https:\/\/[a-z0-9.-]+\//.test(x) && x.split('/')[2].indexOf('*') === -1),
    'https 만 · 호스트에 와일드카드 없음');
  T.check(cs.every(c => c.run_at === 'document_idle' && c.all_frames !== true && !c.match_about_blank && !c.world
    && !(c.exclude_matches && c.exclude_matches.length === 0)), 'document_idle · 최상위 프레임만 · 격리된 세계');
  T.check(cs.every(c => same(c.js, ['src/parse.js', 'src/content.js'])), 'parse.js 가 content.js 보다 먼저 들어간다');

  const files = [m.background && m.background.service_worker]
    .concat([].concat.apply([], cs.map(c => (c.js || []).concat(c.css || []))))
    .filter(Boolean);
  T.check(files.length >= 3 && files.every(f => fs.existsSync(path.join(EXT, f))), '참조한 파일이 전부 있다', files);
  ['README.md', 'PRIVACY.md'].forEach(f => T.check(fs.existsSync(path.join(EXT, f)), `extension/${f} 존재`));
  const binaries = fs.readdirSync(EXT, { recursive: true }).filter(f => /\.(png|jpe?g|gif|ico|webp|crx|zip)$/i.test(String(f)));
  T.check(binaries.length === 0, '바이너리(아이콘 등) 파일 없음', binaries);

  const csp = (m.content_security_policy && m.content_security_policy.extension_pages) || '';
  T.check(!csp || (!/unsafe-eval|unsafe-inline|https?:|\*/.test(csp)), 'CSP 를 느슨하게 만들지 않는다', csp);

  T.section('확장 스크립트 — 원격 코드 없음 · 나가는 곳은 seosa.ai.kr 하나');
  const ALLOWED_URLS = ['https://seosa.ai.kr', 'https://seosa.ai.kr/api/lookup', 'http://www.w3.org/2000/svg'];
  fs.readdirSync(path.join(EXT, 'src')).filter(f => f.endsWith('.js')).forEach(f => {
    const code = stripComments(fs.readFileSync(path.join(EXT, 'src', f), 'utf8'));
    const urls = code.match(/\b(?:https?|wss?):\/\/[^'"`\s)]+/g) || [];
    T.check(urls.every(u => ALLOWED_URLS.indexOf(u) > -1), `${f} — 허용된 주소만 (seosa.ai.kr · SVG 네임스페이스)`, urls);
    T.check(!/\beval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*['"`]|setInterval\s*\(\s*['"`]/.test(code), `${f} — eval · 문자열 실행 없음`);
    T.check(!/XMLHttpRequest|WebSocket|sendBeacon|EventSource|\bimport\s*\(/.test(code), `${f} — 다른 통신 경로 없음`);
    const imports = code.match(/importScripts\s*\(([^)]*)\)/g) || [];
    T.check(imports.every(s => /importScripts\s*\(\s*'parse\.js'\s*\)/.test(s)), `${f} — importScripts 는 로컬 parse.js 만`, imports);
  });
}

/* ==================================================================
 *  3) background.js — vm 샌드박스
 * ================================================================== */
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';

function loadBackground(respond) {
  const src = fs.readFileSync(path.join(EXT, 'src', 'background.js'), 'utf8');
  const parseSrc = fs.readFileSync(path.join(EXT, 'src', 'parse.js'), 'utf8');
  const listeners = [];
  const calls = [];
  const imported = [];
  let ctx = null;
  function fakeNet(url, init) {
    calls.push({ url: String(url), init: init || {} });
    const r = respond ? respond(String(url), init) : { status: 200, body: { ok: true, match: { status: 'EXACT' } } };
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300, status: r.status,
      json: () => (r.body === undefined ? Promise.reject(new Error('no json')) : Promise.resolve(r.body))
    });
  }
  const sandbox = {
    console, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    chrome: {
      runtime: { id: EXT_ID, onMessage: { addListener: fn => listeners.push(fn) } },
      storage: { local: { get(k, cb) { cb({}); }, set() {} } },
      action: { onClicked: { addListener() {} } }
    },
    importScripts(...files) {
      files.forEach(f => {
        imported.push(f);
        if (f !== 'parse.js') throw new Error(`예상하지 못한 importScripts: ${f}`);
        vm.runInContext(parseSrc, ctx, { filename: 'parse.js' });
      });
    },
    fetch: fakeNet
  };
  sandbox.self = sandbox;
  ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: 'background.js' });
  return { listeners, calls, imported };
}

/** 리스너에 메시지를 넣고 sendResponse 로 돌아온 값을 기다린다. */
function send(bg, msg, sender) {
  return new Promise(resolve => {
    const ret = bg.listeners[0](msg, sender, r => resolve({ r, ret }));
    if (ret !== true) resolve({ r: undefined, ret });
  });
}

async function testBackground() {
  T.section('background.js — 메시지 검증 · 단 하나의 GET');
  const bg = loadBackground();
  T.check(bg.listeners.length === 1, 'onMessage 리스너 하나');
  T.check(bg.imported.length === 1 && bg.imported[0] === 'parse.js', 'parse.js 를 importScripts 로 공유한다');

  const CP = 'https://www.coupang.com/vp/products/1001?itemId=5001&vendorItemId=9001';
  const okSender = { id: EXT_ID, url: CP, tab: { id: 7, url: CP } };
  const okMsg = { type: 'seosa:lookup', site: 'coupang', productId: '1001', vendorItemId: '9001', itemId: '5001',
    title: '삼성전자 갤럭시 S25 자급제 SM-S931N 256GB 실버 - 쿠팡!' };

  {
    const out = await send(bg, { type: 'other' }, okSender);
    T.check(out.ret === false && out.r === undefined && bg.calls.length === 0, '모르는 메시지는 답하지도 부르지도 않는다');
  }
  const rejects = [
    ['다른 확장 id', okMsg, Object.assign({}, okSender, { id: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' })],
    ['sender 없음', okMsg, null],
    ['비상품 페이지', okMsg, { id: EXT_ID, url: 'https://www.coupang.com/np/search?q=a' }],
    ['닮은 호스트', okMsg, { id: EXT_ID, url: 'https://www.coupang.com.evil.example/vp/products/1001' }],
    ['http 페이지', okMsg, { id: EXT_ID, url: 'http://www.coupang.com/vp/products/1001' }],
    ['주소 없음', okMsg, { id: EXT_ID }],
    ['번호 형식 오류', Object.assign({}, okMsg, { productId: '1001a' }), okSender],
    ['옵션 형식 오류', Object.assign({}, okMsg, { vendorItemId: '9001;x' }), okSender],
    ['itemId 형식 오류', Object.assign({}, okMsg, { itemId: '5001&productId=2' }), okSender],
    ['번호가 탭 주소와 다름', Object.assign({}, okMsg, { productId: '1002' }), okSender],
    ['site 가 탭과 다름', Object.assign({}, okMsg, { site: '11st' }), okSender],
    ['모르는 site', Object.assign({}, okMsg, { site: 'naver' }), okSender],
    ['숫자 타입 번호', Object.assign({}, okMsg, { productId: 1001 }), okSender],
    ['너무 긴 제목', Object.assign({}, okMsg, { title: 'a'.repeat(5000) }), okSender],
    ['11번가 제목 없음', { type: 'seosa:lookup', site: '11st', productId: '123456', title: '11번가' },
      { id: EXT_ID, url: 'https://www.11st.co.kr/products/123456' }]
  ];
  for (const [label, msg, sender] of rejects) {
    const before = bg.calls.length;
    const out = await send(bg, msg, sender);
    T.check(out.ret === true && out.r && out.r.ok === false && /[가-힣]/.test(out.r.error) && bg.calls.length === before,
      `거절 — ${label} (요청 없음, 한국어 이유)`, out.r);
  }
  T.check(bg.calls.length === 0, '거절된 메시지는 네트워크를 한 번도 쓰지 않았다', bg.calls.length);

  {
    const out = await send(bg, okMsg, okSender);
    T.check(out.r && out.r.ok === true && out.r.data && out.r.data.match.status === 'EXACT', '올바른 메시지 → { ok:true, data }', out.r);
    T.check(bg.calls.length === 1, '요청은 정확히 한 번', bg.calls.length);
    const c = bg.calls[0] || { url: '', init: {} };
    const u = new URL(c.url);
    T.check(u.origin + u.pathname === 'https://seosa.ai.kr/api/lookup', 'https://seosa.ai.kr/api/lookup 로만', c.url);
    T.check(u.searchParams.get('productId') === '1001' && u.searchParams.get('vendorItemId') === '9001'
      && u.searchParams.get('itemId') === '5001', '번호 세 개를 싣는다');
    T.check(u.searchParams.get('title') === '삼성전자 갤럭시 S25 자급제 SM-S931N 256GB 실버', '제목은 정리해서 싣는다 (몰 이름 제거)');
    T.check([...u.searchParams.keys()].sort().join(',') === 'itemId,productId,title,vendorItemId', '그 밖의 값은 싣지 않는다',
      [...u.searchParams.keys()]);
    T.check((c.init.method || 'GET') === 'GET' && c.init.body === undefined, 'GET · 본문 없음');
    T.check(c.init.credentials === 'omit', "credentials:'omit' — 쿠키를 싣지 않는다");
    T.check(c.init.redirect === 'error' && c.init.referrerPolicy === 'no-referrer', '다른 주소로 넘어가지 않고 리퍼러도 없다');
    T.check(!!c.init.signal, '시간 제한(AbortController) 신호를 단다');
    const h = c.init.headers || {};
    T.check(!Object.keys(h).some(k => /cookie|authorization/i.test(k)), '쿠키 · 인증 헤더 없음', h);
  }
  {
    const before = bg.calls.length;
    const sender = { id: EXT_ID, url: 'https://www.11st.co.kr/products/123456' };
    const out = await send(bg, { type: 'seosa:lookup', site: '11st', productId: '123456', title: '코멧 무향 물티슈 캡형 100매 - 11번가' }, sender);
    const u = new URL((bg.calls[before] || {}).url || 'https://x.invalid/');
    T.check(out.r && out.r.ok === true && bg.calls.length === before + 1, '11번가 — 한 번 부른다');
    T.check([...u.searchParams.keys()].join(',') === 'title' && u.searchParams.get('title') === '코멧 무향 물티슈 캡형 100매',
      '11번가 — 제목만 보낸다 (다른 몰 번호는 SEOSA 번호 체계가 아니다)', c2s(u));
  }
  {
    const before = bg.calls.length;
    const sender = { id: EXT_ID, tab: { url: 'https://item.gmarket.co.kr/Item?goodscode=2345678901' } };
    const out = await send(bg, { type: 'seosa:lookup', site: 'gmarket', productId: '2345678901', title: 'G마켓 - 코멧 물티슈' }, sender);
    T.check(out.r && out.r.ok === true && bg.calls.length === before + 1, 'G마켓 — sender.tab.url 로도 확인한다');
  }

  const errCases = [
    ['500 + 서버 문장', () => ({ status: 500, body: { error: '가격 기록을 불러오지 못했어요.' } }), /불러오지 못했어요/],
    ['429', () => ({ status: 429, body: { error: 'x' } }), /너무 잦아요/],
    ['501', () => ({ status: 501, body: { ok: false, code: 'NOT_READY' } }), /준비되지 않았어요/],
    ['네트워크 오류', () => new TypeError('Failed to fetch'), /연결하지 못했어요/],
    ['시간 초과', () => Object.assign(new Error('aborted'), { name: 'AbortError' }), /응답이 늦어요/],
    ['JSON 아님', () => ({ status: 200 }), /읽지 못했어요/],
    ['모양이 다른 응답', () => ({ status: 200, body: { ok: true } }), /읽지 못했어요/]
  ];
  for (const [label, respond, re] of errCases) {
    const b = loadBackground(respond);
    const out = await send(b, okMsg, okSender);
    T.check(out.r && out.r.ok === false && re.test(out.r.error) && b.calls.length === 1, `오류 → 한국어 문장 — ${label}`, out.r);
  }

  const src = stripComments(read('extension/src/background.js'));
  T.check(src.split(/\bfetch\s*\(/).length === 2, '서비스 워커 소스에 네트워크 호출 자리는 하나뿐');
  T.check(/TIMEOUT_MS\s*=\s*10000/.test(src), '시간 제한 10초');
}
function c2s(u) { return u.toString(); }

/* ==================================================================
 *  4) content.js — 정적 검사 + 가짜 DOM 에서 한 번 돌리기
 * ================================================================== */
class FakeNode {
  constructor(tag, ns) {
    this.tagName = String(tag).toUpperCase(); this.ns = ns || null;
    this.children = []; this.attributes = {}; this.listeners = {}; this.style = {};
    this._text = ''; this.parentNode = null; this.className = ''; this.hidden = false; this.isConnected = true;
  }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); c.parentNode = null; return c; }
  get firstChild() { return this.children[0] || null; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  attachShadow(o) { this.shadowMode = o && o.mode; this.shadow = new FakeNode('#shadow-root'); return this.shadow; }
  focus() {}
  click() { (this.listeners.click || []).forEach(fn => fn({ type: 'click' })); }
  set innerHTML(v) { throw new Error('innerHTML 사용 금지'); }
  set outerHTML(v) { throw new Error('outerHTML 사용 금지'); }
  insertAdjacentHTML() { throw new Error('insertAdjacentHTML 사용 금지'); }
}
function walk(n, fn) { fn(n); n.children.forEach(c => walk(c, fn)); if (n.shadow) walk(n.shadow, fn); }
function findAll(root, pred) { const out = []; walk(root, n => { if (pred(n)) out.push(n); }); return out; }

function loadContent(href) {
  const parseSrc = fs.readFileSync(path.join(EXT, 'src', 'parse.js'), 'utf8');
  const src = fs.readFileSync(path.join(EXT, 'src', 'content.js'), 'utf8');
  const html = new FakeNode('html');
  const meta = new FakeNode('meta'); meta.setAttribute('content', '삼성전자 갤럭시 S25 자급제 SM-S931N 256GB 실버');
  const sent = [], stored = [], intervals = [], winListeners = {};
  const document = {
    documentElement: html,
    title: '삼성전자 갤럭시 S25 자급제 SM-S931N 256GB 실버 - 스마트폰 | 쿠팡',
    createElement: t => new FakeNode(t),
    createElementNS: (ns, t) => new FakeNode(t, ns),
    createTextNode: t => { const n = new FakeNode('#text'); n._text = String(t); return n; },
    querySelector: sel => (sel === 'meta[property="og:title"]' ? meta : null),
    get cookie() { throw new Error('쿠키를 읽으면 안 된다'); }
  };
  const sandbox = {
    console, URL, document, location: { href },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); },
    chrome: {
      runtime: { sendMessage: (msg, cb) => sent.push({ msg, cb }), lastError: undefined },
      storage: {
        local: { get: (k, cb) => cb({}), set: o => stored.push(o) },
        onChanged: { addListener() {} }
      }
    }
  };
  sandbox.window = sandbox; sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(parseSrc, ctx, { filename: 'parse.js' });
  vm.runInContext(src, ctx, { filename: 'content.js' });
  return { html, sent, stored, intervals, winListeners, sandbox };
}

function testContent() {
  T.section('content.js — 정적 검사');
  const raw = read('extension/src/content.js');
  const code = stripComments(raw);
  T.check(/attachShadow\(\{\s*mode:\s*'closed'\s*\}\)/.test(code), '닫힌 Shadow DOM 을 쓴다');
  T.check(!/\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|createContextualFragment|DOMParser/.test(code),
    'innerHTML · outerHTML · insertAdjacentHTML · document.write 없음');
  T.check((code.match(/sendMessage/g) || []).length === 1, 'sendMessage 는 소스에 한 번뿐');
  const start = code.indexOf('function onLookupClick(');
  let depth = 0, end = -1;
  for (let i = code.indexOf('{', start); i < code.length && start > -1; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = start > -1 && end > -1 ? code.slice(start, end) : '';
  T.check(body.indexOf('chrome.runtime.sendMessage') > -1, 'sendMessage 는 onLookupClick 안에만 있다');
  T.check((code.match(/onLookupClick/g) || []).length === 2 && /addEventListener\('click',\s*onLookupClick\)/.test(code),
    'onLookupClick 은 click 리스너로만 쓰인다');
  T.check(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|new\s+Image\b/.test(code), '콘텐츠 스크립트는 직접 통신하지 않는다');
  T.check(!/document\.cookie|localStorage|sessionStorage|indexedDB|querySelectorAll|['"]input|['"]form|password|\.value\b/.test(code),
    '쿠키 · 저장소 · 입력란을 읽지 않는다');
  T.check(/rel = 'noopener noreferrer'/.test(code) && /target = '_blank'/.test(code), '새 창 링크는 noopener noreferrer');
  T.check(/protocol === 'https:'/.test(code), '링크는 https 만 연다');

  T.section('content.js — 가짜 DOM 에서 한 번 돌리기');
  const env = loadContent('https://www.coupang.com/vp/products/1001?itemId=5001&vendorItemId=9001');
  const hosts = env.html.children.filter(n => n.getAttribute('data-seosa-price-ext') !== null);
  T.check(hosts.length === 1 && hosts[0].shadowMode === 'closed', '버튼 호스트 하나 · closed shadow');
  const host = hosts[0];
  env.intervals.forEach(i => i.fn());
  T.check(env.sent.length === 0, '페이지를 열고 시간이 흘러도 아무것도 보내지 않는다 (누르기 전)', env.sent.length);
  T.check(env.intervals.length === 1 && env.intervals[0].ms >= 500 && (env.winListeners.popstate || []).length === 1,
    '가벼운 주소 감시 (주기 1개 + popstate)');
  T.check(host.style.display !== 'none', '설정을 읽은 뒤 버튼이 보인다');
  const button = findAll(host, n => n.tagName === 'BUTTON' && /가격 기록 보기/.test(n.textContent))[0];
  T.check(!!button, '"SEOSA 가격 기록 보기" 버튼');
  if (!button) return;

  button.click();
  T.check(env.sent.length === 1, '누르면 한 번 보낸다', env.sent.length);
  const msg = (env.sent[0] || {}).msg || {};
  T.check(msg.type === 'seosa:lookup' && msg.site === 'coupang' && msg.productId === '1001'
    && msg.vendorItemId === '9001' && msg.itemId === '5001', '보내는 값 — 번호', msg);
  T.check(msg.title === '삼성전자 갤럭시 S25 자급제 SM-S931N 256GB 실버', '보내는 값 — og:title 정리본', msg.title);
  T.check(Object.keys(msg).sort().join(',') === 'itemId,productId,site,title,type,vendorItemId', '그 밖의 값은 보내지 않는다', Object.keys(msg));

  const EVIL = '<img src=x onerror=alert(1)>';
  env.sent[0].cb({
    ok: true,
    data: {
      ok: true,
      match: { status: 'SIMILAR', productId: '1001', mall: '쿠팡', mallLabel: '쿠팡', title: EVIL + ' 갤럭시', tier: 'A',
        url: 'https://link.coupang.com/a/x', reasons: ['이 페이지의 상품이 아니라, 제목으로 찾은 다른 판매처 상품의 기록이에요.'] },
      points: [{ date: '2026-09-20', price: 1100000 }, { date: '2026-09-21', price: 1080000 }, { date: 'bad', price: 5 }],
      level: { level: 'cheap', label: '저렴함', pctRank: 20, obs: 12, windowDays: 90 },
      timing: { action: 'WAIT', label: '기다려 보세요' }, anomaly: null,
      offers: [
        { mall: 'ADPICK', mallLabel: '11번가', title: 'x', price: 1050000, url: 'https://adpick.example/a', observedDate: '2026-09-21', identity: { tier: 'A' } },
        { mall: 'ADPICK', mallLabel: EVIL, title: 'y', price: 1060000, url: 'javascript:alert(1)', observedDate: '2026-09-21', identity: { tier: 'A' } },
        { mall: 'ADPICK', mallLabel: 'G마켓', title: 'z', price: 1070000, url: 'http://insecure.example/', observedDate: null, identity: { tier: 'A' } }
      ],
      waitroomUrl: '/v2/waitroom.html?add=1&productId=1001&mall=%EC%BF%A0%ED%8C%A1'
    }
  });
  const all = findAll(host, () => true);
  const text = host.shadow.textContent;
  T.check(/비슷한 상품의 기록/.test(text) && /이 페이지 상품의 기록이 아니에요/.test(text), 'SIMILAR 는 «비슷한 상품의 기록 · 이 상품이 아님» 을 말한다');
  T.check(!all.some(n => n.tagName === 'IMG' || n.tagName === 'SCRIPT'), '서버 문자열이 요소가 되지 않는다 (img · script 없음)');
  T.check(text.indexOf(EVIL) > -1, '서버 문자열은 글자 그대로 보인다');
  const anchors = all.filter(n => n.tagName === 'A');
  T.check(anchors.every(a => /^https:\/\//.test(a.href) && a.target === '_blank' && a.rel === 'noopener noreferrer'),
    '모든 링크가 https · 새 창 · noopener noreferrer', anchors.map(a => a.href));
  T.check(!anchors.some(a => /javascript:|http:\/\//.test(a.href)), 'javascript: · http: 링크는 만들지 않는다');
  T.check(anchors.some(a => a.href === 'https://seosa.ai.kr/v2/waitroom.html?add=1&productId=1001&mall=%EC%BF%A0%ED%8C%A1'),
    '대기실 링크 = https://seosa.ai.kr + 상대 경로');
  const svg = all.filter(n => n.tagName === 'SVG')[0];
  T.check(!!svg && svg.ns === 'http://www.w3.org/2000/svg' && all.some(n => n.tagName === 'PATH'), 'SVG 곡선은 createElementNS 로 만든다');
  T.check(/하위 20%/.test(text) && /기다려 보세요/.test(text), '가격 위치 · 타이밍 문장');
  T.check(env.sent.length === 1, '결과를 그리는 동안 더 보내지 않는다');

  // 닫았다 다시 열면 같은 상품은 다시 보내지 않는다 (캐시)
  button.click(); button.click();
  T.check(env.sent.length === 1, '같은 상품을 다시 열어도 다시 보내지 않는다', env.sent.length);

  // 새로고침 없는 이동 → 이전 결과를 버린다
  env.sandbox.location.href = 'https://www.coupang.com/vp/products/1001?itemId=5002&vendorItemId=9002';
  env.intervals.forEach(i => i.fn());
  T.check(env.sent.length === 1, '주소가 바뀌어도 누르기 전에는 보내지 않는다');
  button.click();
  T.check(env.sent.length === 2 && env.sent[1].msg.vendorItemId === '9002', '다른 옵션으로 넘어간 뒤 누르면 새 옵션으로 보낸다');
  env.sandbox.location.href = 'https://www.coupang.com/np/search?q=x';
  env.intervals.forEach(i => i.fn());
  T.check(host.style.display === 'none', '상품 페이지가 아니게 되면 버튼을 숨긴다');
  env.sent[1].cb({ ok: true, data: { ok: true, match: { status: 'EXACT' } } });
  T.check(!/이 상품의 기록/.test(host.shadow.textContent), '떠난 페이지의 늦은 답은 그리지 않는다');

  // 버튼 숨기기 → 저장되는 값은 설정 하나
  const hide = findAll(host, n => n.tagName === 'BUTTON' && /숨기기/.test(n.textContent))[0];
  if (hide) hide.click();
  T.check(env.stored.length === 1 && JSON.stringify(env.stored[0]) === '{"seosaShowButton":false}',
    'chrome.storage 에 저장하는 것은 버튼 보이기 설정 하나', env.stored);

  // 오류 응답
  const env2 = loadContent('https://www.coupang.com/vp/products/1001');
  const b2 = findAll(env2.html, n => n.tagName === 'BUTTON' && /가격 기록 보기/.test(n.textContent))[0];
  b2.click();
  env2.sent[0].cb({ ok: false, error: '요청이 너무 잦아요. 잠시 후 다시 눌러 주세요.' });
  T.check(/너무 잦아요/.test(env2.html.children[0].shadow.textContent), '오류 문장을 보여 준다');
  const env3 = loadContent('https://www.coupang.com/np/search?q=x');
  T.check(env3.html.children[0].style.display === 'none' && env3.sent.length === 0, '상품 페이지가 아니면 버튼도 요청도 없다');
}

/* ==================================================================
 *  5) /api/lookup
 * ================================================================== */
const M = '삼성전자 갤럭시 S25 자급제 SM-S931N 256GB 실버';
const KW = '갤럭시 S25';
const NOW = new Date().toISOString();
const HOUR_AGO = new Date(Date.now() - 3600 * 1000).toISOString();
const OLD = new Date(Date.now() - 20 * 86400000).toISOString();
const ID = {
  a11: hex('a11'), gmk: hex('gmk'), auc: hex('auc'), blk: hex('blk'), two: hex('two'),
  old: hex('old'), cheap: hex('cheap'), ssg: hex('ssg'), itp: hex('itp')
};
const PRICES_1001 = [1190000, 1180000, 1150000, 1150000, 1160000, 1120000, 1100000, 1130000, 1150000, 1170000,
  1160000, 1140000, 1120000, 1110000, 1100000, 1090000, 1120000, 1130000, 1110000, 1080000];

function seed() {
  const ad = (id, label, title, lprice, extra) => Object.assign({
    product_id: id, mall: 'ADPICK', mall_label: label, vendor_item_id: '', title, lprice, oprice: null,
    image: null, link: `https://adpick.example/c/${id.slice(0, 8)}`, keyword: KW, collected_at: NOW
  }, extra || {});
  db.products = [
    { product_id: '1001', mall: '쿠팡', mall_label: '', vendor_item_id: '9001', title: M, lprice: 1100000, oprice: 1350000,
      image: 'https://img.example/1001.jpg', link: 'https://link.coupang.com/a/aaa?itemId=5001&vendorItemId=9001', keyword: KW, collected_at: NOW },
    { product_id: '1003', mall: '쿠팡', mall_label: '', vendor_item_id: '9301', title: M, lprice: 1070000, oprice: null,
      image: null, link: 'https://link.coupang.com/a/ccc?itemId=5301&vendorItemId=9301', keyword: KW, collected_at: HOUR_AGO },
    ad(ID.a11, '11번가', M, 1050000),
    ad(ID.gmk, 'G마켓', '갤럭시 S25 자급제 SM-S931N 256GB 실버 삼성전자', 1020000),
    ad(ID.auc, '옥션', '삼성전자 갤럭시 S25 자급제 SM-S931N 512GB 실버', 990000),
    ad(ID.blk, '11번가', '삼성전자 갤럭시 S25 자급제 SM-S931N 256GB 블랙', 980000),
    ad(ID.two, '옥션', '삼성전자 갤럭시 S25 자급제 SM-S931N 256GB 실버 2개', 1900000),
    ad(ID.old, '위메프', M, 900000, { collected_at: OLD }),
    ad(ID.cheap, '티몬', M, 300000),
    ad(ID.ssg, 'SSG', M, 1100000),
    ad(ID.itp, '인터파크', M, 1060000, { link: 'javascript:alert(1)' }),
    { product_id: 'N1', mall: '네이버', mall_label: '네이버', vendor_item_id: '', title: M, lprice: 500000,
      link: 'https://search.shopping.naver.com/x', keyword: KW, collected_at: NOW },
    { product_id: '2001', mall: '쿠팡', mall_label: '', vendor_item_id: '9201', title: 'LG전자 2025 그램 AI 17 WIN11 Home',
      lprice: 1500000, link: 'https://link.coupang.com/a/g17', keyword: '그램', collected_at: NOW },
    { product_id: '2002', mall: '쿠팡', mall_label: '', vendor_item_id: '9202', title: 'LG전자 그램 16 16Z90S-GA5CK',
      lprice: 1300000, link: 'https://link.coupang.com/a/g16', keyword: '그램', collected_at: NOW },
    { product_id: '3001', mall: '쿠팡', mall_label: '', vendor_item_id: '9311', title: '코멧 무향 물티슈 캡형 100매',
      lprice: 9900, link: 'https://link.coupang.com/a/cm', keyword: '물티슈', collected_at: NOW }
  ];
  db.price_history = []
    .concat(kit.historyRows({ productId: '1001', mall: '쿠팡', vendorItemId: '9001', prices: PRICES_1001, startId: 1 }))
    .concat(kit.historyRows({ productId: '1001', mall: '쿠팡', vendorItemId: '9002', prices: [1500000, 1490000, 1480000], startId: 100 }))
    .concat(kit.historyRows({ productId: ID.ssg, mall: 'ADPICK', vendorItemId: '', prices: [1000000, 990000], startId: 200 }))
    .concat(kit.historyRows({ productId: '2002', mall: '쿠팡', vendorItemId: '9202', prices: [1350000, 1320000, 1300000], startId: 300 }))
    .concat(kit.historyRows({ productId: '3001', mall: '쿠팡', vendorItemId: '9311', prices: [9900, 9800], startId: 400 }));
}

async function get(query, extra) {
  const res = mkRes();
  await lookupApi.handler(mkReq(Object.assign({ query }, extra || {})), res);
  return res;
}

async function testLookup() {
  seed();
  const today = kstToday();
  const hasTiming = fs.existsSync(path.join(ROOT, 'api', '_timing.js'));
  const hasAnomaly = fs.existsSync(path.join(ROOT, 'api', '_anomaly.js'));

  T.section('/api/lookup — EXACT (쿠팡 상품 번호)');
  const readsBefore = state.reads.length;
  const ex = await get({ productId: '1001', vendorItemId: '9001', itemId: '5001', title: M + ' - 쿠팡!' });
  const b = ex.body || {};
  T.check(ex.statusCode === 200 && b.ok === true, '200 ok', ex.body);
  T.check(b.match && b.match.status === 'EXACT' && b.match.productId === '1001' && b.match.mall === '쿠팡' && b.match.tier === 'A',
    'match EXACT · 1001 · 쿠팡', b.match);
  T.check(b.match && b.match.title === M && /식별자/.test(b.match.reasons.join(' ')), '제목은 카탈로그 값 · 근거는 «식별자로 찾음»');
  T.check(Array.isArray(b.points) && b.points.length === 20 && b.points[19].price === 1080000 && b.points[19].date === today,
    '곡선 20점 · 마지막이 오늘 1,080,000원', (b.points || []).slice(-2));
  T.check(b.points.every(p => p.price < 1400000), '다른 옵션(9002)의 값이 섞이지 않는다');
  T.check(b.level && typeof b.level.level === 'string' && typeof b.level.pctRank === 'number' && b.level.obs === 20,
    'level = fairness(points, 마지막가, 오늘)', b.level);
  if (!hasTiming) T.check(b.timing === null, '① _timing 모듈이 없으면 timing 은 null');
  else T.check(b.timing === null || (typeof b.timing.action === 'string' && typeof b.timing.label === 'string'), '① timing 모양');
  if (!hasAnomaly) T.check(b.anomaly === null, '⑥ _anomaly 모듈이 없으면 anomaly 는 null');
  else T.check(b.anomaly === null || (typeof b.anomaly.status === 'string' && typeof b.anomaly.label === 'string'), '⑥ anomaly 모양');
  T.check(b.waitroomUrl === '/v2/waitroom.html?add=1&productId=1001&mall=' + encodeURIComponent('쿠팡')
    + '&vendorItemId=9001&title=' + encodeURIComponent(M), 'waitroomUrl — 상대 경로 · URL 인코딩', b.waitroomUrl);
  T.check(/public/.test(ex.headers['cache-control'] || '') && /s-maxage=600/.test(ex.headers['cache-control'] || ''),
    'Cache-Control public · s-maxage=600', ex.headers['cache-control']);
  T.check(ex.headers['access-control-allow-origin'] === '*', 'public CORS');
  T.check(state.reads.length - readsBefore <= 5, `조회 횟수 상한 (EXACT ${state.reads.length - readsBefore}회 ≤ 5)`);

  T.section('/api/lookup — 다른 판매처 오퍼 (SEOSA HOT 과 같은 관문)');
  const offers = b.offers || [];
  const labels = offers.map(o => `${o.mallLabel}:${o.price}`);
  T.check(JSON.stringify(labels) === JSON.stringify(['SSG:990000', 'G마켓:1020000', '11번가:1050000', '인터파크:1060000']),
    '같은 상품만 · 값 오름차순', labels);
  T.check(offers.every((o, i) => i === 0 || offers[i - 1].price <= o.price), '값 오름차순');
  T.check(!offers.some(o => /512GB/.test(o.title)), '용량이 다른 행(512GB) 제외');
  T.check(!offers.some(o => /블랙/.test(o.title)), '색상이 다른 행(블랙) 제외');
  T.check(!offers.some(o => /2개/.test(o.title)), '수량이 다른 행(2개) 제외');
  T.check(!offers.some(o => o.mallLabel === '위메프'), '오래 확인 안 된(stale) 행 제외');
  T.check(!offers.some(o => o.price === 300000), '값이 터무니없이 다른 행(canMerge 값 비율) 제외');
  T.check(!offers.some(o => o.mall === '쿠팡'), '자기 자신 · 옵션 식별자가 다른 쿠팡 행(canMerge 0번 규칙) 제외');
  T.check(!offers.some(o => o.mall === '네이버'), '다시 받아올 수 없는 몰(네이버) 제외');
  const ssg = offers.find(o => o.mallLabel === 'SSG') || {};
  T.check(ssg.price === 990000 && ssg.observedDate === today, '값은 가격 기록의 마지막 관측가 (카탈로그 1,100,000 대신)', ssg);
  const g = offers.find(o => o.mallLabel === 'G마켓') || {};
  T.check(g.price === 1020000 && g.observedDate === today && g.url === `https://adpick.example/c/${ID.gmk.slice(0, 8)}`,
    '기록이 없으면 카탈로그 값 · 제휴 링크 그대로', g);
  T.check((offers.find(o => o.mallLabel === '인터파크') || {}).url === null, 'http(s) 가 아닌 링크는 null');
  T.check(offers.every(o => o.identity && o.identity.tier === 'A' && o.mall && o.mallLabel && o.title
    && Number.isInteger(o.price) && 'url' in o && 'observedDate' in o), '오퍼 모양 { mall, mallLabel, title, price, url, observedDate, identity:{tier} }');

  {
    const pool = [];
    for (let i = 0; i < 12; i++) {
      pool.push({ product_id: hex('p' + i), mall: 'ADPICK', mall_label: `몰${i}`, vendor_item_id: '', title: M,
        lprice: 1000000 + (12 - i) * 1000, link: 'https://x.example/' + i, keyword: KW, collected_at: NOW });
    }
    const matched = db.products[0];
    const out = L.buildOffers({ matched, matchedPrice: 1080000, matchedVid: '9001', pool: pool.concat([matched]), stats: new Map() });
    T.check(out.length === L.MAX_OFFERS && out[0].price === 1001000 && out.every((o, i) => i === 0 || out[i - 1].price <= o.price),
      `오퍼는 최대 ${L.MAX_OFFERS}개 · 싼 순`, out.map(o => o.price));
    T.check(!out.some(o => o.mallLabel === '' || o.title !== M), '자기 자신은 빠진다');
  }

  T.section('/api/lookup — EXACT 변형');
  {
    const r = await get({ productId: '1001' });
    T.check(r.body.match.status === 'EXACT' && r.body.match.vendorItemId === '9001' && r.body.points.length === 20,
      'vendorItemId 가 없으면 카탈로그 옵션으로 좁힌다', r.body.match);
  }
  {
    const r = await get({ productId: '1001', vendorItemId: '9002', title: '삼성전자 갤럭시 S25 자급제 SM-S931N 512GB 실버' });
    T.check(r.body.match.status === 'EXACT' && r.body.points.length === 3 && r.body.points.every(p => p.price >= 1480000),
      '다른 옵션을 보고 있으면 그 옵션의 기록만', r.body.points);
    T.check(r.body.offers.length === 0 && /옵션/.test(r.body.match.reasons.join(' ')),
      '옵션이 다르면 다른 판매처 비교를 하지 않는다 (카탈로그 제목은 다른 옵션의 이름)');
    T.check(r.body.match.title === '삼성전자 갤럭시 S25 자급제 SM-S931N 512GB 실버', '옵션이 다르면 제목은 페이지 제목');
  }
  {
    const r = await get({ productId: '1001', vendorItemId: '9999' });
    T.check(r.body.match.status === 'EXACT' && r.body.points.length === 0 && r.body.level && r.body.level.level === 'insufficient',
      '기록 없는 옵션 — 남의 옵션 값을 빌리지 않고 insufficient', r.body.level);
  }

  T.section('/api/lookup — SIMILAR (제목) · 이 상품의 기록으로 내보내지 않는다');
  {
    const before = state.reads.length;
    const r = await get({ productId: '7777', vendorItemId: '7001', title: M + ' - 쿠팡!' });
    const m = r.body.match || {};
    T.check(r.statusCode === 200 && m.status === 'SIMILAR' && m.tier === 'A' && m.productId === '1001' && m.mall === '쿠팡',
      '카탈로그에 없는 번호 + 같은 제목 → SIMILAR (tier A, 쿠팡 1001)', m);
    T.check(m.status !== 'EXACT' && /이 페이지의 상품이 아니라/.test(m.reasons[0]), 'SIMILAR 임을 reasons 첫 줄에 적는다', m.reasons);
    T.check(r.body.points.length === 20 && r.body.level && r.body.level.obs === 20, '곡선 · level 은 찾은 상품의 것');
    T.check(r.body.waitroomUrl.indexOf('productId=1001') > -1 && r.body.waitroomUrl.indexOf('7777') === -1,
      '대기실 링크는 기록이 있는 (찾은) 상품');
    T.check(r.body.offers.length === 4 && !r.body.offers.some(o => o.mall === '쿠팡' && o.title === M && o.price === 1080000),
      '오퍼는 찾은 상품 기준 · 찾은 상품 자신은 빠진다');
    T.check(state.reads.length - before <= 8, `조회 횟수 상한 (SIMILAR ${state.reads.length - before}회 ≤ 8)`);
  }
  {
    const r = await get({ title: M + ' - 11번가' });
    T.check(r.body.match.status === 'SIMILAR' && r.body.match.productId === '1001', '번호 없이 제목만 (11번가·G마켓) → SIMILAR', r.body.match);
  }
  {
    const r = await get({ title: '코멧 무향 물티슈 캡형 100매 대용량' });
    const m = r.body.match || {};
    T.check(m.status === 'SIMILAR' && m.tier === 'B' && m.productId === '3001', 'tier B 도 SIMILAR 로 받되', m);
    T.check(/확신이 낮아요/.test(m.reasons.join(' ')), 'reasons 에 «확신이 낮다» 를 적는다', m.reasons);
  }
  {
    const r = await get({ title: 'LG전자 그램 16 16Z90S-GA5CK 노트북 사무용 가벼운 대학생 추천' });
    const m = r.body.match || {};
    T.check(m.status === 'SIMILAR' && m.tier === 'B' && m.productId === '2002' && /묶음 검증 미통과/.test(m.reasons.join(' ')),
      'judgeSameProduct A 여도 canMerge 를 못 넘으면 B 로 낮춘다', m);
  }

  T.section('/api/lookup — NONE');
  {
    const r = await get({ title: '다이슨 에어랩 멀티 스타일러' });
    const bb = r.body;
    T.check(bb.match.status === 'NONE' && bb.match.tier === null && bb.points.length === 0 && bb.level === null
      && bb.timing === null && bb.anomaly === null && bb.offers.length === 0 && bb.waitroomUrl === null,
    '관련 없는 제목 → NONE · 빈 값은 null/[]', bb);
  }
  {
    const r = await get({ title: '삼성전자 갤럭시 S25 자급제 SM-S931N 512GB 블랙' });
    T.check(r.body.match.status === 'NONE' && /근거가 부족/.test(r.body.match.reasons.join(' ')),
      '닮았지만 용량·색상이 다른 상품뿐 → NONE (tier C/D)', r.body.match);
  }
  {
    const r = await get({ title: 'LG전자 2025 그램 16 WIN11 Home' });
    T.check(r.body.match.status === 'NONE' && /스펙 숫자/.test(r.body.match.reasons.join(' ')),
      '"그램 16" vs "그램 AI 17" (WIN11 로 tier A) → 스펙 숫자로 끊어 NONE', r.body.match);
  }
  {
    const r = await get({ productId: '8888' });
    T.check(r.body.match.status === 'NONE' && r.body.match.productId === '8888'
      && r.body.waitroomUrl === '/v2/waitroom.html?add=1&productId=8888&mall=' + encodeURIComponent('쿠팡'),
    '카탈로그에 없는 쿠팡 번호 → NONE · 대기실은 그 번호로 (추적 안 됨 등록)', r.body);
  }

  T.section('/api/lookup — ①·⑥ 모듈 (있을 때만 · 실패해도 조회는 산다)');
  {
    let seen = null;
    lookupApi._internal.setOptional('timing', { analyze(points, opts) { seen = { n: points.length, opts }; return { recommendation: { action: 'WAIT', label: '2주 안에 더 내려갈 가능성이 있어요' } }; } });
    lookupApi._internal.setOptional('anomaly', { analyze() { throw new Error('boom'); } });
    const r = await get({ productId: '1001', vendorItemId: '9001' });
    T.check(r.body.timing && r.body.timing.action === 'WAIT' && r.body.timing.label === '2주 안에 더 내려갈 가능성이 있어요',
      'timing = { action: recommendation.action, label: recommendation.label }', r.body.timing);
    T.check(seen && seen.n === 20 && seen.opts.horizon === 14 && seen.opts.today === today && seen.opts.product
      && seen.opts.product.productId === '1001', 'analyze(points, { today, horizon:14, product })', seen && seen.opts);
    T.check(r.statusCode === 200 && r.body.anomaly === null, 'anomaly.analyze 가 던지면 null (조회는 200)');

    let aseen = null;
    lookupApi._internal.setOptional('timing', { analyze() { return {}; } });
    lookupApi._internal.setOptional('anomaly', { analyze(arg) { aseen = arg; return { summary: { status: 'WATCH', label: '할인 직전 가격 올리기 의심' } }; } });
    const r2 = await get({ productId: '1001', vendorItemId: '9001' });
    T.check(r2.body.timing === null, '모양이 다른 결과는 null (지어내지 않는다)');
    T.check(r2.body.anomaly && r2.body.anomaly.status === 'WATCH' && r2.body.anomaly.label === '할인 직전 가격 올리기 의심', 'anomaly = summary.{status,label}');
    T.check(aseen && Array.isArray(aseen.rawRows) && aseen.rawRows.length === 23 && aseen.rows.length === 20
      && aseen.points.length === 20 && aseen.vendorItemId === '9001' && aseen.today === today && aseen.product,
    'analyze({ rawRows, rows, points, product, vendorItemId, today })');
    lookupApi._internal.setOptional('timing', undefined);
    lookupApi._internal.setOptional('anomaly', undefined);
    const r3 = await get({ productId: '1001', vendorItemId: '9001' });
    if (!hasTiming) T.check(r3.body.timing === null, '초기화하면 실제 모듈을 다시 찾는다 (이 브랜치에는 없음 → null)');
    if (!hasAnomaly) T.check(r3.body.anomaly === null, '⑥ 도 같다');
  }

  T.section('/api/lookup — 입력 · 메서드 · 오류');
  const bad = [
    [{}, '아무것도 없음'],
    [{ productId: 'abc' }, '숫자가 아닌 productId'],
    [{ productId: '1001;drop' }, '주입 시도 productId'],
    [{ productId: '1'.repeat(21) }, '21자리 productId'],
    [{ productId: '1001', vendorItemId: '9001x' }, '숫자가 아닌 vendorItemId'],
    [{ productId: '1001', itemId: 'x' }, '숫자가 아닌 itemId'],
    [{ title: 'a' }, '한 글자 제목만'],
    [{ title: '   ' }, '빈 제목만'],
    [{ title: '쿠팡!' }, '몰 이름뿐인 제목'],
    [{ productId: '1001', mall: '네이버' }, '지원하지 않는 몰'],
    [{ productId: ['1001', '1002'] }, '같은 키 여러 번']
  ];
  for (const [q, label] of bad) {
    const r = await get(q);
    T.check(r.statusCode === 400 && r.body && r.body.ok === false && r.body.code === 'BAD_INPUT' && /[가-힣]/.test(r.body.error),
      `400 BAD_INPUT — ${label}`, r.body);
  }
  {
    const r = await get({ productId: '1001' }, { method: 'POST' });
    T.check(r.statusCode === 405 && r.body.ok === false && /GET/.test(r.headers.allow || ''), '405 — POST', r.body);
    const o = await get({}, { method: 'OPTIONS' });
    T.check(o.statusCode === 204, 'OPTIONS 는 204 (CORS preflight)');
  }
  {
    state.failNext.price_history = 'boom';
    const r = await get({ productId: '1001' });
    T.check(r.statusCode === 500 && r.body.error === '가격 기록을 불러오지 못했어요.' && !r.headers['cache-control'],
      'DB 오류 → 500 문장만 · 캐시하지 않는다', r.body);
  }
  {
    const r = await get({ title: M });
    T.check(r.statusCode === 200 && r.body.match.status === 'SIMILAR', '제목 검색어에 PostgREST 문법이 섞이지 않는다 (정상 동작 대조)');
    const plans = L.searchPlans('a%b_c,d(e)f.g*h:i 제품명테스트 50%할인');
    T.check(plans.every(p => p.every(t => /^[0-9A-Za-z가-힣-]+$/.test(t))), '검색어에는 [0-9A-Za-z가-힣-] 만 남는다', plans);
  }

  T.section('/api/lookup — 라우팅 (history 호스트)');
  {
    const res = mkRes();
    await history(mkReq({ query: { __route: 'lookup', productId: '1001', vendorItemId: '9001' } }), res);
    T.check(res.statusCode === 200 && res.body && res.body.match && res.body.match.status === 'EXACT',
      '/api/history?__route=lookup → 이 모듈 (501 NOT_READY 가 아니다)', res.body && res.body.code);
  }

  T.section('안전');
  T.check(state.writes.length === 0, '어떤 표에도 쓰지 않았다 (읽기 전용)', state.writes);
  T.check(fetchCalls.length === 0, '외부 호출 0회', fetchCalls);
}

/* ==================================================================
 *  6) 화면 · 문서
 * ================================================================== */
function testDocs() {
  T.section('public/v2/extension.html · 문서');
  const htmlPath = path.join(ROOT, 'public', 'v2', 'extension.html');
  T.check(fs.existsSync(htmlPath), 'public/v2/extension.html 존재');
  if (fs.existsSync(htmlPath)) {
    const html = fs.readFileSync(htmlPath, 'utf8');
    T.check(/\/v2\/v2\.css/.test(html) && /\/v2\/v2\.js/.test(html), 'v2 공용 CSS · JS 를 쓴다');
    T.check(/V2\.api\(\s*'\/api\/lookup'/.test(html), '데모는 V2.api 로 /api/lookup 만 부른다');
    T.check(/V2\.chart\(/.test(html) && /V2\.esc\(/.test(html) && /V2\.safeUrl\(/.test(html), 'V2.chart · V2.esc · V2.safeUrl');
    const scripts = (html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g) || []).join('\n');
    T.check(scripts.length > 0 && !/=>|\blet\s|\bconst\s|`|\bclass\s+\w+\s*\{/.test(stripComments(scripts)), '인라인 스크립트는 ES5');
    T.check(/비슷한 상품의 기록/.test(html), 'SIMILAR 문구가 화면에 있다');
    T.check(/storage/.test(html) && /https:\/\/seosa\.ai\.kr\/\*/.test(html), '권한 목록을 설명한다');
    T.check(/chrome:\/\/extensions/.test(html) && /압축해제된 확장 프로그램/.test(html), '설치 방법');
    T.check(!/\bfetch\s*\(/.test(stripComments(scripts)), '데모 스크립트는 직접 통신하지 않는다 (V2.api 만)');
  }
  /*
   * 홈페이지 진입점 (2026-09-24, 별도 승인 PR).
   *
   * 그 전까지는 "홈은 v2 를 전혀 링크하지 않는다" 가 이 테스트의 계약이었다 — v2 기능이
   * 배포 전이라 링크할 것이 없었기 때문이다. 이제 ③⑤⑥(조사관·장바구니·이상 패턴)이
   * 운영에 있으므로, 링크 자체가 아니라 «어떻게» 링크하는지를 고정한다.
   *
   *   1) SEOSA 2.0 허브 링크는 기존 «부가 기능» 메뉴 안에 하나만 둔다.
   *     준비된 세 기능은 AI Concierge 아래에서 바로 찾을 수 있다.
   *   2) 대기 중 기능과 확장 프로그램 설치 안내는 홈에서 공개하지 않는다.
   *   3) 기존 홈의 다른 레이아웃과 새 CSS 구조를 건드리지 않는다.
   */
  const home = read('public/index.html');
  T.check(home.indexOf('extension.html') === -1, '홈은 확장 프로그램 설치 안내를 직접 링크하지 않는다');
  ['/v2/timing.html', '/v2/waitroom.html'].forEach(p => {
    T.check(home.indexOf(p) === -1, `홈은 준비 전 기능(${p})을 직접 공개하지 않는다`);
  });
  const v2Links = (home.match(/href="\/v2\/index\.html"/g) || []).length;
  T.check(v2Links === 1, 'SEOSA 2.0 허브 링크는 하나', v2Links);
  T.check(/<div class="nav-menu"[^]*?<a class="nav-menu-item" role="menuitem" href="\/v2\/index\.html">[^<]*<\/a>[^]*?<\/div>/.test(home),
    '기존 «부가 기능» 메뉴의 허브 링크를 유지한다');
  T.check(['/v2/investigator.html', '/v2/cart.html', '/v2/anomaly.html'].every(p => home.includes(p)),
    'AI Concierge 아래에서 준비된 세 기능을 직접 찾을 수 있다');
  const privacy = read('extension/PRIVACY.md');
  T.check(/seosa\.ai\.kr\/api\/lookup/.test(privacy) && /chrome\.storage\.local/.test(privacy) && /쿠키/.test(privacy)
    && /누를 때|눌렀을 때/.test(privacy), 'PRIVACY — 무엇을 · 언제 · 어디로 · 무엇을 저장하는가');
  const readme = read('extension/README.md');
  T.check(/chrome:\/\/extensions/.test(readme) && /개발자 모드/.test(readme) && /압축해제된 확장 프로그램 로드/.test(readme), 'README — 설치 방법');
  T.check(fs.existsSync(path.join(ROOT, 'docs', 'seosa2', 'extension.md')), 'docs/seosa2/extension.md 존재');
}

async function main() {
  testParse();
  testManifest();
  await testBackground();
  testContent();
  await testLookup();
  testDocs();
  T.done();
}

main().catch(e => { console.error(e); process.exitCode = 1; });
