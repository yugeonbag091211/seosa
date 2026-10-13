#!/usr/bin/env node
'use strict';
/*
 * Product Identity — Phase 2 Shadow Matching 테스트.
 * ★ 외부 호출 0회 · 운영 DB 접근 0회. 가짜 Supabase 로만 돈다.
 *
 *   node scripts/test-identity-shadow.js
 *
 * 이 파일이 지키는 것:
 *
 *   A. 스키마     additive only · 필요한 인덱스/유일성 · 운영 표 미변경
 *   B. 소비자 0   shadow 표 이름이 운영 경로(검색·AI·상세·핫딜·수집기…)에 없다
 *   C. 관문       IDENTITY_SHADOW_ENABLED 없이는 동작하지 않는다
 *   D. dry-run    DB write 0 (쓰기 시도 자체를 가짜 DB 가 실패로 만든다)
 *   E. 저장       run → groups → members → reviews → completed
 *   F. 실패       중간 insert 실패는 completed 가 아니라 partial/failed
 *   G. 불변식     all-pairs 위반 · 중복 구성원 · REVIEW bridge 를 저장 전에 거부
 *   H. 동시성     두 run 이 동시에 들어오면 하나만 잠금을 잡는다
 *   I. 운영표     products / price_history 에 쓰기 0 (Invariant E)
 *   J. bridge     Phase 1 의 bridge poisoning 방지가 shadow 경로에서도 유지된다
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SH = require('../api/_identityshadow');
const OI = require('../api/_offeridentity');
const W = require('./run-offer-identity-shadow');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) pass++;
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}
const quiet = () => {};

/* ==================================================================
 *  가짜 Supabase
 *
 *  PostgREST 의 의미를 필요한 만큼만 흉내낸다: insert().select(), update().eq(),
 *  select().gt().order().limit(), maybeSingle(). 쓰기는 전부 기록해 두고
 *  «무엇에 썼는가» 를 테스트가 단언한다.
 * ================================================================== */
