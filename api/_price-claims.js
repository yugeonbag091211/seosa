'use strict';
/*
 * «기록상 최저가» 를 말해도 되는 최소 근거 — 관측 건수와 기간.
 *
 * ── 왜 필요한가 (2026-09-24 실사용 신고) ────────────────────────
 *
 * AI 카드(api/ai.js toCard)와 조건 대조 문장(_shopintent · _decision)은
 * «현재가 ≤ 기록 최저» 이기만 하면 "기록상 최저가" 를 붙였다. 그런데 기록이
 * 1건이면 현재가가 곧 최저가다 — 어제 처음 수집한 상품이 전부 "기록상 최저가" 가 된다.
 * 메인 화면 카드는 이미 7일 하한(Grid.ATL_MIN_POINTS)을 두고 "N일 기록 중 최저" 로
 * 기간을 밝히는데, AI 쪽만 하한도 기간도 없이 더 센 말을 했다.
 *
 * ── 규칙 ────────────────────────────────────────────────────────
 *   관측한 날 ≥ RECORD_MIN_OBS(7)  그리고  기록이 덮는 기간 ≥ RECORD_MIN_SPAN_DAYS(14일)
 * 둘 다일 때만 "최저가" 를 말한다. 말할 때는 기간을 함께 적는다 — "42일 기록 중 최저가".
 * 모자라면 아무 말도 하지 않는다(다른 근거 문장으로 넘어간다).
 *
 * ★ 순수 함수. 가격 수집·핫딜 판정·DB 는 건드리지 않는다.
 */

const RECORD_MIN_OBS = 7;
const RECORD_MIN_SPAN_DAYS = 14;

function dayNum(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || ''));
  return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : NaN;
}

/**
 * 기록의 두께.
 * @param {object} h  statsFrom/loadStats 결과, 또는 {count, historyDays, firstDate, lastDate, points}
 *                    points 만 있어도 된다 ([{date|d, price|p}])
 * @returns {{obs:number, spanDays:number, enough:boolean}}
 *   spanDays 는 첫 기록일부터 마지막 기록일까지 «양 끝을 포함한» 일수다.
 */
function basisOf(h) {
  if (!h || typeof h !== 'object') return { obs: 0, spanDays: 0, enough: false };
  const pts = Array.isArray(h.points) ? h.points.filter(p => p && (p.date || p.d)) : [];
  const obs = Number(h.count) > 0 ? Math.round(Number(h.count)) : pts.length;
  let span = 0;
  if (Number(h.historyDays) > 0) span = Math.round(Number(h.historyDays)) + 1;
  else {
    /*
     * historyDays 가 없는 기록(예전 형식·화면이 보낸 요약)은 실제로 관측한 날짜들
     * (첫 기록·마지막·최저·최고·추세 시작·점)의 처음과 끝으로 기간을 잡는다.
     * 관측한 날짜 사이의 거리라 «적어도 이만큼» 인 하한이다 — 부풀리지 않는다.
     */
    const days = [h.firstDate, h.lastDate, h.lowDate, h.highDate, h.trendFromDate]
      .concat(pts.map(p => p.date || p.d)).map(dayNum).filter(Number.isFinite);
    if (days.length) span = Math.max.apply(null, days) - Math.min.apply(null, days) + 1;
  }
  if (!Number.isFinite(span) || span < 0) span = 0;
  if (obs === 1 && span === 0) span = 1;
  return { obs, spanDays: span, enough: obs >= RECORD_MIN_OBS && span >= RECORD_MIN_SPAN_DAYS };
}

/** 기록이 «최저가» 를 말할 만큼 두꺼운가. */
function recordEnough(h) { return basisOf(h).enough; }

/**
 * 현재가가 기록 최저 이하일 때의 한 줄 — 근거가 모자라면 null.
 * @returns {string|null}  "42일 기록 중 최저가"
 */
function recordLowNote(h, price) {
  const p = Math.round(Number(price) || 0);
  if (!h || !(Number(h.low) > 0) || p <= 0 || p > Number(h.low)) return null;
  const b = basisOf(h);
  return b.enough ? `${b.spanDays}일 기록 중 최저가` : null;
}

module.exports = { RECORD_MIN_OBS, RECORD_MIN_SPAN_DAYS, basisOf, recordEnough, recordLowNote };
