#!/usr/bin/env node
'use strict';
/*
 * 신규 사용자 구매 흐름 — 브라우저 쪽 회귀 (2026-10-04, 독립 리뷰 후 실행 기반으로 다시 씀).
 *
 * public/index.html 메인 스크립트를 통째로 vm 에서 «실행» 하고(scripts/_fake-dom.js),
 * 실제 객체와 실제 document 클릭 위임 핸들러로 누른다. 문자열 검사는 보조로만 둔다 —
 * `if (false && …)` 처럼 기능을 죽여도 통과하는 시험은 지키는 것이 없다.
 *
 *   1) 검색 결과 화면에서 히어로 캐러셀을 접고, 홈으로 돌아가면 되돌린다
 *   2) 구매 CTA 다섯 곳: 외부 이동 정확히 1회 · affiliate_click 정확히 1회 · src/mall/pid/price/vid
 *      · 계측이 실패해도 이동은 막히지 않는다
 *   3) 같은 productId 의 옵션 A/B 가 공유 캐시에 같이 있어도 «가격·옵션·링크» 가 한 옵션이다
 *   4) 구매 링크 관문(Fmt.buyUrl) — URL 형식 × CTA 가 서버(test-affiliate-integrity)와 같은 판정
 *   5) 가격 모달이 옵션(vendorItemId)으로 이력을 부른다
 *
 * 네트워크 0회 (fetch 는 기록만 한다).
 */
const { loadApp, FakeEl, elFromHtml } = require('./_fake-dom');

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail === undefined ? '' : '  — ' + JSON.stringify(detail).slice(0, 300)}`); }
}
function section(t) { console.log(`\n[${t}]`); }

const LPTAG = 'AF8789251';
const aff = (pid, vid) => `https://link.coupang.com/re/AFFSDP?lptag=${LPTAG}&pageKey=${pid}&itemId=8${vid}&vendorItemId=${vid}`;
const qs = u => new URL(u, 'https://seosa.ai.kr').searchParams;
const affPings = t => t.pings.filter(p => p.indexOf('/api/stats?') === 0 && qs(p).get('event') === 'affiliate_click');

/** 상품 목록 렌더러가 하는 그대로: 공유 캐시에 넣고, 실제 Card.html 의 속성으로 카드 요소를 만든다. */
function renderCard(t, it, grid) {
  const { app } = t;
  app.AppState.products[app.productKey(it.title, it.mall, it.productId, it.vendorItemId)] = it;
  const html = app.Card.html(it);
  const card = elFromHtml(html);
  card.appendChild(new FakeEl('div', { className: 'p-title', textContent: it.title }));
  card.appendChild(new FakeEl('div', { className: 'price', textContent: app.Fmt.won(it.lprice) + '원' }));
  const buy = new FakeEl('button');
  buy.setAttribute('data-act', 'card-buy');
  card.appendChild(buy);
  if (grid) grid.appendChild(card);
  return { card, buy, html };
}
function fresh() {
  const t = loadApp();
  const grid = t.register(new FakeEl('div'), { id: 'resGrid' });
  const home = t.register(new FakeEl('div'), { id: 'recGrid' });
  return Object.assign(t, { grid, home });
}

/* ══════════════════════════════════════════════════════════════════ */
section('1) 검색 결과: 히어로 캐러셀 접기 (Search.run / goHome 실행)');
{
  const t = fresh();
  const band = t.register(new FakeEl('div', { className: 'hero-band' }), { sel: '.hero-band' });
  const hero = t.register(new FakeEl('section', { className: 'hero' }), { sel: '.hero' });
  t.register(new FakeEl('section'), { id: 'results' });
  t.register(new FakeEl('input'), { id: 'q' });
  t.register(new FakeEl('div'), { id: 'banner' });
  t.app.Search.run('에어팟 프로 2');
  ok(band.style.display === 'none', '★ Search.run 이 .hero-band 를 접는다', band.style);
  ok(hero.style.display === 'none', '(기존) .hero 도 접힌다');
  t.app.Search.goHome();
  ok(band.style.display === '', '★ goHome 이 .hero-band 를 되돌린다', band.style);
  // 뒤로/앞으로 — 캐시된 결과를 그리는 경로도 접힌 상태여야 한다
  t.app.Search.cache[t.app.Search.cacheKey('에어팟 프로 2')] = { items: [], meta: {}, at: Date.now() };
  t.app.Search.run('에어팟 프로 2', { fromUrl: true });
  ok(band.style.display === 'none', '★ 뒤로/앞으로(캐시 결과) 경로도 접힌다', band.style);
}

