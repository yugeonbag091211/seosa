#!/usr/bin/env node
'use strict';
/*
 * ⑤ 장바구니 최저가 — 완전 오프라인.
 *
 * 여기서 고정하는 것
 *   1) 배송비·쿠폰 계산 규칙 (무료배송 기준, 정액/정률, 최소 주문, 최대 할인, 몰당 쿠폰 하나)
 *   2) 최적화가 «정말» 최저가다 — 결정론 난수로 만든 작은 사례 수백 개를
 *      이 파일 안의 독립 구현(완전 탐색)과 대조한다. 같은 총액, 같은 택배 수.
 *   3) 절약액은 음수가 될 수 없다 (노드 상한에 걸려도)
 *   4) 같은 상품 판정: 용량·색상·수량이 다르거나 옵션 번호가 다르면 합치지 않고 이유를 남긴다
 *   5) 오래 확인하지 못한 판매처는 계산에서 빠진다. 가격은 price_history 가 카탈로그보다 먼저다
 *   6) 입력 검증 · 405 · no-store · 쓰기 0회 · 외부 호출 0회
 */

const fs = require('fs');
const path = require('path');
const kit = require('./_v2-testkit');
const { db, state, T, mkReq, mkRes, fetchCalls } = kit.setup('test-v2-cart');

const ROOT = path.resolve(__dirname, '..');
const C = require('../api/_cart');
const cartApi = require('../api/_cart-api');
const history = require('../api/history');

/* ------------------------------------------------------------------ *
 *  독립 구현 — 계약 문장을 그대로 옮긴 완전 탐색. api/_cart.js 를 쓰지 않는다.
 * ------------------------------------------------------------------ */

function bfShip(rule, s) {
  if (s <= 0) return 0;
  if (rule.freeOver !== null && rule.freeOver !== undefined && s >= rule.freeOver) return 0;
  return rule.fee;
}
function bfCoupon(c, s) {
  if (s <= 0 || s < (c.minSpend || 0)) return 0;
  let d = c.amount != null ? c.amount : Math.floor(s * c.percent / 100);
  if (c.maxDiscount != null) d = Math.min(d, c.maxDiscount);
  return Math.max(0, Math.min(d, s));
}
function bfCost(lines, rules, picks) {
  const sub = {};
  let items = 0;
  lines.forEach((l, i) => {
    const o = l.offers[picks[i]];
    const c = o.unitPrice * l.quantity;
    sub[o.group] = (sub[o.group] || 0) + c;
    items += c;
  });
  let total = items, malls = 0;
  Object.keys(sub).forEach(g => {
    if (!(sub[g] > 0)) return;
    malls++;
    const r = rules[g];
    total += bfShip(r, sub[g]);
    total -= (r.coupons || []).reduce((m, c) => Math.max(m, bfCoupon(c, sub[g])), 0);
  });
  return { total, malls };
}
/** 모든 배정을 센다. onlyGroup 이 있으면 그 몰 후보만. */
function brute(lines, rules, onlyGroup) {
  const allowed = lines.map(l => l.offers.map((o, k) => k).filter(k => !onlyGroup || l.offers[k].group === onlyGroup));
  if (allowed.some(a => !a.length)) return null;
  const idx = lines.map(() => 0);
  let best = null;
  for (;;) {
    const picks = idx.map((j, i) => allowed[i][j]);
    const e = bfCost(lines, rules, picks);
    if (!best || e.total < best.total || (e.total === best.total && e.malls < best.malls)) best = e;
    let p = 0;
    while (p < idx.length) {
      idx[p]++;
      if (idx[p] < allowed[p].length) break;
      idx[p] = 0; p++;
    }
    if (p === idx.length) break;
  }
  return best;
}

/** 결정론 난수 (mulberry32) — 실패가 재현돼야 고칠 수 있다. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];

function randomCoupon(r) {
  const c = { amount: null, percent: null, minSpend: pick(r, [0, 0, 10000, 20000, 30000, 50000]), maxDiscount: null };
  if (r() < 0.5) c.amount = pick(r, [500, 1000, 2000, 3000, 5000, 8000]);
  else { c.percent = pick(r, [3, 5, 7.5, 10, 15, 30]); if (r() < 0.6) c.maxDiscount = pick(r, [1000, 2000, 3000, 5000]); }
  return c;
}

function randomInstance(r, o) {
  const nMalls = 1 + Math.floor(r() * o.malls);
  const groups = Array.from({ length: nMalls }, (_, i) => `m${i}`);
  const rules = {};
  groups.forEach(g => {
    rules[g] = {
      fee: pick(r, [0, 2500, 3000, 3000, 5000]),
      freeOver: pick(r, [null, 0, 10000, 20000, 30000, 30000, 50000]),
      coupons: []
    };
    const nc = Math.floor(r() * 3);
    for (let i = 0; i < nc; i++) rules[g].coupons.push(randomCoupon(r));
  });
  const nItems = o.exact ? o.items : 1 + Math.floor(r() * o.items);
  const lines = [];
  for (let i = 0; i < nItems; i++) {
    const base = o.flat ? o.flat : 1000 + Math.floor(r() * 40000);
    const nOffers = 1 + Math.floor(r() * o.offers);
    const offers = [];
    for (let k = 0; k < nOffers; k++) {
      offers.push({ group: pick(r, groups), unitPrice: Math.max(10, Math.round(base * (0.8 + r() * 0.4) / 10) * 10) });
    }
    lines.push({ quantity: 1 + Math.floor(r() * 3), offers });
  }
  return { lines, rules };
}

/* ------------------------------------------------------------------ *
 *  픽스처
 * ------------------------------------------------------------------ */

const isoDaysAgo = n => new Date(Date.now() - n * 86400000).toISOString();
const TODAY = kit.daysAgo(0);

