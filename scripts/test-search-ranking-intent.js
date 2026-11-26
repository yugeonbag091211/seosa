#!/usr/bin/env node
'use strict';

/* Offline intent/ranking regression: no provider, database, or HTTP clients.
 * Normal run: node scripts/test-search-ranking-intent.js
 * Evidence:   node scripts/test-search-ranking-intent.js --report reports/search-ranking-after.json
 * Before:    --search-module <saved original module> --report <file> --snapshot-only
 * --snapshot-only captures failures without making the BEFORE command fail.
 */
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const F = require('./fixtures/search-ranking-fixtures');
const args = process.argv.slice(2);
function arg(name) {
  const at = args.indexOf(name);
  return at < 0 ? null : args[at + 1];
}
const modulePath = arg('--search-module');
const S = require(modulePath ? path.resolve(modulePath) : '../api/_search');
const checks = [];
const snapshots = [];
function copy(items) { return items.map(it => ({ ...it, trust: { ...it.trust } })); }
function check(ok, label, detail) {
  checks.push({ label, pass: !!ok, ...(ok ? {} : { detail }) });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ' — ' + JSON.stringify(detail)}`);
}
function rank(g, variant) {
  const input = copy(g.items);
  const titles = input.map(it => it.title);
  const analysis = S.analyzeQuery(g.query, { titles });
  const result = S.rankItems(g.query, input, { minScore: 0 });
  const ranked = S.sortByRelevance(result.items);
  snapshots.push({
    query: g.query, variant: variant || '', candidateType: 'offline adversarial fixture',
    analysis: { brandHead: analysis.brandHead, intent: analysis.intent || null,
      tokens: analysis.tokens.map(t => ({ text: t.text, kind: t.kind, weight: t.weight })) },
    dropped: result.dropped,
    ranking: ranked.map((it, i) => ({ rank: i + 1, id: it.productId, label: it.label,
      relevance: it.relevance, coverage: S.scoreTitle(analysis, it.title).score,
      focus: S.productFocus(analysis, it.title), reason: it.relevanceWhy || '',
      title: it.title, price: it.lprice, mall: it.mall, mallLabel: it.mallLabel }))
  });
  return ranked;
}
function positions(ranked, label) {
  return ranked.map((it, i) => it.label === label ? i : -1).filter(i => i >= 0);
}
function above(ranked, better, worse) {
  const a = positions(ranked, better), b = positions(ranked, worse);
  return a.length > 0 && b.length > 0 && Math.max(...a) < Math.min(...b);
}
/*
 * `worse` 가 `better` 를 앞지르지 않는다 — «아래에 있다» 와 «아예 빠졌다» 를
 * 모두 통과로 본다 (2026-11-23).
 *
 * 원래는 above() 하나로 봤는데, 그건 «worse 가 목록에 남아 있을 것» 까지 함께
 * 요구한다. 검색어 토큰이 하나도 안 걸린 상품을 빼기 시작하면서
 * (api/_search.js rankItems 의 zero-coverage 주석) 픽스처의 D(무관 상품)가
 * 목록에서 사라졌고, 그 체크들이 «빠졌다» 를 실패로 읽었다.
 *
 * 지키려는 명제는 «무관한 것이 관련 있는 것보다 위에 오지 않는다» 이다.
 * 빠진 것은 아무것도 앞지를 수 없으므로 그 명제를 더 강하게 만족한다.
 * better 쪽은 여전히 반드시 남아 있어야 한다 — 그게 빠지면 진짜 회귀다.
 */
function notAbove(ranked, worse, better) {
  const a = positions(ranked, better), b = positions(ranked, worse);
  if (!a.length) return false;
  return b.length === 0 || Math.max(...a) < Math.min(...b);
}
function detail(ranked) { return ranked.map(it => `${it.label}:${it.relevance}:${it.title}`); }
function retainMain(g, ranked) {
  const expected = g.items.filter(it => it.label === 'A').map(it => it.productId);
  return expected.every(id => ranked.some(it => it.productId === id));
}

async function main() {
console.log('\nBrand-only: all requested main products outrank cheap compatible parts');
for (const g of F.brands) {
  const r = rank(g, 'brand-only');
  check(above(r, 'A', 'C'), `${g.query}: A > C, including consumables and English compatibility`, detail(r));
  check(r.slice(0, 3).every(it => it.label === 'A'), `${g.query}: top 3 contains main products`, detail(r.slice(0, 3)));
  check(notAbove(r, 'D', 'C') && notAbove(r, 'D', 'A'), `${g.query}: unrelated is below relevant candidates (or removed)`, detail(r));
  check(retainMain(g, r), `${g.query}: main-product recall preserved`, detail(r));
}

console.log('\nProduct-family queries');
for (const g of F.families) {
  const r = rank(g, 'product-family');
  check(above(r, 'A', 'C'), `${g.query}: main family > compatible accessory`, detail(r));
  check(notAbove(r, 'D', 'A') && r[0].label === 'A', `${g.query}: requested family first, unrelated last (or removed)`, detail(r));
  check(retainMain(g, r), `${g.query}: main-family recall preserved`, detail(r));
}

console.log('\nBrand plus product-family: A > B > C > D');
for (const g of F.brandProducts) {
  const r = rank(g, 'brand-product');
  check(S.analyzeQuery(g.query, { titles: g.items.map(it => it.title) }).intent === 'BRAND_PRODUCT',
    `${g.query}: primary title evidence identifies brand plus product intent`);
  check(above(r, 'A', 'B'), `${g.query}: exact family > same-brand different family`, detail(r));
  check(above(r, 'B', 'C'), `${g.query}: brand main product > compatible part`, detail(r));
  check(notAbove(r, 'D', 'C'), `${g.query}: compatible result > unrelated (or removed)`, detail(r));
}

console.log('\nExact model: exact main product first; model tokens remain dominant');
for (const g of F.models) {
  const r = rank(g, 'exact-model');
  check(above(r, 'A', 'C'), `${g.query}: exact main product > exact-model accessory`, detail(r));
  check(notAbove(r, 'B', 'A') && r[0].label === 'A', `${g.query}: exact model > neighboring model (or removed)`, detail(r));
  const a = r.find(it => it.label === 'A');
  const b = r.find(it => it.label === 'B');
  // b 가 빠졌으면 격차는 더 벌어진 것이다 — 그 경우도 통과로 본다 (notAbove 주석).
  check(!!a && (!b || a.relevance - b.relevance >= 0.4),
    `${g.query}: exact-model relevance lead >= 0.4 (or neighbor removed)`, detail(r));
}

console.log('\nExplicit accessories: C > A, query-target accessory recall retained');
for (const g of F.accessories) {
  const r = rank(g, 'explicit-accessory');
  check(above(r, 'C', 'A'), `${g.query}: requested accessory > main product`, detail(r));
  check(above(r, 'C', 'B') && above(r, 'C', 'D'), `${g.query}: correct accessory > wrong family/target`, detail(r));
  const wanted = g.items.filter(it => it.label === 'C');
  const defaultKept = S.rankItems(g.query, copy(g.items)).items;
  check(wanted.every(it => defaultKept.some(k => k.productId === it.productId)),
    `${g.query}: requested accessories survive default threshold`, detail(defaultKept));
}

console.log('\nUnknown/long-tail heads: same rules without a brand allowlist');
for (const g of F.longtails) {
  const r = rank(g, 'long-tail');
  check(above(r, 'A', 'C'), `${g.query}: unknown-head main product > compatible part`, detail(r));
  check(notAbove(r, 'D', 'C'), `${g.query}: compatible part > unrelated (or removed)`, detail(r));
  check(retainMain(g, r), `${g.query}: unknown-head recall preserved`, detail(r));
}

console.log('\nBundled accessories describe a main product');
for (const [i, g] of F.bundles.entries()) {
  const r = rank(g, `bundle-${i}`);
  check(above(r, 'A', 'C'), `${g.query} bundle: main product with included accessory > standalone accessory`, detail(r));
  check(retainMain(g, r), `${g.query} bundle: both legitimate main products retained`, detail(r));
}

/*
 * 무엇이 «빠질» 수 있는가 (2026-11-24 재검증).
 *
 * notAbove() 는 «무관한 것이 목록에서 빠졌다» 를 통과로 본다. 그만큼 느슨해진
 * 자리를 여기서 따로 조인다: 빠진 후보는 무관한 것(D)이나 다른 모델(B)뿐이어야
 * 하고, 본품(A)·부속(C)은 한 건도 빠지면 안 된다. rankItems 의 «숫자 조각만
 * 걸린 상품» 규칙이 넓어져 관련 상품을 지우기 시작하면 여기서 잡힌다.
 */
console.log('\nRemoved candidates are unrelated (D) or neighboring models (B) only');
for (const [name, groups] of Object.entries({
  brands: F.brands, families: F.families, brandProducts: F.brandProducts,
  models: F.models, accessories: F.accessories, longtails: F.longtails, bundles: F.bundles
})) {
  for (const g of groups) {
    const kept = new Set(S.rankItems(g.query, copy(g.items), { minScore: 0 }).items.map(it => it.productId));
    const removed = g.items.filter(it => !kept.has(it.productId));
    check(removed.every(it => it.label === 'D' || it.label === 'B'),
      `${g.query} (${name}): only D/B candidates may be removed`, removed.map(it => `${it.label}:${it.title}`));
  }
}

console.log('\nMall/price/trust cannot reverse different relevance');
const main = F.item('bias-main', '삼성전자 갤럭시 S26 자급제', 'A', 1000000);
const part = F.item('bias-part', 'HP LaserJet 삼성 K7용 스캐너 어셈블리', 'C', 1000, 'ADPICK');
for (const swap of [false, true]) {
  const g = { query: '삼성', items: [main, part].map(it => ({ ...it })) };
  if (swap) { g.items[0].mall = 'ADPICK'; g.items[0].mallLabel = '알리'; g.items[1].mall = '쿠팡'; g.items[1].mallLabel = '쿠팡'; }
  g.items[0].trust = { level: 'low', score: 10 };
  g.items[1].trust = { level: 'high', score: 100 };
  const r = rank(g, swap ? 'mall-swapped' : 'mall-original');
  check(above(r, 'A', 'C'), `main > 1000-won trusted part when malls ${swap ? 'swapped' : 'original'}`, detail(r));
}
const strict = S.sortByRelevance([
  { ...main, relevance: 0.95, trust: { score: 10 } },
  { ...part, relevance: 0.60, trust: { score: 100 } }
]);
check(strict[0].productId === main.productId, '0.95 main product beats 0.60 low-price part', detail(strict));
const tie = S.sortByRelevance([
  { ...main, productId: 'expensive', relevance: 0.95, lprice: 1000000 },
  { ...main, productId: 'cheap', relevance: 0.95, lprice: 900000 }
]);
check(tie[0].productId === 'cheap', 'same relevance/trust exact products use lower price as tie-break', detail(tie));

console.log('\nFrontend consumes server ranking without rebuilding default order');
function loadFrontend() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const fm = src.match(/\nvar Filters = \{[\s\S]*?\n\};/);
  const vm = src.match(/ {2}viewList: function\(\) \{[\s\S]*?\n {2}\},/);
  if (!fm || !vm) throw new Error('Cannot extract actual Filters/viewList from public/index.html');
  const shim = `
    var AppState = { results: [], sort: 'default', facets: { mall:'all', minPrice:null, maxPrice:null, trust:'all', drop:false, ship:'all' } };
    var Fmt = { esc: function(s){ return String(s == null ? '' : s); }, won: function(n){ return (parseInt(n,10)||0).toLocaleString('ko-KR'); }, int: function(v){ return parseInt(v,10)||0; }, mall: function(it){ return {cls: it.mall === '쿠팡' ? 'b-coupang' : 'b-ali'}; } };
    function $(){ return null; } function $$(){ return []; }
    function show(){} function setText(){} function setHTML(){}
    var Search = { ${vm[0].replace(/,\s*$/, '')} };
  `;
  return new Function(`${shim}\n${fm[0]}\nreturn { Search: Search, AppState: AppState };`)();
}
const front = loadFrontend();
front.AppState.results = strict;
check(front.Search.viewList().map(it => it.productId).join('|') === strict.map(it => it.productId).join('|'),
  'frontend default order preserves server relevance ordering', front.Search.viewList().map(it => it.productId));
front.AppState.facets.mall = '쿠팡';
check(front.Search.viewList().every(it => it.mall === '쿠팡'), 'frontend mall facet selects existing items without changing ranking contract');
front.AppState.facets.mall = 'all';
front.AppState.sort = 'lowprice';
check(front.Search.viewList()[0].productId === part.productId, 'frontend explicitly selected low-price sort remains user-controlled');

console.log('\nIndependent counterexamples: compounds, nested accessories, and model boundaries');
const preferences = [
  ['unknown-brand', '아트로스', '아트로스 무선청소기 ATX-900', '노바 아트로스용 교체 필터 ATX-900'],
  ['promotion-prefix', '아트로스', '[무료배송 정품] 아트로스 무선청소기 ATX-900', '노바 아트로스 전용 배터리'],
  ['english-prefix', 'ATX-900', '아트로스 ATX-900 무선청소기', 'Replacement filter for ATX-900'],
  ['english-compatible', '아트로스', '아트로스 무선청소기', 'Brush compatible with 아트로스 무선청소기'],
  ['prefix-component', '공기청정기', '아트로스 공기청정기 ATX-900', '호환 필터 공기청정기용 ATX-900'],
  ['toner-component', '프린터', '아트로스 프린터 ATX-900', '프린터용 호환 토너 ATX-900'],
  ['gear-component', '아트로스', '아트로스 무선청소기 ATX-900', '아트로스 무선청소기용 교체 기어 부품'],
  ['assembly-component', '스캐너', '아트로스 문서 스캐너 ATX-900', '스캐너 어셈블리 교체 부품 ATX-900'],
  ['compound-component', '텀블러', '아트로스 텀블러 590ml', '텀블러뚜껑 590ml'],
  ['compound-case', '아이폰', 'Apple 아이폰 17 자급제', '아이폰케이스 17 투명'],
  ['nested-filter', '공기청정기 필터', '아트로스 공기청정기 교체 필터', '공기청정기 필터 보관 케이스'],
  ['nested-battery', '배터리', '아트로스 충전 배터리 AA', '배터리 보관 케이스 AA'],
  ['nested-case', '아이폰 케이스', '아이폰 17 투명 케이스', '아이폰 케이스 전용 세척솔'],
  ['model-number-boundary', 'ABC-120', '아트로스 ABC-120 무선청소기', '아트로스 ABC-1200 무선청소기'],
  ['model-prefix-boundary', 'ABC-120', '아트로스 ABC-120 무선청소기', '아트로스 ZABC-120 무선청소기'],
  ['model-suffix-boundary', 'SL-X4300LX', '아트로스 SL-X4300LX 프린터', '아트로스 SL-X4300LXX 프린터'],
  ['shared-model-fragment', 'RSM-R510', '아트로스 RSM-R510 스캐너', '아트로스 OTH-R510 스캐너']
];
for (const [id, query, preferred, other] of preferences) {
  const r = rank({ query, items: [F.item(`${id}-a`, preferred, 'A', 900000), F.item(`${id}-c`, other, 'C', 1000)] }, id);
  check(r[0].title === preferred && r[0].relevance > r[1].relevance,
    `${id}: preferred sold object beats cheap misleading candidate`, detail(r));
}

console.log('\nNo false accessory penalty on legitimate main products and requested accessories');
const neutral = [
  ['아트로스', '아트로스 보습 토너 200ml'],
  ['아트로스', '아트로스 비타민 B5 보습 토너 200ml'],
  ['토너', '아트로스 피부 보습 토너 200ml'],
  ['삼성', '삼성 기어 S3 스마트워치'],
  ['기어', '삼성 기어 S3 스마트워치'],
  ['이어폰', '아트로스 무선 이어폰 Bluetooth compatible with Android'],
  ['아트로스', '아트로스 스마트 스피커 Android compatible'],
  ['노트북', '아트로스 노트북 WiFi compatible Windows 11'],
  ['노트북', '업무용 아트로스 노트북 ATX-900'],
  ['프린터', '대용량 아트로스 프린터 ATX-900'],
  ['이어폰', '아트로스 무선 이어폰 충전케이스 포함'],
  ['갤럭시 S24', '케이스 포함 삼성 갤럭시 S24 자급제'],
  ['노트북', '충전기 증정 아트로스 노트북 ATX-900'],
  ['아이폰 케이스', '아이폰 17 투명 커버'],
  ['아이폰 케이스', 'Protective case for 아이폰 17'],
  ['노트북 충전기', '노트북 전용 어댑터 65W'],
  ['노트북 충전기', 'Charger for 노트북 65W'],
  ['프린터 토너', '프린터용 호환 토너 ATX-900'],
  ['공기청정기 필터', '아트로스 공기청정기 교체 필터 ATX-900'],
  ['아트로스', '아트로스 문서 스캐너 ATX-900'],
  ['아트로스', '아트로스 컬러 잉크젯 프린터 ATX-900'],
  ['아트로스', '아트로스 기어오일 1L'],
  ['헤드폰', '아트로스 over ear 무선 헤드폰']
];
for (const [query, title] of neutral) {
  const analysis = S.analyzeQuery(query, { titles: [title] });
  check(S.productFocus(analysis, title).factor === 1, `${query}: preserve ${title}`, S.productFocus(analysis, title));
}
for (const title of ['아트로스 ABC120 무선청소기', '아트로스 ABC-120-GX56 무선청소기']) {
  const r = S.rankItems('ABC-120', [F.item('model-format', title, 'A', 900000)], { minScore: 0 });
  check(!String(r.items[0].relevanceWhy || '').includes('model-boundary-miss'), `model spelling/variant preserved: ${title}`, detail(r.items));
}
const fakeBundle = '갤럭시 S24 호환 케이스 스마트폰 포함';
check(S.productFocus(S.analyzeQuery('갤럭시 S24'), fakeBundle).factor < 1,
  'including a main-product noun does not disguise a compatible case', S.productFocus(S.analyzeQuery('갤럭시 S24'), fakeBundle));

const duplicate = S.rankItems('삼성', [
  F.item('same-id', '삼성전자 갤럭시 S26 자급제', 'A', 1000000),
  F.item('same-id', '삼성전자 갤럭시 S26 자급제', 'A', 900000)
], { minScore: 0 });
check(duplicate.items.length === 1 && duplicate.items[0].lprice === 900000
  && Number.isFinite(duplicate.items[0].relevance), 'ranked dedupe representative retains price and relevance');

console.log('\nActual /api/search handler: model separators, dedupe, and unchanged helper calls');
const handlerSource = fs.readFileSync(path.join(__dirname, '..', 'api', 'search.js'), 'utf8');
for (const g of [...F.models, { query: '삼성', items: [
  F.item('api-dup', '삼성전자 갤럭시 S26 자급제', 'A', 1000000),
  F.item('api-dup', '삼성전자 갤럭시 S26 자급제', 'A', 900000),
  F.item('api-part', 'HP LaserJet 삼성 K7용 스캐너 어셈블리', 'C', 1000)
] }]) {
  const calls = { search: 0, save: 0, trust: 0, facets: 0 };
  const dependencies = {
    './_supabase': { from() { throw new Error('unexpected dictionary DB query'); } },
    './_shop': {
      TODAY_PICKS: [],
      async searchAll() { calls.search++; return { items: copy(g.items), from: 'cache' }; },
      async saveProducts() { calls.save++; }
    },
    './_trust': { async attachTrust() { calls.trust++; } },
    './_facets': { async attachPriceChange() { calls.facets++; } },
    './_http': { applyCors: () => true, cachePublic() {}, noStore() {}, fail(_res, err) { throw err; } },
    './_ratelimit': { guard: () => true },
    './_search': S,
    './_physical-search-filter': require('../api/_physical-search-filter'),
    './_search-type-guard': require('../api/_search-type-guard'),
    // 2026-11-25: 기본 OFF(PRODUCT_KIND_CLASSIFY_ENABLED) — 꺼진 채로 돌아가는지만 확인한다.
    './_product-kind-store': require('../api/_product-kind-store'),
    // 2026-11-26: 기본 OFF(SEARCH_CATEGORY_GUARD_ENABLED) — 꺼진 채로 돌아가는지만 확인한다.
    './_search-category-guard': require('../api/_search-category-guard'),
    './_category-store': require('../api/_category-store'),
    './_search-provenance': require('../api/_search-provenance'),
    './_canonicalconsumer': { config: () => ({ enabled: false, percent: 0 }), async collapseItems(items) { return items; } },
    // 구매 링크 관문 — 순수 함수라 진짜 모듈을 쓴다.
    './_affiliate': require('../api/_affiliate')
  };
  const context = {
    module: { exports: {} }, console, process,
    require(name) {
      if (!(name in dependencies)) throw new Error(`unexpected dependency: ${name}`);
      return dependencies[name];
    },
    fetch() { throw new Error('unexpected network request'); }
  };
  vm.runInNewContext(handlerSource, context, { filename: 'api/search.js' });
  let response;
  const res = { setHeader() {}, status() { return this; }, json(items) { response = items; } };
  await context.module.exports({ query: { keyword: g.query } }, res);
  check(response && response[0].label === 'A', `/api/search ${g.query}: actual response starts with main product`, response && detail(response));
  check(Object.values(calls).every(n => n === 1), `/api/search ${g.query}: one existing call per helper, no additional queries`, calls);
  /*
   * 중복 제거는 «같은 상품이면 싼 쪽 하나만» 이다. 가격을 직접 본다.
   *
   * 2026-11-25: 목록 길이로 보던 것을 가격으로 바꿨다. 같은 후보에 들어 있는
   * «HP LaserJet 삼성 K7용 스캐너 어셈블리» 는 유형 가드(_search-type-guard)가
   * 빼므로 길이가 2 에서 1 이 된다. 그건 중복 제거와 무관한 변화다 —
   * 그 상품은 HP 프린터 부품이고 "삼성" 을 찾는 사람이 원한 물건이 아니다.
   * 아래 줄이 그 제외를 따로 고정한다.
   */
  if (g.query === '삼성') {
    check(response[0].lprice === 900000,
      '/api/search returns the scored cheapest dedupe representative', response && detail(response));
    check(!response.some(it => /스캐너\s*어셈블리/.test(it.title)),
      '/api/search drops a different-type part ("삼성" ≠ HP 스캐너 어셈블리)', response && detail(response));
    check(response.filter(it => /갤럭시 S26/.test(it.title)).length === 1,
      '/api/search keeps exactly one representative per duplicated product', response && detail(response));
  }
}

console.log('\nPRODUCT_KIND_CLASSIFY_ENABLED=1: GPT 1회 분류 안전망 연결 확인');
{
  async function runWithFlag(items, query, fakeLookupProductKinds) {
    const calls = { search: 0, save: 0, trust: 0, facets: 0 };
    const dependencies = {
      './_supabase': { from() { throw new Error('unexpected dictionary DB query'); } },
      './_shop': {
        TODAY_PICKS: [],
        async searchAll() { calls.search++; return { items: copy(items), from: 'cache' }; },
        async saveProducts() { calls.save++; }
      },
      './_trust': { async attachTrust() { calls.trust++; } },
      './_facets': { async attachPriceChange() { calls.facets++; } },
      './_http': { applyCors: () => true, cachePublic() {}, noStore() {}, fail(_res, err) { throw err; } },
      './_ratelimit': { guard: () => true },
      './_search': S,
      './_physical-search-filter': require('../api/_physical-search-filter'),
      './_search-type-guard': require('../api/_search-type-guard'),
      // 2026-11-25 배치 분리: 검색 경로는 이제 lookupProductKinds(읽기 전용)만 쓴다 —
      // syncProductKinds(GPT 호출+저장)는 배치 스크립트 전용이라 여기선 호출되지 않는다.
      './_product-kind-store': { lookupProductKinds: fakeLookupProductKinds },
      // 2026-11-26: 기본 OFF(SEARCH_CATEGORY_GUARD_ENABLED) — 꺼진 채로 돌아가는지만 확인한다.
      './_search-category-guard': require('../api/_search-category-guard'),
      './_category-store': require('../api/_category-store'),
      './_search-provenance': require('../api/_search-provenance'),
      './_canonicalconsumer': { config: () => ({ enabled: false, percent: 0 }), async collapseItems(it) { return it; } },
      './_affiliate': require('../api/_affiliate')
    };
    const envBackup = process.env.PRODUCT_KIND_CLASSIFY_ENABLED;
    process.env.PRODUCT_KIND_CLASSIFY_ENABLED = '1';
    const context = {
      module: { exports: {} }, console, process,
      require(name) {
        if (!(name in dependencies)) throw new Error(`unexpected dependency: ${name}`);
        return dependencies[name];
      },
      fetch() { throw new Error('unexpected network request'); }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'api', 'search.js'), 'utf8'), context,
      { filename: 'api/search.js' });
    let response;
    const res = { setHeader() {}, status() { return this; }, json(it) { response = it; } };
    try {
      await context.module.exports({ query: { keyword: query } }, res);
    } finally {
      process.env.PRODUCT_KIND_CLASSIFY_ENABLED = envBackup;
    }
    return response;
  }

  // GPT가 "트레이는 부속이다"라고 답했다고 가정 — 사전(ACCESSORY_TIER)에는
  // 없는 단어라 기존 _search-type-guard 만으로는 못 잡는 케이스다.
  const items = [
    F.item('nas-body', '시놀로지 DS224+ NAS 2베이', 'A', 450000),
    F.item('nas-tray', 'DS224+용 호환 하드 트레이', 'C', 15000)
  ];
  const kinds = new Map([['nas-tray', 'accessory']]);
  const response = await runWithFlag(items, 'DS224+', async () => kinds);
  check(response && response.length === 1 && response[0].productId === 'nas-body',
    'GPT가 accessory로 answer한 상품은 응답에서 빠진다(사전엔 없던 "트레이")', response && detail(response));

  // 전부 accessory로 나오면(판정 과잉 의심) 적용을 포기하고 원본을 그대로 보여준다.
  const allAccessory = new Map([['nas-body', 'accessory'], ['nas-tray', 'accessory']]);
  const response2 = await runWithFlag(items, 'DS224+', async () => allAccessory);
  check(response2 && response2.length === 2,
    '전부 accessory로 나오면 가드를 적용하지 않는다(본품까지 사라지는 사고 방지)', response2 && detail(response2));

  // lookupProductKinds가 실패해도(타임아웃/네트워크) 검색 자체는 멈추지 않는다.
  const response3 = await runWithFlag(items, 'DS224+', async () => { throw new Error('timeout'); });
  check(response3 && response3.length === 2,
    'GPT 분류가 실패해도 검색은 그대로 응답한다(기존 결과 유지)', response3 && detail(response3));
}

console.log('\nSEARCH_CATEGORY_GUARD_ENABLED=1: 카테고리 안전망 연결 확인 (PR #277, 2026-11-26)');
{
  async function runWithCategoryFlag(items, query, fakeLookupCategories) {
    const calls = { search: 0, save: 0, trust: 0, facets: 0 };
    const dependencies = {
      './_supabase': { from() { throw new Error('unexpected dictionary DB query'); } },
      './_shop': {
        TODAY_PICKS: [],
        async searchAll() { calls.search++; return { items: copy(items), from: 'cache' }; },
        async saveProducts() { calls.save++; }
      },
      './_trust': { async attachTrust() { calls.trust++; } },
      './_facets': { async attachPriceChange() { calls.facets++; } },
      './_http': { applyCors: () => true, cachePublic() {}, noStore() {}, fail(_res, err) { throw err; } },
      './_ratelimit': { guard: () => true },
      './_search': S,
      './_physical-search-filter': require('../api/_physical-search-filter'),
      './_search-type-guard': require('../api/_search-type-guard'),
      './_product-kind-store': require('../api/_product-kind-store'),
      // 카테고리 가드만 켠다 — filterByCategory는 진짜 모듈을 쓰고, lookupCategories만
      // 가짜로 바꿔 "배치가 이미 저장해 둔 값"을 흉내 낸다.
      './_search-category-guard': require('../api/_search-category-guard'),
      './_category-store': { lookupCategories: fakeLookupCategories },
      './_search-provenance': require('../api/_search-provenance'),
      './_canonicalconsumer': { config: () => ({ enabled: false, percent: 0 }), async collapseItems(it) { return it; } },
      './_affiliate': require('../api/_affiliate')
    };
    const envBackup = process.env.SEARCH_CATEGORY_GUARD_ENABLED;
    process.env.SEARCH_CATEGORY_GUARD_ENABLED = '1';
    const context = {
      module: { exports: {} }, console, process,
      require(name) {
        if (!(name in dependencies)) throw new Error(`unexpected dependency: ${name}`);
        return dependencies[name];
      },
      fetch() { throw new Error('unexpected network request'); }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'api', 'search.js'), 'utf8'), context,
      { filename: 'api/search.js' });
    let response;
    const res = { setHeader() {}, status() { return this; }, json(it) { response = it; } };
    try {
      await context.module.exports({ query: { keyword: query } }, res);
    } finally {
      process.env.SEARCH_CATEGORY_GUARD_ENABLED = envBackup;
    }
    return response;
  }

  // 오늘 실사용에서 제보된 바로 그 사고 — "그래픽카드" 검색에 글자만 겹친 옷이
  // 섞여 들어온 것(PR #277). 배치가 이미 "GPU=전자기기, 맨투맨=패션의류"로
  // 분류해 뒀다고 가정하면, 카테고리 가드가 옷을 완전히 걸러내야 한다.
  const gpuItems = [
    F.item('gpu', 'RTX 4070 그래픽카드 지포스 게이밍 PC용', 'A', 700000),
    F.item('sweatshirt', '오픈런 아토가토 그래픽 맨투맨뒤면 게임 트럼프카드 니트패턴', 'C', 35000)
  ];
  const cats = new Map([['gpu', '전자기기'], ['sweatshirt', '패션의류']]);
  const r1 = await runWithCategoryFlag(gpuItems, '그래픽카드', async () => cats);
  check(r1 && r1.length === 1 && r1[0].productId === 'gpu',
    '카테고리가 다른 "트럼프카드" 맨투맨은 응답에서 완전히 빠진다', r1 && detail(r1));

  // 전부 다른 카테고리로 나오면(판정 과잉 의심) 적용을 포기하고 원본을 그대로 보여준다.
  const allMismatch = new Map([['gpu', '패션의류'], ['sweatshirt', '패션의류']]);
  const r2 = await runWithCategoryFlag(gpuItems, '그래픽카드', async () => allMismatch);
  check(r2 && r2.length === 2,
    '전부 불일치로 나오면 가드를 적용하지 않는다(진짜 GPU까지 사라지는 사고 방지)', r2 && detail(r2));

  // lookupCategories가 실패해도(타임아웃/네트워크) 검색 자체는 멈추지 않는다.
  const r3 = await runWithCategoryFlag(gpuItems, '그래픽카드', async () => { throw new Error('timeout'); });
  check(r3 && r3.length === 2,
    '카테고리 조회가 실패해도 검색은 그대로 응답한다(기존 결과 유지)', r3 && detail(r3));
}

const passed = checks.filter(c => c.pass).length;
const failed = checks.length - passed;
let benchmark;
if (arg('--benchmark-baseline')) {
  const original = require(path.resolve(arg('--benchmark-baseline')));
  const { performance } = require('node:perf_hooks');
  const groups = F.brands.slice(0, 5);
  function measure(search) {
    const times = [];
    for (let round = 0; round < 1100; round++) {
      for (const g of groups) {
        const input = copy(g.items);
        const start = performance.now();
        search.sortByRelevance(search.rankItems(g.query, input, { minScore: 0 }).items);
        if (round >= 100) times.push(performance.now() - start);
      }
    }
    times.sort((a, b) => a - b);
    return { samples: times.length, meanMs: times.reduce((a, b) => a + b, 0) / times.length,
      p95Ms: times[Math.floor(times.length * 0.95)] };
  }
  benchmark = { runtime: process.version, platform: process.platform,
    candidatesPerSearch: groups.map(g => g.items.length), baseline: measure(original), after: measure(S),
    note: 'Local warmed offline ranking only; includes dedupe/scoring/sort, excludes cloning and all I/O.' };
  console.log(`\nBenchmark: ${JSON.stringify(benchmark)}`);
}
const report = {
  fixtureSource: 'Offline synthetic adversarial data; example Samsung titles supplied in user request',
  sourceRevision: modulePath ? 'main 9749341e796bc67fffdb3a38e151d7b3aa45f93d (saved module)' : 'working tree',
  externalApiCalls: 0, databaseQueries: 0,
  rankingGroups: snapshots.length, neutralCounterexamples: neutral.length,
  ...(benchmark ? { benchmark } : {}),
  summary: { total: checks.length, passed, failed }, checks, snapshots
};
const reportFile = arg('--report');
if (reportFile) {
  const dest = path.resolve(reportFile);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`\nReport: ${dest}`);
}
console.log('\nTop 10 fixture rankings');
for (const snap of snapshots.filter(s => s.variant === 'brand-only' && s.query !== '나이키')) {
  console.log(`\n${snap.query}`);
  snap.ranking.slice(0, 10).forEach(it => console.log(`${it.rank}. [${it.label}] ${it.relevance.toFixed(3)} ${it.title}`));
}
console.log(`\nIntent regression: ${passed}/${checks.length} PASS, ${failed} FAIL. External calls: 0. DB queries: 0.`);
process.exitCode = failed && !args.includes('--snapshot-only') ? 1 : 0;
}
main().catch(err => { console.error(err); process.exitCode = 1; });
