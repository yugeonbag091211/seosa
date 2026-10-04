#!/usr/bin/env node
/**
 * 제휴 링크 경제적 이해관계 고지 — 회귀 테스트 (2026-09-29, ADPICK 승인 요청)
 *
 * 지키는 것
 *   1. 제휴 구매 링크(쿠팡 파트너스·ADPICK)가 있는 모든 화면에 고지 문구가 있다.
 *   2. 고지는 그 화면의 구매 링크보다 «앞» 에 있다 — 같은 섹션·모달 안에서
 *      DOM 순서가 먼저다. 푸터·약관에만 있는 상태로 돌아가면 실패한다.
 *   3. 제휴 링크가 없는 곳(약관·개인정보·링크 없는 상품 페이지·404 ·
 *      제휴 링크가 없는 히어로 슬라이드)에는 넣지 않는다.
 *   4. 제휴 URL 은 한 글자도 바뀌지 않는다 — 추적 파라미터 포함.
 *   5. 문구는 모든 자리에서 같고, 줄이지 않았다.
 *
 * 외부 호출 0회. DB 는 가짜다.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const TEXT = '이 페이지에는 제휴 링크가 포함되어 있으며, 구매 시 SEOSA가 일정 수수료를 제공받습니다.';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t) { console.log(`\n── ${t} ──`); }

const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const radarHtml = fs.readFileSync(path.join(ROOT, 'public', 'radar.html'), 'utf8');
const radarCss = fs.readFileSync(path.join(ROOT, 'public', 'radar.css'), 'utf8');

/** 이 고지 id 의 위치(없으면 -1). */
function noteAt(src, id) { return src.indexOf(`data-aff-note="${id}"`); }
/** 이 고지 한 줄 전체. */
function noteHtml(src, id) {
  const i = noteAt(src, id);
  if (i < 0) return '';
  const s = src.lastIndexOf('<p', i), e = src.indexOf('</p>', i);
  return src.slice(s, e + 4);
}

/*
 * [고지 id, 그 고지가 앞서야 할 제휴 링크(또는 링크가 그려지는 컨테이너),
 *  고지가 들어 있어야 할 화면 경계(그 문자열보다 뒤에 있어야 한다)]
 */
const PLACEMENTS = [
  ['hero-shelf',  'class="hero-still"',         'data-label="브랜드 소개"'],
  ['hero-ai',     'id="hcHpLink"',              'data-label="AI 쇼핑"'],
  ['hero-ai',     'href="https://biz.adpick.co.kr/r4544668"', 'data-label="AI 쇼핑"'],
  ['priceDrop',   'id="dropRows"',              '<section id="priceDrop"'],
  ['externalHot', 'id="externalHotRows"',       '<section id="externalHot"'],
  ['today',       'id="recGrid"',               '<section id="today"'],
  ['forYou',      'id="forYouGrid"',            '<section id="forYou"'],
  ['histRec',     'id="histRecGrid"',           '<section id="histRec"'],
  ['monthly',     'id="monthGrid"',             '<section id="monthly"'],
  ['recent',      'id="viewedGrid"',            '<section id="recent"'],
  ['results',     'id="resGrid"',               '<section id="results"'],
  ['wish',        'id="wishList"',              'id="wishPanel"'],
  ['modal',       'id="modalBuy"',              '<div class="overlay" id="overlay">'],
  ['compare',     'id="cmpBody"',               'id="cmpOverlay"'],
];