const S24 = '삼성전자 갤럭시 S24 SM-S921N 256GB 자급제 블랙';
const S24_512 = '삼성전자 갤럭시 S24 SM-S921N 512GB 자급제 블랙';
const S24_WHITE = '삼성전자 갤럭시 S24 SM-S921N 256GB 자급제 화이트';
const RAMEN1 = '오뚜기 진라면 매운맛 120g 1개';
const RAMEN2 = '오뚜기 진라면 매운맛 120g 2개';
const ADP = n => `ad${String(n).padStart(6, '0')}${'f'.repeat(56)}`;   // ADPICK 식 해시 id (\w)

function seedDb() {
  db.products = [
    { product_id: '1001', mall: '쿠팡', mall_label: '', vendor_item_id: '90011', title: S24, lprice: 1050000,
      link: 'https://link.coupang.com/a/abc?itemId=1&vendorItemId=90011', keyword: '갤럭시 S24', collected_at: isoDaysAgo(2) },
    // 같은 상품 번호 · 같은 몰 · 다른 옵션 (가짜 DB 는 UNIQUE 를 강제하지 않는다 — 코드가 스스로 갈라야 한다)
    { product_id: '1001', mall: '쿠팡', mall_label: '', vendor_item_id: '90012', title: S24_512, lprice: 1250000,
      link: 'https://link.coupang.com/a/abd?itemId=1&vendorItemId=90012', keyword: '갤럭시 S24', collected_at: isoDaysAgo(3) },
    { product_id: ADP(1), mall: 'ADPICK', mall_label: '11번가', vendor_item_id: '', title: S24, lprice: 1020000,
      link: 'https://adpick.example/c/1', keyword: '갤럭시 S24', collected_at: isoDaysAgo(0) },
    { product_id: ADP(2), mall: 'ADPICK', mall_label: 'G마켓', vendor_item_id: '', title: S24_512, lprice: 1150000,
      link: 'https://adpick.example/c/2', keyword: '갤럭시 S24', collected_at: isoDaysAgo(0) },
    { product_id: ADP(3), mall: 'ADPICK', mall_label: '옥션', vendor_item_id: '', title: S24_WHITE, lprice: 1000000,
      link: 'https://adpick.example/c/3', keyword: '갤럭시 S24', collected_at: isoDaysAgo(0) },
    { product_id: ADP(4), mall: 'ADPICK', mall_label: 'SSG', vendor_item_id: '', title: S24, lprice: 900000,
      link: 'https://adpick.example/c/4', keyword: '갤럭시 S24', collected_at: isoDaysAgo(20) },
    { product_id: ADP(5), mall: 'ADPICK', mall_label: '11번가', vendor_item_id: '', title: '갤럭시 S24 케이스 투명 젤리 범퍼', lprice: 5900,
      link: 'https://adpick.example/c/5', keyword: '갤럭시 S24', collected_at: isoDaysAgo(0) },
    { product_id: ADP(6), mall: 'ADPICK', mall_label: 'GS SHOP', vendor_item_id: '', title: S24, lprice: 1030000,
      link: 'http://adpick.example/c/6', keyword: '갤럭시 S24', collected_at: isoDaysAgo(1) },

    { product_id: '2001', mall: '쿠팡', mall_label: '쿠팡', vendor_item_id: '20011', title: RAMEN1, lprice: 1000,
      link: 'https://link.coupang.com/a/r1?itemId=2&vendorItemId=20011', keyword: '진라면', collected_at: isoDaysAgo(0) },
    { product_id: ADP(11), mall: 'ADPICK', mall_label: '11번가', vendor_item_id: '', title: RAMEN1, lprice: 900,
      link: 'https://adpick.example/c/11', keyword: '진라면', collected_at: isoDaysAgo(0) },
    { product_id: ADP(12), mall: 'ADPICK', mall_label: 'G마켓', vendor_item_id: '', title: RAMEN2, lprice: 1800,
      link: 'https://adpick.example/c/12', keyword: '진라면', collected_at: isoDaysAgo(0) }
  ];
  db.price_history = []
    .concat(kit.historyRows({ productId: '1001', vendorItemId: '90011', prices: [1060000, 1050000, 1040000, 990000], startId: 1 }))
    // 다른 옵션의 기록 — 섞이면 안 된다
    .concat(kit.historyRows({ productId: '1001', vendorItemId: '90012', prices: [1250000, 1240000], startId: 100 }))
    .concat(kit.historyRows({ productId: ADP(4), mall: 'ADPICK', vendorItemId: '', prices: [900000, 900000], endDaysAgo: 20, startId: 200 }))
    .concat(kit.historyRows({ productId: '2001', vendorItemId: '20011', prices: [1000, 1000], startId: 300 }));
}

async function post(body, extra) {
  const res = mkRes();
  await cartApi.handler(mkReq(Object.assign({ method: 'POST', body }, extra || {})), res);
  return res;
}

const has = (list, pred) => (list || []).some(pred);

