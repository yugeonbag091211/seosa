#!/usr/bin/env node
'use strict';
/*
 * ⑥ 가격 이상 패턴 — 순수 엔진(_anomaly.analyze) 과 GET /api/anomaly. 완전 오프라인.
 *
 * 여기서 고정하는 것 — «구분» 이 이 기능의 전부다
 *   1) 진짜 가격 변동 · 옵션 변경 · 수집 오류가 서로의 이름으로 불리지 않는다
 *      (확정된 25% 인하는 CRASH, 하루 60% 튐은 COLLECTION_ERROR, 옵션이 바뀐 242,100원은
 *       OPTION_CHANGE — SPIKE 가 아니다)
 *   2) 수집 오류로 본 점은 분포에서 빠진다 (excluded)
 *   3) '' · '__LEGACY__' 는 «옵션 모름» 이지 다른 옵션이 아니다
 *   4) digest 는 canonical 문장 그대로 누구나 다시 계산할 수 있다
 *   5) 핸들러는 읽기 전용 · 외부 호출 0회 · 계약 필드를 전부 싣는다
 *   6) 어떤 입력에도 throw 하지 않는다
 */

const crypto = require('crypto');
const kit = require('./_v2-testkit');
const { db, state, T, mkReq, mkRes, fetchCalls } = kit.setup('test-v2-anomaly');

const A = require('../api/_anomaly');
const api = require('../api/_anomaly-api');
const history = require('../api/history');
const { kstToday, sameVendorRows, MAX_PRICE, OPTION_SWITCH_RATIO } = require('../api/_price');
const { toDailyPoints } = require('../api/_series');

const TODAY = kstToday();
const SEVERITIES = ['info', 'warn', 'alert'];
const FLAGS = ['ok', 'other_option', 'collection_error', 'spike', 'crash', 'fake_discount'];

/** 한 옵션의 가격 배열 → analyze 결과 (핸들러와 같은 방식으로 입력을 만든다). */
function run(prices, o) {
  o = o || {};
  const vid = o.vendorItemId == null ? '9001' : o.vendorItemId;
  const raw = o.rawRows || kit.historyRows({ productId: o.productId || 'P1', vendorItemId: vid, prices, startId: o.startId || 1 });
  const rows = sameVendorRows(raw, vid);
  return A.analyze({
    rawRows: raw, rows, points: toDailyPoints(rows),
    product: o.product || null, vendorItemId: vid, today: o.today || TODAY
  });
}
/** 같은 값 n 개. v 를 주지 않으면 10,000원, null 이면 «그날 관측 없음». */
const flat = (n, v) => Array(n).fill(v === undefined ? 10000 : v);
const kinds = out => out.events.map(e => e.kind);
const ofKind = (out, k) => out.events.filter(e => e.kind === k);
const isInt = v => v === null || Number.isInteger(v);

function shapeOk(out) {
  if (!out || typeof out !== 'object') return 'not an object';
  if (!out.summary || A.KINDS.concat(['x']).length < 1) return 'no summary';
  if (['NORMAL', 'WATCH', 'ANOMALOUS', 'INSUFFICIENT'].indexOf(out.summary.status) === -1) return 'bad status';
  if (typeof out.summary.label !== 'string' || !out.summary.label) return 'no label';
  if (!out.summary.counts || A.KINDS.some(k => typeof out.summary.counts[k] !== 'number')) return 'bad counts';
  if (!Array.isArray(out.events)) return 'events not array';
  for (const e of out.events) {
    for (const f of ['date', 'kind', 'severity', 'price', 'ref', 'changePct', 'confirmed', 'note', 'evidence']) {
      if (!(f in e)) return `event missing ${f}`;
    }
    if (A.KINDS.indexOf(e.kind) === -1) return `bad kind ${e.kind}`;
    if (SEVERITIES.indexOf(e.severity) === -1) return `bad severity ${e.severity}`;
    if (!isInt(e.price) || !isInt(e.ref)) return `non-integer amount ${e.price}/${e.ref}`;
    if (typeof e.note !== 'string' || !e.note) return 'empty note';
  }
  if (out.distribution !== null) {
    const d = out.distribution;
    for (const f of ['count', 'min', 'p5', 'p25', 'median', 'p75', 'p95', 'max', 'mean', 'mad', 'excluded']) {
      if (!Number.isInteger(d[f])) return `distribution.${f} not integer`;
    }
    if (!Array.isArray(d.histogram) || d.histogram.reduce((s, b) => s + b.count, 0) !== d.count) return 'histogram does not sum to count';
  }
  const h = out.history;
  if (!h || !Array.isArray(h.observations) || !/^sha256:[0-9a-f]{64}$/.test(h.digest) || typeof h.canonical !== 'string') return 'bad history';
  if (h.observations.some(x => FLAGS.indexOf(x.flag) === -1)) return 'bad flag';
  return '';
}

