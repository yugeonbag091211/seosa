#!/usr/bin/env node
/*
 * 100문항 하네스 자체의 테스트 (2026-11-14) — 외부 호출 0회.
 *
 *   node scripts/test-ai-100-grader.js
 *
 * 하네스가 틀리면 «PASS» 숫자가 거짓말이 된다. 판정 규칙(HTTP 200 ≠ 정확), 카드 검사,
 * 후속 문맥 검사, 지연·비용 집계, 문항 목록의 무결성, 결정적 플래너, 오프라인 실행 경로를 고정한다.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { CASES, TYPES, BRANDS, CATEGORY_LABELS } = require('./ai-100/cases');
const G = require('./ai-100/grade');
const { planFor } = require('./ai-100/planner');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail === undefined ? '' : '  — ' + JSON.stringify(detail).slice(0, 300)}`); }
}
function section(t) { console.log(`\n[${t}]`); }

const NOW = Date.parse('2026-11-14T09:00:00Z');
const card = over => Object.assign({ productId: 'p1', title: '소니 WF-1000XM5 무선 이어폰', price: 30000, mall: '쿠팡',
  url: 'https://link.coupang.com/a/1', priceObservedAt: '2026-11-14T01:00:00Z', priceFreshness: 'fresh' }, over || {});
const turn = (data, over) => Object.assign({ status: 200, version: 'v3', gate: 'served', elapsedMs: 1000, error: null,
  data: Object.assign({ answer: '추천드려요', cards: [], stats: {} }, data || {}) }, over || {});
const C = id => CASES.find(c => c.id === id);
const grade = (c, t, ctx) => G.gradeCase(c, t, Object.assign({ nowMs: NOW }, ctx || {}));

/* ── 문항 목록 무결성 ── */
section('문항 목록');
ok(CASES.length === 100 && CASES.every((c, i) => c.id === 'Q' + String(i + 1).padStart(3, '0') && c.n === i + 1), '100문항, Q001..Q100 순서');
ok(CASES.every(c => CATEGORY_LABELS[c.category]), '모든 문항에 범주');
ok(CASES.filter(c => c.expect.seed).every(c => c.category === 'followup') && CASES.filter(c => c.category === 'followup').length === 10,
  '후속 질문 10개만 seed 를 갖는다');
ok(CASES.every(c => !c.expect.type || TYPES[c.expect.type]) && CASES.every(c => !c.expect.brand || BRANDS[c.expect.brand]), '유형·브랜드 이름이 사전에 있다');
// 질문 문장은 이전 실행(035dffe·8f3c3d2)과 같아야 비교가 된다 — 문장 전체의 해시로 고정
const QHASH = crypto.createHash('sha256').update(CASES.map(c => c.question).join('\n')).digest('hex').slice(0, 16);
ok(QHASH === '9f9ae05e580bd45f', '질문 문장이 바뀌지 않았다 (sha256 ' + QHASH + ')', QHASH);
ok(C('Q001').question === '에어팟 추천해줘' && C('Q100').question === 'ㅁㄴㅇㄹ' && C('Q046').expect.seed === '5만원 이하 무선 이어폰 추천해줘', '대표 문장 표본');

