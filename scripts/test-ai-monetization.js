#!/usr/bin/env node
/*
 * AI Concierge 유료화 테스트 — OpenRouter 호출 0회 / 운영 Supabase 접근 0회.
 *
 *   node scripts/test-ai-monetization.js
 *
 * 무엇을 지키는 테스트인가
 *   /api/ai 는 호출 1회당 실제 요금이 나간다. 여기서 지켜야 하는 것은 네 가지다.
 *     ① 로그인하지 않으면 못 쓴다
 *     ② 요금제는 DB 가 정한다 (클라이언트가 보낸 plan 을 절대 믿지 않는다)
 *     ③ 하루 한도를 동시 요청으로 우회할 수 없다
 *     ④ 한도를 넘긴 요청은 OpenRouter 를 단 한 번도 부르지 않는다
 *   이 중 하나라도 깨지면 청구서로 즉시 돌아온다.
 *
 * 가짜 Supabase 는 ai_quota_reserve 의 원자성까지 흉내 낸다. 그냥 카운터를
 * 올리는 가짜를 쓰면 동시성 테스트가 통과해도 아무것도 증명하지 못한다.
 */
'use strict';

const path = require('path');
const Module = require('module');

/* ------------------------------------------------------------------ *
 *  가짜 Supabase — RPC 의 원자성을 실제와 같게 흉내 낸다.
 * ------------------------------------------------------------------ */
const db = {
  subscriptions: [],           // {email, plan, status, expires_at}
  ai_usage: [],                // {email, usage_date, used}
  rpcCalls: [],                // 호출 로그
  failRpc: false,              // RPC 실패(마이그레이션 미적용) 흉내
  failSubSelect: false
};

function reset() {
  db.subscriptions = [];
  db.ai_usage = [];
  db.rpcCalls = [];
  db.failRpc = false;
  db.failSubSelect = false;
}

function usageRow(email, date) {
  return db.ai_usage.find(r => r.email === email && r.usage_date === date);
}

const fakeSupabase = {
  from(table) {
    const filters = [];
    const q = {
      select() { return q; },
      eq(col, v) { filters.push([col, v]); return q; },
      maybeSingle() {
        if (table === 'subscriptions' && db.failSubSelect) {
          return Promise.resolve({ data: null, error: { message: 'boom' } });
        }
        const rows = (db[table] || []).filter(r =>
          filters.every(([c, v]) => String(r[c]) === String(v)));
        return Promise.resolve({ data: rows[0] || null, error: null });
      }
    };
    return q;
  },

  /*
   * ★ 원자성 흉내.
   *
   * 실제 Postgres 는 `on conflict do update ... where used < limit` 에서
   * 행 잠금으로 동시 요청을 직렬화한다. Node 는 단일 스레드이고 아래 함수
   * 본문에는 await 가 없으므로, 이 함수가 통째로 원자적으로 실행된다 —
   * 실제 DB 와 같은 성질이다. (중간에 await 를 넣으면 이 성질이 깨지므로
   * 절대 넣지 말 것)
   */
  rpc(name, args) {
    db.rpcCalls.push({ name, args });

    if (db.failRpc) {
      return Promise.resolve({ data: null, error: { message: 'function ai_quota_reserve does not exist' } });
    }

    if (name === 'ai_quota_reserve') {
      const { p_email, p_date, p_limit } = args;
      const row = usageRow(p_email, p_date);

      if (p_limit == null || p_limit <= 0) {
        return Promise.resolve({ data: [{ used: row ? row.used : 0, allowed: false }], error: null });
      }
      if (!row) {
        db.ai_usage.push({ email: p_email, usage_date: p_date, used: 1 });
        return Promise.resolve({ data: [{ used: 1, allowed: true }], error: null });
      }
      if (row.used < p_limit) {
        row.used += 1;
        return Promise.resolve({ data: [{ used: row.used, allowed: true }], error: null });
      }
      return Promise.resolve({ data: [{ used: row.used, allowed: false }], error: null });
    }

    if (name === 'ai_quota_release') {
      const { p_email, p_date } = args;
      const row = usageRow(p_email, p_date);
      if (row) row.used = Math.max(0, row.used - 1);
      return Promise.resolve({ data: row ? row.used : 0, error: null });
    }

    return Promise.resolve({ data: null, error: null });
  }
};

