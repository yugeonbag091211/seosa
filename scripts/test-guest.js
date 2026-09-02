#!/usr/bin/env node
/**
 * 게스트 AI · 정규식 의도 분류 · 수요 기반 셀렉션 — 완전 오프라인 (외부 호출 0회).
 *
 *   node scripts/test-guest.js
 *
 * ── 무엇을 지키는가 ────────────────────────────────────────────
 *   ① api/_intent.classify — 사용자 문장을 LLM 없이 A~E 로 가르고 검색어를 뽑는다
 *   ② api/ai.js 게스트 경로 — 토큰이 없으면 200 + 조립본 + 카드, LLM 호출 0회
 *   ③ 토큰이 "있는데 틀린" 요청은 그대로 401 (게스트로 떨어뜨리지 않는다)
 *   ④ 게스트는 쿼터를 예약하지 않는다
 *   ⑤ api/_picks.demandPicks — 수요 키워드 우선, 큐레이션으로 보충, 중복 없음
 *
 * ── 안전성 ───────────────────────────────────────────────────────
 * OpenRouter 0회 / 쿠팡 0회 / 운영 Supabase 0회. fetch 는 부르는 순간 던진다.
 */
'use strict';

const path = require('path');
const Module = require('module');

process.env.AUTH_SECRET = 'test-secret-guest';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;

/* ── 가짜 Supabase (닿으면 실패) ─────────────────────────────── */
const supabasePath = path.resolve(__dirname, '..', 'api', '_supabase.js');
const touched = [];
const fakeSupabase = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'then') return undefined;
    touched.push(String(prop));
    throw new Error(`오프라인 테스트에서 Supabase 접근: ${String(prop)}`);
  }
});
const realLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === './_supabase' || request === '../api/_supabase' || request === supabasePath) return fakeSupabase;
  return realLoad.apply(this, arguments);
};

/* ── 외부 호출 차단 ─────────────────────────────────────────── */
let fetchCalls = 0;
global.fetch = async (url) => { fetchCalls++; throw new Error(`오프라인 테스트에서 외부 호출: ${url}`); };

/* ── 검색·신뢰도·가격기록 스텁 ──────────────────────────────── */
const http = require('../api/_http');
http.applyCors = () => true;
http.noStore = () => {};
const rl = require('../api/_ratelimit');
rl.guard = () => true;
const plan = require('../api/_plan');
let reserveCalls = 0;
plan.resolvePlan = async () => { throw new Error('게스트는 요금제를 조회하지 않아야 한다'); };
plan.reserve = async () => { reserveCalls++; return { allowed: true, used: 1 }; };
plan.release = async () => {};

const shop = require('../api/_shop');
const trust = require('../api/_trust');
const pricestat = require('../api/_pricestat');

const stub = { searchItems: [], searchMode: 'ok', stats: new Map(), searchCalls: 0 };
shop.searchAll = async () => {
  stub.searchCalls++;
  if (stub.searchMode === 'blocked') return { items: [], allItems: [], from: 'none', blocked: true };
  if (stub.searchMode === 'empty') return { items: [], allItems: [], from: 'api', blocked: false };
  return { items: stub.searchItems, allItems: stub.searchItems, from: 'api', blocked: false };
};
shop.saveProducts = async () => {};
trust.attachTrust = async list => {
  (list || []).forEach(it => { if (it) it.trust = { level: 'high', label: '방금 확인된 가격', reasons: [{ text: '방금 쇼핑몰에서 받아온 값' }] }; });
  return list;
};
pricestat.loadStats = async () => stub.stats;

const handler = require('../api/ai.js');
const { classify, extractQuery } = require('../api/_intent.js');
const { demandPicks } = require('../api/_picks.js');
const { issueToken } = require('../api/_auth');
const { statsFrom } = require('../api/_pricestat.js');

/* ── 검사 도구 ───────────────────────────────────────────────── */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t) { console.log(`\n── ${t} ──`); }

function call(body, headers) {
  return new Promise((resolve, reject) => {
    let code = 200;
    const res = {
      status(c) { code = c; return this; },
      setHeader() { return this; },
      json(payload) { resolve({ status: code, body: payload }); return this; },
      end() { resolve({ status: code, body: {} }); return this; }
    };
    Promise.resolve(handler({ method: 'POST', headers: headers || {}, query: {}, body, socket: { remoteAddress: '10.0.0.1' } }, res)).catch(reject);
  });
}

const daysAgo = n => new Date(Date.now() + 9 * 3600e3 - n * 86400e3).toISOString().slice(0, 10);