/* ── 판정 ── */
section('판정 — HTTP 200 은 근거가 아니다');
let g = grade(C('Q016'), turn({ cards: [] }));
ok(g.verdict === 'FAIL' && g.reasons.includes('no_cards'), '카드 필수인데 0장 → FAIL(no_cards), HTTP 200 이어도');
g = grade(C('Q016'), turn({ cards: [card({ title: 'QCY T13 무선 이어폰', price: 19900 })] }));
ok(g.verdict === 'PASS', '유형·예산 맞는 카드 → PASS', g);
g = grade(C('Q016'), turn({ cards: [card({ title: 'QCY T13 무선 이어폰', price: 59000 })] }));
ok(g.verdict === 'FAIL' && g.reasons.includes('over_budget'), '예산 초과 → FAIL');
g = grade(C('Q016'), turn({ cards: [card({ title: '에어팟 프로 2 실리콘 케이스', price: 9900 })] }));
ok(g.verdict === 'FAIL' && g.reasons.some(r => r.startsWith('accessory_or_part_as')), '이어폰 대신 케이스 → FAIL');
g = grade(C('Q016'), turn({ cards: [card({ title: '[중고] QCY T13 무선 이어폰 S급', price: 9900 })] }));
ok(g.verdict === 'FAIL' && g.reasons.includes('used_or_refurb'), '중고 → FAIL');
g = grade(C('Q016'), turn({ cards: [card({ title: 'QCY T13 무선 이어폰', price: 9900, priceFreshness: 'stale' })] }));
ok(g.verdict === 'FAIL' && g.reasons.includes('stale_or_unknown_price'), '엔진이 stale 이라 한 가격을 현재가로 보이면 FAIL');
g = grade(C('Q016'), turn({ items: [{ productId: 'x', title: 'QCY 무선 이어폰', lprice: 9900, mall: '쿠팡', link: 'https://a.example/1', collectedAt: '2026-10-20T00:00:00Z' }], cards: undefined, answer: undefined, text: '추천' }, { version: 'legacy' }));
ok(g.verdict === 'FAIL' && g.reasons.includes('stale_price'), 'legacy items 도 읽고, 10일 넘은 관측가 → FAIL(stale_price)');
g = grade(C('Q016'), turn({ cards: [card({ url: 'http://x.example/1', title: 'QCY 무선 이어폰', price: 9900 })] }));
ok(g.verdict === 'FAIL' && g.reasons.includes('non_https_link'), 'https 아닌 링크 → FAIL');
g = grade(C('Q086'), turn({ cards: [card({ title: 'QCY T13 무선 이어폰' })] }));
ok(g.verdict === 'FAIL' && g.reasons.includes('wrong_brand:소니'), '브랜드 지정 위반 → FAIL');
g = grade(C('Q081'), turn({ cards: [card()] }));
ok(g.verdict === 'FAIL' && g.reasons.includes('cards_on_non_shopping'), '감사 인사에 카드 → FAIL');
g = grade(C('Q081'), turn({ cards: [] }));
ok(g.verdict === 'PASS', '감사 인사에 카드 없음 → PASS (사람이 볼 필요 없는 문항)');
g = grade(C('Q073'), turn({ cards: [] }));
ok(g.verdict === 'UNVERIFIED' && g.notes.includes('needs_human_review'), '지식 질문은 카드가 없어도 답의 정확성은 사람이 본다 → UNVERIFIED');
g = grade(C('Q073'), turn({ cards: [] }), { review: { Q073: { verdict: 'PASS', evidence: 'USB-C 설명이 정확함 (리뷰어 A, 2026-11-14)' } } });
ok(g.verdict === 'PASS' && g.notes.some(n => n.startsWith('human_review')), '근거를 적은 리뷰는 UNVERIFIED 를 확정한다');
g = grade(C('Q073'), turn({ cards: [] }), { review: { Q073: { verdict: 'PASS', evidence: '   ' } } });
ok(g.verdict === 'UNVERIFIED', '근거 없는 리뷰는 무시');
g = grade(C('Q016'), turn({ cards: [] }), { review: { Q016: { verdict: 'PASS', evidence: '괜찮아 보임' } } });
ok(g.verdict === 'FAIL' && g.notes.some(n => n.startsWith('human_disagrees')), '자동 FAIL 은 리뷰로 PASS 가 되지 않는다(이견만 남긴다)');
g = grade(C('Q002'), turn({ cards: [card({ title: '유선 이어폰 3.5mm', price: 150000 })] }));
ok(g.verdict === 'UNVERIFIED' && g.soft.length, 'soft 불일치(블루투스 아님)는 UNVERIFIED');
g = grade(C('Q016'), turn({}, { status: 500 }));
ok(g.verdict === 'FAIL' && g.reasons.includes('http_500'), 'HTTP 500 → FAIL');
g = grade(C('Q016'), turn({ answer: '' }));
ok(g.verdict === 'FAIL' && g.reasons.includes('empty_answer'), '빈 답 → FAIL');
g = grade(C('Q016'), turn({ cards: [card({ title: 'QCY 무선 이어폰', price: 9900 })] }, { version: 'legacy', gate: 'monitor_unavailable' }), { requireV3: true });
ok(g.verdict === 'FAIL' && g.reasons.includes('not_v3:monitor_unavailable'), '--require-v3: legacy 답은 FAIL(게이트 사유 포함)');

