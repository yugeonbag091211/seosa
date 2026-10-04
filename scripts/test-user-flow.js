#!/usr/bin/env node
'use strict';
/*
 * 신규 사용자 구매 흐름 회귀 — 2026-10-04 운영 검증에서 나온 세 가지.
 *
 *   1) 검색·홈 카드에서 연 가격 모달이 옵션(vendorItemId)을 잃지 않는다.
 *      빠져 있던 동안 /api/history 가 같은 상품 페이지의 다른 옵션 가격까지
 *      한 곡선으로 섞었다 ("드립백 봉투" 2,500원 카드의 최고가가 다른 옵션
 *      42,000원).
 *   2) 검색 결과 화면에서 히어로 캐러셀(.hero-band)을 접는다. 390×844 에서
 *      검색 직후 첫 카드의 가격·구매 버튼이 화면 밖(y≈1,100)이었다.
 *   3) 구매 클릭이 상품 단위(affiliate_click)로 남는다. 히어로 책등 말고는
 *      어느 화면에서 무엇이 눌렸는지 남지 않았다.
 *
 * index.html 에서 함수 본문을 그대로 잘라 스텁 위에서 «실행» 한다 — 문자열이
 * 있는지만 보는 단언은 함수가 그 값을 실제로 돌려주는지까지는 못 지킨다.
 * 네트워크 0회.
 */
const fs = require('fs');
const path = require('path');

