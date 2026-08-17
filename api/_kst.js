'use strict';
/*
 * 한국시간(Asia/Seoul) 달력 날짜 — 프로젝트 공통 기준.
 *
 * ── 왜 별도 모듈인가 ──────────────────────────────────────────────
 * "오늘"의 경계는 서비스 전체가 한 기준을 써야 한다. 한쪽은 UTC, 한쪽은 KST
 * 로 자르면 같은 순간이 서로 다른 날짜로 기록되어 집계·한도·차트가 전부
 * 어긋난다. 실제로 price_history 가 recorded_date 를 UTC 로 저장하고
 * price_job_state.job_date 는 KST 로 저장해서, KST 01시 크론이 수집한
 * 하루치가 통째로 어제 날짜로 들어간 사고가 있었다.
 *
 * ai_usage.usage_date 도 같은 기준을 써야 한다. UTC 로 자르면 한국 사용자의
 * 하루 한도가 오전 9시에 초기화된다 — 사용자가 이해할 수 없는 동작이다.
 *
 * KST 는 UTC+9 고정이고 서머타임이 없어서 9시간을 더해 자르면 정확하다.
 */

/**
 * @param {Date|number} [now]
 * @returns {string} 'YYYY-MM-DD' (KST 달력 기준)
 */
function kstToday(now = new Date()) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  const src = Number.isFinite(t) ? t : Date.now();
  return new Date(src + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

module.exports = { kstToday };
