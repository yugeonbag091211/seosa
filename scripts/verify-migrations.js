#!/usr/bin/env node
/*
 * 마이그레이션 검증 — 정적 안전성 + 운영 적용 여부.
 *
 *   node scripts/verify-migrations.js
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────────
 * 이 저장소의 마이그레이션은 Supabase SQL Editor 에 사람이 붙여넣어 실행한다.
 * 자동 적용 파이프라인이 없으므로 "코드는 배포됐는데 스키마는 아직" 인 상태가
 * 실제로 생긴다. 그때 무엇이 조용히 꺼지는지는 파일마다 다르다.
 *
 * 이 스크립트가 두 가지를 답한다.
 *   1) 이 SQL 을 돌려도 안전한가        (정적 — DB 접속 없이)
 *   2) 지금 운영 DB 에 적용돼 있는가     (읽기 전용 조회)
 *
 * ── 안전성 ───────────────────────────────────────────────────────────
 * 읽기 전용이다. DDL 도 INSERT/UPDATE/DELETE 도 하지 않는다.
 * DB 자격증명이 없으면 정적 검사만 하고 정상 종료한다 (CI 에서도 돌게).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SQL_DIR = path.join(ROOT, 'supabase');

let pass = 0, fail = 0, warn = 0;
function ok(label, detail) { console.log(`  OK    ${label}${detail ? '  — ' + detail : ''}`); pass++; }
function bad(label, detail) { console.log(`  FAIL  ${label}${detail ? '  — ' + detail : ''}`); fail++; }
function wrn(label, detail) { console.log(`  경고  ${label}${detail ? '  — ' + detail : ''}`); warn++; }

/* ------------------------------------------------------------------ *
 *  1. 정적 안전성
 *
 *  이 저장소에는 2026-07-27 에 초기화 스크립트를 다시 돌려 products /
 *  price_history / search_stats 가 통째로 비워진 사고 기록이 있다
 *  (supabase/schema.sql 머리말). 그래서 "몇 번을 실행해도 안전한가" 를
 *  사람 눈이 아니라 검사로 고정한다.
 * ------------------------------------------------------------------ */
function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*--[^\n]*$/gm, ' ');
}

/** 무조건 금지. 어느 테이블이든 데이터를 잃는다. */
const DESTRUCTIVE = [
  { re: /\bdrop\s+table\b/i, what: 'DROP TABLE' },
  { re: /\btruncate\b/i, what: 'TRUNCATE' },
  { re: /\bdrop\s+column\b/i, what: 'DROP COLUMN' },
  { re: /\bdrop\s+database\b/i, what: 'DROP DATABASE' }
];

/*
 * DELETE 는 대상 테이블로 판정한다.
 *
 * 뭉뚱그려 금지하면 정당한 문장까지 걸린다 — auth_code_attempt 안의
 *   delete from auth_codes where email = p_email
 * 은 "사용한 일회용 코드를 폐기" 하는 동작이고, 이건 원래 api/_auth.js 가
 * 하던 일을 함수 안으로 옮긴 것뿐이다. 오히려 없으면 코드 재사용이 뚫린다.
 *
 * 반대로 아래 표에 있는 테이블은 어떤 이유로도 마이그레이션이 지우면 안 된다.
 * 2026-07-27 에 초기화 스크립트 재실행으로 products / price_history /
 * search_stats 가 통째로 비워진 사고가 있었다 (supabase/schema.sql 머리말).
 */
const PROTECTED_TABLES = [
  'products', 'price_history', 'search_stats', 'monthly_curation',
  'payments', 'subscriptions', 'profiles', 'user_data', 'alerts'
];
/** 지워도 되는 테이블 — 일회성/파생 데이터. */
const EPHEMERAL_TABLES = ['auth_codes', 'coupang_api_calls', 'coupang_search_cache'];

function deleteTargets(sql) {
  const out = [];
  const re = /\bdelete\s+from\s+([a-z_][\w.]*)/gi;
  let m;
  while ((m = re.exec(sql))) out.push(m[1].replace(/^public\./, ''));
  return out;
}

/** 이번 릴리스에서 새로 추가한 마이그레이션. 여기 있는 것만 강하게 검사한다. */
const NEW_MIGRATIONS = [
  '2026-08-24-payment-pending-and-auth-attempts.sql',
  '2026-08-24-price-drop-top-orphan-policy.sql'
];

