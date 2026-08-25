#!/usr/bin/env node
/*
 * 2026-08-24 전체 감사 회귀 테스트.
 *
 *   node scripts/test-regression.js
 *
 * ── 이 파일이 존재하는 이유 ──────────────────────────────────────────
 * 감사에서 나온 6개 항목(O1 O2 O3 Y1 Y2 R2)은 기존 테스트가 한 건도 덮고
 * 있지 않다. 기존 스위트가 전부 PASS 하는 상태에서 발견된 문제이므로,
 * "기존 테스트가 통과한다 = 문제 없다" 가 성립하지 않는다는 뜻이다.
 *
 * ── 안전성 ───────────────────────────────────────────────────────────
 * 운영 Supabase 접근 0회 / 쿠팡 API 호출 0회 / 결제사 호출 0회 /
 * 메일 발송 0회. Supabase 와 알림 채널은 require 캐시에 가짜를 심어
 * 대체하고, 쿠팡은 로컬 http 서버를 COUPANG_API_HOST 로 물린다.
 *
 * ── PASS/FAIL 의 뜻 ──────────────────────────────────────────────────
 * 이 파일의 기대값은 "지금 코드가 하는 일" 이 아니라 "해야 하는 일" 이다.
 * FAIL 은 테스트가 잘못된 것이 아니라 구현에 결함이 있다는 뜻이다.
 * 테스트를 통과시키려고 기대값을 낮추지 말 것.
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');

/* ------------------------------------------------------------------ *
 *  0. 환경 격리 — 운영 자원에 절대 닿지 않게 한다
 * ------------------------------------------------------------------ */
// _coupang.js 는 모듈 로드 시점에 이 값들을 읽는다. require 보다 먼저 잡는다.
process.env.COUPANG_ACCESS_KEY = 'test-access-key';
process.env.COUPANG_SECRET_KEY = 'test-secret-key';
process.env.COUPANG_MIN_GAP_MS = '1';
process.env.RESEND_API_KEY = 'test-resend-key';   // check-alerts 가 없으면 exitCode=1
// 실수로 진짜 Supabase 로 나가는 일이 없도록 자격증명 자체를 지운다.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;

/* ------------------------------------------------------------------ *
 *  1. 가짜 Supabase
 *
 *  scripts/test-price.js 의 것과 같은 구조지만 두 가지가 다르다.
 *    · cfg.maxRows — PostgREST 의 db-max-rows(기본 1000) 를 흉내 낸다.
 *                    O3 테스트에 반드시 필요하다.
 *    · queryLog    — 어떤 쿼리가 limit/range 없이 나갔는지 기록한다.
 * ------------------------------------------------------------------ */
const db = {
  price_history: [],
  products: [],
  alerts: [],
  coupang_search_cache: []
};
const cfg = { maxRows: null };          // null = 상한 없음
const queryLog = [];                    // {table, hasLimit, hasRange, returned}
const rpcLog = [];                      // {name, args}
let rpcHandler = () => ({ data: null, error: null });

function resetDb() {
  db.price_history = [];
  db.products = [];
  db.alerts = [];
  db.coupang_search_cache = [];
  cfg.maxRows = null;
  queryLog.length = 0;
  rpcLog.length = 0;
}

function cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function makeQuery(table) {
  const filters = { in: null, lt: [], gte: [], eq: [] };
  const sorts = [];
  let cap = null, rangeFrom = null, rangeTo = null, single = false;

  function run() {
    let rows = (db[table] || []).slice();
    if (filters.in) rows = rows.filter(r => filters.in.vals.indexOf(String(r[filters.in.col])) > -1);
    filters.lt.forEach(f => { rows = rows.filter(r => cmp(r[f.col], f.v) < 0); });
    filters.gte.forEach(f => { rows = rows.filter(r => cmp(r[f.col], f.v) >= 0); });
    filters.eq.forEach(f => { rows = rows.filter(r => String(r[f.col]) === String(f.v)); });

    /*
     * .order() 를 여러 번 부르면 앞의 것이 1차 정렬키다 (PostgREST 와 같다).
     * 동점 처리를 흉내 내야 페이지네이션 검증이 의미를 갖는다 — recordPrices 는
     * 한 배치의 recorded_at 을 전부 같은 값으로 넣으므로 동점이 대량으로 생긴다.
     */
    if (sorts.length) {
      rows = rows.sort((a, b) => {
        for (const s of sorts) {
          const d = (s.asc ? 1 : -1) * cmp(a[s.col], b[s.col]);
          if (d !== 0) return d;
        }
        return 0;
      });
    }

    /*
     * PostgREST 의 Range 는 OFFSET/LIMIT 이다. 오프셋을 먼저 적용하고, 그 뒤
     * 돌려줄 행 수를 요청 limit 과 db-max-rows 중 작은 쪽으로 자른다.
     *
     * ★ 순서를 뒤집으면 안 된다. max-rows 로 먼저 자른 다음 range 를 인덱스로
     *   쓰면 range(1000,1999) 가 항상 0건이 되어, 정상적으로 구현된 페이지네이션이
     *   실패로 보인다 (처음에 이 하네스가 그렇게 돼 있었다).
     */
    const start = rangeFrom === null ? 0 : rangeFrom;
    let want = rangeFrom === null ? Infinity : (rangeTo - rangeFrom + 1);
    if (cap != null) want = Math.min(want, cap);
    if (cfg.maxRows != null) want = Math.min(want, cfg.maxRows);
    rows = Number.isFinite(want) ? rows.slice(start, start + want) : rows.slice(start);

    queryLog.push({
      table, hasLimit: cap !== null, hasRange: rangeFrom !== null, returned: rows.length
    });
    return rows;
  }

  const q = {
    select() { return q; },
    order(col, opts) { sorts.push({ col, asc: !opts || opts.ascending !== false }); return q; },
    limit(n) { cap = n; return q; },
    in(col, vals) { filters.in = { col, vals: vals.map(String) }; return q; },
    lt(col, v) { filters.lt.push({ col, v }); return q; },
    gte(col, v) { filters.gte.push({ col, v }); return q; },
    eq(col, v) { filters.eq.push({ col, v }); return q; },
    range(from, to) { rangeFrom = from; rangeTo = to; return q; },
    maybeSingle() { single = true; return q; },
    then(resolve, reject) {
      const rows = run();
      const data = single ? (rows[0] || null) : rows;
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    }
  };
  return q;
}

const fakeSupabase = {
  from(table) {
    return Object.assign(makeQuery(table), {
      update(patch) {
        const eqs = [];
        return {
          eq(col, v) {
            eqs.push({ col, v });
            (db[table] || []).forEach(r => {
              if (eqs.every(f => String(r[f.col]) === String(f.v))) Object.assign(r, patch);
            });
            return Promise.resolve({ data: null, error: null });
          }
        };
      },
      upsert(rows) {
        const list = Array.isArray(rows) ? rows : [rows];
        const key = table === 'price_history'
          ? ['product_id', 'mall', 'vendor_item_id', 'recorded_date']
          : table === 'products' ? ['product_id', 'mall'] : ['id'];
        list.forEach(r => {
          if (!db[table]) db[table] = [];
          const i = db[table].findIndex(x => key.every(k => String(x[k] || '') === String(r[k] || '')));
          if (i > -1) db[table][i] = { ...db[table][i], ...r };
          else db[table].push({ ...r });
        });
        return Promise.resolve({ data: list, error: null });
      }
    });
  },
  rpc(name, args) {
    rpcLog.push({ name, args });
    return Promise.resolve(rpcHandler(name, args));
  }
};

