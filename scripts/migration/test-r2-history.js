#!/usr/bin/env node
/*
 * R2 가격 기록 아카이브(api/_r2history.js) 단위 테스트 — 네트워크 0회 / DB 0회.
 *
 *   node scripts/migration/test-r2-history.js
 *
 * 아카이브는 임시 폴더의 가짜 묶음(SEOSA_R2_HISTORY_LOCAL_DIR)으로 대신한다.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const archive = require('../../api/_r2history');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

const row = (pid = '7912306911', v = '123', p = 25900) => ({ product_id: pid, mall: '쿠팡', vendor_item_id: v, recorded_at: '2026-08-14T17:12:36.855Z', recorded_date: '2026-08-15', price: p });

function withEnv(env, fn) {
  const keys = Object.keys(env);
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  keys.forEach(k => { if (env[k] == null) delete process.env[k]; else process.env[k] = env[k]; });
  archive._resetForTests();
  return Promise.resolve().then(fn).finally(() => {
    keys.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
    archive._resetForTests();
  });
}

/** 가짜 아카이브 폴더: PID 의 묶음 파일에 COPY 원문 표기 행 두 개. */
function fakeArchiveDir(pid) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seosa-r2-test-'));
  const name = archive.bucketHash(pid);
  const lines = [
    [pid, '쿠팡', 'v1', '2026-10-01 01:00:00.5+00', '2026-10-01', 1000, 'collector'],
    [pid, '쿠팡', 'v1', '2026-10-19 22:08:57.62+00', '2026-10-20', 900, 'collector'],
    [pid, 'ADPICK', '', '2026-10-02 01:00:00+00', '2026-10-02', 5000, 'collector']
  ].map(x => JSON.stringify(x)).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, name + '.jsonl.gz'), zlib.gzipSync(lines));
  return dir;
}

