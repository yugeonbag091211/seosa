#!/usr/bin/env node
'use strict';
/*
 * 일일 가격 하락(api/_dailydrop.js) 회귀 시험. 완전 오프라인 — DB·외부 호출 0회.
 *
 * 여기서 고정하는 것은 «핫딜의 정의» 다.
 *
 *   HOT DEAL = 같은 상품 · 같은 몰 · 같은 옵션에서
 *              어제(KST)의 마지막 유효 관측보다
 *              오늘(KST)의 마지막 유효 관측이 실제로 낮은 것
 *
 * 이 정의가 흔들리면 화면의 핫딜 창이 다시 며칠씩 같은 얼굴이 된다
 * (2026-09-20 감사: ACTIVE 49행 중 44행이 이미 만료된 행이었다).
 */

global.fetch = async url => { throw new Error(`오프라인 테스트에서 외부 호출: ${url}`); };

const DD = require('../api/_dailydrop');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  — ${detail}` : ''}`); }
}
function eq(a, b, name) { ok(a === b, name, a === b ? String(a) : `기대 ${b} / 실제 ${a}`); }
function section(t) { console.log(`\n[${t}]`); }

const TODAY = '2026-09-20';
const YEST = '2026-09-19';

/**
 * 관측 한 점.
 * @param day  KST 달력 날짜
 * @param price 가격
 * @param hhmm KST 시각 (같은 날 여러 관측의 순서를 가르는 값)
 */
function pt(day, price, hhmm) {
  const [h, m] = String(hhmm || '12:00').split(':').map(Number);
  // KST 시각 → UTC 인스턴트. recorded_at 은 언제나 UTC 로 저장된다.
  const at = new Date(Date.parse(`${day}T00:00:00Z`) + ((h - 9) * 60 + m) * 60000).toISOString();
  return { price, recorded_at: at, recorded_date: day };
}

console.log('=== 일일 가격 하락 — 정의 회귀 (외부 호출 0회) ===');

/* ─────────────────────────────────────────────────────────────── */
section('1) 기본 판정 — 어제 대비 오늘');
{
  const r = DD.dailyDrop([pt(YEST, 10000), pt(TODAY, 8000)], { today: TODAY });
  eq(r.ok, true, '어제 10000 / 오늘 8000 → 포함');
  eq(r.pct, 20, '하락률 20%');
  eq(r.amount, 2000, '하락액 2,000원');
  eq(r.yesterdayPrice, 10000, '어제 가격을 그대로 싣는다');
  eq(r.todayPrice, 8000, '오늘 가격을 그대로 싣는다');
  eq(r.reason, 'OK', '이유 OK');
}
{
  eq(DD.dailyDrop([pt(YEST, 10000), pt(TODAY, 10000)], { today: TODAY }).reason,
    DD.REASON.NOT_LOWER, '어제 10000 / 오늘 10000 → 제외 (가격이 같다)');
  eq(DD.dailyDrop([pt(YEST, 10000), pt(TODAY, 12000)], { today: TODAY }).reason,
    DD.REASON.NOT_LOWER, '어제 10000 / 오늘 12000 → 제외 (올랐다)');
}

section('2) 한쪽이 없으면 비교하지 않는다');
{
  eq(DD.dailyDrop([pt(TODAY, 8000)], { today: TODAY }).reason,
    DD.REASON.NO_YESTERDAY, '어제가 없으면 일일 핫딜이 아니다');
  eq(DD.dailyDrop([pt(YEST, 10000)], { today: TODAY }).reason,
    DD.REASON.NO_TODAY, '오늘이 없으면 (=stale) 일일 핫딜이 아니다');
  eq(DD.dailyDrop([], { today: TODAY }).reason, DD.REASON.NO_POINTS, '이력이 없으면 후보가 아니다');
  eq(DD.dailyDrop(null, { today: TODAY }).reason, DD.REASON.NO_POINTS, 'null 안전');
}
{
  // 그제(9/18)만 있고 어제가 없는 경우 — «직전 관측» 이 아니라 «어제» 여야 한다.
  const r = DD.dailyDrop([pt('2026-09-18', 20000), pt(TODAY, 9000)], { today: TODAY });
  eq(r.reason, DD.REASON.NO_YESTERDAY, '그제 값은 어제 자리를 대신하지 못한다');
  eq(r.ok, false, '그래서 후보가 아니다');
}

