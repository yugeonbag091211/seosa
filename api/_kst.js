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

/**
 * 한국시간(Asia/Seoul) 기준 월 (1~12).
 *
 * ── 왜 new Date().getMonth() 를 쓰면 안 되는가 ──────────────────────
 * getMonth() 는 "런타임의 로컬 시간대" 기준이다. Vercel 함수는 TZ=UTC 로 돈다.
 * 그래서 KST 로 매월 1일 00:00~08:59 사이에는 UTC 가 아직 전달이고,
 *   api/init.js  "이달의 추천"        → 지난달 큐레이션 키워드를 조회
 *   api/cron.js  이달의 큐레이션 수집 → 지난달 키워드를 수집 (KST 03:00 실행)
 * 이 된다. 12월→1월 경계에서는 월이 12 로 나와 연도까지 어긋난다.
 *
 * 개발 머신은 대개 TZ=Asia/Seoul 이라 로컬에서는 정상으로 보인다.
 * 그래서 재현이 안 되고, 매월 1일에만 9시간 동안 조용히 틀린다.
 *
 * kstToday() 가 이미 시간대에 의존하지 않는 문자열을 만들므로 거기서 잘라 쓴다.
 *
 * @param {Date|number} [now]
 * @returns {number} 1~12
 */
function kstMonth(now = new Date()) {
  return Number(kstToday(now).slice(5, 7));
}

module.exports = { kstToday, kstMonth };
