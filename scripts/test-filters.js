#!/usr/bin/env node
/*
 * 필터 / 정렬 회귀 테스트 — 쿠팡 호출 0회 / Supabase 접근 0회.
 *
 *   node scripts/test-filters.js
 *
 * 무엇을 지키는가
 *   ① 관련도가 낮은 상품이 "싸다"는 이유로 상단에 올라오지 않는다
 *   ② 신뢰도 필터가 서버 등급(trust.level)을 그대로 쓴다 — 기준을 새로 만들지 않는다
 *   ③ "가격 하락"이 "지금 싸다"와 섞이지 않는다 (_price.plausibleDrop 판정만 인정)
 *   ④ 비정상 가격이 가격 범위 계산·정렬을 오염시키지 않는다
 *   ⑤ 배송 필터가 값이 없는 상품을 "아니다"로 단정하지 않는다
 *   ⑥ 필터를 여러 개 걸어도 product_id + mall 원칙과 관련도 순서가 유지된다
 *
 * 프론트 코드(public/index.html)의 Filters / viewList 는 export 되지 않는다.
 * 규칙이 갈라지지 않도록 파일에서 그대로 읽어 평가한다
 * (scripts/test-price.js 가 history.js 의 collapseToDaily 를 다루는 방식과 같다).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { plausibleDrop, MAX_PLAUSIBLE_DROP_PCT } = require('../api/_price');

let pass = 0, fail = 0;
function check(ok, label, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail === undefined ? '' : '  — ' + JSON.stringify(detail)}`); }
}
function section(name) { console.log(`\n${name}`); }

/* ------------------------------------------------------------------ *
 *  프론트의 Filters 객체와 viewList 정렬부를 실제 파일에서 꺼내 온다
 * ------------------------------------------------------------------ */
function loadFrontend() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  const fm = src.match(/\nvar Filters = \{[\s\S]*?\n\};/);
  if (!fm) throw new Error('public/index.html 에서 var Filters 를 찾지 못했습니다');

  const vm = src.match(/ {2}viewList: function\(\) \{[\s\S]*?\n {2}\},/);
  if (!vm) throw new Error('public/index.html 에서 viewList 를 찾지 못했습니다');

  // Filters / viewList 가 기대는 최소한의 주변 환경만 만들어 준다.
  const shim = `
    var AppState = { results: [], sort: 'default', mallFilter: 'all',
      facets: { mall:'all', minPrice:null, maxPrice:null, trust:'all', drop:false, ship:'all' } };
    var Fmt = {
      esc: function(s){ return String(s == null ? '' : s); },
      won: function(n){ return (parseInt(n,10)||0).toLocaleString('ko-KR'); },
      int: function(v){ return parseInt(v,10)||0; },
      mall: function(it){ return { cls: it.mall === '쿠팡' ? 'b-coupang'
        : it.mall === '알리익스프레스' ? 'b-ali' : 'b-naver' }; }
    };
    function $(){ return null; }
    function $$(){ return []; }
    function show(){}
    function setText(){}
    function setHTML(){}
    var Search = { ${vm[0].replace(/,\s*$/, '')} };
  `;

  // eslint-disable-next-line no-new-func
  const factory = new Function(`${shim}\n${fm[0]}\nreturn { Filters: Filters, Search: Search, AppState: AppState };`);
  return factory();
}

const { Filters, Search, AppState } = loadFrontend();

/** 테스트용 상품 하나. 실제 /api/search 응답과 같은 모양이다. */
function item(o) {
  return Object.assign({
    productId: String(Math.floor(Math.random() * 1e9)),
    mall: '쿠팡',
    title: '테스트 상품',
    lprice: 10000,
    relevance: 1,
    trust: { level: 'high', score: 100 },
    isRocket: null,
    isFreeShipping: null
  }, o);
}

function run(items, facets, sort) {
  AppState.results = items;
  AppState.facets = Object.assign(
    { mall: 'all', minPrice: null, maxPrice: null, trust: 'all', drop: false, ship: 'all' }, facets || {});
  AppState.mallFilter = AppState.facets.mall;
  AppState.sort = sort || 'default';
  return Search.viewList();
}

