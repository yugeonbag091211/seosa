/*
 * AI 핫딜 읽기 도구 (api/_hotdealtool.js, 2026-10-23 감사 CO-09).
 *
 * 여기서 확인하는 것:
 *   1. 예산 상한 위의 딜은 빠진다.
 *   2. 요청한 모델·옵션이 아닌 딜은 빠진다 (G304 ↔ G304 X, 본품 ↔ 케이스).
 *   3. 앞 대화에서 빼 달라고 한 상태(중고)의 딜은 빠진다.
 *   4. 오래 확인하지 않은 딜은 빠진다.
 *   5. 커뮤니티 제보는 기본값에서 아예 나오지 않고, 넣어도 verified=false 와 미검증 라벨을 단다.
 *   6. 핫딜 목록을 못 읽으면 «없다» 가 아니라 unavailable 이다.
 *   7. 프롬프트 블록이 미검증 제보를 검증된 것처럼 적지 않는다.
 *   8. api/ai.js 는 기본값에서 이 도구를 부르지 않는다 (AI_HOTDEAL_TOOL=1 에서만).
 *
 * /api/hotdeals 핸들러를 가짜로 바꿔 끼운다 — DB·외부 호출 0회.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const hoursAgo = h => new Date(NOW - h * 3600000).toISOString();

/* ── 가짜 /api/hotdeals ───────────────────────────────────────────── */
let feed = [];
let failWith = null;
let lastQuery = null;
const fakeHandler = async (req, res) => {
  lastQuery = req.query;
  if (failWith) return res.status(503).json({ error: failWith });
  return res.status(200).json({ items: feed });
};
const hotdealsPath = path.resolve(__dirname, '..', 'api', 'hotdeals.js');
const realLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === './hotdeals.js' || request === hotdealsPath) return fakeHandler;
  return realLoad.apply(this, arguments);
};

