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
  check(above(r, 'C', 'D') && above(r, 'A', 'D'), `${g.query}: unrelated is below relevant candidates`, detail(r));
  check(retainMain(g, r), `${g.query}: main-product recall preserved`, detail(r));
}

console.log('\nProduct-family queries');
for (const g of F.families) {
  const r = rank(g, 'product-family');
  check(above(r, 'A', 'C'), `${g.query}: main family > compatible accessory`, detail(r));
  check(above(r, 'A', 'D') && r[0].label === 'A', `${g.query}: requested family first, unrelated last`, detail(r));
  check(retainMain(g, r), `${g.query}: main-family recall preserved`, detail(r));
}

console.log('\nBrand plus product-family: A > B > C > D');
for (const g of F.brandProducts) {
  const r = rank(g, 'brand-product');
  check(S.analyzeQuery(g.query, { titles: g.items.map(it => it.title) }).intent === 'BRAND_PRODUCT',
    `${g.query}: primary title evidence identifies brand plus product intent`);
  check(above(r, 'A', 'B'), `${g.query}: exact family > same-brand different family`, detail(r));
  check(above(r, 'B', 'C'), `${g.query}: brand main product > compatible part`, detail(r));
  check(above(r, 'C', 'D'), `${g.query}: compatible result > unrelated`, detail(r));
}

console.log('\nExact model: exact main product first; model tokens remain dominant');
for (const g of F.models) {
  const r = rank(g, 'exact-model');
  check(above(r, 'A', 'C'), `${g.query}: exact main product > exact-model accessory`, detail(r));
  check(above(r, 'A', 'B') && r[0].label === 'A', `${g.query}: exact model > neighboring model`, detail(r));
  const a = r.find(it => it.label === 'A');
  const b = r.find(it => it.label === 'B');
  check(a && b && a.relevance - b.relevance >= 0.4,
    `${g.query}: exact-model relevance lead >= 0.4`, detail(r));
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
  check(above(r, 'C', 'D'), `${g.query}: compatible part > unrelated`, detail(r));
  check(retainMain(g, r), `${g.query}: unknown-head recall preserved`, detail(r));
}

console.log('\nBundled accessories describe a main product');
for (const [i, g] of F.bundles.entries()) {
  const r = rank(g, `bundle-${i}`);
  check(above(r, 'A', 'C'), `${g.query} bundle: main product with included accessory > standalone accessory`, detail(r));
  check(retainMain(g, r), `${g.query} bundle: both legitimate main products retained`, detail(r));
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
    // 구매 링크 관문 — 순수 함수라 진짜 모듈을 쓴다.
    './_affiliate': require('../api/_affiliate')
  };
  const context = { module: { exports: {} }, console, require(name) {
    if (!(name in dependencies)) throw new Error(`unexpected dependency: ${name}`);
    return dependencies[name];
  }, fetch() { throw new Error('unexpected network request'); } };
  vm.runInNewContext(handlerSource, context, { filename: 'api/search.js' });
  let response;
  const res = { setHeader() {}, status() { return this; }, json(items) { response = items; } };
  await context.module.exports({ query: { keyword: g.query } }, res);
  check(response && response[0].label === 'A', `/api/search ${g.query}: actual response starts with main product`, response && detail(response));
  check(Object.values(calls).every(n => n === 1), `/api/search ${g.query}: one existing call per helper, no additional queries`, calls);
  if (g.query === '삼성') check(response.length === 2 && response[0].lprice === 900000,
    '/api/search returns the scored cheapest dedupe representative', response && detail(response));
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