global.fetch = async url => { throw new Error(`오프라인 테스트에서 외부 호출: ${url}`); };

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
// 주석 속 설명이 단언을 흔들지 않게 걷어 낸 «실행되는 코드»
const live = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail === undefined ? '' : '  — ' + JSON.stringify(detail)}`); }
}
function section(t) { console.log(`\n[${t}]`); }

/** `marker` 로 시작하는 함수 리터럴의 본문({…})을 중괄호 짝으로 잘라 낸다. */
function fnBody(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`찾을 수 없음: ${marker}`);
  const open = src.indexOf('{', at + marker.length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`본문이 닫히지 않음: ${marker}`);
}
/** `var Name = {` 객체 리터럴 안만 잘라 낸다 (같은 이름의 메서드가 여러 객체에 있다). */
function objectSrc(src, name) {
  return fnBody(src, `var ${name} = {`);
}

/* ══════════════════════════════════════════════════════════════════
 *  1) Card.read 가 옵션 식별자를 돌려준다
 * ════════════════════════════════════════════════════════════════ */
section('1) 카드 → 가격 모달: 옵션 식별자');
{
  const cardSrc = objectSrc(live, 'Card');
  const readBody = fnBody(cardSrc, 'read: function(card) {');
  const Fmt = { textOf: el => (el ? el.text : ''), priceOf: el => (el ? el.price : 0) };
  const productKey = (t, m, pid) => (pid ? `${m}|${pid}` : `${t}|${m}`);
  const make = AppState => new Function('Fmt', 'AppState', 'productKey', `return function(card) ${readBody};`)(Fmt, AppState, productKey);
  const fakeCard = (dataset) => ({
    dataset,
    querySelector: sel => (sel === '.p-title' ? { text: '미스터빈 크라프트 드립백 봉투' } : sel === '.price' ? { price: 2500 } : null)
  });

  // 검색 결과처럼 AppState.products 에 원본 항목이 있는 경우
  const stored = { title: '미스터빈 크라프트 드립백 봉투', mall: '쿠팡', productId: '344928021', vendorItemId: '5615510064', link: 'https://link.coupang.com/re/AFFSDP?x=1' };
  const readA = make({ products: { '쿠팡|344928021': stored } });
  const a = readA(fakeCard({ pid: '344928021', mall: '쿠팡', vid: '', glyph: '✦' }));
  ok(a.vendorItemId === '5615510064', '★ 저장된 항목의 vendorItemId 를 돌려준다', a);

  // 카드에 심긴 data-vid 만 있는 경우 (위시·최근 본 상품처럼 AppState 에 없을 때)
  const readB = make({ products: {} });
  const b = readB(fakeCard({ pid: '344928021', mall: '쿠팡', vid: '5615510064', glyph: '✦' }));
  ok(b.vendorItemId === '5615510064', '★ 카드의 data-vid 만으로도 옵션을 되찾는다', b);

  const c = readB(fakeCard({ pid: 'abc', mall: 'ADPICK', glyph: '✦' }));
  ok(c.vendorItemId === '', '옵션이 없는 상품(ADPICK)은 빈 문자열 — 지어내지 않는다', c);

  ok(/' data-vid="' \+ Fmt\.esc\(it\.vendorItemId \|\| ''\) \+ '"'/.test(fnBody(cardSrc, 'html: function(it) {')),
    '★ Card.html 이 data-vid 를 심는다');
  ok(live.includes("vendorItemId: p.vendorItemId || '', deal: 1"),
    'Modal.open 은 받은 vendorItemId 를 /api/history 에 그대로 넘긴다');
}

/* ══════════════════════════════════════════════════════════════════
 *  2) 검색 결과 화면에서 히어로 캐러셀을 접는다
 * ════════════════════════════════════════════════════════════════ */
section('2) 검색 결과: 히어로 캐러셀 접기');
{
  const searchSrc = objectSrc(live, 'Search');
  const run = fnBody(searchSrc, 'run: function(');
  const home = fnBody(searchSrc, 'goHome: function(opts) {');
  ok(/querySelector\('\.hero-band'\)[\s\S]*?style\.display = 'none'/.test(run), '★ Search.run 이 .hero-band 를 접는다');
  ok(run.indexOf(".hero-band") < run.indexOf("Search.cached(kw)"),
    '뒤로/앞으로(캐시 결과) 경로도 접힌 상태로 그린다 — 접기가 캐시 분기보다 앞');
  ok(/querySelector\('\.hero-band'\)[\s\S]*?style\.display = ''/.test(home), '★ goHome 이 .hero-band 를 되돌린다');
  ok(/class="hero-band"/.test(live), '.hero-band 마크업이 그대로 있다 (선택자가 헛돌지 않는다)');
}

/* ══════════════════════════════════════════════════════════════════
 *  3) 구매 클릭이 상품 단위 행으로 남는다
 * ════════════════════════════════════════════════════════════════ */
section('3) 구매 클릭 계측 (affiliate_click)');
{
  const trackSrc = objectSrc(live, 'Track');
  const affBody = fnBody(trackSrc, 'affiliate: function(it, src) {');
  const pings = [];
  const Track = { vid: () => 'vtest12345', ping: qs => pings.push(qs) };
  const Fmt = { int: v => { const n = parseInt(String(v == null ? '' : v).replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : 0; } };
  const affiliate = new Function('Track', 'Fmt', `return function(it, src) ${affBody};`)(Track, Fmt);

  affiliate({ mall: '쿠팡', productId: '9751742272', lprice: 209000 }, 'search');
  const q = new URLSearchParams(pings[0]);
  ok(q.get('event') === 'affiliate_click', '★ event=affiliate_click', pings[0]);
  ok(q.get('src') === 'search' && q.get('mall') === '쿠팡' && q.get('pid') === '9751742272', '★ src · mall · pid', pings[0]);
  ok(q.get('price') === '209000' && q.get('vid') === 'vtest12345', 'price(관측값) · 방문자 난수', pings[0]);
  ok(!/title|link|http/i.test(pings[0]), '상품명·URL 은 보내지 않는다 (최소 수집)', pings[0]);

  affiliate({ mall: 'ADPICK', productId: 'abc', lprice: 0 }, 'ai');
  ok(new URLSearchParams(pings[1]).get('price') === null, '가격을 모르면 price 를 보내지 않는다 — 0원을 기록하지 않는다', pings[1]);

  // 서버가 받아 주는 출처 이름인가 — 아니면 조용히 ''(모름)으로 저장된다.
  const { SOURCES } = require('../api/_funnel')._internal || {};
  const sources = SOURCES || require('../api/_funnel').SOURCES;
  const used = [...live.matchAll(/Track\.affiliate\([^;]*?'([a-z_]+)'(?: : '([a-z_]+)')?\)/g)]
    .flatMap(m => [m[1], m[2]]).filter(Boolean);
  ok(used.length >= 5, '구매 경로 네 곳(검색/홈 카드·모달·핫딜·AI)이 affiliate 를 보낸다', used);
  ok(Array.isArray(sources) && used.every(s => sources.indexOf(s) > -1),
    '★ 쓰는 src 이름이 전부 서버 화이트리스트(_funnel.SOURCES)에 있다', { used, sources });

  const act = name => fnBody(objectSrc(live, 'Actions'), `'${name}':`);
  ok(/Track\.affiliate\(info, el\.closest\('#resGrid'\) \? 'search' : 'home'\)/.test(act('card-buy')), '카드 구매: 검색 결과면 search, 아니면 home');
  ok(/Track\.affiliate\(it, 'product'\)/.test(act('modal-buy')), '가격 모달 구매: product');
  ok(/Track\.affiliate\(info, 'hotdeal'\)/.test(act('ledger-buy')), '핫딜 구매: hotdeal');
  ok(/Track\.affiliate\([\s\S]*'ai'\)/.test(act('mini-go')), 'AI 카드 구매: ai');
  ok(/data-pid="' \+ Fmt\.esc\(it\.productId \|\| ''\)/.test(fnBody(live, 'miniCard: function(it) {')),
    'AI 카드가 계측에 쓸 pid·mall·price 를 들고 있다');
  // 클릭이 계측 때문에 막히지 않는다 — 링크를 여는 것은 그대로 openLink 다.
  ['card-buy', 'modal-buy', 'ledger-buy', 'mini-go'].forEach(n =>
    ok(/openLink\(/.test(act(n)), `${n}: 링크는 여전히 openLink 가 연다 (리다이렉트를 끼우지 않는다)`));
}

console.log(`\n${'='.repeat(58)}`);
console.log(`PASS ${pass} / FAIL ${fail}`);
if (fail) {
  console.log('\n실패한 항목:');
  failures.forEach(f => console.log(`  · ${f}`));
  process.exit(1);
}
console.log('구매 흐름 계약 이상 없음.');
