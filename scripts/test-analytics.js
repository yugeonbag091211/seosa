#!/usr/bin/env node
/*
 * 최소 사용자 계측 테스트.
 *
 *   node scripts/test-analytics.js
 *
 * ── 안전성 ───────────────────────────────────────────────────────────
 * 운영 Supabase 접근 0회 / 외부 호출 0회. require 캐시에 가짜 Supabase 를
 * 심어 대체한다 (scripts/test-release.js 와 같은 방식).
 *
 * ── 무엇을 고정하는가 ────────────────────────────────────────────────
 * 계측은 "틀려도 조용한" 코드다. 숫자가 조금 어긋나도 화면에는 아무 일도
 * 일어나지 않으므로, 잘못된 채로 몇 달이 지나기 쉽다. 그래서 여기서는
 * 값이 맞는지보다 다음 두 가지를 더 강하게 본다.
 *
 *   1. 계측이 서비스를 막지 않는가   (실패해도 검색·클릭이 정상 동작)
 *   2. 개인정보가 섞이지 않는가      (이메일·IP·UA 를 저장하지 않는다)
 */
'use strict';

const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');

process.env.CRON_SECRET = 'test-cron-secret';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;

/* ------------------------------------------------------------------ *
 *  가짜 Supabase
 * ------------------------------------------------------------------ */
const db = { visitors: [], daily_metrics: [], ai_usage: [] };
const rpcLog = [];
let rpcMissing = false;      // true 면 마이그레이션 미적용 환경을 흉내 낸다
let rpcError = '';           // 그 밖의 오류를 흉내 낼 때

function resetDb() {
  db.visitors = []; db.daily_metrics = []; db.ai_usage = [];
  rpcLog.length = 0; rpcMissing = false; rpcError = '';
}

function makeQuery(table) {
  const filters = [];
  let headMode = false, wantCount = false, rangeArgs = null, limitN = null;
  const q = {
    select(_cols, opts) {
      if (opts && opts.head) headMode = true;
      if (opts && opts.count) wantCount = true;
      return q;
    },
    eq(col, val)  { filters.push(r => String(r[col]) === String(val)); return q; },
    gt(col, val)  { filters.push(r => Number(r[col]) > Number(val)); return q; },
    order()       { return q; },
    limit(n)      { limitN = n; return q; },
    range(a, b)   { rangeArgs = [a, b]; return q; },
    then(resolve) {
      let rows = (db[table] || []).filter(r => filters.every(f => f(r)));
      const count = rows.length;
      if (rangeArgs) rows = rows.slice(rangeArgs[0], rangeArgs[1] + 1);
      else if (limitN != null) rows = rows.slice(0, limitN);
      return Promise.resolve(resolve(
        headMode ? { data: null, count: wantCount ? count : null, error: null }
                 : { data: rows, count: wantCount ? count : null, error: null }
      ));
    }
  };
  return q;
}

const fakeSupabase = {
  from(table) { return makeQuery(table); },

  async rpc(name, args) {
    rpcLog.push({ name, args });
    if (rpcMissing) {
      return { data: null, error: { message: `Could not find the function public.${name} in the schema cache` } };
    }
    if (rpcError) return { data: null, error: { message: rpcError } };

    if (name === 'track_visit') {
      const { p_vid, p_date } = args;
      const row = db.visitors.find(v => v.visitor_id === p_vid);
      if (!row) {
        db.visitors.push({ visitor_id: p_vid, first_date: p_date, last_date: p_date, visit_days: 1 });
      } else {
        // 실제 SQL 의 CASE 와 같은 규칙: 날짜가 넘어갔을 때만 늘린다.
        if (row.last_date < p_date) { row.visit_days += 1; row.last_date = p_date; }
      }
      return { data: null, error: null };
    }
    if (name === 'bump_metric') {
      const { p_metric, p_date } = args;
      const row = db.daily_metrics.find(m => m.metric === p_metric && m.metric_date === p_date);
      if (row) row.count += 1;
      else db.daily_metrics.push({ metric_date: p_date, metric: p_metric, count: 1 });
      return { data: null, error: null };
    }
    if (name === 'increment_search_stat') return { data: null, error: null };
    return { data: null, error: { message: 'unknown rpc ' + name } };
  }
};

/* require 캐시에 가짜를 심는다 (진짜 _supabase.js 는 로드되지 않는다). */
function stub(rel, exports) {
  const full = require.resolve(path.join(ROOT, rel));
  const m = new Module(full, null);
  m.filename = full; m.loaded = true; m.exports = exports;
  require.cache[full] = m;
}
stub('api/_supabase.js', fakeSupabase);

const analytics = require(path.join(ROOT, 'api/_analytics.js'));
const statsHandler = require(path.join(ROOT, 'api/stats.js'));