function fixtureItems() {
  return [
    { productId: '1001', mall: '쿠팡', title: 'QCY T13 무선 블루투스 이어폰 노이즈캔슬링 통화 마이크', lprice: 29900, oprice: 39900, savePct: 25, link: 'https://www.coupang.com/vp/1001', image: 'https://img.example/1.jpg', isCoupang: true },
    { productId: '1002', mall: '쿠팡', title: '소니 WF-1000XM5 노이즈캔슬링 무선 이어폰', lprice: 289000, oprice: 359000, savePct: 19, link: 'https://www.coupang.com/vp/1002', image: 'https://img.example/2.jpg', isCoupang: true },
    { productId: '1003', mall: '쿠팡', title: '브리츠 BZ-TWS6 블루투스 이어폰', lprice: 19900, oprice: 19900, savePct: 0, link: 'https://www.coupang.com/vp/1003', image: '', isCoupang: true }
  ];
}
function fixtureStats() {
  const m = new Map();
  const series = (base, n) => Array.from({ length: n }, (_, i) => ({ date: daysAgo(n - 1 - i), price: base + (i % 3) * 500 }));
  m.set('1001|쿠팡', statsFrom(series(29900, 20)));
  m.set('1002|쿠팡', statsFrom(series(299000, 20)));
  return m;
}

