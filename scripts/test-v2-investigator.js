#!/usr/bin/env node
'use strict';
/*
 * ③ AI 쇼핑 조사관 — 완전 오프라인.
 *
 * 여기서 고정하는 것
 *   1) 자연어 조건을 이해한다 (예산 · 제외 · 사양 요구 · 원하는 기능)
 *   2) 조건을 어긴 상품은 후보에 들어가지 않고, 제외 사유가 남는다
 *   3) 사양은 상품명에 적힌 것만 — 없는 기능을 «없다» 고 단정하지 않는다
 *   4) 가격은 원장으로 검증한다 (오래됐거나 카탈로그와 다르면 verified=false)
 *   5) 요약의 모든 숫자는 데이터 안에 있다 (grounded)
 *   6) 사양 파싱 회귀: 1.19kg → 19kg · "그램 17" → 램 17GB 같은 오독이 다시 생기지 않는다
 *   7) 외부 호출 0회 · 쓰기 0회 · 실시간 검색은 기본 꺼짐
 */

const kit = require('./_v2-testkit');
const { db, state, T, mkReq, mkRes, fetchCalls } = kit.setup('test-v2-investigator');

const INV = require('../api/_investigator');
const api = require('../api/_investigator-api');
const shop = require('../api/_shop');
const specs = require('../api/_specs');

const now = new Date().toISOString();
const old = new Date(Date.now() - 40 * 86400000).toISOString();
let pid = 1000;
const products = [];
const history = [];
function product(title, price, o) {
  const opt = o || {};
  const id = String(++pid);
  const vid = String(pid * 10);
  products.push({ product_id: id, mall: opt.mall || '쿠팡', mall_label: opt.mallLabel || '쿠팡', vendor_item_id: vid,
    title, lprice: opt.catalogPrice || price, oprice: 0, image: 'https://img.example/' + id + '.jpg',
    link: 'https://link.coupang.com/a?vendorItemId=' + vid, keyword: opt.keyword || '노트북',
    collected_at: opt.stale ? old : now });
  const prices = opt.prices || Array.from({ length: 30 }, (_, i) => (i === 29 ? price : price + ((i % 5) - 2) * 1000));
  history.push(...kit.historyRows({ productId: id, vendorItemId: vid, prices, startId: pid * 100, endDaysAgo: opt.endDaysAgo || 0 }));
  return id;
}

async function ask(question, extra) {
  const res = mkRes();
  await api.handler(mkReq({ method: 'POST', body: Object.assign({ question }, extra || {}),
    headers: { origin: 'https://seosa.ai.kr' } }), res);
  return res;
}