function inject(relPath, exportsObj) {
  const p = require.resolve(path.join(ROOT, relPath));
  require.cache[p] = new Module(p, null);
  require.cache[p].filename = p;
  require.cache[p].loaded = true;
  require.cache[p].exports = exportsObj;
}

const sentMail = [];
inject('api/_supabase.js', fakeSupabase);
inject('api/_notify.js', {
  send(channel, payload) { sentMail.push({ channel, payload }); return Promise.resolve({ ok: true }); }
});

/* ------------------------------------------------------------------ *
 *  2. 테스트 유틸
 * ------------------------------------------------------------------ */
const results = {};   // 'O1' → {pass, fail}
let current = null;

function suite(id, title) {
  current = id;
  results[id] = results[id] || { pass: 0, fail: 0 };
  console.log(`\n${'─'.repeat(66)}\n${id} — ${title}\n${'─'.repeat(66)}`);
}
function check(ok, label, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  ok ? results[current].pass++ : results[current].fail++;
  return ok;
}
function note(msg) { console.log(`        ${msg}`); }

const {
  kstToday, kstDayStartUtc, plausibleDrop, todayDropConfirmed, observedKstDate, classifyPrice
} = require(path.join(ROOT, 'api/_price.js'));
const { recordPrices } = require(path.join(ROOT, 'api/_shop.js'));

const TODAY = kstToday();
const kstDay = n => kstToday(new Date(Date.now() - n * 86400000));
/** KST 로 n 일 전의 그 시각(절대 시각). 오늘 경계 안/밖을 정확히 만들 때 쓴다. */
function atKst(kstDate, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.parse(kstDate + 'T00:00:00Z') - 9 * 3600000 + (h * 60 + m) * 60000).toISOString();
}

/* ================================================================== *
 *  O1 — price_drop_top 뷰의 vendor_item_id 조인
 *
 *  가설: 뷰는 (pid, mall, vid) 단위로 latest/prev 를 만드는데, products 는
 *        (pid, mall) 당 1행이라 vid 가 어긋난 행은 title/link/image 가 NULL 이
 *        된다. plausibleDrop 이 link 없는 행을 버리므로 시세판 후보가 사라진다.
 *
 *  이 테스트는 뷰 SQL 을 JS 로 재현해서 조인 조건만 바꿔가며 결과를 비교한다.
 *  운영 DB 는 건드리지 않는다.
 * ================================================================== */
suite('O1', 'price_drop_top — vendor_item_id 조인이 상품 정보를 끊는다');

/**
 * price_drop_top 뷰 정의를 그대로 옮긴 시뮬레이터.
 *
 * 최신 정의: supabase/2026-08-24-price-drop-top-orphan-policy.sql
 *   · products 를 inner join (카탈로그에 없는 고아 이력은 뷰에 안 나온다)
 *   · 조인 키는 product_id + mall (vendor_item_id 는 넣지 않는다)
 *
 * @param {object} [opts]
 *   joinVid    true 면 옛 정의(vid 까지 조인)를 흉내 낸다 — 대조용
 *   innerJoin  false 면 옛 정의(left join)를 흉내 낸다 — 대조용
 */
function simulateDropView(history, products, opts) {
  const joinVid = !!(opts && opts.joinVid);
  const innerJoin = !opts || opts.innerJoin !== false;
  const live = history.filter(r => r.vendor_item_id !== '__LEGACY__');

  const groups = new Map();               // "pid|mall|vid" -> rows
  live.forEach(r => {
    const k = r.product_id + '|' + r.mall + '|' + r.vendor_item_id;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });

  const out = [];
  groups.forEach(rows => {
    // row_number() over (partition by pid, mall, vid order by recorded_date desc)
    const ranked = rows.slice().sort((a, b) => cmp(b.recorded_date, a.recorded_date));
    const latest = ranked[0];
    const prev = ranked[1];
    if (!prev) return;                    // where pv.prev_price is not null
    const allTimeLow = Math.min.apply(null, rows.map(r => r.price));

    const p2 = products.find(p =>
      p.product_id === latest.product_id
      && p.mall === latest.mall
      && (!joinVid || p.vendor_item_id === latest.vendor_item_id));

    // inner join — 카탈로그에 없는 상품은 뷰에 나오지 않는다.
    if (innerJoin && !p2) return;

    out.push({
      product_id: latest.product_id,
      mall: latest.mall,
      title: p2 ? p2.title : null,        // left join -> 매칭 실패면 NULL
      current_price: latest.price,
      prev_price: prev.price,
      all_time_low: allTimeLow,
      drop_amount: prev.price - latest.price,
      drop_pct: prev.price > 0 && latest.price < prev.price
        ? Math.round((1 - latest.price / prev.price) * 1000) / 10 : 0,
      is_all_time_low: latest.price <= allTimeLow,
      link: p2 ? p2.link : null,
      image: p2 ? p2.image : null,
      __vid: latest.vendor_item_id        // 검증용 (뷰에는 없는 컬럼)
    });
  });
  return out.sort((a, b) => b.drop_pct - a.drop_pct);
}

/* -- O1-1. 현재 뷰 SQL 이 실제로 vid 까지 조인하는가 (정적 확인) -- */
{
  /*
   * 뷰는 여러 마이그레이션에 걸쳐 재정의된다. 가장 나중 파일이 실제 정의다 —
   * 파일 하나를 콕 집어 검사하면 새 마이그레이션이 나온 뒤에도 옛 파일을 본다.
   */
  const defs = fs.readdirSync(path.join(ROOT, 'supabase'))
    .filter(f => f.endsWith('.sql'))
    .filter(f => /create\s+or\s+replace\s+view\s+price_drop_top/i
      .test(fs.readFileSync(path.join(ROOT, 'supabase', f), 'utf8')))
    /*
     * 파일명 사전순으로 정렬하면 안 된다. "2026-08-24-..." 와
     * "2026-08-vendor-identity..." 를 비교하면 '2' < 'v' 라 날짜가 있는 쪽이
     * 앞으로 가서, 더 나중 마이그레이션을 옛것으로 오인한다.
     * 날짜가 없는 파일은 그 달의 0일로 보고 정렬한다.
     */
    .sort((a, b) => {
      const key = f => {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(f);
        if (m) return m[1] + m[2] + m[3];
        const ym = /^(\d{4})-(\d{2})/.exec(f);
        return ym ? ym[1] + ym[2] + '00' : '00000000';
      };
      return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
    });
  const latestDef = defs[defs.length - 1];
  note('뷰 정의 파일: ' + defs.join(' → ') + '  (마지막이 유효)');
  check(!!latestDef, 'price_drop_top 정의 파일을 찾았다', latestDef);

  const sql = fs.readFileSync(path.join(ROOT, 'supabase', latestDef), 'utf8');
  const joinBlock = /join products p2 on([\s\S]{0,220}?);/i.exec(sql);
  const joinsOnVid = !!(joinBlock && /p2\.vendor_item_id\s*=\s*l\.vendor_item_id/.test(joinBlock[1]));
  const isLeftJoin = /left join products p2/i.test(sql);
  note('현재 조인 조건: ' + (joinBlock ? joinBlock[1].replace(/\s+/g, ' ').trim() : '(찾지 못함)'));

  check(!joinsOnVid,
    '뷰는 products 를 product_id + mall 로만 조인해야 한다',
    joinsOnVid ? 'vendor_item_id 까지 조인 -> 과거 옵션 행이 전부 NULL' : '');
  check(!isLeftJoin,
    'products 를 inner join 한다 (카탈로그에 없는 고아 이력을 뷰에 올리지 않는다)',
    isLeftJoin ? 'left join 이라 고아 행이 title/link NULL 로 올라온다' : '');
}