section('3) 같은 날 여러 관측 — 마지막 유효 관측을 쓴다');
{
  // 오늘 두 번: 01시 수집기 9000 → 14시 사용자 검색 8000. 오늘 값은 8000이다.
  const r = DD.dailyDrop([
    pt(YEST, 10000, '01:00'), pt(YEST, 11000, '20:00'),
    pt(TODAY, 9000, '01:00'), pt(TODAY, 8000, '14:00')
  ], { today: TODAY });
  eq(r.todayPrice, 8000, '오늘은 가장 늦게 관측된 값');
  eq(r.yesterdayPrice, 11000, '어제도 가장 늦게 관측된 값');
  eq(r.amount, 3000, '하락액은 그 둘의 차');
}
{
  // 순서가 뒤섞여 들어와도 결과가 같아야 한다 (정렬을 가정하지 않는다).
  const rows = [pt(TODAY, 8000, '14:00'), pt(YEST, 11000, '20:00'),
    pt(TODAY, 9000, '01:00'), pt(YEST, 10000, '01:00')];
  const r = DD.dailyDrop(rows, { today: TODAY });
  eq(r.todayPrice, 8000, '입력 순서가 달라도 같은 오늘 값');
  eq(r.yesterdayPrice, 11000, '입력 순서가 달라도 같은 어제 값');
}

section('4) 비정상 가격은 관측이 아니다');
{
  eq(DD.dailyDrop([pt(YEST, 10000), pt(TODAY, 0)], { today: TODAY }).reason,
    DD.REASON.NO_TODAY, '0원은 오늘 관측으로 치지 않는다');
  eq(DD.dailyDrop([pt(YEST, 10000), pt(TODAY, -5000)], { today: TODAY }).reason,
    DD.REASON.NO_TODAY, '음수도 마찬가지');
  eq(DD.dailyDrop([pt(YEST, 10000), { price: null, recorded_at: pt(TODAY, 1).recorded_at }], { today: TODAY }).reason,
    DD.REASON.NO_TODAY, 'null 도 마찬가지');
  eq(DD.dailyDrop([pt(YEST, 0), pt(TODAY, 8000)], { today: TODAY }).reason,
    DD.REASON.NO_YESTERDAY, '어제가 0원이면 비교 기준이 없다');
  // 문자열 음수를 parsePrice 가 양수로 되살리는 일이 없어야 한다.
  eq(DD.dailyDrop([pt(YEST, 10000), { price: '-8,000원', recorded_at: pt(TODAY, 1).recorded_at }], { today: TODAY }).reason,
    DD.REASON.NO_TODAY, '"-8,000원" 을 8000 으로 되살리지 않는다');
}

section('5) 임계값 — 실측 분포에서 정한 값 (모듈 주석 참고)');
{
  eq(DD.MIN_DROP_PCT, 5, '최소 하락률 5% (하루 후보 22~175개)');
  eq(DD.MIN_DROP_AMOUNT, 500, '최소 하락액 500원 (pct≥5 후보의 3.1%만 걸러낸다)');
  eq(DD.dailyDrop([pt(YEST, 100000), pt(TODAY, 97000)], { today: TODAY }).reason,
    DD.REASON.BELOW_MIN_PCT, '3% 하락은 기준 미달');
  eq(DD.dailyDrop([pt(YEST, 7590), pt(TODAY, 7490)], { today: TODAY }).reason,
    DD.REASON.BELOW_MIN_PCT, '7,590→7,490 같은 잔변동은 제외');
  // 하락률은 넉넉한데 액수가 잔돈인 경우 (1,000 → 900 = 10% / 100원)
  eq(DD.dailyDrop([pt(YEST, 1000), pt(TODAY, 900)], { today: TODAY }).reason,
    DD.REASON.BELOW_MIN_AMOUNT, '하락률이 커도 액수가 잔돈이면 제외');
  eq(DD.dailyDrop([pt(YEST, 10000), pt(TODAY, 9400)], { today: TODAY }).ok, true,
    '6% · 600원은 통과');
}

