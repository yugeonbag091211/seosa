'use strict';
/*
 * 실시간 공급원 확인 — 운영 전역 호출 제한기만 쓰고 나머지 DB 쓰기는 0 (2026-11-16, 소유자 승인 후 1회).
 *
 *   NEON_DATABASE_URL=<운영 연결 문자열, 출력 금지> \
 *   node scripts/search-eval/live-capture.js --env <.env.local> --out <captured.json> [--ids R002,R006] [--delay 8000]
 *
 * 왜 이렇게 하나
 * - 공급원 키는 운영 사용자와 같이 쓴다. 전역 제한기(coupang_acquire_v2 · adpick_acquire)를 거치지 않은
 *   호출은 운영 검색의 분당 한도를 몰래 깎는다 — 그래서 제한기는 우회하지 않는다. 제한기는 DB 쓰기다.
 * - 그 밖의 쓰기는 api/_supabase.js 의 읽기 전용 가드(SEOSA_DB_READONLY=1)가 막는다. 허용 RPC 는
 *   SEOSA_DB_READONLY_RPC 에 적은 제한기 함수 넷뿐이다(acquire · finish · block_seconds).
 * - 검색 캐시 두 표(coupang_search_cache · adpick_search_cache)는 이 스크립트가 가로챈다:
 *   읽기는 «없음» 으로 돌려 실제 호출을 하게 하고, 쓰기(upsert)는 DB 로 보내지 않고 내용만 기록한다.
 *   그 기록이 run-search-eval.js --replay 가 읽는 운영 캐시 행 모양({keyword, items, req_limit, fetched_at}) 그대로다.
 * - 질의마다 searchAll 을 한 번(쿠팡 1 + ADPICK 1). 간격 기본 8초(ADPICK 분당 10회 아래).
 * - 결과 파일은 공급원 데이터라 저장소에 넣지 않는다(ADPICK 이용 조건). 키·연결 문자열은 출력에서 가린다.
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const ROOT = path.resolve(__dirname, '..', '..');
const ENV = arg('--env');
const OUT = arg('--out');
const IDS = arg('--ids', 'R002,R006,R017,R024,R036,R042,R047,R054,R063,R070,R080,R084').split(',');
const DELAY = Number(arg('--delay', 8000));
// 제한기가 ADPICK 만 거부한 질의를 다시 부를 때 — 쿠팡 호출을 더하지 않는다.
// ADPICK 은 인스턴스당 분당 3회(_adpicklimit)라 이 모드에서는 간격을 25초 이상으로 둔다.
const ADPICK_ONLY = argv.includes('--adpick-only');
const LIMITER_RPC = ['coupang_acquire_v2', 'coupang_finish', 'coupang_block_seconds', 'adpick_acquire'];

if (!ENV || !OUT) throw new Error('--env 와 --out 이 필요합니다');
if (!process.env.NEON_DATABASE_URL) throw new Error('NEON_DATABASE_URL(환경변수)이 필요합니다 — 운영 제한기를 거쳐야 합니다');
if (IDS.length > 12) throw new Error('승인 범위는 공급원별 12회 이하입니다');

const parsed = require('dotenv').parse(fs.readFileSync(ENV));
for (const k of ['ADPICK_API_KEY', 'COUPANG_ACCESS_KEY', 'COUPANG_SECRET_KEY']) {
  if (!parsed[k]) throw new Error(`${k} 없음`);
  process.env[k] = parsed[k];
}
Object.assign(process.env, {
  SEOSA_DB_BACKEND: 'neon', SEOSA_NEON_EXPERIMENTAL: '1',
  SEOSA_DB_READONLY: '1', SEOSA_DB_READONLY_RPC: LIMITER_RPC.join(',')
});
for (const k of ['VERCEL_ENV', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'OPENAI_API_KEY',
  'ADPICK_GLOBAL_LIMIT', 'COUPANG_DISABLE_GLOBAL_GATE', 'COUPANG_API_HOST', 'ADPICK_API_HOST']) delete process.env[k];

// 출력에서 비밀 값을 가린다 (오류 문구에 요청 주소가 실릴 수 있다)
const SECRETS = ['ADPICK_API_KEY', 'COUPANG_ACCESS_KEY', 'COUPANG_SECRET_KEY', 'NEON_DATABASE_URL']
  .map(k => process.env[k]).filter(v => v && v.length >= 6);
const redact = s => SECRETS.reduce((t, v) => t.split(v).join('***'), String(s));
for (const m of ['log', 'warn', 'error']) {
  const real = console[m].bind(console);
  console[m] = (...a) => real(...a.map(x => redact(typeof x === 'string' ? x : (x && x.stack) || JSON.stringify(x))));
}

/* ── 검색 캐시 가로채기 ─────────────────────────────────────────── */
const supaPath = path.join(ROOT, 'api', '_supabase.js');
const realSupa = require(supaPath);
const CACHE_TABLES = new Set(['coupang_search_cache', 'adpick_search_cache']);
const captured = { coupang_search_cache: [], adpick_search_cache: [] };
const counts = { cacheReadsAsMiss: 0, cacheWritesCaptured: 0 };
function cacheBuilder(table) {
  const miss = () => { counts.cacheReadsAsMiss++; return Promise.resolve({ data: null, error: null }); };
  const record = row => {
    (Array.isArray(row) ? row : [row]).forEach(r => captured[table].push(JSON.parse(JSON.stringify(r))));
    counts.cacheWritesCaptured++;
    return Promise.resolve({ data: null, error: null });   // DB 로 보내지 않는다
  };
  const b = {};
  ['select', 'eq', 'in', 'order', 'limit', 'gte', 'lte', 'neq', 'is', 'range'].forEach(m => { b[m] = () => b; });
  b.maybeSingle = miss; b.single = miss;
  b.then = (res, rej) => { counts.cacheReadsAsMiss++; return Promise.resolve({ data: [], error: null }).then(res, rej); };
  b.upsert = record; b.insert = record;
  b.update = () => Promise.resolve({ data: null, error: null });
  b.delete = () => Promise.resolve({ data: null, error: null });
  return b;
}
const wrappedSupa = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'then') return undefined;
    if (prop === 'from') return t => (CACHE_TABLES.has(String(t)) ? cacheBuilder(String(t)) : realSupa.from(t));
    return realSupa[prop];
  }
});
const apiDir = path.join(ROOT, 'api');
const realLoad = Module._load;
Module._load = function (request, parent) {
  if ((request === './_supabase' || request === './_supabase.js') && parent && path.dirname(parent.filename) === apiDir) return wrappedSupa;
  return realLoad.apply(this, arguments);
};