/* ══════════════════════════════════════════════════════════════════ */
section('2) 구매 CTA — 실제 클릭 위임으로 누른다');
const A = { title: '미스터빈 크라프트 드립백 봉투', lprice: 2500, mall: '쿠팡', productId: '344928021', vendorItemId: '5615510064', link: aff('344928021', '5615510064'), image: '' };
const B = { title: '미스터빈 크라프트 드립백 봉투', lprice: 42000, mall: '쿠팡', productId: '344928021', vendorItemId: '5615510099', link: aff('344928021', '5615510099'), image: '' };
{
  const t = fresh();
  const { buy } = renderCard(t, A, t.grid);
  t.click(buy);
  ok(t.opened.length === 1 && t.opened[0] === A.link, '★ 검색 카드 구매: 외부 이동 1회, 링크 원문 그대로', t.opened);
  const p = affPings(t);
  ok(p.length === 1, '★ affiliate_click 정확히 1회', p);
  const q = qs(p[0] || '');
  ok(q.get('src') === 'search' && q.get('mall') === '쿠팡' && q.get('pid') === A.productId && q.get('price') === '2500' && /^v[a-z0-9]+$/.test(q.get('vid') || ''),
    '★ src=search · mall · pid · price · vid', p[0]);
  ok(!/title|link|http/i.test(p[0] || ''), '상품명·URL 은 보내지 않는다 (최소 수집)', p[0]);
}
{
  const t = fresh();
  const { buy } = renderCard(t, A, t.home);
  t.click(buy);
  ok(qs(affPings(t)[0] || '').get('src') === 'home' && t.opened.length === 1, '홈 카드 구매: src=home', affPings(t));
}
{
  const t = fresh();
  t.ctx.fetch = () => { throw new Error('stats down'); };
  const { buy } = renderCard(t, A, t.grid);
  t.click(buy);
  ok(t.opened.length === 1 && t.opened[0] === A.link, '★ 계측이 터져도 이동은 막히지 않는다', t.opened);
}
{
  const t = fresh();
  const { card } = renderCard(t, A, t.grid);
  t.app.Modal.open(t.app.Card.read(card));
  const hist = t.pings.find(p => p.indexOf('/api/history?') === 0) || '';
  ok(qs(hist).get('vendorItemId') === A.vendorItemId, '★ 가격 모달이 옵션(vendorItemId)으로 이력을 부른다', hist);
  const btn = new FakeEl('button'); btn.setAttribute('data-act', 'modal-buy');
  t.click(btn);
  ok(t.opened.length === 1 && t.opened[0] === A.link && qs(affPings(t)[0] || '').get('src') === 'product', '★ 가격 모달 구매: 이동 1회 · src=product', { opened: t.opened, pings: affPings(t) });
}
{
  const t = fresh();
  const it = Object.assign({}, A, { currentPrice: 2500 });
  t.app.AppState.products[t.app.productKey(it.title, it.mall, it.productId, it.vendorItemId)] = it;
  const row = elFromHtml(t.app.Drop.rowHTML(it, 0));
  const btn = new FakeEl('button'); btn.setAttribute('data-act', 'ledger-buy'); row.appendChild(btn);
  t.click(btn);
  ok(t.opened.length === 1 && t.opened[0] === A.link && qs(affPings(t)[0] || '').get('src') === 'hotdeal', '★ 핫딜 구매: 이동 1회 · src=hotdeal', { opened: t.opened, pings: affPings(t) });
}
{
  const t = fresh();
  const mini = elFromHtml(t.app.Chat.miniCard(A));
  t.click(mini);
  const q = qs(affPings(t)[0] || '');
  ok(t.opened.length === 1 && t.opened[0] === A.link && q.get('src') === 'ai' && q.get('pid') === A.productId && q.get('price') === '2500',
    '★ AI 카드 구매: 이동 1회 · src=ai · pid · price', { opened: t.opened, pings: affPings(t) });
}
{
  const t = fresh();
  const card = t.app.ExternalHot.cardHTML({ title: '외부 핫딜', sourceUrl: 'https://community.example/p/1', affiliateUrl: A.link, monetized: true, price: 2500, productId: A.productId, affiliateMall: '쿠팡', verified: true });
  const m = card.match(/<a href="([^"]+)"[^>]*data-aff-track="hotdeal"[^>]*>제휴 상품 보기<\/a>/);
  ok(!!m, '외부 핫딜 «제휴 상품 보기» 앵커가 계측 표시를 단다', card.slice(0, 200));
  const a = elFromHtml(m ? m[0] : '<a>');
  t.click(a);
  ok(affPings(t).length === 1 && qs(affPings(t)[0]).get('src') === 'hotdeal', '★ 외부 핫딜 앵커: affiliate_click 1회 (이동은 앵커가 한다)', affPings(t));
}