/* ================================================================ *
 *  1. 가격 범위 필터
 * ================================================================ */
section('1. 가격 범위 필터');

const priced = [
  item({ productId: '1', title: '1만원', lprice: 10000 }),
  item({ productId: '2', title: '5만원', lprice: 50000 }),
  item({ productId: '3', title: '50만원', lprice: 500000 }),
  item({ productId: '4', title: '150만원', lprice: 1500000 })
];

check(run(priced, { maxPrice: 500000 }).length === 3, '50만원 이하 → 3건 (경계 포함)');
check(run(priced, { minPrice: 50000 }).length === 3, '5만원 이상 → 3건 (경계 포함)');
check(run(priced, { minPrice: 50000, maxPrice: 500000 }).length === 2, '5만~50만 → 2건');
check(run(priced, {}).length === 4, '범위를 안 걸면 전부');
check(run(priced, { minPrice: 0, maxPrice: 0 }).length === 0,
      'min=max=0 은 "필터 없음"이 아니라 0원 필터다 (null 과 구분)');

/* ── 비정상 가격은 계산에서 뺀다 (api/_price.parsePrice 와 같은 규칙) ── */
const weird = [
  item({ productId: 'a', title: '정상', lprice: 30000 }),
  item({ productId: 'b', title: '0원', lprice: 0 }),
  item({ productId: 'c', title: '음수', lprice: -1000 }),
  item({ productId: 'd', title: '1억 초과', lprice: 200000000 }),
  item({ productId: 'e', title: '숫자아님', lprice: null })
];
check(Filters.price(weird[0]) === 30000, '정상 가격은 그대로');
[1, 2, 3, 4].forEach(i =>
  check(Filters.price(weird[i]) === null, `비정상 가격은 null — ${weird[i].title}`, weird[i].lprice));

const wr = run(weird, { maxPrice: 100000 });
check(wr.length === 1 && wr[0].title === '정상',
      '범위를 걸면 가격을 못 읽는 상품은 빠진다 (범위 안이라고 말할 근거가 없다)',
      wr.map(x => x.title));
check(run(weird, {}).length === 5, '범위를 안 걸면 비정상 가격 상품도 목록에는 남는다');

/* ── 입력 파싱 (모바일 숫자 키패드 · 한국식 "만" 단위) ── */
check(Filters.parseInput('50000') === 50000, '"50000"');
check(Filters.parseInput('50,000') === 50000, '"50,000" (쉼표)');
check(Filters.parseInput(' 50000원 ') === 50000, '"50000원" (단위·공백)');
check(Filters.parseInput('5만') === 50000, '"5만"');
check(Filters.parseInput('1.5만') === 15000, '"1.5만"');
check(Filters.parseInput('') === null, '빈 값 → null (필터 없음)');
check(Filters.parseInput('abc') === null, '숫자가 아니면 null');
check(Filters.parseInput('-100') === null, '음수는 null');
check(Filters.parseInput('999999999999') === null, '1억 초과는 null');
check(Filters.parseInput('0') === 0, '"0" 은 0 이다 (null 이 아니다)');

/* ================================================================ *
 *  2. 신뢰도 필터 — 서버 등급을 그대로 쓴다
 * ================================================================ */
section('2. 가격 신뢰도 필터');

const trusted = [
  item({ productId: 'h', title: 'high',    trust: { level: 'high',    score: 100 } }),
  item({ productId: 'm', title: 'medium',  trust: { level: 'medium',  score: 70 } }),
  item({ productId: 'l', title: 'low',     trust: { level: 'low',     score: 40 } }),
  item({ productId: 's', title: 'stale',   trust: { level: 'stale',   score: 0 } }),
  item({ productId: 'u', title: 'unknown', trust: { level: 'unknown', score: 0 } })
];

const names = r => r.map(x => x.title).join(',');
check(names(run(trusted, { trust: 'high' })) === 'high', '신뢰 높음 → high 만');
check(names(run(trusted, { trust: 'medium' })) === 'high,medium', '보통 이상 → high + medium');
check(names(run(trusted, { trust: 'notlow' })) === 'high,medium,stale',
      '확인 필요 제외 → low / unknown 만 뺀다', names(run(trusted, { trust: 'notlow' })));