const HT = require('../api/_hotdealtool');

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); return; }
  fails.push(name);
  console.log(`  [FAIL] ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 320)}`}`);
}
function section(t) { console.log(`\n── ${t}`); }

function deal(o) {
  return Object.assign({
    id: Math.random().toString(36).slice(2),
    status: 'VERIFIED_HOT', verificationStatus: 'VERIFIED_HOT',
    title: '상품', price: 100000, mall: '쿠팡',
    url: 'https://example.com/d', productUrl: 'https://example.com/d', sourceUrl: '',
    source: 'internal-history', productId: 'p1', vendorItemId: 'v1',
    checkedAt: hoursAgo(1), communityOnly: false,
    signals: { priceDropPercent: 21, referencePrice: 127000 }
  }, o);
}

(async () => {
  /* ================================================================ */
  section('A. 예산 상한');
  {
    feed = [
      deal({ title: '로지텍 G304 무선 게이밍 마우스', price: 24900, productId: 'a1' }),
      deal({ title: '로지텍 G502 X 게이밍 마우스', price: 79000, productId: 'a2' })
    ];
    const r = await HT.searchHotdeals({ budgetMax: 30000, now: NOW });
    ok(r.state === 'found' && r.verified.length === 1 && r.verified[0].price === 24900,
      '상한 위의 딜은 빠진다', r.verified.map(d => `${d.title} ${d.price}`));
    ok(r.counts.overBudget === 1, '몇 개를 예산으로 걸렀는지 센다', r.counts);

    const none = await HT.searchHotdeals({ budgetMax: 10000, now: NOW });
    ok(none.state === 'empty' && none.verified.length === 0, '상한 안에 없으면 empty (unavailable 이 아니다)', none);
  }

  /* ================================================================ */
  section('B. 모델·옵션·부속');
  {
    feed = [
      deal({ title: '로지텍 G304 X SUPERLIGHT 무선 마우스', price: 89000, productId: 'b1' }),
      deal({ title: '로지텍 G304 LIGHTSPEED 무선 마우스', price: 24900, productId: 'b2' })
    ];
    const r = await HT.searchHotdeals({ product: 'G304', userText: 'G304 핫딜 있어?', now: NOW });
    ok(r.verified.length === 1 && /G304 LIGHTSPEED/.test(r.verified[0].title),
      'G304 요청에 G304 X 는 빠진다 (형제 모델)', r.verified.map(d => d.title));

    feed = [
      deal({ title: '에어팟 프로 3 실리콘 케이스', price: 4900, productId: 'c1' }),
      deal({ title: '애플 에어팟 프로 3 본품', price: 319000, productId: 'c2' })
    ];
    const r2 = await HT.searchHotdeals({ product: '에어팟 프로 3', userText: '에어팟 프로 3 핫딜, 케이스는 제외', now: NOW });
    ok(r2.verified.length === 1 && /본품/.test(r2.verified[0].title),
      '케이스 제외 요청에 케이스가 첫 카드로 오지 않는다', r2.verified.map(d => d.title));
  }

  /* ================================================================ */
  section('C. 앞 대화에서 빼 달라고 한 상태');
  {
    feed = [
      deal({ title: '[중고] 삼성 갤럭시북3 노트북', price: 150000, productId: 'd1' }),
      deal({ title: '삼성 갤럭시북3 노트북 새상품', price: 290000, productId: 'd2' })
    ];
    const r = await HT.searchHotdeals({ product: '노트북', budgetMax: 300000, excludedConditions: ['used'], now: NOW });
    ok(r.verified.length === 1 && !/중고/.test(r.verified[0].title),
      '중고 제외가 핫딜 목록에도 걸린다', r.verified.map(d => d.title));
  }

  /* ================================================================ */
  section('D. 오래된 딜');
  {
    feed = [
      deal({ title: 'LG 그램 15 노트북', price: 980000, productId: 'e1', checkedAt: hoursAgo(40) }),
      deal({ title: '레노버 아이디어패드 노트북', price: 450000, productId: 'e2', checkedAt: hoursAgo(2) })
    ];
    const r = await HT.searchHotdeals({ now: NOW });
    ok(r.verified.length === 1 && /레노버/.test(r.verified[0].title),
      `마지막 확인이 ${HT.MAX_STALE_HOURS}시간보다 오래된 딜은 빠진다`, r.verified.map(d => `${d.title} ${d.checkedAt}`));
    ok(r.counts.stale === 1, '오래돼 뺀 수를 센다', r.counts);
  }

  /* ================================================================ */
  section('E. 커뮤니티 제보는 승격되지 않는다');
  {
    feed = [
      deal({ title: '[제보] 노트북 특가', price: 200000, productId: 'f1', communityOnly: true, verificationStatus: 'UNMATCHED', source: 'ppomppu' }),
      deal({ title: '레노버 노트북', price: 250000, productId: 'f2' })
    ];
    const base = await HT.searchHotdeals({ now: NOW });
    ok(base.verified.length === 1 && base.community.length === 0,
      '기본값에서는 커뮤니티 제보가 아예 나오지 않는다', { v: base.verified.length, c: base.community.length });
    ok(base.counts.community === 1, '몇 건이 커뮤니티였는지는 센다', base.counts);

    const withC = await HT.searchHotdeals({ includeCommunity: true, now: NOW });
    ok(withC.community.length === 1 && withC.community[0].verified === false
      && /미검증/.test(withC.community[0].label), '넣어도 verified=false 와 미검증 라벨을 단다', withC.community);
    ok(withC.verified.every(d => d.verified === true), '검증 목록에는 제보가 섞이지 않는다', withC.verified);

    const block = HT.hotdealBlock(withC);
    ok(/검증되지 않았다/.test(block) && /커뮤니티 제보·미검증/.test(block),
      '프롬프트 블록이 미검증임을 분명히 적는다', block.slice(0, 200));
    ok(/여기 없는 핫딜은 말하지 마라/.test(block), '목록 밖의 핫딜을 지어내지 못하게 못 박는다');
  }

  /* ================================================================ */
  section('F. 목록을 못 읽으면 «없다» 가 아니다');
  {
    failWith = 'db down';
    const r = await HT.searchHotdeals({ now: NOW });
    failWith = null;
    ok(r.state === 'unavailable' && r.verified.length === 0, '실패는 unavailable 이다', r);
    const block = HT.hotdealBlock(r);
    ok(/«없다» 는 뜻이 아니다/.test(block) && /지어내지 마라/.test(block),
      '확인 실패를 핫딜 없음으로 바꿔 말하지 않게 적는다', block);
  }

  /* ================================================================ */
  section('G. 핫딜을 묻는 말만 고른다');
  {
    ['핫딜 있어?', '지금 특가 뭐 있어', '세일 중인 노트북 알려줘', '30만원 이하 핫딜'].forEach(t =>
      ok(HT.asksHotdeal(t), `핫딜 질문으로 본다 — "${t}"`));
    ['노트북 추천해줘', '이 상품 할인율 알려줘', '역대 최저가야?'].forEach(t =>
      ok(!HT.asksHotdeal(t), `핫딜 질문이 아니다 — "${t}"`));
  }

  /* ================================================================ */
  section('H. api/ai.js 연결 — 기본 꺼짐');
  {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'api', 'ai.js'), 'utf8');
    ok(/process\.env\.AI_HOTDEAL_TOOL === '1'[\s\S]{0,400}HT\.asksHotdeal\(q\)/.test(src),
      '플래그가 1 일 때만, 핫딜을 묻는 말에만 부른다');
    ok(/excludedConditions: conv\.excludedBefore/.test(src), '앞 대화의 제외 상태를 넘긴다');
    ok(/budgetMax: constraints \? constraints\.budgetMax : 0/.test(src), '서버가 읽은 예산을 넘긴다');
    ok(/AI_HOTDEAL_TOOL_COMMUNITY === '1'/.test(src), '커뮤니티 제보는 별도 플래그로만 넣는다');
    ok(/핫딜 목록 블록 조립 실패\(없이 진행\)/.test(src), '실패해도 답변 경로를 멈추지 않는다');
  }

  ok(lastQuery && lastQuery.limit === '48', '/api/hotdeals 를 목록 한도와 함께 읽는다 (새 SQL 을 쓰지 않는다)', lastQuery);

  console.log(`\n=== 결과: ${pass}/${pass + fails.length} PASS ===`);
  if (fails.length) {
    console.log('\n실패:');
    fails.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
})();
