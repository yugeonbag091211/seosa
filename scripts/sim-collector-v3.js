#!/usr/bin/env node
/*
 * 수집기 V3 오프라인 시뮬레이션 — 레거시(가나다순) 와 V3(기대 회수량 순) 비교.
 *
 *   node scripts/collector-v3-snapshot.js <폴더>        # 운영 DB 읽기 전용 스냅숏
 *   node scripts/sim-collector-v3.js <폴더> [--days 21] [--seeds 5]
 *   node scripts/sim-collector-v3.js <폴더> --calibrate  # api/_collectplan.js PRIOR 재현
 *
 * 외부 API·DB 호출 0회. 같은 입력·같은 씨앗이면 같은 숫자가 나온다.
 *
 * ── 세계 모델 (계획기 보정표와 «독립») ─────────────────────────────
 *   상품마다 잠재 도달성(검색하면 우리 상품·옵션이 응답에 실리는가)이 있다.
 *   초기값은 스냅숏의 «관측 이력» 으로 정한다 — 계획기가 쓰는 PRIOR 표가 아니다.
 *     최근 14일 수집기가 확보한 적 있음        → 0.85  (직전 확보 → 다음 확보 81~85%, 실측)
 *     검색어가 불렸는데 한 번도 확보 못 함      → 0.10  (직전 실패 → 다음 확보 7~12%, 실측)
 *     한 번도 검색되지 않음 (회전 대상 대부분) → 몰별 첫 시도 확보율 (쿠팡 .49 / ADPICK .725, 09-23 실측)
 *   하루마다 도달 1% 이탈 / 불가 0.5% 복귀. 도달 상태에서 한 번 부르면 95% 확률로 확보.
 *   응답 하나는 우리 상품을 limit(쿠팡 10 / ADPICK 20)개까지만 싣는다.
 *
 * ── 공통 난수 ────────────────────────────────────────────────────
 *   (씨앗, 상품, 날짜) 해시로 난수를 만든다. 두 전략이 같은 날 같은 상품을
 *   부르면 결과도 같다 — 차이는 «누구를 언제 불렀는가» 에서만 나온다.
 *
 * ── 모델에 없는 것 (두 전략에 똑같이 빠짐) ──────────────────────────
 *   회수 패스(hint·facet·사다리), 교차 매칭, 다른 경로(검색·cron)의 기록,
 *   cron 누락·장애. 1차 패스의 호출 순서와 호출 예산만 비교한다.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Planner = require('../api/_collectplan');

const dir = process.argv[2];
if (!dir) { console.error('사용법: node scripts/sim-collector-v3.js <스냅숏 폴더> [--days 21] [--seeds 5] [--calibrate]'); process.exit(2); }
const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const DAYS = Number(arg('--days', 21));
const SEEDS = Number(arg('--seeds', 5));
const START = arg('--start', '2026-09-24');
/*
 * --world flat : 모든 상품의 도달 확률을 0.5 로 같게 둔다 (스트레스 테스트).
 *   계획기의 신선도 신호가 «아무 정보도 없는» 세계에서도 손해를 보지 않는지 확인한다.
 */
const WORLD = arg('--world', 'history');

const load = (...names) => {
  for (const n of names) { const p = path.join(dir, n); if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); }
  throw new Error(`스냅숏 파일 없음: ${names.join(' / ')}`);
};
const products = load('products.json');
const ph = load('price_history.json', 'price_history_14d.json');
const cc = load('coupang_calls.json', 'coupang_calls_8d.json');
const ac = load('adpick_calls.json', 'adpick_calls_8d.json');
const tb = load('targets_by_bucket.json');

const DAY = 86400000;
const kst = iso => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 10);
const dayStartOf = date => Date.parse(`${date}T00:00:00+09:00`);
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const bucketOf = date => { const n = Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY); return ((n % 7) + 7) % 7; };
const keyOf = p => `${p.product_id}|${p.mall}`;
const prod = new Map(products.map(p => [keyOf(p), p]));

