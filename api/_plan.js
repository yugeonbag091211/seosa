'use strict';
/*
 * AI Concierge 요금제 · 사용량 한도.
 *
 * ── 이 파일이 존재하는 이유 ──────────────────────────────────────────
 * /api/ai 는 호출 1회당 OpenRouter 요금이 실제로 나간다. 지금까지 이 엔드포인트는
 * 인증이 없었고(익명 호출 가능), 방어라고는 인메모리 레이트리미터 하나뿐이었다.
 * 서버리스에서 인메모리 카운터는 인스턴스마다 따로 놀기 때문에 사실상
 * "조금 성가시게 하는 것" 이상은 못 된다. 즉 누구든 우리 OpenRouter 잔액을
 * 원하는 만큼 태울 수 있는 상태였다.
 *
 * 여기서 정하는 것은 두 가지뿐이다.
 *   1. 이 사용자가 오늘 몇 번 쓸 수 있는가 (plan)
 *   2. 지금 이 요청이 그 한도 안인가 (quota reservation)
 *
 * ── 반드시 지켜야 하는 것 ────────────────────────────────────────────
 *   · 한도 판정은 전부 서버/DB 에서 한다. 프론트의 카운터는 표시용이며
 *     보안 장치가 아니다.
 *   · plan 은 절대 요청 body 에서 읽지 않는다. 서명 검증된 이메일로 DB 를 본다.
 *   · 사용량 증가는 원자적이어야 한다. select → 비교 → update 로 나누면
 *     동시에 20개를 쏘아 한도를 우회할 수 있다 (reserve() 주석 참고).
 */

const supabase = require('./_supabase');
const { kstToday } = require('./_kst');

/* ── 한도 ─────────────────────────────────────────────────────────────
 *
 * 숫자는 여기에서만 정의한다. api/ai.js 나 프론트에 흩어 놓으면 정책을 바꿀 때
 * 한 곳을 놓치고, 그 순간 표시값과 실제 차단 지점이 어긋난다.
 *
 * 환경변수로 덮을 수 있게 해 두되 기본값을 반드시 둔다 — 환경변수가 없다고
 * 해서 무제한이 되면 안 된다.
 *
 * ★ '무제한' 플랜은 만들지 않는다. 무제한은 곧 "청구서 상한 없음" 이다.
 */
const FREE_DAILY_AI_LIMIT = Number(process.env.FREE_DAILY_AI_LIMIT) || 3;
const PRO_DAILY_AI_LIMIT  = Number(process.env.PRO_DAILY_AI_LIMIT)  || 50;

const PLAN = { FREE: 'free', PRO: 'pro' };
const STATUS = { ACTIVE: 'active', INACTIVE: 'inactive' };

/** 요금제 → 하루 한도. 모르는 값이면 가장 보수적인 FREE 로 떨어진다. */
function limitFor(plan) {
  return plan === PLAN.PRO ? PRO_DAILY_AI_LIMIT : FREE_DAILY_AI_LIMIT;
}

/* ── 요금제 판정 ──────────────────────────────────────────────────────
 *
 * PRO 조건은 세 가지를 모두 만족해야 한다.
 *   plan   = 'pro'
 *   status = 'active'
 *   expires_at 이 없거나(무기한) 아직 지나지 않았다
 *
 * 하나라도 어긋나면 FREE 다. 만료·해지가 자동으로 FREE 로 떨어지는 구조라
 * 별도의 만료 배치가 필요 없다 — 배치에 의존하면 그 배치가 죽은 날 만료된
 * 사용자가 계속 PRO 로 남는다.
 * ------------------------------------------------------------------ */

/**
 * @param {object|null} row  subscriptions 행 (없으면 null)
 * @param {Date} [now]
 * @returns {{plan: string, limit: number, reason: string}}
 */
function resolvePlanFromRow(row, now = new Date()) {
  const free = reason => ({ plan: PLAN.FREE, limit: FREE_DAILY_AI_LIMIT, reason });

  // 구독 행이 아예 없는 기존 사용자 — 정상이다. FREE 로 본다.
  if (!row) return free('구독 정보 없음');
  if (row.plan !== PLAN.PRO) return free('무료 요금제');
  if (row.status !== STATUS.ACTIVE) return free('구독이 활성 상태가 아님');

  if (row.expires_at) {
    const exp = Date.parse(row.expires_at);
    // 만료일을 못 읽으면 PRO 로 쳐주지 않는다. 값이 깨졌을 때 유료 권한이
    // 열리는 방향으로 실패하면 안 된다.
    if (!Number.isFinite(exp)) return free('만료일을 읽을 수 없음');
    if (exp <= now.getTime()) return free('구독 만료');
  }

  return { plan: PLAN.PRO, limit: PRO_DAILY_AI_LIMIT, reason: '' };
}

/**
 * 검증된 이메일로 요금제를 조회한다.
 *
 * 조회에 실패하면 FREE 로 떨어진다 — DB 가 흔들릴 때 유료 권한이 열리는
 * 것보다, 무료 한도로 좁게 동작하는 쪽이 안전하다.
 */
async function resolvePlan(email, now = new Date()) {
  if (!email) return resolvePlanFromRow(null, now);

  const { data, error } = await supabase
    .from('subscriptions')
    .select('email, plan, status, expires_at')
    .eq('email', email)
    .maybeSingle();

  if (error) {
    console.warn(`[plan] 구독 조회 실패(무료로 처리): ${error.message}`);
    return resolvePlanFromRow(null, now);
  }
  return resolvePlanFromRow(data || null, now);
}

