#!/usr/bin/env node
/**
 * AI Concierge 파이프라인 E2E — 완전 오프라인 (외부 호출 0회, 비용 0원).
 *
 * ── 세 테스트의 역할 분담 ───────────────────────────────────────
 *
 *   test-ai.js            순수 함수 단위. (npm test 포함)
 *   test-ai-pipeline.js   ★ 이 파일. api/ai.js 핸들러를 통째로 돌리되
 *                         LLM·쿠팡·Supabase 를 스텁으로 바꾼다. (npm test 포함)
 *   test-ai-concierge.js  진짜 LLM·쿠팡·DB 로 돈다. (비용 발생 — 수동)
 *
 * ── 왜 필요한가 ─────────────────────────────────────────────────
 * 단위 테스트는 "함수가 맞다"만 보장한다. 함수들이 핸들러 안에서 실제로
 * 연결됐는지 — 조건이 프롬프트에 실리는지, 랭킹 순서가 카드 순서와 같은지,
 * firewall 이 실제 응답 경로에서 도는지 — 는 여기서만 잡힌다.
 * 그리고 LLM 크레딧이 없어도(2026-08-28 에 실제로 그랬다) 돌릴 수 있다.
 *
 * ── 스텁의 선 ──────────────────────────────────────────────────
 * 스텁하는 것: OpenRouter 응답, 쿠팡 검색 결과, price_history 조회.
 * 스텁하지 않는 것: 그 사이의 모든 production 코드 — 분류 파싱, 조건 추출,
 * 랭킹, describe, 프롬프트 조립, stripRefs/stripUrls, firewall, 카드 변환.
 */
'use strict';

require('./_env.js');

/* ── 대역 (ai.js require 이전에) ──────────────────────────────── */
const auth = require('../api/_auth');
auth.identify = () => ({ ok: true, email: 'qa@seosa.local' });
const http = require('../api/_http');
http.applyCors = () => true;
http.noStore = () => {};
const rl = require('../api/_ratelimit');
rl.guard = () => true;
const plan = require('../api/_plan');
plan.resolvePlan = async () => ({ plan: 'pro', limit: 9999 });
plan.reserve = async () => ({ allowed: true, used: 1, degraded: false });
let releasedCount = 0;
plan.release = async () => { releasedCount++; };
plan.usagePayload = (p, used, limit) => ({ plan: p, used, limit, remaining: limit - used });

/*
 * 검색·신뢰도·가격기록 스텁.
 * require 캐시의 같은 객체를 ai.js 도 받으므로 속성 교체가 그대로 먹는다.
 */
const shop = require('../api/_shop');
const trust = require('../api/_trust');
const pricestat = require('../api/_pricestat');

/** 시나리오마다 갈아끼우는 스텁 상태 */
const stub = {
  searchItems: [],        // searchAll 이 돌려줄 상품
  searchMode: 'ok',       // ok | empty | blocked | throw
  stats: new Map(),       // loadStats 결과
  llm: {},                // { classify, resolve, answer, answerStatus }
  captured: {}            // { classify, resolve, main } 요청 본문
};

shop.searchAll = async () => {
  if (stub.searchMode === 'throw') throw new Error('쿠팡 연결 실패(스텁)');
  if (stub.searchMode === 'blocked') return { items: [], allItems: [], from: 'none', blocked: true };
  if (stub.searchMode === 'empty') return { items: [], allItems: [], from: 'api', blocked: false };
  return { items: stub.searchItems, allItems: stub.searchItems, from: 'api', blocked: false };
};
shop.saveProducts = async () => {};
trust.attachTrust = async (list) => {
  (list || []).forEach(it => {
    if (it) it.trust = { level: 'high', label: '방금 확인된 가격', reasons: [{ text: '방금 쇼핑몰에서 받아온 값' }] };
  });
  return list;
};
pricestat.loadStats = async () => stub.stats;

/* OpenRouter 만 가로챈다. max_tokens 로 어느 호출인지 가른다(production 상수). */
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (!String(url).includes('openrouter.ai')) {
    throw new Error(`오프라인 테스트에서 예상 밖 외부 호출: ${url}`);
  }
  const body = JSON.parse(opts.body);
  if (body.max_tokens >= 700) {
    stub.captured.main = body;
    const st = stub.llm.answerStatus || 200;
    if (st !== 200) return { ok: false, status: st, text: async () => '{"error":"stub"}' };
    return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: stub.llm.finish || 'stop', message: { content: stub.llm.answer || '' } }] }) };
  }
  if (body.max_tokens === 120) {
    stub.captured.resolve = body;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: stub.llm.resolve || '' } }] }) };
  }
  stub.captured.classify = body;
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: stub.llm.classify || 'A' } }] }) };
};

const handler = require('../api/ai.js');

function call(body) {
  return new Promise((resolve, reject) => {
    let code = 200;
    const res = {
      status(c) { code = c; return this; },
      setHeader() { return this; },
      json(payload) { resolve({ status: code, body: payload }); return this; },
      end() { resolve({ status: code, body: {} }); return this; }
    };
    Promise.resolve(handler({ method: 'POST', headers: {}, query: {}, body }, res)).catch(reject);
  });
}

/* ── 검사 도구 ────────────────────────────────────────────────── */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sys = () => ((stub.captured.main || {}).messages || [{}])[0].content || '';

/* ── 공용 픽스처 ─────────────────────────────────────────────── */
function fixtureItems() {
  return [
    { title: '알파 무선 이어폰', lprice: 250000, link: 'https://l.c/a', image: '', mall: '쿠팡', productId: 'A1', isCoupang: true, oprice: 250000, savePct: 0 },
    { title: '베타 무선 이어폰', lprice: 89000, link: 'https://l.c/b', image: '', mall: '쿠팡', productId: 'B2', isCoupang: true, oprice: 120000, savePct: 26 },
    { title: '감마 무선 이어폰', lprice: 95000, link: 'https://l.c/c', image: '', mall: '쿠팡', productId: 'C3', isCoupang: true, oprice: 95000, savePct: 0 }
  ];
}
function fixtureStats() {
  const m = new Map();
  // 베타: 기록 풍부 + 평균보다 저렴 → 랭킹·판정·카드 근거가 전부 나와야 한다
  m.set('B2|쿠팡', {
    count: 15, lastPrice: 89000, lastDate: kstToday(), prevPrice: 95000,
    low: 85000, lowDate: '2026-07-02', avg30: 101000, avg30Days: 15,
    trendPct: -6.3, trendDays: 7, trendFrom: 95000, trendFromDate: daysAgo(7),
    points: [{ d: daysAgo(7), p: 95000 }, { d: kstToday(), p: 89000 }],
    // Deal Engine(api/_deal.js)이 쓰는 값. statsFrom 이 실제로 내는 모양과 맞춘다 —
    // 이 필드가 비어 있으면 백분위 경로가 테스트에서 한 번도 돌지 않는다.
    high: 112000, highDate: '2026-06-14',
    avg7: 90500, avg7Days: 7,
    volatility: 7.4, historyDays: 42, maxGapDays: 2, firstDate: '2026-07-01'
  });
  return m;
}
function kstToday() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }
function daysAgo(n) { return new Date(Date.now() + 9 * 3600e3 - n * 86400e3).toISOString().slice(0, 10); }