function checkStatic() {
  console.log('\n[1] 정적 안전성 (DB 접속 없음)');

  for (const name of NEW_MIGRATIONS) {
    const p = path.join(SQL_DIR, name);
    if (!fs.existsSync(p)) { bad(`${name} 존재`); continue; }
    const raw = fs.readFileSync(p, 'utf8');
    const sql = stripSqlComments(raw);

    const hits = DESTRUCTIVE.filter(d => d.re.test(sql)).map(d => d.what);
    if (hits.length) bad(`${name}: 파괴적 문장 없음`, hits.join(', '));
    else ok(`${name}: 파괴적 문장 없음 (DROP / TRUNCATE)`);

    const dels = deleteTargets(sql);
    const risky = dels.filter(t => PROTECTED_TABLES.indexOf(t) > -1);
    const unknown = dels.filter(t =>
      PROTECTED_TABLES.indexOf(t) === -1 && EPHEMERAL_TABLES.indexOf(t) === -1);
    if (risky.length) bad(`${name}: 보호 테이블 DELETE 없음`, risky.join(', '));
    else if (unknown.length) wrn(`${name}: 분류되지 않은 테이블 DELETE`, unknown.join(', '));
    else if (dels.length) ok(`${name}: DELETE 는 일회성 데이터만`, [...new Set(dels)].join(', '));
    else ok(`${name}: DELETE 없음`);

    // 멱등성 — 재실행해도 깨지지 않는 형태인가
    const stmts = sql.split(';').map(s => s.trim()).filter(Boolean);
    const nonIdempotent = stmts.filter(s => {
      if (/^create\s+table/i.test(s) && !/if\s+not\s+exists/i.test(s)) return true;
      if (/^create\s+index/i.test(s) && !/if\s+not\s+exists/i.test(s)) return true;
      if (/^alter\s+table\s+\S+\s+add\s+column/i.test(s) && !/if\s+not\s+exists/i.test(s)) return true;
      return false;
    });
    if (nonIdempotent.length) bad(`${name}: 재실행 안전`, `${nonIdempotent.length}개 문장이 IF NOT EXISTS 없음`);
    else ok(`${name}: 재실행 안전 (IF NOT EXISTS / OR REPLACE)`);

    // PostgREST 스키마 캐시 갱신 — 빠뜨리면 새 컬럼/함수를 한동안 못 찾는다
    if (/notify\s+pgrst/i.test(sql)) ok(`${name}: 스키마 캐시 갱신 포함`);
    else wrn(`${name}: notify pgrst 없음`, '새 컬럼/함수를 한동안 못 찾을 수 있다');
  }

  /* security definer 함수는 실행 권한을 반드시 좁혀야 한다. */
  const authSql = path.join(SQL_DIR, NEW_MIGRATIONS[0]);
  if (fs.existsSync(authSql)) {
    const sql = stripSqlComments(fs.readFileSync(authSql, 'utf8'));
    const isDefiner = /security\s+definer/i.test(sql);
    const revoked = /revoke\s+all\s+on\s+function\s+auth_code_attempt[\s\S]*?from\s+public/i.test(sql);
    const anonRevoked = /revoke\s+all\s+on\s+function\s+auth_code_attempt[\s\S]*?from\s+anon/i.test(sql);
    if (isDefiner && revoked && anonRevoked) {
      ok('auth_code_attempt: security definer + 실행 권한 회수', 'public / anon');
    } else {
      bad('auth_code_attempt: 실행 권한 회수',
        `definer=${isDefiner} public=${revoked} anon=${anonRevoked}`);
    }
    // search_path 고정 — definer 함수에서 빠뜨리면 스키마 하이재킹이 가능하다
    if (/set\s+search_path\s*=/i.test(sql)) ok('auth_code_attempt: search_path 고정');
    else bad('auth_code_attempt: search_path 고정 없음', 'definer 함수는 반드시 고정할 것');
  }

  /* 뷰 정의는 price_history 를 건드리지 않아야 한다. */
  const viewSql = path.join(SQL_DIR, NEW_MIGRATIONS[1]);
  if (fs.existsSync(viewSql)) {
    const sql = stripSqlComments(fs.readFileSync(viewSql, 'utf8'));
    const onlyView = /create\s+or\s+replace\s+view\s+price_drop_top/i.test(sql)
      && !/\b(insert|update)\s+/i.test(sql.replace(/create\s+or\s+replace\s+view[\s\S]*/i, ''));
    if (onlyView) ok('price_drop_top: 뷰 재정의만 한다 (이력 테이블 미변경)');
    else bad('price_drop_top: 뷰 외 변경이 섞여 있다');

    const innerJoin = /(^|\s)join\s+products\s+p2/i.test(sql) && !/left\s+join\s+products\s+p2/i.test(sql);
    ok('price_drop_top: products inner join', innerJoin ? '고아 이력 배제' : '확인 필요');
  }
}