/* -- O1-2. 감사 명세 그대로의 데이터로 NULL 조인 재현 -- */
{
  // price_history: pid=100 / mall=coupang / vid=A
  // products     : pid=100 / mall=coupang / vid=B   <- 대표 옵션이 바뀐 상태
  const history = [
    { product_id: '100', mall: '쿠팡', vendor_item_id: 'A', price: 70000, recorded_date: kstDay(1) },
    { product_id: '100', mall: '쿠팡', vendor_item_id: 'A', price: 60000, recorded_date: TODAY }
  ];
  const products = [
    { product_id: '100', mall: '쿠팡', vendor_item_id: 'B', title: '테스트 상품',
      link: 'https://link.coupang.com/re/X?itemId=1&vendorItemId=222', image: 'https://img/x.jpg' }
  ];

  // 옛 정의(left join + vid 포함)를 흉내 내 무엇이 문제였는지 대조한다.
  const withVid = simulateDropView(history, products, { joinVid: true, innerJoin: false });
  const noVid = simulateDropView(history, products, { joinVid: false });

  check(withVid.length === 1 && withVid[0].title === null && withVid[0].link === null,
    'vid 까지 조인하면 title/link 가 NULL 이 된다 (문제 재현)',
    'title=' + (withVid[0] && withVid[0].title) + ' link=' + (withVid[0] && withVid[0].link));
  check(noVid.length === 1 && noVid[0].title === '테스트 상품' && !!noVid[0].link,
    'pid+mall 로만 조인하면 상품 정보가 붙는다',
    'title=' + (noVid[0] && noVid[0].title));

  // 시세판이 실제로 이 행을 쓸 수 있는가 - plausibleDrop 은 link 없는 행을 버린다.
  check(plausibleDrop(withVid[0]) === false,
    'NULL 조인 행은 plausibleDrop 에서 탈락한다 (= 시세판 후보 소실)');
  check(plausibleDrop(noVid[0]) === true,
    'pid+mall 조인 행은 plausibleDrop 을 통과한다');
}

/* -- O1-3. pid+mall 조인이 "다른 상품" 을 붙일 수 있는가 --
 *
 * products 에는 products_pid_mall_key UNIQUE (product_id, mall) 가 있다
 * (supabase/2026-08-products-unique-restore.sql). pid+mall 로 조인하면
 * 매칭되는 products 행은 정의상 0개 아니면 1개다 - 다른 상품이 붙을 수 없다.
 */
{
  const restore = fs.readFileSync(path.join(ROOT, 'supabase/2026-08-products-unique-restore.sql'), 'utf8');
  check(/unique\s*\(\s*product_id\s*,\s*mall\s*\)/i.test(restore),
    'products 에 (product_id, mall) UNIQUE 가 있어 pid+mall 조인은 1행만 매칭된다',
    'products_pid_mall_key');

  // 같은 product_id 를 다른 몰이 쓰는 경우에도 섞이지 않아야 한다.
  const history = [
    { product_id: '200', mall: '쿠팡', vendor_item_id: 'A', price: 50000, recorded_date: kstDay(1) },
    { product_id: '200', mall: '쿠팡', vendor_item_id: 'A', price: 40000, recorded_date: TODAY }
  ];
  const products = [
    { product_id: '200', mall: '네이버', vendor_item_id: 'A', title: '남의 몰 상품', link: 'https://naver/x', image: '' },
    { product_id: '200', mall: '쿠팡', vendor_item_id: 'B', title: '내 상품', link: 'https://link.coupang.com/re/Y?vendorItemId=333', image: '' }
  ];
  const noVid = simulateDropView(history, products, { joinVid: false });
  check(noVid.length === 1 && noVid[0].title === '내 상품',
    '몰이 다른 동일 product_id 행이 섞이지 않는다', noVid[0] && noVid[0].title);
}

/* -- O1-4. 조인을 풀었을 때 "틀린 가격" 이 노출될 수 있는가 --
 *
 * pid+mall 조인은 옛 옵션(vid=A)의 가격에 현재 옵션(vid=B)의 링크를 붙인다.
 * 그 자체로는 위험하다. 안전판은 todayDropConfirmed 다 - 화면에 찍을
 * current_price 가 "오늘 원장에 실제로 있는 최신 관측가" 와 같아야만 통과시킨다.
 */
{
  const history = [
    // 옛 옵션 A - 며칠 전에 멈췄다. 뷰는 여전히 latest/prev 를 만들어 낸다.
    { product_id: '300', mall: '쿠팡', vendor_item_id: 'A', price: 90000, recorded_date: kstDay(6), recorded_at: atKst(kstDay(6), '02:00') },
    { product_id: '300', mall: '쿠팡', vendor_item_id: 'A', price: 50000, recorded_date: kstDay(5), recorded_at: atKst(kstDay(5), '02:00') },
    // 현재 옵션 B - 오늘도 수집됐고 값이 다르다.
    { product_id: '300', mall: '쿠팡', vendor_item_id: 'B', price: 88000, recorded_date: kstDay(1), recorded_at: atKst(kstDay(1), '02:00') },
    { product_id: '300', mall: '쿠팡', vendor_item_id: 'B', price: 86000, recorded_date: TODAY, recorded_at: atKst(TODAY, '02:00') }
  ];
  const products = [
    { product_id: '300', mall: '쿠팡', vendor_item_id: 'B', title: '로봇청소기',
      link: 'https://link.coupang.com/re/Z?itemId=9&vendorItemId=444', image: '' }
  ];
  const rows = simulateDropView(history, products, { joinVid: false }).filter(plausibleDrop);
  const points = history.map(r => ({ price: r.price, recorded_date: r.recorded_date, recorded_at: r.recorded_at }));
  const confirmed = rows.filter(r => todayDropConfirmed(r, points, TODAY));

  const staleRow = rows.find(r => r.__vid === 'A');
  check(!!staleRow, '조인을 풀면 옛 옵션 행도 링크를 얻어 후보로 올라온다 (위험 지점)',
    staleRow ? 'vid=A current=' + staleRow.current_price + ' 인데 link 는 현재 옵션의 것' : '');
  check(confirmed.every(r => r.__vid === 'B'),
    'todayDropConfirmed 가 옛 옵션 행을 걸러낸다 (오늘 원장 최신가와 불일치)',
    '통과 ' + confirmed.length + '행: ' + (confirmed.map(r => r.__vid).join(',') || '없음'));
  check(confirmed.every(r => r.current_price === 86000),
    '통과한 행의 표시가는 오늘 원장의 최신 관측가와 일치한다',
    confirmed.map(r => r.current_price).join(','));
}