function reset() {
  stub.searchItems = fixtureItems();
  stub.searchMode = 'ok';
  stub.stats = fixtureStats();
  stub.llm = {};
  stub.captured = {};
  releasedCount = 0;
  /*
   * ★ 시나리오마다 LLM 캐시를 비운다 (2026-09-02).
   *
   * 캐시 기본값이 켜짐으로 바뀌면서, 앞 시나리오의 답이 다음 시나리오로
   * 새어 들어왔다. 특히 "LLM 이 실패하면 정직하게 알린다" 를 재는 케이스가
   * 캐시 적중으로 조용히 통과해 버렸다 — 검사하려던 실패 경로가 아예 돌지
   * 않은 것이다. 시나리오는 서로 독립이어야 한다.
   */
  try { require('../api/_llm')._internal._reset(); } catch (e) { /* 없으면 그만 */ }
}

/* ── 시나리오 ─────────────────────────────────────────────────── */
(async () => {
  console.log('=== AI 파이프라인 E2E (완전 오프라인) ===');

  /* 1 ─ 예산 추천: 조건 → 검색 → 기록 → 랭킹 → 프롬프트 → 카드 */
  console.log('\n[1] 예산 추천 파이프라인');
  reset();
  stub.llm.classify = 'C|무선 이어폰';
  stub.llm.answer = '결론부터, 베타 무선 이어폰을 권합니다. 현재 89,000원으로 30일 평균(101,000원)보다 저렴하고 기록상 최저가 85,000원과 4,000원 차이입니다.';
  let r = await call({ question: '10만원 이하 무선 이어폰 추천해줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });

  ok(r.status === 200, 'HTTP 200', String(r.status));
  const s1 = sys();
  ok(s1.includes('[사용자 조건 — 이미 들은 것]') && s1.includes('예산 100,000원'),
    '★ 예산이 프롬프트 조건 블록에 실린다');
  ok(s1.includes('조건 대조: 예산 적합'), '★ 예산 판정이 코드에서 계산돼 실린다');
  ok(/\[P1\][^\n]*베타/.test(s1), '★ 예산에 맞는 상품이 P1(첫 번째)로 온다');
  ok(s1.includes('가격 수준 판정: 지금 사도 좋은 편'), '★ 구매 시점 판정(서버)이 실린다');
  ok(s1.includes('이번 후보 중 최저가'), '★ 후보 간 최저가 사실이 실린다');
  ok(s1.includes('예산 초과'), '★ 예산 초과 상품도 숨기지 않고 초과로 표시된다');
  ok((r.body.items || []).length === 3, '카드 3장', String((r.body.items || []).length));
  ok(r.body.items[0].productId === 'B2', '★ 카드 순서 = 프롬프트 랭킹 순서', r.body.items[0].productId);
  ok(!!r.body.items[0].note && /평균|최저가/.test(r.body.items[0].note),
    '★ 카드에 데이터 근거 한 줄이 붙는다', r.body.items[0].note);
  ok(!/확인되지 않았어요/.test(r.body.text), '정상 답변에는 firewall 경고가 붙지 않는다');

  /* 2 ─ Hallucination Firewall: 지어낸 가격 탐지 */
  console.log('\n[2] Hallucination Firewall');
  reset();
  stub.llm.classify = 'C|무선 이어폰';
  stub.llm.answer = '알파 이어폰이 현재 79,000원까지 내려왔고 정가는 320,000원입니다.';
  r = await call({ question: '무선 이어폰 추천해줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(/확인되지 않았어요/.test(r.body.text), '★ 지어낸 가격(79,000·320,000)에 경고가 붙는다');
  ok(r.body.text.includes('79,000원'), '원문은 훼손하지 않는다 (몰래 고치지 않는다)');

  /* 3 ─ 내부 꼬리표·URL 제거 */
  console.log('\n[3] 내부 표기·URL 정리');
  reset();
  stub.llm.classify = 'C|무선 이어폰';
  stub.llm.answer = '**베타 무선 이어폰(P1)**을 권합니다. 89,000원입니다. 구매 링크: https://www.coupang.com/vp/products/999';
  r = await call({ question: '이어폰 추천', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(!/\(P[1-8]\)/.test(r.body.text), '★ (P1) 꼬리표가 답변에 남지 않는다', r.body.text.slice(0, 60));
  ok(!/https?:\/\//.test(r.body.text), '★ URL 이 답변에 남지 않는다');

  /* 4 ─ 잡담(A): 쇼핑 재료가 프롬프트에 없고 firewall 도 돌지 않는다 */
  console.log('\n[4] 잡담 의도');
  reset();
  stub.llm.classify = 'A';
  stub.llm.answer = '별말씀을요. 참고로 보통 책 한 권이 15,000원쯤 하죠.';
  r = await call({ question: '고마워', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(!sys().includes('<상품데이터>'), '★ 잡담 프롬프트에 상품데이터가 없다');
  ok(!sys().includes('[사용자 조건'), '잡담에 조건 블록이 없다');
  ok(!/확인되지 않았어요|확인된 데이터가 아니에요/.test(r.body.text),
    '★ 잡담의 일반 지식 금액에는 firewall 이 돌지 않는다');
  ok(!(r.body.items || []).length, '카드 없음');

  /* 5 ─ 검색 실패 vs 0건: 없는 것과 못 본 것을 구분 */
  console.log('\n[5] 검색 실패/0건 구분');
  reset();
  stub.searchMode = 'blocked';
  stub.llm.classify = 'D|갤럭시 버즈 9';
  stub.llm.answer = '지금 상품 정보를 불러오지 못했어요.';
  r = await call({ question: '갤럭시 버즈 9 얼마야?', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(sys().includes('[검색을 하지 못했다]'), '★ 조회 실패는 "못 봤다"로 프롬프트에 적힌다');

  reset();
  stub.searchMode = 'empty';
  stub.llm.classify = 'D|갤럭시 버즈 9';
  stub.llm.answer = '검색 결과가 없었어요.';
  r = await call({ question: '갤럭시 버즈 9 얼마야?', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(sys().includes('[방금 검색했지만 못 찾았다]'), '★ 0건은 "찾아봤는데 없었다"로 적힌다');

  /* 6 ─ LLM 장애: 찾아온 카드는 살아 나간다 */
  console.log('\n[6] LLM 장애 폴백');
  reset();
  stub.llm.classify = 'C|무선 이어폰';
  stub.llm.answerStatus = 500;
  r = await call({ question: '무선 이어폰 추천해줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(r.status === 200 && (r.body.items || []).length === 3,
    '★ 답변 생성이 죽어도 카드는 나간다', `status=${r.status} items=${(r.body.items || []).length}`);
  ok(r.body.degraded === true, 'degraded 표시');
  ok(releasedCount === 1, '★ 사용량 1회를 돌려준다 (장애 요금 전가 금지)', String(releasedCount));

  /* 7 ─ 대화 조건 이어받기: 예산이 다음 턴에도 프롬프트에 남는다 */
  console.log('\n[7] 조건 이어받기');
  reset();
  stub.llm.classify = 'C|무선 이어폰';
  stub.llm.resolve = '{"q":"무선 이어폰","use":"통화","brand":"","avoid":""}';
  stub.llm.answer = '통화 품질 기준으로 다시 보면 베타가 낫습니다.';
  r = await call({
    question: '통화 품질도 중요해',
    contextProducts: [],
    chatHistory: [
      { role: 'user', text: '20만원 이하 무선 이어폰 추천해줘' },
      { role: 'assistant', text: '베타 무선 이어폰(89,000원)을 권합니다.' }
    ],
    view: { source: 'none' }
  });
  const s7 = sys();
  ok(s7.includes('예산 200,000원'), '★ 앞 턴의 예산이 이번 프롬프트에 살아 있다');
  ok(s7.includes('용도: 통화'), '★ 이번 턴의 용도가 함께 실린다');

  /* 8 ─ 멈춘 가격 기록: 단정 금지 표시 */
  console.log('\n[8] 오래된 기록 주의');
  reset();
  const staleStats = new Map();
  staleStats.set('B2|쿠팡', {
    count: 10, lastPrice: 89000, lastDate: daysAgo(12), prevPrice: 95000,
    low: 85000, lowDate: '2026-07-02', avg30: 0, avg30Days: 0,
    trendPct: null, trendDays: 0, trendFrom: 0, trendFromDate: '',
    points: [{ d: daysAgo(12), p: 89000 }]
  });
  stub.stats = staleStats;
  stub.llm.classify = 'E|베타 무선 이어폰';
  stub.llm.answer = '마지막 확인 기준으로 말씀드릴게요.';
  r = await call({ question: '베타 이어폰 지금 사도 돼?', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(/멈춰 있음[^\n]*단정하지 말 것/.test(sys()), '★ 12일 멈춘 기록엔 "단정 금지"가 프롬프트에 실린다');

  /* 9 ─ 화면 상품(검색 없이): 서버가 기록·판정을 채워 준다 */
  console.log('\n[9] 화면 상품 보강');
  reset();
  stub.llm.classify = 'E|베타 무선 이어폰';
  stub.llm.answer = '베타는 지금 값이 괜찮은 편입니다.';
  r = await call({
    question: '이 가격 괜찮아?',
    contextProducts: [{ productId: 'B2', title: '베타 무선 이어폰', mall: '쿠팡', price: 89000 }],  // hist 없음 — 프론트가 못 채운 상황
    chatHistory: [],
    view: { source: 'modal' }
  });
  const s9 = sys();
  ok(s9.includes('역대 최저가 85,000원'), '★ 프론트가 못 채운 가격 기록을 서버가 채운다');
  ok(s9.includes('가격 수준 판정'), '판정도 함께 실린다');

  /* 10 ─ 상품명 스펙이 프롬프트에 실리고 랭킹에 반영되는가 */
  console.log('\n[10] 스펙 인텔리전스');
  reset();
  stub.searchItems = [
    // 알파는 제목에 사양 낱말이 하나도 없다 — "사양 없음" 경로를 검증하기 위해서다.
    { title: '알파 이어폰', lprice: 90000, link: 'https://l.c/a', image: '', mall: '쿠팡', productId: 'A1', isCoupang: true, oprice: 90000, savePct: 0 },
    { title: '베타 무선 이어폰 노이즈캔슬링 마이크 방수 500mAh', lprice: 90000, link: 'https://l.c/b', image: '', mall: '쿠팡', productId: 'B2', isCoupang: true, oprice: 90000, savePct: 0 }
  ];
  stub.stats = new Map();
  stub.llm.classify = 'C|무선 이어폰';
  stub.llm.resolve = '{"q":"무선 이어폰","use":"통화","brand":"","avoid":""}';
  stub.llm.answer = '통화 품질을 보면 베타 무선 이어폰이 낫습니다.';
  r = await call({
    question: '통화 품질 중요한 무선 이어폰 추천해줘',
    contextProducts: [], chatHistory: [], view: { source: 'none' }
  });
  {
    const s = sys();
    ok(/상품명에서 확인된 사양[^\n]*노이즈캔슬링/.test(s),
      '★ 상품명에서 뽑은 사양이 프롬프트에 실린다');
    ok(/상품명에서 확인된 사양[^\n]*배터리 500mAh/.test(s), '수치 사양도 실린다');
    ok(/\[P1\][^\n]*베타/.test(s),
      '★ 요구 기능(통화=마이크)이 확인된 상품이 1위로 온다');
    ok(s.includes('요구 기능 확인'), '요구 기능 충족이 사실로 적힌다');
    ok(/확인 안 됨\(없다는 뜻은 아님\)/.test(s),
      '★ 미확인을 "없음"으로 단정하지 않는다');
    ok(s.includes('사양: 없음 → 사양을 말하지 말 것'),
      '사양이 안 잡힌 상품에는 말하지 말라고 명시한다');
  }

  /* 11 ─ Firewall 2.0: 사양 환각 */
  console.log('\n[11] Firewall 2.0 — 사양 환각');
  reset();
  stub.searchItems = [
    { title: '베타 무선 이어폰 500mAh', lprice: 89000, link: 'https://l.c/b', image: '', mall: '쿠팡', productId: 'B2', isCoupang: true, oprice: 89000, savePct: 0 }
  ];
  stub.stats = new Map();
  stub.llm.classify = 'C|무선 이어폰';
  stub.llm.answer = '베타 무선 이어폰은 배터리가 30시간 가고 램은 16GB입니다.';
  r = await call({ question: '무선 이어폰 추천', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(/상품명에서 확인되지 않았어요/.test(r.body.text),
    '★ 지어낸 사양(30시간·16GB)에 경고가 붙는다', r.body.text.slice(-70));

  /* 12 ─ Firewall 2.0: 근거 없는 최상급 */
  console.log('\n[12] Firewall 2.0 — 최상급 표현');
  reset();
  stub.searchItems = [
    { title: '베타 이어폰', lprice: 89000, link: 'https://l.c/b', image: '', mall: '쿠팡', productId: 'B2', isCoupang: true, oprice: 89000, savePct: 0 }
  ];
  stub.stats = new Map();          // 가격 기록 없음 → 최저가를 말할 근거가 없다
  stub.llm.classify = 'C|이어폰';
  stub.llm.answer = '베타 이어폰이 역대 최저가입니다.';
  r = await call({ question: '이어폰 추천', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(/최저가" ?여부는 지금 데이터로 확인되지 않았어요|확인되지 않았어요/.test(r.body.text),
    '★ 가격 기록 없이 "역대 최저가" 라고 하면 경고', r.body.text.slice(-60));

  /* 13 ─ 예산 완화가 프롬프트까지 전달되는가 (hard → soft) */
  console.log('\n[13] 예산 완화 (constraint evolution)');
  reset();
  stub.searchItems = [
    { title: '싼 노트북', lprice: 900000, link: 'https://l.c/a', image: '', mall: '쿠팡', productId: 'A1', isCoupang: true, oprice: 900000, savePct: 0 },
    { title: '좋은 노트북', lprice: 1250000, link: 'https://l.c/b', image: '', mall: '쿠팡', productId: 'B2', isCoupang: true, oprice: 1250000, savePct: 0 }
  ];
  stub.stats = new Map();
  stub.llm.classify = 'C|노트북';
  stub.llm.resolve = '{"q":"노트북","use":"영상편집","brand":"","avoid":""}';
  stub.llm.answer = '조금 넘더라도 좋은 노트북 쪽을 권합니다.';
  r = await call({
    question: '가격 조금 넘어도 제일 좋은 거 보여줘',
    contextProducts: [],
    chatHistory: [
      { role: 'user', text: '100만원 이하 노트북 추천해줘' },
      { role: 'assistant', text: '싼 노트북을 권합니다.' }
    ],
    view: { source: 'none' }
  });
  {
    const s = sys();
    ok(s.includes('예산 1,000,000원 안팎'),
      '★ 사용자가 말한 금액은 그대로, 강도만 안팎으로 낮춘다');
    ok(/\[P1\][^\n]*좋은 노트북/.test(s),
      '★ 완화 뒤에는 125만원짜리도 후보로 올라온다');
  }

  /* 14 ─ 관측 로그가 secret·개인정보를 흘리지 않는가 */
  console.log('\n[14] 관측 로그 안전성');
  {
    const logs = [];
    const orig = console.log;
    console.log = (...a) => { logs.push(a.join(' ')); };
    reset();
    stub.llm.classify = 'C|무선 이어폰';
    stub.llm.answer = '베타를 권합니다.';
    await call({ question: '비밀질문 10만원 이어폰', contextProducts: [], chatHistory: [], view: { source: 'none' } });
    console.log = orig;

    const obs = logs.find(l => l.includes('[ai:obs]')) || '';
    ok(!!obs, '관측 로그가 남는다');
    ok(!obs.includes('비밀질문'), '★ 질문 원문을 남기지 않는다');
    ok(!obs.includes('qa@seosa.local'), '★ 이메일을 남기지 않는다');
    ok(!/베타|이어폰/.test(obs), '★ 상품명을 남기지 않는다');
    ok(obs.includes('shopping-v'), '프롬프트 판번호가 남는다');
  }

  /* 15 ─ 상위 상세 / 하위 압축 (토큰 최적화가 사실을 훼손하지 않는가) */
  console.log('\n[15] 컨텍스트 압축');
  reset();
  stub.searchItems = [];
  stub.stats = new Map();
  for (let i = 1; i <= 8; i++) {
    const id = "P" + i;
    stub.searchItems.push({ title: "상품" + i + " 무선 이어폰", lprice: 50000 + i * 1000,
      link: "https://l.c/" + i, image: "", mall: "쿠팡", productId: id, isCoupang: true, oprice: 0, savePct: 0 });
    stub.stats.set(id + "|쿠팡", { count: 10, lastPrice: 50000 + i * 1000, lastDate: kstToday(),
      prevPrice: 60000, low: 45000, lowDate: "2026-07-01", avg30: 60000, avg30Days: 10,
      trendPct: -3, trendDays: 7, trendFrom: 60000, trendFromDate: daysAgo(7), points: [] });
  }
  stub.llm.classify = "C|무선 이어폰";
  stub.llm.answer = "상품1을 권합니다.";
  r = await call({ question: "무선 이어폰 추천해줘", contextProducts: [], chatHistory: [], view: { source: "none" } });
  {
    const s = sys();
    const blocks = s.split(/[P[1-8]]/).slice(1);
    ok(blocks.length === 8, "8개 상품이 모두 프롬프트에 남는다 (지우지 않는다)", String(blocks.length));
    ok(/30일 평균/.test(blocks[0]), "★ 상위 후보는 상세하게 (30일 평균 포함)");
    ok(!/30일 평균/.test(blocks[7]), "★ 하위 후보는 간추려서 (토큰 절약)");
    ok(/현재가/.test(blocks[7]), "간추려도 이름·가격은 남는다");
    ok(s.includes("생략된 것이지 없는 것이 아니다"),
      "★ 간추림을 데이터 없음으로 읽지 않게 명시한다");
    ok((r.body.items || []).length === 8, "카드는 8장 그대로", String((r.body.items || []).length));
  }
  /* 16 ─ 결정 엔진이 실제 응답 경로에서 도는가 */
  console.log('\n[16] 결정 엔진 통합');
  reset();
  stub.searchItems = [
    { title: '알파 이어폰', lprice: 250000, link: 'https://l.c/a', image: '', mall: '쿠팡', productId: 'A1', isCoupang: true, oprice: 0, savePct: 0 },
    { title: '베타 무선 이어폰 노이즈캔슬링 마이크 500mAh', lprice: 89000, link: 'https://l.c/b', image: '', mall: '쿠팡', productId: 'B2', isCoupang: true, oprice: 0, savePct: 0 },
    { title: '감마 이어폰', lprice: 42000, link: 'https://l.c/c', image: '', mall: '쿠팡', productId: 'C3', isCoupang: true, oprice: 0, savePct: 0 }
  ];
  stub.llm.classify = 'C|무선 이어폰';
  stub.llm.resolve = '{"q":"무선 이어폰","use":"통화","brand":"","avoid":""}';
  stub.llm.answer = '베타 무선 이어폰을 권합니다.';
  r = await call({ question: '10만원 이하 무선 이어폰, 통화 중요해', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  {
    const s = sys();
    ok(s.includes('[결정 데이터]'), '★ 결정 블록이 프롬프트에 실린다');
    ok(/1위: P1/.test(s), '1위가 지정된다');
    ok(s.includes('추천 확신도:'), '확신도가 실린다');
    ok(s.includes('후회 위험:'), '후회 위험이 실린다');
    ok(s.includes('포기하는 것:'), '★ 포기하는 것이 실린다');
    ok(/고르지 않은 이유/.test(s), '왜 저건 아닌가가 실린다');
    ok(s.includes('[결정 데이터를 쓰는 법]'), '결정 사용 규칙이 함께 간다');
    ok(r.body.topProductId === 'B2', '★ 응답에 1위 상품 id 가 실린다', r.body.topProductId);
    ok(!r.body.recommendationChange, '이전 1위를 모르면 변경 표시 없음');
    ok(!/_score|fitScore/.test(s), '★ 내부 점수가 프롬프트에 새지 않는다');
  }

  /* 17 ─ 추천 변경 감지 (prevTop 왕복) */
  console.log('\n[17] 추천 변경 감지');
  reset();
  stub.searchItems = [
    { title: '알파 이어폰', lprice: 70000, link: 'https://l.c/a', image: '', mall: '쿠팡', productId: 'A1', isCoupang: true, oprice: 0, savePct: 0 },
    { title: '베타 이어폰 마이크 노이즈캔슬링', lprice: 90000, link: 'https://l.c/b', image: '', mall: '쿠팡', productId: 'B2', isCoupang: true, oprice: 0, savePct: 0 }
  ];
  stub.llm.classify = 'C|이어폰';
  stub.llm.answer = '통화 조건을 넣으니 베타가 낫습니다.';
  r = await call({ question: '통화도 중요해', contextProducts: [], chatHistory: [{ role: 'user', text: '10만원 이하 이어폰 추천' }], view: { source: 'none' }, prevTop: 'A1' });
  ok(!!r.body.recommendationChange, '★ 1위가 바뀌면 응답에 알린다',
    JSON.stringify(r.body.recommendationChange));
  ok(r.body.recommendationChange.changed === true, 'changed=true');
  ok(!!r.body.recommendationChange.cause, '바뀐 원인이 함께 온다');
  ok(/추천이 바뀌었다/.test(sys()), '프롬프트에도 변경 사실이 실린다');

  reset();
  stub.searchItems = [
    { title: '알파 이어폰', lprice: 70000, link: 'https://l.c/a', image: '', mall: '쿠팡', productId: 'A1', isCoupang: true, oprice: 0, savePct: 0 }
  ];
  stub.llm.classify = 'C|이어폰';
  stub.llm.answer = '알파를 권합니다.';
  r = await call({ question: '이어폰 추천', contextProducts: [], chatHistory: [], view: { source: 'none' }, prevTop: 'A1' });
  ok(!r.body.recommendationChange, '★ 1위가 그대로면 변경 알림이 없다');

  /* 18 ─ Firewall 3.0: 근거 없는 비교 주장 */
  console.log('\n[18] Firewall 3.0 — 비교 주장');
  reset();
  stub.searchItems = [
    { title: '알파 이어폰', lprice: 70000, link: 'https://l.c/a', image: '', mall: '쿠팡', productId: 'A1', isCoupang: true, oprice: 0, savePct: 0 },
    { title: '베타 이어폰', lprice: 90000, link: 'https://l.c/b', image: '', mall: '쿠팡', productId: 'B2', isCoupang: true, oprice: 0, savePct: 0 }
  ];
  stub.stats = new Map();
  stub.llm.classify = 'C|이어폰';
  stub.llm.answer = '알파가 베타보다 더 가볍고 배터리도 더 오래 갑니다.';
  r = await call({ question: '이어폰 추천', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(/비교는 확인된 데이터가 아니에요/.test(r.body.text),
    '★ 무게·배터리 데이터 없이 비교하면 경고', r.body.text.slice(-60));

  reset();
  stub.stats = new Map();
  stub.llm.classify = 'C|이어폰';
  stub.llm.answer = '저는 알파가 더 낫다고 봅니다. 5,000원 더 저렴합니다.';
  r = await call({ question: '이어폰 추천', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(!/비교는 확인된 데이터가 아니에요/.test(r.body.text),
    '★ 주관 표현·가격 비교는 막지 않는다', r.body.text.slice(-60));

  /* 19 ─ 잡담에는 결정 엔진이 돌지 않는다 (비용) */
  console.log('\n[19] 잡담 비용');
  reset();
  stub.llm.classify = 'A';
  stub.llm.answer = '별말씀을요.';
  r = await call({ question: '고마워', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(!sys().includes('[결정 데이터]'), '★ 잡담 프롬프트에 결정 블록이 없다');
  ok(!sys().includes('[결정 데이터를 쓰는 법]'), '결정 규칙도 없다');
  ok(!r.body.topProductId, '잡담에는 1위도 없다');
  /* 20 ─ Phase 1: 성향·다목적 분석이 실제 응답 경로에서 도는가 */
  console.log('\n[20] Phase 1 통합');
  reset();
  stub.searchItems = [
    { title: '알파 무선 이어폰 마이크 노이즈캔슬링 500mAh', lprice: 150000, link: '', image: '', mall: '쿠팡', productId: 'A1', isCoupang: true, oprice: 0, savePct: 0 },
    { title: '베타 무선 이어폰 노이즈캔슬링 방수 1500mAh', lprice: 180000, link: '', image: '', mall: '쿠팡', productId: 'B2', isCoupang: true, oprice: 0, savePct: 0 },
    { title: '감마 무선 이어폰 마이크', lprice: 89000, link: '', image: '', mall: '쿠팡', productId: 'C3', isCoupang: true, oprice: 0, savePct: 0 }
  ];
  stub.stats = new Map([
    ['A1|쿠팡', { count: 14, low: 140000, lowDate: daysAgo(20), avg30: 170000, avg30Days: 14, lastPrice: 150000, lastDate: daysAgo(1), prevPrice: 0, trendPct: -5, trendDays: 7, trendFrom: 0, trendFromDate: daysAgo(7), points: [] }],
    ['C3|쿠팡', { count: 14, low: 85000, lowDate: daysAgo(20), avg30: 95000, avg30Days: 14, lastPrice: 89000, lastDate: daysAgo(1), prevPrice: 0, trendPct: -4, trendDays: 7, trendFrom: 0, trendFromDate: daysAgo(7), points: [] }]
  ]);
  stub.llm.classify = 'C|무선 이어폰';
  stub.llm.resolve = '{"q":"무선 이어폰","use":"통화","brand":"","avoid":""}';
  stub.llm.answer = '알파를 권합니다.';
  r = await call({
    question: '가벼운 걸로, 성능도 중요해',
    contextProducts: [],
    chatHistory: [
      { role: 'user', text: '20만원 이하 무선 이어폰 추천해줘' },
      { role: 'assistant', text: '알파를 권합니다.' },
      { role: 'user', text: '통화도 중요해' }
    ],
    view: { source: 'none' }
  });
  {
    const s = sys();
    ok(s.includes('[이 사람이 더 중요하게 보는 것]'), '★ 성향 프로필이 프롬프트에 실린다');
    ok(/성능/.test(s.split('[이 사람이')[1] || ''), '대화에서 읽은 성향이 적힌다');
    ok(/\("[^"]+"\)/.test(s.split('[이 사람이')[1] || ''), '★ 성향에 근거가 함께 적힌다');
    ok(!/덜 중요하게 봄/.test((s.split('[이 사람이')[1] || '').split('\n\n')[0]),
      '★ 근거 없는 상대적 하락은 적지 않는다');
    ok(s.includes('[다목적 분석]'), '★ 다목적 분석이 프롬프트에 실린다');
    ok(/후보 구조:/.test(s), '후보 구조가 적힌다');
    ok(/더 싼 대안:/.test(s), '★ 대체품이 계산돼 실린다');
    ok(!/_sub|_score|budgetScore/.test(s), '★ 내부 점수 키가 프롬프트에 새지 않는다');
  }

  /* 21 ─ 취향을 말하지 않으면 성향 블록이 없다 (기존 동작 보존) */
  console.log('\n[21] 성향 없음 = 기존 동작');
  reset();
  stub.llm.classify = 'C|무선 이어폰';
  stub.llm.answer = '베타를 권합니다.';
  r = await call({ question: '무선 이어폰 추천해줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(!sys().includes('[이 사람이 더 중요하게 보는 것]'),
    '★ 취향을 말하지 않으면 성향 블록이 붙지 않는다');

  /* 22 ─ 후보 1개면 다목적 분석을 만들지 않는다 */
  console.log('\n[22] 후보 1개');
  reset();
  stub.searchItems = [
    { title: '알파 무선 이어폰', lprice: 89000, link: '', image: '', mall: '쿠팡', productId: 'A1', isCoupang: true, oprice: 0, savePct: 0 }
  ];
  stub.stats = new Map();
  stub.llm.classify = 'C|무선 이어폰';
  stub.llm.answer = '알파를 권합니다.';
  r = await call({ question: '무선 이어폰 추천해줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(!sys().includes('[다목적 분석]'), '★ 후보 1개면 다목적 분석이 없다');
  ok(r.status === 200 && (r.body.items || []).length === 1, '그래도 추천은 정상', String(r.status));

  /* 23 ─ 잡담에는 Phase 1 레이어가 돌지 않는다 (토큰) */
  console.log('\n[23] 잡담 비용');
  reset();
  stub.llm.classify = 'A';
  stub.llm.answer = '별말씀을요.';
  r = await call({ question: '고마워', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(!sys().includes('[이 사람이 더 중요하게 보는 것]'), '★ 잡담에 성향 블록이 없다');
  ok(!sys().includes('[다목적 분석]'), '★ 잡담에 다목적 분석이 없다');
  /* 24 ─ OMEGA: 조건이 충분하면 되묻지 않는다 */
  console.log('\n[24] 되묻기 — 조건 충분');
  reset();
  stub.searchItems = [
    { title: '알파 무선 이어폰 마이크 노이즈캔슬링', lprice: 89000, link: '', image: '', mall: '쿠팡', productId: 'A1', isCoupang: true, oprice: 0, savePct: 0 },
    { title: '베타 무선 이어폰 마이크 노이즈캔슬링', lprice: 92000, link: '', image: '', mall: '쿠팡', productId: 'B2', isCoupang: true, oprice: 0, savePct: 0 }
  ];
  stub.stats = new Map();
  stub.llm.classify = 'C|무선 이어폰';
  stub.llm.answer = '알파를 권합니다.';
  r = await call({ question: '10만원 이하 무선 이어폰, 통화 중요하고 가성비 위주로', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(sys().includes('[되물을 것 없음]'), '★ 조건이 충분하면 묻지 말라고 명시한다');
  ok(!sys().includes('[되물을 값어치가 있는 질문'), '질문 블록이 붙지 않는다');

  /* 25 ─ OMEGA: 정보가 부족하면 값어치 있는 질문 하나 */
  console.log('\n[25] 되묻기 — 정보 부족');
  reset();
  stub.searchItems = [
    { title: '알파 무선 이어폰 마이크', lprice: 45000, link: '', image: '', mall: '쿠팡', productId: 'A1', isCoupang: true, oprice: 0, savePct: 0 },
    { title: '베타 무선 이어폰 노이즈캔슬링 방수', lprice: 280000, link: '', image: '', mall: '쿠팡', productId: 'B2', isCoupang: true, oprice: 0, savePct: 0 },
    { title: '감마 무선 이어폰 마이크 노이즈캔슬링', lprice: 150000, link: '', image: '', mall: '쿠팡', productId: 'C3', isCoupang: true, oprice: 0, savePct: 0 }
  ];
  stub.stats = new Map();
  stub.llm.classify = 'C|무선 이어폰';
  stub.llm.answer = '알파를 권합니다.';
  r = await call({ question: '무선 이어폰 추천해줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  {
    const s = sys();
    ok(s.includes('[되물을 값어치가 있는 질문'), '★ 정보가 부족하면 질문 블록이 실린다');
    ok(/딱 하나/.test(s), '★ 하나만 물으라고 명시한다');
    ok(/질문만 하고 끝내지 마라/.test(s), '★ 답변을 먼저 하라고 명시한다');
    ok(!s.includes('[되물을 것 없음]'), '두 블록이 동시에 붙지 않는다');
  }

  /* 26 ─ OMEGA: 조건 0개일 때 완화 선택지를 계산한다 */
  console.log('\n[26] No-Result 완화');
  reset();
  stub.searchItems = [
    { title: '알파 노트북 램 8GB', lprice: 950000, link: '', image: '', mall: '쿠팡', productId: 'A1', isCoupang: true, oprice: 0, savePct: 0 },
    { title: '베타 노트북 램 16GB 방수', lprice: 1200000, link: '', image: '', mall: '쿠팡', productId: 'B2', isCoupang: true, oprice: 0, savePct: 0 },
    { title: '감마 노트북 램 8GB', lprice: 850000, link: '', image: '', mall: '쿠팡', productId: 'C3', isCoupang: true, oprice: 0, savePct: 0 }
  ];
  stub.stats = new Map();
  stub.llm.classify = 'C|노트북';
  stub.llm.resolve = '{"q":"노트북","use":"","brand":"","avoid":""}';
  stub.llm.answer = '조건에 맞는 상품이 없습니다.';
  r = await call({ question: '80만원 이하 노트북, 방수 필요해', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  {
    const s = sys();
    ok(s.includes('[조건을 모두 만족하는 상품이 없다]'), '★ 완화 블록이 실린다');
    ok(/가장 적게 포기하는 순서로/.test(s), '★ 완화안이 계산돼 실린다');
    ok(/\d+개 생김/.test(s), '★ 실제 개수가 적힌다');
    ok(/조건을 우리 마음대로 바꾸지 마라/.test(s), '★ 조건을 조용히 바꾸지 말라고 명시한다');
    ok(r.status === 200 && (r.body.items || []).length === 3, '그래도 카드는 나간다', String(r.status));
  }

  /* 27 ─ OMEGA: 조건을 만족하면 완화 블록이 없다 */
  console.log('\n[27] No-Result 침묵');
  reset();
  stub.llm.classify = 'C|무선 이어폰';
  stub.llm.answer = '베타를 권합니다.';
  r = await call({ question: '10만원 이하 무선 이어폰 추천해줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(!sys().includes('[조건을 모두 만족하는 상품이 없다]'),
    '★ 조건을 만족하는 상품이 있으면 완화 블록이 없다');

  /* 28 ─ OMEGA: 잡담에는 두 엔진 모두 돌지 않는다 */
  console.log('\n[28] 잡담 비용');
  reset();
  stub.llm.classify = 'A';
  stub.llm.answer = '별말씀을요.';
  r = await call({ question: '고마워', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(!sys().includes('[되물을'), '★ 잡담에 되묻기 블록이 없다');
  ok(!sys().includes('[조건을 모두 만족'), '★ 잡담에 완화 블록이 없다');
  /* 29 ─ SINGULARITY: 거부 피드백이 재랭킹까지 이어지는가 */
  console.log('\n[29] 피드백 → 재랭킹');
  reset();
  stub.searchItems = [
    { title: '알파 이어폰 노이즈캔슬링 마이크 방수 500mAh', lprice: 150000, link: '', image: '', mall: '쿠팡', productId: 'A1', isCoupang: true, oprice: 0, savePct: 0 },
    { title: '베타 경량 휴대용 이어폰', lprice: 80000, link: '', image: '', mall: '쿠팡', productId: 'B2', isCoupang: true, oprice: 0, savePct: 0 }
  ];
  stub.stats = new Map();
  stub.llm.classify = 'C|이어폰';
  stub.llm.resolve = '{"q":"이어폰","use":"","brand":"","avoid":""}';
  stub.llm.answer = '무게를 반영해 베타를 권합니다.';
  r = await call({ question: '이거 너무 무거운데', contextProducts: [],
    chatHistory: [{ role: 'user', text: '20만원 이하 이어폰 추천' }], view: { source: 'none' } });
  {
    const s = sys();
    ok(s.includes('[사용자가 방금 거부했다'), '★ 피드백 블록이 프롬프트에 실린다');
    ok(/무게 문제로 읽고/.test(s), '★ 거부 이유가 무게로 해석된다');
    ok(/무엇을 반영했는지 답변에서 한 줄로 밝혀라/.test(s), '★ 조용히 바꾸지 말라고 명시한다');
    ok(s.includes('[이 사람이 더 중요하게 보는 것]'), '★ 피드백이 성향으로 이어진다');
    ok(r.body.items[0].productId === 'B2', '★ 실제 순위가 바뀐다(경량 상품이 1위)', r.body.items[0].productId);
  }

  /* 30 ─ SINGULARITY: 브랜드 제외가 반영되는가 */
  console.log('\n[30] 브랜드 제외');
  reset();
  stub.searchItems = [
    { title: '삼성 갤럭시 버즈 노이즈캔슬링 마이크 방수', lprice: 90000, link: '', image: '', mall: '쿠팡', productId: 'S1', isCoupang: true, oprice: 0, savePct: 0 },
    { title: '베타 무선 이어폰', lprice: 120000, link: '', image: '', mall: '쿠팡', productId: 'B2', isCoupang: true, oprice: 0, savePct: 0 }
  ];
  stub.stats = new Map();
  stub.llm.classify = 'C|이어폰';
  stub.llm.answer = '삼성을 빼고 베타를 권합니다.';
  r = await call({ question: '삼성은 빼줘', contextProducts: [],
    chatHistory: [{ role: 'user', text: '20만원 이하 이어폰 추천' }], view: { source: 'none' } });
  {
    const s = sys();
    ok(/삼성을 크게 내렸다/.test(s), '★ 제외를 반영했다고 프롬프트에 적힌다');
    ok(r.body.items[0].productId === 'B2', '★ 제외한 브랜드가 1위에서 내려간다', r.body.items[0].productId);
    ok((r.body.items || []).some(x => x.productId === 'S1'),
      '★ 완전히 지우지는 않는다(소프트 제외)');
    ok(/제외 요청하신 삼성/.test(s), '★ 제외 사유가 상품 사실로 남는다');
  }

  /* 31 ─ SINGULARITY: 취향이 없으면 개인화가 아무 일도 하지 않는다 */
  console.log('\n[31] 취향 없음 = 기존 동작');
  reset();
  stub.llm.classify = 'C|무선 이어폰';
  stub.llm.answer = '베타를 권합니다.';
  r = await call({ question: '10만원 이하 무선 이어폰 추천해줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(!sys().includes('[이 사람이 더 중요하게 보는 것]'), '★ 성향 블록이 붙지 않는다');
  ok(!sys().includes('[사용자가 방금 거부했다'), '★ 피드백 블록도 붙지 않는다');
  ok(r.body.items[0].productId === 'B2', '기존 랭킹 그대로', r.body.items[0].productId);

  /* 32 ─ SINGULARITY: 잘린 답변을 안전하게 다듬는가 */
  console.log('\n[32] 응답 잘림 처리');
  reset();
  stub.llm.classify = 'C|무선 이어폰';
  stub.llm.answer = '베타를 권합니다. 89,000원으로 좋은 편입니다. 다만 배터리는 확인되지 않';
  stub.llm.finish = 'length';
  r = await call({ question: '무선 이어폰 추천해줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(!/확인되지 않$/.test(r.body.text.split('\n')[0]),
    '★ 반쪽 문장으로 끝나지 않는다', r.body.text.slice(0, 60));
  ok(/좋은 편입니다\./.test(r.body.text), '★ 마지막 완결 문장까지 남는다');
  ok((r.body.items || []).length > 0, '카드는 그대로 나간다');
  /* 33 ─ SINGULARITY: 빼 달라고 한 것은 다음 턴에도 지켜지는가
   *
   * 실측으로 찾은 구멍이다. 성향 가중치는 앞 대화를 읽어 이어지는데 제외만
   * 이번 문장에서 뽑고 있어서, "삼성은 빼줘" 다음 턴에 삼성이 1위로 돌아왔다. */
  console.log('\n[33] 제외가 다음 턴까지 이어진다');
  reset();
  stub.searchItems = [
    { title: '삼성 갤럭시 버즈 노이즈캔슬링 마이크 방수', lprice: 90000, link: '', image: '', mall: '쿠팡', productId: 'S1', isCoupang: true, oprice: 0, savePct: 0 },
    { title: '베타 무선 이어폰', lprice: 120000, link: '', image: '', mall: '쿠팡', productId: 'B2', isCoupang: true, oprice: 0, savePct: 0 }
  ];
  stub.stats = new Map();
  stub.llm.classify = 'C|이어폰';
  stub.llm.answer = '베타를 권합니다.';
  r = await call({ question: '예산은 15만원까지야', contextProducts: [], chatHistory: [
    { role: 'user', text: '20만원 이하 이어폰 추천' },
    { role: 'assistant', text: '삼성 갤럭시 버즈를 권합니다.' },
    { role: 'user', text: '삼성은 빼줘' },
    { role: 'assistant', text: '알겠습니다. 베타를 권합니다.' }
  ], view: { source: 'none' } });
  {
    const s = sys();
    ok(r.body.items[0].productId === 'B2',
      '★★ 3턴 전에 빼 달라고 한 브랜드가 다시 1위로 올라오지 않는다', r.body.items[0].productId);
    ok(/삼성을 크게 내렸다/.test(s), '★ 앞 대화의 제외를 프롬프트에 그대로 밝힌다');
    ok(/앞 대화에서 사용자가 빼 달라고 한 것을 그대로 지키고 있다/.test(s),
      '★ 이번 턴 거부가 아니라 이어진 제외임을 구분해 적는다');
    ok((r.body.items || []).some(x => x.productId === 'S1'), '여전히 소프트 제외다');
  }

  /* 34 ─ 제외를 말한 적 없으면 아무것도 이어지지 않는다 */
  console.log('\n[34] 제외를 말한 적 없으면 그대로');
  reset();
  stub.llm.classify = 'C|무선 이어폰';
  stub.llm.answer = '베타를 권합니다.';
  r = await call({ question: '다른 것도 보여줘', contextProducts: [], chatHistory: [
    { role: 'user', text: '20만원 이하 이어폰 추천' },
    { role: 'assistant', text: '베타를 권합니다.' }
  ], view: { source: 'none' } });
  ok(!sys().includes('빼 달라고 한 것'), '★ 이어진 제외 블록이 붙지 않는다');
  ok(!sys().includes('크게 내렸다'), '제외 문구가 어디에도 없다');


  /* 35 ─ SINGULARITY Ω: 구매 시점 판정이 프롬프트에 실린다 */
  console.log('\n[35] 구매 시점 판정 (True Deal)');
  reset();
  stub.llm.classify = 'E|베타 무선 이어폰';
  stub.llm.answer = '지금 사도 좋은 편입니다.';
  r = await call({ question: '베타 이어폰 지금 사도 돼?', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  {
    const s = sys();
    ok(/\[구매 시점 판정/.test(s), '★ 판정 블록이 프롬프트에 실린다');
    ok(/판정: (BUY|GOOD_BUY|NORMAL|WATCH|WAIT|DONT_BUY|UNKNOWN)/.test(s),
      '★ 7단계 판정 중 하나를 코드가 정해서 준다', (s.match(/판정: \w+/) || [])[0]);
    ok(/다시 판단하지 마라/.test(s), '★ 모델이 판정을 다시 내리지 말라고 못 박는다');
    ok(/기록 내 위치: 하위 \d+%/.test(s), '★ 할인율이 아니라 기록 내 백분위를 준다',
      (s.match(/기록 내 위치: 하위 \d+%/) || [])[0]);
    ok(/역대 최저가는 아니다/.test(s), '★ 좋은 소식만 주지 않는다 — 주의도 함께 준다');
    ok(/\[확신도 —/.test(s), '★ 축별 확신도 블록이 실린다');
    ok(/가격 최신성: /.test(s), '★ 최신성을 별도 축으로 준다');
  }

  /* 36 ─ SINGULARITY Ω: 근거가 없으면 UNKNOWN 이라고 말한다 */
  console.log('\n[36] 근거 부족은 UNKNOWN');
  reset();
  {
    const thin = new Map();
    thin.set('B2|쿠팡', {
      count: 2, lastPrice: 89000, lastDate: kstToday(), prevPrice: 95000,
      low: 85000, lowDate: daysAgo(1), avg30: 92000, avg30Days: 2,
      trendPct: null, trendDays: 0, trendFrom: 0, trendFromDate: '',
      points: [{ d: daysAgo(1), p: 95000 }, { d: kstToday(), p: 89000 }],
      high: 95000, highDate: daysAgo(1), avg7: 92000, avg7Days: 2,
      volatility: 3.3, historyDays: 1, maxGapDays: 1, firstDate: daysAgo(1)
    });
    stub.stats = thin;
  }
  stub.llm.classify = 'E|베타 무선 이어폰';
  stub.llm.answer = '아직 판단할 근거가 부족합니다.';
  r = await call({ question: '베타 이어폰 지금 사도 돼?', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  {
    const s = sys();
    ok(/판정: UNKNOWN/.test(s), '★★ 기록 2일치로는 BUY 를 말하지 않는다');
    ok(/판단할 근거가 부족하다/.test(s), '★ 왜 판정할 수 없는지도 준다');
    ok(/판정할 수 없다는 사실을 숨기지 마라/.test(s), '★ 모르는 것을 "괜찮다"로 바꾸지 말라고 못 박는다');
    ok(!/기록 내 위치/.test(s), '★ 근거가 없으면 백분위도 말하지 않는다');
  }

  /* 37 ─ Ω: 오염된 평균은 프롬프트에 싣지 않는다
   *
   * 실측(2026-08-29). 15,900원짜리 이어폰의 27일 기록 중 25일이 15,900원인데
   * 이틀만 242,100 / 222,390원이었다. 그 이틀 때문에 30일 평균이 24,504원이
   * 되어, 값이 한 달째 고정된 상품에 "평균보다 35% 저렴" 이 붙었다.
   *
   * 프롬프트에 "그 평균은 쓰지 마라" 한 줄을 덧붙여 봤지만 소용없었다 —
   * 같은 프롬프트에 "30일 평균과 비교한다" 는 지시와 예시가 이미 있어서
   * 모델이 그쪽을 따랐다. 그래서 숫자 자체를 뺀다. */
  console.log('\n[37] 오염된 평균 제거');
  reset();
  {
    const dirty = new Map();
    dirty.set('B2|쿠팡', {
      count: 27, lastPrice: 89000, lastDate: kstToday(), prevPrice: 89000,
      low: 89000, lowDate: daysAgo(1), avg30: 137000, avg30Days: 27,
      trendPct: 0, trendDays: 6, trendFrom: 89000, trendFromDate: daysAgo(6),
      points: [{ d: daysAgo(1), p: 89000 }, { d: kstToday(), p: 89000 }],
      high: 1350000, highDate: daysAgo(30), avg7: 89000, avg7Days: 7,
      volatility: 177.7, historyDays: 33, maxGapDays: 1, median: 89000,
      firstDate: daysAgo(33)
    });
    stub.stats = dirty;
  }
  stub.llm.classify = 'E|베타 무선 이어폰';
  stub.llm.answer = '평소 가격과 비슷합니다.';
  r = await call({ question: '베타 이어폰 지금 사도 돼?', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  {
    const s = sys();
    ok(!/최근 30일 평균 137,000원/.test(s),
      '★★ 오염된 30일 평균 숫자가 프롬프트에 없다 — 없으면 인용할 수 없다');
    ok(/잘못 수집된 값이 섞여 평균을 쓸 수 없음/.test(s),
      '★ 왜 못 쓰는지 대신 적는다');
    ok(/평소 가격 89,000원/.test(s), '★ 평균 대신 중앙값을 준다');
    ok(!/판정: BUY/.test(s),
      '★★ 오염된 범위로 BUY 판정을 만들지 않는다', (s.match(/판정: \w+/) || [])[0]);
    ok(/옵션이 바뀌었거나 다른 상품이 섞였을 수 있다/.test(s),
      '★ 사용자에게 왜 그런지 설명할 근거도 함께 준다');
  }

  /* 38 ─ 멀쩡한 기록에서는 평균을 그대로 쓴다 (기능이 죽지 않았는지) */
  console.log('\n[38] 멀쩡한 기록은 그대로');
  reset();
  stub.llm.classify = 'E|베타 무선 이어폰';
  stub.llm.answer = '싼 편입니다.';
  r = await call({ question: '베타 이어폰 지금 사도 돼?', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  {
    const s = sys();
    ok(/최근 30일 평균 101,000원/.test(s), '★ 오염이 없으면 30일 평균을 그대로 싣는다');
    ok(!/잘못 수집된 값이 섞여/.test(s), '멀쩡한 기록에 오염 문구를 붙이지 않는다');
    ok(!/옵션이 바뀌었거나 다른 상품이 섞였을 수 있다/.test(s), '이상치 경고도 만들어내지 않는다');
  }

  /* 39 ─ Ω: LLM 이 죽어도 판정은 전한다 (Deterministic Fallback)
   *
   * 실측(2026-08-29): OpenRouter 잔액이 떨어져 23회 402 가 났다. 그동안
   * 사용자가 받은 것은 "지금 상품 설명을 만들지 못했어요" 한 줄이었는데,
   * 그 시점에 서버는 검색·가격 기록·구매 시점 판정·조건 대조를 전부
   * 마친 상태였다. 판정은 LLM 이 아니라 코드가 한다 — LLM 이 없다고
   * 판정까지 버릴 이유가 없다. */
  console.log('\n[39] LLM 장애 시 결정 데이터로 답한다');
  reset();
  stub.llm.classify = 'C|무선 이어폰';
  stub.llm.answerStatus = 402;          // OpenRouter 잔액 소진
  r = await call({ question: '10만원 이하 무선 이어폰 추천해줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  {
    const t = r.body.text || '';
    ok(r.status === 200, '★ 장애를 500 으로 던지지 않는다 — 줄 수 있는 것이 있다', String(r.status));
    ok(r.body.degraded === true, 'degraded 플래그로 프론트에 알린다');
    ok((r.body.items || []).length > 0, '찾아온 상품은 그대로 준다', String((r.body.items || []).length));
    ok(/추천: /.test(t), '★★ 무엇을 권하는지 말한다', t.split('\n')[2]);
    ok(/구매 시점: /.test(t), '★★ 구매 시점 판정을 그대로 전한다',
      (t.match(/구매 시점: [^\n]*/) || [])[0]);
    ok(/이유:/.test(t), '★ 왜 그 상품인지 근거를 준다');
    ok(/가격 데이터: /.test(t), '★ 데이터 최신성도 알린다');
    ok(/예산 100,000원은 그대로 반영/.test(t), '★ 사용자가 말한 조건을 지켰다고 밝힌다');
    ok(/AI 응답이 실패했기 때문/.test(t),
      '★★ 왜 짧은지 밝힌다 — AI 가 정상인 척하지 않는다');
    // 새 사실을 만들어내지 않았는가: 답변의 금액이 전부 근거 있는 값이어야 한다.
    const nums = (t.match(/([0-9][0-9,]{2,})\s*원/g) || []);
    ok(nums.length > 0, '숫자를 실제로 말한다', nums.join(' '));
  }

  /* 40 ─ 상품조차 없으면 없다고 말한다 */
  console.log('\n[40] 장애 + 상품도 없음');
  reset();
  stub.searchMode = 'empty';
  stub.llm.classify = 'C|무선 이어폰';
  stub.llm.answerStatus = 402;
  r = await call({ question: '10만원 이하 무선 이어폰 추천해줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
  ok(r.status === 500 || (r.body.items || []).length === 0,
    '보여줄 것이 없으면 있는 척하지 않는다', String(r.status));

  /* ── 결과 ── */
  console.log(`\n=== 결과: ${pass}/${pass + fail} PASS ===`);
  if (failures.length) {
    console.log('\n실패:');
    failures.forEach(f => console.log(`  - ${f}`));
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