/* 관측 이력 */
const hitDays = new Map();
for (const r of ph) if (r.source === 'collect') {
  const k = `${r.product_id}|${r.mall}`;
  (hitDays.get(k) || hitDays.set(k, new Set()).get(k)).add(kst(r.recorded_at));
}
const calledKw = { '쿠팡': new Map(), 'ADPICK': new Map() };
cc.filter(r => r.source === 'collect').forEach(r => { const d = kst(r.called_at); (calledKw['쿠팡'].get(d) || calledKw['쿠팡'].set(d, new Set()).get(d)).add(r.keyword); });
ac.filter(r => r.source === 'collect' && r.external_call && Number(r.http_status) === 200).forEach(r => { const d = kst(r.called_at); (calledKw.ADPICK.get(d) || calledKw.ADPICK.set(d, new Set()).get(d)).add(r.query); });
const everCalled = { '쿠팡': new Set(), 'ADPICK': new Set() };
Object.entries(calledKw).forEach(([m, byDay]) => byDay.forEach(s => s.forEach(kw => everCalled[m].add(kw))));

/* ── 보정 모드: PRIOR 재현 ─────────────────────────────────────── */
if (process.argv.includes('--calibrate')) {
  const recAll = new Map();
  for (const r of ph) { const k = `${r.product_id}|${r.mall}`; (recAll.get(k) || recAll.set(k, []).get(k)).push(Date.parse(r.recorded_at)); }
  const dailyDays = String(arg('--daily-days', '2026-09-16,2026-09-17,2026-09-20,2026-09-21,2026-09-23')).split(',');
  const rotationDays = String(arg('--rotation-days', '2026-09-23')).split(',');
  const agg = {};
  const days = [...new Set([...dailyDays, ...rotationDays])];
  for (const d of days) {
    const ds = dayStartOf(d);
    for (const t of tb[bucketOf(d)]) {
      if (t.tier === 'daily' && !dailyDays.includes(d)) continue;
      if (t.tier === 'rotation' && !rotationDays.includes(d)) continue;
      const k = `${t.product_id}|${t.mall}`, p = prod.get(k);
      if (!p || !p.keyword || !(calledKw[t.mall].get(d) || new Set()).has(p.keyword)) continue;
      const prior = (recAll.get(k) || []).filter(x => x < ds);
      const age = prior.length ? (ds - Math.max(...prior)) / DAY : null;
      const c = Planner.freshnessClass(age, t.tier);
      const a = agg[`${t.mall}|${t.tier}|${c}`] || (agg[`${t.mall}|${t.tier}|${c}`] = { n: 0, hit: 0 });
      a.n++; if ((hitDays.get(k) || new Set()).has(d)) a.hit++;
    }
  }
  console.log('몰|tier|신선도                n      확보율   (api/_collectplan.js PRIOR)');
  Object.entries(agg).sort().forEach(([k, v]) => {
    const [m, t, c] = k.split('|');
    console.log(`${k.padEnd(26)} ${String(v.n).padStart(6)}  ${(v.hit / v.n).toFixed(3)}    ${Planner.PRIOR[m][t][c]}`);
  });
  process.exit(0);
}

/* ── 세계 ─────────────────────────────────────────────────────── */
function u01(s) { return Planner.hash32(s) / 4294967296; }
const FIRST_TRY = { '쿠팡': 0.49, 'ADPICK': 0.725 };
const dailyKeys = new Set(tb[0].filter(t => t.tier === 'daily').map(t => `${t.product_id}|${t.mall}`));
const tierOf = new Map();
for (let b = 0; b < 7; b++) tb[b].forEach(t => tierOf.set(`${t.product_id}|${t.mall}`, t.tier));
const universe = [...tierOf.keys()].filter(k => prod.has(k) && prod.get(k).keyword);

function makeWorld(seed) {
  const reach = new Map();   // key -> Uint8Array(DAYS)
  for (const k of universe) {
    const p = prod.get(k);
    const ever = hitDays.has(k);
    const tried = everCalled[p.mall].has(p.keyword);
    const p0 = WORLD === 'flat' ? 0.5
      : ever ? 0.85 : tried ? 0.10 : (tierOf.get(k) === 'daily' ? 0.10 : FIRST_TRY[p.mall]);
    const arr = new Uint8Array(DAYS);
    let s = u01(`${seed}|${k}|init`) < p0 ? 1 : 0;
    for (let d = 0; d < DAYS; d++) {
      if (d > 0) { const c = u01(`${seed}|${k}|${d}|churn`); s = s ? (c < 0.01 ? 0 : 1) : (c < 0.005 ? 1 : 0); }
      arr[d] = s;
    }
    reach.set(k, arr);
  }
  return reach;
}