async function main() {
  /* ── 1. 배송비 · 쿠폰 규칙 ──────────────────────────────────── */
  T.section('배송비 · 쿠폰 규칙');
  {
    const rule = { fee: 3000, freeOver: 30000, coupons: [] };
    T.check(C.shippingFor(rule, 0) === 0, '그 몰에서 아무것도 안 사면 배송비 0');
    T.check(C.shippingFor(rule, 29990) === 3000, '무료배송 기준 미만이면 배송비');
    T.check(C.shippingFor(rule, 30000) === 0, '무료배송 기준 «이상» 이면 무료');
    T.check(C.shippingFor({ fee: 2500, freeOver: null }, 999999) === 2500, 'freeOver 없음 → 항상 배송비');
    T.check(C.shippingFor({ fee: 2500, freeOver: 0 }, 100) === 0, 'freeOver 0 → 항상 무료');
    T.check(C.couponDiscount({ amount: 5000, minSpend: 0 }, 3000) === 3000, '할인은 소계를 넘지 않는다');
    T.check(C.couponDiscount({ amount: 5000, minSpend: 30000 }, 29999) === 0, '최소 주문 금액 미만이면 0');
    T.check(C.couponDiscount({ percent: 10, minSpend: 0, maxDiscount: 2000 }, 30000) === 2000, '정률 쿠폰은 최대 할인에서 멈춘다');
    T.check(C.couponDiscount({ percent: 10, minSpend: 0 }, 12345) === 1234, '정률 할인의 원 미만은 버린다 (부풀리지 않는다)');
    T.check(C.couponDiscount({ amount: 5000, minSpend: 0, maxDiscount: 3000 }, 50000) === 3000, '정액 쿠폰에도 최대 할인이 걸린다');
    const two = { fee: 0, freeOver: null, coupons: [{ amount: 3000, minSpend: 0 }, { amount: 2000, minSpend: 0 }] };
    T.check(C.extraOf(two, 50000) === -3000, '몰당 쿠폰은 가장 유리한 하나만 (중복 적용 없음)');
  }

  /* ── 2. 최적화 = 완전 탐색 ──────────────────────────────────── */
  T.section('최적화 = 완전 탐색 (결정론 난수)');
  {
    const r = prng(20260924);
    let cases = 0, mismatch = null, notOptimal = 0, negative = 0, badBaseline = null, badTotal = null;
    for (let t = 0; t < 400; t++) {
      const { lines, rules } = randomInstance(r, { items: 5, offers: 4, malls: 4 });
      const o = C.optimize(lines, rules);
      const bf = brute(lines, rules);
      cases++;
      if (!o.optimal) notOptimal++;
      if (o.total !== bf.total || o.groups.length !== bf.malls) {
        if (!mismatch) mismatch = { t, got: [o.total, o.groups.length], want: [bf.total, bf.malls], lines, rules };
      }
      const re = bfCost(lines, rules, o.picks);
      if (re.total !== o.total || o.itemsCost + o.shippingCost - o.couponDiscount !== o.total) {
        if (!badTotal) badTotal = { t, re, o: [o.total, o.itemsCost, o.shippingCost, o.couponDiscount] };
      }
      // 기준선도 독립 구현과 같아야 한다
      const cheapPicks = lines.map(l => {
        let b = 0;
        l.offers.forEach((x, k) => { if (x.unitPrice < l.offers[b].unitPrice) b = k; });
        return b;
      });
      const cheap = bfCost(lines, rules, cheapPicks).total;
      let single = null;
      Object.keys(rules).forEach(g => {
        const s = brute(lines, rules, g);
        if (s && (single === null || s.total < single)) single = s.total;
      });
      const gotSingle = o.baselines.singleMall ? o.baselines.singleMall.total : null;
      if (cheap !== o.baselines.cheapestEach.total || single !== gotSingle) {
        if (!badBaseline) badBaseline = { t, cheap, single, got: o.baselines };
      }
      if (o.baselines.cheapestEach.total - o.total < 0 || (gotSingle !== null && gotSingle - o.total < 0)) negative++;
    }
    T.check(cases >= 200, `무작위 사례 ${cases}개 (1~5 상품 · 1~4 후보 · 1~4 몰 · 무작위 배송비/쿠폰)`);
    T.check(!mismatch, '모든 사례에서 완전 탐색과 같은 최저 총액 · 같은 택배 수', mismatch);
    T.check(!badTotal, '계획 총액 = 상품값 + 배송비 − 쿠폰, 독립 계산과 일치', badTotal);
    T.check(notOptimal === 0, '작은 사례는 전부 optimal:true', notOptimal);
    T.check(!badBaseline, '기준선(단일 몰 · 상품별 최저가)도 독립 계산과 일치', badBaseline);
    T.check(negative === 0, '절약액이 음수인 사례 0', negative);
  }
  {
    // 값이 거의 같은 후보들 — 동점이 많아 가지치기 경계(bound === best)를 두드린다
    const r = prng(7);
    let mismatch = null;
    for (let t = 0; t < 150; t++) {
      const { lines, rules } = randomInstance(r, { items: 5, offers: 4, malls: 3, flat: 10000 });
      const o = C.optimize(lines, rules);
      const bf = brute(lines, rules);
      if ((o.total !== bf.total || o.groups.length !== bf.malls) && !mismatch) mismatch = { t, o: o.total, bf };
    }
    T.check(!mismatch, '값이 비슷한(동점 많은) 사례 150개도 완전 탐색과 일치', mismatch);
  }

  /* ── 3. 시나리오 ──────────────────────────────────────────── */
  T.section('시나리오 — 몰아 사기 vs 나눠 사기');
  {
    const rules = { A: { fee: 3000, freeOver: 30000, coupons: [] }, B: { fee: 3000, freeOver: 30000, coupons: [] } };
    const lines = [
      { quantity: 1, offers: [{ group: 'A', unitPrice: 9000 }, { group: 'B', unitPrice: 10000 }] },
      { quantity: 1, offers: [{ group: 'A', unitPrice: 21500 }, { group: 'B', unitPrice: 20000 }] }
    ];
    const o = C.optimize(lines, rules);
    T.check(o.total === 30000 && o.groups.length === 1 && o.groups[0].group === 'B',
      '무료배송 기준 때문에 한 곳(B)에 몰아 사는 쪽이 싸다 (30,000원)', o);
    T.check(o.baselines.cheapestEach.total === 35000, '상품별 최저가는 배송비 두 번 → 35,000원', o.baselines);
    T.check(o.baselines.cheapestEach.total - o.total === 5000, '상품별 최저가 대비 5,000원 절약');
  }
  {
    const rules = { A: { fee: 3000, freeOver: 50000, coupons: [] }, B: { fee: 3000, freeOver: 50000, coupons: [] } };
    const lines = [
      { quantity: 1, offers: [{ group: 'A', unitPrice: 5000 }, { group: 'B', unitPrice: 15000 }] },
      { quantity: 1, offers: [{ group: 'A', unitPrice: 15000 }, { group: 'B', unitPrice: 5000 }] }
    ];
    const o = C.optimize(lines, rules);
    T.check(o.total === 16000 && o.groups.length === 2, '값 차이가 배송비보다 크면 나눠 사는 쪽이 싸다 (16,000원)', o);
    T.check(o.baselines.singleMall && o.baselines.singleMall.total === 23000, '한 곳에서 다 사면 23,000원', o.baselines);
  }
  {
    const rules = {
      A: { fee: 0, freeOver: null, coupons: [{ amount: 5000, percent: null, minSpend: 30000, maxDiscount: null }] },
      B: { fee: 0, freeOver: null, coupons: [] },
      C: { fee: 0, freeOver: null, coupons: [] }
    };
    const lines = [
      { quantity: 1, offers: [{ group: 'A', unitPrice: 16000 }, { group: 'B', unitPrice: 15000 }] },
      { quantity: 1, offers: [{ group: 'A', unitPrice: 16000 }, { group: 'C', unitPrice: 15000 }] }
    ];
    const o = C.optimize(lines, rules);
    T.check(o.total === 27000 && o.couponDiscount === 5000, '쿠폰 최소 주문 금액은 몰아 사야만 채워진다 (32,000 − 5,000)', o);
    T.check(o.baselines.cheapestEach.total === 30000, '상품별 최저가로는 쿠폰을 못 쓴다 (30,000원)');
  }
  {
    const rules = { A: { fee: 0, freeOver: null, coupons: [{ amount: null, percent: 10, minSpend: 0, maxDiscount: 2000 }] } };
    const o = C.optimize([{ quantity: 2, offers: [{ group: 'A', unitPrice: 15000 }] }], rules);
    T.check(o.total === 28000 && o.couponDiscount === 2000, '정률 10% 쿠폰은 최대 할인 2,000원에서 멈춘다 (30,000 → 28,000)', o);
  }
  {
    // 같은 몰의 «더 비싼» 후보가 무료배송 기준을 넘겨 줘서 이득인 경우 — 이 후보를 버리면 틀린다
    const rules = { A: { fee: 3000, freeOver: 30000, coupons: [] } };
    const o = C.optimize([{ quantity: 1, offers: [{ group: 'A', unitPrice: 29000 }, { group: 'A', unitPrice: 30000 }] }], rules);
    T.check(o.total === 30000 && o.picks[0] === 1, '같은 몰의 조금 더 비싼 옵션이 무료배송을 열면 그쪽을 고른다', o);
  }

  /* ── 4. 노드 상한 ─────────────────────────────────────────── */
  T.section('노드 상한');
  {
    // 네 몰 모두 «15만원 이상 1만원» 쿠폰 — 20개(약 20만원)로는 한 몰만 채울 수 있어서
    // 하한(쿠폰 넷 다 받는다고 가정)이 느슨하다. 50 노드 안에 증명이 끝날 수 없는 사례.
    const r = prng(99);
    const groups = ['A', 'B', 'C', 'D'];
    const rules = {};
    groups.forEach(g => { rules[g] = { fee: 3000, freeOver: 50000, coupons: [{ amount: 10000, percent: null, minSpend: 150000, maxDiscount: null }] }; });
    const big = [];
    for (let i = 0; i < 20; i++) {
      big.push({ quantity: 1, offers: groups.map(g => ({ group: g, unitPrice: 9000 + Math.floor(r() * 200) * 10 })) });
    }
    const o = C.optimize(big, rules, { nodeCap: 50 });
    T.check(o.optimal === false, '상한에 걸리면 optimal:false', o.optimal);
    T.check(o.searchedNodes <= 50, `탐색 노드는 상한 이하 (${o.searchedNodes})`);
    T.check(o.picks.length === 20 && o.picks.every((k, i) => k >= 0 && k < big[i].offers.length), '그래도 모든 상품에 판매처가 배정된 유효한 계획이다');
    T.check(bfCost(big, rules, o.picks).total === o.total, '상한에 걸린 계획의 총액도 독립 계산과 같다');
    T.check(o.total <= o.baselines.cheapestEach.total
      && (!o.baselines.singleMall || o.total <= o.baselines.singleMall.total), '상한에 걸려도 기준선보다 비싸지 않다 (절약액 ≥ 0)');
    const full = C.optimize(big, rules);
    T.check(full.optimal === true && full.total <= o.total, `상한 없이 풀면 증명까지 끝난다 (${full.searchedNodes} 노드) · 더 싸거나 같다`, full.searchedNodes);
  }

  /* ── 5. 20 상품 최악 측정 ─────────────────────────────────── */
  T.section('20 상품 — 노드 수 · 시간 측정');
  {
    const families = [
      { name: '현실형 (후보 1~4 · 몰 1~5 · 값 제각각)', seed: 1000, n: 30, o: { items: 20, exact: true, offers: 4, malls: 5 } },
      { name: '넓은형 (후보 1~6 · 몰 1~6 · 값 제각각)', seed: 2000, n: 30, o: { items: 20, exact: true, offers: 6, malls: 6 } },
      { name: '적대형 (후보 1~6 · 몰 1~6 · 값이 전부 ±20% 안)', seed: 3000, n: 30, o: { items: 20, exact: true, offers: 6, malls: 6, flat: 9000 } },
      { name: '같은 상품을 여러 줄로 담은 장바구니 (줄 복제)', seed: 4000, n: 30, o: { items: 20, offers: 4, malls: 5, dup: true } }
    ];
    let slowest = 0, allValid = true;
    families.forEach(f => {
      let worstNodes = 0, worstMs = 0, capped = 0;
      for (let s = 1; s <= f.n; s++) {
        const r = prng(f.seed + s);
        const inst = randomInstance(r, f.o);
        // 같은 상품을 수량 대신 여러 줄로 담은 경우 — 같은 줄이 반복된다
        if (f.o.dup) while (inst.lines.length < 20) inst.lines.push(inst.lines[inst.lines.length % Math.max(1, inst.lines.length)]);
        const t0 = process.hrtime.bigint();
        const o = C.optimize(inst.lines, inst.rules);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (!o.optimal) capped++;
        if (o.searchedNodes > worstNodes) worstNodes = o.searchedNodes;
        if (ms > worstMs) worstMs = ms;
        if (bfCost(inst.lines, inst.rules, o.picks).total !== o.total || o.total > o.baselines.cheapestEach.total) allValid = false;
      }
      slowest = Math.max(slowest, worstMs);
      console.log(`    ${f.name}: 최악 노드 ${worstNodes.toLocaleString('ko-KR')} · 최악 ${worstMs.toFixed(1)}ms · 상한 도달 ${capped}/${f.n}`);
    });
    T.check(allValid, '20 상품 사례 전부 유효한 계획 · 기준선 이하');
    T.check(slowest < 5000, `20 상품 최악 계산 시간 ${slowest.toFixed(1)}ms (< 5초)`);
  }

  /* ── 6. 입력 검증 ─────────────────────────────────────────── */
  T.section('입력 검증 (400 BAD_INPUT)');
  seedDb();
  const one = { productId: '1001', quantity: 1 };
  const badCases = [
    ['상품 0개', { items: [] }],
    ['상품 21개', { items: Array.from({ length: 21 }, () => one) }],
    ['items 없음', {}],
    ['수량 0', { items: [{ productId: '1001', quantity: 0 }] }],
    ['수량 100', { items: [{ productId: '1001', quantity: 100 }] }],
    ['수량 1.5', { items: [{ productId: '1001', quantity: 1.5 }] }],
    ['수량 문자', { items: [{ productId: '1001', quantity: 'abc' }] }],
    ['상품 번호도 상품명도 없음', { items: [{ quantity: 1 }] }],
    ['상품명 1자', { items: [{ title: '폰' }] }],
    ['이상한 상품 번호', { items: [{ productId: '1;drop table', quantity: 1 }] }],
    ['이상한 옵션 번호', { items: [{ productId: '1001', vendorItemId: 'x y' }] }],
    ['배송비 20만원', { items: [one], shipping: { 쿠팡: { fee: 200000 } } }],
    ['배송비 음수', { items: [one], shipping: { 쿠팡: { fee: -1 } } }],
    ['무료배송 기준 음수', { items: [one], shipping: { 쿠팡: { fee: 3000, freeOver: -5 } } }],
    ['배송비 형식', { items: [one], shipping: [1, 2] }],
    ['쿠폰 11개', { items: [one], coupons: Array.from({ length: 11 }, () => ({ mall: '쿠팡', amount: 1000 })) }],
    ['쿠폰 할인율 95%', { items: [one], coupons: [{ mall: '쿠팡', percent: 95 }] }],
    ['쿠폰 할인율 0.5%', { items: [one], coupons: [{ mall: '쿠팡', percent: 0.5 }] }],
    ['쿠폰 금액 0', { items: [one], coupons: [{ mall: '쿠팡', amount: 0 }] }],
    ['쿠폰 금액·비율 둘 다', { items: [one], coupons: [{ mall: '쿠팡', amount: 1000, percent: 10 }] }],
    ['쿠폰 할인 없음', { items: [one], coupons: [{ mall: '쿠팡' }] }],
    ['쿠폰 판매처 없음', { items: [one], coupons: [{ amount: 1000 }] }],
    ['쿠폰 최소 주문 음수', { items: [one], coupons: [{ mall: '쿠팡', amount: 1000, minSpend: -1 }] }],
    ['쿠폰 최대 할인 0', { items: [one], coupons: [{ mall: '쿠팡', percent: 10, maxDiscount: 0 }] }],
    ['본문 32KB 초과', { items: [Object.assign({}, one, { title: 'x'.repeat(40000) })] }]
  ];
  for (const [label, body] of badCases) {
    const res = await post(body);
    T.check(res.statusCode === 400 && res.body && res.body.ok === false && res.body.code === 'BAD_INPUT'
      && /[가-힣]/.test(res.body.error || ''), `${label} → 400 BAD_INPUT (한국어 문장)`, { status: res.statusCode, body: res.body });
  }
  {
    const res = await post(JSON.stringify({ items: [{ productId: '1001', quantity: '2' }] }));
    T.check(res.statusCode === 200 && res.body.items[0].input.quantity === 2, '문자열 본문 · 숫자 문자열 수량도 읽는다', res.body);
    const big = await post('{"items":[{"productId":"1001","title":"' + 'y'.repeat(40000) + '"}]}');
    T.check(big.statusCode === 400 && big.body.code === 'BAD_INPUT', '문자열 본문도 32KB 를 넘으면 400');
    const dflt = await post({ items: [{ productId: '1001' }] });
    T.check(dflt.statusCode === 200 && dflt.body.items[0].input.quantity === 1, '수량이 없으면 1');
  }

  /* ── 7. 핸들러 · 동일상품 판정 · 가격 확인 ─────────────────── */
  T.section('핸들러 — 후보 판정 · 가격 확인');
  const main1 = await post({
    items: [
      { productId: '1001', mall: '쿠팡', vendorItemId: '90011', quantity: 1 },
      { productId: '2001', quantity: 1 },
      { productId: '404404404', quantity: 1 }
    ]
  });
  const b = main1.body;
  T.check(main1.statusCode === 200 && b.ok === true, '200 ok', { status: main1.statusCode, body: b });
  T.check(main1.headers['cache-control'] === 'no-store, max-age=0', '장바구니 응답은 no-store', main1.headers['cache-control']);
  T.check(['ok', 'items', 'plan', 'baselines', 'savings', 'assumptions', 'unresolved'].every(k => k in b), '응답 최상위 모양이 계약과 같다', Object.keys(b));
  T.check(['total', 'itemsCost', 'shippingCost', 'couponDiscount', 'optimal', 'searchedNodes', 'byMall'].every(k => k in b.plan),
    'plan 모양이 계약과 같다', Object.keys(b.plan));
  const s24 = b.items[0];
  const offerKeys = ['mall', 'mallLabel', 'productId', 'vendorItemId', 'title', 'unitPrice', 'observedDate', 'staleDays',
    'availability', 'url', 'identity', 'option'];
  T.check(s24.offers.every(o => offerKeys.every(k => k in o)), 'Offer 모양이 계약과 같다', s24.offers[0]);

  const cp = s24.offers.find(o => o.productId === '1001');
  T.check(cp && cp.unitPrice === 990000 && cp.priceSource === 'price_history' && cp.observedDate === TODAY,
    '가격 기록(오늘 990,000원)이 카탈로그 lprice(이틀 전 1,050,000원)보다 먼저다', cp);
  T.check(cp && cp.mallLabel === '쿠팡' && cp.vendorItemId === '90011' && cp.option.ok === true, '쿠팡 기준 행 · 요청 옵션 일치', cp);
  T.check(cp && cp.url === 'https://link.coupang.com/a/abc?itemId=1&vendorItemId=90011', '링크는 products.link 그대로 (제휴 링크)');
  const st11 = s24.offers.find(o => o.mallLabel === '11번가');
  T.check(st11 && st11.unitPrice === 1020000 && st11.priceSource === 'catalog' && st11.identity.tier === 'A',
    '같은 제목의 11번가 오퍼를 받아들인다 (tier A + canMerge) · 기록이 없으면 카탈로그 가격', st11);
  const gs = s24.offers.find(o => o.mallLabel === 'GS SHOP');
  T.check(gs && gs.url === null, 'https 가 아닌 링크는 null', gs && gs.url);
  T.check(s24.offers.every(o => o.availability === 'LIVE'), 'offers 에는 LIVE 만 (계산에 쓴 판매처)');

  const reasonOf = pred => { const x = s24.excluded.find(e => pred(e.offer)); return x ? x.reason : ''; };
  T.check(/용량/.test(reasonOf(o => o.mallLabel === 'G마켓')), '256GB vs 512GB → 제외 · 이유: 용량', reasonOf(o => o.mallLabel === 'G마켓'));
  T.check(/색상/.test(reasonOf(o => o.mallLabel === '옥션')), '블랙 vs 화이트 → 제외 · 이유: 색상', reasonOf(o => o.mallLabel === '옥션'));
  T.check(/다른 옵션/.test(reasonOf(o => o.productId === '1001' && o.vendorItemId === '90012')),
    '같은 상품 번호 · 다른 옵션 번호 → 제외 · 이유: 다른 옵션', reasonOf(o => o.productId === '1001'));
  const ssg = s24.excluded.find(e => e.offer.mallLabel === 'SSG');
  T.check(ssg && ssg.offer.availability === 'STALE' && /최근 가격 확인이 안 돼/.test(ssg.reason) && ssg.offer.staleDays >= 20,
    '20일 전 확인한 판매처는 STALE — 계산에서 빼고 이유를 남긴다 (더 싸도)', ssg);
  T.check(!has(s24.excluded, e => /케이스/.test(e.offer.title)) && !has(s24.offers, o => /케이스/.test(o.title)),
    '같은 검색어의 무관한 상품(케이스)은 오퍼로도, 제외 목록으로도 늘어놓지 않는다');
  T.check(has(b.assumptions, a => /같은 상품이 아니라서 비교하지 않았어요/.test(a)), '무관한 후보 수는 assumptions 에 한 줄로 남긴다');
  T.check(s24.excluded.every(e => e.offer && typeof e.reason === 'string' && e.reason), 'excluded 는 {offer, reason} 모양');

  const ramen = b.items[1];
  const r2 = ramen.excluded.find(e => e.offer.title === RAMEN2);
  T.check(r2 && /수량/.test(r2.reason), '1개 vs 2개 → 제외 · 이유: 수량', r2 && r2.reason);
  T.check(ramen.offers.length === 2, '라면은 쿠팡 · 11번가 두 곳', ramen.offers.map(o => o.mallLabel));

  T.check(b.unresolved.length === 1 && b.unresolved[0].itemIndex === 2 && /찾지 못했어요/.test(b.unresolved[0].reason),
    '카탈로그에 없는 상품 번호는 unresolved', b.unresolved);
  T.check(b.items[2].offers.length === 0, '찾지 못한 상품은 offers 가 비어 있다');

  /* 계획: 쿠팡 990,000 + 라면 쿠팡 1,000 → 쿠팡 한 곳, 무료배송 */
  T.check(b.plan.total === 991000 && b.plan.byMall.length === 1 && b.plan.byMall[0].mall === '쿠팡',
    '기본 배송비 추정이면 라면도 쿠팡에서 — 991,000원 한 곳', b.plan);
  T.check(b.plan.optimal === true && b.plan.searchedNodes > 0, 'optimal:true · searchedNodes 보고', b.plan);
  T.check(b.baselines.cheapestEach.total === 993900, '상품별 최저가 = 990,000 + 900 + 11번가 배송비 3,000', b.baselines);
  T.check(b.baselines.singleMall && b.baselines.singleMall.mall === '쿠팡' && b.baselines.singleMall.total === 991000,
    '단일 몰 기준선 = 쿠팡 991,000', b.baselines);
  T.check(b.savings.vsCheapestEach === 2900 && b.savings.vsSingleMall === 0, '절약액 (상품별 최저가 대비 2,900원)', b.savings);
  const line0 = b.plan.byMall[0].lines[0];
  T.check(line0 && line0.itemIndex === 0 && line0.quantity === 1 && line0.lineTotal === 990000 && line0.offer.productId === '1001',
    'byMall.lines 모양 { itemIndex, offer, quantity, lineTotal }', line0);
  T.check(b.plan.byMall[0].shippingEstimated === true && has(b.assumptions, a => /기본 추정치/.test(a) && /판매처마다 달라요/.test(a)),
    '입력하지 않은 배송비는 추정이라고 적는다', b.assumptions);
  T.check(has(b.assumptions, a => /재고/.test(a) && /API/.test(a)), '재고 API 가 없다는 사실을 적는다');
  T.check(has(b.assumptions, a => /직접 입력한 것만/.test(a)), '쿠폰은 입력한 것만 쓴다고 적는다');

  /* 배송비 입력 → 계획이 바뀐다 */
  {
    const res = await post({
      items: [{ productId: '1001', vendorItemId: '90011' }, { productId: '2001' }],
      shipping: { '11번가': { fee: 0 } }
    });
    const p = res.body.plan;
    T.check(p.total === 990900 && p.byMall.length === 2, '11번가 배송비 0 을 입력하면 라면은 11번가 (990,900원)', p);
    const m11 = p.byMall.find(g => g.mall === '11번가');
    T.check(m11 && m11.shipping === 0 && m11.shippingEstimated === false, '입력한 배송비는 추정이 아니다', m11);
  }
  /* 쿠폰 입력 → 몰아 사기로 쿠폰 최소 금액을 채운다 */
  {
    const res = await post({
      items: [{ productId: '1001', vendorItemId: '90011' }, { productId: '2001' }],
      coupons: [{ mall: ' 11번가 ', amount: 40000, minSpend: 1000000 }, { mall: '알리', amount: 1000 }]
    });
    const p = res.body.plan;
    T.check(p.total === 980900 && p.couponDiscount === 40000 && p.byMall.length === 1 && p.byMall[0].mall === '11번가',
      '11번가 쿠폰(100만원 이상 4만원)은 두 상품을 11번가에 몰아야 쓸 수 있다 → 980,900원', p);
    T.check(has(res.body.assumptions, a => /알리/.test(a) && /적용하지 못했어요/.test(a)), '비교할 상품이 없는 판매처의 쿠폰은 못 썼다고 적는다');
    T.check(res.body.savings.vsCheapestEach >= 0 && res.body.savings.vsSingleMall >= 0, '절약액 ≥ 0', res.body.savings);
  }
  /* 수량 */
  {
    const res = await post({ items: [{ productId: '2001', quantity: 40 }] });
    const p = res.body.plan;
    T.check(p.byMall.length === 1 && p.byMall[0].lines[0].quantity === 40 && p.byMall[0].lines[0].lineTotal === p.byMall[0].subtotal,
      '수량은 줄 금액에 곱해진다', p.byMall);
    T.check(p.total === 36000 && p.byMall[0].mall === '11번가' && p.shippingCost === 0,
      '라면 40개 = 11번가 900×40 = 36,000원 (무료배송 기준 이상)', p);
  }

  /* ── 8. 상품명으로 찾기 · 요청 옵션 ─────────────────────────── */
  T.section('상품명으로 찾기 · 요청 옵션');
  {
    const res = await post({ items: [{ title: S24 }] });
    const it = res.body.items[0];
    T.check(res.body.unresolved.length === 0 && it.offers.length >= 2, '정확한 상품명은 tier A 로 찾고 후보군까지 이어진다', res.body.unresolved);
    const res2 = await post({ items: [{ title: '갤럭시 S24' }] });
    const u = res2.body.unresolved[0];
    T.check(u && /확신할 수 없어요/.test(u.reason) && u.suggestions.length >= 1 && u.suggestions.every(s => s.productId && s.title),
      '짧은 상품명은 합치지 않고 unresolved + 후보 제안', u);
    const res3 = await post({ items: [{ title: '세상에 없는 상품명 크크크 ZZ99X' }] });
    T.check(res3.body.unresolved.length === 1 && res3.body.plan.byMall.length === 0 && res3.body.plan.total === 0,
      '아무것도 맞지 않으면 unresolved (계획은 빈 채로)', res3.body);
    T.check(res3.body.baselines.singleMall === null && res3.body.savings.vsSingleMall === null, '기준선을 낼 수 없으면 null');
  }
  {
    const res = await post({ items: [{ productId: '1001', vendorItemId: '99999' }] });
    const u = res.body.unresolved[0];
    T.check(u && /옵션/.test(u.reason), '요청한 옵션 번호가 카탈로그에 없으면 다른 옵션 가격을 빌려 오지 않는다', u);
    T.check(res.body.items[0].excluded.length === 2 && res.body.items[0].excluded.every(e => /다른 옵션/.test(e.reason)),
      '같은 상품의 다른 옵션들은 이유와 함께 제외', res.body.items[0].excluded.map(e => e.reason));
  }
  {
    const res = await post({ items: [{ productId: '1001', vendorItemId: '90011', title: '삼성전자 갤럭시 S24 512GB' }] });
    const o = res.body.items[0].offers.find(x => x.productId === '1001');
    T.check(o && o.option.ok === false && o.option.notes.some(n => /용량/.test(n)),
      '입력한 상품명과 용량이 다르면 option.ok=false 로 알린다', o && o.option);
    const res2 = await post({ items: [{ productId: '1001', vendorItemId: '90011', title: '갤럭시 S24' }] });
    const o2 = res2.body.items[0].offers.find(x => x.productId === '1001');
    T.check(o2 && o2.option.ok === true, '색을 적지 않은 상품명은 색상 충돌로 보지 않는다', o2 && o2.option);
  }

  /* ── 9. 순수 부품 ────────────────────────────────────────── */
  T.section('순수 부품');
  {
    T.check(C.mallLabelOf({ mall: '쿠팡', mall_label: '' }).label === '쿠팡', '쿠팡 행의 판매처는 쿠팡');
    T.check(C.mallLabelOf({ mall: 'ADPICK', mall_label: 'G마켓' }).label === 'G마켓', 'ADPICK 행은 실제 판매몰 이름');
    const u1 = C.mallLabelOf({ mall: 'ADPICK', mall_label: '', product_id: 'abc123' });
    const u2 = C.mallLabelOf({ mall: 'ADPICK', mall_label: '', product_id: 'def456' });
    T.check(u1.unknownSeller && u1.label !== u2.label, '판매처 이름이 없는 ADPICK 상품은 서로 다른 판매처로 센다 (배송비를 적게 세지 않게)');
    const toks = C.titleSearchTokens(S24);
    T.check(toks.length === 2 && toks[0] === 'sm-s921n' && toks.every(t => /^[0-9a-z가-힣-]+$/.test(t)),
      '상품명 검색 단서: 모델코드 먼저 · 와일드카드 문자 없음', toks);
    T.check(C.titleSearchTokens('100% 정품 !!!').every(t => !/[%_]/.test(t)), '검색 단서에 % · _ 가 들어가지 않는다');
  }

  /* ── 10. 라우팅 · 메서드 · 안전 ──────────────────────────── */
  T.section('라우팅 · 메서드 · 안전');
  {
    const res = mkRes();
    await cartApi.handler(mkReq({ method: 'GET' }), res);
    T.check(res.statusCode === 405, 'GET → 405', res.statusCode);
    T.check(res.headers['cache-control'] === 'no-store, max-age=0', '405 응답도 no-store', res.headers['cache-control']);
    const opt = mkRes();
    await cartApi.handler(mkReq({ method: 'OPTIONS' }), opt);
    T.check(opt.statusCode === 204 && opt.headers['access-control-allow-origin'] === '*', 'OPTIONS → 204 (public CORS)');
  }
  {
    const res = mkRes();
    await history(mkReq({ method: 'POST', query: { __route: 'cart' }, body: { items: [{ productId: '2001' }] } }), res);
    T.check(res.statusCode === 200 && res.body && res.body.ok === true && res.body.plan, 'history?__route=cart 가 이 모듈로 이어진다 (NOT_READY 아님)', res.body);
  }
  {
    state.failNext.products = 'boom';
    const res = await post({ items: [{ productId: '2001' }] });
    T.check(res.statusCode === 500 && /장바구니를 계산하지 못했어요/.test(res.body.error), 'DB 오류는 fail → 500 문장', res.body);
  }
  {
    // 레이트 리밋: 같은 IP 로 31번
    let last = null;
    for (let i = 0; i < 31; i++) last = await post({ items: [{ productId: '2001' }] }, { ip: '203.0.113.77' });
    T.check(last.statusCode === 429, '같은 IP 분당 30회를 넘으면 429 (_ratelimit.guard)', last.statusCode);
  }
  {
    const pure = fs.readFileSync(path.join(ROOT, 'api', '_cart.js'), 'utf8');
    const reqs = (pure.match(/require\((['"])[^'"]+\1\)/g) || []);
    T.check(reqs.length > 0 && reqs.every(x => /_identity|_hotgroup|_price'/.test(x)),
      'api/_cart.js 는 DB·HTTP 를 모른다 (순수 모듈만 require)', reqs);
    const handlerSrc = fs.readFileSync(path.join(ROOT, 'api', '_cart-api.js'), 'utf8');
    T.check(!/\.(insert|upsert|update|rpc)\(/.test(handlerSrc) && !/\.delete\(/.test(handlerSrc), '핸들러 소스에 쓰기 연산이 없다');
  }
  T.check(state.writes.length === 0, '어떤 표에도 한 행도 쓰지 않았다', state.writes);
  T.check(fetchCalls.length === 0, '외부 호출 0회', fetchCalls);

  /* ── 11. 화면 ────────────────────────────────────────────── */
  T.section('화면');
  {
    const p = path.join(ROOT, 'public', 'v2', 'cart.html');
    T.check(fs.existsSync(p), 'public/v2/cart.html 존재');
    const html = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    const scripts = (html.match(/<script>([\s\S]*?)<\/script>/g) || []).join('\n');
    T.check(scripts.length > 0, '인라인 스크립트가 있다');
    T.check(!/=>|`|\blet\s|\bconst\s|\bclass\s|\.\.\./.test(scripts), '인라인 스크립트는 ES5 (화살표·템플릿·let/const·전개 없음)');
    T.check(/직접 확인한 쿠폰만/.test(html), '쿠폰 입력에 «직접 확인한 쿠폰만» 이라고 적는다');
    T.check(/seosa_v2_cart/.test(html) && /V2\.readJSON/.test(html) && /V2\.writeJSON/.test(html), '장바구니는 localStorage(seosa_v2_cart)에 V2.readJSON/writeJSON 으로');
    T.check(/rel="noopener sponsored"/.test(html) && /target="_blank"/.test(html) && /구매하러 가기/.test(html), '구매 링크는 새 창 · noopener sponsored');
    T.check(/V2\.safeUrl/.test(html) && /V2\.esc/.test(html), '서버 문자열은 V2.esc, 링크는 V2.safeUrl(https)');
    T.check((scripts.match(/V2\.esc\(/g) || []).length >= 10, '화면이 그리는 서버 문자열마다 V2.esc 를 거친다');
    const home = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    T.check(home.includes('/v2/cart.html'), '기존 홈에서 장바구니 최저가로 이동할 수 있다');
  }

  T.done();
}

main().catch(e => { console.error(e); process.exitCode = 1; });