/* ══════════════════════════════════════════════════════════════════ */
section('3) 옵션 A/B 공유 캐시 — 가격·옵션·링크가 한 옵션 (Codex 재현)');
for (const order of [['A', 'B'], ['B', 'A']]) {
  const t = fresh();
  const cards = {};
  order.forEach(k => { cards[k] = renderCard(t, k === 'A' ? A : B, t.grid); });
  for (const k of ['A', 'B']) {
    const it = k === 'A' ? A : B;
    const before = t.opened.length, beforeP = affPings(t).length;
    const info = t.app.Card.read(cards[k].card);
    t.click(cards[k].buy);
    const url = t.opened[before] || '';
    ok(info.lprice === it.lprice && info.vendorItemId === it.vendorItemId && qs(url).get('vendorItemId') === it.vendorItemId,
      `★ 렌더 순서 ${order.join('→')} 후 ${k} 카드 구매: 가격 ${it.lprice} · 옵션 ${it.vendorItemId} · 링크 옵션 ${qs(url).get('vendorItemId')}`,
      { info: { lprice: info.lprice, vid: info.vendorItemId }, url });
    ok(qs(affPings(t)[beforeP] || '').get('price') === String(it.lprice), `  ${k}: 계측 가격도 그 옵션 가격`, affPings(t)[beforeP]);
  }
}
{
  // 서버가 옵션이 다른 링크를 실어 보내도(가격 A, 링크 B) 이동하지 않는다 — 마지막 방어선.
  const t = fresh();
  const bad = Object.assign({}, A, { link: B.link });
  const { buy, html } = renderCard(t, bad, t.grid);
  ok(!/data-act="card-buy"/.test(html), '★ 링크 옵션이 카드 옵션과 다르면 구매 버튼을 그리지 않는다');
  t.click(buy);
  ok(t.opened.length === 0 && affPings(t).length === 0 && t.toasts.some(x => /구매 링크가 없는/.test(x)), '★ 눌려도 이동·계측 없이 «링크 없음»', { opened: t.opened, toasts: t.toasts });
}