function fakeDb(opts) {
  const o = opts || {};
  const state = {
    writes: [],                    // {table, op, rows}
    reads: [],
    tables: {
      identity_shadow_runs: [],
      identity_shadow_groups: [],
      identity_shadow_group_members: [],
      identity_shadow_reviews: [],
      identity_shadow_job_state: [{ id: 1, status: 'idle', lock_token: '', lock_until: null }]
    },
    products: o.products || [],
    seq: { identity_shadow_runs: 0, identity_shadow_groups: 0, identity_shadow_group_members: 0, identity_shadow_reviews: 0 }
  };
  // 테이블별 강제 실패: {table: 'identity_shadow_group_members', afterRows: 0}
  const failOn = o.failOn || null;
  const writtenRows = {};

  function from(table) {
    const q = { _table: table, _op: null, _rows: null, _patch: null, _eq: {}, _gt: null, _lt: null, _in: null, _limit: 0 };
    const api = {
      select() { if (!q._op) q._op = 'select'; return api; },
      insert(rows) { q._op = 'insert'; q._rows = Array.isArray(rows) ? rows : [rows]; return api; },
      update(patch) { q._op = 'update'; q._patch = patch; return api; },
      eq(k, v) { q._eq[k] = v; return api; },
      gt(k, v) { q._gt = [k, v]; return api; },
      lt(k, v) { q._lt = [k, v]; return api; },
      in(k, v) { q._in = [k, v]; return api; },
      order() { return api; },
      limit(n) { q._limit = n; return api; },
      range() { return api; },
      maybeSingle() { return exec(true); },
      then(res, rej) { return exec(false).then(res, rej); }
    };
    function exec(single) {
      // ── 운영 표 ──
      if (table === 'products') {
        if (q._op !== 'select' && q._op !== null) {
          state.writes.push({ table, op: q._op });
          return Promise.resolve({ data: null, error: { message: 'products 쓰기 금지 (테스트)' } });
        }
        state.reads.push(table);
        let rows = state.products;
        if (q._gt) rows = rows.filter(r => r[q._gt[0]] > q._gt[1]);
        if (q._eq.mall) rows = rows.filter(r => r.mall === q._eq.mall);
        if (q._in && q._in[0] === 'mall') rows = rows.filter(r => q._in[1].includes(r.mall));
        rows = rows.slice(0, q._limit || 1000);
        return Promise.resolve({ data: rows, error: null });
      }
      if (table === 'price_history') {
        state.writes.push({ table, op: q._op });
        return Promise.resolve({ data: null, error: { message: 'price_history 접근 금지 (테스트)' } });
      }

      const rows = state.tables[table];
      if (!rows) return Promise.resolve({ data: null, error: { message: `relation "${table}" does not exist`, code: '42P01' } });

      if (q._op === 'insert') {
        if (failOn && failOn.table === table && (writtenRows[table] || 0) >= (failOn.afterRows || 0)) {
          state.writes.push({ table, op: 'insert', rows: q._rows.length, failed: true });
          return Promise.resolve({ data: null, error: { message: failOn.message || 'insert 강제 실패' } });
        }
        // 유일성: group_members (run_id, product_id, mall, vendor_item_id)
        if (table === 'identity_shadow_group_members') {
          // 이미 저장된 행뿐 아니라 «같은 묶음 안» 의 중복도 거부한다 (실제 유일 인덱스와 같다).
          const seenTriples = new Set(rows.map(x => `${x.run_id}\u0000${x.product_id}\u0000${x.mall}\u0000${x.vendor_item_id || ''}`));
          for (const r of q._rows) {
            const t = `${r.run_id}\u0000${r.product_id}\u0000${r.mall}\u0000${r.vendor_item_id || ''}`;
            if (seenTriples.has(t)) return Promise.resolve({ data: null, error: { message: 'duplicate key value violates unique constraint "identity_shadow_group_members_unique_idx"', code: '23505' } });
            seenTriples.add(t);
          }
        }
        // 유일성: runs 의 «running 은 하나»
        if (table === 'identity_shadow_runs' && q._rows.some(r => r.status === 'running')
          && rows.some(x => x.status === 'running')) {
          return Promise.resolve({ data: null, error: { message: 'duplicate key value violates unique constraint "identity_shadow_runs_single_running_idx"', code: '23505' } });
        }
        const made = q._rows.map(r => {
          const id = ++state.seq[table];
          const row = Object.assign({ id }, r);
          rows.push(row);
          return row;
        });
        writtenRows[table] = (writtenRows[table] || 0) + made.length;
        state.writes.push({ table, op: 'insert', rows: made.length });
        return Promise.resolve({ data: made.map(r => ({ id: r.id })), error: null });
      }

      if (q._op === 'update') {
        let target = rows.filter(r => Object.keys(q._eq).every(k => r[k] === q._eq[k]));
        if (q._lt) target = target.filter(r => r[q._lt[0]] < q._lt[1]);
        target.forEach(r => Object.assign(r, q._patch));
        state.writes.push({ table, op: 'update', rows: target.length });
        return Promise.resolve({ data: target.map(r => ({ id: r.id })), error: null });
      }

      // select
      state.reads.push(table);
      let out = rows.filter(r => Object.keys(q._eq).every(k => r[k] === q._eq[k]));
      if (single) return Promise.resolve({ data: out[0] || null, error: null });
      return Promise.resolve({ data: out, error: null });
    }
    return api;
  }
  return { from, _state: state };
}

/** 같은 SKU 2개 + 전혀 다른 상품 1개 — 그룹 하나가 나오는 최소 입력. */
function sampleProducts() {
  return [
    { id: 1, product_id: 'c1', mall: '쿠팡', mall_label: null, title: '삼성전자 갤럭시 버즈3 프로 화이트 SM-R630', lprice: 283220, vendor_item_id: 'v1', collected_at: '2026-10-13T00:00:00Z' },
    { id: 2, product_id: 'a1', mall: 'ADPICK', mall_label: 'SSG', title: 'Galaxy Buds3 Pro White 국내정품 SM-R630', lprice: 279000, vendor_item_id: '', collected_at: '2026-10-13T01:00:00Z' },
    { id: 3, product_id: 'c2', mall: '쿠팡', mall_label: null, title: 'Apple 아이폰 17 Pro 256GB 블랙 자급제', lprice: 1599000, vendor_item_id: 'v2', collected_at: '2026-10-13T02:00:00Z' }
  ];
}

