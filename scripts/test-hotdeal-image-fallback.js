#!/usr/bin/env node
'use strict';
/*
 * 핫딜 썸네일 사진 실패 폴백 + ADPICK 판매처 이름(mall_label) 보존 (2026-10-09).
 *
 *   운영 실측: 홈 핫딜 ADPICK 54장 중 29장이 search_img.php 임시 토큰(몇 시간 뒤 404)이었고,
 *   .dthumb 는 오류 처리 갈래가 없어 사진만 숨긴 빈 칸으로 남았다. 같은 조사에서
 *   최근 ADPICK products 1,000행의 mall_label 이 전부 빈 값이었다 — 수집기가
 *   cp_name 을 잃은 채 mall_label: '' 로 덮어썼다.
 *
 *   A) public/index.html 전역 이미지 error 처리기를 가짜 DOM 에서 그대로 실행한다
 *   B) recordPrices 가 판매처 이름을 저장하고, 빈 값으로는 기존 값을 지우지 않는다
 *   C) 수집기 ADPICK 경로(fetchAdpickAll → runMallCollection)가 이름을 저장까지 들고 간다
 *
 * ★ 네트워크도 운영 DB 도 쓰지 않는다 (가짜 supabase, fetch 차단).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('module');

global.fetch = async url => { throw new Error(`오프라인 테스트에서 외부 호출: ${url}`); };

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

/* ================================================================== *
 *  A — 이미지 error 처리기 (가짜 DOM)
 * ================================================================== */
console.log('[A] 핫딜 썸네일 사진 실패 → 상품명 글리프');

const start = html.indexOf("document.addEventListener('error', function(e) {");
const end = html.indexOf('}, true);', start);
assert(start > -1 && end > start, '전역 이미지 error 처리기를 찾지 못했다');
const handlerSrc = html.slice(start, end + '}, true);'.length);

const glyphsMatch = html.match(/var GLYPHS = \{[\s\S]*?\n\};/);
const glyphFnMatch = html.match(/glyph: function\(t\) \{[\s\S]*?\n {2}\},/);
assert(glyphsMatch && glyphFnMatch, 'GLYPHS / Fmt.glyph 를 찾지 못했다');

/** 이 처리기가 쓰는 만큼만 흉내 내는 DOM. 선택자는 '.class' 하나만 지원한다. */
class El {
  constructor(tag, cls = '', attrs = {}) {
    this.tagName = tag.toUpperCase(); this.className = cls; this.attrs = attrs;
    this.dataset = {}; this.style = {}; this.children = []; this.parentNode = null; this.textContent = '';
    for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
  }
  has(sel) { return sel[0] === '.' && this.className.split(/\s+/).includes(sel.slice(1)); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; }
  closest(sel) { let n = this; while (n) { if (n.has && n.has(sel)) return n; n = n.parentNode; } return null; }
  querySelector(sel) { for (const c of this.children) { if (c.has(sel)) return c; const d = c.querySelector(sel); if (d) return d; } return null; }
}
const tree = (tag, cls, attrs, kids = []) => { const e = new El(tag, cls, attrs); kids.forEach(k => e.appendChild(k)); return e; };

let onError = null;
const ctx = {
  document: {
    addEventListener(type, fn, capture) { if (type === 'error' && capture === true) onError = fn; },
    createElement: tag => new El(tag)
  }
};
vm.createContext(ctx);
vm.runInContext(`${glyphsMatch[0]}\nvar Fmt = { ${glyphFnMatch[0]} };\n${handlerSrc}`, ctx);
assert(typeof onError === 'function', 'error 처리기가 캡처링으로 등록되지 않았다');
const fire = img => onError({ target: img });
const glyphOf = title => vm.runInContext(`Fmt.glyph(${JSON.stringify(title)})`, ctx);

/* 핫딜 카드 하나 — Drop.rowHTML 과 같은 뼈대 (.dcard[data-title] > .dthumb > img) */
function dropCard(title, withImg = true) {
  const img = withImg ? new El('img', '', { src: 'https://d2iaagr1j041pi.cloudfront.net/apis/search_img.php?code=1' }) : null;
  const thumb = tree('div', 'dthumb', {}, img ? [img] : [tree('span', 'glyph')]);
  const card = tree('div', 'dcard', { 'data-title': title }, [thumb, tree('div', 'dmain')]);
  return { card, thumb, img };
}

