#!/usr/bin/env node
/*
 * 하루 캐시(scripts/_daycache.js) 회귀 테스트 (2026-10-22) — 외부 API·운영 DB 0회.
 *
 *   node scripts/test-daycache.js
 *
 * 고정하는 것:
 *   [1] 파일 왕복 · 키/종류가 다르면 · 깨졌으면 · 없으면 → 쓰지 않는다(hit=false)
 *   [2] 수집기 대상 캐시 — 저장한 대상(키·상시/회전·상품 행)을 그대로 돌려준다. 서명·열 목록이 다르거나
 *       모양이 틀리면(대상 밖 상품 행) 쓰지 않는다. 회전/상시 모드만 캐시한다.
 *   [3] 핫딜 기록 — 캐시 끔 = 첫 실행(파일 생성) = 캐시 쓴 실행, 결과가 행 하나까지 같다.
 *       캐시 쓴 실행은 캐시에 있는 상품의 «오늘 행» 만 DB 에서 읽는다. 오늘 새로 들어온 행이 반영된다.
 *       실패한 묶음의 상품은 캐시에 넣지 않는다. 캐시에 없는 상품은 예전처럼 전부 읽는다.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

function inject(rel, ex) {
  const p = require.resolve(path.join(__dirname, '..', rel));
  require.cache[p] = new Module(p, null);
  require.cache[p].filename = p; require.cache[p].loaded = true; require.cache[p].exports = ex;
}

const { kstToday } = require('../api/_kst');
const TODAY = kstToday();
const daysAgo = n => kstToday(new Date(Date.now() - n * 86400000));

/* ── 가짜 price_history (핫딜 기록 로더가 쓰는 모양만) ── */
const db = { history: [], queries: [], failFor: null };
function historyQuery() {
  const f = { in: null, gte: null, lt: null };
  let from = 0, to = 1e9;
  const q = {
    select() { return q; },
    in(c, v) { f.in = v.map(String); return q; },
    gte(c, v) { f.gte = v; return q; },
    lt(c, v) { f.lt = v; return q; },
    order() { return q; },
    range(a, b) { from = a; to = b; return q; },
    then(res) {
      db.queries.push({ ids: f.in.slice(), gte: f.gte, lt: f.lt });
      if (db.failFor && f.in.indexOf(db.failFor) > -1) return Promise.resolve({ data: null, error: { message: 'boom' } }).then(res);
      const rows = db.history
        .filter(r => f.in.indexOf(String(r.product_id)) > -1 && r.recorded_date >= f.gte && (!f.lt || r.recorded_date < f.lt))
        .sort((a, b) => (a.product_id < b.product_id ? -1 : a.product_id > b.product_id ? 1 : a.recorded_date < b.recorded_date ? -1 : a.recorded_date > b.recorded_date ? 1 : 0))
        .slice(from, to + 1);
      return Promise.resolve({ data: rows.map(r => ({ ...r })), error: null }).then(res);
    }
  };
  return q;
}
inject('api/_supabase.js', {
  from: t => (t === 'price_history' ? historyQuery() : (() => { throw new Error('unexpected table ' + t); })()),
  rpc: () => Promise.resolve({ data: null, error: null })
});
inject('api/_notify.js', { send: () => Promise.resolve({ ok: true }) });

const DayCache = require('./_daycache');
const C = require('./collect-all-prices');
const H = require('./collect-hotdeals');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? '  — ' + detail : ''}`);
  if (ok) pass++; else fail++;
}
const eq = (label, a, b) => check(label, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a).slice(0, 200)} want ${JSON.stringify(b).slice(0, 200)}`);
const tmp = name => path.join(os.tmpdir(), `seosa-daycache-test-${process.pid}-${name}`);
const mapView = m => [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));