(async () => {
  console.log('=== 게스트 AI · 정규식 의도 · 수요 셀렉션 (외부 호출 0회) ===');

  /* ══════════════════════════════════════════════════════════
     ① 정규식 의도 분류
     ══════════════════════════════════════════════════════════ */
  section('1. api/_intent.classify — 의도');
  const INTENT_GOLDEN = [
    ['안녕', 'A'], ['고마워!', 'A'], ['ㅋㅋㅋ', 'A'],
    ['20만원 이하 가성비 무선 이어폰 추천해줘', 'C'],
    ['엄마 드릴 안마기 뭐가 좋아?', 'C'],
    ['노트북', 'C'],
    ['대학생 노트북 사려고 하는데', 'C'],
    ['추천해줘', 'C'],
    ['삼성 버즈3 vs 에어팟 프로2 비교해줘', 'C'],
    ['아이폰 16 최저가 얼마야', 'D'],
    ['로지텍 마우스 요즘 가격 어때', 'D'],
    ['캠핑용 아이스박스 어디서 사는 게 싸', 'D'],
    ['LG 그램 14 지금 사도 돼?', 'E'],
    ['이거 지금 사도 괜찮은 가격인가요?', 'E'],
    ['기다리면 더 떨어질까', 'E'],
    ['이 가격 추이가 어때', 'E'],
    ['무선 이어폰이랑 헤드폰 차이가 뭐야', 'B'],
    ['노트북 고를 때 어떻게 골라야 해', 'B']
  ];
  INTENT_GOLDEN.forEach(([q, want]) => {
    const r = classify(q);
    ok(r.intent === want, `"${q}" → ${want}`, r.intent === want ? '' : `실제 ${r.intent}`);
  });

  section('2. api/_intent.extractQuery — 검색어');
  const QUERY_GOLDEN = [
    ['20만원 이하 가성비 무선 이어폰 추천해줘', '무선 이어폰'],
    ['엄마 드릴 안마기 뭐가 좋아?', '안마기'],
    ['LG 그램 14 지금 사도 돼?', 'LG 그램 14'],
    ['아이폰 16 최저가 얼마야', '아이폰 16'],
    ['로지텍 마우스 요즘 가격 어때', '로지텍 마우스'],
    ['10만원 이하로', ''],
    ['추천해줘', ''],
    ['이거 지금 사도 괜찮은 가격인가요?', ''],
    ['200,000원 이내 노트북', '노트북']
  ];
  QUERY_GOLDEN.forEach(([q, want]) => {
    const got = extractQuery(q);
    ok(got === want, `"${q}" → "${want}"`, got === want ? '' : `실제 "${got}"`);
  });

  section('3. 문맥 이어받기 · 형식');
  {
    const r = classify('10만원 이하로', [{ role: 'user', text: '무선 이어폰 추천해줘' }, { role: 'assistant', text: '…' }]);
    ok(r.intent === 'C' && r.query === '무선 이어폰', '검색어가 비면 앞 사용자 발화에서 이어받는다', JSON.stringify(r));
    const r2 = classify('추천해줘', []);
    ok(r2.intent === 'C' && r2.query === '', '이어받을 것이 없으면 검색어를 비운다', JSON.stringify(r2));
    const r3 = classify('안녕', [{ role: 'user', text: '무선 이어폰 추천해줘' }]);
    ok(r3.intent === 'A' && r3.query === '', '잡담에는 검색어를 붙이지 않는다');
    ok(classify('').intent === 'A', '빈 문장 → A');
    ok(classify('<script>alert(1)</script> 노트북 추천').query.indexOf('<') === -1, '검색어에 꺾쇠가 남지 않는다');
    ok(extractQuery('a'.repeat(200)).length <= 40, '검색어 길이 상한');
    ok(JSON.stringify(classify('노트북 추천해줘')) === JSON.stringify(classify('노트북 추천해줘')), '결정적이다');
  }

  /* ══════════════════════════════════════════════════════════
     ② 게스트 핸들러
     ══════════════════════════════════════════════════════════ */
  section('4. 게스트 — 토큰 없음 → 조립본 + 카드, LLM 0회');
  {
    stub.searchItems = fixtureItems(); stub.searchMode = 'ok'; stub.stats = fixtureStats(); stub.searchCalls = 0; fetchCalls = 0; reserveCalls = 0;
    const r = await call({ question: '10만원 이하 통화 되는 무선 이어폰 추천해줘', contextProducts: [], chatHistory: [], view: { source: 'none' } });
    ok(r.status === 200, '200', String(r.status));
    ok(r.body.guest === true, 'guest:true');
    ok(r.body.needsAuthForFull === true, 'needsAuthForFull:true');
    ok(fetchCalls === 0, '★ 외부 호출(OpenRouter) 0회', String(fetchCalls));
    ok(reserveCalls === 0, '★ 쿼터 예약 0회', String(reserveCalls));
    ok(stub.searchCalls === 1, '검색은 1회 돈다', String(stub.searchCalls));
    ok(Array.isArray(r.body.items) && r.body.items.length === 3, '카드 3장', String(r.body.items && r.body.items.length));
    ok(/추천:/.test(r.body.text), '조립본 결론("추천:")이 있다', r.body.text.slice(0, 60));
    ok(/예산 100,000원/.test(r.body.text), '예산이 반영됐다고 밝힌다');
    ok(r.body.items[0].productId === '1001' || r.body.items[0].productId === '1003', '예산 안 상품이 1위 카드', r.body.items[0].productId);
    ok(Array.isArray(r.body.followups) && r.body.followups.length > 0, '후속 질문이 있다', String(r.body.followups && r.body.followups.length));
    ok(!('usage' in r.body) || r.body.usage == null, '게스트에는 사용량이 없다');
    ok(!/\[P\d\]/.test(r.body.text) && !/\(P\d\)/.test(r.body.text), '★ 내부 꼬리표([P2]·(P2))가 새지 않는다', r.body.text.replace(/\n/g, ' ').slice(0, 200));
    ok(r.body.text.indexOf('<') === -1, 'HTML 이 섞이지 않는다');
  }

  section('5. 게스트 — 잡담·지식·빈 검색');
  {
    stub.searchCalls = 0; fetchCalls = 0;
    const a = await call({ question: '안녕', contextProducts: [], chatHistory: [] });
    ok(a.status === 200 && a.body.guest === true, '인사 → 200 게스트');
    ok(stub.searchCalls === 0, '인사에는 검색하지 않는다');
    ok(/찾으시는 상품/.test(a.body.text), '안내 문구', a.body.text.slice(0, 40));

    const b = await call({ question: '무선 이어폰이랑 헤드폰 차이가 뭐야', contextProducts: [], chatHistory: [] });
    ok(b.status === 200 && /로그인/.test(b.body.text), '지식 질문 → 로그인 안내', b.body.text.slice(0, 40));
    ok(stub.searchCalls === 0, '지식 질문에는 검색하지 않는다');

    const c = await call({ question: '추천해줘', contextProducts: [], chatHistory: [] });
    ok(c.status === 200 && /어떤 상품/.test(c.body.text), '품목 없는 추천 요청 → 되묻는다', c.body.text.slice(0, 40));
    ok(fetchCalls === 0, '외부 호출 0회 유지');
  }

  section('6. 게스트 — 검색 실패·0건을 구분한다');
  {
    stub.searchMode = 'blocked';
    const f = await call({ question: '노트북 추천해줘', contextProducts: [], chatHistory: [] });
    ok(f.status === 200 && /실패/.test(f.body.text), '차단 → "조회 실패" (없다고 단정하지 않는다)', f.body.text.slice(0, 40));
    stub.searchMode = 'empty';
    const e = await call({ question: '노트북 추천해줘', contextProducts: [], chatHistory: [] });
    ok(e.status === 200 && /찾지 못했어요/.test(e.body.text) && /노트북/.test(e.body.text), '0건 → 검색어와 함께 못 찾았다고 말한다', e.body.text.slice(0, 50));
    stub.searchMode = 'ok';
  }

  section('7. 게스트 — 가격 모달 맥락은 검색하지 않고 그 상품을 판정한다');
  {
    stub.searchCalls = 0;
    const st = fixtureStats().get('1001|쿠팡');
    const ctx = [{ ref: 'P1', productId: '1001', title: 'QCY T13 무선 블루투스 이어폰', mall: '쿠팡', price: 29900, hist: st }];
    const r = await call({ question: '이거 지금 사도 괜찮은 가격인가요?', contextProducts: ctx, chatHistory: [], view: { source: 'modal' } });
    ok(r.status === 200 && r.body.guest === true, '200 게스트');
    ok(stub.searchCalls === 0, '★ 모달 맥락에서는 검색하지 않는다', String(stub.searchCalls));
    ok(/구매 시점:/.test(r.body.text), '구매 시점 판정이 문장에 있다', r.body.text.slice(0, 80));
    ok(!r.body.items, '새로 찾은 카드가 없다(화면의 상품이 주제)');
  }

  /* ══════════════════════════════════════════════════════════
     ③ 틀린 토큰은 401
     ══════════════════════════════════════════════════════════ */
  section('8. 토큰이 있는데 틀리면 401');
  {
    fetchCalls = 0; reserveCalls = 0;
    const bad = await call({ question: '노트북 추천해줘' }, { authorization: 'Bearer v1.bad.token' });
    ok(bad.status === 401 && bad.body.needsAuth === true, '틀린 토큰 → 401 needsAuth', String(bad.status));
    const expired = issueToken('x@seosa.local', -1000);
    const ex = await call({ question: '노트북 추천해줘' }, { authorization: 'Bearer ' + expired });
    ok(ex.status === 401, '만료 토큰 → 401 (게스트로 떨어뜨리지 않는다) ★', String(ex.status));
    ok(fetchCalls === 0 && reserveCalls === 0, '401 경로는 예약도 호출도 없다');
  }

  /* ══════════════════════════════════════════════════════════
     ⑤ 수요 기반 셀렉션
     ══════════════════════════════════════════════════════════ */
  section('9. api/_picks.demandPicks');
  {
    const FB = ['수영복', '물놀이 용품', '아이스크림', '방수팩', '차량용 햇빛 가리개', '여행용 캐리어', '서큘레이터', '쿨토시'];
    const pop = [{ keyword: '무선 이어폰', count: 27 }, { keyword: '노트북', count: 22 }, { keyword: '마우스', count: 15 }];
    const p = demandPicks(pop, FB);
    ok(p.length === 8, '8개로 채운다', String(p.length));
    ok(p[0] === '무선 이어폰' && p[1] === '노트북' && p[2] === '마우스', '수요 키워드가 앞에 온다', p.slice(0, 3).join(','));
    ok(p.slice(3).every(k => FB.indexOf(k) > -1), '모자란 자리는 큐레이션으로 보충한다');
    ok(new Set(p).size === p.length, '중복 없음');
    ok(demandPicks([], FB).join(',') === FB.join(','), '수요가 없으면 큐레이션 그대로');
    ok(demandPicks([{ keyword: '수영복', count: 9 }], FB).filter(k => k === '수영복').length === 1, '수요와 큐레이션이 겹치면 한 번만');
    ok(demandPicks([{ keyword: '' }, null, { keyword: '  ' }], FB).length === 8, '빈 값·null 을 건너뛴다');
    ok(demandPicks(pop, [], 2).join(',') === '무선 이어폰,노트북', 'max 를 지킨다');
    ok(demandPicks([{ keyword: '무선 이어폰' }, { keyword: '무선이어폰' }, { keyword: 'LG그램' }, { keyword: 'lg 그램' }], []).length === 2,
      '띄어쓰기·대소문자만 다른 검색어는 한 칩으로 접는다');
    ok(demandPicks(null, null).length === 0, '입력이 전부 없으면 빈 배열');
  }

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
  if (fail) { console.log('실패: ' + failures.join(' | ')); process.exit(1); }
})().catch(e => { console.error('오류:', e && e.stack || e); process.exit(1); });