async function main() {
  /* ── 1. 사양 파싱 회귀 (_specs) ────────────────────────────── */
  T.section('사양 파싱 회귀 — 틀린 사양을 만들지 않는다');
  [
    ['LG 그램 17 17Z90S 램 32GB', 'ram_gb', 32],
    ['LG전자 그램 1.19kg', 'weight_g', 1190],
    ['삼성 갤럭시북4 프로 14인치 1.23kg', 'weight_g', 1230],
    ['맥북 에어 13 M3 8GB 256GB 1.24kg', 'weight_g', 1240],
    ['1.75L 전기포트', 'capacity_ml', 1750],
    ['20L 쓰레기통', 'capacity_ml', 20000],
    ['12.34cm 필름', 'length_cm', 12.34],
    ['노트북 1.5kg', 'weight_g', 1500],
    ['텀블러 0.5L', 'capacity_ml', 500],
    ['램 16GB SSD 512GB', 'ram_gb', 16],
    ['16GB 램 노트북', 'ram_gb', 16],
    ['13.3인치 노트북', 'size_inch', 13.3]
  ].forEach(([title, key, want]) => {
    const got = specs.extractSpecs(title).specs[key];
    T.check(got === want, `${title} → ${key} ${want}`, got);
  });
  T.check(specs.extractSpecs('LG 그램 16 노트북').specs.ram_gb === undefined, '"그램 16" 의 16 을 램으로 읽지 않는다');

  /* ── 2. 질문 이해 ─────────────────────────────────────────── */
  T.section('질문 이해');
  {
    const p = INV.parseQuestion('150만원 이하 1.5kg 이하 노트북 램 16GB 이상, 삼성 제외하고 비교해줘');
    T.check(p.constraints.budgetMax === 1500000, '예산 150만원', p.constraints.budgetMax);
    T.check(p.searchTokens.join() === '노트북' && p.category === '노트북', '찾을 상품 = 노트북', p.searchTokens);
    T.check(p.exclusions.indexOf('삼성') > -1, '삼성 제외', p.exclusions);
    const w = p.specRules.find(r => r.key === 'weight_g');
    const r = p.specRules.find(r => r.key === 'ram_gb');
    T.check(w && w.op === 'max' && w.value === 1500, '무게 1.5kg 이하 → max 1500g', w);
    T.check(r && r.op === 'min' && r.value === 16 && r.assumed === false, '램 16GB 이상 → min 16 (문맥 있음)', r);
    const g = INV.parseQuestion('512GB 이상 노트북').specRules[0];
    T.check(g.key === 'storage_gb' && g.assumed === true, '문맥 없는 GB 는 크기로 추정하고 추정임을 표시', g);
    const f = INV.parseQuestion('10만원대 노이즈캔슬링 무선 이어폰 알아봐줘');
    T.check(f.wantedFeatures.indexOf('노이즈캔슬링') > -1 && f.constraints.budgetMin === 100000, '원하는 기능 · 가격대', f.wantedFeatures);
    T.check(INV.parseQuestion('ㅁ') === null && INV.parseQuestion('') === null, '너무 짧으면 null');
    T.check(INV.parseQuestion('캠핑용 20L 쿨러 조사해줘').specRules[0].op === 'eq', '«20L 쿨러» 는 정확히 20L 요구');
  }

  /* ── 3. 조사 — 조건 · 제외 · 검증 ─────────────────────────── */
  T.section('조사 — 조건을 어긴 상품은 후보가 아니다');
  const light = product('LG전자 2025 그램 14 14Z90T 인텔 울트라5 램 16GB 1.19kg 화이트', 1290000);
  const heavy = product('에이수스 게이밍 노트북 TUF 램 16GB 2.3kg', 1190000);
  const samsung = product('삼성전자 갤럭시북4 램 16GB 1.23kg 노트북', 990000);
  const expensive = product('애플 맥북 프로 14 램 16GB 1.55kg 노트북', 2390000);
  const lowRam = product('레노버 아이디어패드 슬림 램 8GB 1.3kg 노트북', 690000);
  const noWeight = product('HP 파빌리온 램 16GB 노트북 15인치', 850000);
  const accessory = product('노트북 파우치 14인치 케이스', 19000);
  const stale = product('델 인스피론 램 16GB 1.4kg 노트북', 900000, { stale: true, endDaysAgo: 40 });
  const mismatch = product('기가바이트 에어로 램 16GB 1.45kg 노트북', 1400000, { catalogPrice: 1350000 });
  product('무선 이어폰 노이즈캔슬링 블루투스', 89000, { keyword: '이어폰' });
  db.products = products;
  db.price_history = history;

  const q1 = '150만원 이하 1.5kg 이하 노트북 램 16GB 이상, 삼성 제외하고 비교해줘';
  const r1 = await ask(q1);
  const b = r1.body || {};
  const ids = (b.candidates || []).map(c => c.productId);
  T.check(r1.statusCode === 200 && b.ok, '200', b.error);
  T.check(ids.indexOf(light) > -1, '조건을 모두 만족하는 상품은 후보', ids);
  const why = id => ((b.excluded || []).find(e => e.productId === id) || {}).reason || '';
  T.check(ids.indexOf(heavy) === -1 && /무게/.test(why(heavy)), '2.3kg → 무게 조건 위반으로 제외', why(heavy));
  T.check(ids.indexOf(samsung) === -1 && /삼성/.test(why(samsung)), '삼성 → 제외 요청', why(samsung));
  T.check(ids.indexOf(expensive) === -1 && /예산/.test(why(expensive)), '239만원 → 예산 초과', why(expensive));
  T.check(ids.indexOf(lowRam) === -1 && /램/.test(why(lowRam)), '램 8GB → 램 조건 미달', why(lowRam));
  T.check(ids.indexOf(accessory) === -1 && /부속품/.test(why(accessory)), '노트북 파우치 → 부속품 제외', why(accessory));
  T.check(ids.indexOf(stale) === -1 && /최근 가격 확인/.test(why(stale)), '40일 전 확인 → 판매 여부 불명으로 제외', why(stale));
  T.check((b.candidates || []).every(c => c.fits && !c.violations.length), '후보는 전부 조건을 만족한다');

  const nw = (b.candidates || []).find(c => c.productId === noWeight);
  T.check(nw && nw.cons.some(x => /무게: 상품명에 표기가 없어/.test(x.text)),
    '무게 표기가 없는 상품은 탈락이 아니라 «확인 못 함» 으로 남는다', nw && nw.cons);

  const lc = (b.candidates || []).find(c => c.productId === light);
  T.check(lc && lc.specs.verified.weight_g && lc.specs.verified.weight_g.text === '1.19kg' && lc.specs.verified.weight_g.value === 1190,
    '사양 값과 근거 글자 (1.19kg)', lc && lc.specs.verified);
  T.check(lc && lc.pros.some(p => /가장 가벼워요 \(1\.19kg\)/.test(p.text) && p.basis === 'title'), '장점: 비교 중 가장 가벼움 — 근거 title', lc && lc.pros);
  T.check(lc && lc.price.verified === true && lc.price.source === 'price_history', '카탈로그와 원장이 같고 오늘 기록 → 가격 검증됨', lc && lc.price);
  const mc = (b.candidates || []).find(c => c.productId === mismatch);
  T.check(mc && mc.price.verified === false && mc.price.value === 1400000 && mc.cons.some(x => /확인하지 못했어요/.test(x.text)),
    '카탈로그(135만)와 원장(140만)이 다르면 원장 값을 쓰고 미검증으로 밝힌다', mc && mc.price);

  T.check(b.summary && b.summary.grounded && b.summary.grounded.ok === true && !b.summary.grounded.replaced,
    '요약의 숫자는 전부 데이터 안에 있다', b.summary);
  T.check(/SEOSA 가격 기록이 있는 상품 \d+개를 살펴/.test(b.summary.text), '요약에 조사 범위가 있다', b.summary.text);
  T.check(b.coverage.source === 'catalog', '기본은 카탈로그만 조사');
  T.check(b.candidates.every(c => c.pros.concat(c.cons).every(x => ['comparison', 'title', 'price_history', 'deal_engine'].indexOf(x.basis) > -1)),
    '모든 장단점에 근거 종류가 붙는다');

  /* ── 4. 기능 — 확인 안 됨 ≠ 없음 ─────────────────────────── */
  T.section('기능 — 확인 안 됨은 없음이 아니다');
  {
    db.products = products.concat([
      { product_id: '9001', mall: '쿠팡', mall_label: '쿠팡', vendor_item_id: '90010', title: '소니 무선 이어폰 WF-1000XM5 노이즈캔슬링',
        lprice: 259000, image: '', link: 'https://link.coupang.com/b', keyword: '이어폰', collected_at: now },
      { product_id: '9002', mall: '쿠팡', mall_label: '쿠팡', vendor_item_id: '90020', title: 'QCY 무선 이어폰 T13',
        lprice: 19900, image: '', link: 'https://link.coupang.com/c', keyword: '이어폰', collected_at: now }
    ]);
    db.price_history = history.concat(
      kit.historyRows({ productId: '9001', vendorItemId: '90010', prices: [259000, 259000, 259000], startId: 70000 }),
      kit.historyRows({ productId: '9002', vendorItemId: '90020', prices: [19900, 19900, 19900], startId: 71000 }));
    const r = await ask('노이즈캔슬링 무선 이어폰 비교해줘');
    const cs = r.body.candidates || [];
    const sony = cs.find(c => c.productId === '9001');
    const qcy = cs.find(c => c.productId === '9002');
    T.check(sony && sony.specs.matchedFeatures.indexOf('노이즈캔슬링') > -1, '제목에 있는 기능 → 확인됨');
    T.check(qcy && qcy.specs.unverifiedFeatures.indexOf('노이즈캔슬링') > -1
      && qcy.cons.some(x => /확인되지 않았어요 \(없다는 뜻은 아니에요\)/.test(x.text)), '제목에 없는 기능 → «확인 안 됨», 없다고 하지 않는다');
    const hits = cs.map(c => c.specs.matchedFeatures.length);
    T.check(hits.length >= 3 && hits.every((h, i) => i === 0 || hits[i - 1] >= h) && cs[cs.length - 1].productId === '9002',
      '요청 기능이 더 많이 확인된 상품이 앞에 온다 (같으면 Concierge 순서)', cs.map(c => [c.productId, c.specs.matchedFeatures.length]));
    T.check(qcy && qcy.cons.some(x => /판단하기 일러요/.test(x.text)), '기록 3일 → 싼지 비싼지 판단하기 이르다고 말한다');
  }

  /* ── 5. 없음 · 입력 오류 ─────────────────────────────────── */
  T.section('못 찾음 · 입력 오류');
  {
    const r = await ask('10만원 이하 로봇청소기 알아봐줘');
    T.check(r.statusCode === 200 && r.body.candidates.length === 0 && /찾지 못했어요/.test(r.body.summary.text)
      && r.body.summary.grounded.ok, '없으면 없다고 말한다 (지어내지 않는다)', r.body.summary);
    const e1 = await ask('');
    T.check(e1.statusCode === 400 && e1.body.code === 'BAD_INPUT', '빈 질문 → 400');
    const e2 = await ask('추천해줘');
    T.check(e2.statusCode === 400 && /상품 종류/.test(e2.body.error), '무엇을 찾는지 모르면 400', e2.body);
    const g = mkRes();
    await api.handler(mkReq({ method: 'GET' }), g);
    T.check(g.statusCode === 405, 'GET → 405');
    const cors = await ask('노트북', {});
    T.check(cors.headers['access-control-allow-origin'] === 'https://seosa.ai.kr' && /no-store/.test(cors.headers['cache-control']),
      'private CORS(허용 오리진) · no-store');
    const evil = mkRes();
    await api.handler(mkReq({ method: 'POST', body: { question: '노트북' }, headers: { origin: 'https://evil.example' } }), evil);
    T.check(evil.headers['access-control-allow-origin'] === undefined, '허용 밖 오리진에는 CORS 헤더가 없다');
    const lim = await ask('노트북 비교', { limit: 2 });
    T.check(lim.body.candidates.length <= 2, 'limit 을 지킨다');
  }

  /* ── 6. 근거 검사 · 결정론 ───────────────────────────────── */
  T.section('근거 검사 · 결정론');
  {
    const ev = new Set(['1290000', '1.19']);
    T.check(INV.groundCheck('1,290,000원이고 1.19kg', ev).ok, '근거 안의 숫자는 통과');
    const bad = INV.groundCheck('1,290,000원인데 지금 20% 할인', ev);
    T.check(!bad.ok && bad.unmatched.indexOf('20') > -1, '근거 밖의 숫자(20%)를 잡는다', bad);
    T.check(INV.cutTitle('LG전자 2025 그램 14 14Z90T 인텔 울트라5 램 16GB 1.19kg', 34).indexOf('램 1…') === -1
      && /…$/.test(INV.cutTitle('LG전자 2025 그램 14 14Z90T 인텔 울트라5 램 16GB 1.19kg', 34)),
      '상품명을 숫자 한가운데서 자르지 않는다 («램 16GB» → «램 1…» 금지)');
    db.products = products; db.price_history = history;
    const a = await ask(q1); const c = await ask(q1);
    delete a.body.asOf; delete c.body.asOf;
    T.check(JSON.stringify(a.body) === JSON.stringify(c.body), '같은 질문 → 같은 보고서');
  }

  /* ── 7. Concierge 경로 · 원장 페이지 · 실시간 검색 ───────── */
  T.section('AI Concierge 경로 · 페이지 · 실시간 검색 꺼짐');
  {
    const ai = require('../api/ai');
    const res = mkRes();
    await ai(mkReq({ method: 'POST', query: { __route: 'investigate' }, body: { question: q1 }, headers: { origin: 'https://seosa.ai.kr' } }), res);
    T.check(res.body && res.body.ok && res.body.candidates.length > 0, '/api/ai?__route=investigate (Concierge 함수) 로도 같은 답');

    // 한 상품에 1,000행이 넘는 기록 — 페이지를 넘겨 읽어야 최저가가 맞는다
    const many = [];
    for (let d = 0; d < 20; d++) {
      for (let k = 0; k < 60; k++) {
        const date = kit.daysAgo(19 - d);
        many.push({ id: 500000 + d * 100 + k, product_id: '7777', mall: '쿠팡', vendor_item_id: '77770',
          price: k === 59 ? 50000 - d : 60000 + k, recorded_date: date, recorded_at: kit.noonKst(date) });
      }
    }
    db.price_history = many;
    const pts = await api._internal.loadPoints([{ product_id: '7777', mall: '쿠팡', vendor_item_id: '77770' }]);
    const line = pts.get('7777|쿠팡|77770');
    T.check(many.length > 1000 && line.length === 20 && line.every((p, i) => p.price === 50000 - i),
      `1,200행을 페이지로 끝까지 읽어 날짜별 최저가를 맞춘다`, line && line.slice(0, 3));
    db.price_history = history;

    let called = 0;
    const saved = shop.searchAll;
    shop.searchAll = async () => { called++; return { items: [] }; };
    await ask('10만원 이하 로봇청소기 알아봐줘');
    T.check(called === 0, 'INVESTIGATOR_LIVE_SEARCH 가 없으면 실시간 검색(쿠팡)을 부르지 않는다');
    process.env.INVESTIGATOR_LIVE_SEARCH = '1';
    await ask('10만원 이하 로봇청소기 알아봐줘');
    T.check(called === 1, '켜면 카탈로그에서 못 찾았을 때만 기존 검색 경로를 한 번 탄다');
    delete process.env.INVESTIGATOR_LIVE_SEARCH;
    shop.searchAll = saved;

    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'v2', 'investigator.html'), 'utf8');
    T.check(/V2\.esc/.test(html) && !/innerHTML\s*=\s*[^;]*\+\s*(it|c|r)\.title/.test(html), '화면은 상품명을 escape 해서 그린다');
  }

  T.section('안전');
  T.check(state.writes.length === 0, '어떤 표에도 쓰지 않았다', state.writes.map(w => w.table));
  T.check(fetchCalls.length === 0, '외부 호출 0회', fetchCalls);

  T.done();
}

main().catch(e => { console.error(e); process.exitCode = 1; });