(async () => {
  console.log('\n[1] 파일 왕복');
  {
    const f = tmp('basic.json.gz');
    const w = DayCache.writeDayCache(f, 'k', 'key-1', { a: [1, 2, 3] });
    check('쓰기 성공', w.ok && w.bytes > 0);
    const r = DayCache.readDayCache(f, 'k', 'key-1');
    eq('같은 종류·키 → 그대로', [r.hit, r.payload], [true, { a: [1, 2, 3] }]);
    eq('키가 다르면 쓰지 않는다', DayCache.readDayCache(f, 'k', 'key-2').reason, 'key');
    eq('종류가 다르면 쓰지 않는다', DayCache.readDayCache(f, 'other', 'key-1').reason, 'format');
    fs.writeFileSync(f, 'not gzip');
    eq('깨진 파일 → 쓰지 않는다', DayCache.readDayCache(f, 'k', 'key-1').reason, 'corrupt');
    eq('파일 없음', DayCache.readDayCache(tmp('none.json.gz'), 'k', 'x').reason, 'none');
    eq('경로 없음(끔)', DayCache.readDayCache('', 'k', 'x').reason, 'off');
    fs.unlinkSync(f);
  }

  console.log('\n[2] 수집기 대상 캐시');
  {
    const f = tmp('targets.json.gz');
    const meta = { mode: 'rotation', rotationDays: 7, rotationBucket: 3, signature: `rotation-v1:${TODAY}:7:3` };
    const target = {
      keys: new Set(['A|쿠팡', 'B|ADPICK', 'C|쿠팡']),
      dailyKeys: new Set(['A|쿠팡']), rotationKeys: new Set(['B|ADPICK', 'C|쿠팡']),
      rotationDays: 7, rotationBucket: 3, source: 'keyset'
    };
    const products = [
      { product_id: 'A', mall: '쿠팡', title: '가', keyword: '가', link: 'https://x/a', vendor_item_id: '1', item_id: '' },
      { product_id: 'B', mall: 'ADPICK', title: '나', keyword: '나', link: '', vendor_item_id: '', item_id: '' }
    ];
    C.saveTargetDayCache(meta, target, products, f);
    const got = C.loadTargetDayCache(meta, f);
    check('저장한 대상을 읽는다', !!got);
    eq('키 · 상시 · 회전 집합이 같다', [[...got.target.keys].sort(), [...got.target.dailyKeys], [...got.target.rotationKeys].sort()],
      [[...target.keys].sort(), [...target.dailyKeys], [...target.rotationKeys].sort()]);
    eq('상품 행이 같다(순서 포함)', got.products, products);
    eq('회전 정보 · 출처 표시', [got.target.rotationDays, got.target.rotationBucket, got.target.source], [7, 3, 'day-cache']);
    check('다른 날 서명이면 쓰지 않는다', C.loadTargetDayCache({ ...meta, signature: `rotation-v1:${daysAgo(1)}:7:2` }, f) === null);
    check('계획기 서명(:planner-v3)이 다르면 쓰지 않는다', C.loadTargetDayCache({ ...meta, signature: meta.signature + ':planner-v3' }, f) === null);
    check('★ 키에 열 목록이 들어간다 (배포로 열이 바뀌면 옛 파일을 쓰지 않는다)', C.targetCacheKey(meta).endsWith(C.PRODUCT_COLS));
    // 대상 밖 상품 행이 섞인 파일 → 쓰지 않는다
    DayCache.writeDayCache(f, 'collector-targets', C.targetCacheKey(meta), { dailyKeys: ['A|쿠팡'], rotationKeys: [], products: [products[1]] });
    check('대상 밖 상품 행이 있으면 쓰지 않는다', C.loadTargetDayCache(meta, f) === null);
    // 전체·시드 모드는 캐시하지 않는다
    const f2 = tmp('targets-all.json.gz');
    C.saveTargetDayCache({ mode: 'all', signature: `all-v1:${TODAY}` }, target, products, f2);
    check('전체(bulk) 모드는 파일을 만들지 않는다', !fs.existsSync(f2));
    try { fs.unlinkSync(f); } catch (_) { /* 없음 */ }
  }

  console.log('\n[3] 핫딜 기록 — 어제까지 캐시');
  {
    // 상품 205개(묶음 3개: 100·100·5), 상품마다 계열 1~2개, 120일 안팎 기록 + 오늘 행
    db.history = [];
    const ids = Array.from({ length: 205 }, (_, i) => `P${String(i).padStart(4, '0')}`);
    ids.forEach((id, i) => {
      for (let d = 125; d >= 1; d -= 7) db.history.push({ product_id: id, mall: '쿠팡', vendor_item_id: 'V1', price: 1000 + d, recorded_date: daysAgo(d), recorded_at: `${daysAgo(d)}T01:00:00+00:00` });
      if (i % 3 === 0) db.history.push({ product_id: id, mall: '쿠팡', vendor_item_id: 'V2', price: 777, recorded_date: daysAgo(2), recorded_at: `${daysAgo(2)}T02:00:00+00:00` });
      if (i % 2 === 0) db.history.push({ product_id: id, mall: '쿠팡', vendor_item_id: 'V1', price: 900, recorded_date: TODAY, recorded_at: `${TODAY}T00:30:00+00:00` });
    });
    const products = ids.map(id => ({ product_id: id, mall: '쿠팡' }));
    const f = tmp('history.json.gz');
    try { fs.unlinkSync(f); } catch (_) { /* 없음 */ }

    db.queries.length = 0;
    const off = await H.loadHistory(products, { cacheFile: '' });
    const offQueries = db.queries.length;
    db.queries.length = 0;
    const first = await H.loadHistory(products, { cacheFile: f });
    check('첫 실행이 캐시 파일을 남겼다', fs.existsSync(f));
    eq('★ 캐시 끔 = 첫 실행(파일 생성) 결과', mapView(first), mapView(off));
    eq('첫 실행 질의 수 = 캐시 끔과 같다', db.queries.length, offQueries);

    // 같은 날 다음 실행 전에 오늘 행이 새로 들어왔다(수집 진행).
    db.history.push({ product_id: 'P0001', mall: '쿠팡', vendor_item_id: 'V1', price: 850, recorded_date: TODAY, recorded_at: `${TODAY}T05:00:00+00:00` });
    const offAfter = await H.loadHistory(products, { cacheFile: '' });
    db.queries.length = 0;
    const second = await H.loadHistory(products, { cacheFile: f });
    eq('★ 캐시 쓴 실행 = 캐시 끔 결과 (오늘 새 행 포함)', mapView(second), mapView(offAfter));
    check('오늘 새 행이 보인다', (second.get('P0001|쿠팡|V1') || []).some(p => p.price === 850));
    check('★ 캐시 쓴 실행은 오늘 행만 DB 에서 읽는다', db.queries.length > 0 && db.queries.every(q => q.gte === TODAY && !q.lt),
      JSON.stringify(db.queries.slice(0, 2)));
    const list = second.get('P0000|쿠팡|V1') || [];
    check('계열 목록은 날짜 오름차순', list.every((p, i) => i === 0 || list[i - 1].date <= p.date));

    // 캐시에 없는 상품(오늘 대상에 새로 들어옴)은 전부 읽는다
    db.history.push({ product_id: 'NEW1', mall: '쿠팡', vendor_item_id: '', price: 5000, recorded_date: daysAgo(10), recorded_at: `${daysAgo(10)}T01:00:00+00:00` });
    db.queries.length = 0;
    const withNew = await H.loadHistory(products.concat([{ product_id: 'NEW1', mall: '쿠팡' }]), { cacheFile: f });
    check('캐시에 없는 상품은 120일 전부를 읽는다', (withNew.get('NEW1|쿠팡|') || []).length === 1
      && db.queries.some(q => q.ids.indexOf('NEW1') > -1 && q.gte < TODAY));

    // 실패한 묶음의 상품은 캐시에 넣지 않는다
    const f3 = tmp('history-fail.json.gz');
    try { fs.unlinkSync(f3); } catch (_) { /* 없음 */ }
    db.failFor = 'P0150';                       // 두 번째 묶음(P0100~P0199) 실패
    await H.loadHistory(products, { cacheFile: f3 });
    db.failFor = null;
    const raw = JSON.parse(require('zlib').gunzipSync(fs.readFileSync(f3)).toString('utf8'));
    eq('★ 실패한 묶음의 상품 100개는 캐시 ids 에 없다', raw.payload.ids.filter(id => id >= 'P0100' && id <= 'P0199').length, 0);
    eq('나머지 105개는 들어 있다', raw.payload.ids.length, 105);
    check('캐시에는 오늘 행이 없다(어제까지만)', raw.payload.rows.every(r => String(r.recorded_date) < TODAY));
    [f, f3].forEach(x => { try { fs.unlinkSync(x); } catch (_) { /* 없음 */ } });
  }

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