{
  // 정상 이미지: load 성공이면 error 가 오지 않는다 → 처리기가 손대지 않는다
  const { thumb, img } = dropCard('삼성 갤럭시 노트북');
  check('.dthumb 정상 이미지 — 그대로 보인다(숨김 없음, 글리프 없음)',
    img.style.display === undefined && thumb.children.length === 1 && !thumb.querySelector('.glyph'));
}
{
  // 404/403/네트워크 오류는 브라우저에서 모두 같은 error 이벤트다
  const title = '나이키 에어맥스 운동화';
  const { thumb, img } = dropCard(title);
  fire(img);
  const g = thumb.querySelector('.glyph');
  check('.dthumb 404 → 사진은 숨긴다', img.style.display === 'none');
  check('.dthumb 404 → 썸네일 안에 글리프가 생긴다 (빈 칸이 남지 않는다)', !!g && g.parentNode === thumb);
  check('글리프는 상품명 기반 Fmt.glyph(title)', g && g.textContent === glyphOf(title) && g.textContent.length > 0,
    `got=${g && g.textContent} want=${glyphOf(title)}`);
  fire(img);
  check('error 가 두 번 와도 글리프는 하나', thumb.children.filter(c => c.has('.glyph')).length === 1);
}
{
  const { thumb, img } = dropCard('');
  fire(img);
  check('제목이 비어도 기본 글리프(✦)로 채운다', (thumb.querySelector('.glyph') || {}).textContent === '✦');
}
{
  // 사진 없는 카드: rowHTML 이 처음부터 글리프를 그린다 — 처리기와 무관하게 그대로
  const rowHTML = html.slice(html.indexOf('rowHTML: function(it, i) {'), html.indexOf('show: function(items) {', html.indexOf('rowHTML: function(it, i) {')));
  check('.dthumb 이미지 없음 — 기존 fallback(Fmt.glyph(it.title)) 유지',
    /var imgSrc = Fmt\.safeUrl\(it\.image\);/.test(rowHTML)
    && /'<span class="glyph">' \+ Fmt\.esc\(Fmt\.glyph\(it\.title\)\) \+ '<\/span>'/.test(rowHTML));
  check('정상 이미지 마크업은 그대로 (lazy · no-referrer)',
    rowHTML.includes(`'<img src="' + Fmt.esc(imgSrc) + '" loading="lazy" referrerpolicy="no-referrer" alt="">'`));
}

/* ── 기존 갈래 회귀 ──────────────────────────────────────────────── */
{
  const img = new El('img');
  const card = tree('div', 'card', { 'data-glyph': '🎧' }, [tree('div', 'thumb', {}, [img])]);
  fire(img);
  const g = card.querySelector('.glyph');
  check('기존 .card — data-glyph 글리프 그대로', img.style.display === 'none' && g && g.textContent === '🎧' && g.parentNode === img.parentNode);
}
{
  const img = new El('img');
  const card = tree('div', 'card', {}, [tree('div', 'thumb', {}, [img])]);
  fire(img);
  check('기존 .card — data-glyph 없으면 ✦', card.querySelector('.glyph').textContent === '✦');
}
{
  const img = new El('img');
  const lthumb = tree('div', 'lthumb', {}, [img]);
  fire(img);
  check('기존 .lthumb — ✦ 글리프 그대로', lthumb.querySelector('.glyph') && lthumb.querySelector('.glyph').textContent === '✦');
}
{
  const img = new El('img');
  const radar = tree('div', 'radar-deal-thumb', {}, [img, tree('span', 'radar-img-note')]);
  fire(img);
  check('기존 .radar-deal-thumb — 참고 표시 제거 + ⌁',
    !radar.querySelector('.radar-img-note') && radar.querySelector('.radar-img-fallback').textContent === '⌁'
    && !radar.querySelector('.glyph'));
}
{
  const img = new El('img');
  const other = tree('div', 'hero', {}, [img]);
  fire(img);
  check('어느 갈래도 아닌 사진은 숨기기만 한다(예전과 같다)', img.style.display === 'none' && other.children.length === 1);
  let threw = false;
  try { onError({ target: new El('div') }); onError({ target: null }); } catch (e) { threw = true; }
  check('IMG 가 아닌 대상은 무시', !threw);
}

