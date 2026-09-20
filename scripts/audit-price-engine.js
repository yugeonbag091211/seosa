#!/usr/bin/env node
'use strict';
/*
 * 가격 엔진 전수 감사 — 읽기 전용.
 *
 *   node scripts/audit-price-engine.js
 *   node scripts/audit-price-engine.js --json      기계가 읽을 형태로
 *
 * ── 이 스크립트가 있는 이유 ────────────────────────────────────────
 *
 * 2026-09-20 감사에서 나온 숫자를 «한 번 세고 문서에 적는» 대신 «언제든 다시
 * 셀 수 있게» 남긴다. 수치가 보고서에만 있으면 한 달 뒤에는 아무도 그게
 * 아직 맞는지 모른다.
 *
 * ── 안전성 ─────────────────────────────────────────────────────────
 *
 *   · INSERT / UPDATE / DELETE / DDL 을 하지 않는다. SELECT 뿐이다.
 *   · 쿠팡 · ADPICK 등 외부 API 를 부르지 않는다 (fetch 를 막아 둔다).
 *   · 자기가 읽은 바이트 수를 직접 세어 마지막에 보고한다 — 감사 자체가
 *     egress 를 키우면 안 되므로, 가능한 곳은 head 요청(본문 0바이트)으로
 *     센다.
 *
 * ── 무엇을 세는가 ──────────────────────────────────────────────────
 *
 *   A. 카탈로그    69,666행이 왜 2,965개 대상이 되는지 상호배타 분류
 *   B. 수집        오늘 시도 / 확보 / 미확보
 *   C. 가격 정확성 products.lprice 와 원장 최신값의 불일치 · 신선도 · 옵션
 *   D. 핫딜        오늘의 일일 하락 후보와 어제와의 겹침
 *   E. egress      수집기 한 바퀴가 읽는 바이트 (전/후 비교)
 */

require('./_env');

const supabase = require('../api/_supabase');
const P = require('../api/_price');
const DD = require('../api/_dailydrop');

// 감사 도중 외부 API 를 부르는 일이 없어야 한다 — 실수로라도 유료 호출이 나가면 안 된다.
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (!u.startsWith(String(process.env.SUPABASE_URL || 'https://__none__'))) {
    throw new Error(`감사 스크립트가 외부를 호출하려 했습니다(차단): ${u.slice(0, 80)}`);
  }
  return realFetch(url, opts);
};

const JSON_OUT = process.argv.indexOf('--json') > -1;
const PAGE = 1000;

let readBytes = 0;
function account(rows) {
  // 대략치가 아니라 실제로 받은 JSON 크기를 센다.
  try { readBytes += Buffer.byteLength(JSON.stringify(rows || [])); } catch { /* 무시 */ }
}

function log(...a) { if (!JSON_OUT) console.log(...a); }
const pct = (n, d) => (Number(d) > 0 ? `${(Number(n) / Number(d) * 100).toFixed(1)}%` : '-');
const num = n => Number(n || 0).toLocaleString('en-US');

/** 행을 내려받지 않고 개수만 센다 (응답 본문 0바이트). */
async function count(build) {
  const { count: c, error } = await build(supabase.from('__x__'));
  if (error) throw new Error(error.message);
  return Number(c) || 0;
}
async function countOf(table, apply) {
  let q = supabase.from(table).select('*', { count: 'exact', head: true });
  if (apply) q = apply(q);
  const { count: c, error } = await q;
  if (error) throw new Error(`${table} count 실패: ${error.message}`);
  return Number(c) || 0;
}