section('후속 질문 — 같은 세션 문맥');
const seed = turn({ cards: [card({ productId: 'a', price: 49900, title: 'A 무선 이어폰' }), card({ productId: 'b', price: 22950, title: 'B 무선 이어폰' })], turnSig: 'at1.x.y' });
g = grade(C('Q046'), turn({ cards: [card({ productId: 'c', price: 9800, title: 'C 무선 이어폰' })], stats: { state: 'valid', conversation: { verifiedAssistant: 1 } } }), { seed });
ok(g.verdict === 'PASS', '더 싼 거 — 앞 카드보다 싸면 PASS', g);
g = grade(C('Q046'), turn({ cards: [card({ productId: 'a', price: 49900, title: 'A 무선 이어폰' })], stats: { state: 'valid', conversation: { verifiedAssistant: 1 } } }), { seed });
ok(g.verdict === 'FAIL' && g.reasons.includes('not_cheaper_than_seed'), '★ 같은 카드를 다시 보이면 FAIL(not_cheaper_than_seed)');
g = grade(C('Q046'), turn({ cards: [], stats: { state: 'absent', conversation: { verifiedAssistant: 0 } } }), { seed });
ok(g.verdict === 'FAIL' && g.reasons.includes('state_not_carried:absent') && g.reasons.includes('prior_answer_not_verified'),
  '★ v3 가 받은 상태·서명 기록을 못 이어 쓰면 FAIL');
g = grade(C('Q046'), turn({ cards: [], stats: {} }), { seed });
ok(g.verdict !== 'FAIL' && g.soft.includes('state_unreported'), '상태 판정을 보고하지 않는 옛 서버는 검증 불가(soft)');
g = grade(C('Q046'), turn({ cards: [] }), { seed: turn({}, { status: 503 }) });
ok(g.verdict === 'UNVERIFIED' && g.notes.includes('seed_failed'), 'seed 가 실패하면 후속은 평가하지 않는다 → UNVERIFIED');
const seed2 = turn({ cards: [card({ productId: 'n1', title: 'LG 그램 노트북' }), card({ productId: 'n2', title: '삼성 갤럭시북 노트북' })] });
g = grade(C('Q049'), turn({ cards: [card({ productId: 'n1', title: 'LG 그램 노트북' })], stats: { state: 'valid', conversation: { verifiedAssistant: 1 } } }), { seed: seed2 });
ok(g.verdict === 'FAIL' && g.reasons.includes('wrong_referenced_product'), '«두 번째 거» 에 첫 번째 상품 → FAIL');
g = grade(C('Q053'), turn({ cards: [card({ productId: 'm1', title: '로지텍 무선 마우스', price: 20000 })], stats: { state: 'valid', conversation: { verifiedAssistant: 1 } } }),
  { seed: turn({ cards: [card({ productId: 'm1', title: '로지텍 무선 마우스', price: 20000 })] }) });
ok(g.verdict === 'FAIL' && g.reasons.includes('repeated_seed_product'), '«이거 말고 다른 거» 에 같은 상품 → FAIL');
g = grade(C('Q052'), turn({ cards: [card({ title: '삼성전자 오디세이 G5 모니터', price: 300000 })], stats: { state: 'valid', conversation: { verifiedAssistant: 1 } } }), { seed: seed2 });
ok(g.verdict === 'FAIL' && g.reasons.includes('excluded_brand:삼성'), '«삼성 말고» 에 삼성 → FAIL');

section('집계 — 지연 · 오류율 · 비용');
ok(G.percentile([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000], 0.95) === 1000 && G.percentile([5, 1, 3], 0.5) === 3 && G.percentile([], 0.95) === null,
  'p95 · p50 (nearest-rank)');