(async () => {
  console.log('=== 제휴 고지 (외부 호출 0회) ===');

  section('1. 제휴 링크가 있는 모든 화면에 고지가 있고, 링크보다 앞에 있다');
  for (const [id, target, boundary] of PLACEMENTS) {
    const n = noteAt(html, id), t = html.indexOf(target), b = html.indexOf(boundary);
    ok(n > -1, `${id}: 고지 존재`);
    ok(t > -1 && b > -1, `${id}: 기준 마크업 존재`, `${target} / ${boundary}`);
    ok(n > b && n < t, `${id}: 같은 화면 안에서 «${target}» 보다 앞`, `boundary=${b} note=${n} link=${target.length && t}`);
  }
  // 경계 다음 화면이 시작되기 전에 고지가 있어야 한다 (다른 섹션의 고지를 빌려 쓰지 않는다)
  const slide2 = html.indexOf('data-label="AI 쇼핑"'), slide3 = html.indexOf('data-label="구매 시점 판단"');
  ok(noteAt(html, 'hero-ai') < slide3 && noteAt(html, 'hero-ai') > slide2, 'hero-ai: 2번 슬라이드 안에 있다');
  ok(noteAt(html, 'hero-shelf') < slide2, 'hero-shelf: 1번 슬라이드 안에 있다');

  section('2. HTML 에 박힌 제휴 링크는 하나도 빠짐없이 같은 화면의 고지 뒤에 있다');
  // 정적 외부 링크 중 sponsored 이거나 제휴 도메인인 것 전부
  const re = /<a\b[^>]*href="(https:\/\/(?:link\.coupang\.com|biz\.adpick\.co\.kr|[^"]*adpick)[^"]*)"[^>]*>/g;
  let m, count = 0;
  while ((m = re.exec(html))) {
    count++;
    const at = m.index;
    const prevNote = html.lastIndexOf('data-aff-note=', at);
    const prevScreen = Math.max(html.lastIndexOf('class="hc-slide', at), html.lastIndexOf('<section', at));
    ok(prevNote > prevScreen, `정적 제휴 링크 ${m[1]} 앞에 같은 화면의 고지`);
  }
  ok(count >= 2, '정적 제휴 링크를 실제로 찾았다', `${count}개`);

  section('3. JS 로 그리는 AI 답변 카드도 카드 묶음 앞에 고지를 붙인다');
  const constM = html.match(/var AFF_NOTE_HTML = '([^']*)';/);
  ok(!!constM, 'AFF_NOTE_HTML 상수 존재');
  ok(constM && constM[1].includes(TEXT), 'AFF_NOTE_HTML 문구가 같다');
  const chatAt = html.indexOf('html += AFF_NOTE_HTML;');
  const gridAt = html.indexOf(`html += '<div class="mini-grid">'`);
  ok(chatAt > -1 && gridAt > chatAt && gridAt - chatAt < 200, 'AI 카드: 고지가 mini-grid 바로 앞');
  // 2026-10-04: «링크 있음» 의 판정은 구매 링크 관문(Fmt.buyUrl)이다 — 막힌 링크만 있는 답변에는 고지를 넣지 않는다.
  ok(/res\.items\.some\(function\(it\) \{ return it && Fmt\.buyUrl\(it\.link, it\); \}\)\) html \+= AFF_NOTE_HTML/.test(html),
     'AI 카드: 링크 있는 카드가 하나라도 있을 때만 (링크 없는 답변에는 넣지 않는다)');

  section('4. 문구는 모든 자리에서 같고 줄이지 않았다');
  const ids = [...new Set(PLACEMENTS.map(p => p[0]))];
  for (const id of ids) {
    const h = noteHtml(html, id);
    ok(h.includes(TEXT) && h.includes('class="aff-note'), `${id}: 전체 문구`);
  }
  const all = html.match(/data-aff-note="/g) || [];
  ok(all.length === ids.length + 1, '고지 개수 = 화면 수 (+AI 상수 1)', `${all.length}`);
  ok(html.includes(TEXT + '\r\n    본 사이트는 쿠팡 파트너스 활동의 일환으로') || html.includes(TEXT + '\n    본 사이트는 쿠팡 파트너스 활동의 일환으로'),
     '푸터: 공통 문구 + 기존 쿠팡 파트너스 문구(그대로)');
  ok((html.match(/본 사이트는 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받을 수 있습니다\./g) || []).length === 2,
     '기존 쿠팡 파트너스 문구 2곳(푸터·사업자 정보) 유지');

  section('5. 가독성 — 숨기지 않는다');
  const css = (html.match(/\.aff-note\{[^}]*\}/) || [''])[0];
  const fs_ = parseFloat((css.match(/font-size:([\d.]+)rem/) || [])[1]);
  ok(fs_ >= 0.75, `글자 크기 ${fs_}rem ≥ .75rem`);
  ok(/color:var\(--soft\)/.test(css), '글자색 --soft (--faint 아님)');
  ok(!/display:none|visibility:hidden|opacity:0/.test(css), '감추는 규칙 없음');
  ok(!/@media[^{]*\{[^}]*\.aff-note\{[^}]*display:none/.test(html), '모바일에서 감추는 미디어쿼리 없음');
  // 고지는 팝업 안에만 있지 않다 — 첫 화면(히어로)·목록 섹션에 직접 있다
  ok(noteAt(html, 'hero-shelf') > -1 && noteAt(html, 'today') > -1, '팝업을 열지 않아도 보이는 자리에 있다');

  section('6. 제휴 링크가 없는 곳에는 넣지 않는다');
  const s3 = html.slice(slide3, html.indexOf('</div><!-- /.hc-viewport -->'));
  ok(!s3.includes('data-aff-note'), '3·4번 히어로 슬라이드(제휴 링크 없음)에는 없다');
  for (const ov of ['privacyOverlay', 'termsOverlay', 'veteranOverlay', 'alertOverlay']) {
    const s = html.indexOf(`id="${ov}"`);
    const e = html.indexOf('<div class="overlay"', s + 10) > -1 ? html.indexOf('<div class="overlay"', s + 10) : s + 4000;
    ok(s > -1 && !html.slice(s, Math.min(e, s + 6000)).includes('data-aff-note'), `${ov}: 고지 없음`);
  }

  section('7. 제휴 URL·열기 방식은 그대로다');
  ok(html.includes('href="https://link.coupang.com/a/hb5vuuKbV6" target="_blank" rel="noopener noreferrer sponsored nofollow"'), '히어로 헤드폰 쿠팡 링크 그대로');
  ok(html.includes('href="https://biz.adpick.co.kr/r4544668" target="_blank" rel="noopener noreferrer sponsored nofollow"'), '히어로 ADPICK 링크 그대로');
  ok(html.includes("window.open(url, '_blank', 'noopener,noreferrer');"), 'openLink: 원래 URL 을 그대로 새 탭으로');
  // 2026-10-04: 구매 링크 관문(Fmt.buyUrl)을 지난다. 관문은 링크를 통과(같은 문자열) 또는
  // 차단('')할 뿐 고쳐 쓰지 않는다 — 실제 동작은 scripts/test-user-flow.js 가 실행해서 본다.
  ok(/function openLink\(link, it\) \{\s*var url = Fmt\.buyUrl\(link, it\);/.test(html), 'openLink: 링크 가공 없음 (관문 통과 시 원문 그대로)');

  section('8. 내 레이더 페이지(radar.html)');
  const rn = noteAt(radarHtml, 'radar');
  ok(rn > -1 && noteHtml(radarHtml, 'radar').includes(TEXT), 'radar: 고지 존재·전체 문구');
  ok(rn < radarHtml.indexOf('id="sections"'), 'radar: 구매처 확인 버튼이 그려지는 #sections 보다 앞');
  ok(/\.aff-note\{[^}]*font-size:1[3-9]px/.test(radarCss), 'radar.css: 13px 이상');

  section('9. 서버 렌더 상품 페이지(/p/:pid)');
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SECRET_KEY;
  const db = { products: [], price_history: [] };
  const cmp = (a, b) => (typeof a === 'number' && typeof b === 'number') ? a - b : (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
  const fake = {
    from(table) {
      const f = []; let ord = null, lim = null, rf = null, rt = null;
      const q = {
        select() { return q; },
        eq(c, v) { f.push(r => String(r[c]) === String(v)); return q; },
        neq(c, v) { f.push(r => String(r[c]) !== String(v)); return q; },
        gte(c, v) { f.push(r => cmp(r[c], v) >= 0); return q; },
        gt(c, v) { f.push(r => cmp(r[c], v) > 0); return q; },
        lt(c, v) { f.push(r => cmp(r[c], v) < 0); return q; },
        in(c, vs) { f.push(r => vs.map(String).includes(String(r[c]))); return q; },
        order(c, o) { ord = { c, asc: !o || o.ascending !== false }; return q; },
        limit(n) { lim = n; return q; },
        range(a, b) { rf = a; rt = b; return q; },
        then(res) {
          let rows = (db[table] || []).filter(r => f.every(x => x(r)));
          if (ord) rows = rows.slice().sort((a, b) => (ord.asc ? 1 : -1) * cmp(a[ord.c], b[ord.c]));
          if (rf != null) rows = rows.slice(rf, rt + 1);
          if (lim != null) rows = rows.slice(0, lim);
          res({ data: rows.map(r => Object.assign({}, r)), error: null });
        }
      };
      return q;
    },
    rpc() { return Promise.resolve({ data: null, error: { message: 'rpc not in fake' } }); }
  };
  const supabasePath = path.resolve(ROOT, 'api', '_supabase.js');
  const realLoad = Module._load;
  Module._load = function(request) {
    if (request === './_supabase' || request === supabasePath) return fake;
    return realLoad.apply(this, arguments);
  };
  global.fetch = async url => { throw new Error(`오프라인 테스트에서 외부 호출: ${url}`); };
  const trust = require('../api/_trust');
  trust.attachTrust = async list => list;
  const history = require('../api/history.js');

  const nowIso = new Date().toISOString();
  const kst = n => new Date(Date.now() + 9 * 3600e3 - n * 86400e3).toISOString().slice(0, 10);
  // ADPICK commissionlink 모양 — 추적 쿼리가 한 글자라도 바뀌면 안 된다
  const ADPICK_LINK = 'https://adpick.co.kr/?ac=click&site=abc123&ad=987&pid=a3f9c2&sub=seosa&url=https%3A%2F%2Fwww.ssg.com%2Fitem%2FitemView.ssg%3FitemId%3D1000&x=1';
  const COUPANG_LINK = 'https://link.coupang.com/re/AFFSDP?lptag=AF8789251&pageKey=7001&itemId=8001&vendorItemId=9001&traceid=V0-153';
  db.products.push(
    { id: 1, product_id: 'a3f9c2', mall: 'ADPICK', mall_label: 'SSG', keyword: '무선 이어폰', title: '무선 이어폰 A', lprice: 12000, oprice: 12000, save_pct: 0, link: ADPICK_LINK, image: '', collected_at: nowIso, item_id: '', vendor_item_id: '' },
    { id: 2, product_id: '7001', mall: '쿠팡', keyword: '무선 이어폰', title: '무선 이어폰 B', lprice: 22000, oprice: 22000, save_pct: 0, link: COUPANG_LINK, image: '', collected_at: nowIso, item_id: '8001', vendor_item_id: '9001' },
    { id: 3, product_id: '7002', mall: '쿠팡', keyword: '무선 이어폰', title: '무선 이어폰 링크없음', lprice: 9900, oprice: 9900, save_pct: 0, link: '', image: '', collected_at: nowIso, item_id: '', vendor_item_id: '' }
  );
  let hid = 1;
  for (const [pid, mall, base] of [['a3f9c2', 'ADPICK', 12000], ['7001', '쿠팡', 22000], ['7002', '쿠팡', 9900]]) {
    for (let i = 0; i < 10; i++) db.price_history.push({ id: hid++, product_id: pid, mall, vendor_item_id: pid === '7001' ? '9001' : '', price: base + (i % 3) * 300, recorded_date: kst(9 - i), recorded_at: nowIso });
  }
  function call(query) {
    return new Promise((resolve, reject) => {
      let code = 200;
      const res = {
        status(c) { code = c; return this; }, setHeader() { return this; },
        json(p) { resolve({ status: code, text: JSON.stringify(p) }); return this; },
        end(t) { resolve({ status: code, text: String(t || '') }); return this; }
      };
      Promise.resolve(history({ method: 'GET', headers: {}, query, socket: { remoteAddress: '10.0.0.9' } }, res)).catch(reject);
    });
  }
  const escAttr = s => s.replace(/&/g, '&amp;');
  for (const [pid, mall, link] of [['a3f9c2', 'ADPICK', ADPICK_LINK], ['7001', '쿠팡', COUPANG_LINK]]) {
    const r = await call({ __route: 'page', pid, mall });
    const t = r.text;
    ok(r.status === 200, `${mall} 상품 페이지 200`, String(r.status));
    const n = t.indexOf('data-aff-note="product"'), a = t.indexOf('id="affiliateLink"');
    ok(n > -1 && t.includes(TEXT), `${mall}: 고지 존재·전체 문구`);
    ok(n > -1 && a > n && a - n < 600, `${mall}: 고지가 구매 버튼 바로 앞`, `note=${n} link=${a}`);
    const href = (t.slice(a).match(/href="([^"]*)"/) || [])[1] || '';
    ok(href === escAttr(link), `${mall}: 제휴 URL 한 글자도 안 바뀜(추적 파라미터 포함)`);
    ok(/rel="nofollow sponsored noopener"/.test(t.slice(a, a + 400)), `${mall}: rel sponsored 유지`);
    ok((t.match(/data-aff-note=/g) || []).length === 1, `${mall}: 고지 한 번만`);
  }
  const none = await call({ __route: 'page', pid: '7002', mall: '쿠팡' });
  ok(none.status === 200 && !none.text.includes('data-aff-note') && !none.text.includes('id="affiliateLink"'),
     '링크 없는 상품 페이지: 제휴 링크도 고지도 없다');
  const nf = await call({ __route: 'page', pid: 'zz-none', mall: '쿠팡' });
  ok(!nf.text.includes('data-aff-note'), '404 페이지: 고지 없음');

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  if (fail) { console.log('실패:\n  - ' + failures.join('\n  - ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
