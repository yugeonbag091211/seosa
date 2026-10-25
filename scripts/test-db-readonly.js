/*
 * 읽기 전용 DB 가드 — 격리 검증 환경 (api/_supabase.js 읽기 전용 모드 주석, 2026-10-23 감사 CO-10).
 *
 * 여기서 확인하는 것:
 *   1. SEOSA_DB_READONLY=1 이면 insert·upsert·update·delete 가 모두 막힌다 (조용히 넘기지 않는다).
 *   2. select·체이닝 읽기는 그대로 통과한다.
 *   3. rpc 는 기본 차단이고 SEOSA_DB_READONLY_RPC 에 적은 함수만 통과한다.
 *   4. Production 에서는 켜지지 않는다 (운영 쓰기를 멈추지 않게).
 *   5. 플래그가 없으면 아무것도 바뀌지 않는다 (지금까지와 똑같다).
 *   6. _shop.saveProducts 는 읽기 전용 환경에서 원장에 쓰지 않고 돌아온다.
 *
 * 진짜 Supabase 에 붙지 않는다 — @supabase/supabase-js 의 createClient 를 가짜로 바꿔 끼운다.
 * 외부 호출 0회, DB 연결 0회.
 */
'use strict';

const path = require('path');
const Module = require('module');

/* ── 가짜 supabase-js ─────────────────────────────────────────────── */
const calls = [];
function fakeBuilder(table) {
  const b = {};
  ['select', 'eq', 'in', 'gte', 'lte', 'order', 'limit'].forEach(m => {
    b[m] = () => { calls.push(`${table}.${m}`); return b; };
  });
  ['insert', 'upsert', 'update', 'delete'].forEach(m => {
    b[m] = () => { calls.push(`${table}.${m}`); return b; };
  });
  b.then = (resolve) => Promise.resolve({ data: [], error: null }).then(resolve);
  return b;
}
const fakeClient = {
  from: table => fakeBuilder(String(table)),
  rpc: (name) => { calls.push(`rpc:${name}`); return Promise.resolve({ data: [], error: null }); }
};
const realLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === '@supabase/supabase-js') return { createClient: () => fakeClient };
  return realLoad.apply(this, arguments);
};

process.env.SUPABASE_URL = 'https://offline.example.invalid';
process.env.SUPABASE_SECRET_KEY = 'offline-key';
delete process.env.SEOSA_DB_BACKEND;
delete process.env.VERCEL_ENV;

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); return; }
  fails.push(name);
  console.log(`  [FAIL] ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
}
function section(t) { console.log(`\n── ${t}`); }

/** 모듈 캐시를 비워 플래그를 바꿔 끼운다 (클라이언트가 한 번만 만들어지므로). */
function freshSupabase(env) {
  Object.keys(env).forEach(k => { if (env[k] === null) delete process.env[k]; else process.env[k] = env[k]; });
  delete require.cache[path.resolve(__dirname, '..', 'api', '_supabase.js')];
  return require('../api/_supabase');
}
function threw(fn) {
  try { fn(); return null; } catch (e) { return e; }
}

/* ================================================================== */
section('A. 쓰기는 막는다');
{
  const db = freshSupabase({ SEOSA_DB_READONLY: '1', SEOSA_DB_READONLY_RPC: null });
  ['insert', 'upsert', 'update', 'delete'].forEach(m => {
    const e = threw(() => db.from('price_history')[m]({ a: 1 }));
    ok(!!e && e.readOnlyBlocked === true && /읽기 전용/.test(e.message), `${m} 은 예외로 막힌다`, e && e.message);
  });
  const e2 = threw(() => db.from('products').select('*').eq('id', 1).upsert({ a: 1 }));
  ok(!!e2 && e2.readOnlyBlocked === true, '체이닝 뒤의 쓰기도 막는다 (select().eq().upsert())', e2 && e2.message);
  ok(db.__readOnlyGuard.enabled === true && db.__readOnlyGuard.blockedWrites === 5,
    '막은 쓰기 수를 센다 (삼켜도 검증이 알 수 있다)', db.__readOnlyGuard);
  ok(!calls.some(c => /\.(insert|upsert|update|delete)$/.test(c)),
    '가짜 클라이언트에는 쓰기 호출이 하나도 닿지 않았다', calls);
}

/* ================================================================== */
section('B. 읽기는 통과한다');
{
  const db = freshSupabase({ SEOSA_DB_READONLY: '1' });
  calls.length = 0;
  const q = db.from('products').select('id,title').eq('id', 1).order('id').limit(5);
  ok(typeof q.then === 'function', '질의 빌더는 그대로 쓸 수 있다 (thenable)');
  ok(calls.join() === 'products.select,products.eq,products.order,products.limit',
    '읽기 체이닝이 실제 클라이언트에 그대로 전달된다', calls.join());
}

/* ================================================================== */
section('C. rpc — 기본 차단, 허용 목록만 통과');
{
  const db = freshSupabase({ SEOSA_DB_READONLY: '1', SEOSA_DB_READONLY_RPC: 'price_history_prior_obs, coverage_summary' });
  const e = threw(() => db.rpc('collector_target_products', {}));
  ok(!!e && e.readOnlyBlocked === true && /SEOSA_DB_READONLY_RPC/.test(e.message),
    '허용 목록에 없는 rpc 는 막고 무엇을 해야 하는지 알린다', e && e.message);
  calls.length = 0;
  db.rpc('price_history_prior_obs', {});
  db.rpc('coverage_summary', {});
  ok(calls.join() === 'rpc:price_history_prior_obs,rpc:coverage_summary', '허용한 rpc 는 통과한다', calls.join());
  ok(db.__readOnlyGuard.blockedRpc === 1 && db.__readOnlyGuard.allowedRpc === 2, 'rpc 도 센다', db.__readOnlyGuard);
}

/* ================================================================== */
section('D. Production 에서는 켜지지 않는다');
{
  const db = freshSupabase({ SEOSA_DB_READONLY: '1', VERCEL_ENV: 'production' });
  const e = threw(() => db.from('products'));
  ok(!!e && /Production 에서 쓸 수 없습니다/.test(e.message),
    'Production + 읽기 전용은 분명한 오류로 거절한다 (운영 쓰기를 조용히 멈추지 않는다)', e && e.message);
}

/* ================================================================== */
section('E. 플래그가 없으면 아무것도 바뀌지 않는다');
{
  const db = freshSupabase({ SEOSA_DB_READONLY: null, VERCEL_ENV: null });
  calls.length = 0;
  db.from('price_history').upsert({ a: 1 });
  ok(calls.join() === 'price_history.upsert', '기본값에서는 쓰기가 그대로 간다', calls.join());
  ok(db.__readOnlyGuard.enabled === false, '가드는 꺼져 있다', db.__readOnlyGuard);
}

/* ================================================================== */
section('F. _shop.saveProducts — 읽기 전용에서는 원장에 쓰지 않는다');
(async () => {
  process.env.SEOSA_DB_READONLY = '1';
  delete process.env.VERCEL_ENV;
  const shop = require('../api/_shop');
  const r = await shop.saveProducts('노트북', [{ productId: 1, mall: 'coupang', title: '노트북', lprice: 100000, _source: 'api' }], { from: 'api' });
  ok(r && r.readOnly === true && r.saved === 0, '저장을 건너뛰고 그 사실을 알린다', r);

  console.log(`\n=== 결과: ${pass}/${pass + fails.length} PASS ===`);
  if (fails.length) {
    console.log('\n실패:');
    fails.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
})();
