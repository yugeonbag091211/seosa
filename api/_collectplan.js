/*
 * Adaptive Collection Planner (수집기 V3) — 1차 검색어 그룹의 호출 순서를 정한다.
 *
 * 순수 함수만 있다. DB·API·시계에 손대지 않는다 — 입력이 같으면 순서도 같다.
 * scripts/collect-all-prices.js 가 PRICE_COLLECTOR_V3=1 일 때만 부른다.
 *
 * ── 왜 가나다순을 버리는가 (2026-09-23 운영 실측) ───────────────────
 *
 *   레거시는 검색어를 가나다순으로 한 줄로 세우고 커서로 이어받는다. 하루에
 *   다 못 도는 몰에서는 «앞쪽만 매일» 돈다. ADPICK 회전 대상의 날짜별 확보율을
 *   가나다 10분위로 나누면 (09-21~09-23):
 *     D0 31.8%  D1 4.0%  D2 3.3%  D3 6.7% … D9 4.4%
 *   회전 버킷은 7일마다 같은 상품·같은 순서로 돌아오므로 D1~D9 는 차례가 오지 않는다.
 *
 * ── 무엇으로 정렬하는가 — 기대 회수량 ────────────────────────────
 *
 *   호출 1회의 비용은 같다. 그러니 «이 호출이 몇 개를 회수할 것인가» 가 큰
 *   그룹부터 부르면 같은 예산에서 회수가 최대가 된다 (단위 비용 배낭 문제는
 *   가치 내림차순 탐욕법이 최적이다).
 *
 *   그룹 가치 = Σ (상품의 확보 확률 × 긴급도), 응답 상한(limit)개까지만 센다
 *   — 응답 하나에 우리 상품이 limit 개보다 많이 실릴 수 없다.
 *
 *   확보 확률은 머신러닝이 아니라 «몰 × tier × 마지막 성공 경과» 표 하나다.
 *   적은 데이터에서도 흔들리지 않고, 표를 보면 왜 그 순서인지 설명된다.
 *
 * ── 기아 방지 ─────────────────────────────────────────────────────
 *
 *   확률만 보면 오래 못 잡은 상품은 영원히 뒤로 밀린다. 그래서 두 겹을 둔다.
 *     ① 긴급도: 목표 주기를 넘긴 만큼 가치가 커진다 (최대 URGENCY_CAP 배).
 *     ② 예약 슬롯: STARVE_EVERY 번째 호출마다 «굶은» 그룹 하나를 부른다.
 *        확률과 무관하게 호출의 1/STARVE_EVERY 가 이 레인에 간다.
 *
 *   ★ 예약 레인은 «가장 오래된 순» 이 아니라 «해시 순 원형 순회» 다.
 *     오래된 순으로 세우면, 영원히 확보되지 않는 상품(판매 종료·옵션 소멸)이
 *     날마다 더 오래돼 맨 앞을 영구히 차지한다. 그러면 최근에 굶기 시작한
 *     상품은 끝내 차례가 오지 않는다 — test-collector-v3 의 40일 시뮬레이션이
 *     실제로 그 모양(58개 그룹 미호출)을 잡았다.
 *     해시 순서는 날짜와 무관하게 고정이고, 마지막으로 부른 위치(커서, uint32
 *     하나)를 날짜를 넘어 저장해 다음 날 그 뒤부터 잇는다. 굶은 그룹이 S개,
 *     하루 예약 호출이 s회면 모든 굶은 그룹이 ⌈S/s⌉일 안에 반드시 한 번 불린다.
 */

'use strict';

/*
 * P̂(확보 | 몰, tier, 신선도) — 호출이 나간 상품 중 그날 수집기가 가격을 확보한 비율.
 *
 * 측정: 2026-09-16·17·20·21·23 KST 운영 데이터, 그날 자기 검색어가 실제로
 * 불린 대상 상품만 (scripts/collector-v3-calibrate.js 로 재현). 신선도는
 * 런타임과 같은 정의 — products.collected_at(모든 경로의 마지막 기록) 기준.
 *
 *   쿠팡   daily   fresh .930 (n=3,926)  lapsed .496 (1,980)  stale .077 (714)  never .025 (938)
 *   ADPICK daily   fresh .955 (n=2,321)  lapsed .635 (1,032)  stale .010 (98)   never .031 (163)
 *   쿠팡   rotation fresh .490 (n=3,053)
 *   ADPICK rotation fresh .725 (n=552)
 *
 * ★ rotation 의 lapsed/stale/never 는 «측정값이 아니다». 회전 수집이 2026-09-21
 *   에 시작돼 아직 한 바퀴도 돌지 않았다. lapsed 는 daily 의 fresh→lapsed 비율
 *   (0.53~0.66)을 곱한 값, stale/never 는 보수적 가정이다. 회전 상품의
 *   stale 에는 «시도했는데 없는» 상품과 «차례가 안 온» 상품이 섞여 있어 daily
 *   stale(0.01~0.08)보다 높게 둔다. 두 바퀴 뒤 다시 보정할 것.
 */