check(names(run(trusted, { trust: 'fresh' })) === 'high,medium,low,unknown',
      '오래된 가격 제외 → stale 만 뺀다', names(run(trusted, { trust: 'fresh' })));
check(run(trusted, { trust: 'all' }).length === 5, '전체 → 5건');

// 등급이 아예 없는 상품
const noTrust = [item({ productId: 'n', title: '등급없음', trust: null })];
check(Filters.level(noTrust[0]) === 'unknown', 'trust 가 없으면 unknown 으로 본다');
check(run(noTrust, { trust: 'notlow' }).length === 0, 'unknown 은 "확인 필요 제외"에서 빠진다');
check(run(noTrust, { trust: 'fresh' }).length === 1, 'unknown 은 "오래된 가격 제외"에는 남는다');

/* ================================================================ *
 *  3. 가격 하락 필터 — "지금 싸다" 와 다르다
 * ================================================================ */
section('3. 가격 하락 필터');

const dropped = [
  item({ productId: 'd1', title: '실제 하락', lprice: 50000,
         priceChange: { prevPrice: 80000, currentPrice: 50000, dropAmount: 30000, dropPct: 37.5, isAllTimeLow: false } }),
  item({ productId: 'd2', title: '그냥 싼 상품', lprice: 1000 }),
  item({ productId: 'd3', title: '하락 없음', lprice: 90000 })
];
const dr = run(dropped, { drop: true });
check(dr.length === 1 && dr[0].title === '실제 하락',
      '1,000원짜리 상품은 "가격 하락"이 아니다 — 하락 판정을 받은 상품만', dr.map(x => x.title));
check(Filters.dropped(dropped[1]) === false, '싸다고 하락으로 치지 않는다');
check(run(dropped, {}).length === 3, '하락 필터를 안 걸면 전부');

/* ── 하락 판정 자체는 _price.plausibleDrop 하나만 쓴다 (홈 시세판과 같은 기준) ── */
const base = { product_id: '123', mall: '쿠팡', link: 'https://link.coupang.com/x' };
check(plausibleDrop(Object.assign({}, base, { current_price: 50000, prev_price: 80000, drop_pct: 37.5 })) === true,
      '정상 하락은 통과');
check(plausibleDrop(Object.assign({}, base, { current_price: 18500, prev_price: 733950, drop_pct: 97.5 })) === false,
      `${MAX_PLAUSIBLE_DROP_PCT}% 이상 하락은 매칭 오류로 본다 (로보락 733,950→18,500 사례)`);
check(plausibleDrop(Object.assign({}, base, { current_price: 90000, prev_price: 80000, drop_pct: 0 })) === false,
      '올랐으면 하락이 아니다');
check(plausibleDrop(Object.assign({}, base, { mall: '네이버', current_price: 5, prev_price: 10, drop_pct: 50 })) === false,
      '더 이상 수집되지 않는 몰은 하락으로 치지 않는다');
check(plausibleDrop(Object.assign({}, base, { link: '', current_price: 5000, prev_price: 9000, drop_pct: 44 })) === false,
      '링크가 없으면 클릭해도 갈 곳이 없다 → 제외');
check(plausibleDrop(Object.assign({}, base, { product_id: '미스터빈 드립백', current_price: 5000, prev_price: 9000, drop_pct: 44 })) === false,
      'product_id 자리에 상품명이 든 옛 이관분은 제외');

/* ================================================================ *
 *  4. 배송 필터 — 없는 정보로 거르지 않는다
 * ================================================================ */
section('4. 배송 필터');

const ship = [
  item({ productId: 'r', title: '로켓', isRocket: true, isFreeShipping: false }),
  item({ productId: 'f', title: '무료배송', isRocket: false, isFreeShipping: true }),
  item({ productId: 'x', title: '정보없음', isRocket: null, isFreeShipping: null })
];
check(names(run(ship, { ship: 'rocket' })) === '로켓', '로켓배송 → true 인 것만');
check(names(run(ship, { ship: 'free' })) === '무료배송', '무료배송 → true 인 것만');
check(run(ship, { ship: 'rocket' }).every(x => x.title !== '정보없음'),
      '값이 null 인 상품을 "로켓 아님"으로 단정하지 않는다 (필터를 걸면 빠진다)');