/* ── 한 전략 실행 ─────────────────────────────────────────────── */
const LIMIT = { '쿠팡': 10, 'ADPICK': 20 };
function simulate({ seed, world, order, budget }) {
  const collectedAt = new Map(universe.map(k => [k, prod.get(k).collected_at || null]));
  const lastAttempt = new Map();
  const attemptsPerKey = new Map();
  const scheduled = new Map();
  const cursor = { '쿠팡': null, 'ADPICK': null };
  const m = { calls: { '쿠팡': 0, 'ADPICK': 0 }, hits: { '쿠팡': 0, 'ADPICK': 0 }, targets: { '쿠팡': 0, 'ADPICK': 0 },
    zeroCalls: { '쿠팡': 0, 'ADPICK': 0 }, dailyFresh: [], rot7: [], rot7Reach: [] };
  const lastHitDay = new Map();
  universe.forEach(k => { const t = Date.parse(collectedAt.get(k) || ''); if (Number.isFinite(t)) lastHitDay.set(k, Math.floor((t - dayStartOf(START)) / DAY)); });

  for (let d = 0; d < DAYS; d++) {
    const date = addDays(START, d), ds = dayStartOf(date);
    const today = tb[bucketOf(date)].filter(t => prod.has(`${t.product_id}|${t.mall}`) && prod.get(`${t.product_id}|${t.mall}`).keyword);
    for (const mall of ['쿠팡', 'ADPICK']) {
      const rows = today.filter(t => t.mall === mall).map(t => {
        const k = `${t.product_id}|${t.mall}`;
        scheduled.set(k, (scheduled.get(k) || 0) + 1);
        return { product_id: t.product_id, mall, key: k, tier: t.tier, collected_at: collectedAt.get(k) };
      });
      m.targets[mall] += rows.length;
      const g = new Map();
      rows.forEach(r => { const kw = prod.get(r.key).keyword; (g.get(kw) || g.set(kw, []).get(kw)).push(r); });
      let groups = [...g.entries()].map(([kw, rs]) => ({ kw, rows: rs }));
      if (order === 'legacy') groups.sort((a, b) => (a.kw < b.kw ? -1 : a.kw > b.kw ? 1 : 0));
      else groups = Planner.orderGroups(groups, { mall, date, dayStartMs: ds, tierOf: r => r.tier, limit: LIMIT[mall], starveAfter: cursor[mall] });
      const called = groups.slice(0, budget[mall]);
      if (order !== 'legacy') cursor[mall] = Planner.advanceStarveCursor(cursor[mall], called);
      for (const grp of called) {
        m.calls[mall]++;
        let got = 0;
        const shuffled = [...grp.rows].sort((a, b) => u01(`${seed}|${a.key}|${d}|slot`) - u01(`${seed}|${b.key}|${d}|slot`));
        for (const r of shuffled) {
          lastAttempt.set(r.key, d);
          attemptsPerKey.set(r.key, (attemptsPerKey.get(r.key) || 0) + 1);
          if (got >= LIMIT[mall]) continue;
          if (world.get(r.key)[d] && u01(`${seed}|${r.key}|${d}|hit`) < 0.95) {
            got++;
            collectedAt.set(r.key, new Date(ds + 3 * 3600e3).toISOString());
            lastHitDay.set(r.key, d);
          }
        }
        m.hits[mall] += got;
        if (!got) m.zeroCalls[mall]++;
      }
    }
    const dk = [...dailyKeys].filter(k => world.has(k));
    m.dailyFresh.push(dk.filter(k => lastHitDay.get(k) === d).length / (dk.length || 1));
    if (d >= 6) {
      const rot = universe.filter(k => tierOf.get(k) === 'rotation');
      const within = k => (lastHitDay.get(k) ?? -999) >= d - 6;
      m.rot7.push(rot.filter(within).length / rot.length);
      const reachable = rot.filter(k => world.get(k)[d]);
      m.rot7Reach.push(reachable.filter(within).length / (reachable.length || 1));
    }
  }
  /* 기아: 회전 대상으로 3번 이상 예정됐는데 한 번도 1차 호출을 못 받은 상품 */
  const starved = { '쿠팡': 0, 'ADPICK': 0 }, eligible = { '쿠팡': 0, 'ADPICK': 0 };
  scheduled.forEach((n, k) => {
    if (n < 3) return;
    const mall = k.slice(k.lastIndexOf('|') + 1);
    eligible[mall]++;
    if (!attemptsPerKey.has(k)) starved[mall]++;
  });
  return { ...m, starved, eligible };
}

