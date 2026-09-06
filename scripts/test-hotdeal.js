#!/usr/bin/env node
'use strict';
/*
 * SEOSA HOT — 판정 엔진 fixture 테스트.
 *
 * ★ 외부 호출 0회. OpenRouter·쿠팡·ADPICK·Supabase 를 한 번도 부르지 않는다.
 *   여기서 검증하는 것은 "같은 데이터면 같은 판정이 나오는가" 뿐이다.
 *
 * ★ 기대값을 통과시키려고 고치지 않는다. 판정이 바뀌어야 한다면 엔진을 고친다.
 */

const HD = require('../api/_hotdeal');
const HS = require('../api/_hotsource');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  — ${detail}` : ''}`); }
}
function eq(actual, expected, name) {
  ok(actual === expected, name, actual === expected ? String(actual) : `기대 ${expected} / 실제 ${actual}`);
}

const TODAY = '2026-09-06';
const day = n => new Date(Date.parse(TODAY + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
/** n일치 연속 관측 (offset 만큼 과거로 민다) */
const flat = (n, price, offset) => {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push({ date: day(i + (offset || 0)), price });
  return out;
};
const BODY = '삼성전자 갤럭시 버즈3 프로 SM-R630N 실버';
const ev = (title, price, points, extra) => HD.evaluate(Object.assign({
  candidate: { title, salePrice: price },
  storedTitle: BODY, points, today: TODAY
}, extra || {}));

console.log('=== SEOSA HOT 판정 엔진 (외부 호출 0회) ===\n');

/* ─────────────────────────────────────────────────────────────
   [1] 가격 파서 — PHASE 20 Price parser
   ───────────────────────────────────────────────────────────── */
console.log('[1] 가격 파서');
eq(HD.toKRW('1,590,000원'), 1590000, '쉼표 + 원');
eq(HD.toKRW('  159000  '), 159000, '앞뒤 공백');
eq(HD.toKRW('159000'), 159000, '숫자 문자열');
eq(HD.toKRW(159000), 159000, '숫자');
eq(HD.toKRW('₩89,900'), 89900, '통화기호');
eq(HD.toKRW('0'), null, '0 은 가격이 아니다');
eq(HD.toKRW('-500'), 500, '음수 기호는 제거되고 절대값이 남는다(문자 필터)');
eq(HD.toKRW(-500), null, '숫자 음수는 거부');
eq(HD.toKRW(''), null, '빈 문자열');
eq(HD.toKRW(null), null, 'null');
eq(HD.toKRW(undefined), null, 'undefined');
eq(HD.toKRW('가격문의'), null, '숫자 없는 문자열');
eq(HD.toKRW(true), null, 'boolean 거부');

/* ─────────────────────────────────────────────────────────────
   [2] 후보 정규화 — PHASE 3
   ───────────────────────────────────────────────────────────── */
console.log('\n[2] 후보 정규화');
{
  const c = HS.normalizeCandidate({
    title: '  갤럭시  버즈3   프로  ', price_sale: '175,000원', price_org: '219,000원',
    id: 'X1', mall: 'AliExpress', photo: 'https://x/y.jpg', buyurl: 'https://a/b'
  }, 'adpick-hotdeal');
  ok(!!c, '정상 항목 통과');
  eq(c.salePrice, 175000, 'price_sale 파싱');
  eq(c.referencePrice, 219000, 'price_org 파싱');
  eq(c.title, '갤럭시 버즈3 프로', '연속 공백 정리');
  eq(c.mall, '알리', '몰 이름 정규화');
  eq(c.source, 'adpick-hotdeal', 'source 기록');
}
eq(HS.normalizeCandidate({ title: 'x', price: 0, id: 'a' }, 's'), null, '가격 0 은 후보가 아니다');
eq(HS.normalizeCandidate({ title: '', price: 100, id: 'a' }, 's'), null, '제목 없음');
eq(HS.normalizeCandidate({ title: 'x', price: 100 }, 's'), null, '식별자 없음');
{
  const c = HS.normalizeCandidate({ title: 'x', price: 100, id: 'a', buyurl: 'javascript:alert(1)' }, 's');
  eq(c.affiliateUrl, '', 'javascript: 스킴 차단');
}
{
  // 정가가 판매가보다 낮으면 정가가 아니다 — 가짜 할인 방어의 첫 단계
  const c = HS.normalizeCandidate({ title: 'x', price: 100, price_org: 90, id: 'a' }, 's');
  eq(c.referencePrice, 0, '정가 < 판매가면 버린다');
}
{
  const list = [
    HS.normalizeCandidate({ title: 'a', price: 200, id: 'k', mall: '쿠팡' }, 's'),
    HS.normalizeCandidate({ title: 'a', price: 150, id: 'k', mall: '쿠팡' }, 's')
  ];
  const d = HS.dedupeCandidates(list);
  eq(d.length, 1, '같은 source+id+mall 중복 제거');
  eq(d[0].salePrice, 150, '중복 시 싼 쪽을 남긴다');
}

/* ─────────────────────────────────────────────────────────────
   [3] 상품 정체성 — PHASE 4 / GATE 1·7
   ───────────────────────────────────────────────────────────── */
console.log('\n[3] 상품 정체성');
const idl = (a, b) => HD.identityOf(a, b).level;
eq(idl('Apple 아이폰 17 128GB 자급제', 'Apple 아이폰 17 512GB 자급제'), HD.IDENTITY.REJECT, '용량 다름(128 vs 512)');
eq(idl('Apple 아이폰 17 128GB 자급제', 'Apple 아이폰 17 128GB 자급제'), HD.IDENTITY.EXACT, '완전 동일');
eq(idl('Apple 에어팟 프로 2세대', 'Apple 에어팟 프로 3세대'), HD.IDENTITY.REJECT, '세대 다름(Pro2 vs Pro3)');
eq(idl('Apple 아이폰 17 128GB', '아이폰 17 케이스 투명 범퍼'), HD.IDENTITY.REJECT, '본체 vs 케이스');
eq(idl('Apple 에어팟 프로 3세대', '에어팟 프로 실리콘 이어팁 3쌍'), HD.IDENTITY.REJECT, '본체 vs 이어팁');
eq(idl('LG전자 그램 16 16GB 512GB', 'LG전자 그램 16 32GB 512GB'), HD.IDENTITY.REJECT, '노트북 램 다름');
eq(idl(BODY, BODY + ' 리퍼'), HD.IDENTITY.REJECT, '새상품 vs 리퍼');
eq(idl(BODY, BODY + ' 중고'), HD.IDENTITY.REJECT, '새상품 vs 중고');
eq(idl('아픔이 길이 되려면', '지혜문학+아픔이 길이 되려면 세트'), HD.IDENTITY.REJECT, '단품 vs 번들');
eq(idl('에이수스 2025 비보북 S 16', '에이수스 2026 비보북 16'), HD.IDENTITY.REJECT, '연식 다름');
ok(HD.isAccessoryTitle('아이폰 17 강화유리 액정보호필름'), '강화유리를 부속으로 본다');
ok(!HD.isAccessoryTitle('Apple 아이폰 17 128GB 자급제'), '본체는 부속이 아니다');

/* ─────────────────────────────────────────────────────────────
   [4] 이력 기준선 — PHASE 5
   ───────────────────────────────────────────────────────────── */
console.log('\n[4] 이력 기준선');
{
  const b = HD.baselineFrom(flat(10, 100000), 90000, TODAY);
  eq(b.count, 10, '관측 10회');
  eq(b.span, 9, 'span 9일');
  eq(b.maxGap, 1, '공백 1일');
  eq(b.median, 100000, '중앙값');
  eq(b.currentObserved, false, '90000 은 관측된 적 없다');
  eq(b.prevObserved, 100000, '오늘을 뺀 직전 관측');
}
{
  // 같은 날짜 여러 행이 들어와도 관측 횟수가 부풀지 않아야 한다
  const dup = [{ date: day(0), price: 100 }, { date: day(0), price: 90 }, { date: day(1), price: 100 }];
  const b = HD.baselineFrom(dup, 90, TODAY);
  eq(b.count, 2, '같은 날은 1회로 접는다');
  eq(b.low, 90, '같은 날 여러 값이면 최저가를 쓴다');
}
{
  // 오늘 수집분이 이미 이력에 있어도 prevObserved 는 어제 값이어야 한다.
  // 이게 깨지면 이상치 감지가 자기 자신과 비교하게 된다.
  const pts = flat(5, 200000).concat([{ date: day(0), price: 80000 }]);
  const b = HD.baselineFrom(pts, 80000, TODAY);
  eq(b.prevObserved, 200000, '오늘 값을 직전으로 삼지 않는다');
  eq(b.currentObserved, true, '오늘 값이 이력에 있으면 관측됨');
}
{
  // 진짜 백분위(순위 기반). min-max 위치였다면 25 가 나왔을 분포.
  const pts = [100, 100, 100, 100, 200].map((p, i) => ({ date: day(4 - i), price: p }));
  const b = HD.baselineFrom(pts, 125, TODAY);
  eq(b.pctRank, 80, '편향 분포에서 순위 기반 백분위');
}

/* ─────────────────────────────────────────────────────────────
   [5] 하드 게이트 — PHASE 6
   ───────────────────────────────────────────────────────────── */
console.log('\n[5] 하드 게이트');
const gateOf = (r, id) => r.gates.find(g => g.id === id);
eq(ev(BODY, 175000, [{ date: day(0), price: 219000 }]).status, HD.STATUS.NORMAL, '관측 1회 — 핫딜 아님');
ok(!gateOf(ev(BODY, 175000, flat(2, 219000)), 'MIN_OBSERVATIONS').ok, 'GATE2 관측 2회 차단');
// span 은 «첫 관측과 마지막 관측 사이의 일수» 다. 4점(day0~day3)이면 3일.
ok(gateOf(ev(BODY, 175000, flat(4, 219000)), 'OBSERVATION_SPAN').ok, 'GATE3 span 3일은 통과');
ok(!gateOf(ev(BODY, 175000, flat(3, 219000)), 'OBSERVATION_SPAN').ok, 'GATE3 span 2일은 차단');
ok(!gateOf(ev(BODY, 175000, flat(4, 219000, 40).concat(flat(3, 219000))), 'MAX_GAP').ok, 'GATE4 큰 공백 차단');
ok(!gateOf(ev(BODY, 175000, flat(20, 219000, 12)), 'FRESHNESS').ok, 'GATE6 오래된 기록 차단');
{
  const r = ev(BODY, 88000, flat(28, 219000).concat([{ date: day(0), price: 88000 }]));
  ok(!gateOf(r, 'OUTLIER').ok, 'GATE5 직전 대비 60% 급락 차단');
  eq(r.status, HD.STATUS.REJECTED, '이상치는 REJECTED');
}
{
  const r = ev('갤럭시 버즈3 프로 실리콘 케이스', 5900, flat(30, 219000));
  ok(!gateOf(r, 'PRODUCT_TYPE').ok, 'GATE7 본체 자리에 부속 차단');
  eq(r.status, HD.STATUS.REJECTED, '부속은 REJECTED');
}
{
  const r = HD.evaluate({ candidate: { title: BODY, salePrice: 0 }, storedTitle: BODY, points: flat(30, 219000), today: TODAY });
  ok(!gateOf(r, 'PRICE_VALID').ok, 'GATE8 가격 0 차단');
  eq(r.status, HD.STATUS.REJECTED, '가격 없음은 REJECTED');
}

/* ─────────────────────────────────────────────────────────────
   [6] HOT SCORE 와 상태 — PHASE 7·8
   ───────────────────────────────────────────────────────────── */
console.log('\n[6] HOT SCORE / 상태');
{
  // 관측된 20% 인하 — 검증된 핫딜
  const pts = flat(28, 219000).concat([{ date: day(0), price: 175000 }]);
  const r = ev(BODY, 175000, pts);
  eq(r.status, HD.STATUS.VERIFIED_HOT, '관측된 20% 인하 = VERIFIED_HOT');
  ok(r.hotScore >= HD.VERIFIED_HOT_MIN, 'score >= 임계', String(r.hotScore));
  eq(r.confidence, HD.CONFIDENCE.HIGH, 'confidence HIGH');
}
{
  const pts = flat(28, 219000).concat([{ date: day(0), price: 197000 }]);
  const r = ev(BODY, 197000, pts);
  eq(r.status, HD.STATUS.GOOD_DEAL, '10% 인하 = GOOD_DEAL');
}
{
  // ★ 가짜 할인: 쇼핑몰은 정가 550,000 에 60% 할인이라지만 우리 기록엔 늘 그 값
  const r = HD.evaluate({
    candidate: { title: BODY, salePrice: 219000, referencePrice: 550000 },
    storedTitle: BODY, points: flat(30, 219000), today: TODAY
  });
  eq(r.status, HD.STATUS.NORMAL, '가짜 할인은 NORMAL');
  eq(r.hotScore, 0, '가짜 할인은 0점 — 쇼핑몰 정가를 쓰지 않는다');
}
{
  // 미관측 신저가: 싸 보이지만 우리가 확인한 값이 아니다
  const r = ev(BODY, 150000, flat(30, 219000));
  eq(r.status, HD.STATUS.GOOD_DEAL, '미관측 신저가는 VERIFIED 가 아니다');
  ok(r.reasons.some(x => x.kind === 'unconfirmed'), '“처음 본 값이라 확인 중” 근거를 붙인다');
  ok(!r.reasons.some(x => /가장 낮은|최저가\) 수준/.test(x.text)), '역대 최저라고 단정하지 않는다');
}
{
  // 고정가 상품: 30번 모두 같은 값 — 최저가지만 아무 의미가 없다
  const r = ev(BODY, 219000, flat(30, 219000));
  eq(r.status, HD.STATUS.NORMAL, '고정가는 NORMAL');
  ok(!r.reasons.some(x => x.kind === 'rank' || x.kind === 'low'), '고정가에 최저가·순위 문구를 붙이지 않는다');
}
{
  // confidence 천장
  const low = flat(3, 219000, 5).concat([{ date: day(0), price: 120000 }]);
  const r = ev(BODY, 120000, low);
  ok(r.hotScore <= HD.SCORE_CEILING[r.confidence], 'confidence 천장을 넘지 않는다',
    `${r.hotScore} <= ${HD.SCORE_CEILING[r.confidence]} (${r.confidence})`);
}
{
  /*
   * 변동성 감점은 «축 하나» 로 따로 잰다.
   *
   * 처음에는 안정 계열과 출렁 계열의 최종 점수를 견줬는데, 두 계열은 중앙값도
   * 직전 관측도 달라서 할인율 자체가 달라진다 — 변동성이 아니라 할인율 차이를
   * 재고 있었다. 변수를 하나만 두려면 축을 직접 봐야 한다.
   */
  const flatB = HD.baselineFrom(flat(20, 100000), 85000, TODAY);
  const wobblyB = HD.baselineFrom(
    Array.from({ length: 20 }, (_, i) => ({ date: day(20 - i), price: i % 2 ? 130000 : 70000 })),
    85000, TODAY);
  const fp = HD.hotScore(flatB, HD.CONFIDENCE.HIGH).parts;
  const wp = HD.hotScore(wobblyB, HD.CONFIDENCE.HIGH).parts;
  eq(fp.volatility, 0, '변동 없는 계열은 감점 없음');
  ok(wp.volatility < 0, '변동성 큰 계열은 감점', `volatility=${wobblyB.volatility}% → ${wp.volatility}점`);
}

/* ─────────────────────────────────────────────────────────────
   [7] 근거 문장 — PHASE 9 (전부 DB 값으로 되짚을 수 있어야 한다)
   ───────────────────────────────────────────────────────────── */
console.log('\n[7] 근거 문장');
{
  const pts = flat(28, 219000).concat([{ date: day(0), price: 175000 }]);
  const r = ev(BODY, 175000, pts);
  const texts = r.reasons.map(x => x.text).join(' | ');
  ok(/30일 중앙값/.test(texts), '중앙값 대비 문장');
  ok(/원 하락/.test(texts), '직전 대비 하락 문장');
  ok(!/무조건|역대급|지금 사세요/.test(texts), '재촉·과장 표현 없음');
  ok(!/60%|정가/.test(texts), '쇼핑몰 정가 기준 할인율을 말하지 않는다');
  const m = texts.match(/중앙값\(([\d,]+)원\)/);
  ok(m && Number(m[1].replace(/,/g, '')) === 219000, '문장 속 숫자가 실제 중앙값과 일치');
}

/* ─────────────────────────────────────────────────────────────
   [8] source 등록부 — PHASE 2
   ───────────────────────────────────────────────────────────── */
console.log('\n[8] source 등록부');
ok(HS.sourceById('internal-history').enabled(), 'internal-history 는 켜져 있다');
ok(!HS.sourceById('coupang-goldbox').enabled(), 'coupang-goldbox 는 꺼져 있다 (NOT VERIFIED)');
{
  const saved = process.env.ADPICK_HOTDEAL_FUNCTION;
  delete process.env.ADPICK_HOTDEAL_FUNCTION;
  ok(!HS.sourceById('adpick-hotdeal').enabled(), 'ADPICK 핫딜은 function 이름 없이는 꺼져 있다');
  if (saved) process.env.ADPICK_HOTDEAL_FUNCTION = saved;
}
ok(HS.activeSources().every(s => typeof s.id === 'string'), '켜진 source 는 모두 id 를 가진다');

/* ─────────────────────────────────────────────────────────────
   [9] 결정론 — 같은 입력이면 같은 판정
   ───────────────────────────────────────────────────────────── */
console.log('\n[9] 결정론');
{
  const pts = flat(28, 219000).concat([{ date: day(0), price: 175000 }]);
  const a = JSON.stringify(ev(BODY, 175000, pts));
  const b = JSON.stringify(ev(BODY, 175000, pts));
  ok(a === b, '같은 입력 → 같은 출력');
}

/* ───────────────────────────────────────────────────────────── */
console.log(`\n${'='.repeat(52)}`);
console.log(`PASS ${pass}  /  FAIL ${fail}`);
if (fail) { console.log('실패: ' + failures.join(', ')); process.exit(1); }