const shop = require(path.join(apiDir, '_shop'));
const questions = require('./questions-replay').filter(q => IDS.includes(q.id));
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const log = [];
  for (const [i, q] of questions.entries()) {
    if (i) await sleep(ADPICK_ONLY ? Math.max(DELAY, 25000) : DELAY);
    const t0 = Date.now();
    // api/search.js 와 같은 인자
    let r;
    if (ADPICK_ONLY) {
      const a = await shop.fetchAdpick(q.cacheKey, 20, { source: 'search' });
      r = { items: a.items || [], errors: a.error ? [a.error] : [], providerSources: { coupang: 'skipped', adpick: a.from || 'none' },
        providerBlocked: { coupang: false, adpick: !!a.blocked } };
    } else {
      r = await shop.searchAll(q.cacheKey, {
        coupangLimit: 10, adpickLimit: 20,
        coupangOpts: { source: 'search', maxWaitMs: 1500 }, adpickOpts: { source: 'search' }
      });
    }
    const entry = {
      id: q.id, q: q.cacheKey, ms: Date.now() - t0, sources: r.providerSources, blocked: r.providerBlocked,
      shownAfterOneTokenRule: { coupang: (r.items || []).filter(x => x.mall === '쿠팡').length, adpick: (r.items || []).filter(x => x.mall !== '쿠팡').length },
      errors: (r.errors || []).map(e => redact(e).slice(0, 120))
    };
    log.push(entry);
    console.log(JSON.stringify(entry));
  }
  await sleep(2500);   // coupang_finish 같은 마무리 기록이 끝나게
  const guard = realSupa.__readOnlyGuard;
  const out = {
    capturedAt: new Date().toISOString(),
    coupang: { rows: captured.coupang_search_cache }, adpick: { rows: captured.adpick_search_cache },
    log, guard: { blockedWrites: guard.blockedWrites, blockedRpc: guard.blockedRpc, allowedLimiterRpc: guard.allowedRpc }, counts
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  const live = s => log.filter(x => x.sources && x.sources[s] === 'api').length;
  console.log(`LIVE_CAPTURE queries=${log.length} coupang_live=${live('coupang')} adpick_live=${live('adpick')} `
    + `captured_rows coupang=${captured.coupang_search_cache.length} adpick=${captured.adpick_search_cache.length} `
    + `limiter_rpc=${guard.allowedRpc} blocked_writes=${guard.blockedWrites} blocked_rpc=${guard.blockedRpc}`);
  if (!guard.allowedRpc) { console.error('LIVE_CAPTURE_FAIL 전역 제한기를 한 번도 거치지 않았다'); process.exitCode = 1; }
  process.exit();
})().catch(e => { console.error('LIVE_CAPTURE_FAIL', redact(e.message)); process.exit(1); });