section('6) 이상치 — 80% 이상 하락은 인하가 아니라 매칭 오류');
{
  const r = DD.dailyDrop([pt(YEST, 100000), pt(TODAY, 10000)], { today: TODAY });
  eq(r.reason, DD.REASON.IMPLAUSIBLE, '90% 하락은 제외');
  eq(r.ok, false, '노출하지 않는다');
  eq(DD.dailyDrop([pt(YEST, 100000), pt(TODAY, 21000)], { today: TODAY }).ok, true,
    '79% 하락은 통과 (경계 바로 아래)');
}

section('7) KST 자정 경계 — 라벨이 아니라 recorded_at 으로 가른다');
{
  /*
   * UTC 2026-09-19T16:00Z 는 KST 2026-09-20 01:00 이다. 수집 크론이 도는 시각이고,
   * 2026-08-27 이전 행은 recorded_date 라벨이 «2026-09-19» 로 잘려 있다.
   * 라벨을 믿으면 오늘 값이 어제로 밀려 하락이 통째로 사라진다.
   */
  const kstMidnightRun = { price: 8000, recorded_at: '2026-09-19T16:00:00.000Z', recorded_date: '2026-09-19' };
  const r = DD.dailyDrop([pt(YEST, 10000, '13:00'), kstMidnightRun], { today: TODAY });
  eq(r.ok, true, 'UTC 라벨이 하루 밀려 있어도 KST 로 오늘이다');
  eq(r.todayPrice, 8000, '오늘 값으로 잡힌다');
  eq(r.pct, 20, '하락률이 그대로 계산된다');
}
{
  // KST 23:59 (= UTC 14:59) 도 그날이다.
  const late = { price: 8000, recorded_at: '2026-09-20T14:59:00.000Z', recorded_date: '2026-09-20' };
  eq(DD.dailyDrop([pt(YEST, 10000), late], { today: TODAY }).ok, true, 'KST 23:59 도 오늘이다');
  // KST 다음 날 00:00 (= UTC 15:00) 은 오늘이 아니다.
  const next = { price: 8000, recorded_at: '2026-09-20T15:00:00.000Z', recorded_date: '2026-09-20' };
  eq(DD.dailyDrop([pt(YEST, 10000), next], { today: TODAY }).reason, DD.REASON.NO_TODAY,
    'KST 로 다음 날이면 오늘 관측이 아니다');
}
eq(DD.kstYesterday('2026-01-01'), '2025-12-31', '해가 바뀌는 경계');
eq(DD.kstYesterday('2026-03-01'), '2026-02-28', '달이 바뀌는 경계');
eq(DD.kstYesterday('nope'), '', '날짜가 아니면 빈 문자열');

section('8) 계열 키 — 몰·옵션이 다르면 같은 계열이 아니다');
{
  const base = { product_id: 'p1', mall: '쿠팡', vendor_item_id: '111' };
  eq(DD.seriesKey(base), 'p1|쿠팡|111', '상품·몰·옵션이 키다');
  ok(DD.seriesKey(base) !== DD.seriesKey({ product_id: 'p1', mall: 'ADPICK', vendor_item_id: '111' }),
    '몰이 다르면 다른 계열 — 비교 금지');
  ok(DD.seriesKey(base) !== DD.seriesKey({ product_id: 'p1', mall: '쿠팡', vendor_item_id: '222' }),
    '옵션(vid)이 다르면 다른 계열 — 비교 금지');
  // 컬럼이 비어 있으면 link 에서 뽑는다 (_price.vendorIdOf 와 같은 규칙).
  eq(DD.seriesKey({ product_id: 'p1', mall: '쿠팡', vendor_item_id: '',
    link: 'https://link.coupang.com/re/AFFSDP?pageKey=p1&itemId=9&vendorItemId=777' }),
  'p1|쿠팡|777', 'vid 컬럼이 비면 link 에서 뽑는다');
}

