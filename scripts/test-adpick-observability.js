#!/usr/bin/env node
/*
 * ADPICK 외부 호출 계측(adpick_api_calls) 회귀 테스트 — 실제 ADPICK 호출 0회.
 *
 *   node scripts/test-adpick-observability.js
 *
 * 가짜 ADPICK 서버를 로컬에 띄우고 ADPICK_API_HOST 로 물린 뒤, 응답 종류마다
 * 몇 행이 기록되는지 고정한다. 운영 Supabase 는 건드리지 않는다 (가짜로 교체).
 *
 * ── 이 테스트가 지키는 불변식 ────────────────────────────────────────
 *   adpick_api_calls 의 1행 = 실제 외부 ADPICK 요청 1회.
 *
 * 2026-09-05 ADPICK 이 429 "사용 횟수를 초과하였습니다" 를 돌려줬을 때 우리는
 * 그날 실제 호출 수를 댈 수 없었다. 그래서 이 계측을 넣었는데, 계측이 캐시
 * 적중이나 서킷 브레이커 사전 차단까지 세어 버리면 숫자가 부풀어서 공급자에게
 * 거짓을 대게 된다. 그건 계측이 없는 것보다 나쁘다. 그래서 "세지 않아야 할
 * 것" 쪽을 더 강하게 고정한다.
 */
'use strict';

const http = require('http');
const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
function check(ok, label, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
}
function section(name) {
  console.log(`\n──────────────────────────────────────────────────────────────`);
  console.log(name);
  console.log(`──────────────────────────────────────────────────────────────`);
}

const API_KEY = 'super-secret-adpick-key-do-not-log';

/* ── 가짜 ADPICK 서버 ─────────────────────────────────────────────── */
let mode = 'ok';
let seenPaths = [];

const server = http.createServer((req, res) => {
  seenPaths.push(req.url);
  const send = (code, body, type) => {
    res.writeHead(code, { 'Content-Type': type || 'application/json' });
    res.end(body);
  };
  if (mode === 'ok') {
    return send(200, JSON.stringify({
      success: true,
      data: [
        { title: '무선 마우스 A', price: '10900', photo: 'p1', cp_code: '1', cp_name: 'SSG', commissionlink: 'https://x/1' },
        { title: '무선 마우스 B', price: '12900', photo: 'p2', cp_code: '1', cp_name: 'SSG', commissionlink: 'https://x/2' }
      ]
    }));
  }
  if (mode === '403') return send(403, '', 'text/plain');
  if (mode === '429') {
    return send(429, JSON.stringify({
      status: 'error', code: 429, error: '사용 횟수를 초과하였습니다. 잠시후 다시 이용해주세요.'
    }));
  }
  if (mode === 'html') return send(200, '<html><body>not json</body></html>', 'text/html');
  if (mode === 'successfalse') {
    return send(200, JSON.stringify({ success: false, message: '검색 결과가 없습니다' }));
  }
  if (mode === 'echokey') {
    // 업스트림이 요청 경로(=API 키 포함)를 본문에 되비추는 최악의 경우.
    return send(500, `Invalid request: ${req.url}`, 'text/plain');
  }
  if (mode === 'hang') return;   // 응답하지 않는다 → 타임아웃
  return send(500, 'boom', 'text/plain');
});

/* ── 가짜 Supabase ────────────────────────────────────────────────── */
const db = { adpick_api_calls: [], adpick_search_cache: [] };
let insertError = null;   // { message } 를 넣으면 insert 가 실패한다

function makeTable(name) {
  const eqs = [];
  const q = {
    select() { return q; },
    eq(c, v) { eqs.push([c, v]); return q; },
    limit() { return q; },
    maybeSingle() {
      const rows = db[name].filter(r => eqs.every(([c, v]) => String(r[c]) === String(v)));
      return Promise.resolve({ data: rows[0] || null, error: null });
    },
    then(res, rej) {
      const rows = db[name].filter(r => eqs.every(([c, v]) => String(r[c]) === String(v)));
      return Promise.resolve({ data: rows, error: null }).then(res, rej);
    },
    insert(row) {
      if (insertError) return Promise.resolve({ data: null, error: insertError });
      db[name].push(Array.isArray(row) ? row[0] : row);
      return Promise.resolve({ data: null, error: null });
    },
    upsert(row) {
      const r = Array.isArray(row) ? row[0] : row;
      const i = db[name].findIndex(x => x.keyword === r.keyword);
      if (i > -1) db[name][i] = { ...db[name][i], ...r }; else db[name].push({ ...r });
      return Promise.resolve({ data: null, error: null });
    }
  };
  return q;
}
const fakeSupabase = { from: makeTable, rpc: () => Promise.resolve({ data: null, error: null }) };

