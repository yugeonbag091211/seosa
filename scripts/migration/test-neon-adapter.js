#!/usr/bin/env node
/*
 * Neon 호환 계층(api/_neonpg.js) 단위 테스트 — 외부 호출 0회 / DB 접근 0회.
 *
 *   node scripts/migration/test-neon-adapter.js
 *
 * 가짜 실행기로 «보내는 SQL» 과 «돌려주는 결과 모양» 을 함께 본다. 기준은
 * @supabase/postgrest-js 2.110.8 의 실제 동작이다(_neonpg.js 머리 주석 목록).
 * 실제 Neon 에서 같은 동작을 확인하는 짝은 test-neon-conformance.js 다.
 */
'use strict';

const assert = require('node:assert/strict');
const { createClient, _internal } = require('../../api/_neonpg');

const seen = [];
let respond = () => ({ rows: [], rowCount: 0 });
const query = async (text, values) => {
  seen.push({ text, values });
  return respond(text, values);
};
let txCount = 0;
const transaction = async fn => { txCount++; seen.push({ text: 'BEGIN' }); const out = await fn(query); seen.push({ text: 'COMMIT' }); return out; };

const META = {
  tables: {
    products: { columns: { id: {}, product_id: {}, mall: {}, title: {}, mall_label: {}, lprice: {} }, primaryKey: ['id'] },
    user_data: { columns: { id: {}, email: {}, wish: { json: true }, viewed: { json: true }, searches: { json: true } }, primaryKey: ['id'] },
    auth_codes: { columns: { email: {}, code_hash: {}, expires_at: {} }, primaryKey: ['email'] },
    identity_review_queue: { columns: { id: {}, reason_codes: { array: true } }, primaryKey: ['id'] },
    search_stats: { columns: { id: {}, keyword: {}, count: {} }, primaryKey: ['id'] },
    price_history: { columns: { id: {}, product_id: {}, mall: {}, vendor_item_id: {}, recorded_date: {}, recorded_at: {}, price: {} }, primaryKey: ['id'] }
  },
  functions: {
    coupang_acquire_v2: [{ retset: true, returns: 'rows', args: [{ name: 'p_source', type: 'text', hasDefault: false }, { name: 'p_keyword', type: 'text', hasDefault: false }, { name: 'p_collector_cap', type: 'integer', hasDefault: true }] }],
    coupang_prune: [{ retset: false, returns: 'scalar', args: [{ name: 'keep_days', type: 'integer', hasDefault: false }] }],
    bump_metric: [{ retset: false, returns: 'void', args: [{ name: 'p_metric', type: 'text', hasDefault: false }, { name: 'p_date', type: 'date', hasDefault: false }] }],
    collector_target_page: [{ retset: true, returns: 'rows', args: [{ name: 'p_limit', type: 'integer', hasDefault: false }] }],
    price_history_prior_obs: [{ retset: true, returns: 'rows', args: [{ name: 'p_ids', type: 'text[]', hasDefault: false }, { name: 'p_before', type: 'timestamp with time zone', hasDefault: false }] }],
    identity_review_resolve: [{ retset: false, returns: 'scalar', args: [{ name: 'p_queue_id', type: 'bigint', hasDefault: false }, { name: 'p_canonical_members', type: 'jsonb', hasDefault: false }] }]
  }
};
const db = createClient({ query, transaction, meta: META });