(async () => {
  /* ================================================================
   *  A. 스키마
   * ================================================================ */
  console.log('=== A. 스키마 (additive only) ===');
  const migPath = path.join(ROOT, 'supabase', '2026-10-13-identity-shadow.sql');
  const sql = fs.readFileSync(migPath, 'utf8');
  /*
   * 실제로 «실행되는» SQL 만 본다. 주석(롤백 안내·검증 예시)과 문자열 리터럴
   * (comment on table '… products 를 수정하지 않는다')은 DDL 이 아니다.
   */
  const statements = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  /*
   * products / price_history 언급 검사용으로는 문자열 리터럴까지 지운다 —
   * comment on table '… products 를 수정하지 않는다' 는 DDL 이 아니다.
   */
  const noStrings = statements.replace(/'(?:[^']|'')*'/g, "''");

  ['identity_shadow_runs', 'identity_shadow_groups', 'identity_shadow_group_members',
    'identity_shadow_reviews', 'identity_shadow_job_state'].forEach(t => {
    ok(new RegExp(`create table if not exists ${t}\\b`).test(statements), `${t} 를 if not exists 로 만든다`);
    ok(new RegExp(`alter table ${t}\\s+enable row level security`).test(statements), `${t} RLS 켬`);
  });

  // 파괴적 구문이 «실행되는 자리» 에 없어야 한다 (주석의 롤백 안내는 위에서 걸러냈다)
  [/\bdrop\s+table\b/i, /\btruncate\b/i, /\bdelete\s+from\b/i, /\balter\s+table\s+products\b/i,
    /\balter\s+table\s+price_history\b/i, /\balter\s+table\s+\w+\s+rename\b/i].forEach(re => {
    ok(!re.test(noStrings), `파괴적 구문 없음: ${re}`);
  });
  ok(!/\bproducts\b/.test(noStrings) && !/\bprice_history\b/.test(noStrings),
    '마이그레이션 본문이 products / price_history 를 아예 건드리지 않는다');

  ok(/create unique index if not exists identity_shadow_group_members_unique_idx[\s\S]*?\(run_id, product_id, mall, vendor_item_id\)/.test(statements),
    'Invariant A 를 DB 유일 인덱스로 고정');
  ok(/create unique index if not exists identity_shadow_runs_single_running_idx[\s\S]*?where status = 'running'/.test(statements),
    'running run 은 전체에서 하나 (부분 유일 인덱스)');
  ok(/create unique index if not exists identity_shadow_groups_run_key_idx[\s\S]*?\(run_id, group_key\)/.test(statements),
    '한 run 안에서 같은 그룹은 한 번만');
  ok(/create unique index if not exists identity_shadow_reviews_pair_idx/.test(statements), 'REVIEW 쌍 유일 인덱스');
  ok(/check \(member_count >= 2\)/.test(statements), '1인 그룹은 DB 가 거부한다');
  ok(/check \(left_offer_key < right_offer_key\)/.test(statements), 'REVIEW 쌍은 항상 정렬된 순서로만 저장된다');
  ok(/references identity_shadow_runs\(id\) on delete cascade/.test(statements), 'run 을 지우면 딸린 행도 사라진다');
  ok(!/references products/.test(noStrings),'products 로 FK 를 걸지 않는다 (카탈로그 재등록을 막지 않기 위해)');

  /* ================================================================
   *  B. 소비자 0 — 운영 경로가 shadow 표를 읽지 않는다
   * ================================================================ */
  console.log('=== B. 소비자 0 ===');
  const SHADOW_NAMES = ['identity_shadow_runs', 'identity_shadow_groups', 'identity_shadow_group_members',
    'identity_shadow_reviews', 'identity_shadow_job_state'];
  const ALLOWED = new Set([
    'supabase/2026-10-13-identity-shadow.sql',
    'supabase/2026-10-13-identity-promotion.sql',
    'scripts/run-offer-identity-shadow.js',
    'scripts/run-offer-identity-promotion.js',
    'scripts/compare-identity-shadow-runs.js',
    'scripts/test-identity-shadow.js',
    'scripts/test-identity-promotion.js',
    'scripts/test-identity-promotion-mutations.js',
    'api/_identityreview.js',
    'scripts/run-identity-review-ingest.js',
    'scripts/test-identity-review.js',
    'scripts/test-identity-review-mutations.js',
    'supabase/2026-10-13-identity-review-phase4.sql',
    'supabase/2026-10-13-identity-review-phase4-indexes.sql',
    'reports/product-identity-phase2-shadow-2026-10-13.md',
    'reports/product-identity-phase3-promotion-2026-10-13.md',
    '.github/workflows/identity-shadow.yml'
  ]);
  function walk(dir, out) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.claude')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(js|ts|tsx|jsx|json|sql|yml|yaml|html|md)$/.test(e.name)) out.push(p);
    }
    return out;
  }
  const files = walk(ROOT, []);
  const offenders = [];
  files.forEach(p => {
    const rel = path.relative(ROOT, p).split(path.sep).join('/');
    if (ALLOWED.has(rel)) return;
    const text = fs.readFileSync(p, 'utf8');
    if (SHADOW_NAMES.some(n => text.includes(n))) offenders.push(rel);
  });
  ok(offenders.length === 0, 'shadow 표 이름은 Phase 2/3 유지보수 도구 밖의 운영 경로에서 쓰이지 않는다', offenders.join(', '));

  // 운영 API 가 새 모듈을 require 하지도 않는다
  const apiFiles = fs.readdirSync(path.join(ROOT, 'api')).filter(f => f.endsWith('.js'));
  const importers = apiFiles.filter(f => fs.readFileSync(path.join(ROOT, 'api', f), 'utf8').includes('_identityshadow'));
  ok(importers.every(f => f === '_identityreview.js'), 'only the Phase 4 admin review module may reuse _identityshadow', importers.join(', '));

  /* ================================================================
   *  C. 관문
   * ================================================================ */
  console.log('=== C. opt-in 관문 ===');
  ok(W.shadowEnabled({ IDENTITY_SHADOW_ENABLED: 'true' }) === true, 'true 면 켜진다');
  ok(W.shadowEnabled({ IDENTITY_SHADOW_ENABLED: '1' }) === true, '1 이면 켜진다');
  ok(W.shadowEnabled({}) === false, '없으면 꺼진다');
  ok(W.shadowEnabled({ IDENTITY_SHADOW_ENABLED: 'false' }) === false, 'false 면 꺼진다');
  ok(W.shadowEnabled({ IDENTITY_SHADOW_ENABLED: 'yes' }) === false, '모호한 값은 꺼진 것으로 본다');
  const workerSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'run-offer-identity-shadow.js'), 'utf8');
  ok(/if \(!shadowEnabled\(\)\)[\s\S]{0,200}process\.exit\(0\)/.test(workerSrc), '꺼져 있으면 exit 0 으로 조용히 끝낸다');

  /* ================================================================
   *  D. dry-run — DB write 0
   * ================================================================ */
  console.log('=== D. dry-run ===');
  {
    const db = fakeDb({ products: sampleProducts() });
    const r = await W.run(db, { dryRun: true, log: quiet });
    ok(r.dryRun === true, 'dry-run 으로 끝난다');
    ok(db._state.writes.length === 0, 'DB 쓰기 0회', JSON.stringify(db._state.writes));
    ok(db._state.tables.identity_shadow_runs.length === 0, 'run 행을 만들지 않는다');
    ok(db._state.reads.includes('products'), 'products 는 읽는다');
    ok(r.groups === 1, '그룹 1개를 계산한다(저장은 안 한다)', String(r.groups));
    ok(r.stats.source_product_count === 3, 'source_product_count = 3', String(r.stats.source_product_count));
    ok(r.stats.parsed_offer_count === 3, 'parsed_offer_count = 3');
  }

  /* ================================================================
   *  E. 실제 shadow 저장
   * ================================================================ */
  console.log('=== E. shadow write ===');
  let writtenState = null;
  {
    const db = fakeDb({ products: sampleProducts() });
    const r = await W.run(db, { log: quiet, matcherVersion: 'test-sha' });
    writtenState = db._state;
    ok(!r.failed, 'run 이 실패하지 않는다', r.reason);
    const runs = db._state.tables.identity_shadow_runs;
    ok(runs.length === 1, 'run 행 1개');
    ok(runs[0].status === 'completed', 'status = completed', runs[0].status);
    ok(runs[0].matcher_id === SH.MATCHER_ID, 'matcher_id 기록');
    ok(runs[0].matcher_version === 'test-sha', 'matcher_version 기록', runs[0].matcher_version);
    ok(runs[0].source_snapshot_at === '2026-10-13T02:00:00Z', 'source_snapshot_at = 최신 collected_at', String(runs[0].source_snapshot_at));
    ok(runs[0].finished_at != null, 'finished_at 기록');

    const groups = db._state.tables.identity_shadow_groups;
    ok(groups.length === 1, '그룹 1개 저장', String(groups.length));
    ok(groups[0].member_count === 2 && groups[0].merchant_count === 2, '구성원 2 · 판매처 2');
    ok(groups[0].confidence_tier === 'A', '모델번호가 같으니 Tier A', groups[0].confidence_tier);
    ok(groups[0].group_key && groups[0].group_key.length === 32, 'group_key 는 32자 지문');
    ok(groups[0].canonical_identity && groups[0].canonical_identity.brand === 'samsung', 'canonical_identity 저장');
    ok(groups[0].verification_status === 'UNVERIFIED', 'Phase 4 검수 전 상태');

    const members = db._state.tables.identity_shadow_group_members;
    ok(members.length === 2, '구성원 2행', String(members.length));
    ok(members.every(m => m.group_id === groups[0].id && m.run_id === runs[0].id), 'group_id / run_id 연결');
    ok(members.every(m => m.decision === 'MATCH'), '구성원 판정은 MATCH');
    ok(members.every(m => m.confidence > 0 && m.evidence.length > 0), 'confidence · evidence 기록');
    ok(members.some(m => m.mall === '쿠팡') && members.some(m => m.mall === 'ADPICK/SSG'),
      'mall 은 표시 이름까지 (ADPICK/SSG)', members.map(m => m.mall).join(','));
    ok(members.every(m => m.identity_snapshot && !('title' in m.identity_snapshot)),
      'identity_snapshot 에 상품명을 복사하지 않는다');
    ok(members.map(m => m.product_id).sort().join(',') === 'a1,c1', 'products 의 logical key 를 그대로 들고 간다');

    // 통계
    ok(runs[0].stored_group_count === 1, 'stored_group_count');
    ok(runs[0].cross_merchant_group_count === 1, 'cross_merchant_group_count');
    ok(runs[0].match_pair_count >= 1, 'match_pair_count >= 1', String(runs[0].match_pair_count));
    ok(runs[0].largest_group_size === 2, 'largest_group_size');
    ok(runs[0].all_pairs_violation_count === 0, '위반 0');
    ok(runs[0].metadata && runs[0].metadata.byMall, '몰별 수치 기록');
    ok(runs[0].scope && runs[0].scope.dryRun === false, 'scope 기록');

    // 잠금이 반납됐다
    const lockRow = db._state.tables.identity_shadow_job_state[0];
    ok(lockRow.status === 'idle' && lockRow.lock_token === '', '잠금 반납');
    ok(lockRow.last_run_id === runs[0].id, 'last_run_id 기록');
  }

  /* ================================================================
   *  I. 운영 표 무변경 (Invariant E)
   * ================================================================ */
  console.log('=== I. 운영 표 무변경 ===');
  {
    const touched = writtenState.writes.filter(w => w.table === 'products' || w.table === 'price_history');
    ok(touched.length === 0, 'products / price_history 쓰기 0회', JSON.stringify(touched));
    const tables = [...new Set(writtenState.writes.map(w => w.table))].sort();
    ok(tables.every(t => t.startsWith('identity_shadow_')), '쓴 표는 전부 identity_shadow_*', tables.join(','));
  }

  /* ================================================================
   *  F. 중간 실패 → completed 금지
   * ================================================================ */
  console.log('=== F. 중간 실패 ===');
  {
    const db = fakeDb({ products: sampleProducts(), failOn: { table: 'identity_shadow_group_members', afterRows: 0 } });
    const r = await W.run(db, { log: quiet });
    const runs = db._state.tables.identity_shadow_runs;
    ok(r.failed === true, 'run 이 실패로 돌아온다');
    ok(runs[0].status === 'partial', 'group 은 썼고 member 에서 실패 → partial', runs[0].status);
    ok(runs[0].status !== 'completed', '★ completed 가 아니다');
    ok(runs[0].error_reason.includes('identity_shadow_group_members'), '실패 이유 기록', runs[0].error_reason);
    ok(db._state.tables.identity_shadow_job_state[0].status === 'idle', '실패해도 잠금은 반납한다');
  }
  {
    const db = fakeDb({ products: sampleProducts(), failOn: { table: 'identity_shadow_groups', afterRows: 0 } });
    const r = await W.run(db, { log: quiet });
    const runs = db._state.tables.identity_shadow_runs;
    ok(r.failed === true && runs[0].status === 'failed', 'group 부터 실패하면 failed', runs[0].status);
    ok(db._state.tables.identity_shadow_group_members.length === 0, '구성원 행이 남지 않는다');
  }

  /* ================================================================
   *  G. 불변식 — 저장 전에 거부
   * ================================================================ */
  console.log('=== G. 불변식 ===');
  {
    // all-pairs 위반을 주입한다 (서로 MATCH 가 아닌 둘을 한 그룹으로)
    const a = OI.parseOffer({ key: 'm|1', title: 'Apple 아이폰 17 Pro 256GB 블랙 자급제', mall: 'm', productId: '1' });
    const b = OI.parseOffer({ key: 'm|2', title: 'Apple 아이폰 17 Pro 512GB 블랙 자급제', mall: 'm', productId: '2' });
    const offersByKey = new Map([[a.key, a], [b.key, b]]);
    const v = SH.validateShadowResult({ groups: [{ id: 0, members: [a.key, b.key] }], offersByKey });
    ok(!v.ok, 'all-pairs 위반을 잡는다');
    ok(v.violations.some(x => x.kind === SH.VIOLATION.PAIR_NOT_MATCH), 'pair_not_match 로 보고', JSON.stringify(v.violations[0]));
    ok(v.violations[0].conflicts.some(c => c.startsWith('storage_mismatch')), '충돌 근거까지 남긴다');
  }
  {
    // 같은 상품이 두 그룹에
    const a = OI.parseOffer({ key: 'm|1', title: '삼성 갤럭시 버즈3 프로 화이트 SM-R630', mall: 'm', productId: '1', vendorItemId: 'v' });
    const b = OI.parseOffer({ key: 'm|2', title: 'Galaxy Buds3 Pro White SM-R630', mall: 'm', productId: '2' });
    const c = OI.parseOffer({ key: 'm|3', title: '삼성전자 갤럭시 버즈3 프로 화이트 SM-R630 국내정품', mall: 'm', productId: '1', vendorItemId: 'v' });
    const offersByKey = new Map([[a.key, a], [b.key, b], [c.key, c]]);
    const v = SH.validateShadowResult({ groups: [{ id: 0, members: [a.key, b.key] }, { id: 1, members: [c.key, b.key] }], offersByKey });
    ok(v.violations.some(x => x.kind === SH.VIOLATION.DUPLICATE_MEMBER), 'Invariant A: 같은 상품이 두 그룹에 들어가면 잡는다');
  }
  {
    // REVIEW 쌍이 같은 그룹 안에 (bridge)
    const a = OI.parseOffer({ key: 'm|1', title: '삼성 갤럭시 버즈3 프로 화이트 SM-R630', mall: 'm', productId: '1' });
    const b = OI.parseOffer({ key: 'm|2', title: 'Galaxy Buds3 Pro White SM-R630', mall: 'm', productId: '2' });
    const offersByKey = new Map([[a.key, a], [b.key, b]]);
    const v = SH.validateShadowResult({
      groups: [{ id: 0, members: [a.key, b.key] }], offersByKey, reviewPairs: [[a.key, b.key]]
    });
    ok(v.violations.some(x => x.kind === SH.VIOLATION.REVIEW_BRIDGE), 'Invariant C: REVIEW 가 그룹 안에 있으면 잡는다');
  }
  {
    // 위반이 있으면 워커가 저장하지 않는다 — matcher 를 망가뜨려 주입한다
    const db = fakeDb({ products: sampleProducts() });
    const realVerify = OI.verifyGroups;
    OI.verifyGroups = () => [{ group: 'g', a: 'x', b: 'y', result: { decision: 'NO_MATCH', conflicts: ['storage_mismatch:1!=2'], unknown: [] } }];
    const r = await W.run(db, { log: quiet });
    OI.verifyGroups = realVerify;
    ok(r.failed === true && r.reason === 'invariant_violation', '위반이면 run 실패', r.reason);
    ok(db._state.tables.identity_shadow_groups.length === 0, '★ 그룹을 하나도 저장하지 않는다');
    ok(db._state.tables.identity_shadow_group_members.length === 0, '구성원도 저장하지 않는다');
    ok(db._state.tables.identity_shadow_runs[0].status === 'failed', 'run 은 failed 로 끝난다');
    ok(String(db._state.tables.identity_shadow_runs[0].error_reason).includes('invariant_violation'), '이유 기록');
  }
  {
    // DB 유일 인덱스도 두 번째 방어선으로 동작한다
    const db = fakeDb({ products: sampleProducts() });
    const dup = [{ run_id: 1, group_id: 1, product_id: 'c1', mall: '쿠팡', vendor_item_id: 'v1', offer_key: 'k' },
      { run_id: 1, group_id: 2, product_id: 'c1', mall: '쿠팡', vendor_item_id: 'v1', offer_key: 'k' }];
    let threw = false;
    try { await W.insertBatches(db, 'identity_shadow_group_members', dup, { log: quiet }); } catch (e) { threw = /unique|duplicate/i.test(e.message); }
    ok(threw, 'DB 유일 인덱스가 중복 구성원을 거부한다');
  }

  /* ================================================================
   *  H. 동시성
   * ================================================================ */
  console.log('=== H. 동시성 ===');
  {
    const db = fakeDb({ products: sampleProducts() });
    // 두 실행이 «같은 상태» 를 읽고 동시에 CAS 로 들어온다
    const [l1, l2] = await Promise.all([W.acquireLock(db, { log: quiet }), W.acquireLock(db, { log: quiet })]);
    const acquired = [l1, l2].filter(x => x.result === W.LOCK.ACQUIRED);
    ok(acquired.length === 1, '동시에 들어와도 한쪽만 잠금을 잡는다', JSON.stringify([l1.result, l2.result]));
    ok([l1, l2].some(x => x.result === W.LOCK.SKIP), '다른 쪽은 SKIP');
  }
  {
    const db = fakeDb({ products: sampleProducts() });
    db._state.tables.identity_shadow_job_state[0] = {
      id: 1, status: 'running', lock_token: 'other', lock_until: new Date(Date.now() + 60000).toISOString()
    };
    const r = await W.run(db, { log: quiet });
    ok(r.skipped === true && r.reason === 'busy', '남이 쥐고 있으면 건너뛴다', JSON.stringify(r));
    ok(db._state.tables.identity_shadow_runs.length === 0, 'run 을 만들지 않는다');
    ok(db._state.tables.identity_shadow_job_state[0].lock_token === 'other', '남의 잠금을 건드리지 않는다');
  }
  {
    // TTL 이 지난 잠금은 회수하고, 남아 있던 running run 을 내린다
    const db = fakeDb({ products: sampleProducts() });
    db._state.tables.identity_shadow_job_state[0] = {
      id: 1, status: 'running', lock_token: 'dead', lock_until: new Date(Date.now() - 60000).toISOString()
    };
    db._state.tables.identity_shadow_runs.push({ id: 99, status: 'running', started_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString() });
    db._state.seq.identity_shadow_runs = 99;
    const r = await W.run(db, { log: quiet });
    ok(!r.failed && !r.skipped, '만료된 잠금은 회수한다', JSON.stringify(r).slice(0, 120));
    const stale = db._state.tables.identity_shadow_runs.find(x => x.id === 99);
    ok(stale.status === 'failed' && stale.error_reason === 'stale_running_reclaimed', '죽은 run 을 failed 로 내린다', stale.status);
  }
  {
    // 잠금 반납은 자기 토큰일 때만
    const db = fakeDb({});
    db._state.tables.identity_shadow_job_state[0] = { id: 1, status: 'running', lock_token: 'mine', lock_until: null };
    await W.releaseLock(db, { result: W.LOCK.ACQUIRED, token: 'not-mine' }, 1, {}, { log: quiet });
    ok(db._state.tables.identity_shadow_job_state[0].lock_token === 'mine', '남의 잠금은 풀지 않는다');
  }

  /* ================================================================
   *  J. bridge poisoning — shadow 경로에서도 유지
   * ================================================================ */
  console.log('=== J. bridge poisoning ===');
  {
    const products = [
      { id: 1, product_id: 'p1', mall: '쿠팡', title: 'Apple 아이폰 17 Pro 256GB 블랙 자급제', lprice: 1599000, vendor_item_id: '', collected_at: '2026-10-13T00:00:00Z' },
      { id: 2, product_id: 'p2', mall: 'ADPICK', title: 'Apple 아이폰 17 Pro 블랙 자급제', lprice: 1550000, vendor_item_id: '', collected_at: '2026-10-13T00:00:00Z' },
      { id: 3, product_id: 'p3', mall: 'ADPICK', mall_label: 'SSG', title: 'Apple 아이폰 17 Pro 512GB 블랙 자급제', lprice: 1799000, vendor_item_id: '', collected_at: '2026-10-13T00:00:00Z' }
    ];
    const db = fakeDb({ products });
    const r = await W.run(db, { log: quiet });
    ok(!r.failed, 'run 성공', r.reason);
    const members = db._state.tables.identity_shadow_group_members;
    const groupOf = new Map(members.map(m => [m.product_id, m.group_id]));
    ok(!(groupOf.has('p1') && groupOf.has('p3') && groupOf.get('p1') === groupOf.get('p3')),
      '★ 256GB 와 512GB 가 같은 그룹에 들어가지 않는다');
    ok(db._state.tables.identity_shadow_reviews.length > 0, '용량을 모르는 쌍은 REVIEW 로 남는다');
    const rev = db._state.tables.identity_shadow_reviews[0];
    ok(rev.left_offer_key < rev.right_offer_key, 'REVIEW 쌍은 정렬된 순서로 저장');
    ok(Array.isArray(rev.unknown) && rev.unknown.includes('storage'), 'unknown 에 storage 가 남는다', JSON.stringify(rev.unknown));
    ok(rev.decision === 'REVIEW' && rev.confidence > 0, 'REVIEW 행의 판정·신뢰도');
  }

  /* ================================================================
   *  K. 멱등성 · 순수 함수 계약
   * ================================================================ */
  console.log('=== K. 멱등성 · 계약 ===');
  {
    // 같은 스냅숏을 두 번 돌리면 run 두 개가 «독립적으로» 쌓인다 (덮어쓰지 않는다)
    const db = fakeDb({ products: sampleProducts() });
    await W.run(db, { log: quiet });
    await W.run(db, { log: quiet });
    const runs = db._state.tables.identity_shadow_runs;
    ok(runs.length === 2, '두 번 돌리면 run 두 개', String(runs.length));
    ok(runs.every(r => r.status === 'completed'), '둘 다 completed');
    const g = db._state.tables.identity_shadow_groups;
    ok(g.length === 2 && g[0].group_key === g[1].group_key,
      '같은 묶음은 run 이 달라도 같은 group_key (비교 가능)', g.map(x => x.group_key).join(' '));
    ok(g[0].run_id !== g[1].run_id, 'run 별로 분리 저장 — 감사 추적이 남는다');
  }
  {
    ok(SH.groupKeyOf(['b', 'a']) === SH.groupKeyOf(['a', 'b']), 'group_key 는 순서에 무관하다');
    ok(SH.groupKeyOf(['a', 'b']) !== SH.groupKeyOf(['a', 'c']), '구성원이 다르면 다른 group_key');
    ok(SH.storableGroups([{ members: ['a'] }, { members: ['a', 'b'] }]).length === 1, '1인 그룹은 저장하지 않는다');
    const rows = SH.buildReviewRows([
      { a: { key: 'z', productId: 'z', mall: 'm' }, b: { key: 'a', productId: 'a', mall: 'm' }, result: { decision: 'REVIEW', confidence: 0.5, unknown: ['color'], evidence: [], conflicts: [] } },
      { a: { key: 'a', productId: 'a', mall: 'm' }, b: { key: 'z', productId: 'z', mall: 'm' }, result: { decision: 'REVIEW', confidence: 0.5, unknown: ['color'], evidence: [], conflicts: [] } }
    ]);
    ok(rows.length === 1, 'A-B 와 B-A 는 한 행으로 접는다');
    ok(rows[0].left_offer_key === 'a' && rows[0].right_offer_key === 'z', '정렬된 순서로 저장');
  }
  {
    // 배치 경계: batchSize 를 1 로 줄여도 같은 결과
    const db = fakeDb({ products: sampleProducts() });
    const r = await W.run(db, { log: quiet, batchSize: 1 });
    ok(!r.failed && db._state.tables.identity_shadow_group_members.length === 2, 'batchSize=1 에서도 같은 결과');
    const inserts = db._state.writes.filter(w => w.table === 'identity_shadow_group_members' && w.op === 'insert');
    ok(inserts.length === 2, '묶음이 쪼개져 두 번 보내진다', String(inserts.length));
  }
  {
    // --limit / --mall
    const db = fakeDb({ products: sampleProducts() });
    const r = await W.run(db, { log: quiet, dryRun: true, limit: 2 });
    ok(r.stats.source_product_count === 2, '--limit 가 대상 수를 줄인다', String(r.stats.source_product_count));
    const db2 = fakeDb({ products: sampleProducts() });
    const r2 = await W.run(db2, { log: quiet, dryRun: true, malls: ['쿠팡'] });
    ok(r2.stats.source_product_count === 2, '--mall 로 판매처를 고른다', String(r2.stats.source_product_count));
    ok(r2.groups === 0, '쿠팡만 보면 묶일 짝이 없다', String(r2.groups));
  }
  {
    const parsed = W.parseArgs(['--dry-run', '--limit', '50', '--mall', '쿠팡', '--mall', 'ADPICK', '--sample', '5']);
    ok(parsed.dryRun && parsed.limit === 50 && parsed.malls.length === 2 && parsed.sample === 5,
      'CLI 인자 파싱', JSON.stringify(parsed));
  }
  {
    // 표가 아직 없으면 (마이그레이션 전) 조용히 건너뛴다 — 배포만으로 깨지지 않는다
    const db = fakeDb({ products: sampleProducts() });
    delete db._state.tables.identity_shadow_job_state;
    const r = await W.run(db, { log: quiet });
    ok(r.skipped === true && r.reason === 'table_missing', '마이그레이션 전에는 skip', JSON.stringify(r));
  }

  /* ================================================================ */
  console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
  if (fail) {
    console.log(failures.map(f => `  - ${f}`).join('\n'));
    process.exit(1);
  }
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