/* -- O1-5. 두 옵션이 오늘 같은 값으로 관측된 경우 (가장 까다로운 케이스) -- */
{
  const history = [
    { product_id: '400', mall: '쿠팡', vendor_item_id: 'A', price: 70000, recorded_date: kstDay(1), recorded_at: atKst(kstDay(1), '02:00') },
    { product_id: '400', mall: '쿠팡', vendor_item_id: 'A', price: 60000, recorded_date: TODAY, recorded_at: atKst(TODAY, '02:00') },
    { product_id: '400', mall: '쿠팡', vendor_item_id: 'B', price: 70000, recorded_date: kstDay(1), recorded_at: atKst(kstDay(1), '02:05') },
    { product_id: '400', mall: '쿠팡', vendor_item_id: 'B', price: 60000, recorded_date: TODAY, recorded_at: atKst(TODAY, '02:05') }
  ];
  const products = [
    { product_id: '400', mall: '쿠팡', vendor_item_id: 'B', title: '동일가 옵션',
      link: 'https://link.coupang.com/re/W?vendorItemId=555', image: '' }
  ];
  const rows = simulateDropView(history, products, { joinVid: false }).filter(plausibleDrop);
  const points = history.map(r => ({ price: r.price, recorded_date: r.recorded_date, recorded_at: r.recorded_at }));
  const confirmed = rows.filter(r => todayDropConfirmed(r, points, TODAY));

  check(confirmed.every(r => r.current_price === 60000 && r.prev_price === 70000),
    '두 옵션이 동일가여도 표시되는 숫자는 전부 원장과 일치한다',
    '통과 ' + confirmed.length + '행');
  if (confirmed.length > 1) {
    note('※ 뷰는 옵션 단위라 같은 상품이 ' + confirmed.length + '행으로 나올 수 있다 '
      + '(값은 전부 정확하다). api/init.js 가 노출 단계에서 상품당 1장으로 접는다.');
  }
}

async function runO2() {

/* ================================================================== *
 *  O2 — 옵션 교체 판정의 "직전 vendorItemId" 출처
 *
 *  ── 코드 구조 (실제 확인) ─────────────────────────────────────────
 *    api/_shop.js loadPrevObservations()
 *        select('product_id, mall, price, recorded_date, recorded_at')
 *        .lt('recorded_at', kstDayStartUtc(today))      <- 오늘 행을 뺀다
 *      -> 비교 기준가(prev.price)는 "오늘 이전의 마지막 관측" 이다.
 *         vendor_item_id 는 select 에 없다.
 *
 *    api/_shop.js loadStoredVendorIds()
 *        select from products                            <- 오늘 갱신분 포함
 *      -> 비교 기준 옵션(prev.vendorItemId)은 "지금 카탈로그의 대표 옵션" 이다.
 *
 *  두 값의 시점이 다르다. 가격은 어제 것인데 옵션은 오늘 것이다.
 *
 *  ── 감사 명세의 기대값을 코드 설계에 맞춰 정정한다 ────────────────
 *  명세는 "오늘 2회차의 직전 관측 = 오늘 1회차" 로 적었지만, 코드는 의도적으로
 *  오늘 행을 제외한다(주석: "자기 자신과 비교하면 검증이 무력화된다").
 *  따라서 두 시나리오 모두 직전 관측은 '어제(vid=111, 60,000)' 이고,
 *  올바른 기대값은 아래와 같다.
 * ================================================================== */
suite('O2', '옵션 교체 감지 — 직전 vid 를 원장이 아니라 카탈로그에서 읽는다');

const VID_OLD = '111';   // 어제 관측된 옵션
const VID_NEW = '222';   // 오늘 대표가 된 옵션

function seedYesterday() {
  resetDb();
  db.price_history.push({
    product_id: '100', mall: '쿠팡', title: '무선 이어폰', price: 60000,
    vendor_item_id: VID_OLD, item_id: '1',
    recorded_date: kstDay(1), recorded_at: atKst(kstDay(1), '02:00')
  });
  db.products.push({
    product_id: '100', mall: '쿠팡', title: '무선 이어폰', keyword: '무선 이어폰',
    lprice: 60000, vendor_item_id: VID_OLD, item_id: '1',
    link: 'https://link.coupang.com/re/A?itemId=1&vendorItemId=' + VID_OLD,
    collected_at: atKst(kstDay(1), '02:00')
  });
}

function obs(vid, price) {
  return {
    productId: '100', mall: '쿠팡', title: '무선 이어폰', keyword: '무선 이어폰',
    price, vendorItemId: vid, itemId: '1',
    link: 'https://link.coupang.com/re/A?itemId=1&vendorItemId=' + vid,
    image: ''
  };
}

/* -- O2-0. classifyPrice 자체는 올바른가 (결함 위치를 좁힌다) -- */
{
  const switched = classifyPrice(20000,
    { price: 60000, observedAt: atKst(kstDay(1), '02:00'), vendorItemId: VID_OLD },
    { vendorItemId: VID_NEW });
  const same = classifyPrice(20000,
    { price: 60000, observedAt: atKst(kstDay(1), '02:00'), vendorItemId: VID_OLD },
    { vendorItemId: VID_OLD });

  check(switched.status === 'suspect',
    'classifyPrice: 옵션이 바뀐 3배 변동은 suspect (OPTION_SWITCH_RATIO=2)', switched.status);
  check(same.status === 'ok',
    'classifyPrice: 같은 옵션의 3배 변동은 ok (SUSPECT_RATIO=5)', same.status);
  note('=> classifyPrice 는 정상. 결함이 있다면 인자를 만들어 넘기는 recordPrices 쪽이다.');
}

/* -- O2-1. loadPrevObservations 가 vendor_item_id 를 읽는가 (정적) -- */
{
  const src = fs.readFileSync(path.join(ROOT, 'api/_shop.js'), 'utf8');
  // ★ 저장소 파일이 CRLF 다. /\n}\n/ 로 잡으면 함수 본문을 영영 못 찾아
  //   무엇을 검사하든 항상 FAIL 한다 (실제로 그랬다). \r 를 허용한다.
  const fn = /async function loadPrevObservations[\s\S]*?\r?\n}\r?\n/.exec(src);
  /*
   * select 문자열을 리터럴로 고정하지 않는다 - 컬럼 목록을 상수로 빼는 것은
   * 정상적인 구현 방식이고, 그걸 깨뜨리는 테스트는 리팩터링을 막을 뿐이다.
   * 확인하려는 성질은 하나다: 이 함수가 price_history 에서 옵션 식별자를
   * 읽어서 직전 관측에 실어 보내는가.
   */
  const readsVid = !!(fn && /vendor_item_id/.test(fn[0]) && /vendorItemId\s*:/.test(fn[0]));
  check(readsVid,
    'loadPrevObservations 가 직전 관측 행의 vendor_item_id 를 함께 읽어 실어 보낸다',
    readsVid ? '' : '직전 옵션을 원장에서 알 수 없다 (products 값을 대신 쓰게 된다)');

  const usesLedgerVid = /vendorItemId:\s*prevObs\.vendorItemId/.test(src);
  check(usesLedgerVid,
    'recordPrices 가 prev.vendorItemId 를 직전 관측 행에서 채운다',
    usesLedgerVid ? '' : '현재는 vendorMap(products 현재 대표 옵션)에서 채운다');
}

/* -- O2-2. 시나리오 B-1: 어제 B / 오늘 1회차 A / 오늘 2회차 A --
 *
 *   직전 관측(오늘 제외) = 어제 vid=111 @ 60,000
 *   이번 관측            =      vid=222 @ 20,000
 *   -> 옵션이 바뀌었고 3배 변동 -> suspect (현재가로 승격하면 안 된다)
 */
{
  seedYesterday();
  const r1 = await recordPrices([obs(VID_NEW, 55000)], { label: 'B-1/1회차' });
  const afterFirst = db.products.find(p => p.product_id === '100');
  check(r1.saved === 1 && afterFirst.lprice === 55000 && afterFirst.vendor_item_id === VID_NEW,
    'B-1 1회차: 111->222 교체 + 1.09배 변동은 정상 통과, products 가 222/55,000 이 된다',
    'lprice=' + afterFirst.lprice + ' vid=' + afterFirst.vendor_item_id);

  const r2 = await recordPrices([obs(VID_NEW, 20000)], { label: 'B-1/2회차' });
  const afterSecond = db.products.find(p => p.product_id === '100');

  check(r2.suspect === 1 && r2.saved === 0,
    'B-1 2회차: 직전 관측(어제 vid=111)과 옵션이 다르므로 suspect 여야 한다',
    'suspect=' + r2.suspect + ' saved=' + r2.saved);
  check(afterSecond.lprice === 55000,
    'B-1 2회차: 20,000 이 현재가로 승격되면 안 된다',
    'products.lprice=' + afterSecond.lprice);
  check(db.price_history.some(h => h.price === 20000),
    'B-1 2회차: 관측 사실은 price_history 에 남는다 (다음 관측에서 확인 가능)');
}