/* ------------------------------------------------------------------ *
 *  테스트 러너
 * ------------------------------------------------------------------ */
let pass = 0, fail = 0;
const groups = [];
function group(name) { groups.push({ name, pass: 0, fail: 0 }); console.log(`\n${'─'.repeat(66)}\n${name}\n${'─'.repeat(66)}`); }
function ok(cond, label, detail) {
  const g = groups[groups.length - 1];
  if (cond) { pass++; g.pass++; console.log(`  PASS  ${label}${detail ? '  — ' + detail : ''}`); }
  else { fail++; g.fail++; console.log(`  FAIL  ${label}${detail ? '  — ' + detail : ''}`); }
}

/** 최소한의 가짜 res. 실제 핸들러가 쓰는 것만 흉내 낸다. */
function makeRes() {
  const res = {
    statusCode: 200, body: null, headers: {},
    status(c) { res.statusCode = c; return res; },
    json(b) { res.body = b; return res; },
    setHeader(k, v) { res.headers[k] = v; },
    end() { return res; }
  };
  return res;
}
function makeReq(query, headers) {
  return { method: 'GET', url: '/api/stats', query: query || {}, headers: headers || {}, socket: { remoteAddress: '1.2.3.4' } };
}

const TODAY = '2026-08-25';
const TOMORROW = '2026-08-26';

