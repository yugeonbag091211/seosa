#!/usr/bin/env node
/*
 * 수집기 동시 실행 방지(잠금) 테스트 — 외부 호출 0회 / 운영 DB 접근 0회.
 *
 *   node scripts/test-collector-lock.js
 *
 * ── 왜 이 파일이 있는가 ─────────────────────────────────────────
 *
 * GitHub Actions 는 cron 시각을 보장하지 않는다. 2026-09-01 실측:
 *   실행 A  2026-08-31T21:19:35Z ~ 22:09:44Z
 *   실행 B  2026-08-31T22:08:19Z ~ 22:21:59Z
 * 두 실행이 85초 겹쳤다. 겹치는 동안 두 프로세스가 같은 price_job_state 를
 * 읽고 써서 커서를 되돌리고 호출 예산을 두 배로 태울 수 있다.
 *
 * 잠금은 price_job_state.last_run_at 에 대한 compare-and-swap 으로 잡는다
 * (마이그레이션 없음). 아래 스텁은 PostgREST 의 update...eq 의미를 그대로
 * 흉내낸다 — eq 값이 다르면 0행을 돌려준다.
 */
'use strict';

const path = require('path');
const Module = require('module');

let row = { id: 1, last_run_at: '2026-09-01T00:00:00.000Z', last_result: {} };

function inject(rel, ex) {
  const p = require.resolve(path.join(__dirname, '..', rel));
  require.cache[p] = new Module(p, null);
  require.cache[p].filename = p; require.cache[p].loaded = true; require.cache[p].exports = ex;
}
inject('api/_supabase.js', {
  from: () => {
    let eqLast, isNull = false, payload = null, mode = null;
    const c = {
      select: () => c,
      eq: (k, v) => { if (k === 'last_run_at') eqLast = v; return c; },
      is: (k, v) => { if (k === 'last_run_at' && v === null) isNull = true; return c; },
      maybeSingle: () => Promise.resolve({ data: { ...row }, error: null }),
      update: (p) => { mode = 'update'; payload = p; return c; },
      upsert: () => Promise.resolve({ error: null }),
      then: (r) => {
        if (mode === 'update') {
          const match = isNull ? row.last_run_at === null
            : (eqLast === undefined || row.last_run_at === eqLast);
          if (match) { row = { ...row, ...payload }; return Promise.resolve({ data: [{ id: 1 }], error: null }).then(r); }
          return Promise.resolve({ data: [], error: null }).then(r);   // ← CAS 실패
        }
        return Promise.resolve({ data: { ...row }, error: null }).then(r);
      }
    };
    return c;
  },
  rpc: () => Promise.resolve({ data: null, error: null })
});
inject('api/_notify.js', { send: () => Promise.resolve({ ok: true }) });

const { acquireLock, releaseLock, LOCK_TTL_MS } = require('./collect-all-prices');

let pass = 0, fail = 0;
function check(ok, label, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail === undefined ? '' : '  — ' + JSON.stringify(detail)}`); }
}

(async () => {
  console.log('=== 수집기 동시 실행 방지 테스트 ===\n');

  /* 1. 두 실행이 같은 상태를 읽고 동시에 들어오면 하나만 통과한다 */
  const snapshot = { ...row };
  const a = await acquireLock(snapshot);
  const b = await acquireLock(snapshot);
  check(a.ok === true, '★★ 먼저 도착한 실행이 잠금을 잡는다', a);
  check(b.ok === false, '★★ 같은 상태를 읽은 두 번째 실행은 CAS 로 밀린다', b);
  check(/CAS|진행 중/.test(b.reason || ''), '  밀린 이유가 보고된다', b.reason);

  /* 2. 잠금이 살아 있는 동안 뒤따라온 실행도 막힌다 */
  const c = await acquireLock({ ...row });
  check(c.ok === false, '★ 진행 중에는 새 실행이 들어오지 못한다', c.reason);

  /* 3. 해제하면 다시 잡힌다 (정상 재시작을 막지 않는다) */
  await releaseLock(a.token);
  const d = await acquireLock({ ...row });
  check(d.ok === true, '★★ 해제 후에는 다음 실행이 정상적으로 잡는다');
  await releaseLock(d.token);

  /* 4. 프로세스가 죽어 해제하지 못해도 TTL 이 지나면 회수된다 */
  row.last_result = { lock: { runId: 'dead-run', at: '2026-08-01T00:00:00Z', until: '2026-08-01T01:00:00Z' } };
  const e = await acquireLock({ ...row });
  check(e.ok === true, '★★ 만료된 잠금은 회수한다 (영구 잠금 없음)');
  check(LOCK_TTL_MS < 120 * 60 * 1000,
    '★ TTL 이 cron 최소 간격(120분)보다 짧다 — 죽은 잠금이 다음 실행을 막지 않는다',
    LOCK_TTL_MS);
  check(LOCK_TTL_MS > 50 * 60 * 1000,
    '★ TTL 이 한 실행 최대 시간(50분)보다 길다 — 도는 중에 만료되지 않는다',
    LOCK_TTL_MS);

  /* 5. 남의 잠금은 풀지 않는다 */
  row.last_result = { lock: { runId: 'someone-else', until: new Date(Date.now() + 3600e3).toISOString() } };
  await releaseLock('my-token');
  check(row.last_result.lock && row.last_result.lock.runId === 'someone-else',
    '★★ 내 것이 아닌 잠금은 해제하지 않는다', row.last_result.lock);

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('테스트 실행 오류:', e); process.exit(1); });