const PRIOR = Object.freeze({
  '쿠팡': Object.freeze({
    daily:    Object.freeze({ fresh: 0.93,  lapsed: 0.50, stale: 0.077, never: 0.025 }),
    rotation: Object.freeze({ fresh: 0.49,  lapsed: 0.29, stale: 0.15,  never: 0.10 })
  }),
  'ADPICK': Object.freeze({
    daily:    Object.freeze({ fresh: 0.955, lapsed: 0.635, stale: 0.01, never: 0.031 }),
    rotation: Object.freeze({ fresh: 0.725, lapsed: 0.43,  stale: 0.15, never: 0.10 })
  })
});

/** tier 별 목표 갱신 주기(일). daily 는 매일, rotation 은 버킷 한 바퀴. */
const INTERVAL_DAYS = Object.freeze({ daily: 1, rotation: 7 });

/** 긴급도 상한 — 오래 굶었다고 확률 0.01 짜리가 fresh 를 무한히 이기면 안 된다. */
const URGENCY_CAP = 4;

/** 이 경과(일)를 넘기면 «굶은» 상품이다. daily 7일, rotation 3바퀴. */
const STARVE_DAYS = Object.freeze({ daily: 7, rotation: 21 });

/** 예약 슬롯 주기 — 8 이면 호출 8번 중 1번(12.5%)이 가장 오래 굶은 그룹에 간다. */
const STARVE_EVERY = 8;

const DAY_MS = 86400000;

/** 마지막 성공 경과(일) → 신선도 등급. 주기 대비 비율로 자른다. */
function freshnessClass(ageDays, tier) {
  if (ageDays == null || !Number.isFinite(ageDays)) return 'never';
  const interval = INTERVAL_DAYS[tier] || 1;
  if (ageDays <= 1.5 * interval) return 'fresh';
  if (ageDays <= 4 * interval) return 'lapsed';
  return 'stale';
}

/** 목표 주기를 넘긴 만큼 커지는 가중치. 주기 안이면 1. 기록이 없으면 상한. */
function urgencyOf(ageDays, tier) {
  if (ageDays == null || !Number.isFinite(ageDays)) return URGENCY_CAP;
  const interval = INTERVAL_DAYS[tier] || 1;
  const over = Math.max(0, ageDays - interval) / interval;
  return Math.min(URGENCY_CAP, 1 + over);
}

/** 오늘 0시(KST) 기준 마지막 성공 경과(일). 오늘 기록은 0 으로 본다. */
function ageDaysOf(collectedAt, dayStartMs) {
  const t = Date.parse(collectedAt || '');
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (dayStartMs - t) / DAY_MS);
}

/** 상품 하나의 확보 확률·긴급도·가치. */
function scoreProduct(p, { mall, tier, dayStartMs, prior = PRIOR }) {
  const ageDays = ageDaysOf(p.collected_at, dayStartMs);
  const cls = freshnessClass(ageDays, tier);
  const table = (prior[mall] || prior['쿠팡'])[tier] || (prior[mall] || prior['쿠팡']).rotation;
  const pHit = table[cls];
  const urgency = urgencyOf(ageDays, tier);
  return { pHit, urgency, value: pHit * urgency, ageDays, cls };
}

/** FNV-1a 32bit. 동점 순서를 날짜마다 바꾸는 데만 쓴다 — 보안 용도가 아니다. */
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 그룹 하나를 채점한다.
 * @returns {{score:number, expected:number, maxAgeDays:number, starving:boolean, pending:number}}
 */