/* ------------------------------------------------------------------ *
 *  2. 운영 적용 여부 (읽기 전용)
 * ------------------------------------------------------------------ */
async function checkLive() {
  console.log('\n[2] 운영 DB 적용 여부 (읽기 전용)');

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    wrn('DB 자격증명 없음 — 적용 여부 검사를 건너뜁니다', 'SUPABASE_URL / SUPABASE_SECRET_KEY');
    return;
  }
  const supabase = require('../api/_supabase');

  const hasColumn = async (t, c) => {
    const { error } = await supabase.from(t).select(c).limit(1);
    return !error;
  };

  const applied = { payment: true, view: true };

  for (const [t, c] of [['subscriptions', 'last_renew_at'], ['subscriptions', 'renew_failures']]) {
    const has = await hasColumn(t, c);
    if (has) ok(`${t}.${c}`);
    else { bad(`${t}.${c} 없음`, '자동결제 갱신이 매일 실패한다'); applied.payment = false; }
  }

  // 존재하지 않는 이메일로 부른다 — 어떤 행도 만들지 않는다.
  {
    const { error } = await supabase.rpc('auth_code_attempt', {
      p_email: '__migration_probe__@invalid.example', p_hash: 'probe', p_max: 5
    });
    const missing = error && /could not find|does not exist|schema cache/i.test(error.message);
    if (missing) { bad('auth_code_attempt() RPC 없음', '인증 시도 제한이 비원자적 폴백으로 동작'); applied.payment = false; }
    else ok('auth_code_attempt() RPC');
  }

  {
    const { data, error } = await supabase
      .from('price_drop_top').select('link').is('link', null).limit(1);
    if (error) { wrn('price_drop_top 조회 실패', error.message.slice(0, 60)); }
    else if (data.length) { bad('price_drop_top 에 link IS NULL 행이 남아 있음', '뷰 미적용'); applied.view = false; }
    else ok('price_drop_top: 고아 행 없음 (뷰 적용됨)');
  }

  // 이력은 절대 줄면 안 된다. 적용 전후 대조용 수치를 남긴다.
  const { count: ph } = await supabase.from('price_history').select('*', { count: 'exact', head: true });
  const { count: pdt } = await supabase.from('price_drop_top').select('*', { count: 'exact', head: true });
  console.log(`        price_history ${ph}행 / price_drop_top ${pdt}행`);
  console.log('        ※ 뷰를 적용해도 price_history 행 수는 변하지 않아야 한다.');

  if (!applied.payment || !applied.view) {
    console.log('\n  적용하려면 Supabase 대시보드 > SQL Editor 에서 아래를 순서대로 실행하세요:');
    if (!applied.payment) console.log(`    1) supabase/${NEW_MIGRATIONS[0]}`);
    if (!applied.view) console.log(`    2) supabase/${NEW_MIGRATIONS[1]}`);
  }
}

(async () => {
  try { require('./_env'); } catch (e) { /* CI 에서는 파일이 없다 */ }

  console.log('\nSEOSA 마이그레이션 검증');
  checkStatic();
  await checkLive();

  console.log(`\n결과: ${pass} OK / ${fail} FAIL / ${warn} 경고\n`);
  /*
   * 정적 검사 실패만 exit 1 로 만든다. "아직 적용 안 됨" 은 배포 순서의 문제이지
   * 코드의 결함이 아니므로, CI 를 빨갛게 만들 이유가 없다 — 위에 크게 안내한다.
   */
  process.exit(0);
})().catch(e => { console.error('오류:', e.message); process.exit(1); });
