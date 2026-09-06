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
/* 비동기 검사는 여기에 모아 두고 요약 직전에 기다린다 — 안 그러면 집계가 어긋난다. */
const PENDING = [];
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
// 음수는 문자열이든 숫자든 전부 거부한다. 음수 가격은 source 응답이 깨졌다는
// 신호이지 "싼 값"이 아니다 — 부호를 지워 양수로 되살리면 없는 딜이 생긴다.
eq(HD.toKRW('-500'), null, '문자열 음수 거부');
eq(HD.toKRW('-1,000원'), null, '문자열 음수 + 쉼표 + 단위 거부');
eq(HD.toKRW(' -500 '), null, '앞뒤 공백이 있는 문자열 음수 거부');
eq(HD.toKRW('−500'), null, '유니코드 마이너스(U+2212) 거부');
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

/* ── currentObserved 는 «최신 관측» 확인이다 (BLOCKER 4) ──────────── */
{
  // 옛 기록에 같은 값이 있어도 «최신» 관측이 다르면 확인된 것이 아니다.
  const pts = [{ date: day(36), price: 80000 }, { date: day(35), price: 80000 },
    { date: day(2), price: 100000 }, { date: day(1), price: 100000 }, { date: day(0), price: 100000 }];
  const b = HD.baselineFrom(pts, 80000, TODAY);
  eq(b.latestPrice, 100000, '최신 관측가');
  eq(b.currentObserved, false, '옛 기록에만 있는 값은 확인된 것이 아니다');
}
{
  const b = HD.baselineFrom(flat(10, 100000), 100000, TODAY);
  eq(b.currentObserved, true, '최신 관측 = 현재가 + 신선하면 확인됨');
}
{
  // 최신 관측이 현재가와 같아도 오래됐으면 «지금» 값의 근거가 아니다.
  const b = HD.baselineFrom(flat(10, 100000, 6), 100000, TODAY);
  ok(b.staleDays > HD.CONFIRM_MAX_STALE_DAYS, '전제: staleDays 가 확인 한계를 넘음', String(b.staleDays));
  eq(b.currentObserved, false, '오래된 일치는 확인으로 치지 않는다');
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
/* ── VERIFIED 는 «최신 관측» 확인을 요구한다 (BLOCKER 4 · 필수 3케이스) ── */
{
  /*
   * 1) 옛 기록에 같은 가격이 있지만 최신 관측은 다르다 → VERIFIED 금지.
   *    기준선은 20% 할인이 나오도록 잡아 «점수 때문이 아니라 확인 때문에»
   *    막혔음을 분명히 한다.
   */
  const pts = flat(6, 175000, 30)          // 한 달 전에 175,000 을 본 적이 있다
    .concat(flat(20, 219000));             // 그 뒤로 오늘까지는 219,000
  const r = ev(BODY, 175000, pts);
  eq(r.baseline.latestPrice, 219000, '전제: 최신 관측은 219,000');
  ok(r.hotScore >= HD.VERIFIED_HOT_MIN, '전제: 점수는 VERIFIED 임계를 넘는다', String(r.hotScore));
  ok(r.status !== HD.STATUS.VERIFIED_HOT, '옛 일치만으로는 VERIFIED 금지', r.status);
}
{
  // 2) 최신 관측이 현재가와 같고 신선하다 → VERIFIED 가능
  const pts = flat(28, 219000).concat([{ date: day(0), price: 175000 }]);
  const r = ev(BODY, 175000, pts);
  eq(r.baseline.currentObserved, true, '전제: 최신 관측이 현재가를 확인');
  eq(r.status, HD.STATUS.VERIFIED_HOT, '최신 확인 + 신선 → VERIFIED');
}
{
  // 3) 최신 관측이 현재가와 같지만 오래됐다 → VERIFIED 금지
  const pts = flat(28, 219000, 6).concat([{ date: day(5), price: 175000 }]);
  const r = ev(BODY, 175000, pts);
  eq(r.baseline.latestPrice, 175000, '전제: 최신 관측 = 현재가');
  ok(r.baseline.staleDays > HD.CONFIRM_MAX_STALE_DAYS, '전제: 오래됨', String(r.baseline.staleDays));
  ok(r.status !== HD.STATUS.VERIFIED_HOT, '오래된 확인은 VERIFIED 금지', r.status);
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
   [8-b] ADPICK 쇼핑메이트 핫딜 API — 공식 계약 (외부 호출 0회)
   ───────────────────────────────────────────────────────────── */
console.log('\n[8-b] ADPICK 핫딜 어댑터');
{
  const AH = require('../api/_adpickhot');

  // 공식 응답 fixture — 문서에 적힌 필드 이름 그대로
  const OFFICIAL = {
    list: [
      { product_name: '삼성전자 갤럭시 버즈3 프로', photo: 'https://img/a.jpg', mall: '쿠팡',
        price_sale: '175,000', price_org: '219,000', commission: '3.5',
        buyurl: 'https://adpick.co.kr/go/abc123' },
      { product_name: '로지텍 MX Master 3S', photo: 'https://img/b.jpg', mall: '11번가',
        price_sale: '119000', price_org: '139000', commission: '2',
        buyurl: 'https://adpick.co.kr/go/def456' }
    ]
  };
  const p = AH.parseHotdealResponse(OFFICIAL);
  eq(p.items.length, 2, '공식 응답 파싱');
  eq(p.malformed, false, 'malformed 아님');
  {
    const c = HS.normalizeCandidate(p.items[0], 'adpick-hotdeal');
    ok(!!c, '정규화 통과');
    eq(c.salePrice, 175000, 'price_sale 파싱');
    eq(c.referencePrice, 219000, 'price_org 는 참고 정가로만');
    eq(c.mall, '쿠팡', 'mall 정규화');
    eq(c.affiliateUrl, 'https://adpick.co.kr/go/abc123', 'buyurl → affiliateUrl');
    eq(c.externalId, 'https://adpick.co.kr/go/abc123', 'buyurl 이 외부 식별자');
  }

  // malformed
  eq(AH.parseHotdealResponse({}).malformed, true, 'list 없는 응답은 malformed');
  eq(AH.parseHotdealResponse(null).malformed, true, 'null 응답은 malformed');
  eq(AH.parseHotdealResponse({ list: 'nope' }).malformed, true, 'list 가 배열이 아니면 malformed');
  {
    const r = AH.parseHotdealResponse({ list: [null, 3, { product_name: 'x' }, { buyurl: 'https://a/b' }] });
    eq(r.items.length, 0, '깨진 항목은 전부 제외');
    eq(r.dropped, 4, '제외 건수를 센다');
  }

  // invalid price — 파싱은 통과하되 정규화에서 후보가 되지 못한다
  {
    const r = AH.parseHotdealResponse({ list: [
      { product_name: 'a', buyurl: 'https://a/1', price_sale: '0' },
      { product_name: 'b', buyurl: 'https://a/2', price_sale: '-1,000원' },
      { product_name: 'c', buyurl: 'https://a/3', price_sale: '가격문의' }
    ] });
    eq(r.items.length, 3, '항목 자체는 살아 있고');
    eq(r.items.filter(x => HS.normalizeCandidate(x, 's')).length, 0, '가격이 잘못된 것은 후보가 되지 못한다');
  }

  // 자격증명 없음
  {
    const saved = process.env.ADPICK_AFFILIATE_ID;
    delete process.env.ADPICK_AFFILIATE_ID;
    ok(!AH.hasCredential(), 'affid 없으면 자격증명 없음');
    ok(!HS.sourceById('adpick-hotdeal').enabled(), 'affid 없으면 source 가 꺼져 있다');
    if (saved) process.env.ADPICK_AFFILIATE_ID = saved;
  }

  // affid 로그 redaction
  {
    const saved = process.env.ADPICK_AFFILIATE_ID;
    process.env.ADPICK_AFFILIATE_ID = 'SECRET_MEMBER_42';
    const msg = 'fetch failed https://adpick.co.kr/apis/sdk_shopping_hotdeal.php?affid=SECRET_MEMBER_42';
    const red = AH.redact(msg);
    ok(red.indexOf('SECRET_MEMBER_42') < 0, 'affid 값이 로그에 남지 않는다');
    ok(red.indexOf('***') > -1, '가려진 표시가 남는다');
    // 값을 몰라도 질의문자열 형태는 막는다
    ok(AH.redact('...?affid=OTHER_ID&x=1').indexOf('OTHER_ID') < 0, 'affid= 질의문자열 자체를 가린다');
    ok(HS.sourceById('adpick-hotdeal').enabled(), 'affid 가 있으면 source 가 켜진다');
    if (saved) process.env.ADPICK_AFFILIATE_ID = saved; else delete process.env.ADPICK_AFFILIATE_ID;
  }

  // 1분 1회 제한 — 공식 문서의 호출 한도를 코드가 강제하는가
  ok(AH.MIN_INTERVAL_MS >= 60000, '최소 호출 간격이 60초 이상', String(AH.MIN_INTERVAL_MS));

  // 자격증명이 없으면 네트워크를 타지 않고 즉시 값으로 실패한다 (throw 하지 않는다)
  PENDING.push((async () => {
    const saved = process.env.ADPICK_AFFILIATE_ID;
    delete process.env.ADPICK_AFFILIATE_ID;
    const r = await AH.fetchHotdeals();
    eq(r.ok, false, '자격증명 없으면 ok=false');
    eq(r.reason, 'no-credential', '이유를 값으로 돌려준다');
    eq(r.items.length, 0, '빈 목록');
    if (saved) process.env.ADPICK_AFFILIATE_ID = saved;
  })());
}

/* ─────────────────────────────────────────────────────────────
   [8-c] 보안 — 마이그레이션 RLS 계약 (SQL 실행 없이 파일로 검증)
   ───────────────────────────────────────────────────────────── */
console.log('\n[8-c] 마이그레이션 RLS');
{
  const fs = require('fs');
  const path = require('path');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', '2026-09-06-hotdeals.sql'), 'utf8');
  ok(/alter table hotdeals\s+enable row level security/i.test(sql), 'hotdeals RLS 활성화');
  ok(/alter table hotdeal_job_state\s+enable row level security/i.test(sql), 'hotdeal_job_state RLS 활성화');
  ok(/create table if not exists hotdeal_job_state/i.test(sql), '전용 잠금 표를 만든다');
  ok(/lock_token/.test(sql) && /lock_until/.test(sql), '잠금 토큰·만료 컬럼');
  ok(/notify pgrst, 'reload schema'/.test(sql), 'PostgREST 스키마 갱신');
  // 정책을 만들면 anon 이 열린다. v1 은 server-only 이므로 정책이 없어야 한다.
  ok(!/create policy/i.test(sql), '정책을 만들지 않는다 (service_role 전용)');
  ok(/price_job_state/.test(sql), '왜 기존 표를 안 쓰는지 근거를 남긴다');
}

/* ─────────────────────────────────────────────────────────────
   [8-d] 수집기 잠금 — CAS · 소유권 · 무단 우회 금지
   ───────────────────────────────────────────────────────────── */
console.log('\n[8-d] 수집기 잠금');
{
  const C = require('./collect-hotdeals.js');

  /** 최소 supabase 스텁. update 는 .eq 조건을 실제로 검사한다. */
  function stubDb(row, opts) {
    const o = opts || {};
    const state = { row: row ? Object.assign({}, row) : null };
    return {
      state,
      from() {
        const q = { _eq: {}, _upd: null };
        q.select = () => q;
        q.eq = (k, v) => { q._eq[k] = v; return q; };
        // ★ 복사본을 돌려준다. 참조를 주면 «읽은 값» 이 나중 변경에 같이 끌려가
        //   CAS 비교가 자기 자신과 비교하게 된다(실제 DB 는 그렇지 않다).
        q.maybeSingle = async () => o.readError
          ? { data: null, error: { message: o.readError } }
          : { data: state.row ? Object.assign({}, state.row) : null, error: null };
        /*
         * update() 는 «패치를 기록만» 한다. 실제 적용과 CAS 비교는 await 시점
         * (q.then)에 한 번만 일어난다. 여기서 미리 적용해 버리면 CAS 가
         * 자기가 방금 바꾼 값과 비교하게 되어 항상 실패한다.
         */
        q.update = (patch) => { q._upd = patch; return q; };
        q.then = (res, rej) => Promise.resolve().then(() => {
          if (o.updateError) return { data: null, error: { message: o.updateError } };
          // CAS: lock_token 조건이 현재 값과 다르면 0행
          if (q._eq.lock_token !== undefined
            && String(state.row.lock_token || '') !== String(q._eq.lock_token)) {
            return { data: [], error: null };
          }
          if (q._upd) Object.assign(state.row, q._upd);
          return { data: [{ id: 1 }], error: null };
        }).then(res, rej);
        return q;
      }
    };
  }

  const IDLE = { id: 1, status: 'idle', lock_token: '', lock_until: null };

  PENDING.push((async () => {
    // 1) 정상 획득
    const db1 = stubDb(IDLE);
    const a1 = await C.acquireLock(db1);
    eq(a1.result, C.LOCK.ACQUIRED, '비어 있으면 잠금 획득');
    ok(!!a1.token, '토큰 발급');
    eq(db1.state.row.status, 'running', 'status=running 으로 바뀐다');

    // 2) 이중 획득 — 이미 유효한 잠금이 있으면 SKIP
    const held = { id: 1, status: 'running', lock_token: 'other-run',
      lock_until: new Date(Date.now() + 10 * 60000).toISOString() };
    const a2 = await C.acquireLock(stubDb(held));
    eq(a2.result, C.LOCK.SKIP, '남이 쥐고 있으면 SKIP');
    eq(a2.reason, 'held', '이유가 held');

    // 3) 만료된 잠금은 회수 가능
    const stale = { id: 1, status: 'running', lock_token: 'dead-run',
      lock_until: new Date(Date.now() - 60000).toISOString() };
    const a3 = await C.acquireLock(stubDb(stale));
    eq(a3.result, C.LOCK.ACQUIRED, '만료된 잠금은 회수한다');

    // 4) CAS 경쟁 패배 — 읽은 뒤 값이 바뀌면 0행
    const dbRace = stubDb(IDLE);
    const orig = dbRace.from.bind(dbRace);
    dbRace.from = function () {
      const q = orig();
      const realUpdate = q.update.bind(q);
      q.update = (patch) => { dbRace.state.row.lock_token = 'someone-else'; return realUpdate(patch); };
      return q;
    };
    const a4 = await C.acquireLock(dbRace);
    eq(a4.result, C.LOCK.SKIP, 'CAS 패배는 SKIP');
    eq(a4.reason, 'cas_lost', '이유가 cas_lost');

    // 5) ★ 읽기 오류는 조용히 진행하지 않는다 — FAIL 이어야 한다
    const a5 = await C.acquireLock(stubDb(IDLE, { readError: 'connection reset' }));
    eq(a5.result, C.LOCK.FAIL, '잠금 읽기 실패는 FAIL (무단 우회 금지)');

    // 6) 표가 없으면 SKIP (마이그레이션 전 정상 상태)
    const a6 = await C.acquireLock(stubDb(null, { readError: 'relation "hotdeal_job_state" does not exist' }));
    eq(a6.result, C.LOCK.SKIP, '표 없음은 SKIP');
    eq(a6.reason, 'table_missing', '이유가 table_missing');

    // 7) 쓰기 오류도 FAIL
    const a7 = await C.acquireLock(stubDb(IDLE, { updateError: 'permission denied' }));
    eq(a7.result, C.LOCK.FAIL, '잠금 획득 쓰기 실패는 FAIL');

    // 8) ★ 남의 잠금을 풀지 않는다
    const dbRel = stubDb({ id: 1, status: 'running', lock_token: 'owner-A',
      lock_until: new Date(Date.now() + 60000).toISOString() });
    await C.releaseLock({ result: C.LOCK.ACQUIRED, token: 'intruder-B' }, 'done', {}, dbRel);
    eq(dbRel.state.row.lock_token, 'owner-A', '토큰이 다르면 반납이 통하지 않는다');
    eq(dbRel.state.row.status, 'running', '남의 status 를 바꾸지 않는다');

    // 9) 자기 잠금은 정상 반납
    const dbOwn = stubDb({ id: 1, status: 'running', lock_token: 'owner-A',
      lock_until: new Date(Date.now() + 60000).toISOString() });
    await C.releaseLock({ result: C.LOCK.ACQUIRED, token: 'owner-A' }, 'done', { kept: 3 }, dbOwn);
    eq(dbOwn.state.row.lock_token, '', '자기 잠금은 풀린다');
    eq(dbOwn.state.row.status, 'done', 'status 가 done 으로');
  })());
}

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
// 비동기 검사(ADPICK 자격증명 · 잠금 CAS)가 끝난 뒤에 집계한다.
(async () => {
  await Promise.all(PENDING);
  console.log(`\n${'='.repeat(52)}`);
  console.log(`PASS ${pass}  /  FAIL ${fail}`);
  if (fail) { console.log('실패: ' + failures.join(', ')); process.exit(1); }
})();