const supabasePath = require.resolve(path.join(__dirname, '..', 'api', '_supabase.js'));
const adpickPath = require.resolve(path.join(__dirname, '..', 'api', '_adpick.js'));

/**
 * _adpick.js 를 매번 새로 읽는다.
 *
 * 서킷 브레이커·분당 카운터·"계측 껐음" 플래그가 전부 모듈 전역이라, 한
 * 테스트의 403(60분 차단)이 다음 테스트를 오염시킨다. 캐시를 지우고 다시
 * 읽으면 각 시나리오가 깨끗한 상태에서 시작한다.
 */
function freshAdpick() {
  require.cache[supabasePath] = Object.assign(new Module(supabasePath, null), {
    filename: supabasePath, loaded: true, exports: fakeSupabase
  });
  delete require.cache[adpickPath];
  return require('../api/_adpick');
}

function resetAll() {
  db.adpick_api_calls = [];
  db.adpick_search_cache = [];
  insertError = null;
  seenPaths = [];
  mode = 'ok';
}

const rows = () => db.adpick_api_calls;

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  process.env.ADPICK_API_KEY = API_KEY;
  process.env.ADPICK_API_HOST = `http://127.0.0.1:${port}`;
  process.env.ADPICK_MIN_GAP_MS = '1';
  process.env.ADPICK_TIMEOUT_MS = '400';

  /* ============================================================== */
  section('[1] 외부 호출이 실제로 일어난 경우 — 응답 종류마다 정확히 1행');

  for (const [m, wantOutcome, wantStatus, wantItems] of [
    ['ok', 'ok', 200, 2],
    ['403', '403', 403, 0],
    ['429', '429', 429, 0],
    ['html', 'invalid_response', 200, 0],
    ['successfalse', 'other', 200, 0]
  ]) {
    resetAll();
    mode = m;
    const { searchAdpick } = freshAdpick();
    await searchAdpick('무선 마우스', { limit: 5, source: 'collect' });

    check(rows().length === 1, `${m} → 정확히 1행`, `${rows().length}행`);
    const r = rows()[0] || {};
    check(r.outcome === wantOutcome, `${m} → outcome='${wantOutcome}'`, String(r.outcome));
    check(r.http_status === wantStatus, `${m} → http_status=${wantStatus}`, String(r.http_status));
    check(r.items === wantItems, `${m} → items=${wantItems}`, String(r.items));
    check(r.external_call === true, `${m} → external_call=true`);
    check(r.operation === 'search', `${m} → operation='search'`);
    check(r.source === 'collect', `${m} → source 가 호출자 그대로`, String(r.source));
    check(typeof r.latency_ms === 'number' && r.latency_ms >= 0, `${m} → latency_ms 기록`, String(r.latency_ms));
  }

  /* ============================================================== */
  section('[2] 타임아웃 — 응답이 없어도 반드시 1행');

  {
    resetAll();
    mode = 'hang';
    const { searchAdpick } = freshAdpick();
    await searchAdpick('무선 마우스', { limit: 5, source: 'collect' });

    check(rows().length === 1, 'timeout → 정확히 1행', `${rows().length}행`);
    const r = rows()[0] || {};
    check(r.outcome === 'timeout', "timeout → outcome='timeout'", String(r.outcome));
    check(r.http_status === 0, 'timeout → http_status=0 (응답 없음)', String(r.http_status));
    check(/시간 초과/.test(r.detail || ''), 'timeout → detail 에 사유가 남는다', String(r.detail).slice(0, 40));
  }

  /* ============================================================== */
  section('[3] ★ 외부 호출이 없었던 경로 — 0행이어야 한다');

  {
    // 캐시 적중: TTL 안쪽 캐시가 있으면 네트워크를 타지 않는다.
    resetAll();
    db.adpick_search_cache.push({
      keyword: '무선 마우스', items: [{ title: 'x' }], req_limit: 20,
      fetched_at: new Date().toISOString()
    });
    const { searchAdpick } = freshAdpick();
    const r = await searchAdpick('무선 마우스', { limit: 5, source: 'collect' });

    check(r.from === 'cache', '캐시 적중으로 응답', String(r.from));
    check(rows().length === 0, '★ 캐시 적중 → 계측 0행', `${rows().length}행`);
    check(seenPaths.length === 0, '★ 캐시 적중 → 외부 요청 0회', `${seenPaths.length}회`);
  }

  {
    // 서킷 브레이커 사전 차단: 403 으로 브레이커를 연 뒤 두 번째 호출.
    resetAll();
    mode = '403';
    const { searchAdpick, isBlocked } = freshAdpick();
    await searchAdpick('첫 번째', { limit: 5, source: 'collect' });
    const afterFirst = rows().length;
    const pathsAfterFirst = seenPaths.length;

    check(isBlocked(), '403 이후 서킷 브레이커가 열렸다');
    const r2 = await searchAdpick('두 번째', { limit: 5, source: 'collect' });

    check(r2.blocked === true, '두 번째 호출은 네트워크 전에 차단됐다');
    check(seenPaths.length === pathsAfterFirst,
      '★ 사전 차단 → 외부 요청이 늘지 않는다', `${pathsAfterFirst} → ${seenPaths.length}`);
    check(rows().length === afterFirst,
      '★ 사전 차단 → 계측이 늘지 않는다 (403 1행 그대로)', `${afterFirst} → ${rows().length}`);
  }

  {
    // 키가 없으면 네트워크 이전에 끝난다.
    resetAll();
    const saved = process.env.ADPICK_API_KEY;
    delete process.env.ADPICK_API_KEY;
    const { searchAdpick } = freshAdpick();
    await searchAdpick('무선 마우스', { limit: 5, source: 'collect' });
    process.env.ADPICK_API_KEY = saved;

    check(rows().length === 0, '★ API 키 없음 → 계측 0행', `${rows().length}행`);
    check(seenPaths.length === 0, '★ API 키 없음 → 외부 요청 0회', `${seenPaths.length}회`);
  }

  /* ============================================================== */
  section('[4] 이중 기록 없음');

  {
    resetAll();
    mode = 'ok';
    const { searchAdpick } = freshAdpick();
    await searchAdpick('A', { limit: 5, source: 'collect' });
    await searchAdpick('B', { limit: 5, source: 'collect' });
    await searchAdpick('C', { limit: 5, source: 'collect' });

    check(seenPaths.length === 3, '외부 요청 3회', `${seenPaths.length}회`);
    check(rows().length === 3, '★ 계측 3행 (요청 1회 = 1행)', `${rows().length}행`);
    const qs = rows().map(r => r.query);
    check(JSON.stringify(qs) === JSON.stringify(['A', 'B', 'C']),
      '★ 행이 요청과 1:1 로 대응한다', qs.join(','));
  }

  /* ============================================================== */
  section('[5] ★ API 키가 어떤 컬럼에도 남지 않는다');

  {
    resetAll();
    mode = 'echokey';   // 업스트림이 요청 경로를 본문에 되비춘다
    const { searchAdpick } = freshAdpick();
    await searchAdpick('무선 마우스', { limit: 5, source: 'collect' });

    check(rows().length === 1, 'echokey → 1행', `${rows().length}행`);
    const dump = JSON.stringify(rows());
    check(dump.indexOf(API_KEY) === -1, '★ 기록 어디에도 API 키가 없다');
    check(dump.indexOf('***') > -1, '키 자리는 마스킹되고 진단 정보는 남는다');
    const r = rows()[0] || {};
    check(!/\/api\/[^/]+\/search/.test(String(r.query || '')), 'query 에 URL 을 넣지 않는다', String(r.query));
  }

  /* ============================================================== */
  section('[6] KST 기준일');

  {
    resetAll();
    mode = 'ok';
    const { searchAdpick } = freshAdpick();
    await searchAdpick('무선 마우스', { limit: 5, source: 'collect' });
    const r = rows()[0] || {};
    const expect = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    check(r.kst_date === expect, 'kst_date 가 Asia/Seoul 기준 오늘', `${r.kst_date} (기대 ${expect})`);
    check(/^\d{4}-\d{2}-\d{2}$/.test(String(r.kst_date)), 'kst_date 형식이 date');
  }

  /* ============================================================== */
  section('[7] 계측이 실패해도 수집은 계속된다');

  {
    resetAll();
    mode = 'ok';
    insertError = { message: "Could not find the table 'public.adpick_api_calls' in the schema cache" };
    const { searchAdpick } = freshAdpick();
    const r1 = await searchAdpick('A', { limit: 5, source: 'collect' });

    check(r1.from === 'api' && r1.items.length === 2,
      '테이블이 없어도 검색 결과는 정상으로 돌아온다', `from=${r1.from} items=${r1.items.length}`);
    check(rows().length === 0, '기록은 남지 않는다 (테이블 없음)', `${rows().length}행`);

    // 두 번째부터는 계측 자체를 끄고 조용히 지나간다 (매 호출 경고 금지).
    insertError = null;
    const r2 = await searchAdpick('B', { limit: 5, source: 'collect' });
    check(r2.from === 'api', '이후 호출도 정상', String(r2.from));
    check(rows().length === 0, '한 번 끈 계측은 그 프로세스에서 다시 켜지 않는다', `${rows().length}행`);
  }

  server.close();
  console.log(`\n결과: PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('테스트 실패:', e); server.close(); process.exit(1); });
