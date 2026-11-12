'use strict';
// Self-test of the v3.4 independent judge on SYNTHETIC results (no engine).
// Proves the rubric before any graded run: correct card → PASS, stale price →
// FAIL, invented product/price → FAIL, missed available → FAIL, correct
// absence → UNVERIFIED (never PASS), outage → honest-outage PASS, comparison
// sides, «그중» subset rule, and judge disagreement → NEEDS_REVIEW.
const assert = require('node:assert/strict');
const { judgeTurn, specErrors, combine, partWord } = require('./ai-v34/eval/oracle');
const { judgeQuestion } = require('./ai-v34/eval/judge');

const asOfMs = Date.parse('2026-11-06T05:00:00Z');
const ctx = { asOfMs, maxAgeDays: 10 };
const fresh = '2026-11-05T00:00:00Z', old = '2026-09-01T00:00:00Z';
const row = (pid, title, lprice, collected_at = fresh) => ({ mall: '쿠팡', product_id: pid, title, lprice, collected_at });
const corpus = new Map([
  row('g1', '로지텍 G304 LIGHTSPEED 무선 게이밍 마우스', 39000),
  row('g2', '로지텍 G304 무선 마우스 화이트', 41000, old),
  row('p1', '로지텍 G304 마우스피트 교체용', 9000),
  row('b1', '갤럭시 버즈3 프로 SM-R630N', 219000),
  row('a1', 'Apple 에어팟 프로 2세대 USB-C', 315000)
].map(r => ['쿠팡:' + r.product_id, { ...r, link: 'https://link.invalid/' + r.product_id }]));
const card = (pid, price) => ({ productId: '쿠팡:' + pid, title: corpus.get('쿠팡:' + pid).title, price: price ?? corpus.get('쿠팡:' + pid).lprice, link: 'https://link.invalid/' + pid });
const spec = { all: [['로지텍', 'logitech'], ['g304']], floor: 8000 };
const turn = (extra = {}) => ({ p: '로지텍 G304 찾아줘', spec, expect: 'AUTO', ...extra });
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }

