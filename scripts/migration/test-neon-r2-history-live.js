#!/usr/bin/env node
/*
 * 가격 그래프 실측 — Neon 테스트 브랜치 + 실제 R2. 읽기 전용(쓰기 0회).
 *
 *   (with-neon 래퍼가 NEON_DATABASE_URL · R2_* 를 프로세스 환경으로만 넣는다)
 *   node scripts/migration/test-neon-r2-history-live.js
 *
 * 같은 상품의 /api/history 응답을 세 방식으로 만들어 «완전히 같은지» 본다.
 *   A  Neon 만 (아카이브 끔 — 지금 기본값)
 *   B  R2 + Neon, 컷오프 없음 (Neon 전체 + 아카이브, 겹침 제거)
 *   C  R2 + Neon, 컷오프 2026-10-19T22:08:57.620Z (Neon 은 그 이후만)
 * 그리고 C 가 Neon 에서 받은 행 수가 A 보다 얼마나 적은지(전송량 절감)를 센다.
 */
'use strict';

const assert = require('node:assert/strict');

const ALLOWED_HOSTS = new Set([
  'ep-gentle-art-aoaa97v4.c-2.ap-southeast-1.aws.neon.tech',
  'ep-gentle-art-aoaa97v4-pooler.c-2.ap-southeast-1.aws.neon.tech'
]);
const CUTOFF = '2026-10-19T22:08:57.620Z';

function mockRes() {
  return {
    code: 200, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
    end() { return this; }
  };
}

async function main() {
  const host = new URL(process.env.NEON_DATABASE_URL || 'postgres://x').hostname;
  if (!ALLOWED_HOSTS.has(host) || process.env.VERCEL_ENV !== 'preview') throw new Error('격리된 테스트 브랜치(Preview)에서만 돈다');
  if (process.env.SEOSA_R2_HISTORY_ENABLED !== '1' || !process.env.R2_ACCESS_KEY_ID) throw new Error('R2 읽기 자격이 필요하다');

  const db = require('../../api/_supabase');
  const handler = require('../../api/history');
  const R2 = require('../../api/_r2history');

  // 표본: 기록이 많은 기준 상품 + 최근 관측 상품 + 오래된 관측 상품.
  const recent = await db.from('price_history').select('product_id, mall').order('id', { ascending: false }).limit(300);
  const old = await db.from('price_history').select('product_id, mall').order('id', { ascending: true }).limit(300);
  assert.equal(recent.error, null); assert.equal(old.error, null);
  const seen = new Set();
  const sample = [{ product_id: '7912306911', mall: '쿠팡' }];
  for (const r of [...recent.data, ...old.data]) {
    const k = r.product_id + '|' + r.mall;
    if (seen.has(k) || sample.length >= 25) continue;
    seen.add(k); sample.push(r);
  }

  const run = async (p, env) => {
    Object.assign(process.env, env);
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
    const res = mockRes();
    await handler({ method: 'GET', query: { productId: p.product_id, mall: p.mall }, headers: {}, url: '/api/history' }, res);
    return res;
  };
  const onlineRows = async (p, since) => {
    let q = db.from('price_history').select('recorded_date, recorded_at, price, vendor_item_id').eq('product_id', p.product_id).eq('mall', p.mall);
    if (since) q = q.gt('recorded_at', since);
    const r = await q.order('recorded_date', { ascending: false }).limit(3000);
    assert.equal(r.error, null);
    return r.data.length;
  };

  let same = 0;
  let rowsFull = 0;
  let rowsAfterCutoff = 0;
  let archiveRows = 0;
  const t0 = Date.now();
  for (const p of sample) {
    const a = await run(p, { SEOSA_R2_HISTORY_ENABLED: undefined, SEOSA_R2_HISTORY_CUTOFF: undefined });
    const b = await run(p, { SEOSA_R2_HISTORY_ENABLED: '1', SEOSA_R2_HISTORY_CUTOFF: undefined });
    const c = await run(p, { SEOSA_R2_HISTORY_ENABLED: '1', SEOSA_R2_HISTORY_CUTOFF: CUTOFF });
    assert.equal(a.code, 200, `A ${p.product_id} ${a.code}`);
    assert.equal(b.code, 200); assert.equal(c.code, 200);
    assert.deepEqual(b.body, a.body, `B≠A ${p.product_id}`);
    assert.deepEqual(c.body, a.body, `C≠A ${p.product_id}`);
    same++;
    rowsFull += await onlineRows(p, null);
    rowsAfterCutoff += await onlineRows(p, CUTOFF);
    archiveRows += (await R2.getHistory(p.product_id, p.mall)).length;
  }
  const ref = await run(sample[0], { SEOSA_R2_HISTORY_ENABLED: '1', SEOSA_R2_HISTORY_CUTOFF: CUTOFF });
  console.log(`기준 상품 ${sample[0].product_id}: 일별 점 ${ref.body.length}개 (첫 ${ref.body[0] && ref.body[0].date} · 끝 ${ref.body[ref.body.length - 1] && ref.body[ref.body.length - 1].date})`);
  console.log(`표본 ${sample.length}개 상품 — A=B=C 동일 ${same}/${sample.length}`);
  console.log(`Neon 에서 받은 가격 행: 컷오프 없음 ${rowsFull} → 컷오프 이후만 ${rowsAfterCutoff} (아카이브가 대신 준 행 ${archiveRows})`);
  console.log(`소요 ${Date.now() - t0}ms`);
  console.log('NEON_R2_HISTORY_LIVE PASS');
  await require('../../api/_neonpg').client.close();
}

main().catch(e => { console.error('NEON_R2_HISTORY_LIVE FAIL ' + e.message); process.exitCode = 1; });