(async () => {
  console.log('[1) 키 · 경로]');
  await check('같은 상품 → 같은 묶음 키', () => { assert.equal(archive.keyOf('7912306911'), archive.keyOf('7912306911')); });
  await check('한글·쉼표 옛 상품 ID 허용', () => { assert.match(archive.keyOf('보관함 신발 제품, 3개'), /^history\/v1\/shards\/[0-9a-f]{2}\.jsonl\.gz$/); });
  await check('제어문자 거절', () => { assert.throws(() => archive.keyOf('test\nabc')); });
  await check('경로 문자열이 객체 키에 섞이지 않는다', () => { assert.match(archive.keyOf('test/../x'), /^history\/v1\/shards\/[0-9a-f]{2}\.jsonl\.gz$/); });

  console.log('\n[2) 합치기]');
  await check('같은 관측(Date · 문자열 표기 달라도) → 한 번', () => {
    const old = row();
    const online = { recorded_at: new Date(old.recorded_at), recorded_date: old.recorded_date, price: old.price, vendor_item_id: old.vendor_item_id };
    assert.equal(archive.mergeHistory([online], [old], { productId: old.product_id, mall: old.mall }).length, 1);
  });
  await check('★ COPY 표기와 PostgREST 표기의 같은 관측 → 한 번', () => {
    const a = { ...row(), recorded_at: '2026-08-14 17:12:36.855+00' };
    const b = { ...row(), recorded_at: '2026-08-14T17:12:36.855+00:00' };
    assert.equal(archive.mergeHistory([b], [a]).length, 1);
  });
  await check('다른 옵션은 합치지 않는다', () => { assert.equal(archive.mergeHistory([row('abc', '11')], [row('abc', '22')]).length, 2); });
  await check('다른 몰·가격은 합치지 않는다', () => {
    assert.equal(archive.mergeHistory([row('abc', '11', 20000)], [{ ...row('abc', '11', 30000), mall: 'ADPICK' }]).length, 2);
  });
  await check('normalizeAt: COPY 원문 → PostgREST 표기', () => {
    assert.equal(archive.normalizeAt('2026-10-19 22:08:57.62+00'), '2026-10-19T22:08:57.62+00:00');
    assert.equal(archive.normalizeAt(new Date('2026-10-19T22:08:57.620Z')), '2026-10-19T22:08:57.620+00:00');
  });

  console.log('\n[3) withArchive — 그래프 기록]');
  const PID = '7912306911';
  await check('★ 아카이브 꺼짐(기본값) → DB 한 번, 컷오프 없이', () => withEnv({ SEOSA_R2_HISTORY_ENABLED: null, SEOSA_R2_HISTORY_LOCAL_DIR: null }, async () => {
    const calls = [];
    const r = await archive.withArchive(PID, '쿠팡', since => { calls.push(since); return Promise.resolve({ data: [row(PID)], error: null }); });
    assert.deepEqual(calls, [null]); assert.equal(r.archive, 'disabled'); assert.equal(r.data.length, 1);
  }));
  await check('★ 컷오프 있음 → DB 는 컷오프 이후만, 과거는 아카이브에서 (몰로 좁힘 · 표기 통일)', () => withEnv({
    SEOSA_R2_HISTORY_LOCAL_DIR: fakeArchiveDir(PID), VERCEL_ENV: 'preview', SEOSA_R2_HISTORY_CUTOFF: '2026-10-19T22:08:57.620Z'
  }, async () => {
    const calls = [];
    const fresh = { product_id: PID, mall: '쿠팡', vendor_item_id: 'v1', recorded_at: '2026-10-21T01:00:00+00:00', recorded_date: '2026-10-21', price: 880 };
    const r = await archive.withArchive(PID, '쿠팡', since => { calls.push(since); return Promise.resolve({ data: [fresh], error: null }); });
    assert.deepEqual(calls, ['2026-10-19T22:08:57.620Z']);
    assert.equal(r.archive, 'merged');
    assert.deepEqual(r.data.map(x => x.price).sort((a, b) => a - b), [880, 900, 1000]);
    assert.ok(r.data.every(x => /T.*\+00:00$/.test(x.recorded_at)));
  }));
  await check('컷오프 없음 + 아카이브 켬 → DB 전체 + 아카이브, 겹침은 한 번', () => withEnv({
    SEOSA_R2_HISTORY_LOCAL_DIR: fakeArchiveDir(PID), VERCEL_ENV: 'preview', SEOSA_R2_HISTORY_CUTOFF: null
  }, async () => {
    const dup = { product_id: PID, mall: '쿠팡', vendor_item_id: 'v1', recorded_at: '2026-10-01T01:00:00.5+00:00', recorded_date: '2026-10-01', price: 1000 };
    const r = await archive.withArchive(PID, '쿠팡', since => { assert.equal(since, null); return Promise.resolve({ data: [dup], error: null }); });
    assert.equal(r.data.length, 2);
  }));
  await check('★ 아카이브 읽기 실패 → DB 만으로 (컷오프 없이 다시 읽는다, 500 아님)', () => withEnv({
    SEOSA_R2_HISTORY_LOCAL_DIR: path.join(os.tmpdir(), 'seosa-r2-missing-' + Date.now()), VERCEL_ENV: 'preview', SEOSA_R2_HISTORY_CUTOFF: '2026-10-19T22:08:57.620Z'
  }, async () => {
    const calls = [];
    const r = await archive.withArchive(PID, '쿠팡', since => { calls.push(since); return Promise.resolve({ data: [row(PID)], error: null }); });
    assert.deepEqual(calls, ['2026-10-19T22:08:57.620Z', null]);
    assert.equal(r.archive, 'db-only'); assert.equal(r.error, null); assert.equal(r.data.length, 1);
  }));
  await check('DB 오류는 그대로 돌려준다 (아카이브로 덮지 않는다)', () => withEnv({
    SEOSA_R2_HISTORY_LOCAL_DIR: fakeArchiveDir(PID), VERCEL_ENV: 'preview', SEOSA_R2_HISTORY_CUTOFF: null
  }, async () => {
    const r = await archive.withArchive(PID, '쿠팡', () => Promise.resolve({ data: null, error: { message: 'boom' } }));
    assert.equal(r.error.message, 'boom');
  }));
  await check('Production 은 로컬 폴더를 쓰지 않는다', () => withEnv({ SEOSA_R2_HISTORY_ENABLED: null, SEOSA_R2_HISTORY_LOCAL_DIR: '/tmp/x', VERCEL_ENV: 'production' }, () => {
    assert.equal(archive.archiveEnabled(), false);
  }));
  await check('이상한 컷오프 값 → null (DB 전체)', () => withEnv({ SEOSA_R2_HISTORY_CUTOFF: 'yesterday-ish' }, () => {
    assert.equal(archive.archiveCutoff(), null);
  }));

  console.log('\n====================================================');
  console.log(`결과: ${passed} PASS / ${failed} FAIL`);
  console.log(`R2_ARCHIVE_UNIT_TESTS ${passed}/${passed + failed} ${failed ? 'FAIL' : 'PASS'}`);
  if (failed) process.exitCode = 1;
})();