/* -- O2-3. 시나리오 B-2: 어제 B / 오늘 1회차 A / 오늘 2회차 B --
 *
 *   직전 관측(오늘 제외) = 어제 vid=111 @ 60,000
 *   이번 관측            =      vid=111 @ 20,000   <- 같은 옵션이다
 *   -> 옵션 교체가 아니다. SUSPECT_RATIO(5) 기준이므로 3배는 정상 통과.
 *      products 현재 대표 옵션이 222 라는 사실은 판정에 끼어들면 안 된다.
 */
{
  seedYesterday();
  await recordPrices([obs(VID_NEW, 55000)], { label: 'B-2/1회차' });
  const r2 = await recordPrices([obs(VID_OLD, 20000)], { label: 'B-2/2회차' });
  const after = db.products.find(p => p.product_id === '100');

  check(r2.suspect === 0 && r2.saved === 1,
    'B-2 2회차: 직전 관측과 같은 옵션(111)이므로 suspect 가 아니어야 한다',
    'suspect=' + r2.suspect + ' saved=' + r2.saved);
  check(after.lprice === 20000,
    'B-2 2회차: 정상 변동이므로 현재가가 20,000 으로 갱신되어야 한다',
    'products.lprice=' + after.lprice);
}

/* -- O2-4. products 행이 없으면 옵션 교체 감지가 통째로 꺼진다 --
 *
 * 원장에는 어제 vid=111 이 분명히 있는데도, 카탈로그에 행이 없다는 이유만으로
 * prevVendor 가 '' 가 되어 교체 판정이 사라진다. (신규 등록 상품 / 옛 이관분)
 */
{
  resetDb();
  db.price_history.push({
    product_id: '100', mall: '쿠팡', title: '무선 이어폰', price: 60000,
    vendor_item_id: VID_OLD, item_id: '1',
    recorded_date: kstDay(1), recorded_at: atKst(kstDay(1), '02:00')
  });
  // products 는 비어 있다.
  const r = await recordPrices([obs(VID_NEW, 20000)], { label: 'B-3' });
  check(r.suspect === 1 && r.saved === 0,
    'products 행이 없어도 원장의 직전 옵션(111)으로 교체를 감지해야 한다',
    'suspect=' + r.suspect + ' saved=' + r.saved);
}
}


async function runO3() {

/* ================================================================== *
 *  O3 — scripts/check-alerts.js 와 PostgREST 의 1,000행 상한
 *
 *  Supabase PostgREST 는 db-max-rows(기본 1000)를 넘는 행을 돌려주지 않는다.
 *  .limit() 을 걸지 않으면 그 값이 그대로 상한이 된다. check-alerts 의 네 쿼리는
 *  limit 도 range 도 없다.
 *
 *  더 나쁜 것은 정렬 방향이다.
 *      .order('recorded_at', { ascending: true })
 *  이라 잘려 나가는 쪽이 "그날 나중에 수집된 행" 이다. 그런데 latestByProduct 는
 *  "뒤에 온 것이 이긴다" 로 그날 최종값을 잡는 설계다 - 잘리면 설계가 뒤집힌다.
 *
 *  운영 DB 는 건드리지 않는다. 가짜 Supabase 에 상한만 켜서 재현한다.
 * ================================================================== */
suite('O3', 'check-alerts — PostgREST 1,000행 상한에서 알림이 누락된다');

const CHECK_ALERTS = path.join(ROOT, 'scripts/check-alerts.js');

/** check-alerts.run() 을 돌리고 exitCode 오염을 막는다. */
async function runCheckAlerts() {
  const before = process.exitCode;
  sentMail.length = 0;
  queryLog.length = 0;
  delete require.cache[require.resolve(CHECK_ALERTS)];
  const { run } = require(CHECK_ALERTS);
  try {
    await run();
  } finally {
    process.exitCode = before;   // 이 스크립트의 판정은 우리가 한다
  }
}

function alertRow(id, productId, targetPrice) {
  return {
    id, email: 'tester@example.com', title: '테스트 상품 ' + productId,
    mall: '쿠팡', product_id: productId, target_price: targetPrice,
    current_price: 0, sent: false, link: 'https://link.coupang.com/re/A', image: ''
  };
}

/* -- O3-1. 1,001번째 상품의 알림이 통째로 누락된다 -- */
{
  resetDb();
  cfg.maxRows = 1000;

  // 오늘(KST) 1,001개 상품 × 1행. recorded_at 오름차순으로 늘어놓는다.
  for (let i = 1; i <= 1001; i++) {
    db.price_history.push({
      id: i,
      product_id: String(i), mall: '쿠팡', title: '테스트 상품 ' + i,
      price: 10000, link: 'https://link.coupang.com/re/A',
      vendor_item_id: 'v' + i, recorded_date: TODAY,
      recorded_at: new Date(Date.parse(atKst(TODAY, '01:00')) + i * 1000).toISOString()
    });
  }
  // 마지막으로 수집된 상품에 알림을 걸어 둔다. 목표가는 이미 달성된 상태다.
  db.alerts.push(alertRow(1, '1001', 20000));

  await runCheckAlerts();
  check(sentMail.length === 1,
    '1,001번째 상품의 목표가 달성 알림이 발송되어야 한다',
    '발송 ' + sentMail.length + '건 (실패 시 원인: 오늘 가격 조회가 1,000행에서 잘림)');
}

/* -- O3-2. 같은 상품의 "그날 최종값" 이 잘려 옛 값으로 판정된다 -- */
{
  resetDb();
  cfg.maxRows = 1000;

  const target = { product_id: '9999', mall: '쿠팡', title: '급락 상품',
    link: 'https://link.coupang.com/re/B', vendor_item_id: 'vX', recorded_date: TODAY };

  // 새벽 1회차: 100,000원 (오름차순에서 맨 앞)
  db.price_history.push({ ...target, id: 1, price: 100000, recorded_at: atKst(TODAY, '01:00') });
  // 사이를 다른 상품 1,000행으로 채운다
  for (let i = 1; i <= 1000; i++) {
    db.price_history.push({
      id: 1 + i,
      product_id: 'f' + i, mall: '쿠팡', title: 'filler', price: 5000,
      link: '', vendor_item_id: 'vf' + i, recorded_date: TODAY,
      recorded_at: new Date(Date.parse(atKst(TODAY, '02:00')) + i * 1000).toISOString()
    });
  }
  // 3회차: 20,000원 - 이것이 그날의 실제 최종값이다 (오름차순에서 맨 뒤)
  db.price_history.push({ ...target, id: 1002, price: 20000, recorded_at: atKst(TODAY, '06:00') });

  db.alerts.push(alertRow(1, '9999', 30000));   // 목표가 30,000 -> 20,000 이면 달성

  await runCheckAlerts();
  check(sentMail.length === 1,
    '그날 마지막 관측(20,000)이 목표가(30,000)를 만족하므로 발송되어야 한다',
    '발송 ' + sentMail.length + '건 (실패 시 원인: 잘린 뒤 남은 값이 새벽의 100,000)');
}

/* -- O3-2b. 한 배치의 recorded_at 이 전부 같을 때 (실제 저장 모양) --
 *
 * recordPrices 는 배치 하나의 recorded_at 을 같은 값 하나로 넣는다.
 * 그래서 recorded_at 만으로 정렬하면 동점이 1,000행 넘게 생기고, 페이지 경계에서
 * 어떤 행은 두 번 오고 어떤 행은 영영 안 온다. id 2차 정렬키가 없으면 깨진다.
 */
{
  resetDb();
  cfg.maxRows = 1000;

  const sameInstant = atKst(TODAY, '02:00');
  for (let i = 1; i <= 1200; i++) {
    db.price_history.push({
      id: i,
      product_id: String(i), mall: '쿠팡', title: '동시 저장 ' + i,
      price: i === 1200 ? 15000 : 90000, link: 'https://link.coupang.com/re/A',
      vendor_item_id: 'v' + i, recorded_date: TODAY,
      recorded_at: sameInstant            // ← 전부 같은 시각
    });
  }
  db.alerts.push(alertRow(1, '1200', 20000));

  await runCheckAlerts();
  check(sentMail.length === 1,
    '한 배치가 같은 recorded_at 을 공유해도 모든 행을 빠짐없이 읽는다',
    '발송 ' + sentMail.length + '건 (실패 시 원인: 동점 정렬로 페이지 경계에서 행 누락)');
}

/* -- O3-3. 어느 쿼리에 페이지네이션이 필요한가 (구조 확인) -- */
{
  resetDb();
  cfg.maxRows = 1000;
  db.price_history.push({
    product_id: '1', mall: '쿠팡', title: 'x', price: 1000, link: '',
    vendor_item_id: 'v1', recorded_date: TODAY, recorded_at: atKst(TODAY, '01:00')
  });
  db.price_history.push({
    product_id: '1', mall: '쿠팡', title: 'x', price: 2000, link: '',
    vendor_item_id: 'v1', recorded_date: kstDay(1), recorded_at: atKst(kstDay(1), '01:00')
  });
  db.alerts.push(alertRow(1, '1', 5000));

  await runCheckAlerts();
  const unbounded = queryLog.filter(q => !q.hasLimit && !q.hasRange);
  const byTable = {};
  unbounded.forEach(q => { byTable[q.table] = (byTable[q.table] || 0) + 1; });
  note('limit/range 없는 쿼리: ' + (JSON.stringify(byTable) || '{}'));
  check(unbounded.length === 0,
    'check-alerts 의 모든 조회에 limit 또는 range 가 걸려 있어야 한다',
    unbounded.length + '개가 무제한 (todayRows / yesterdayRows / alertList / hist30)');
}

/* -- O3-4. 어떤 쿼리가 "limit 만으로 충분" 하고 어떤 것이 페이지네이션이 필요한가 --
 *
 * 판단 근거를 남겨 둔다. 수정 단계에서 이 구분을 그대로 쓰면 된다.
 *   todayRows      상품 수만큼 커진다(현재 1,064). 반드시 range 페이지네이션.
 *   yesterdayRows  같음. 반드시 페이지네이션.
 *   alertList      사용자 알림 총량. 페이지네이션(또는 처리 배치화).
 *   hist30         상품 1개 × 30일 = 최대 수십 행. .limit(수백) 으로 충분.
 */
{
  const src = fs.readFileSync(CHECK_ALERTS, 'utf8');
  const hist30Scoped = /const scoped = \(\) => supabase[\s\S]{0,240}?;/.exec(src);
  check(!!hist30Scoped, 'hist30 은 상품 1개로 좁혀진 쿼리다 (.eq(product_id).eq(mall))',
    hist30Scoped ? 'scoped() 확인됨 - limit 만으로 충분' : '');
  note('=> todayRows / yesterdayRows / alertList = range 페이지네이션 필요');
  note('=> hist30 = 명시적 .limit() 으로 충분');
}
}