/* ================================================================== *
 *  B·C — mall_label 저장 (가짜 supabase)
 * ================================================================== */
const db = { products: [], price_history: [], adpick_search_cache: [], upserts: { products: [] } };
function reset() {
  db.products = []; db.price_history = []; db.adpick_search_cache = []; db.upserts = { products: [] };
}
function makeQuery(table) {
  const eqs = []; let inF = null;
  const q = {
    select() { return q; }, order() { return q; }, limit() { return q; }, range() { return q; },
    lt() { return q; }, gte() { return q; }, gt() { return q; }, lte() { return q; }, neq() { return q; },
    or() { return q; }, not() { return q; }, is() { return q; }, abortSignal() { return q; },
    in(col, vals) { inF = { col, vals: vals.map(String) }; return q; },
    eq(col, v) { eqs.push({ col, v }); return q; },
    maybeSingle() { return q.then(r => ({ data: (r.data || [])[0] || null, error: r.error })); },
    single() { return q.maybeSingle(); },
    then(resolve, reject) {
      let rows = db[table] || [];
      if (inF) rows = rows.filter(r => inF.vals.includes(String(r[inF.col])));
      eqs.forEach(f => { rows = rows.filter(r => String(r[f.col]) === String(f.v)); });
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    }
  };
  return q;
}
const fakeSupabase = {
  from(table) {
    return Object.assign(makeQuery(table), {
      update() { return { eq: () => Promise.resolve({ data: null, error: null }) }; },
      insert() { return Promise.resolve({ data: null, error: null }); },
      upsert(rows) {
        const list = Array.isArray(rows) ? rows : [rows];
        if (table === 'products') db.upserts.products.push(list.map(r => ({ ...r })));
        const key = table === 'price_history' ? ['product_id', 'mall', 'vendor_item_id', 'recorded_date']
          : table === 'products' ? ['product_id', 'mall'] : ['keyword'];
        db[table] = db[table] || [];
        list.forEach(r => {
          const i = db[table].findIndex(x => key.every(k => String(x[k] || '') === String(r[k] || '')));
          // on conflict do update — 보낸 컬럼만 덮는다. 새 행의 mall_label 기본값은 '' (2026-08-mall-label.sql)
          if (i > -1) db[table][i] = { ...db[table][i], ...r };
          else db[table].push(table === 'products' ? { mall_label: '', ...r } : { ...r });
        });
        return Promise.resolve({ data: list, error: null });
      }
    });
  },
  rpc() { return Promise.resolve({ data: null, error: { message: 'function does not exist' } }); }
};
const supabasePath = require.resolve(path.join(root, 'api', '_supabase.js'));
require.cache[supabasePath] = new Module(supabasePath, null);
require.cache[supabasePath].filename = supabasePath;
require.cache[supabasePath].loaded = true;
require.cache[supabasePath].exports = fakeSupabase;

process.env.ADPICK_API_KEY = process.env.ADPICK_API_KEY || 'offline-test-key';
const { recordPrices, adpickProductId } = require('../api/_shop');

const LINK = n => `https://biz.adpick.co.kr/r${n}`;
const obs = (n, price, mallLabel) => ({
  productId: adpickProductId(LINK(n)), mall: 'ADPICK', keyword: '테스트 키워드', title: `상품 ${n}`,
  price, oprice: price, link: LINK(n), image: '', itemId: '', vendorItemId: '', mallLabel
});
const prodOf = n => db.products.find(r => r.product_id === adpickProductId(LINK(n)));
const sentLabelKey = n => db.upserts.products.flat().filter(r => r.product_id === adpickProductId(LINK(n)));