test('correct fresh card → PASS', () => {
  const r = judgeTurn({ turn: turn(), result: { status: 200, cards: [card('g1')] }, gold: { count: 1 }, corpus, ctx });
  assert.equal(r.verdict, 'PASS');
});
test('stale price shown as current → FAIL', () => {
  const r = judgeTurn({ turn: turn(), result: { status: 200, cards: [card('g2')] }, gold: { count: 1 }, corpus, ctx });
  assert.equal(r.verdict, 'FAIL'); assert(r.causes.some(c => c.includes('stale_price_shown')));
});
test('invented product and invented price → FAIL', () => {
  const ghost = judgeTurn({ turn: turn(), result: { status: 200, cards: [{ productId: '쿠팡:nope', title: '로지텍 G304', price: 1000, link: 'https://x' }] }, gold: { count: 1 }, corpus, ctx });
  assert.equal(ghost.verdict, 'FAIL'); assert(ghost.causes.some(c => c.includes('card_not_in_corpus')));
  const wrongPrice = judgeTurn({ turn: turn(), result: { status: 200, cards: [card('g1', 19000)] }, gold: { count: 1 }, corpus, ctx });
  assert.equal(wrongPrice.verdict, 'FAIL'); assert(wrongPrice.causes.some(c => c.includes('price_mismatch')));
});
test('accessory with the model name → FAIL', () => {
  assert(['마우스피트', '교체용'].includes(partWord('로지텍 G304 마우스피트 교체용')));
  assert.equal(partWord('로지텍 G304 LIGHTSPEED 무선 게이밍 마우스'), null);
  const r = judgeTurn({ turn: turn(), result: { status: 200, cards: [card('p1')] }, gold: { count: 1 }, corpus, ctx });
  assert.equal(r.verdict, 'FAIL');
});
test('no card while the corpus has one → FAIL (MISSED_AVAILABLE)', () => {
  const r = judgeTurn({ turn: turn(), result: { status: 200, cards: [], answer: '없어요' }, gold: { count: 1 }, corpus, ctx });
  assert.equal(r.verdict, 'FAIL'); assert.equal(r.outcome, 'MISSED_AVAILABLE');
});
test('correct absence is UNVERIFIED, never PASS', () => {
  const r = judgeTurn({ turn: turn(), result: { status: 200, cards: [] }, gold: { count: 0 }, corpus, ctx });
  assert.equal(r.verdict, 'UNVERIFIED');
});
test('HTTP 200 + 4 cards is not enough: every card is checked', () => {
  const r = judgeTurn({ turn: turn(), result: { status: 200, cards: [card('g1'), card('g2'), card('p1'), card('b1')] }, gold: { count: 1 }, corpus, ctx });
  assert.equal(r.verdict, 'FAIL');
});
test('outage: 503 → PASS; 200 «no products» → FAIL', () => {
  const t = turn({ expect: 'OUTAGE' });
  assert.equal(judgeTurn({ turn: t, result: { status: 503, cards: [] }, gold: { count: 1 }, corpus, ctx }).verdict, 'PASS');
  assert.equal(judgeTurn({ turn: t, result: { status: 200, cards: [], answer: '조건에 맞는 후보가 없어요.' }, gold: { count: 1 }, corpus, ctx }).verdict, 'FAIL');
});
test('stale-only: honest stale text → PASS; absence claim → FAIL; stale card → FAIL', () => {
  const t = turn({ expect: 'STALE_ONLY' });
  assert.equal(judgeTurn({ turn: t, result: { status: 200, cards: [], answer: '최근 10일 안에 확인된 가격이 없어 추천하지 않았어요.' }, gold: { count: 0 }, corpus, ctx }).verdict, 'PASS');
  assert.equal(judgeTurn({ turn: t, result: { status: 200, cards: [], answer: '조건에 맞는 후보가 없어요.' }, gold: { count: 0 }, corpus, ctx }).verdict, 'FAIL');
  assert.equal(judgeTurn({ turn: t, result: { status: 200, cards: [card('g2')] }, gold: { count: 0 }, corpus, ctx }).verdict, 'FAIL');
});
test('comparison needs exactly one valid card per side', () => {
  const t = { p: '버즈3 프로랑 에어팟 프로 2 비교', expect: 'COMPARE', spec: { sides: [{ all: [['버즈3프로']], floor: 100000 }, { all: [['에어팟프로2']], floor: 150000 }] } };
  const g = { sides: [{ count: 1 }, { count: 1 }] };
  assert.equal(judgeTurn({ turn: t, result: { status: 200, cards: [card('b1'), card('a1')] }, gold: g, corpus, ctx }).verdict, 'PASS');
  assert.equal(judgeTurn({ turn: t, result: { status: 200, cards: [card('b1')] }, gold: g, corpus, ctx }).verdict, 'FAIL');
  assert.equal(judgeTurn({ turn: t, result: { status: 200, cards: [card('b1'), card('g1')] }, gold: g, corpus, ctx }).verdict, 'FAIL');
});
test('«그중» must stay among previously shown cards', () => {
  const t = turn({ expect: 'DYNAMIC', spec: { ...spec, amongPrevious: true } });
  const previous = { cards: [card('g1')] };
  assert.equal(judgeTurn({ turn: t, result: { status: 200, cards: [card('g1')] }, previous, gold: { dynamic: true }, corpus, ctx }).verdict, 'PASS');
  assert.equal(judgeTurn({ turn: t, result: { status: 200, cards: [card('b1')] }, previous, gold: { dynamic: true }, corpus, ctx }).verdict, 'FAIL');
});
test('short model codes need word boundaries; ENC is not ANC', () => {
  assert.deepEqual(specErrors({ all: [['t7']] }, '필립스 CDO-TT PLUS 70W94', 50000).filter(e => e.startsWith('missing')), ['missing:t7']);
  assert.deepEqual(specErrors({ all: [['t7']] }, '삼성 T7 Shield 1TB', 150000).filter(e => e.startsWith('missing')), []);
  assert(specErrors({ all: [['노이즈캔슬링', 'anc']] }, 'ENC 노이즈캔슬링 블루투스 이어폰', 20000).some(e => e.startsWith('missing')));
});
test('judges disagreeing → NEEDS_REVIEW, combined verdict is not PASS', () => {
  const q = { id: 'T001', type: 'outage', cat: '마우스', turns: [turn({ expect: 'OUTAGE' })] };
  const j = judgeQuestion(q, [{ status: 503, cards: [], answer: '' }], { gold: { T001: [{ count: 1 }] }, corpus, ctx });
  assert.equal(j.v34, 'PASS'); assert.equal(j.v2, 'FAIL'); assert.equal(j.final, 'NEEDS_REVIEW');
  assert.equal(combine(['PASS', 'NEEDS_REVIEW']), 'NEEDS_REVIEW');
  assert.equal(combine(['PASS', 'UNVERIFIED']), 'UNVERIFIED');
});
console.log(JSON.stringify({ passed, failed: 0 }));