/* ── 사용량 예약 ──────────────────────────────────────────────────────
 *
 * ★ 왜 RPC 인가 — 이 코드를 이렇게 쓰면 안 되기 때문이다.
 *
 *     const { used } = await select(...)      // 2
 *     if (used < limit)                        // 통과
 *     await update({ used: used + 1 })         // 3
 *
 *   요청 20개가 거의 동시에 들어오면 20개 전부 같은 used=2 를 읽고 전부
 *   통과한 뒤 전부 3 으로 쓴다. 한도 3인 사용자가 20번 호출하고, 그만큼
 *   OpenRouter 요금이 나간다. 실제로 유료화에서 가장 먼저 뚫리는 지점이다.
 *
 *   그래서 "읽고-비교하고-쓰는" 일을 한 문장으로 DB 에 맡긴다.
 *
 *     insert ... on conflict do update
 *       set used = ai_usage.used + 1
 *       where ai_usage.used < p_limit
 *       returning used
 *
 *   UPDATE ... WHERE 가 행 잠금을 잡으므로 동시 요청은 직렬화되고, 한도를
 *   넘는 순간부터는 조건이 거짓이 되어 아무 행도 반환되지 않는다.
 *   → 반환 행이 없으면 그 요청은 거절이다.
 * ------------------------------------------------------------------ */

/**
 * 오늘(KST) 사용량 1회를 예약한다.
 *
 * @returns {{allowed: boolean, used: number, limit: number, degraded?: boolean}}
 *   allowed=false 면 호출부는 OpenRouter 를 단 한 번도 부르지 않고 429 를 준다.
 */
async function reserve(email, limit, now = new Date()) {
  const usageDate = kstToday(now);

  // 한도가 0 이하면 DB 까지 갈 것도 없다. (RPC 의 최초 INSERT 는 한도와
  // 무관하게 1 을 넣으므로, 0 한도를 여기서 막지 않으면 1회가 새어 나간다)
  if (!(limit > 0)) return { allowed: false, used: 0, limit: 0 };

  const { data, error } = await supabase.rpc('ai_quota_reserve', {
    p_email: email,
    p_date: usageDate,
    p_limit: limit
  });

  if (error) {
    /*
     * 여기서 통과시키면 안 된다.
     *
     * 마이그레이션이 아직 적용되지 않았거나 DB 가 흔들리는 상황인데, 그때
     * "일단 허용" 으로 열어 두면 정확히 그 순간에 한도 없는 AI 호출이 나간다.
     * 비용이 걸린 기능은 확실할 때만 열어야 한다 (fail closed).
     */
    console.error(`[plan] 사용량 예약 실패(요청 거절): ${error.message}`);
    return { allowed: false, used: 0, limit, degraded: true };
  }

  // supabase-js 는 returns table 을 배열로 준다.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { allowed: false, used: 0, limit, degraded: true };

  return {
    allowed: !!row.allowed,
    used: Number(row.used) || 0,
    limit
  };
}

/**
 * 예약했던 1회를 되돌린다.
 *
 * 업스트림(OpenRouter)이 5xx·타임아웃으로 죽어서 사용자가 답을 못 받은 경우에만
 * 부른다. 사용자의 잘못이 아닌 실패로 한도를 깎으면, 장애가 날수록 사용자가
 * 손해를 보는 구조가 된다.
 *
 * 반대로 정상 4xx(질문이 비었다 등)는 애초에 예약 전에 걸러지고, 정상 응답은
 * 당연히 소비를 유지한다.
 *
 * 되돌리기가 실패해도 요청 처리 자체를 실패로 만들지 않는다 — 사용자에게는
 * 이미 업스트림 오류를 알려야 하는 상황이고, 1회 오차보다 그게 중요하다.
 */
async function release(email, now = new Date()) {
  const usageDate = kstToday(now);
  const { error } = await supabase.rpc('ai_quota_release', {
    p_email: email,
    p_date: usageDate
  });
  if (error) console.warn(`[plan] 사용량 되돌리기 실패(무시): ${error.message}`);
  return !error;
}

/**
 * 차감하지 않고 오늘 사용량만 읽는다 (프론트 표시용).
 * 실패하면 used=0 으로 본다 — 표시가 조금 틀리는 것뿐이고, 차단 판정은
 * 언제나 reserve() 가 한다.
 */
async function peek(email, now = new Date()) {
  const { data, error } = await supabase
    .from('ai_usage')
    .select('used')
    .eq('email', email)
    .eq('usage_date', kstToday(now))
    .maybeSingle();
  if (error) {
    console.warn(`[plan] 사용량 조회 실패: ${error.message}`);
    return 0;
  }
  return (data && Number(data.used)) || 0;
}

/**
 * 프론트로 내보낼 사용량 요약.
 * 구독 내부 정보(status·expires_at 등)는 담지 않는다.
 */
function usagePayload(plan, used, limit) {
  const u = Math.max(0, Number(used) || 0);
  const l = Math.max(0, Number(limit) || 0);
  return { plan, used: u, limit: l, remaining: Math.max(0, l - u) };
}

module.exports = {
  FREE_DAILY_AI_LIMIT, PRO_DAILY_AI_LIMIT, PLAN, STATUS,
  limitFor, resolvePlanFromRow, resolvePlan,
  reserve, release, peek, usagePayload
};