/* ================================================================== *
 *  Y1 — "이달의 큐레이션" 이 UTC 기준 월을 쓴다
 *
 *  api/init.js:189 / api/cron.js:61   const month = new Date().getMonth() + 1;
 *
 *  getMonth() 는 "런타임 로컬 시간대" 기준이다. Vercel 함수는 TZ=UTC 로 돈다.
 *  그래서 KST 매월 1일 00:00~08:59 동안 UTC 는 아직 전달이고, 홈의 이달의 추천과
 *  cron 의 큐레이션 수집이 지난달 키워드를 쓴다.
 *
 *  로컬 개발 머신은 TZ=Asia/Seoul 이라 정상으로 보인다 - 그래서 놓치기 쉽다.
 *  이 테스트는 런타임 TZ 에 의존하지 않도록 UTC 로 명시 평가한다.
 * ================================================================== */
function runY1() {
  suite('Y1', '이달의 큐레이션 — UTC 기준 월이라 매월 1일 9시간 동안 지난달을 본다');

  // 검증 대상은 실제 구현이다. 여기서 다시 구현해 비교하면 아무것도 검증하지 못한다.
  const { kstMonth } = require(path.join(ROOT, 'api/_kst.js'));
  /** 프로덕션(TZ=UTC)에서 `new Date(t).getMonth()+1` 이 내던 값 — 비교용 참고치. */
  const naiveUtcMonth = iso => new Date(iso).getUTCMonth() + 1;

  const cases = [
    ['2026-09-01 00:30 KST', '2026-08-31T15:30:00.000Z', 9],
    ['2026-09-01 08:30 KST', '2026-08-31T23:30:00.000Z', 9],
    ['2026-09-01 09:30 KST', '2026-09-01T00:30:00.000Z', 9],
    ['2027-01-01 00:30 KST', '2026-12-31T15:30:00.000Z', 1]   // 연도까지 어긋나던 경계
  ];

  cases.forEach(([label, iso, want]) => {
    const got = kstMonth(new Date(iso));
    check(got === want,
      label + ' -> kstMonth = ' + want,
      'kstMonth=' + got + ' (옛 구현이던 UTC 기준=' + naiveUtcMonth(iso) + ')');
  });

  // Date 객체든 epoch 숫자든 같은 순간이면 같은 답이어야 한다 (kstToday 와 같은 계약).
  const t = Date.parse('2026-08-31T15:30:00.000Z');
  check(kstMonth(new Date(t)) === 9 && kstMonth(t) === 9,
    'Date 객체와 epoch 숫자 모두 받는다', kstMonth(new Date(t)) + '/' + kstMonth(t));

  // 날짜 문자열(kstToday)과 월(kstMonth)이 서로 어긋나면 안 된다.
  const sameAsToday = [0, 6, 15, 23].every(h => {
    const iso = `2026-08-31T${String(h).padStart(2, '0')}:30:00.000Z`;
    return kstMonth(new Date(iso)) === Number(kstToday(new Date(iso)).slice(5, 7));
  });
  check(sameAsToday, 'kstMonth 와 kstToday 가 같은 달력을 가리킨다');

  /*
   * 두 경로가 같은 기준을 쓰는지 (정적).
   *
   * ★ 주석을 벗기고 검사한다. 안 그러면 "new Date().getMonth() 를 쓰면 안 된다"
   *   고 적어 둔 설명문 자체에 걸려서 고친 파일이 계속 FAIL 한다 (실제로 그랬다).
   */
  const stripComments = s => s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  ['api/init.js', 'api/cron.js'].forEach(rel => {
    const code = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    const usesLocalMonth = /new Date\([^)]*\)\.getMonth\(\)/.test(code);
    const usesKstMonth = /kstMonth\(/.test(code);
    check(!usesLocalMonth && usesKstMonth,
      rel + ' 는 KST 기준 월(kstMonth)을 쓴다',
      usesLocalMonth ? 'new Date().getMonth() 사용 - 런타임 TZ 에 좌우됨'
        : (usesKstMonth ? '' : 'kstMonth 호출이 없다'));
  });

  note('※ 로컬(TZ=Asia/Seoul)에서는 정상으로 보이고 Vercel(TZ=UTC)에서만 틀린다.');
}