/** range 페이지로 «끝까지» 읽는다. .limit() 은 PostgREST 상한(1,000)에 눌린다. */
async function selectAll(table, cols, apply) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select(cols);
    if (apply) q = apply(q);
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} 조회 실패: ${error.message}`);
    account(data);
    out.push(...(data || []));
    if (!data || data.length < PAGE) return out;
  }
}

async function eligibleKeys() {
  const seen = new Set();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.rpc('collector_eligible_products').range(from, from + PAGE - 1);
    if (error) return null;                       // 마이그레이션 전 환경
    account(data);
    (data || []).forEach(r => seen.add(`${r.product_id}|${r.mall}`));
    if (!data || data.length < PAGE) return seen;
  }
}

/* ══════════════════════════════════════════════════════════════════
 *  A. 카탈로그 — 왜 이만큼만 대상인가
 * ════════════════════════════════════════════════════════════════ */
function reconcile(products, elig, historyByKey) {
  /*
   * ★ 상호배타 분류다. 한 상품은 정확히 한 칸에만 들어간다 (first match).
   *   그래야 합계가 products 전체와 «맞는지» 를 검사할 수 있다.
   *   합계가 맞지 않으면 분류 자체가 틀린 것이므로 아래에서 경고한다.
   */
  const B = {
    ELIGIBLE: 0,
    X1_지원하지_않는_몰: 0,
    X2_식별자_없음: 0,
    X3_쿠팡인데_옵션id_없음: 0,
    X4_이력이_아예_없음: 0,
    X5_수집은_됐지만_승격되지_않음: 0,
    X6_seed_뿐: 0,
    X9_기타: 0
  };
  const byMall = {};
  for (const p of products) {
    const k = `${p.product_id}|${p.mall}`;
    const rows = historyByKey.get(k) || [];
    const bump = b => {
      B[b]++;
      byMall[b] = byMall[b] || {};
      byMall[b][p.mall] = (byMall[b][p.mall] || 0) + 1;
    };
    if (elig && elig.has(k)) { bump('ELIGIBLE'); continue; }
    if (p.mall !== '쿠팡' && p.mall !== 'ADPICK') { bump('X1_지원하지_않는_몰'); continue; }
    if (!p.product_id) { bump('X2_식별자_없음'); continue; }
    if (p.mall === '쿠팡' && !String(p.vendor_item_id || '').trim()) { bump('X3_쿠팡인데_옵션id_없음'); continue; }
    if (!rows.length) { bump('X4_이력이_아예_없음'); continue; }
    if (rows.some(r => r.source === 'collect')) { bump('X5_수집은_됐지만_승격되지_않음'); continue; }
    if (rows.some(r => r.source === 'seed')) { bump('X6_seed_뿐'); continue; }
    bump('X9_기타');
  }
  return { buckets: B, byMall };
}

/*
 * 테스트가 분류 규칙만 따로 검사할 수 있게 내보낸다. require 로 불러도
 * 감사가 돌지 않도록 main 은 아래에서 require.main 일 때만 실행한다.
 */
module.exports = { reconcile };

/* ══════════════════════════════════════════════════════════════════
 *  main
 * ════════════════════════════════════════════════════════════════ */
if (require.main !== module) return;

(async () => {
  const today = P.kstToday();
  const out = { today, generatedAt: new Date().toISOString() };

  log(`\n══════════════════════════════════════════════════════════`);
  log(`  SEOSA 가격 엔진 감사  (KST ${today})   ※ 읽기 전용`);
  log(`══════════════════════════════════════════════════════════`);

  /* ── A. 카탈로그 ─────────────────────────────────────────────── */
  const totalProducts = await countOf('products');
  const elig = await eligibleKeys();

  const products = await selectAll('products', 'product_id, mall, lprice, vendor_item_id, collected_at');
  const history = await selectAll('price_history',
    'product_id, mall, price, recorded_date, recorded_at, vendor_item_id, source');

  const historyByKey = new Map();
  for (const h of history) {
    const k = `${h.product_id}|${h.mall}`;
    let a = historyByKey.get(k);
    if (!a) historyByKey.set(k, a = []);
    a.push(h);
  }

  const rec = reconcile(products, elig, historyByKey);
  const sum = Object.values(rec.buckets).reduce((s, v) => s + v, 0);

  log(`\n[A] 카탈로그 분해  — 한 상품은 정확히 한 칸에만 들어간다`);
  log(`    products 전체 ${num(totalProducts)}행`);
  for (const [k, v] of Object.entries(rec.buckets)) {
    if (!v) continue;
    const m = rec.byMall[k] || {};
    const detail = Object.entries(m).map(([mm, n]) => `${mm} ${num(n)}`).join(' / ');
    log(`      ${k.padEnd(34)} ${String(num(v)).padStart(8)}   ${detail}`);
  }
  log(`      ${'─'.repeat(34)} ${'─'.repeat(8)}`);
  log(`      ${'합계'.padEnd(34)} ${String(num(sum)).padStart(8)}`
    + `   ${sum === products.length ? '✔ products 전체와 일치' : '✘ 불일치 — 분류가 틀렸다'}`);
  if (sum !== products.length) {
    log(`      ★ 분류 합계 ${sum} ≠ products ${products.length} — 이 감사 결과를 믿지 말 것`);
  }
  out.catalog = { total: totalProducts, buckets: rec.buckets, byMall: rec.byMall, reconciles: sum === products.length };

  /* ── B. 수집 ─────────────────────────────────────────────────── */
  const target = elig ? elig.size : products.length;
  const todayKeys = new Set(), yesterdayKeys = new Set();
  const yesterday = DD.kstYesterday(today);
  for (const h of history) {
    if (!(Number(h.price) > 0)) continue;
    const d = P.observedKstDate(h);
    const k = `${h.product_id}|${h.mall}`;
    if (d === today) todayKeys.add(k);
    else if (d === yesterday) yesterdayKeys.add(k);
  }
  const collectedToday = elig ? [...elig].filter(k => todayKeys.has(k)).length : todayKeys.size;
  log(`\n[B] 수집  (분모 = 일일 수집 대상, 카탈로그 전체가 아니다)`);
  log(`    수집 대상            ${String(num(target)).padStart(8)}`);
  log(`    오늘 가격 확보       ${String(num(collectedToday)).padStart(8)}   ${pct(collectedToday, target)}`);
  log(`    오늘 미확보          ${String(num(target - collectedToday)).padStart(8)}`);
  log(`    (카탈로그 전체 대비)  ${String(num(totalProducts)).padStart(8)}   ${pct(collectedToday, totalProducts)}  ← 분모가 다르다`);
  out.collection = { target, collectedToday, missingToday: target - collectedToday, totalProducts };

  /* ── C. 가격 정확성 ──────────────────────────────────────────── */
  const latestPM = new Map();
  for (const h of history) {
    if (!(Number(h.price) > 0)) continue;
    const k = `${h.product_id}|${h.mall}`;
    const cur = latestPM.get(k);
    if (!cur || String(h.recorded_at) > String(cur.recorded_at)) latestPM.set(k, h);
  }
  const ageOf = d => Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86400000);

  let mismatch = 0, invalidProduct = 0, noHistory = 0, optionMismatch = 0;
  const fresh = { '0 (오늘)': 0, '1': 0, '2-3': 0, '4-7': 0, '8-14': 0, '15-30': 0, '30+': 0 };
  const samples = [];
  for (const p of products) {
    if (!(Number(p.lprice) > 0)) invalidProduct++;
    const L = latestPM.get(`${p.product_id}|${p.mall}`);
    if (!L) { noHistory++; continue; }
    const a = ageOf(P.observedKstDate(L));
    const b = a <= 0 ? '0 (오늘)' : a === 1 ? '1' : a <= 3 ? '2-3' : a <= 7 ? '4-7' : a <= 14 ? '8-14' : a <= 30 ? '15-30' : '30+';
    fresh[b]++;
    if (Number(p.lprice) !== Number(L.price)) {
      mismatch++;
      if (samples.length < 8) {
        samples.push({ key: `${p.product_id}|${p.mall}`, catalog: Number(p.lprice), ledger: Number(L.price),
          ledgerDate: P.observedKstDate(L), source: L.source,
          catalogVid: String(p.vendor_item_id || ''), ledgerVid: String(L.vendor_item_id || '') });
      }
    }
    if (p.mall === '쿠팡') {
      const pv = String(p.vendor_item_id || '').trim(), hv = String(L.vendor_item_id || '').trim();
      if (pv && hv && pv !== hv) optionMismatch++;
    }
  }
  let invalidHistory = 0;
  for (const h of history) if (!(Number(h.price) > 0)) invalidHistory++;

  log(`\n[C] 가격 정확성`);
  log(`    products.lprice ≠ 원장 최신 관측   ${String(num(mismatch)).padStart(7)}   ${pct(mismatch, products.length - noHistory)}`);
  log(`    products.lprice ≤ 0                ${String(num(invalidProduct)).padStart(7)}`);
  log(`    price_history 유효하지 않은 가격    ${String(num(invalidHistory)).padStart(7)}  / ${num(history.length)}행`);
  log(`    이력이 아예 없는 상품               ${String(num(noHistory)).padStart(7)}`);
  log(`    쿠팡 옵션 불일치 (카탈로그 vs 원장) ${String(num(optionMismatch)).padStart(7)}`);
  log(`    최신 관측이 며칠 전인가:`);
  for (const [k, v] of Object.entries(fresh)) if (v) log(`        ${k.padEnd(10)} ${String(num(v)).padStart(8)}   ${pct(v, products.length)}`);
  if (samples.length) {
    log(`    불일치 표본:`);
    samples.forEach(s => log(`        ${s.key.slice(0, 26).padEnd(26)} 카탈로그 ${String(s.catalog).padStart(9)}`
      + ` / 원장 ${String(s.ledger).padStart(9)} (${s.ledgerDate}, ${s.source || 'null'})`
      + `${s.catalogVid && s.ledgerVid && s.catalogVid !== s.ledgerVid ? '  ← 옵션이 다르다' : ''}`));
  }
  out.integrity = { mismatch, invalidProduct, invalidHistory, noHistory, optionMismatch, freshness: fresh, samples };

  /* ── D. 핫딜 (일일 하락) ─────────────────────────────────────── */
  const series = new Map();
  for (const h of history) {
    const pm = `${h.product_id}|${h.mall}`;
    if (elig && !elig.has(pm)) continue;
    const k = `${pm}|${h.vendor_item_id || ''}`;
    let a = series.get(k);
    if (!a) series.set(k, a = []);
    a.push(h);
  }
  function dropsOn(day) {
    const list = [], reasons = {};
    for (const [k, rows] of series) {
      const r = DD.dailyDrop(rows, { today: day });
      reasons[r.reason] = (reasons[r.reason] || 0) + 1;
      if (r.ok) list.push(Object.assign({ key: k }, r));
    }
    list.sort(DD.compareDrops);
    return { list, reasons };
  }
  const t = dropsOn(today);
  const y = dropsOn(yesterday);
  const top = t.list.slice(0, 20).map(x => x.key);
  const yTop = y.list.slice(0, 20).map(x => x.key);
  const overlap = top.filter(k => yTop.indexOf(k) > -1).length;

  log(`\n[D] 핫딜 — 어제(${yesterday}) 대비 오늘(${today}) 일일 하락`);
  log(`    옵션 계열 수          ${String(num(series.size)).padStart(8)}`);
  log(`    오늘 후보             ${String(num(t.list.length)).padStart(8)}`);
  log(`    어제 후보             ${String(num(y.list.length)).padStart(8)}`);
  log(`    TOP20 겹침            ${String(overlap).padStart(8)} / ${Math.min(20, yTop.length)}`
    + `   ← 매일 바뀌어야 한다 (0~2 가 정상)`);
  log(`    제외 사유: ${Object.entries(t.reasons).map(([k, v]) => `${k} ${num(v)}`).join(' / ')}`);
  if (t.list.length) {
    log(`    오늘 상위:`);
    t.list.slice(0, 10).forEach((x, i) => log(`      ${String(i + 1).padStart(2)}  ${(x.pct.toFixed(1) + '%').padStart(7)}`
      + `  ${String(num(x.yesterdayPrice)).padStart(11)} → ${String(num(x.todayPrice)).padStart(11)}`
      + `  (-${num(x.amount)})  ${x.key.slice(0, 44)}`));
  } else {
    log(`    (오늘 후보 없음 — 수집이 아직 돌고 있거나, 값이 움직이지 않았다)`);
  }
  out.hotdeal = {
    yesterday, seriesCount: series.size, todayCandidates: t.list.length,
    yesterdayCandidates: y.list.length, top20Overlap: overlap, reasons: t.reasons,
    top: t.list.slice(0, 20)
  };

  /* ── E. egress ───────────────────────────────────────────────── */
  const eligBytes = elig ? elig.size * 96 : 0;
  const perRowFull = 448;      // 2026-09-20 실측 (title/link/image 포함 select)
  const perRowElig = 724;      // 대상만 읽을 때의 행당 크기 (대상 행이 더 길다)
  log(`\n[E] 수집기 한 바퀴의 products 읽기 (실측 행당 크기 기준)`);
  log(`    예전: 전체 스캔   ${String(num(totalProducts)).padStart(8)}행  ≈ ${(totalProducts * perRowFull / 1e6).toFixed(1)} MB`);
  log(`    지금: 대상만 읽기 ${String(num(target)).padStart(8)}행  ≈ ${(target * perRowElig / 1e6).toFixed(2)} MB`
    + `   (절감 ${pct(totalProducts * perRowFull - target * perRowElig, totalProducts * perRowFull)})`);
  out.egress = {
    beforeBytes: totalProducts * perRowFull,
    afterBytes: target * perRowElig + eligBytes,
    totalProducts, target
  };

  log(`\n  ※ 이 감사가 읽은 바이트: ${(readBytes / 1e6).toFixed(1)} MB (쓰기 0, 외부 API 0회)`);
  log('');

  if (JSON_OUT) console.log(JSON.stringify(out, null, 2));
})().catch(e => { console.error('감사 실패:', e.message); process.exit(1); });