/** canonical 문장을 그대로 따라 다시 계산한다. */
function recompute(observations) {
  const payload = JSON.stringify(observations.map(o => [o.at, o.price, o.vendorItemId]));
  return 'sha256:' + crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

async function main() {
  /* ── 1. 평온한 계열 ─────────────────────────────────────────── */
  T.section('평온한 계열');
  {
    const out = run(flat(30));
    T.check(shapeOk(out) === '', '계약 모양', shapeOk(out));
    T.check(out.summary.status === 'NORMAL' && out.summary.label === '정상', '같은 값 30일 → NORMAL', out.summary);
    T.check(out.events.length === 0, '사건 없음', kinds(out));
    T.check(out.distribution.count === 30 && out.distribution.excluded === 0 && out.distribution.min === 10000, '분포 30일 · 제외 0', out.distribution);
  }
  {
    const noise = [0, 3, -2, 1, -3, 2, -1, 0, 3, -3, 2, 1, -2, 0, 3, -1, -3, 2, 0, 1, -2, 3, -3, 1, 0, 2, -1, -2, 3, 0]
      .map(x => Math.round(10000 * (1 + x / 100)));
    const out = run(noise);
    T.check(!kinds(out).some(k => k === 'SPIKE' || k === 'CRASH'), '±3% 흔들림은 급등·급락이 아니다', kinds(out));
    T.check(out.events.length === 0 && out.summary.status === 'NORMAL', '±3% 흔들림 → 사건 없음 · NORMAL', out.events);
  }

  /* ── 2. 진짜 가격 변동 vs 수집 오류 ─────────────────────────── */
  T.section('진짜 가격 변동 vs 수집 오류');
  {
    const out = run(flat(20).concat(flat(6, 7500)));
    const c = ofKind(out, 'CRASH');
    T.check(c.length === 1 && c[0].confirmed === true, '영구 25% 인하 → CRASH 확정 1건', out.events);
    T.check(c[0] && c[0].price === 7500 && c[0].ref === 10000 && c[0].changePct === -25, 'CRASH 가격·기준·변화율', c[0]);
    T.check(ofKind(out, 'COLLECTION_ERROR').length === 0, '확정된 인하는 수집 오류가 아니다');
    T.check(/실제 가격 인하/.test(c[0].note), '메모가 «실제 가격 인하» 라고 말한다', c[0].note);
    T.check(out.summary.status === 'ANOMALOUS', '최근 7일 안의 확정 급락 → ANOMALOUS', out.summary);
    T.check(out.distribution.count === 26 && out.distribution.excluded === 0 && out.distribution.min === 7500, '진짜 인하는 분포에 남는다', out.distribution);
    const cutObs = out.history.observations.find(x => x.date === c[0].date);
    T.check(cutObs && cutObs.flag === 'crash', '인하 날의 관측 표시는 crash', cutObs);
  }
  {
    const prices = flat(10).concat([4000]).concat(flat(10));
    const out = run(prices);
    const ce = ofKind(out, 'COLLECTION_ERROR');
    T.check(ce.length === 1 && ce[0].evidence.reason === 'one_day_blip', '하루 60% 튐 → COLLECTION_ERROR(one_day_blip)', out.events);
    T.check(ofKind(out, 'CRASH').length === 0 && ofKind(out, 'SPIKE').length === 0, '하루 튐은 급락·급등이 아니다', kinds(out));
    T.check(out.distribution.excluded === 1 && out.distribution.min === 10000 && out.distribution.count === 20, '튄 점은 분포에서 빠진다', out.distribution);
    const bad = out.history.observations.find(x => x.price === 4000);
    T.check(bad && bad.flag === 'collection_error', '튄 관측의 표시는 collection_error', bad);
    T.check(/절반 이하/.test(ce[0].note), '절반 이하 급락은 _deal 과 같이 «다른 옵션·구성» 가능성을 말한다', ce[0].note);
  }
  {
    // 하루 −20% 후 복귀 — 짧은 특가일 수 있다. 수집 오류로 지우지 않는다.
    const out = run(flat(10).concat([8000]).concat(flat(10)));
    const c = ofKind(out, 'CRASH');
    T.check(c.length === 1 && c[0].confirmed === false && c[0].severity === 'info', '하루 −20% 후 복귀 → 미확정 CRASH(info)', out.events);
    T.check(ofKind(out, 'COLLECTION_ERROR').length === 0 && out.distribution.excluded === 0, '−20% 하루 특가는 수집 오류로 지우지 않는다');
  }
  {
    const out = run(flat(20).concat([13000]));
    const s = ofKind(out, 'SPIKE');
    T.check(s.length === 1 && s[0].confirmed === false && s[0].severity === 'warn', '마지막 한 번만 +30% → SPIKE 미확정 · warn', out.events);
    T.check(out.summary.status === 'WATCH', '미확정 급등만 있으면 WATCH (ANOMALOUS 아님)', out.summary);
    T.check(/다음 수집/.test(s[0].note), '확정 조건을 말한다', s[0].note);
  }
  {
    const out = run(flat(20).concat([13000, 13000]));
    const s = ofKind(out, 'SPIKE');
    T.check(s.length === 1 && s[0].confirmed === true, '같은 수준 두 번 → SPIKE 확정', out.events);
  }
  {
    // 확정됐지만 절반 이하 — _deal.anomalies 의 price_drop 과 같은 말을 붙인다
    const out = run(flat(20).concat(flat(4, 4500)));
    const c = ofKind(out, 'CRASH');
    T.check(c.length === 1 && c[0].confirmed && c[0].severity === 'warn' && /같은 상품인지 확인/.test(c[0].note),
      '확정 급락이 절반 이하면 warn + «같은 상품인지 확인» (_deal 과 일관)', c[0]);
  }
  {
    // 옵션 표시 없는 옛 기록에서 이틀 15배 → 복귀 (15,900 → 242,100 · 222,390 사례)
    const out = run(flat(15, 15900).concat([242100, 222390]).concat(flat(5, 15900)), { vendorItemId: '' });
    const ce = ofKind(out, 'COLLECTION_ERROR');
    T.check(ce.length === 1 && ce[0].evidence.reason === 'short_excursion', '이틀 15배 이탈 후 복귀 → COLLECTION_ERROR(short_excursion)', out.events);
    T.check(out.distribution.excluded === 2 && out.distribution.max === 15900, '이탈한 이틀은 분포에서 빠진다', out.distribution);
    T.check(ofKind(out, 'SPIKE').length === 0, '이탈은 급등으로 세지 않는다', kinds(out));
  }

  /* ── 3. 옵션 변경 ────────────────────────────────────────── */
  T.section('옵션 변경');
  {
    const mine = kit.historyRows({ productId: 'P2', vendorItemId: '9001', prices: flat(20, 15900).concat([null, null]), startId: 1 });
    const other = kit.historyRows({ productId: 'P2', vendorItemId: '9002', prices: flat(20, null).concat([242100, 242100]), startId: 100 });
    const raw = mine.concat(other);
    const out = run(null, { rawRows: raw, vendorItemId: '9001' });
    const oc = ofKind(out, 'OPTION_CHANGE');
    T.check(oc.length === 1, '다른 옵션 식별자로 바뀐 곳 → OPTION_CHANGE 1건', out.events);
    T.check(oc[0] && oc[0].ref === 15900 && oc[0].price === 242100 && oc[0].severity === 'warn',
      `15,900 → 242,100 (${OPTION_SWITCH_RATIO}배 이상) → warn`, oc[0]);
    T.check(oc[0] && oc[0].evidence.fromVendorItemId === '9001' && oc[0].evidence.toVendorItemId === '9002' && oc[0].evidence.involvesThisOption,
      '근거에 옵션 식별자 전·후', oc[0] && oc[0].evidence);
    T.check(/다른 옵션의 가격/.test(oc[0] && oc[0].note), '메모가 «가격 변동이 아니라 다른 옵션» 이라고 말한다', oc[0] && oc[0].note);
    T.check(ofKind(out, 'SPIKE').length === 0 && ofKind(out, 'CRASH').length === 0, '옵션 변경은 급등이 아니다', kinds(out));
    T.check(out.distribution.max === 15900, '다른 옵션 가격은 분포에 섞이지 않는다', out.distribution);
    T.check(out.history.observations.length === 22 && out.history.observations.filter(x => x.flag === 'other_option').length === 2,
      'history 에는 다른 옵션까지 전부 싣고 other_option 으로 표시한다', out.history.observations.map(x => x.flag));

    // 좁힐 근거가 없을 때(vendorItemId='') rows 에 두 옵션이 섞여도 급등으로 부르지 않는다
    const mixed = A.analyze({ rawRows: raw, rows: raw, points: toDailyPoints(raw), product: null, vendorItemId: '', today: TODAY });
    T.check(ofKind(mixed, 'SPIKE').length === 0 && ofKind(mixed, 'OPTION_CHANGE').length === 1,
      '옵션을 모르고 받아도 섞인 옵션 값을 SPIKE 로 부르지 않는다', mixed.events.map(e => e.kind));
  }
  {
    const a = kit.historyRows({ productId: 'P3', vendorItemId: '9001', prices: [10000, null, 10000, null, 10000, null, 10000, 10000], startId: 1 });
    const b = kit.historyRows({ productId: 'P3', vendorItemId: '', prices: [null, 10000, null, null, null, 25000, null, null], startId: 50 });
    const c = kit.historyRows({ productId: 'P3', vendorItemId: '__LEGACY__', prices: [null, null, null, 12000, null, null, null, null], startId: 80 });
    const raw = a.concat(b, c);
    const out = A.analyze({ rawRows: raw, rows: sameVendorRows(raw, '9001'), points: [], product: null, vendorItemId: '9001', today: TODAY });
    T.check(ofKind(out, 'OPTION_CHANGE').length === 0, "'' · '__LEGACY__' 는 옵션 변경을 만들지 않는다", out.events);
    const all = A.analyze({ rawRows: raw, rows: raw, points: [], product: null, vendorItemId: '', today: TODAY });
    T.check(ofKind(all, 'OPTION_CHANGE').length === 0, '옵션 모름 → 알려진 옵션 → 옵션 모름 도 옵션 변경이 아니다', all.events);
  }
  {
    // 운영 사례: 같은 product_id 가 두 옵션으로 날마다 번갈아 온다 → 전환마다 한 줄이 아니라 한 사건
    const a = kit.historyRows({ productId: 'P3b', vendorItemId: '9001', prices: flat(20, 15900), startId: 1 });
    const b = kit.historyRows({ productId: 'P3b', vendorItemId: '9002', prices: flat(20, 10000), startId: 100 })
      .map(r => Object.assign({}, r, { recorded_at: r.recorded_at.replace('03:00', '05:00') }));
    const raw = a.concat(b);
    const out = A.analyze({ rawRows: raw, rows: sameVendorRows(raw, '9001'), points: [], vendorItemId: '9001', today: TODAY });
    const oc = ofKind(out, 'OPTION_CHANGE');
    T.check(oc.length === 1 && oc[0].evidence.switches === 39 && oc[0].evidence.lastSwitchDate === TODAY,
      '날마다 번갈아 오는 두 옵션 → OPTION_CHANGE 한 사건 (전환 횟수는 근거에)', oc.map(e => e.evidence));
    T.check(out.summary.counts.OPTION_CHANGE === 1 && out.summary.status === 'NORMAL' && out.distribution.max === 15900,
      '번갈아 와도 이 옵션의 계열은 평온하다', out.summary);
  }
  {
    const opts = kit.historyRows({ productId: 'P4', vendorItemId: '9001', prices: [10000, 10000, null, null], startId: 1 })
      .concat(kit.historyRows({ productId: 'P4', vendorItemId: '9002', prices: [null, null, 11000, 11000], startId: 10 }));
    const out = A.analyze({ rawRows: opts, rows: sameVendorRows(opts, '9002'), points: [], product: null, vendorItemId: '9002', today: TODAY });
    const oc = ofKind(out, 'OPTION_CHANGE');
    T.check(oc.length === 1 && oc[0].severity === 'info', '옵션 변경이어도 값 차이가 2배 미만이면 info', oc);
    T.check(out.summary.status === 'INSUFFICIENT' && oc.length === 1, '관측이 모자라도 옵션 변경(사실)은 알린다', out.summary);
  }

  /* ── 4. 가격 패턴 ────────────────────────────────────────── */
  T.section('가격 패턴');
  {
    const out = run(flat(14).concat(flat(5, 12000)).concat(flat(6)));
    const f = ofKind(out, 'FAKE_DISCOUNT');
    T.check(f.length === 1 && f[0].severity === 'alert', '올렸다가 원래 값으로 «할인» → FAKE_DISCOUNT alert', out.events);
    T.check(f[0] && f[0].evidence.baseline === 10000 && f[0].evidence.raised === 12000 && f[0].evidence.after === 10000,
      '근거 {baseline, raised, after}', f[0] && f[0].evidence);
    T.check(ofKind(out, 'SPIKE').length === 0 && ofKind(out, 'CRASH').length === 0, '같은 일을 급등·급락으로 또 세지 않는다', kinds(out));
    T.check(/되돌린 것/.test(f[0] && f[0].note), '메모: 할인은 최근 올린 값을 되돌린 것', f[0] && f[0].note);
    T.check(out.summary.status === 'ANOMALOUS', 'alert → ANOMALOUS', out.summary);
    const dropObs = out.history.observations.find(x => x.date === (f[0] && f[0].date));
    T.check(dropObs && dropObs.flag === 'fake_discount', '할인 날의 관측 표시는 fake_discount', dropObs);
  }
  {
    // «할인» 뒤에도 올리기 전보다 비싸다
    const out = run(flat(14).concat(flat(4, 12000)).concat(flat(5, 10900)));
    const f = ofKind(out, 'FAKE_DISCOUNT');
    T.check(f.length === 1 && /오히려/.test(f[0].note), '할인 후에도 원래보다 비싸면 FAKE_DISCOUNT (오히려 비싸다)', out.events);
  }
  {
    // 올린 뒤 원래보다 싸게 내렸다 → 진짜 할인
    const out = run(flat(14).concat(flat(4, 12000)).concat(flat(5, 8500)));
    T.check(ofKind(out, 'FAKE_DISCOUNT').length === 0, '원래 값보다 더 내리면 뻥튀기가 아니다', out.events);
  }
  {
    // 한 번만 올렸다가 내림 — «하루 이상 유지» 가 아니다
    const out = run(flat(14).concat([11500]).concat(flat(6)));
    T.check(ofKind(out, 'FAKE_DISCOUNT').length === 0, '올린 값을 한 번만 봤으면 뻥튀기로 단정하지 않는다', out.events);
  }
  {
    const saw = [];
    for (let i = 0; i < 40; i++) saw.push(Math.floor(i / 2) % 2 ? 11000 : 10000);
    const out = run(saw);
    const s = ofKind(out, 'SAWTOOTH');
    T.check(s.length === 1 && s[0].severity === 'info' && s[0].evidence.cycles >= A.SAW_MIN_CYCLES, '10% 폭 규칙적 등락 → SAWTOOTH info', out.events);
    T.check(!kinds(out).some(k => k === 'FAKE_DISCOUNT' || k === 'SPIKE' || k === 'CRASH'), '규칙적 등락의 매 오르내림을 뻥튀기·급변으로 세지 않는다', kinds(out));
    T.check(out.summary.status === 'NORMAL', 'info 만 있으면 NORMAL', out.summary);
    T.check(/기다리면/.test(s[0] && s[0].note), '메모: 낮은 날을 기다리면 도움', s[0] && s[0].note);
  }
  {
    const saw = [];
    for (let i = 0; i < 40; i++) saw.push(Math.floor(i / 2) % 2 ? 12000 : 10000);
    const out = run(saw);
    T.check(ofKind(out, 'SAWTOOTH').length === 1 && !kinds(out).some(k => k === 'SPIKE' || k === 'CRASH'),
      '20% 폭으로 오가도(MAD=0 창) 매 등락을 급등·급락으로 세지 않는다', kinds(out));
  }
  {
    const out = run(flat(20), { product: { oprice: 30000, lprice: 10000 } });
    const r = ofKind(out, 'REFERENCE_INFLATION');
    T.check(r.length === 1 && r[0].severity === 'warn' && r[0].ref === 30000 && r[0].evidence.rule === 'both',
      '정가 30,000 · 관측 최고 10,000 → REFERENCE_INFLATION warn', out.events);
    T.check(/부풀려/.test(r[0] && r[0].note), '메모: 표시 할인율이 부풀려졌을 가능성', r[0] && r[0].note);
    const same = run(flat(20), { product: { oprice: 10000, lprice: 10000 } });
    T.check(ofKind(same, 'REFERENCE_INFLATION').length === 0, '정가 = 판매가(쿠팡 기본) 면 사건 없음');
    const fair = run(flat(10, 12000).concat(flat(10, 8000)), { product: { oprice: 12500 } });
    T.check(ofKind(fair, 'REFERENCE_INFLATION').length === 0, '실제로 그 근처에 판 적이 있는 정가는 부풀리기가 아니다', fair.events);
  }

  /* ── 5. 수집 오류 (값 · 같은 날) ─────────────────────────── */
  T.section('수집 오류 — 값 범위 · 같은 날 충돌');
  {
    const rows = kit.historyRows({ productId: 'P5', vendorItemId: '9001', prices: flat(15), startId: 1 });
    const d = rows[10];
    rows.push(Object.assign({}, d, { id: 500, price: 25000, recorded_at: d.recorded_at.replace('03:00', '06:00') }));
    const out = run(null, { rawRows: rows });
    const ce = ofKind(out, 'COLLECTION_ERROR');
    T.check(ce.length === 1 && ce[0].evidence.reason === 'same_day_conflict', '같은 날 2배 넘는 충돌 → COLLECTION_ERROR(same_day_conflict)', out.events);
    T.check(ce[0] && ce[0].ref === 10000 && ce[0].price === 25000, '앞뒤 기록에 가까운 값을 남긴다', ce[0]);
    T.check(out.distribution.excluded === 1 && out.distribution.max === 10000, '충돌한 값은 분포에서 빠진다', out.distribution);
    T.check(out.history.observations.find(x => x.price === 25000).flag === 'collection_error', '충돌한 관측의 표시는 collection_error');
    T.check(out.summary.status === 'WATCH' || out.summary.status === 'ANOMALOUS', '수집 오류가 있으면 NORMAL 이 아니다', out.summary);
  }
  {
    // 낮은 쪽이 틀린 값이어도 기준(앞뒤)에 가까운 쪽을 남긴다
    const rows = kit.historyRows({ productId: 'P5b', vendorItemId: '9001', prices: flat(15), startId: 1 });
    rows.push(Object.assign({}, rows[7], { id: 600, price: 3000, recorded_at: rows[7].recorded_at.replace('03:00', '07:00') }));
    const out = run(null, { rawRows: rows });
    T.check(out.distribution.min === 10000 && ofKind(out, 'COLLECTION_ERROR').length === 1, '같은 날 낮은 쪽 오류도 걸러낸다 (최저가 접기에 속지 않는다)', out.distribution);
  }
  {
    const rows = kit.historyRows({ productId: 'P6', vendorItemId: '9001', prices: flat(12).concat([0]).concat(flat(3)).concat([MAX_PRICE + 1]).concat(flat(2)), startId: 1 });
    const out = run(null, { rawRows: rows });
    const ce = ofKind(out, 'COLLECTION_ERROR');
    T.check(ce.length === 2 && ce.every(e => e.evidence.reason === 'insane_price'), '0원 · 1억원 초과 → COLLECTION_ERROR(insane_price) 2건', out.events);
    T.check(out.distribution.excluded === 2 && out.distribution.max === 10000 && out.distribution.min === 10000, '범위 밖 값은 분포에서 빠진다', out.distribution);
    T.check(out.summary.status === 'ANOMALOUS', '최근 7일 안의 수집 오류 → ANOMALOUS', out.summary);
    T.check(ofKind(out, 'CRASH').length === 0 && ofKind(out, 'SPIKE').length === 0, '범위 밖 값으로 급변을 만들지 않는다', kinds(out));
  }

  /* ── 6. 판단 데이터 부족 ─────────────────────────────────── */
  T.section('판단 데이터 부족');
  {
    const out = run([10000, 10000, 9000]);
    T.check(out.summary.status === 'INSUFFICIENT' && out.summary.label === '판단 데이터 부족', '관측 3일 → INSUFFICIENT', out.summary);
    T.check(out.distribution === null, '분포는 null (0 으로 채우지 않는다)');
    T.check(out.history.observations.length === 3 && /^sha256:[0-9a-f]{64}$/.test(out.history.digest), 'INSUFFICIENT 여도 history · digest 는 싣는다', out.history);
    T.check(shapeOk(out) === '', 'INSUFFICIENT 도 같은 계약 모양', shapeOk(out));
  }
  {
    const out = A.analyze({ rawRows: [], rows: [], points: [], product: null, vendorItemId: '', today: TODAY });
    T.check(out.summary.status === 'INSUFFICIENT' && out.events.length === 0 && out.history.observations.length === 0, '빈 입력 → INSUFFICIENT', out.summary);
    T.check(out.history.digest === recompute([]), '빈 관측의 digest 도 규칙대로', out.history.digest);
  }
  {
    // 원본 행 없이 곡선만 받아도 분석은 한다 (history 에는 원본만 싣는다)
    const pts = kit.historyRows({ productId: 'P7', prices: flat(20).concat(flat(5, 7000)) }).map(r => ({ date: r.recorded_date, price: r.price }));
    const out = A.analyze({ points: pts, today: TODAY });
    T.check(ofKind(out, 'CRASH').length === 1 && out.history.observations.length === 0, 'points 만 받아도 분석하고, history 에는 지어낸 원본을 싣지 않는다', out.events);
  }

  /* ── 7. 분포 ─────────────────────────────────────────────── */
  T.section('분포');
  {
    const prices = [];
    for (let v = 10000; v <= 20000; v += 1000) prices.push(v);
    const d = A.distributionOf(prices, 0);
    T.check(d.count === 11 && d.min === 10000 && d.max === 20000, 'count · min · max', d);
    T.check(d.p5 === 10500 && d.p25 === 12500 && d.median === 15000 && d.p75 === 17500 && d.p95 === 19500,
      '분위수는 선형 보간 (numpy 기본 · PERCENTILE.INC)', d);
    T.check(d.mean === 15000 && d.mad === 3000, 'mean 15,000 · MAD 3,000', { mean: d.mean, mad: d.mad });
    T.check(d.histogram.length === Math.ceil(Math.log2(11)) + 1 && d.histogram[0].from === 10000 && d.histogram[d.histogram.length - 1].to === 20000,
      '히스토그램 Sturges 칸 · 양 끝이 min/max', d.histogram);
    const even = A.distributionOf([100, 200, 300, 400], 3);
    T.check(even.median === 250 && even.excluded === 3, '짝수 개 중앙값 · excluded 전달', even);
    const one = A.distributionOf([5000, 5000, 5000, 5000, 5000], 0);
    T.check(one.histogram.length === 1 && one.histogram[0].count === 5 && one.mad === 0, '값이 하나뿐이면 칸 하나', one);
    const shuffled = run([13000, 11000, 19000, 10000, 15000, 17000, 12000, 20000, 14000, 16000, 18000]);
    T.check(shuffled.distribution.p25 === 12500 && shuffled.distribution.median === 15000, 'analyze 의 분포도 같은 규칙 (순서 무관)', shuffled.distribution);
  }

  /* ── 8. 검증 가능한 기록 (digest) ─────────────────────────── */
  T.section('digest');
  {
    const raw = kit.historyRows({ productId: 'P8', vendorItemId: '9001', prices: flat(10).concat([4000]).concat(flat(5)), startId: 1 })
      .concat(kit.historyRows({ productId: 'P8', vendorItemId: '9002', prices: flat(15, null).concat([30000]), startId: 100 }));
    const a = A.analyze({ rawRows: raw, rows: sameVendorRows(raw, '9001'), points: [], vendorItemId: '9001', today: TODAY });
    const b = A.analyze({ rawRows: raw.slice().reverse(), rows: sameVendorRows(raw, '9001').reverse(), points: [], vendorItemId: '9001', today: TODAY });
    T.check(a.history.digest === b.history.digest, '같은 기록이면 입력 순서와 무관하게 같은 digest', [a.history.digest, b.history.digest]);
    T.check(JSON.stringify(a) === JSON.stringify(b), '결정론 — 같은 입력이면 출력 전체가 같다');
    T.check(a.history.digest === recompute(a.history.observations), 'canonical 규칙으로 누구나 다시 계산할 수 있다', a.history.canonical);
    T.check(/JSON\.stringify/.test(a.history.canonical) && /o\.at, o\.price, o\.vendorItemId/.test(a.history.canonical) && /sha256/.test(a.history.canonical),
      'canonical 문장이 직렬화 규칙을 그대로 적는다', a.history.canonical);
    const at = a.history.observations.map(o => o.at);
    T.check(at.every((v, i) => i === 0 || at[i - 1] <= v), 'observations 는 시간 오름차순');
    T.check(a.history.observations.length === raw.length, '다른 옵션까지 모든 원본 행을 싣는다');
    const changed = raw.map(r => (r.id === 3 ? Object.assign({}, r, { price: 10010 }) : r));
    const c = A.analyze({ rawRows: changed, rows: sameVendorRows(changed, '9001'), points: [], vendorItemId: '9001', today: TODAY });
    T.check(c.history.digest !== a.history.digest, '값 하나만 바뀌어도 digest 가 바뀐다');
    const o = a.history.observations.find(x => x.price === 4000);
    T.check(o && o.flag === 'collection_error' && o.vendorItemId === '9001' && o.date && o.at, '관측 필드 at · date · price · vendorItemId · flag', o);
  }

  /* ── 9. 어떤 입력에도 throw 하지 않는다 ────────────────────── */
  T.section('입력 방어');
  {
    const garbage = [
      undefined, null, 'abc', 42, [], { rawRows: 'x', rows: 5, points: 'y' },
      { rawRows: [null, 'str', 7, [], { price: 'abc' }, { price: -500, recorded_date: '2026-09-01' }, { price: 1e20, recorded_at: 'nope' }] },
      { rawRows: [{ price: 10000, recorded_at: '+275760-09-13T00:00:00.000Z' }], today: 'bad' },
      { rawRows: kit.historyRows({ productId: 'G', prices: [-1, -2, -3, -4, -5, -6] }) },
      { rows: kit.historyRows({ productId: 'G2', prices: flat(8) }), product: 'not an object', today: TODAY },
      { points: [{ date: 'x', price: 'y' }, null, { date: '2026-01-01', price: 5 }] }
    ];
    let threw = null;
    const outs = [];
    for (const g of garbage) {
      try { outs.push(A.analyze(g)); } catch (e) { threw = e; }
    }
    T.check(threw === null, '쓰레기 입력에도 throw 하지 않는다', threw && threw.message);
    T.check(outs.every(o => shapeOk(o) === ''), '쓰레기 입력에도 같은 계약 모양', outs.map(shapeOk));
    const neg = outs[8];
    T.check(neg.summary.status === 'INSUFFICIENT' && neg.summary.counts.COLLECTION_ERROR >= 1 && neg.distribution === null,
      '음수 가격만 있으면 수집 오류 + INSUFFICIENT', neg.summary);
    T.check(outs[9].summary.status === 'NORMAL', 'rows 만 받아도 분석한다 (product 가 문자열이어도)', outs[9].summary);
  }

  /* ── 10. 핸들러 GET /api/anomaly ─────────────────────────── */
  T.section('핸들러');
  db.products = [{
    product_id: '8082654809', mall: '쿠팡', mall_label: '쿠팡', vendor_item_id: '', title: '무선 이어폰', lprice: 15900, oprice: 15900,
    image: 'https://img.example/1.jpg', link: 'https://link.coupang.com/a?itemId=1&vendorItemId=95768196637', collected_at: new Date().toISOString()
  }];
  db.price_history = kit.historyRows({ productId: '8082654809', vendorItemId: '95768196637', prices: flat(20, 15900).concat([null, null]), startId: 1 })
    .concat(kit.historyRows({ productId: '8082654809', vendorItemId: '91193685703', prices: flat(20, null).concat([242100, 222390]), startId: 200 }));
  const writesBefore = state.writes.length;
  {
    const res = mkRes();
    await api.handler(mkReq({ query: {} }), res);
    T.check(res.statusCode === 400 && res.body && res.body.ok === false && res.body.code === 'BAD_INPUT' && res.body.error === '상품 식별자가 필요해요',
      'productId 없으면 400 BAD_INPUT', res.body);
  }
  {
    const res = mkRes();
    await api.handler(mkReq({ query: { productId: 'x;drop table' } }), res);
    T.check(res.statusCode === 400, '이상한 식별자도 400', res.body);
  }
  {
    const res = mkRes();
    await api.handler(mkReq({ method: 'POST', query: { productId: '8082654809' }, body: {} }), res);
    T.check(res.statusCode === 405 && res.body && res.body.ok === false, 'POST → 405', res.body);
  }
  {
    const res = mkRes();
    await api.handler(mkReq({ method: 'OPTIONS', query: {} }), res);
    T.check(res.statusCode === 204 && res.headers['access-control-allow-origin'] === '*', 'OPTIONS → 204 · public CORS', res.headers);
  }
  {
    const res = mkRes();
    await api.handler(mkReq({ query: { productId: '8082654809', mall: '쿠팡' } }), res);
    const b = res.body || {};
    T.check(res.statusCode === 200 && b.ok === true, 'GET → 200 ok', b);
    T.check(typeof b.asOf === 'string' && !isNaN(Date.parse(b.asOf)), 'asOf ISO 시각', b.asOf);
    T.check(b.product && b.product.productId === '8082654809' && b.product.vendorItemId === '95768196637' && b.product.title === '무선 이어폰',
      'product 요약 (vendorItemId 는 카탈로그 link 에서 채움)', b.product);
    for (const f of ['distribution', 'events', 'summary', 'history']) T.check(f in b, `응답에 ${f}`);
    T.check(shapeOk(b) === '', '응답이 계약 모양', shapeOk(b));
    T.check(b.events.some(e => e.kind === 'OPTION_CHANGE') && !b.events.some(e => e.kind === 'SPIKE'),
      '운영 사례(15,900 ↔ 242,100) → OPTION_CHANGE, SPIKE 아님', b.events.map(e => e.kind));
    T.check(b.distribution && b.distribution.max === 15900, '다른 옵션 가격은 분포에 없다', b.distribution);
    T.check(b.history.observations.length === 22 && b.history.digest === recompute(b.history.observations), '응답 digest 재계산 일치');
    T.check(/public/.test(String(res.headers['cache-control'])) && /s-maxage=300/.test(String(res.headers['cache-control'])),
      'Cache-Control public · s-maxage=300', res.headers['cache-control']);
    T.check(res.headers['access-control-allow-origin'] === '*', 'CORS public');
    T.check(!('rawRows' in b) && !('rows' in b), '원본 행 배열을 따로 내보내지 않는다 (history.observations 로만)');
  }
  {
    // vercel rewrite 와 같은 경로: /api/history?__route=anomaly
    const res = mkRes();
    await history(mkReq({ query: { __route: 'anomaly', productId: '8082654809', mall: '쿠팡' } }), res);
    T.check(res.statusCode === 200 && res.body && res.body.ok === true && res.body.summary, 'history.js 라우터를 거쳐도 200', res.body && res.body.error);
  }
  {
    const res = mkRes();
    await api.handler(mkReq({ query: { productId: 'nothing-here' } }), res);
    T.check(res.statusCode === 200 && res.body.summary.status === 'INSUFFICIENT' && res.body.product.title === null,
      '기록 없는 상품 → 200 INSUFFICIENT (title null)', res.body.summary);
  }
  {
    state.failNext.price_history = 'boom';
    const res = mkRes();
    const origError = console.error;
    console.error = () => {};
    try {
      await api.handler(mkReq({ query: { productId: '8082654809' } }), res);
    } finally {
      console.error = origError;
    }
    T.check(res.statusCode === 500 && res.body && res.body.error === '가격 이상 패턴을 불러오지 못했어요.', 'DB 실패 → 500 문장만', res.body);
  }

  /* ── 11. 안전 ─────────────────────────────────────────────── */
  T.section('안전');
  T.check(state.writes.length === 0 && state.writes.length === writesBefore, '어떤 표에도 한 행도 쓰지 않았다 (읽기 전용)', state.writes);
  T.check(state.reads.every(r => r.table === 'products' || r.table === 'price_history'), '읽은 표는 products · price_history 뿐', state.reads.map(r => r.table));
  T.check(fetchCalls.length === 0, '외부 호출 0회', fetchCalls);
  T.check(state.rpcCalls.length === 0, 'RPC 호출 0회', state.rpcCalls);

  T.done();
}

main().catch(e => { console.error(e); process.exitCode = 1; });