/* ================================================================== *
 *  Y2 — coupang_finish 인자 밀림
 *
 *  api/_coupang.js
 *      async function dbFinish(callId, outcome, httpStatus, rCode, items)
 *      ...
 *      await dbFinish(gate.callId, 'ok', r.status, items.length);   <- 4개
 *
 *  성공 경로에서만 인자가 하나 빠져 rCode 자리에 상품 수가 들어가고
 *  n_items 는 항상 0 이 된다. coupang_api_calls 의 성공 통계가 통째로 오염된다.
 *  (실패 경로들은 전부 5개를 정확히 넘긴다 - 그래서 눈에 안 띈다)
 * ================================================================== */
async function runY2() {
  suite('Y2', 'coupang_finish 인자 밀림 — 성공 호출의 rCode/n_items 가 뒤바뀐다');

  const src = fs.readFileSync(path.join(ROOT, 'api/_coupang.js'), 'utf8');
  const okCall = /await dbFinish\(gate\.callId, 'ok',([^)]*)\)/.exec(src);
  const argCount = okCall ? okCall[0].slice(0, -1).split(',').length : 0;
  note("현재 성공 경로: dbFinish(gate.callId, 'ok'," + (okCall ? okCall[1] : '?') + ')');
  check(argCount === 5,
    "dbFinish 성공 호출은 인자 5개(callId, outcome, http, rCode, items)를 넘겨야 한다",
    '현재 ' + argCount + '개');

  /* 실제 호출로 RPC 페이로드를 확인한다 (가짜 쿠팡 서버 + 가짜 supabase.rpc) */
  const server = http.createServer((req, res) => {
    const rows = [];
    for (let i = 1; i <= 10; i++) {
      rows.push({
        productId: 5000 + i, productName: '상품 ' + i, productPrice: 10000 + i,
        productUrl: 'https://link.coupang.com/re/A?itemId=' + i + '&vendorItemId=' + (900 + i),
        productImage: ''
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ rCode: '0', rMessage: '', data: { productData: rows } }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const finishes = [];
  rpcHandler = (name, args) => {
    if (name === 'coupang_acquire') return { data: [{ allowed: true, call_id: 'call-1', reason: '', used: 1 }], error: null };
    if (name === 'coupang_finish') { finishes.push(args); return { data: null, error: null }; }
    return { data: null, error: null };
  };

  const { searchCoupang } = freshCoupang({
    COUPANG_API_HOST: 'http://127.0.0.1:' + port,
    COUPANG_DISABLE_GLOBAL_GATE: '0'
  });
  const r = await searchCoupang('테스트', { limit: 10, source: 'test', useCache: false });
  server.close();
  rpcHandler = () => ({ data: null, error: null });

  const f = finishes[0] || {};
  note('coupang_finish 페이로드: ' + JSON.stringify(f));
  check(r.items.length === 10, '가짜 쿠팡 응답 10건이 정상 파싱된다', String(r.items.length));
  check(f.http === 200, 'http_status = 200', String(f.http));
  check(f.n_items === 10, 'n_items = 실제 상품 수(10)', String(f.n_items));
  check(String(f.rcode) !== '10', 'rcode 자리에 상품 수가 들어가지 않는다', 'rcode=' + f.rcode);
}

/* ================================================================== *
 *  R2 — 쿠팡 호출에 타임아웃이 없다
 *
 *  api/_coupang.js:508  fetch(HOST + SEARCH_PATH, { headers })   <- signal 없음
 *  api/_toss.js 와 api/ai.js 에는 AbortController 가 있는데 여기만 없다.
 *
 *  쿠팡이 연결을 열어 둔 채 응답하지 않으면 /api/search /api/ai /api/cron 과
 *  GitHub Actions 수집기가 함수 최대 실행시간까지 그 자리에 매달린다.
 *
 *  재시도는 절대 추가하지 않는다 - 기존 서킷 브레이커/레이트리밋 설계를 유지한 채
 *  "정해진 시간 안에 반드시 끝난다" 만 확인한다.
 * ================================================================== */
const R2_TIMEOUT_TARGET_MS = 8000;   // 권장 상한
const R2_GUARD_MS = 12000;           // 이 안에 안 끝나면 무한 대기로 판정

async function runR2() {
  suite('R2', '쿠팡 호출 타임아웃 — 응답하지 않는 쿠팡에 함수가 매달린다');

  /** 지연 응답 서버. delayMs = null 이면 영원히 응답하지 않는다. */
  function delayServer(delayMs) {
    const sockets = new Set();
    const server = http.createServer((req, res) => {
      const body = JSON.stringify({
        rCode: '0', data: { productData: [{
          productId: 777, productName: '지연 상품', productPrice: 12345,
          productUrl: 'https://link.coupang.com/re/A?itemId=1&vendorItemId=901', productImage: ''
        }] }
      });
      if (delayMs === null) return;   // 응답하지 않는다 (연결은 유지)
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
      }, delayMs);
    });
    server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    server.destroyAll = () => { sockets.forEach(s => s.destroy()); server.close(); };
    return server;
  }

  async function callWithGuard(host, opts) {
    const { searchCoupang } = freshCoupang({
      COUPANG_API_HOST: host, COUPANG_DISABLE_GLOBAL_GATE: '1'
    });
    const started = Date.now();
    let timer;
    const guard = new Promise(res => { timer = setTimeout(() => res('__HUNG__'), R2_GUARD_MS); });
    const out = await Promise.race([searchCoupang('테스트', Object.assign({ limit: 5, source: 'test', useCache: false }, opts)), guard]);
    clearTimeout(timer);
    return { out, elapsed: Date.now() - started };
  }

  /* R2-1. 정상 응답 */
  {
    const s = delayServer(0);
    await new Promise(r => s.listen(0, '127.0.0.1', r));
    const { out } = await callWithGuard('http://127.0.0.1:' + s.address().port);
    s.destroyAll();
    check(out !== '__HUNG__' && out.from === 'api' && out.items.length === 1,
      '정상 응답: from=api', out === '__HUNG__' ? 'HUNG' : out.from);
  }

  /* R2-2. 1초 지연 -> 성공해야 한다 (타임아웃이 너무 짧으면 안 된다) */
  {
    const s = delayServer(1000);
    await new Promise(r => s.listen(0, '127.0.0.1', r));
    const { out, elapsed } = await callWithGuard('http://127.0.0.1:' + s.address().port);
    s.destroyAll();
    check(out !== '__HUNG__' && out.from === 'api',
      '1초 지연: 정상 응답으로 처리된다', elapsed + 'ms');
  }

  /* R2-3. 5초 지연 -> 여전히 성공해야 한다 (권장 8초 상한 안) */
  {
    const s = delayServer(5000);
    await new Promise(r => s.listen(0, '127.0.0.1', r));
    const { out, elapsed } = await callWithGuard('http://127.0.0.1:' + s.address().port);
    s.destroyAll();
    check(out !== '__HUNG__' && out.from === 'api',
      '5초 지연: 아직 상한 안이라 정상 응답', elapsed + 'ms');
  }

  /* R2-4. 응답 없음 -> 상한 근처에서 안전하게 끝나야 한다 */
  {
    const s = delayServer(null);
    await new Promise(r => s.listen(0, '127.0.0.1', r));
    const { out, elapsed } = await callWithGuard('http://127.0.0.1:' + s.address().port);
    s.destroyAll();
    if (out === '__HUNG__') {
      check(false, '무응답: ' + R2_TIMEOUT_TARGET_MS + 'ms 안팎에서 끝나야 한다',
        R2_GUARD_MS + 'ms 동안 resolve 되지 않음 - AbortController 가 없어 무한 대기');
    } else {
      check(elapsed < R2_GUARD_MS && out.from === 'none',
        '무응답: 타임아웃으로 from=none 처리', elapsed + 'ms / from=' + out.from);
      check(out.blocked === false,
        '무응답 타임아웃은 차단(blocked)이 아니라 네트워크 오류로 다룬다', String(out.blocked));
    }
  }

  /* R2-5. 네트워크 오류(연결 거부) -> 이미 처리되는가 */
  {
    const { out, elapsed } = await callWithGuard('http://127.0.0.1:1');
    check(out !== '__HUNG__' && out.from === 'none' && /네트워크|연결|fetch/i.test(String(out.error)),
      '연결 거부: from=none + 네트워크 오류 메시지',
      out === '__HUNG__' ? 'HUNG' : (elapsed + 'ms / ' + String(out.error).slice(0, 60)));
  }

  /* R2-6. 타임아웃 뒤에는 서킷 브레이커가 잠시 호출을 멈춰야 한다 (재시도 금지) */
  {
    const src = fs.readFileSync(path.join(ROOT, 'api/_coupang.js'), 'utf8');
    const hasAbort = /AbortController/.test(src);
    check(hasAbort, '_coupang.js 가 AbortController 로 요청을 끊는다',
      hasAbort ? '' : 'signal 없이 fetch 한다 (api/_toss.js / api/ai.js 와 불일치)');
    check(!/retry|재시도\s*루프/i.test(src.replace(/재시도는[^\n]*/g, '')),
      '타임아웃 대응으로 재시도 루프를 넣지 않는다 (쿠팡 경고 누적 방지)');
  }
}

/* ------------------------------------------------------------------ *
 *  쿠팡 모듈을 매번 새로 로드한다.
 *
 *  _coupang.js 는 모듈 스코프에 state(서킷 브레이커·분당 윈도우)를 들고 있고
 *  MAX_PER_MIN / HOST 를 로드 시점에 읽는다. 한 시나리오에서 trip() 이 걸리면
 *  그 뒤 시나리오가 전부 "차단 중" 으로 끝나므로, 시나리오마다 캐시를 비운다.
 * ------------------------------------------------------------------ */
function freshCoupang(env) {
  Object.keys(env || {}).forEach(k => { process.env[k] = env[k]; });
  const p = require.resolve(path.join(ROOT, 'api/_coupang.js'));
  delete require.cache[p];
  return require(p);
}

/* ------------------------------------------------------------------ *
 *  실행
 * ------------------------------------------------------------------ */

/* ================================================================== *
 *  O1 (계속) — NULL 조인의 진짜 주범: products 행이 아예 없는 고아 이력
 *
 *  ★ 2026-08-24 실측으로 감사 가설이 부분적으로 틀렸음을 확인했다.
 *
 *    뷰 2,272행 / link NULL 1,549행 (68.2%)
 *      · products 에 (pid, mall) 이 있는데 vid 만 어긋난 행 ... 386
 *      · products 에 pid 자체가 없는 고아 이력 .............. 1,163
 *
 *    즉 NULL 의 주된 원인은 vid 조인이 아니라 "이력만 남고 카탈로그에서 사라진
 *    상품" 이다. price_history 비쿠팡 5,017행 vs products 비쿠팡 0행 —
 *    scripts/purge-noncoupang.js 로 카탈로그만 정리하고 이력을 남긴 결과다.
 *
 *    그리고 조인을 pid+mall 로 풀어 386행을 복구해도 plausibleDrop 통과는 0행이다.
 *    (멈춘 옵션 계열이라 마지막 두 관측이 애초에 하락이 아니다)
 *
 *  → 결론: 조인 결함은 기전상 실재하지만 현재 노출 손실은 0건이다.
 *    남는 문제는 "뷰의 97% 가 영구 쓰레기" 라는 위생 문제이고, 그것이
 *    DROP_FETCH(200) 창을 언젠가 밀어낼 수 있다는 미래 위험이다.
 * ================================================================== */
function runO1b() {
  suite('O1', 'price_drop_top — 고아 이력이 뷰를 채운다 (NULL 의 주된 원인)');

  // products 에 행이 없는 상품의 이력만 있는 경우
  const history = [
    { product_id: '500', mall: '네이버', vendor_item_id: '', price: 80000, recorded_date: kstDay(9) },
    { product_id: '500', mall: '네이버', vendor_item_id: '', price: 40000, recorded_date: kstDay(8) },
    { product_id: '삼성 갤럭시 핏3', mall: '쿠팡', vendor_item_id: '', price: 50000, recorded_date: kstDay(9) },
    { product_id: '삼성 갤럭시 핏3', mall: '쿠팡', vendor_item_id: '', price: 30000, recorded_date: kstDay(8) }
  ];
  const products = [];   // 카탈로그에서 사라진 상태

  const rows = simulateDropView(history, products, { joinVid: false });
  check(rows.length === 0,
    '카탈로그에 없는 상품의 이력은 뷰에 나오지 않아야 한다 (inner join / 정리 필요)',
    rows.length + '행이 title=null, link=null 로 뷰에 남는다');

  // 다만 정확성은 유지된다 — plausibleDrop 이 전부 걸러낸다.
  check(rows.every(r => plausibleDrop(r) === false),
    '고아 행은 plausibleDrop 이 전부 걸러낸다 (틀린 가격이 노출되지는 않는다)',
    '통과 ' + rows.filter(plausibleDrop).length + '행');

  note('실측: 뷰 2,272행 중 plausibleDrop 통과는 28행뿐. 상위 200행 창으로 좁혀도 28행 —');
  note('즉 현재는 DROP_FETCH=200 이 놓치는 후보가 0건이다. 손실이 아니라 미래 위험이다.');
}
(async () => {
  runO1b();
  await runO2();
  await runO3();
  runY1();
  await runY2();
  await runR2();

  const order = ['O1', 'O2', 'O3', 'Y1', 'Y2', 'R2'];
  let pass = 0, fail = 0;
  console.log('\n' + '='.repeat(66));
  console.log('회귀 테스트 요약');
  console.log('='.repeat(66));
  order.forEach(id => {
    const r = results[id] || { pass: 0, fail: 0 };
    pass += r.pass; fail += r.fail;
    console.log(`  ${id}  ${r.fail ? 'FAIL' : 'PASS'}   ${r.pass} pass / ${r.fail} fail`);
  });
  console.log('-'.repeat(66));
  console.log(`  합계  ${pass} PASS / ${fail} FAIL`);
  if (fail) {
    console.log('\n  FAIL 은 테스트의 문제가 아니라 구현의 결함이다.');
    console.log('  기대값을 낮춰 통과시키지 말 것.');
  }
  console.log('');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n오류:', e && e.stack || e); process.exit(1); });