check(run(ship, {}).length === 3, '배송 필터를 안 걸면 정보 없는 상품도 그대로 보인다');

AppState.results = ship;
check(Filters.hasShipData() === true, '배송 값이 하나라도 있으면 필터 줄을 띄운다');
AppState.results = [item({ productId: 'z', isRocket: null, isFreeShipping: null })];
check(Filters.hasShipData() === false, '전부 정보 없음이면 필터 줄 자체를 띄우지 않는다');

/* ================================================================ *
 *  5. 정렬
 * ================================================================ */
section('5. 정렬');

const mixed = [
  item({ productId: 's1', title: '관련도낮음-최저가', lprice: 5000,  relevance: 0.35, trust: { level: 'high', score: 100 } }),
  item({ productId: 's2', title: '딱맞음-비쌈',       lprice: 90000, relevance: 1.00, trust: { level: 'high', score: 100 } }),
  item({ productId: 's3', title: '중간-중간가',       lprice: 40000, relevance: 0.70, trust: { level: 'medium', score: 70 } })
];

// 기본(관련도순) = 서버가 준 순서 그대로. 다시 세우지 않는다.
check(names(run(mixed, {}, 'default')) === '관련도낮음-최저가,딱맞음-비쌈,중간-중간가',
      '기본 정렬은 서버 순서를 건드리지 않는다 (서버가 관련도→신뢰도→가격으로 이미 세웠다)',
      names(run(mixed, {}, 'default')));

check(names(run(mixed, {}, 'lowprice')) === '관련도낮음-최저가,중간-중간가,딱맞음-비쌈', '최저가순');
check(names(run(mixed, {}, 'highprice')) === '딱맞음-비쌈,중간-중간가,관련도낮음-최저가', '최고가순');
check(run(mixed, {}, 'trust')[2].title === '중간-중간가', '신뢰도순 — 낮은 등급이 뒤로');

// 동점이면 관련도가 순서를 정한다
const tie = [
  item({ productId: 't1', title: '관련도낮음', lprice: 10000, relevance: 0.4 }),
  item({ productId: 't2', title: '관련도높음', lprice: 10000, relevance: 0.95 })
];
check(names(run(tie, {}, 'lowprice')) === '관련도높음,관련도낮음',
      '가격이 같으면 관련도가 높은 쪽이 위', names(run(tie, {}, 'lowprice')));
check(names(run(tie, {}, 'trust')) === '관련도높음,관련도낮음', '신뢰도가 같아도 관련도가 순서를 정한다');

// 가격을 못 읽는 상품은 가격 정렬에서 맨 뒤 (0원 취급하면 1위가 된다)
const withBad = [
  item({ productId: 'p1', title: '정상', lprice: 30000 }),
  item({ productId: 'p2', title: '가격불명', lprice: 0 })
];
check(names(run(withBad, {}, 'lowprice')) === '정상,가격불명',
      '최저가순에서 가격 불명 상품이 1위가 되지 않는다', names(run(withBad, {}, 'lowprice')));
check(names(run(withBad, {}, 'highprice')) === '정상,가격불명', '최고가순에서도 맨 뒤');

// 가격 하락순 — 하락 정보가 없는 상품은 뒤로
const dropSort = [
  item({ productId: 'q1', title: '하락없음', lprice: 1000, relevance: 0.9 }),
  item({ productId: 'q2', title: '30%하락',  lprice: 90000, relevance: 0.5,
         priceChange: { dropPct: 30, prevPrice: 128000, currentPrice: 90000, dropAmount: 38000, isAllTimeLow: false } }),
  item({ productId: 'q3', title: '10%하락',  lprice: 50000, relevance: 0.5,
         priceChange: { dropPct: 10, prevPrice: 55000, currentPrice: 50000, dropAmount: 5000, isAllTimeLow: false } })
];
check(names(run(dropSort, {}, 'drop')) === '30%하락,10%하락,하락없음',
      '가격하락순 — 하락률 큰 순, 정보 없는 상품은 맨 뒤', names(run(dropSort, {}, 'drop')));