// api/_supabase 를 가짜로 바꿔치기 — _plan.js 가 require 하기 전에 해야 한다.
const supabasePath = require.resolve(path.join(__dirname, '..', 'api', '_supabase.js'));
require.cache[supabasePath] = new Module(supabasePath, null);
require.cache[supabasePath].filename = supabasePath;
require.cache[supabasePath].loaded = true;
require.cache[supabasePath].exports = fakeSupabase;

process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'test-secret-for-ai-monetization';

const plan = require('../api/_plan');
const { kstToday } = require('../api/_kst');
const { issueToken, identify } = require('../api/_auth');

/* ------------------------------------------------------------------ *
 *  테스트 유틸
 * ------------------------------------------------------------------ */
let pass = 0, fail = 0;
function check(ok, label, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
}
function section(name) { console.log(`\n${name}`); }

const reqWith = token => ({ headers: token ? { authorization: 'Bearer ' + token } : {} });
const USER = 'user@example.com';
const OTHER = 'other@example.com';

function setSub(email, patch) {
  db.subscriptions.push(Object.assign(
    { email, plan: 'free', status: 'active', expires_at: null }, patch));
}

(async () => {

  /* ================================================================ *
   *  1. 인증 — 신원은 토큰에서만 나온다
   * ================================================================ */
  section('1. 인증 (identify)');
  reset();

  check(identify(reqWith('')).ok === false, '토큰 없음 → 거절');
  check(identify({ headers: {} }).ok === false, 'Authorization 헤더 없음 → 거절');
  check(identify(reqWith('garbage')).ok === false, '형식이 깨진 토큰 → 거절');
  check(identify(reqWith('v1.aaa.bbb')).ok === false, '서명이 틀린 토큰 → 거절');

  const tok = issueToken(USER);
  const id = identify(reqWith(tok));
  check(id.ok === true && id.email === USER, '유효 토큰 → 이메일 확정', id.email);

  const expired = issueToken(USER, -1000);
  check(identify(reqWith(expired)).ok === false, '만료된 토큰 → 거절');

  section('1-b. 이메일 스푸핑 방어');
  // 공격자가 body 에 남의 이메일을 넣어도 신원은 토큰에서만 나온다.
  const attacker = identify(reqWith(issueToken(OTHER)));
  check(attacker.email === OTHER, '토큰의 이메일이 곧 신원 (body 는 보지 않는다)', attacker.email);
  check(attacker.email !== USER, '다른 사람의 신원을 가로챌 수 없다');

  /* ================================================================ *
   *  2. 요금제 판정 — DB 가 정한다
   * ================================================================ */
  section('2. 요금제 판정 (resolvePlan)');
  const NOW = new Date('2026-08-17T03:00:00Z');

  reset();
  let p = await plan.resolvePlan(USER, NOW);
  check(p.plan === 'free' && p.limit === 3, '구독 행 없음 → FREE 3회', `${p.plan}/${p.limit}`);

  reset(); setSub(USER, { plan: 'pro', status: 'active', expires_at: '2026-12-31T00:00:00Z' });
  p = await plan.resolvePlan(USER, NOW);
  check(p.plan === 'pro' && p.limit === 50, '활성 PRO → 50회', `${p.plan}/${p.limit}`);

  reset(); setSub(USER, { plan: 'pro', status: 'active', expires_at: null });
  p = await plan.resolvePlan(USER, NOW);
  check(p.plan === 'pro' && p.limit === 50, '무기한 PRO(expires_at null) → 50회');

  reset(); setSub(USER, { plan: 'pro', status: 'active', expires_at: '2026-08-01T00:00:00Z' });
  p = await plan.resolvePlan(USER, NOW);
  check(p.plan === 'free' && p.limit === 3, '만료된 PRO → FREE 자동 강등', `${p.plan}/${p.limit}`);

  reset(); setSub(USER, { plan: 'pro', status: 'inactive', expires_at: '2026-12-31T00:00:00Z' });
  p = await plan.resolvePlan(USER, NOW);
  check(p.plan === 'free', '해지(inactive) PRO → FREE');

  reset(); setSub(USER, { plan: 'pro', status: 'active', expires_at: 'not-a-date' });
  p = await plan.resolvePlan(USER, NOW);
  check(p.plan === 'free', '만료일이 깨진 값 → FREE (유료 권한이 열리는 방향으로 실패하지 않는다)');

  reset(); db.failSubSelect = true;
  p = await plan.resolvePlan(USER, NOW);
  check(p.plan === 'free', '구독 조회 실패 → FREE (안전한 쪽으로)');

  section('2-b. plan 스푸핑 방어');
  reset(); setSub(USER, { plan: 'free', status: 'active' });
  // resolvePlan 은 이메일만 받는다 — 요청 body 를 넣을 자리가 애초에 없다.
  p = await plan.resolvePlan(USER, NOW);
  check(p.plan === 'free' && p.limit === 3,
        'body 에 plan=pro 를 보내도 반영될 통로가 없다', `${p.plan}/${p.limit}`);
  check(plan.resolvePlanFromRow({ plan: 'pro', status: 'active', expires_at: null }, NOW).plan === 'pro',
        '(대조) DB 행이 pro 면 pro');

  /* ================================================================ *
   *  3. 사용량 한도
   * ================================================================ */
  section('3. FREE 하루 3회');
  reset();
  const r1 = await plan.reserve(USER, 3, NOW);
  const r2 = await plan.reserve(USER, 3, NOW);
  const r3 = await plan.reserve(USER, 3, NOW);
  const r4 = await plan.reserve(USER, 3, NOW);
  check(r1.allowed && r1.used === 1, '1회차 성공', String(r1.used));
  check(r2.allowed && r2.used === 2, '2회차 성공', String(r2.used));
  check(r3.allowed && r3.used === 3, '3회차 성공', String(r3.used));
  check(r4.allowed === false, '4회차 거절 ★');
  check(r4.used === 3, '거절된 요청은 사용량을 늘리지 않는다', String(r4.used));

  section('3-b. PRO 하루 50회');
  reset();
  let ok50 = 0;
  for (let i = 0; i < 50; i++) if ((await plan.reserve(USER, 50, NOW)).allowed) ok50++;
  const r51 = await plan.reserve(USER, 50, NOW);
  check(ok50 === 50, '50회 전부 성공', String(ok50));
  check(r51.allowed === false, '51회차 거절 ★');

  section('3-c. 한도 0 / 음수');
  reset();
  const rz = await plan.reserve(USER, 0, NOW);
  check(rz.allowed === false, '한도 0 → 거절 (최초 1회가 새지 않는다)');
  check(usageRow(USER, kstToday(NOW)) === undefined, '행 자체가 만들어지지 않는다');

  /* ================================================================ *
   *  4. 동시성 — 가장 중요한 테스트
   * ================================================================ */
  section('4. 동시 요청으로 한도를 우회할 수 없다');
  reset();
  const results = await Promise.all(
    Array.from({ length: 20 }, () => plan.reserve(USER, 3, NOW))
  );
  const granted = results.filter(r => r.allowed).length;
  check(granted === 3, `동시 20건 중 정확히 3건만 승인 ★★`, String(granted));
  check(usageRow(USER, kstToday(NOW)).used === 3, 'DB 사용량도 3에서 멈춘다',
        String(usageRow(USER, kstToday(NOW)).used));

  const usedValues = results.filter(r => r.allowed).map(r => r.used).sort();
  check(JSON.stringify(usedValues) === '[1,2,3]',
        '승인된 요청의 used 가 1,2,3 으로 유일하다 (중복 없음)', usedValues.join(','));

  section('4-b. 사용자별로 사용량이 격리된다');
  reset();
  await plan.reserve(USER, 3, NOW);
  await plan.reserve(USER, 3, NOW);
  const otherFirst = await plan.reserve(OTHER, 3, NOW);
  check(otherFirst.allowed && otherFirst.used === 1,
        '다른 사용자는 자기 카운터를 쓴다', String(otherFirst.used));

  /* ================================================================ *
   *  5. KST 날짜 경계
   * ================================================================ */
  section('5. KST 기준 하루 (UTC 아님)');
  check(kstToday(new Date('2026-08-13T14:59:00Z')) === '2026-08-13', 'UTC 14:59 → KST 08-13');
  check(kstToday(new Date('2026-08-13T15:00:00Z')) === '2026-08-14', 'UTC 15:00 → KST 08-14 ★');
  check(kstToday(new Date('2026-08-13T23:59:00Z')) === '2026-08-14', 'UTC 23:59 → KST 08-14');
  check(kstToday(new Date('2026-12-31T15:00:00Z')) === '2027-01-01', '연말 경계');

  section('5-b. KST 자정에 사용량이 초기화된다');
  reset();
  const before = new Date('2026-08-13T14:59:00Z');   // KST 08-13 23:59
  const after  = new Date('2026-08-13T15:00:00Z');   // KST 08-14 00:00
  await plan.reserve(USER, 3, before);
  await plan.reserve(USER, 3, before);
  await plan.reserve(USER, 3, before);
  const blocked = await plan.reserve(USER, 3, before);
  check(blocked.allowed === false, 'KST 08-13 에 3회를 다 씀 → 4회차 거절');

  const nextDay = await plan.reserve(USER, 3, after);
  check(nextDay.allowed === true && nextDay.used === 1,
        'KST 08-14 로 넘어가면 1회차부터 다시 ★', String(nextDay.used));
  check(usageRow(USER, '2026-08-13').used === 3, '전날 기록은 그대로 남는다');

  /* ================================================================ *
   *  6. 업스트림 실패 → 롤백
   * ================================================================ */
  section('6. 업스트림 실패 시 사용량 되돌리기');
  reset();
  await plan.reserve(USER, 3, NOW);
  const afterReserve = usageRow(USER, kstToday(NOW)).used;
  await plan.release(USER, NOW);
  const afterRelease = usageRow(USER, kstToday(NOW)).used;
  check(afterReserve === 1 && afterRelease === 0,
        '예약 1 → 되돌리기 후 0', `${afterReserve} → ${afterRelease}`);

  reset();
  await plan.release(USER, NOW);   // 예약도 안 한 상태에서 되돌리기
  check(true, '예약 없이 되돌려도 예외가 나지 않는다');
  reset();
  await plan.reserve(USER, 3, NOW);
  await plan.release(USER, NOW);
  await plan.release(USER, NOW);
  check(usageRow(USER, kstToday(NOW)).used === 0, '중복 되돌리기에도 0 밑으로 내려가지 않는다');

  /* ================================================================ *
   *  7. RPC 실패 → fail closed
   * ================================================================ */
  section('7. 마이그레이션 미적용 / DB 장애 → 요청 거절 (fail closed)');
  reset();
  db.failRpc = true;
  const degraded = await plan.reserve(USER, 3, NOW);
  check(degraded.allowed === false, 'RPC 를 못 쓰면 허용하지 않는다 ★');
  check(degraded.degraded === true, 'degraded 플래그로 한도초과와 구분된다');

  /* ================================================================ *
   *  8. 한도 초과 시 OpenRouter 를 부르지 않는다
   * ================================================================ */
  section('8. 비용 방어 — 한도 초과 요청은 LLM 을 부르지 않는다');
  reset();
  // reserve 가 거절하면 호출부(api/ai.js)는 즉시 429 로 빠져나간다.
  // 여기서는 "거절이 OpenRouter 호출보다 먼저 결정된다" 는 것을 확인한다.
  await plan.reserve(USER, 1, NOW);
  const denied = await plan.reserve(USER, 1, NOW);
  check(denied.allowed === false, '한도 초과가 예약 단계에서 확정된다');
  const reserveCalls = db.rpcCalls.filter(c => c.name === 'ai_quota_reserve').length;
  check(reserveCalls === 2, '판정은 DB RPC 한 번으로 끝난다 (LLM 호출 없음)', String(reserveCalls));

  section('8-b. api/ai.js 가 예약을 OpenRouter 보다 먼저 한다 (소스 검증)');
  const fs = require('fs');
  const aiSrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'ai.js'), 'utf8');

  /*
   * 파일 전체에서 문자열 위치를 비교하면 안 된다. LLM 을 부르는 헬퍼
   * (callClassifier / resolveQuery / classifyIntent)는 파일 위쪽에 "정의" 되어
   * 있고 핸들러는 아래쪽에 있어서, 단순 indexOf 로는 정의가 호출보다 앞선
   * 것처럼 보인다. 실제로 봐야 하는 것은 "핸들러 안에서의 실행 순서" 다.
   */
  const handlerAt = aiSrc.indexOf('module.exports = async function handler');
  check(handlerAt > -1, '핸들러를 찾았다');
  const handler = aiSrc.slice(handlerAt);

  const reserveAt = handler.indexOf('plan.reserve(');
  /*
   * 핸들러가 LLM 으로 들어가는 입구 — 분류기 호출과 본답변 호출 둘 다.
   *
   * 2026-08-30 이후 OpenRouter 로 나가는 fetch 는 전부 api/_llm.js 안에 있고,
   * 이 파일은 llm.chat() 만 부른다. 그래서 여기서 찾는 것도 그 진입점이다.
   * (아래에서 이 파일에 날 fetch 가 남아 있지 않은지도 함께 확인한다 —
   *  라우터를 우회하는 호출이 생기면 사슬·타임아웃·예산이 전부 무력해진다)
   */
  // resolveIntent 는 2026-09-02 부터 분류의 진입점이다 (deterministic-first 게이트).
  const llmEntries = ['resolveIntent(', 'classifyIntent(', 'llm.chat(']
    .map(s => handler.indexOf(s))
    .filter(i => i > -1);
  const firstLlmAt = Math.min.apply(null, llmEntries);

  check(reserveAt > -1, 'ai.js 가 plan.reserve 를 호출한다');
  check(llmEntries.length >= 2, '핸들러의 LLM 진입점을 모두 찾았다', String(llmEntries.length));
  check(aiSrc.indexOf('openrouter.ai/api/') === -1,
    '★ ai.js 는 OpenRouter 를 직접 부르지 않는다 (전부 api/_llm.js 사슬을 지난다)');
  check(reserveAt < firstLlmAt, 'plan.reserve 가 핸들러의 첫 LLM 호출보다 앞에 있다 ★',
        `reserve@${reserveAt} < firstLLM@${firstLlmAt}`);

  // 신원 확인과 요금제 판정은 예약보다도 앞이어야 한다.
  const identifyAt = handler.indexOf('identify(req)');
  const resolveAt = handler.indexOf('plan.resolvePlan(');
  check(identifyAt > -1 && identifyAt < reserveAt, '신원 확인이 예약보다 먼저', `${identifyAt} < ${reserveAt}`);
  check(resolveAt > -1 && resolveAt < reserveAt, '요금제 판정이 예약보다 먼저', `${resolveAt} < ${reserveAt}`);
  check(aiSrc.indexOf('identify(req)') > -1, 'ai.js 가 토큰 기반 신원 확인을 한다');
  check(/status\(401\)/.test(aiSrc), '비로그인 → 401');
  check(/status\(429\)/.test(aiSrc), '한도 초과 → 429');
  check(!/req\.body\s*\.\s*plan|body\.plan/.test(aiSrc), 'body 에서 plan 을 읽지 않는다');

  /* ================================================================ *
   *  9. 응답 payload
   * ================================================================ */
  section('9. 사용량 응답 payload');
  const pay = plan.usagePayload('free', 2, 3);
  check(pay.plan === 'free' && pay.used === 2 && pay.limit === 3 && pay.remaining === 1,
        '{plan, used, limit, remaining}', JSON.stringify(pay));
  check(plan.usagePayload('free', 5, 3).remaining === 0, 'remaining 은 음수가 되지 않는다');
  check(Object.keys(pay).length === 4, '구독 내부 정보(status·expires_at)를 노출하지 않는다',
        Object.keys(pay).join(','));

  /* ================================================================ *
   *  10. 한도 상수 중앙화
   * ================================================================ */
  section('10. 한도 상수');
  check(plan.FREE_DAILY_AI_LIMIT === 3, 'FREE = 3');
  check(plan.PRO_DAILY_AI_LIMIT === 50, 'PRO = 50');
  check(plan.limitFor('pro') === 50 && plan.limitFor('free') === 3, 'limitFor 매핑');
  check(plan.limitFor('unknown') === 3, '모르는 요금제는 FREE 로 (무제한이 되지 않는다)');
  const aiSrcHasMagic = /limit:\s*(3|50)\b/.test(aiSrc.replace(/limit:\s*10\b/g, ''));
  check(!aiSrcHasMagic, 'ai.js 에 한도 숫자가 하드코딩되어 있지 않다');

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
  if (fail) process.exitCode = 1;
})().catch(e => {
  console.error('오류:', e.message, e.stack);
  process.exit(1);
});
