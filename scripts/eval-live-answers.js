#!/usr/bin/env node
/*
 * 실제 모델로 답변 품질을 본다 — 데이터는 스텁, LLM 만 실호출.
 *
 * ── 세 E2E 스크립트의 역할 분담 ─────────────────────────────────
 *
 *   test-ai-pipeline.js   전부 스텁. 배선 검사. (npm test 포함, 0원)
 *   eval-live-answers.js  ★ 이 파일. LLM 만 진짜. 쿠팡·DB 는 스텁. (수동)
 *   test-ai-concierge.js  전부 진짜. 쿠팡 쿼터·운영 DB 를 쓴다. (수동)
 *
 * ── 왜 가운데가 필요한가 ────────────────────────────────────────
 *
 * 무료 모델로 내려갔을 때 "답이 나오는가" 는 배선 문제이고 test-ai-pipeline
 * 이 본다. 그런데 "그 답이 쓸 만한가" 는 실제 모델을 불러 봐야만 안다 —
 * 지시 18항의 열 가지 질문이 그것이다.
 *
 * 그렇다고 전부 진짜로 돌리면 쿠팡 쿼터를 먹고 운영 products 에 쓴다.
 * 여기서는 **상품·가격 기록만 고정 픽스처**로 두고 모델만 진짜를 부른다.
 *   · 쿠팡 호출 0회 · 운영 DB 쓰기 0회 · 무료 모델이면 비용 0원
 *   · 데이터가 고정이라 "모델이 지어낸 금액" 을 정확히 가려낼 수 있다
 *
 *   node scripts/eval-live-answers.js
 *   node scripts/eval-live-answers.js --free     무료 사슬만 쓴다(유료 건너뜀)
 */
'use strict';

require('./_env.js');

if (!process.env.OPENROUTER_API_KEY) {
  console.error('OPENROUTER_API_KEY 없음 — .env.local 을 확인하세요');
  process.exit(1);
}

/*
 * --free : 유료 1순위를 건너뛰고 무료 사슬만 쓴다.
 * 크레딧이 있는 계정에서도 "무료로 떨어졌을 때의 품질" 을 볼 수 있어야 한다.
 */
if (process.argv.indexOf('--free') > -1) {
  const llm = require('../api/_llm');
  process.env.OPENROUTER_MODELS = llm.FREE_ANSWER_CHAIN.join(',');
  process.env.OPENROUTER_CLASSIFY_MODELS = llm.FREE_CLASSIFY_CHAIN.join(',');
}

/* ── 대역: 신원·요금제·검색·가격기록 (ai.js require 이전에) ────── */
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
plan.release = async () => {};
plan.usagePayload = (p, used, limit) => ({ plan: p, used, limit, remaining: limit - used });

const shop = require('../api/_shop');
const trust = require('../api/_trust');
const pricestat = require('../api/_pricestat');

function kstToday() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }
function daysAgo(n) { return new Date(Date.now() + 9 * 3600e3 - n * 86400e3).toISOString().slice(0, 10); }

/*
 * 고정 픽스처.
 *
 * ★ 여기 적힌 금액이 "세상에 존재하는 전부" 다. 답변에 이 밖의 금액이
 *   나오면 모델이 지어낸 것이다 — 아래 hallucination 검사가 그것을 센다.
 */
const ITEMS = [
  { title: '알파 노트북 15인치 16GB 512GB', lprice: 289000, link: 'https://l.c/a', image: '',
    mall: '쿠팡', productId: 'A1', isCoupang: true, oprice: 320000, savePct: 10 },
  { title: '베타 노트북 14인치 8GB 256GB',  lprice: 279000, link: 'https://l.c/b', image: '',
    mall: '쿠팡', productId: 'B2', isCoupang: true, oprice: 279000, savePct: 0 },
  { title: '감마 노트북 15인치 16GB 1TB',   lprice: 299000, link: 'https://l.c/c', image: '',
    mall: '쿠팡', productId: 'C3', isCoupang: true, oprice: 340000, savePct: 12 }
];
const KNOWN_WON = [289000, 279000, 299000, 320000, 340000, 300000, 310000, 275000, 295000, 260000];

const STATS = new Map();
STATS.set('A1|쿠팡', {
  count: 30, lastPrice: 289000, lastDate: kstToday(), prevPrice: 295000,
  low: 275000, lowDate: daysAgo(20), high: 320000, highDate: daysAgo(28),
  avg30: 300000, avg30Days: 30, avg7: 295000, avg7Days: 7, median: 298000,
  trendPct: -2.0, trendDays: 7, trendFrom: 295000, trendFromDate: daysAgo(7),
  points: [{ d: daysAgo(7), p: 295000 }, { d: kstToday(), p: 289000 }],
  volatility: 5.1, historyDays: 30, maxGapDays: 1, firstDate: daysAgo(30)
});
STATS.set('C3|쿠팡', {
  count: 30, lastPrice: 299000, lastDate: kstToday(), prevPrice: 290000,
  low: 260000, lowDate: daysAgo(25), high: 340000, highDate: daysAgo(2),
  avg30: 310000, avg30Days: 30, avg7: 305000, avg7Days: 7, median: 308000,
  trendPct: 3.1, trendDays: 7, trendFrom: 290000, trendFromDate: daysAgo(7),
  points: [{ d: daysAgo(7), p: 290000 }, { d: kstToday(), p: 299000 }],
  volatility: 8.4, historyDays: 30, maxGapDays: 1, firstDate: daysAgo(30)
});