(async () => {
  console.log('\n[B] recordPrices — mall_label 저장과 보존');

  reset();
  await recordPrices([obs(1, 10000, 'SSG')], { label: 't', source: 'collect' });
  check('ADPICK mallLabel 이 products.mall_label 로 저장된다', prodOf(1) && prodOf(1).mall_label === 'SSG',
    JSON.stringify(prodOf(1) && prodOf(1).mall_label));

  await recordPrices([obs(1, 9800, '')], { label: 't', source: 'collect' });
  check('★ 새 mallLabel 이 빈 값이면 기존 정상 값(SSG)을 지킨다', prodOf(1).mall_label === 'SSG', prodOf(1).mall_label);
  check('그 upsert 는 mall_label 컬럼을 아예 보내지 않는다',
    sentLabelKey(1).length === 2 && !('mall_label' in sentLabelKey(1)[1]));
  check('가격·수집 시각은 정상 갱신된다', prodOf(1).lprice === 9800);

  await recordPrices([obs(1, 9700, '알리')], { label: 't', source: 'collect' });
  check('새 이름이 오면 바꾼다 (공급자 값이 바뀐 경우)', prodOf(1).mall_label === '알리');

  reset();
  await recordPrices([obs(2, 5000, '')], { label: 't', source: 'collect' });
  check('새 상품 + 빈 이름 → 컬럼 기본값 \'\' (판매처를 지어내지 않는다)', prodOf(2) && prodOf(2).mall_label === '');

  reset();
  await recordPrices([obs(3, 5000, 'Hmall'), obs(4, 6000, '')], { label: 't', source: 'collect' });
  const batches = db.upserts.products;
  check('이름 있는 행과 없는 행은 다른 묶음으로 나간다',
    batches.length === 2 && batches[0].every(r => r.mall_label) && batches[1].every(r => !('mall_label' in r)));
  check('두 행 모두 저장된다', prodOf(3).mall_label === 'Hmall' && prodOf(4) && prodOf(4).lprice === 6000);

  console.log('\n[C] 수집기 ADPICK 경로 — cp_name 이 저장까지 간다');
  reset();
  const {
    fetchAdpickAll, runMallCollection
  } = require('./collect-all-prices');
  const today = new Date().toISOString();
  db.adpick_search_cache.push({
    keyword: '오프라인 수집 키워드', req_limit: 20, fetched_at: today,
    items: [
      { title: '상품 10', price: 12000, photo: '', cpCode: 'x', cpName: 'GS SHOP', mallLabel: 'GS SHOP', commissionlink: LINK(10) },
      { title: '상품 11', price: 13000, photo: '', cpCode: 'y', cpName: '', mallLabel: '', commissionlink: LINK(11) }
    ]
  });
  const fr = await fetchAdpickAll('오프라인 수집 키워드');
  check('fetchAdpickAll 이 캐시에서 읽었다 (외부 호출 없음)', fr.ok === true && fr.items.length === 2, fr.reason);
  check('fetchAdpickAll 항목에 mallLabel 이 실린다', fr.items[0] && fr.items[0].mallLabel === 'GS SHOP',
    JSON.stringify(fr.items[0] && fr.items[0].mallLabel));
  check('cp_name 이 없으면 빈 값 (추측하지 않는다)', fr.items[1] && fr.items[1].mallLabel === '');

  const seen = [];
  const rows = [10, 11].map(n => ({
    product_id: adpickProductId(LINK(n)), mall: 'ADPICK', title: `상품 ${n}`, keyword: '오프라인 수집 키워드',
    link: LINK(n), image: '', vendor_item_id: '', item_id: ''
  }));
  await runMallCollection({
    mallName: 'ADPICK', rows, savedState: null, deadlineTs: Date.now() + 5000,
    fetchAllFn: async () => fr,
    collectedTodayFn: async () => new Set(),
    cacheHintFn: async () => new Map(),
    recordPricesFn: async (observations) => {
      seen.push(...observations);
      return { saved: observations.length, recorded: observations.length, rejected: 0, suspect: 0, errors: [],
        recordedKeys: observations.map(o => `${o.productId}|${o.mall}`) };
    }
  });
  const o10 = seen.find(o => o.productId === adpickProductId(LINK(10)));
  const o11 = seen.find(o => o.productId === adpickProductId(LINK(11)));
  check('수집기 관측치가 mallLabel 을 recordPrices 까지 들고 간다', o10 && o10.mallLabel === 'GS SHOP',
    JSON.stringify(o10 && o10.mallLabel));
  check('이름 없는 상품의 관측치는 빈 mallLabel', o11 && o11.mallLabel === '');

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