let passed = 0;
let failed = 0;
async function test(name, fn) {
  seen.length = 0; txCount = 0; respond = () => ({ rows: [], rowCount: 0 });
  try { await fn(); passed++; console.log('  PASS ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

(async () => {
  console.log('[1) 읽기 · 필터]');
  await test('필터 값은 전부 바인드 인자 (SQL 에 끼워 넣지 않는다)', async () => {
    respond = () => ({ rows: [{ product_id: 'abc', mall: '쿠팡' }] });
    const r = await db.from('products').select('product_id, mall').eq('mall', "쿠팡' OR 1=1 --").gte('id', 4).limit(5);
    assert.equal(r.error, null);
    assert.deepEqual(r.data, [{ product_id: 'abc', mall: '쿠팡' }]);
    assert.match(seen[0].text, /WHERE "mall" = \$1 AND "id" >= \$2 LIMIT \$3$/);
    assert.deepEqual(seen[0].values, ["쿠팡' OR 1=1 --", 4, 5]);
  });
  await test('★ db-max-rows 1,000: limit 없으면 1,000, limit(5000) 이어도 1,000', async () => {
    await db.from('price_history').select('*');
    assert.deepEqual(seen[0].values, [1000]);
    seen.length = 0;
    await db.from('price_history').select('id').range(0, 4999);
    assert.deepEqual(seen[0].values, [1000]);
  });
  await test('in() — 빈 목록은 FALSE, 중복은 한 번', async () => {
    await db.from('products').select('*').in('product_id', ['a', 'b', 'a']);
    assert.match(seen[0].text, /"product_id" IN \(\$1,\$2\)/);
    assert.deepEqual(seen[0].values.slice(0, 2), ['a', 'b']);
    seen.length = 0;
    await db.from('products').select('*').in('product_id', []);
    assert.match(seen[0].text, /WHERE FALSE/);
  });
  await test('order 여러 개 + nullsFirst + range', async () => {
    await db.from('products').select('id').order('id', { ascending: false }).order('mall', { nullsFirst: false }).range(10, 20);
    assert.match(seen[0].text, /ORDER BY "id" DESC, "mall" ASC NULLS LAST LIMIT \$1 OFFSET \$2/);
    assert.deepEqual(seen[0].values, [11, 10]);
  });
  await test('★ like/ilike 의 * 는 % (PostgREST URL 문법)', async () => {
    await db.from('products').select('id').like('title', 'SONY*').ilike('mall', '*쿠*');
    assert.deepEqual(seen[0].values.slice(0, 2), ['SONY%', '%쿠%']);
  });
  await test('★ or(): is.null · gt 타임스탬프 (hotdeals 실사용 문자열)', async () => {
    const nowIso = '2026-10-21T00:00:00.000Z';
    await db.from('products').select('id').or(`expires_at.is.null,expires_at.gt.${nowIso}`);
    assert.match(seen[0].text, /\("expires_at" IS NULL OR "expires_at" > \$1\)/);
    assert.equal(seen[0].values[0], nowIso);
  });
  await test('★ or(): like 접두 다수 (_seo-pages 실사용) → % 로', async () => {
    await db.from('products').select('id').or('title.like.SONY*,title.like.Sony*').gte('collected_at', '2026-01-01');
    assert.match(seen[0].text, /\("title" LIKE \$1 OR "title" LIKE \$2\) AND "collected_at" >= \$3/);
    assert.deepEqual(seen[0].values.slice(0, 2), ['SONY%', 'Sony%']);
  });
  await test('★ or() 조건 수백 개 (브랜드 허브 실사용 — PostgREST 는 개수 상한 없음)', async () => {
    const ors = Array.from({ length: 600 }, (_, i) => `title.like.B${i}*`).join(',');
    const r = await db.from('products').select('id').or(ors).gte('collected_at', '2026-01-01');
    assert.equal(r.error, null);
    assert.equal(seen[0].values.length, 600 + 2);
  });
  await test('or(): and() 중첩 · not. · in.(…) · 큰따옴표 값', async () => {
    await db.from('products').select('id').or('and(mall.eq.쿠팡,lprice.lt.1000),mall.not.in.(ADPICK,"a,b"),title.eq."x.y"');
    assert.match(seen[0].text, /\(\("mall" = \$1 AND "lprice" < \$2\) OR NOT \("mall" IN \(\$3,\$4\)\) OR "title" = \$5\)/);
    assert.deepEqual(seen[0].values.slice(0, 5), ['쿠팡', '1000', 'ADPICK', 'a,b', 'x.y']);
  });
  await test('not(col, is, null) (_billing 실사용)', async () => {
    await db.from('products').select('id').not('title', 'is', null);
    assert.match(seen[0].text, /WHERE NOT \("title" IS NULL\)/);
  });
  await test('filter(col, in, "(a,b)") · match()', async () => {
    await db.from('products').select('id').filter('mall', 'in', '(쿠팡,ADPICK)').match({ product_id: 'p1' });
    assert.match(seen[0].text, /"mall" IN \(\$1,\$2\) AND "product_id" = \$3/);
  });
  await test('위험한 식별자는 실행 전에 error (동기 예외 없음)', async () => {
    const t = await db.from('products;DROP TABLE products').select('*');
    assert.ok(t.error); assert.equal(t.data, null);
    const c = await db.from('products').select('*').eq('x); DROP TABLE products', '1');
    assert.ok(c.error);
    const p = await db.from('products').select('other_table(*)');
    assert.ok(p.error);
    assert.equal(seen.length, 0, '아무 SQL 도 보내지 않는다');
  });
  await test('alias:col 투영 · 공백 정리', async () => {
    await db.from('products').select('pid:product_id,  mall');
    assert.match(seen[0].text, /SELECT "product_id" AS "pid", "mall" FROM/);
  });

  console.log('\n[2) single · maybeSingle · count]');
  await test('★ single 0행 → PGRST116 · maybeSingle 0행 → data null', async () => {
    const miss = await db.from('products').select('*').eq('id', 100).single();
    assert.equal(miss.error.code, 'PGRST116'); assert.equal(miss.data, null); assert.equal(miss.status, 406);
    const maybe = await db.from('products').select('*').eq('id', 100).maybeSingle();
    assert.equal(maybe.data, null); assert.equal(maybe.error, null);
  });
  await test('maybeSingle 2행 → PGRST116 (postgrest-js 와 같은 문구)', async () => {
    respond = () => ({ rows: [{ id: 1 }, { id: 2 }] });
    const r = await db.from('products').select('id').maybeSingle();
    assert.equal(r.error.code, 'PGRST116');
    assert.equal(r.error.message, 'JSON object requested, multiple (or no) rows returned');
  });
  await test('count exact + head → 행을 내려받지 않는다', async () => {
    respond = text => /COUNT/.test(text) ? { rows: [{ count: 12 }] } : { rows: [] };
    const r = await db.from('products').select('*', { count: 'exact', head: true }).eq('mall', '쿠팡');
    assert.equal(r.data, null); assert.equal(r.count, 12);
    assert.equal(seen.length, 1); assert.match(seen[0].text, /^SELECT COUNT\(\*\)::bigint AS count FROM public\."products" WHERE "mall" = \$1$/);
  });
  await test('count exact + 데이터 → 둘 다', async () => {
    respond = text => /COUNT/.test(text) ? { rows: [{ count: 3 }] } : { rows: [{ id: 1 }] };
    const r = await db.from('products').select('id', { count: 'exact' }).limit(1);
    assert.equal(r.count, 3); assert.deepEqual(r.data, [{ id: 1 }]);
  });

  console.log('\n[3) 쓰기]');
  await test('insert 반환 없음 → data null · 201', async () => {
    const r = await db.from('search_stats').insert({ keyword: 'test', count: 1 });
    assert.equal(r.error, null); assert.equal(r.data, null); assert.equal(r.status, 201);
    assert.match(seen[0].text, /^INSERT INTO public\."search_stats" \("keyword", "count"\) VALUES \(\$1, \$2\)$/);
  });
  await test('★ jsonb 컬럼에 배열 → JSON 텍스트 (pg 배열 리터럴 아님)', async () => {
    await db.from('user_data').upsert({ email: 'a@b.c', wish: ['p1', 'p2'], viewed: [] }, { onConflict: 'email' });
    assert.deepEqual(seen[0].values, ['a@b.c', '["p1","p2"]', '[]']);
  });
  await test('text[] 컬럼 배열은 그대로 (pg 가 배열로 보낸다)', async () => {
    await db.from('identity_review_queue').update({ reason_codes: ['A', 'B'] }).eq('id', 1);
    assert.deepEqual(seen[0].values[1], ['A', 'B']);
  });
  await test('★ 여러 행: 컬럼은 키 합집합, 빠진 키는 NULL (defaultToNull 기본)', async () => {
    await db.from('products').insert([{ product_id: 'a', mall: '쿠팡' }, { product_id: 'b', mall: '쿠팡', title: 'T' }]);
    assert.match(seen[0].text, /\("product_id", "mall", "title"\) VALUES \(\$1, \$2, \$3\), \(\$4, \$5, \$6\)/);
    assert.deepEqual(seen[0].values, ['a', '쿠팡', null, 'b', '쿠팡', 'T']);
  });
  await test('defaultToNull:false → 빠진 키는 DEFAULT', async () => {
    await db.from('products').insert([{ product_id: 'a' }, { product_id: 'b', title: 'T' }], { defaultToNull: false });
    assert.match(seen[0].text, /VALUES \(\$1, DEFAULT\), \(\$2, \$3\)/);
  });
  await test('한 행의 undefined 값 키는 보내지 않는다 (JSON.stringify 와 같다)', async () => {
    await db.from('products').insert({ product_id: 'a', title: undefined });
    assert.match(seen[0].text, /\("product_id"\) VALUES \(\$1\)/);
  });
  await test('upsert onConflict → 보낸 컬럼 전부 EXCLUDED', async () => {
    await db.from('products').upsert({ product_id: 'p', mall: '쿠팡', title: 'T' }, { onConflict: 'product_id,mall' });
    assert.match(seen[0].text, /ON CONFLICT \("product_id", "mall"\) DO UPDATE SET "product_id" = EXCLUDED\."product_id", "mall" = EXCLUDED\."mall", "title" = EXCLUDED\."title"$/);
  });
  await test('★ upsert onConflict 없음 → 기본키 (auth_codes 실사용)', async () => {
    await db.from('auth_codes').upsert({ email: 'a@b.c', code_hash: 'h' });
    assert.match(seen[0].text, /ON CONFLICT \("email"\) DO UPDATE/);
  });
  await test('upsert ignoreDuplicates → DO NOTHING', async () => {
    await db.from('products').upsert([{ product_id: 'p', mall: 'x' }], { onConflict: 'product_id,mall', ignoreDuplicates: true });
    assert.match(seen[0].text, /DO NOTHING$/);
  });
  await test('없는 컬럼 → PGRST204 (SQL 보내지 않음)', async () => {
    const r = await db.from('products').insert({ product_id: 'p', nope: 1 });
    assert.equal(r.error.code, 'PGRST204'); assert.equal(seen.length, 0);
  });
  await test('★ 큰 묶음은 나눠서 한 트랜잭션 안에서 (전부 되거나 전부 안 된다)', async () => {
    const rows = Array.from({ length: 12000 }, (_, i) => ({ product_id: 'p' + i, mall: '쿠팡', title: 't' }));
    const r = await db.from('products').upsert(rows, { onConflict: 'product_id,mall' });
    assert.equal(r.error, null);
    assert.equal(txCount, 1);
    const inserts = seen.filter(s => /^INSERT/.test(s.text));
    assert.equal(inserts.length, 2);
    assert.ok(inserts.every(s => s.values.length <= 30000));
    assert.equal(seen[0].text, 'BEGIN'); assert.equal(seen[seen.length - 1].text, 'COMMIT');
  });
  await test('묶음 사이 중복 충돌키 → 21000 (한 문장이었다면 Postgres 가 낸 오류)', async () => {
    const rows = Array.from({ length: 12000 }, (_, i) => ({ product_id: 'p' + (i % 11000), mall: '쿠팡', title: 't' }));
    const r = await db.from('products').upsert(rows, { onConflict: 'product_id,mall' });
    assert.equal(r.error.code, '21000'); assert.equal(seen.length, 0);
  });
  await test('insert().select().single() → RETURNING 한 행', async () => {
    respond = () => ({ rows: [{ id: 7 }], rowCount: 1 });
    const r = await db.from('search_stats').insert({ keyword: 'k', count: 1 }).select('id').single();
    assert.deepEqual(r.data, { id: 7 });
    assert.match(seen[0].text, /RETURNING "id"$/);
  });
  await test('★ delete({count}) · update({count}) → 영향 행 수 (_account · pruneSearchCaches 실사용)', async () => {
    respond = () => ({ rows: [], rowCount: 5 });
    const d = await db.from('price_history').delete({ count: 'exact' }).lt('recorded_at', '2026-01-01');
    assert.equal(d.count, 5); assert.equal(d.error, null);
    const u = await db.from('products').update({ title: 'x' }, { count: 'exact' }).eq('id', 1);
    assert.equal(u.count, 5);
  });
  await test('★ 필터 없는 UPDATE/DELETE 거절 (pg-safeupdate 와 같다)', async () => {
    const d = await db.from('products').delete();
    const u = await db.from('products').update({ title: 'oops' });
    assert.equal(d.error.code, '21000'); assert.equal(u.error.code, '21000');
    assert.equal(seen.length, 0);
  });
  await test('UPDATE 값도 바인드 인자', async () => {
    await db.from('products').update({ title: "a' --" }).eq('product_id', 'p');
    assert.match(seen[0].text, /^UPDATE public\."products" SET "title" = \$2 WHERE "product_id" = \$1$/);
    assert.deepEqual(seen[0].values, ['p', "a' --"]);
  });
  await test('update().select() → 갱신된 행 배열', async () => {
    respond = () => ({ rows: [{ id: 1 }], rowCount: 1 });
    const r = await db.from('products').update({ title: 'x' }).eq('id', 1).select('*');
    assert.deepEqual(r.data, [{ id: 1 }]);
  });

  console.log('\n[4) rpc]');
  await test('집합 반환 → 배열 · 선언 타입으로 캐스트', async () => {
    respond = () => ({ rows: [{ allowed: true, call_id: 20 }] });
    const r = await db.rpc('coupang_acquire_v2', { p_source: 'search', p_keyword: '상품' });
    assert.equal(r.error, null); assert.deepEqual(r.data, [{ allowed: true, call_id: 20 }]);
    assert.match(seen[0].text, /^SELECT \* FROM public\."coupang_acquire_v2"\("p_source" => \$1::text, "p_keyword" => \$2::text\) LIMIT \$3$/);
  });
  await test('스칼라 → 값 하나', async () => {
    respond = () => ({ rows: [{ value: 4 }] });
    const r = await db.rpc('coupang_prune', { keep_days: 3 });
    assert.equal(r.data, 4);
    assert.match(seen[0].text, /^SELECT public\."coupang_prune"\("keep_days" => \$1::integer\) AS value$/);
  });
  await test('void → null', async () => {
    respond = () => ({ rows: [{ value: '' }] });
    const r = await db.rpc('bump_metric', { p_metric: 'x', p_date: '2026-10-21' });
    assert.equal(r.data, null); assert.equal(r.error, null);
  });
  await test('range() 는 서버에서 자른다', async () => {
    respond = () => ({ rows: [{ product_id: '1' }] });
    await db.rpc('collector_target_page', { p_limit: 5 }).range(5, 9);
    assert.match(seen[0].text, /LIMIT \$2 OFFSET \$3$/); assert.deepEqual(seen[0].values, [5, 5, 5]);
  });
  await test('text[] 인자는 배열 그대로 · timestamptz 캐스트', async () => {
    await db.rpc('price_history_prior_obs', { p_ids: ['a', 'b'], p_before: '2026-10-21T00:00:00Z' });
    assert.deepEqual(seen[0].values[0], ['a', 'b']);
    assert.match(seen[0].text, /"p_ids" => \$1::text\[\], "p_before" => \$2::timestamp with time zone/);
  });
  await test('jsonb 인자는 JSON 텍스트', async () => {
    await db.rpc('identity_review_resolve', { p_queue_id: 1, p_canonical_members: [{ a: 1 }] });
    assert.equal(seen[0].values[1], '[{"a":1}]');
  });
  await test('★ 없는 함수 · 모르는 인자 → PGRST202 (_dberror FUNCTION_MISSING)', async () => {
    const r = await db.rpc('no_such_fn', {});
    assert.equal(r.error.code, 'PGRST202');
    const r2 = await db.rpc('coupang_prune', { wrong: 1 });
    assert.equal(r2.error.code, 'PGRST202');
  });

  console.log('\n[5) 중단 · 오류 모양]');
  await test('★ abortSignal: 이미 중단 → 즉시 AbortError (status 0), SQL 없음', async () => {
    const c = new AbortController(); c.abort();
    const r = await db.from('products').select('*').abortSignal(c.signal);
    assert.equal(r.status, 0); assert.match(r.error.message, /^AbortError/); assert.equal(seen.length, 0);
  });
  await test('★ abortSignal: 실행 중 중단 → 결과를 기다리지 않는다', async () => {
    respond = () => new Promise(resolve => setTimeout(() => resolve({ rows: [{ id: 1 }] }), 300));
    const c = new AbortController();
    setTimeout(() => c.abort(), 20);
    const t0 = Date.now();
    const r = await db.rpc('coupang_prune', { keep_days: 1 }).abortSignal(c.signal);
    assert.ok(Date.now() - t0 < 200); assert.match(r.error.message, /^AbortError/);
  });
  await test('DB 오류 → { error: { message, code=SQLSTATE, details, hint } }, throw 안 함', async () => {
    respond = () => { const e = new Error('relation "public.nope" does not exist'); e.code = '42P01'; throw e; };
    const r = await db.from('products').select('*');
    assert.equal(r.error.code, '42P01'); assert.equal(r.data, null);
  });
  await test('throwOnError() → PostgrestError 로 throw', async () => {
    respond = () => { const e = new Error('boom'); e.code = 'XX000'; throw e; };
    await assert.rejects(() => db.from('products').select('*').throwOnError(), e => e.name === 'PostgrestError' && e.code === 'XX000');
  });
  await test('★ 연결 실패 문구가 _dberror 의 일시 장애로 분류된다', async () => {
    const dberr = require('../../api/_dberror');
    for (const [msg, code] of [['Connection terminated unexpectedly', ''], ['connect ECONNREFUSED 1.2.3.4:5432', 'ECONNREFUSED'],
      ['timeout exceeded when trying to connect', ''], ['Your account or project has exceeded the compute time quota. Upgrade your plan to increase limits.', 'XX000']]) {
      respond = () => { const e = new Error(msg); e.code = code; throw e; };
      const r = await db.from('products').select('*');
      assert.ok(dberr.isTransientDbError(r.error), msg + ' → ' + dberr.classifyDbError(r.error).kind);
    }
  });

  console.log('\n[6) 타입 — PostgREST JSON 과 같은 값]');
  await test('★ timestamptz 텍스트 → PostgREST 표기 (마이크로초 보존)', async () => {
    const P = _internal.TEXT_PARSERS;
    assert.equal(P[1184]('2026-10-21 01:02:03.4567+00'), '2026-10-21T01:02:03.4567+00:00');
    assert.equal(P[1184]('2026-10-21 01:02:03+00'), '2026-10-21T01:02:03+00:00');
    assert.equal(P[1184]('2026-10-21 10:02:03.123456+09'), '2026-10-21T01:02:03.123456+00:00');
    assert.equal(P[1184]('2026-10-20 23:30:00-05:30'), '2026-10-21T05:00:00+00:00');
    assert.equal(P[1184]('infinity'), 'infinity');
    assert.equal(P[1114]('2026-10-21 01:02:03.5'), '2026-10-21T01:02:03.5');
  });
  await test('★ date 는 문자열 · int8/numeric 은 number', async () => {
    const P = _internal.TEXT_PARSERS;
    assert.equal(P[1082]('2026-10-21'), '2026-10-21');
    assert.equal(P[20]('9007199254740991'), 9007199254740991);
    assert.equal(P[1700]('12.50'), 12.5);
    assert.equal(P[1700]('NaN'), 'NaN');
    assert.deepEqual(P[1016]('{1,2,NULL}'), [1, 2, null]);
    assert.deepEqual(P[1185]('{"2026-10-21 01:02:03+00"}'), ['2026-10-21T01:02:03+00:00']);
  });

  console.log('\n====================================================');
  console.log(`결과: ${passed} PASS / ${failed} FAIL`);
  console.log(`NEON_ADAPTER_UNIT_TESTS ${passed}/${passed + failed} ${failed ? 'FAIL' : 'PASS'}`);
  if (failed) process.exitCode = 1;
})().catch(e => { console.error('FAIL: ' + e.stack); process.exitCode = 1; });