function scoreGroup(rows, ctx) {
  const scored = rows.map(p => {
    const tier = ctx.tierOf(p);
    return { tier, ...scoreProduct(p, { mall: ctx.mall, tier, dayStartMs: ctx.dayStartMs, prior: ctx.prior }) };
  }).sort((a, b) => b.value - a.value);
  const top = scored.slice(0, Math.max(1, ctx.limit || scored.length));
  let score = 0, expected = 0, maxAge = -1, starving = false;
  top.forEach(s => { score += s.value; expected += s.pHit; });
  scored.forEach(s => {
    const age = s.ageDays == null ? Infinity : s.ageDays;
    if (age > maxAge) maxAge = age;
    if (age >= (STARVE_DAYS[s.tier] || STARVE_DAYS.rotation)) starving = true;
  });
  return { score, expected, maxAgeDays: maxAge, starving, pending: rows.length };
}

/**
 * 1차 그룹의 호출 순서를 정한다.
 *
 * @param {Array<{kw:string, rows:Array}>} groups  이미 «오늘 남은 상품» 만 담긴 그룹
 * @param {object} ctx
 *   mall        '쿠팡' | 'ADPICK'
 *   date        KST YYYY-MM-DD — 동점 순서의 씨앗
 *   dayStartMs  KST 오늘 0시 (ms)
 *   tierOf      (row) => 'daily' | 'rotation'
 *   limit       응답 한 번의 최대 항목 수 (쿠팡 10 / ADPICK 20)
 *   starveEvery 예약 슬롯 주기 (기본 STARVE_EVERY, 0 이면 끈다)
 *   starveAfter 예약 레인 커서 — 지난번에 마지막으로 부른 굶은 그룹의 hash (없으면 처음부터)
 * @returns {Array<{kw, rows, score, expected, maxAgeDays, starving, lane, hash}>}
 */
function orderGroups(groups, ctx) {
  const every = ctx.starveEvery == null ? STARVE_EVERY : ctx.starveEvery;
  const kwCmp = (a, b) => (a.kw < b.kw ? -1 : a.kw > b.kw ? 1 : 0);
  const seeded = groups.map(g => ({
    kw: g.kw, rows: g.rows, ...scoreGroup(g.rows, ctx),
    hash: hash32(g.kw), tie: hash32(`${ctx.date}|${g.kw}`)
  }));
  const byValue = [...seeded].sort((a, b) => b.score - a.score || a.tie - b.tie || kwCmp(a, b));
  const ring = seeded.filter(g => g.starving).sort((a, b) => a.hash - b.hash || kwCmp(a, b));
  let start = 0;
  if (ctx.starveAfter != null && Number.isFinite(Number(ctx.starveAfter))) {
    start = ring.findIndex(g => g.hash > Number(ctx.starveAfter));
    if (start < 0) start = 0;   // 끝까지 돌았다 — 처음으로 감는다
  }
  const byAge = [...ring.slice(start), ...ring.slice(0, start)];

  const out = [];
  const taken = new Set();
  let iv = 0, ia = 0;
  while (out.length < seeded.length) {
    const starveSlot = every > 0 && (out.length + 1) % every === 0;
    let g = null;
    if (starveSlot) {
      while (ia < byAge.length && taken.has(byAge[ia].kw)) ia++;
      if (ia < byAge.length) { g = byAge[ia++]; g.lane = 'starve'; }
    }
    if (!g) {
      while (iv < byValue.length && taken.has(byValue[iv].kw)) iv++;
      if (iv >= byValue.length) break;
      g = byValue[iv++]; g.lane = 'value';
    }
    taken.add(g.kw);
    out.push(g);
  }
  return out.map(({ tie, ...g }) => g);  // eslint-disable-line no-unused-vars
}

/**
 * 실제로 부른 그룹들(계획 순서대로)을 보고 예약 레인 커서를 옮긴다.
 * 예약 레인 그룹이 하나도 없었으면 커서는 그대로다.
 */
function advanceStarveCursor(cursor, calledGroups) {
  let c = cursor == null ? null : cursor;
  (calledGroups || []).forEach(g => { if (g && g.lane === 'starve') c = g.hash; });
  return c;
}

/** 앞에서 n 개 그룹을 부를 때의 기대 회수 합 (로그·시뮬레이션용). */
function expectedWithin(ordered, n) {
  let s = 0;
  for (let i = 0; i < Math.min(n, ordered.length); i++) s += ordered[i].expected;
  return s;
}

module.exports = {
  PRIOR, INTERVAL_DAYS, URGENCY_CAP, STARVE_DAYS, STARVE_EVERY,
  freshnessClass, urgencyOf, ageDaysOf, scoreProduct, scoreGroup, orderGroups, expectedWithin, hash32,
  advanceStarveCursor
};