/* ══════════════════════════════════════════════════════════════════ */
section('4) 구매 링크 관문 — URL 형식 × CTA (서버와 같은 판정)');
const FORMS = [
  ['SEOSA AFFSDP', aff('7001', '90001'), true],
  ['파트너스 단축 /a/', 'https://link.coupang.com/a/hb5vuuKbV6', true],
  ['ADPICK commissionlink', 'https://biz.adpick.co.kr/r4268331', true],
  ['다른 파트너 lptag', 'https://link.coupang.com/re/AFFSDP?lptag=AF1234567&pageKey=7001&vendorItemId=90001', false],
  ['lptag 없음', 'https://link.coupang.com/re/AFFSDP?pageKey=7001&vendorItemId=90001', false],
  ['/re/PCS 가격비교', 'https://link.coupang.com/re/PCSNAVERPCSDP?pageKey=1&lptag=l000000000000', false],
  ['/re/UNKNOWN', `https://link.coupang.com/re/UNKNOWN?lptag=${LPTAG}&pageKey=7001`, false],
  ['쿠팡 상품 원본 URL', 'https://www.coupang.com/vp/products/7001?vendorItemId=90001', false]
];
for (const [name, url, allow] of FORMS) {
  const it = { title: '상품 ' + name, lprice: 9900, mall: url.indexOf('adpick') > -1 ? 'ADPICK' : '쿠팡', productId: '7001', vendorItemId: url.indexOf('adpick') > -1 ? '' : '90001', link: url, image: '' };
  const results = {};
  // 검색 카드
  {
    const t = fresh(); const { buy, html } = renderCard(t, it, t.grid); t.click(buy);
    results.card = { nav: t.opened[0] === url, shown: /data-act="card-buy"/.test(html) };
  }
  // 가격 모달
  {
    const t = fresh(); const { card } = renderCard(t, it, t.grid); t.app.Modal.open(t.app.Card.read(card));
    const b = new FakeEl('button'); b.setAttribute('data-act', 'modal-buy'); t.click(b);
    results.modal = { nav: t.opened[0] === url };
  }
  // 핫딜 행
  {
    const t = fresh(); t.app.AppState.products[t.app.productKey(it.title, it.mall, it.productId, it.vendorItemId)] = it;
    const html = t.app.Drop.rowHTML(it, 0); const row = elFromHtml(html);
    const b = new FakeEl('button'); b.setAttribute('data-act', 'ledger-buy'); row.appendChild(b); t.click(b);
    results.hotdeal = { nav: t.opened[0] === url, shown: /data-act="ledger-buy"/.test(html) };
  }
  // AI 카드 — 렌더 시 걸러진 링크 + 누를 때 한 번 더
  {
    const t = fresh(); const mini = elFromHtml(t.app.Chat.miniCard(it)); t.click(mini);
    const raw = new FakeEl('div'); raw.setAttribute('data-act', 'mini-go'); raw.setAttribute('data-link', url); raw.setAttribute('data-vid', it.vendorItemId); t.click(raw);
    results.ai = { nav: t.opened.length > 0 && t.opened.every(u => u === url), count: t.opened.length };
  }
  // 찜 · 비교 · 외부 핫딜 앵커 — href 를 그리는가
  {
    const t = fresh();
    results.wish = { shown: new RegExp('href="' + url.replace(/[.?*+^$()[\]{}|\\]/g, '\\$&').replace(/&/g, '&amp;')).test(t.app.Wish.itemHTML(it, 0)) };
    results.external = { shown: /제휴 상품 보기/.test(t.app.ExternalHot.cardHTML({ title: 'x', sourceUrl: 'https://community.example/1', affiliateUrl: url, monetized: true, price: 1 })) };
    results.compareGate = { shown: !!t.app.Fmt.buyUrl(url, it) };
  }
  const want = allow;
  const bad = Object.entries(results).filter(([, r]) => {
    if ('nav' in r && r.nav !== want) return true;
    if ('shown' in r && r.shown !== want) return true;
    return false;
  });
  ok(!bad.length, `★ ${allow ? '통과' : '차단'} — ${name} (검색·모달·핫딜·AI·찜·외부핫딜·비교)`, bad);
}
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  ok(/class="cmp-go" href="' \+ Fmt\.esc\(Fmt\.buyUrl\(it\.link, it\)\)/.test(src), '(보조) 비교 패널 «구매» 앵커도 같은 관문을 쓴다');
  ok(/var url  = book \? Fmt\.buyUrl\(book\.coupangUrl\) : '';/.test(src), '(보조) 히어로 책등 링크도 같은 관문을 쓴다');
}

console.log(`\n${'='.repeat(58)}`);
console.log(`PASS ${pass} / FAIL ${fail}`);
if (fail) { console.log('\n실패한 항목:'); failures.forEach(f => console.log(`  · ${f}`)); process.exit(1); }
console.log('구매 흐름 계약 이상 없음.');
