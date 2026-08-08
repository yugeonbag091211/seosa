#!/usr/bin/env node
/*
 * 마이그레이션 적용 여부 확인 (읽기 전용).
 *
 * supabase/2026-08-hardening.sql 을 Supabase SQL Editor 에서 실행한 뒤
 * 제대로 반영됐는지 확인하는 용도다. 아무것도 쓰지 않는다.
 *
 *   node scripts/verify-schema.js
 *
 * ※ DDL(alter table / create index)은 PostgREST 로 실행할 수 없어서
 *   스크립트가 대신 적용해 줄 수는 없다. SQL Editor 에 붙여넣어야 한다.
 */
'use strict';

require('./_env');
const supabase = require('../api/_supabase');

let pass = 0, fail = 0;

function report(ok, label, detail) {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
}

/** 컬럼을 직접 select 해서 존재 여부를 본다 (없으면 PostgREST가 오류를 준다). */
async function hasColumn(table, column) {
  const { error } = await supabase.from(table).select(column).limit(1);
  if (!error) return { ok: true };
  return { ok: false, why: error.message.slice(0, 90) };
}

/** RPC 존재 여부 */
async function hasFunction(name, args) {
  const { error } = await supabase.rpc(name, args);
  if (!error) return { ok: true };
  if (/could not find|does not exist|schema cache/i.test(error.message)) {
    return { ok: false, why: '함수 없음' };
  }
  // 인자 타입 오류 등은 "존재는 한다"는 뜻
  return { ok: true, why: error.message.slice(0, 60) };
}

(async () => {
  console.log('\nSEOSA 스키마 점검 (읽기 전용)\n');

  console.log('[2026-08-hardening.sql]');
  for (const [t, c] of [
    ['alerts', 'product_id'],
    ['alerts', 'sent_at'],
    // 이메일 인증 코드 저장소. 없으면 /api/auth 가 동작하지 않고,
    // 그러면 찜/취향/알림 기능 전체가 인증 단계에서 막힌다.
    ['auth_codes', 'code_hash'],
    ['auth_codes', 'expires_at']
  ]) {
    const r = await hasColumn(t, c);
    report(r.ok, `${t}.${c}`, r.ok ? '' : r.why);
  }

  console.log('\n[환경변수]');
  report(!!process.env.SUPABASE_URL, 'SUPABASE_URL');
  report(!!process.env.SUPABASE_SECRET_KEY, 'SUPABASE_SECRET_KEY');
  report(!!process.env.COUPANG_ACCESS_KEY, 'COUPANG_ACCESS_KEY');
  report(!!process.env.RESEND_API_KEY, 'RESEND_API_KEY',
    process.env.RESEND_API_KEY ? '' : '없으면 인증코드·가격알림 메일이 나가지 않습니다');

  console.log('\n[기존 스키마]');
  for (const [t, c] of [
    ['products', 'collected_at'],
    ['products', 'oprice'],
    ['products', 'save_pct'],
    ['price_history', 'recorded_date'],
    ['profiles', 'data'],
    // user_data 는 data jsonb 하나가 아니라 컬럼 3개로 되어 있다.
    // api/sync.js 가 이 스키마에 맞춰져 있으니 여기도 실제 컬럼을 본다.
    ['user_data', 'wish'],
    ['user_data', 'viewed'],
    ['user_data', 'searches']
  ]) {
    const r = await hasColumn(t, c);
    report(r.ok, `${t}.${c}`, r.ok ? '' : r.why);
  }

  console.log('\n[쿠팡 통제 함수 — coupang-quota.sql]');
  const usage = await hasFunction('coupang_usage', {});
  report(usage.ok, 'coupang_usage()', usage.ok ? '' : usage.why);
  const stat = await hasFunction('increment_search_stat', { kw: '__schema_check__' });
  report(stat.ok, 'increment_search_stat(kw)', stat.ok ? '' : stat.why);

  console.log('\n[테이블 접근]');
  for (const t of ['products', 'price_history', 'search_stats', 'monthly_curation',
                   'price_drop_top', 'alerts', 'profiles', 'user_data', 'auth_codes',
                   'coupang_api_calls', 'coupang_api_state', 'coupang_search_cache']) {
    const { error, count } = await supabase.from(t).select('*', { count: 'exact', head: true });
    // 없는 테이블은 오류 없이 count=null 로 돌아올 때가 있다. 그걸 OK 로 세면
    // 출시 전 점검에서 "테이블 있음"으로 잘못 읽힌다.
    const ok = !error && count !== null && count !== undefined;
    report(ok, t, error ? error.message.slice(0, 70) : (ok ? `${count}행` : '테이블 없음'));
  }

  console.log(`\n결과: ${pass}개 통과 / ${fail}개 실패`);
  if (fail) {
    console.log('\n실패 항목이 있으면 Supabase 대시보드 > SQL Editor 에서');
    console.log('supabase/2026-08-hardening.sql 을 붙여넣고 실행하세요.');
    console.log('(schema.sql 은 재실행 금지 — 7월 큐레이션을 덮어씁니다)');
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('오류:', e.message); process.exit(1); });