/* ── 실행 ─────────────────────────────────────────────────────── */
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const sd = a => { const mu = mean(a); return Math.sqrt(mean(a.map(x => (x - mu) ** 2))); };
const fmt = (a, digits = 2, pct = false) => { const k = pct ? 100 : 1; return `${(mean(a) * k).toFixed(digits)} ± ${(sd(a) * k).toFixed(digits)}`; };

const STRATS = [
  { name: 'A 레거시 순서 · ADPICK 600/일 (현재 운영)', order: 'legacy', budget: { '쿠팡': 2500, 'ADPICK': 600 } },
  { name: 'B V3 순서   · ADPICK 600/일 (같은 예산)', order: 'v3', budget: { '쿠팡': 2500, 'ADPICK': 600 } },
  { name: 'C 레거시 순서 · ADPICK 1800/일 (병렬만)', order: 'legacy', budget: { '쿠팡': 2500, 'ADPICK': 1800 } },
  { name: 'D V3 순서   · ADPICK 1800/일 (V3 전체)', order: 'v3', budget: { '쿠팡': 2500, 'ADPICK': 1800 } },
  { name: 'E 레거시 순서 · 쿠팡 1200/일 (장애일)', order: 'legacy', budget: { '쿠팡': 1200, 'ADPICK': 600 } },
  { name: 'F V3 순서   · 쿠팡 1200/일 (장애일)', order: 'v3', budget: { '쿠팡': 1200, 'ADPICK': 600 } }
];

console.log(`시뮬레이션: ${START} 부터 ${DAYS}일 · 씨앗 ${SEEDS}개 · 세계 ${WORLD} · 대상 우주 ${universe.length}개 (keyword 없는 상품 제외)`);
const res = STRATS.map(() => []);
for (let s = 1; s <= SEEDS; s++) {
  const world = makeWorld(s);
  STRATS.forEach((st, i) => res[i].push(simulate({ seed: s, world, order: st.order, budget: st.budget })));
}
for (const mall of ['ADPICK', '쿠팡']) {
  console.log(`\n=== ${mall} (1차 패스, ${DAYS}일 합, 평균 ± 표준편차) ===`);
  console.log('전략'.padEnd(40) + '호출/일   호출당 확보      대상 대비 확보율   무수확 호출 비율   기아(3회+ 예정, 0회 호출)');
  STRATS.forEach((st, i) => {
    const r = res[i];
    const perCall = r.map(x => x.hits[mall] / (x.calls[mall] || 1));
    const cover = r.map(x => x.hits[mall] / (x.targets[mall] || 1));
    const zero = r.map(x => x.zeroCalls[mall] / (x.calls[mall] || 1));
    const starved = r.map(x => x.starved[mall]);
    console.log(`${st.name.padEnd(40)}${String(Math.round(mean(r.map(x => x.calls[mall])) / DAYS)).padStart(6)}   ${fmt(perCall).padStart(12)}   ${fmt(cover, 1, true).padStart(14)}%   ${fmt(zero, 1, true).padStart(12)}%   ${mean(starved).toFixed(0).padStart(6)} / ${mean(r.map(x => x.eligible[mall])).toFixed(0)}`);
  });
}
console.log('\n=== 신선도 (두 몰 합) ===');
console.log('전략'.padEnd(40) + 'daily tier 당일 확보율   회전 풀 7일 내 확보율   (그중 도달 가능 상품만)');
STRATS.forEach((st, i) => {
  const r = res[i];
  console.log(`${st.name.padEnd(40)}${fmt(r.map(x => mean(x.dailyFresh)), 1, true).padStart(14)}%   ${fmt(r.map(x => mean(x.rot7)), 1, true).padStart(14)}%   ${fmt(r.map(x => mean(x.rot7Reach)), 1, true).padStart(14)}%`);
});