const rows = [
  { verdict: 'PASS', category: 'budget', reasons: [], expectCards: 'required', cardCount: 2, cardsChecked: 2, cardViolations: 0,
    turn: { status: 200, version: 'v3', gate: 'served', elapsedMs: 1000, data: { stats: { modelUsage: { calls: 2, inputTokens: 1000, outputTokens: 200, totalTokens: 1200 } } } } },
  { verdict: 'FAIL', category: 'budget', reasons: ['over_budget'], expectCards: 'required', cardCount: 0, cardsChecked: 1, cardViolations: 1,
    turn: { status: 500, version: 'legacy', gate: 'engine_error', elapsedMs: 3000, data: {} } },
  { verdict: 'UNVERIFIED', category: 'followup', reasons: [], expectCards: 'optional', cardCount: 0, cardsChecked: 0, cardViolations: 0,
    turn: { status: 0, version: 'network-error', elapsedMs: 40000, error: 'timeout', data: {} },
    seedTurn: { status: 200, version: 'v3', elapsedMs: 2000, data: {} } }
];
const s = G.summarize(rows, { prices: { input: 1, output: 4 } });
ok(s.verdicts.PASS === 1 && s.verdicts.FAIL === 1 && s.verdicts.UNVERIFIED === 1 && s.byCategory.budget.FAIL === 1, '판정 집계·범주별 집계');
ok(s.transport.requests === 4 && s.transport.http200 === 2 && s.transport.errorRate === 50 && s.transport.timeouts === 1, '요청 수(seed 포함)·HTTP 200·오류율·타임아웃', s.transport);
ok(s.latencyMs.scored.n === 2 && s.latencyMs.scored.p95 === 3000 && s.latencyMs.seeds.n === 1, '지연: 채점 턴과 seed 턴을 따로 (전송 실패는 지연에서 뺀다)', s.latencyMs);
ok(s.accuracy.recommendationRate === 50 && s.accuracy.cardPrecision === 66.7, '추천률·카드 정확도', s.accuracy);
ok(Math.abs(s.cost.usd - (1000 / 1e6 * 1 + 200 / 1e6 * 4)) < 1e-9 && s.cost.pricedRequests === 1 && s.cost.unpricedRequests === 3 && s.cost.verified === false,
  '비용: 토큰 × 단가, 토큰을 보고하지 않은 요청은 unpriced(검증 안 됨)', s.cost);

section('결정적 플래너 (오프라인 GPT 대역)');
ok(JSON.stringify(planFor('10만원 이하 블렌더 추천해줘')) === JSON.stringify(planFor('10만원 이하 블렌더 추천해줘')) && planFor('10만원 이하 블렌더 추천해줘').query === '블렌더',
  '같은 질문 → 같은 계획, 예산·군말 제거, «블렌더» 의 «더» 를 지우지 않는다');
ok(planFor('더 싼 거 없어?').query === '' && planFor('더 싼 거 없어?').mode === 'recommend', '상품 낱말 없는 후속 → 검색어 비움(엔진이 앞 검색어를 쓴다)');
const cmp = planFor('에어팟 프로 vs 갤럭시 버즈 뭐가 나아?');
ok(cmp.mode === 'compare' && cmp.query === '에어팟 프로' && cmp.compareQuery === '갤럭시 버즈', '비교 → 두 검색어');
ok(planFor('삼성 T7 1TB 최저가 알려줘').category === '외장하드' && planFor('소니 WH-1000XM5 최저가 찾아줘').category === '헤드폰', '모델명만 있어도 GPT 가 아는 종류');

section('오프라인 실행 경로 (동결 픽스처 26행, 네트워크 0)');
const out = path.join(os.tmpdir(), 'ai100-grader-' + process.pid + '.json');
const fixture = path.join(__dirname, '..', 'tools', 'ai-eval', 'fixtures', 'catalog-fixture.jsonl');
const r = spawnSync(process.execPath, [path.join(__dirname, 'test-100-questions.js'), '--offline', '--snapshot=' + fixture,
  '--only=Q004,Q046,Q081', '--out=' + out, '--label=selftest'], { encoding: 'utf8', timeout: 120000 });
let report = null;
try { report = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (_) {}
ok(r.status === 0 && report && report.results.length === 3, '오프라인 3문항 실행 → JSON 저장', (r.stderr || '').slice(-300));
if (report) {
  ok(report.meta.mode === 'offline' && report.meta.offline.rows === 26 && /^[0-9a-f]{64}$/.test(report.meta.offline.sha256), '메타: 모드·스냅숏 행 수·해시');
  ok(report.summary.transport.requests === 4 && report.summary.transport.http200 === 4, 'seed 포함 4요청, 전부 v3 라우트가 답함');
  const f = report.results.find(x => x.id === 'Q046');
  ok(f && f.seedTurn && f.turn && f.turn.stats.conversation && f.turn.stats.conversation.verifiedAssistant === 1 && f.turn.stats.state === 'valid',
    '★ 후속은 같은 세션: seed 답의 서명이 인정되고(verifiedAssistant=1) 상태가 이어진다', f && f.turn && f.turn.stats);
  ok(['PASS', 'FAIL', 'UNVERIFIED'].includes(report.results[0].verdict) && Array.isArray(report.results[0].reasons), '문항마다 판정·사유');
  try { fs.unlinkSync(out); } catch (_) {}
}

console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exitCode = 1;
