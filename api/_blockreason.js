'use strict';
/*
 * 공급자 차단 사유 판정 — «기다리면 풀리는 전송 장애» 인가, «공급자의 거절» 인가.
 *
 * 쿠팡·ADPICK 모듈은 사유별로 쿨다운을 건다 (네트워크 2분 · 5xx 5분 · 429 15분 ·
 * 401/403 24시간 · rCode 60분). 수집기는 그 쿨다운을 «실행 끝까지» 로 늘려 붙이는
 * 래치를 갖고 있었는데, 2026-09-29 운영에서 8초 타임아웃 한 건(쿨다운 2분)이
 * 쿠팡 레인 46분을, HTTP 504 한 건(쿨다운 5분)이 캐치업 실행의 쿠팡 몫 2.6시간
 * (검색어 996종)을 통째로 멈췄다. 래치는 거절 신호에만 남기고, 전송 장애는
 * 공급자 모듈의 쿨다운 시각까지만 기다리게 하려고 이 판정을 둔다.
 *
 * 모르는 사유는 «거절» 로 본다 — 모르면서 재개하는 것이 가장 위험하다.
 */

// 명시적 거절: 인증·권한·레이트리밋·rCode·차단 안내 페이지·애플리케이션 거절.
const REFUSAL_RE = /HTTP\s*4\d\d|API\s*4\d\d|\b(401|403|429)\b|rCode|HTML 차단|access denied|forbidden|not authorized|success=false|이용이 제한|접근이 거부|too many|rate limit|quota/i;

// 전송 장애: 응답이 없었거나 게이트웨이/서버 오류, 본문 파싱 실패.
const TRANSIENT_RE = /네트워크|시간 초과|timed?\s*out|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|HTTP\s*5\d\d|API\s*5\d\d|파싱 실패/i;

function isTransientBlockReason(reason) {
  const s = String(reason || '');
  if (!s || REFUSAL_RE.test(s)) return false;
  return TRANSIENT_RE.test(s);
}

module.exports = { isTransientBlockReason };
