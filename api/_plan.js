'use strict';
/*
 * 구독 상태 판정.
 *
 * AI 질문 횟수는 FREE/PRO 모두 제한하지 않는다. 과거의 ai_usage 테이블과
 * ai_quota_reserve/release RPC는 기존 운영 데이터를 보존하기 위해 DB에 남겨
 * 두지만, Production 요청 경로에서는 읽거나 호출하지 않는다. 폭주 방어는
 * api/_ratelimit.js의 짧은 IP 윈도우가 별도로 담당한다.
 */

const supabase = require('./_supabase');

const PLAN = { FREE: 'free', PRO: 'pro' };
const STATUS = { ACTIVE: 'active', INACTIVE: 'inactive' };

function resolvePlanFromRow(row, now = new Date()) {
  const free = reason => ({ plan: PLAN.FREE, reason });
  if (!row) return free('구독 정보 없음');
  if (row.plan !== PLAN.PRO) return free('무료 요금제');
  if (row.status !== STATUS.ACTIVE) return free('구독이 활성 상태가 아님');
  if (row.expires_at) {
    const exp = Date.parse(row.expires_at);
    if (!Number.isFinite(exp)) return free('만료일을 읽을 수 없음');
    if (exp <= now.getTime()) return free('구독 만료');
  }
  return { plan: PLAN.PRO, reason: '' };
}

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

module.exports = { PLAN, STATUS, resolvePlanFromRow, resolvePlan };