/* ══════════════════════════════════════════════════════════════════ */
group('A — 방문자 집계');
(async () => {
  resetDb(); analytics._reset();

  await analytics.trackVisit('vabc12345', TODAY);
  ok(db.visitors.length === 1, '첫 방문이 기록된다', `${db.visitors.length}행`);
  ok(db.visitors[0].visit_days === 1, 'visit_days = 1');

  // 같은 날 다섯 번 더
  for (let i = 0; i < 5; i++) await analytics.trackVisit('vabc12345', TODAY);
  ok(db.visitors.length === 1, '같은 방문자가 행을 늘리지 않는다', `${db.visitors.length}행`);
  ok(db.visitors[0].visit_days === 1,
    '★ 같은 날 새로고침은 재방문이 아니다', `visit_days=${db.visitors[0].visit_days}`);

  // 다음 날
  await analytics.trackVisit('vabc12345', TOMORROW);
  ok(db.visitors[0].visit_days === 2, '★ 다른 날 재방문은 센다', `visit_days=${db.visitors[0].visit_days}`);
  ok(db.visitors[0].first_date === TODAY, 'first_date 는 그대로', db.visitors[0].first_date);

  // 다른 방문자
  await analytics.trackVisit('vxyz98765', TOMORROW);
  ok(db.visitors.length === 2, '다른 방문자는 새 행', `${db.visitors.length}행`);

  /* ── 개인정보 ─────────────────────────────────────────────── */
  const cols = Object.keys(db.visitors[0]).join(',');
  ok(!/email|ip|user_agent|ua\b/i.test(cols), '★ 방문자 행에 개인정보 컬럼이 없다', cols);
  const dump = JSON.stringify(db.visitors);
  ok(!/@/.test(dump), '★ 저장된 값에 이메일이 없다');
  ok(!/1\.2\.3\.4/.test(dump), '★ 저장된 값에 IP 가 없다');

  /* ── vid 검증 ─────────────────────────────────────────────── */
  resetDb();
  const bad = ['', '   ', 'ab', 'x'.repeat(65), '<script>', "'; drop table visitors;--", 'v abc12345'];
  let rejected = 0;
  for (const b of bad) { const r = await analytics.trackVisit(b, TODAY); if (!r.ok) rejected++; }
  ok(rejected === bad.length, '★ 이상한 visitorId 는 전부 거절한다', `${rejected}/${bad.length}`);
  ok(db.visitors.length === 0, '거절된 값은 저장되지 않는다', `${db.visitors.length}행`);

  /* ══════════════════════════════════════════════════════════ */
  group('B — 카운터 (검색 / 클릭)');
  resetDb(); analytics._reset();

  await analytics.bump('search', TODAY);
  await analytics.bump('search', TODAY);
  await analytics.bump('click', TODAY);
  const s = db.daily_metrics.find(m => m.metric === 'search');
  const c = db.daily_metrics.find(m => m.metric === 'click');
  ok(s && s.count === 2, 'search 2회', s ? String(s.count) : 'none');
  ok(c && c.count === 1, 'click 1회', c ? String(c.count) : 'none');
  ok(db.daily_metrics.length === 2, '날짜·종류당 한 행으로 접힌다', `${db.daily_metrics.length}행`);

  await analytics.bump('search', TOMORROW);
  ok(db.daily_metrics.length === 3, '날짜가 바뀌면 새 행', `${db.daily_metrics.length}행`);

  /* ── 화이트리스트 ─────────────────────────────────────────── */
  const before = db.daily_metrics.length;
  const junk = ['', 'hack', 'DROP TABLE', 'visit', '../../etc', 'search; delete'];
  let blocked = 0;
  for (const j of junk) { const r = await analytics.bump(j, TODAY); if (!r.ok) blocked++; }
  ok(blocked === junk.length, '★ 화이트리스트 밖 metric 은 전부 거절', `${blocked}/${junk.length}`);
  ok(db.daily_metrics.length === before, '거절된 metric 은 테이블을 늘리지 않는다');

  /* ══════════════════════════════════════════════════════════ */
  group('C — 마이그레이션 미적용 구간 (조용히 틀리지 않는가)');
  resetDb(); analytics._reset();
  rpcMissing = true;

  const v = await analytics.trackVisit('vabc12345', TODAY);
  const b = await analytics.bump('search', TODAY);
  ok(!v.ok && v.reason === 'disabled', 'RPC 가 없으면 계측을 끈다', v.reason);
  ok(!b.ok, '카운터도 끈다', b.reason);
  ok(analytics.isEnabled() === false, '한 번 확인하면 상태로 남는다');

  const callsAfterDisable = rpcLog.length;
  await analytics.trackVisit('vabc12345', TODAY);
  await analytics.bump('search', TODAY);
  ok(rpcLog.length === callsAfterDisable,
    '★ 끈 뒤에는 RPC 를 다시 부르지 않는다 (매 요청 실패로 지연 쌓지 않기)',
    `${rpcLog.length}회`);

  /* ── 그 밖의 오류는 끄지 않는다 ───────────────────────────── */
  resetDb(); analytics._reset();
  rpcError = 'connection reset';
  const e1 = await analytics.bump('search', TODAY);
  ok(!e1.ok && e1.reason === 'connection reset', '일시 오류는 그대로 보고한다', e1.reason);
  ok(analytics.isEnabled() === true,
    '★ 일시 오류로는 계측을 끄지 않는다 (없는 것과 고장난 것은 다르다)');

  /* ── 절대 throw 하지 않는다 ───────────────────────────────── */
  resetDb(); analytics._reset();
  let threw = false;
  try {
    await analytics.trackVisit(null);
    await analytics.bump(undefined);
    await analytics.trackVisit({ toString() { throw new Error('boom'); } });
  } catch (e) { threw = true; }
  ok(!threw, '★ 어떤 입력에도 throw 하지 않는다 (계측이 서비스를 막지 않는다)');

  /* ══════════════════════════════════════════════════════════ */
  group('D — /api/stats 엔드포인트');
  resetDb(); analytics._reset();

  // 방문
  let res = makeRes();
  await statsHandler(makeReq({ event: 'visit', vid: 'vabc12345' }), res);
  ok(res.statusCode === 200, 'event=visit → 200', String(res.statusCode));
  ok(db.visitors.length === 1, '방문이 기록된다');

  // 클릭
  res = makeRes();
  await statsHandler(makeReq({ event: 'click' }), res);
  ok(res.statusCode === 200 && res.body.counted === true, 'event=click → 200 counted', JSON.stringify(res.body));

  // 검색어 집계가 검색 카운터도 올린다 (프론트 요청 추가 없음)
  resetDb();
  res = makeRes();
  await statsHandler(makeReq({ keyword: '마우스' }), res);
  const sm = db.daily_metrics.find(m => m.metric === 'search');
  ok(res.statusCode === 200, '기존 keyword 집계는 그대로 200', String(res.statusCode));
  ok(sm && sm.count === 1, '★ 같은 요청에서 검색 횟수도 센다 (요청 추가 없음)', sm ? String(sm.count) : 'none');

  // 알 수 없는 event 는 세지 않되 흐름은 막지 않는다
  res = makeRes();
  await statsHandler(makeReq({ event: 'nonsense' }), res);
  ok(res.statusCode === 200 && res.body.counted === false,
    '★ 모르는 event 는 200 + counted:false (사용자 화면에 오류를 띄우지 않는다)',
    JSON.stringify(res.body));

  // 기존 계약 유지
  res = makeRes();
  await statsHandler(makeReq({}), res);
  ok(res.statusCode === 400, '키워드도 event 도 없으면 기존대로 400', String(res.statusCode));

  /* ══════════════════════════════════════════════════════════ */
  group('E — 지표 조회는 관리자만');
  resetDb(); analytics._reset();

  res = makeRes();
  await statsHandler(makeReq({ report: '1' }), res);
  ok(res.statusCode === 401, '★ 토큰 없이 지표 조회 → 401', String(res.statusCode));

  res = makeRes();
  await statsHandler(makeReq({ report: '1' }, { authorization: 'Bearer wrong' }), res);
  ok(res.statusCode === 401, '★ 틀린 토큰 → 401', String(res.statusCode));

  res = makeRes();
  await statsHandler(makeReq({ report: '1' }, { authorization: 'Bearer test-cron-secret' }), res);
  ok(res.statusCode === 200, '올바른 토큰 → 200', String(res.statusCode));
  ok(res.body && typeof res.body.visitorsTotal === 'number', '지표가 나온다', JSON.stringify(res.body && res.body.visitorsTotal));

  // CRON_SECRET 미설정이면 열지 않는다 (fail closed)
  const savedSecret = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  res = makeRes();
  await statsHandler(makeReq({ report: '1' }, { authorization: 'Bearer test-cron-secret' }), res);
  ok(res.statusCode === 500, '★ CRON_SECRET 미설정이면 열지 않는다 (fail closed)', String(res.statusCode));
  process.env.CRON_SECRET = savedSecret;

  /* ══════════════════════════════════════════════════════════ */
  group('F — report() 계산');
  resetDb(); analytics._reset();

  db.visitors = [
    { visitor_id: 'a', first_date: '2026-08-20', last_date: TODAY,        visit_days: 4 },
    { visitor_id: 'b', first_date: '2026-08-24', last_date: TODAY,        visit_days: 2 },
    { visitor_id: 'c', first_date: TODAY,        last_date: TODAY,        visit_days: 1 },
    { visitor_id: 'd', first_date: '2026-08-01', last_date: '2026-08-02', visit_days: 1 }
  ];
  db.daily_metrics = [
    { metric_date: TODAY, metric: 'search', count: 17 },
    { metric_date: TODAY, metric: 'click',  count: 5 },
    { metric_date: '2026-08-24', metric: 'search', count: 99 }
  ];
  db.ai_usage = [
    { email: 'x@a.com', usage_date: TODAY, used: 3 },
    { email: 'y@a.com', usage_date: TODAY, used: 2 },
    { email: 'x@a.com', usage_date: '2026-08-24', used: 7 }
  ];

  const rep = await analytics.report(TODAY);
  ok(rep.visitorsTotal === 4, '총 방문자 = 4', String(rep.visitorsTotal));
  ok(rep.visitorsToday === 3, '오늘 방문자 = 3', String(rep.visitorsToday));
  ok(rep.visitorsReturning === 2, '★ 재방문자 = 2 (visit_days > 1)', String(rep.visitorsReturning));
  ok(rep.searchToday === 17, '오늘 검색 = 17 (어제 99 를 섞지 않는다)', String(rep.searchToday));
  ok(rep.clickToday === 5, '오늘 클릭 = 5', String(rep.clickToday));
  ok(rep.aiToday === 5, '★ 오늘 AI = 5 (ai_usage 에서 읽는다, 새로 쌓지 않는다)', String(rep.aiToday));
  ok(rep.aiTotal === 12, '전체 AI = 12', String(rep.aiTotal));
  ok(rep.errors.length === 0, '오류 없음', JSON.stringify(rep.errors));

  const repDump = JSON.stringify(rep);
  ok(!/@/.test(repDump), '★ 지표 응답에 이메일이 새어 나오지 않는다');

  /* ══════════════════════════════════════════════════════════ */
  group('G — 프론트 계측 코드');
  const fs = require('fs');
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

  ok(/var Track = \{/.test(html), 'Track 객체가 있다');
  ok(/Track\.visit\(\)/.test(html), '진입 시 방문을 보낸다');
  ok(/Track\.click\(\)/.test(html), '상품 클릭을 보낸다');
  ok(/keepalive: true/.test(html),
    '★ keepalive 를 쓴다 (새 탭으로 나가면서 취소되지 않게)');
  ok(/CONST\.LS\.VID/.test(html) && !/CONFIG\.LS\.VID/.test(html),
    '★ 실제로 존재하는 설정 객체(CONST)를 참조한다');
  // openLink 안에서만 클릭을 센다 = 링크가 실제로 열릴 때만
  ok(/Track\.click\(\);\s*\n\s*window\.open/.test(html),
    '★ 링크가 실제로 열리는 경우만 클릭으로 센다');
  ok(!/Track[\s\S]{0,400}(navigator\.userAgent|localStorage\.getItem\(CONST\.LS\.EMAIL)/.test(html),
    '★ 계측이 UA·이메일을 읽지 않는다');

  /* ══════════════════════════════════════════════════════════ */
  console.log(`\n${'='.repeat(66)}\n계측 테스트 요약\n${'='.repeat(66)}`);
  groups.forEach(g => {
    console.log(`  ${g.name.split(' ')[0].padEnd(4)} ${g.fail ? 'FAIL' : 'PASS'}   ${g.pass} pass / ${g.fail} fail`);
  });
  console.log('-'.repeat(66));
  console.log(`결과: ${pass} PASS / ${fail} FAIL`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