/* ================================================================ *
 *  6. 필터 조합 — 시나리오
 * ================================================================ */
section('6. 필터 조합');

const catalog = [
  item({ productId: 'c1', title: '노트북A 40만 high',  lprice: 400000, relevance: 1.0, trust: { level: 'high', score: 100 } }),
  item({ productId: 'c2', title: '노트북B 40만 low',   lprice: 400000, relevance: 0.9, trust: { level: 'low', score: 40 } }),
  item({ productId: 'c3', title: '노트북C 80만 high',  lprice: 800000, relevance: 0.9, trust: { level: 'high', score: 100 } }),
  item({ productId: 'c4', title: '노트북D 30만 high 하락', lprice: 300000, relevance: 0.8, trust: { level: 'high', score: 100 },
         priceChange: { dropPct: 25, prevPrice: 400000, currentPrice: 300000, dropAmount: 100000, isAllTimeLow: false } })
];

// 노트북 + 50만원 이하 + 높은 신뢰도
const s1 = run(catalog, { maxPrice: 500000, trust: 'high' });
check(names(s1) === '노트북A 40만 high,노트북D 30만 high 하락',
      '노트북 + 50만원 이하 + 신뢰 높음 → 2건', names(s1));

// 마우스 + 최근 가격 하락
const s2 = run(catalog, { drop: true });
check(names(s2) === '노트북D 30만 high 하락', '최근 가격 하락만 → 1건');

// 세 조건 동시 + 최저가순
const s3 = run(catalog, { maxPrice: 500000, trust: 'high', drop: true }, 'lowprice');
check(names(s3) === '노트북D 30만 high 하락', '가격 + 신뢰도 + 하락 동시 적용', names(s3));

// 조합해도 0건이 될 수 있다 — 그때도 오류가 아니라 빈 목록이어야 한다
const s4 = run(catalog, { maxPrice: 10000, trust: 'high' });
check(Array.isArray(s4) && s4.length === 0, '맞는 게 없으면 빈 배열 (예외가 아니다)');

// 필터를 걸어도 관련도 기준선 아래 상품이 새로 나타나지는 않는다
check(run(catalog, { maxPrice: 500000 }).every(x => x.relevance > 0),
      '필터는 목록을 좁히기만 한다 — 없던 상품을 만들지 않는다');

/* ── product_id + mall 원칙 ── */
const sameId = [
  item({ productId: '999', mall: '쿠팡',   title: '쿠팡행', lprice: 10000 }),
  item({ productId: '999', mall: '네이버쇼핑', title: '네이버행', lprice: 12000 })
];
check(run(sameId, { mall: '쿠팡' }).length === 1,
      '같은 product_id 라도 mall 이 다르면 별개로 걸린다 (title 로 묶지 않는다)');
check(run(sameId, {}).length === 2, '몰 필터가 없으면 둘 다 보인다');

/* ================================================================ *
 *  7. 카운트 — 눌러도 0건인 필터를 미리 알려준다
 * ================================================================ */
section('7. 필터 개수 계산');

AppState.results = catalog;
AppState.facets = { mall: 'all', minPrice: null, maxPrice: null, trust: 'all', drop: false, ship: 'all' };
check(Filters.countWith('trust', { trust: 'high' }) === 3, '신뢰 높음 개수 = 3');
check(Filters.countWith('drop', { drop: true }) === 1, '가격 하락 개수 = 1');
check(Filters.countWith('price', { minPrice: 0, maxPrice: 500000 }) === 3, '50만원 이하 개수 = 3');

// 이미 다른 필터가 걸린 상태에서의 개수 = 그 필터를 "추가로" 걸었을 때 남는 수
AppState.facets.trust = 'high';
check(Filters.countWith('price', { minPrice: 0, maxPrice: 500000 }) === 2,
      '신뢰 높음이 걸린 상태에서 50만원 이하 개수 = 2 (조합 기준)',
      Filters.countWith('price', { minPrice: 0, maxPrice: 500000 }));

console.log(`\n결과: ${pass} PASS / ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
