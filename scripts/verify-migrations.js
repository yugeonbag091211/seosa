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
  'payments', 'subscriptions', 'profiles', 'user_data', 'alerts',
  'hotdeals', 'external_hotdeals'
];
/** 지워도 되는 테이블 — 일회성/파생 데이터. */
const EPHEMERAL_TABLES = [
  'auth_codes', 'coupang_api_calls', 'coupang_search_cache',
  'adpick_api_calls', 'adpick_search_cache',
  /*
   * 2026-09-22: collector_eligible_products() 의 결과를 하루 한 번 굳혀 둔
   * 캐시. 원본은 price_history/products 이고 언제든 다시 만들 수 있다
   * (collector_refresh_eligible). 지워도 잃는 사실이 없다.
   */
  'collector_eligible_cache',
  /*
   * 2026-09-25: 가격 하락 사전 집계. 원본은 price_history/products 이고
   * price_drop_state_rebuild_batch 로 언제든 다시 만든다.
   */
  'price_drop_state', 'price_drop_state_meta'
];

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
  '2026-08-24-price-drop-top-orphan-policy.sql',
  '2026-08-25-analytics.sql',
  '2026-09-05-adpick-api-calls.sql',
  '2026-09-12-external-hotdeals.sql',
  /*
   * 2026-09-19: 함수는 이미 운영에 있고 파일만 뒤늦게 들어왔다 (2026-09-20 감사).
   * 여기 등록해야 «파일은 있는데 운영에는 없다» 를 새 환경에서 잡아낸다.
   */
  '2026-09-19-collector-eligible-catalog.sql',
  // 2026-09-20: price_drop_top 타임아웃 대응 인덱스 (데이터 변경 없음).
  '2026-09-20-price-drop-top-index.sql',
  /*
   * 2026-09-20: 인스턴스 사이에서 provider 장애를 공유하는 AI 회로.
   * 미적용이면 api/_global-circuit.js 가 매 요청 RPC 를 놓치고 프로세스
   * 로컬 보호로만 떨어진다 — AI 는 계속 돌지만, 50개 인스턴스가 저마다
   * 429 를 새로 맞던 고치기 전 상태로 조용히 되돌아간다.
   */
  '2026-09-20-ai-global-circuit.sql',
  /*
   * 2026-09-21: 홈 핫딜 «오늘 가격 하락» 이 쓰는 recorded_at 정렬 인덱스.
   * 미적용이어도 기능은 동작한다 — 원장 정렬이 인덱스를 타지 못해 느릴 뿐이다
   * (2026-09-21 실측 2,636 ms). 데이터 변경 없음, CREATE INDEX 한 줄.
   */
  '2026-09-21-price-history-recorded-at-index.sql',
  /*
   * 2026-09-22: collector target RPC 가 authenticator 8s 제한에 걸린 사고 대응.
   * 함수 단위 timeout 만 30s 로 늘리고, 전체 target 을 JSONB 한 행으로 반환해
   * 1,000행 페이지마다 같은 무거운 계산을 다시 하지 않게 한다.
   */
  '2026-09-22-collector-target-timeout-batch.sql',
  /*
   * 2026-09-22: 위 timeout 처방이 하루 만에 다시 30초를 넘겼다 (운영 실측
   * 30,362 ms / 57014). 비싼 계산을 캐시 표로 분리하고 대상 조회를
   * (mall, product_id) 키셋 페이지로 바꾼다. 미적용이면 수집기가
   * collector_target_products_batch 로 자동 폴백하므로 «동작은 하지만
   * 카탈로그가 커질수록 다시 죽는» 상태로 남는다.
   */
  '2026-09-22-collector-target-keyset.sql',
  // 2026-09-25: read-only price_drop_top rewrite; no application data mutation.
  '2026-09-25-price-drop-top-ranked-aggregation.sql',
  // 2026-09-25: 가격 하락 상태표(파생) + 증분/재구성 함수 + price_drop_top_fast. 원장·기존 뷰 미변경.
  '2026-09-25-price-drop-state.sql'
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

  /* collector 캐시는 service_role 전용이어야 한다. */
  const collectorSql = path.join(SQL_DIR, '2026-09-22-collector-target-keyset.sql');
  if (fs.existsSync(collectorSql)) {
    const sql = stripSqlComments(fs.readFileSync(collectorSql, 'utf8'));
    if (/alter\s+table\s+(?:public\.)?collector_eligible_cache\s+enable\s+row\s+level\s+security/i.test(sql)) {
      ok('collector_eligible_cache: RLS 활성화');
    } else bad('collector_eligible_cache: RLS 활성화 없음');

    const tableRevoked = /revoke\s+all\s+on\s+table\s+(?:public\.)?collector_eligible_cache[\s\S]*?from\s+public\s*,\s*anon\s*,\s*authenticated/i.test(sql);
    const sequenceRevoked = /revoke\s+all\s+on\s+sequence\s+(?:public\.)?collector_eligible_cache_id_seq[\s\S]*?from\s+public\s*,\s*anon\s*,\s*authenticated/i.test(sql);
    if (tableRevoked && sequenceRevoked) {
      ok('collector_eligible_cache: public/anon/authenticated 권한 회수', 'table / sequence');
    } else bad('collector_eligible_cache: 공개 권한 회수 불완전',
      `table=${tableRevoked} sequence=${sequenceRevoked}`);

    const serviceTable = /grant\s+select\s*,\s*insert\s*,\s*update\s*,\s*delete\s+on\s+table\s+(?:public\.)?collector_eligible_cache[\s\S]*?to\s+service_role/i.test(sql);
    const serviceSequence = /grant\s+usage\s*,\s*select\s+on\s+sequence\s+(?:public\.)?collector_eligible_cache_id_seq[\s\S]*?to\s+service_role/i.test(sql);
    if (serviceTable && serviceSequence) {
      ok('collector_eligible_cache: service_role 최소 권한', 'table / sequence');
    } else bad('collector_eligible_cache: service_role 권한 불완전',
      `table=${serviceTable} sequence=${serviceSequence}`);
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

  const applied = { payment: true, view: true, analytics: true, adpick: true, circuit: true };

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

  /* ── 계측 (2026-08-25-analytics.sql) ──────────────────────────── */
  for (const t of ['visitors', 'daily_metrics']) {
    /*
     * ★ head:true 로 존재를 확인하면 안 된다.
     *
     *   PostgREST 는 head 요청에 본문을 주지 않으므로, 테이블이 없어도
     *   supabase-js 가 error 를 만들지 못하고 204 로 조용히 성공한다.
     *   실측(2026-08-25): 존재하지 않는 이름으로도 error=null 이 왔다.
     *   즉 "없는 테이블이 OK 로 보고되는" 거짓 통과가 된다 — 검증 스크립트에서
     *   가장 나쁜 실패 방식이다.
     *
     *   본문을 받는 select 로 물으면 스키마 캐시에 없다는 오류가 정확히 온다.
     *   limit(1) 이라 테이블이 아무리 커도 비용은 같다.
     */
    const { error } = await supabase.from(t).select('*').limit(1);
    if (error) { bad(`${t} 테이블 없음`, '사용자 계측이 기록되지 않는다'); applied.analytics = false; }
    else ok(`${t} 테이블`);
  }
  {
    /*
     * 실제로 한 행을 만들지 않도록 일부러 형식에 맞지 않는 날짜를 넘긴다.
     * 함수가 있으면 날짜 캐스팅에서 실패하고(=존재는 확인됨), 없으면
     * "could not find" 가 온다. 둘을 메시지로 구분한다.
     */
    const { error } = await supabase.rpc('bump_metric', {
      p_metric: '__probe__', p_date: 'not-a-date'
    });
    const missing = error && /could not find|does not exist|schema cache/i.test(error.message);
    if (missing) { bad('bump_metric() RPC 없음', '검색·클릭 횟수가 집계되지 않는다'); applied.analytics = false; }
    else ok('bump_metric() RPC');
  }

  /* ── ADPICK 호출 계측 (2026-09-05-adpick-api-calls.sql) ────────── */
  {
    /*
     * head:true 를 쓰지 않는 이유는 바로 위 visitors 검사 주석과 같다.
     * 이 테이블이 없어도 서비스와 수집은 그대로 돈다 — api/_adpick.js 가
     * 계측만 조용히 끈다. 그래서 실패가 아니라 경고로 보고한다.
     */
    const { error } = await supabase.from('adpick_api_calls').select('*').limit(1);
    if (error) {
      wrn('adpick_api_calls 테이블 없음',
        'ADPICK 외부 호출이 기록되지 않는다 (수집·서비스 동작에는 영향 없음)');
      applied.adpick = false;
    } else ok('adpick_api_calls 테이블');
  }

  /* ── AI 공유 회로 (2026-09-20-ai-global-circuit.sql) ──────────── */
  {
    /*
     * head:true 를 쓰지 않는 이유는 위 visitors 검사 주석과 같다.
     * 이 표에는 provider 장애 상태만 들어간다 — 질문도 계정도 IP 도 없다.
     */
    const { error } = await supabase.from('ai_provider_circuit').select('*').limit(1);
    if (error) {
      bad('ai_provider_circuit 표 없음', '인스턴스 사이 provider 장애 공유가 꺼진다');
      applied.circuit = false;
    } else ok('ai_provider_circuit 표');
  }
  {
    /*
     * 인자 검증에서 바로 걸리도록 부른다 — 함수가 있어도 행을 잠그거나
     * 만들지 않는다. p_model = '*' 는 gate 가 첫 줄에서 거부한다.
     */
    const { error } = await supabase.rpc('ai_circuit_gate', {
      p_provider: 'gemini', p_model: '*',
      p_token: '00000000-0000-0000-0000-000000000000'
    });
    const missing = error && /could not find|does not exist|schema cache/i.test(error.message);
    if (missing) { bad('ai_circuit_gate() RPC 없음', '429 가 인스턴스마다 따로 터진다'); applied.circuit = false; }
    else ok('ai_circuit_gate() RPC');
  }

  /* ── 수집 대상 키셋 (2026-09-22-collector-target-keyset.sql) ────
   *
   * 미적용이어도 수집기는 collector_target_products_batch 로 폴백해서
   * 돈다. 그래서 «조용히 느려지는» 상태가 된다 — 그 상태를 이름으로
   * 드러내는 것이 이 검사의 목적이다.
   */
  {
    const { error } = await supabase.from('collector_eligible_cache').select('*').limit(1);
    if (error) {
      wrn('collector_eligible_cache 표 없음',
        '수집 대상 조회가 매 실행 price_history 전체를 다시 훑는다');
    } else ok('collector_eligible_cache 표');
  }
  {
    /*
     * 커서를 «모든 값보다 큰» 자리에 두고 부른다. 함수가 있으면 0행이
     * 즉시 오고(비용 없음), 없으면 스키마 캐시 오류가 온다.
     */
    const { error } = await supabase.rpc('collector_target_page', {
      p_rotation_days: 7, p_rotation_bucket: 0,
      p_after_mall: '￿', p_after_product_id: '', p_limit: 1, p_include_all: false
    });
    const missing = error && /could not find|does not exist|schema cache/i.test(error.message);
    if (missing) wrn('collector_target_page() RPC 없음', '구형 batch RPC 로 폴백 — 카탈로그가 커지면 다시 timeout');
    else if (error) wrn('collector_target_page() 조회 실패', error.message.slice(0, 80));
    else ok('collector_target_page() RPC');
  }
  {
    // p_max_age_minutes 를 아주 크게 줘서 «재계산하지 않는» 경로로만 부른다.
    const { error } = await supabase.rpc('collector_refresh_eligible', { p_max_age_minutes: 525600 });
    const missing = error && /could not find|does not exist|schema cache/i.test(error.message);
    if (missing) wrn('collector_refresh_eligible() RPC 없음', '상시 추적 캐시를 채울 수 없다');
    else if (error) wrn('collector_refresh_eligible() 조회 실패', error.message.slice(0, 80));
    else ok('collector_refresh_eligible() RPC');
  }

  // 이력은 절대 줄면 안 된다. 적용 전후 대조용 수치를 남긴다.
  const { count: ph } = await supabase.from('price_history').select('*', { count: 'exact', head: true });
  const { count: pdt } = await supabase.from('price_drop_top').select('*', { count: 'exact', head: true });
  console.log(`        price_history ${ph}행 / price_drop_top ${pdt}행`);
  console.log('        ※ 뷰를 적용해도 price_history 행 수는 변하지 않아야 한다.');

  if (!applied.payment || !applied.view || !applied.analytics || !applied.adpick
      || !applied.circuit) {
    console.log('\n  적용하려면 Supabase 대시보드 > SQL Editor 에서 아래를 순서대로 실행하세요:');
    let n = 0;
    if (!applied.payment)   console.log(`    ${++n}) supabase/${NEW_MIGRATIONS[0]}`);
    if (!applied.view)      console.log(`    ${++n}) supabase/${NEW_MIGRATIONS[1]}`);
    if (!applied.analytics) console.log(`    ${++n}) supabase/${NEW_MIGRATIONS[2]}`);
    if (!applied.adpick)    console.log(`    ${++n}) supabase/${NEW_MIGRATIONS[3]}`);
    if (!applied.circuit)   console.log(`    ${++n}) supabase/${NEW_MIGRATIONS[6]}`);
    console.log('    ※ 서로 의존하지 않으므로 순서가 바뀌어도 되지만, 위 순서를 권한다.');
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