section('9) 같은 상품의 여러 옵션 — 대표 한 장을 고른다');
{
  const a = { key: 'p|쿠팡|A', pct: 12, amount: 1200, todayAt: '2026-09-20T01:00:00Z' };
  const b = { key: 'p|쿠팡|B', pct: 20, amount: 900, todayAt: '2026-09-20T01:00:00Z' };
  eq(DD.pickPrimary(a, b).key, 'p|쿠팡|B', '하락률이 큰 옵션이 대표');
  const c = { key: 'p|쿠팡|C', pct: 20, amount: 5000, todayAt: '2026-09-20T01:00:00Z' };
  eq(DD.pickPrimary(b, c).key, 'p|쿠팡|C', '하락률이 같으면 하락액이 큰 쪽');
  const d = { key: 'p|쿠팡|D', pct: 20, amount: 5000, todayAt: '2026-09-20T09:00:00Z' };
  eq(DD.pickPrimary(c, d).key, 'p|쿠팡|D', '둘 다 같으면 더 최근에 본 쪽');
  const e = { key: 'p|쿠팡|A0', pct: 20, amount: 5000, todayAt: '2026-09-20T09:00:00Z' };
  eq(DD.pickPrimary(d, e).key, 'p|쿠팡|A0', '전부 같으면 키 사전순 — 결정론');
  eq(DD.pickPrimary(null, a).key, a.key, '한쪽이 없으면 있는 쪽');
  eq(DD.pickPrimary(a, null).key, a.key, '반대도 마찬가지');
}

section('10) 정렬 — 하락률 → 하락액 → 신선도 → 키');
{
  const rows = [
    { key: 'c', pct: 8, amount: 9000, todayAt: 'T3' },
    { key: 'a', pct: 20, amount: 1000, todayAt: 'T1' },
    { key: 'b', pct: 20, amount: 5000, todayAt: 'T1' }
  ];
  const sorted = rows.slice().sort(DD.compareDrops).map(r => r.key);
  eq(sorted.join(','), 'b,a,c', '하락률 먼저, 같으면 하락액');
  // 같은 입력이면 같은 순서 (결정론)
  eq(rows.slice().sort(DD.compareDrops).map(r => r.key).join(','), sorted.join(','), '결정론');
}

section('11) 두 경로의 가격이 모두 후보가 된다 (수집기 · 사용자 검색)');
{
  /*
   * price_history 는 source 로 경로를 구분하지만, 일일 하락 판정은 source 를
   * 보지 않는다 — 어느 경로로 들어왔든 «그 시각 그 옵션의 관측» 이라는 사실은
   * 같기 때문이다. 검색이 남긴 오늘 값이 빠지면, 낮에 가격이 내려간 상품이
   * 다음 날 새벽까지 핫딜에 오르지 못한다.
   */
  const collector = Object.assign(pt(YEST, 10000, '01:00'), { source: 'collect' });
  const search = Object.assign(pt(TODAY, 8000, '15:00'), { source: 'search' });
  eq(DD.dailyDrop([collector, search], { today: TODAY }).ok, true, '검색이 남긴 오늘 가격도 쓴다');

  const searchY = Object.assign(pt(YEST, 10000, '15:00'), { source: 'search' });
  const collectT = Object.assign(pt(TODAY, 8000, '01:00'), { source: 'collect' });
  eq(DD.dailyDrop([searchY, collectT], { today: TODAY }).ok, true, '수집기가 남긴 오늘 가격도 쓴다');
}

section('12) 되짚을 수 있는 값 — 관측 시각을 같이 싣는다');
{
  const { observedKstDate } = require('../api/_price');
  const r = DD.dailyDrop([pt(YEST, 10000, '01:00'), pt(TODAY, 8000, '01:00')], { today: TODAY });
  /*
   * recorded_at 은 UTC 인스턴트다 — KST 01시 관측은 전날 16:00Z 로 적힌다.
   * 그래서 시각 문자열의 앞자리가 아니라 «KST 로 며칠인가» 를 확인한다.
   */
  eq(observedKstDate({ recorded_at: r.yesterdayAt }), YEST, '어제 관측 시각은 KST 로 어제');
  eq(observedKstDate({ recorded_at: r.todayAt }), TODAY, '오늘 관측 시각은 KST 로 오늘');
  ok(r.yesterdayAt < r.todayAt, '어제가 오늘보다 앞선다');
}

console.log('\n====================================================');
console.log(`PASS ${pass}  /  FAIL ${fail}`);
if (fail) { console.log('실패: ' + failures.join(', ')); process.exit(1); }