shop.searchAll = async () => ({ items: ITEMS, allItems: ITEMS, from: 'api', blocked: false });
shop.saveProducts = async () => {};   // ★ 운영 DB 에 쓰지 않는다
trust.attachTrust = async (list) => {
  (list || []).forEach(it => {
    if (it) it.trust = { level: 'high', label: '오늘 확인된 가격', reasons: [{ text: '오늘 수집한 값' }] };
  });
  return list;
};
pricestat.loadStats = async () => STATS;

const handler = require('../api/ai.js');

function call(body) {
  return new Promise((resolve, reject) => {
    let code = 200;
    const res = {
      status(c) { code = c; return this; },
      setHeader() { return this; },
      json(p) { resolve({ status: code, body: p }); return this; },
      end() { resolve({ status: code, body: {} }); return this; }
    };
    Promise.resolve(handler({ method: 'POST', headers: {}, query: {}, body }, res)).catch(reject);
  });
}

/* 지시 18항의 열 가지 질문. 대화 맥락이 필요한 것은 history 를 함께 준다. */
const HIST_AFTER_REC = [
  { role: 'user', text: '30만원 이하 노트북 추천해줘' },
  { role: 'assistant', text: '알파 노트북을 권해요. 289,000원으로 30일 평균보다 낮습니다.' }
];

const CASES = [
  { q: '30만원 이하 노트북 추천해줘',            want: 'C' },
  { q: '지금 사도 돼?',                          want: 'E', hist: HIST_AFTER_REC },
  { q: '이거 왜 추천해?',                        want: null, hist: HIST_AFTER_REC },
  { q: '알파랑 감마 비교해줘',                   want: null, hist: HIST_AFTER_REC },
  { q: '더 싼 거 있어?',                         want: 'C', hist: HIST_AFTER_REC },
  { q: '게임용으로 추천해줘',                    want: 'C' },
  { q: '맥북이랑 윈도우 노트북 중 뭐가 좋아?',   want: null },
  { q: '아까 추천한 것 중에서 제일 가성비 좋은 거', want: null, hist: HIST_AFTER_REC },
  { q: '가격 떨어지면 알려줘',                   want: null, hist: HIST_AFTER_REC },
  { q: '그냥 지금 살까 말까?',                   want: 'E', hist: HIST_AFTER_REC }
];

/*
 * 답변에 나온 금액 중 근거 없는 것.
 *
 * ★ 차액은 지어낸 것이 아니다.
 *   "최저가 275,000원과 14,000원 차이" 의 14,000 은 픽스처에 없는 숫자지만
 *   289,000 − 275,000 이라 근거가 있다. 처음에는 이것까지 세어서 10건 중
 *   6건이 hallucination 으로 잡혔는데, 실제로 지어낸 것은 한 건뿐이었다.
 *   아는 금액들의 차이도 아는 값으로 친다.
 */
function knownSet() {
  const s = new Set(KNOWN_WON);
  KNOWN_WON.forEach(a => KNOWN_WON.forEach(b => {
    if (a > b) s.add(a - b);
  }));
  return s;
}
const KNOWN = knownSet();

function madeUpWons(text) {
  return (text.match(/[0-9][0-9,]{2,}(?=\s*원)/g) || [])
    .map(s => Number(s.replace(/,/g, '')))
    .filter(n => n >= 1000 && !KNOWN.has(n));
}

(async () => {
  console.log('=== 실모델 답변 품질 (쿠팡 0회 · 운영 DB 쓰기 0회) ===');
  const llm = require('../api/_llm');
  console.log(`answer   : ${llm.chainFor('answer').join(' → ')}`);
  console.log(`classify : ${llm.chainFor('classify').join(' → ')}\n`);

  let hallucinated = 0, degraded = 0, empty = 0, longAnswers = 0;

  for (const c of CASES) {
    const started = Date.now();
    const r = await call({
      question: c.q,
      contextProducts: [],
      chatHistory: c.hist || [],
      view: { source: 'none' }
    });
    const ms = Date.now() - started;
    const t = String((r.body && r.body.text) || '');
    const bad = madeUpWons(t);
    const fu = (r.body && r.body.followups) || [];

    if (bad.length) hallucinated++;
    if (r.body && r.body.degraded) degraded++;
    if (!t.trim()) empty++;
    if (t.length > 700) longAnswers++;

    console.log(`──────────────────────────────────────────────`);
    console.log(`Q. ${c.q}`);
    console.log(`   ${r.status} · ${ms}ms · 카드 ${(r.body.items || []).length}장`
      + `${r.body.degraded ? ' · degraded(결정론 답변)' : ''}`);
    console.log(`   지어낸 금액: ${bad.length ? bad.join(', ') + '  ★' : '없음'}`);
    console.log(`   길이 ${t.length}자${t.length > 700 ? '  ★ 장황' : ''}`);
    console.log(`   후속: ${fu.length ? fu.join(' / ') : '(없음)'}`);
    console.log('');
    console.log(t.split('\n').map(l => '   ' + l).join('\n'));
    console.log('');
  }

  console.log('==============================================');
  console.log(`케이스 ${CASES.length}건`);
  console.log(`  지어낸 금액 있음 : ${hallucinated}건  ${hallucinated ? '★ 확인 필요' : ''}`);
  console.log(`  결정론 답변으로 떨어짐 : ${degraded}건`);
  console.log(`  빈 답변 : ${empty}건`);
  console.log(`  700자 초과(장황) : ${longAnswers}건`);
  console.log('');
  console.log('※ 의도 분류 정확도는 scripts/test-intent.js 가 따로 본다.');
  process.exit(hallucinated || empty ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
