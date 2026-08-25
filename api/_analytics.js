/**
 * 최소 사용자 계측.
 *
 * ── 무엇을 세는가 ───────────────────────────────────────────────────
 *   총 방문자 / 오늘 방문자 / 재방문자      ← visitors 테이블
 *   상품 검색 횟수 / 상품 클릭 횟수         ← daily_metrics 테이블
 *   AI Concierge 사용 횟수                  ← ai_usage (이미 있다, 새로 쌓지 않는다)
 *
 * ── 설계 원칙 ───────────────────────────────────────────────────────
 *
 * 1. 계측이 서비스를 망가뜨리지 않는다.
 *    모든 함수가 절대 throw 하지 않고 절대 await 를 강요하지 않는다.
 *    집계 한 줄 때문에 검색이 실패하면 그건 계측이 아니라 장애다.
 *
 * 2. 개인을 특정할 수 있는 것을 저장하지 않는다.
 *    IP·User-Agent·이메일 어느 것도 남기지 않는다. visitorId 는 브라우저가
 *    만든 난수이고 서버는 그게 누구인지 모른다.
 *
 * 3. 원본 이벤트를 쌓지 않는다.
 *    날짜별 카운터로 바로 접는다. 하루에 metric 종류만큼만 행이 는다.
 *
 * 4. 새 엔드포인트를 만들지 않는다.
 *    Vercel Hobby 는 함수 12개가 상한이고 현재 11개다. 이미 인증 없이 쓰기를
 *    받고 있는 /api/stats 에 얹는다.
 *
 * (배경: supabase/2026-08-25-analytics.sql 머리말)
 */
const supabase = require('./_supabase');
const { kstToday } = require('./_kst');

/**
 * 셀 수 있는 metric 화이트리스트.
 *
 * ★ 이것이 실제 관문이다. /api/stats 는 인증이 없으므로 metric 이름을
 *   그대로 받으면 아무 문자열이나 daily_metrics 에 쌓을 수 있다. 테이블이
 *   쓰레기로 차면 지표를 읽을 수 없게 된다 — 세지 않는 편이 낫다.
 */
const METRICS = ['search', 'click'];

/** visitorId 로 받아들일 모양. 브라우저가 만든 난수만 통과시킨다. */
const VID_RE = /^[a-z0-9]{8,64}$/i;

/*
 * 마이그레이션(2026-08-25-analytics.sql) 미적용 환경 대비.
 *
 * 한 번 없다고 확인되면 그 뒤로는 아예 부르지 않는다. 매 요청마다 실패하는
 * RPC 를 호출하면 지연만 쌓인다. (api/_auth.js · api/_shop.js 와 같은 방식)
 */
let enabled = true;
let warned = false;

function missingObject(msg) {
  return /could not find|does not exist|schema cache|relation .* does not exist/i.test(msg || '');
}

function disable(what, msg) {
  enabled = false;
  if (warned) return;
  warned = true;
  console.warn(
    `[analytics] ${what} 없음 — 계측을 끄고 계속합니다 `
    + `(supabase/2026-08-25-analytics.sql 을 실행하면 켜집니다): ${msg}`
  );
}

/** @returns {boolean} 계측이 켜져 있는가 (테스트·진단용) */
function isEnabled() { return enabled; }

/** 테스트에서 모듈 상태를 되돌리기 위한 것. 운영 코드는 부르지 않는다. */
function _reset() { enabled = true; warned = false; }

/**
 * 방문 기록.
 *
 * 같은 날 몇 번을 부르든 visit_days 는 한 번만 는다 (RPC 안의 CASE 가 판단).
 * 그래서 프론트가 페이지를 열 때마다 불러도 재방문 수가 부풀지 않는다.
 *
 * @param {string} visitorId 브라우저가 만든 난수
 * @returns {Promise<{ok: boolean, reason: string}>}  절대 throw 하지 않는다
 */
async function trackVisit(visitorId, today = kstToday()) {
  if (!enabled) return { ok: false, reason: 'disabled' };

  /*
   * ★ 값을 문자열로 바꾸는 것부터 try 안에서 한다.
   *
   *   String(x) 는 x.toString() 을 부르므로 던지는 객체가 오면 여기서 터진다.
   *   그 예외가 호출부로 올라가면 계측 한 줄이 요청 전체를 죽인다 — 이 모듈이
   *   절대 하지 않기로 한 바로 그 일이다. 검증도 변환도 전부 안쪽에 둔다.
   */
  try {
    const vid = String(visitorId || '').trim();
    if (!VID_RE.test(vid)) return { ok: false, reason: 'invalid vid' };

    const { error } = await supabase.rpc('track_visit', { p_vid: vid, p_date: today });
    if (error) {
      if (missingObject(error.message)) { disable('track_visit RPC', error.message); return { ok: false, reason: 'disabled' }; }
      return { ok: false, reason: error.message };
    }
    return { ok: true, reason: '' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * 카운터 하나를 올린다.
 *
 * @param {string} metric METRICS 안의 값만 센다
 * @returns {Promise<{ok: boolean, reason: string}>}  절대 throw 하지 않는다
 */
async function bump(metric, today = kstToday()) {
  if (!enabled) return { ok: false, reason: 'disabled' };

  // 변환·검증을 전부 try 안에서 한다 (이유는 trackVisit 주석 참고).
  try {
    const m = String(metric || '').trim().toLowerCase();
    if (METRICS.indexOf(m) === -1) return { ok: false, reason: 'unknown metric' };

    const { error } = await supabase.rpc('bump_metric', { p_metric: m, p_date: today });
    if (error) {
      if (missingObject(error.message)) { disable('bump_metric RPC', error.message); return { ok: false, reason: 'disabled' }; }
      return { ok: false, reason: error.message };
    }
    return { ok: true, reason: '' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * 지표 요약.
 *
 * ── 왜 visitors 를 세 번 세지 않는가 ────────────────────────────────
 * 총/오늘/재방문은 전부 같은 테이블의 서로 다른 조건이다. PostgREST 로는
 * 조건별 count 를 한 번에 못 받으므로 head:true + count:'exact' 로 세 번
 * 부른다 — 행을 실제로 가져오지 않으므로 크기와 무관하게 싸다.
 *
 * 한 조각이 실패해도 나머지는 돌려준다. 지표는 전부-아니면-무가 아니다.
 *
 * @returns {Promise<object>} 실패한 항목은 null 로 온다
 */
async function report(today = kstToday()) {
  const out = {
    date: today,
    enabled,
    visitorsTotal: null,
    visitorsToday: null,
    visitorsReturning: null,
    searchToday: null,
    clickToday: null,
    aiToday: null,
    aiTotal: null,
    errors: []
  };

  const countOf = async (table, build) => {
    try {
      const { count, error } = await build(
        supabase.from(table).select('*', { count: 'exact', head: true }));
      if (error) throw new Error(error.message);
      return Number(count) || 0;
    } catch (e) {
      out.errors.push(`${table}: ${e.message}`);
      return null;
    }
  };

  out.visitorsTotal     = await countOf('visitors', q => q);
  out.visitorsToday     = await countOf('visitors', q => q.eq('last_date', today));
  // 재방문자 = 다른 날에 다시 온 사람. 같은 날 새로고침은 세지 않는다.
  out.visitorsReturning = await countOf('visitors', q => q.gt('visit_days', 1));

  // 날짜별 카운터 — 오늘 행만 읽는다.
  try {
    const { data, error } = await supabase
      .from('daily_metrics').select('metric, count').eq('metric_date', today);
    if (error) throw new Error(error.message);
    const byMetric = {};
    (data || []).forEach(r => { byMetric[r.metric] = Number(r.count) || 0; });
    out.searchToday = byMetric.search || 0;
    out.clickToday  = byMetric.click  || 0;
  } catch (e) {
    out.errors.push(`daily_metrics: ${e.message}`);
  }

  /*
   * AI 사용 횟수는 ai_usage 에서 읽는다 — 새로 쌓지 않는다.
   *
   * 이 테이블은 (email, usage_date) 당 한 행이고 used 가 그날 사용 횟수다.
   * 오늘 행만 더하면 "오늘 AI 사용 횟수" 가 된다.
   *
   * 총합은 전 기간을 훑어야 하는데 PostgREST 는 1,000행에서 잘린다
   * (scripts/check-alerts.js O3 와 같은 함정). 사용자·날짜 조합이 늘면
   * 조용히 축소된 값을 보게 되므로, 페이지를 넘겨 가며 전부 받는다.
   */
  try {
    const { data, error } = await supabase
      .from('ai_usage').select('used').eq('usage_date', today).limit(1000);
    if (error) throw new Error(error.message);
    out.aiToday = (data || []).reduce((s, r) => s + (Number(r.used) || 0), 0);
  } catch (e) {
    out.errors.push(`ai_usage(today): ${e.message}`);
  }

  try {
    const PAGE = 1000;
    let total = 0;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('ai_usage').select('used')
        .order('usage_date', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      total += (data || []).reduce((s, r) => s + (Number(r.used) || 0), 0);
      if (!data || data.length < PAGE) break;
    }
    out.aiTotal = total;
  } catch (e) {
    out.errors.push(`ai_usage(total): ${e.message}`);
  }

  return out;
}

module.exports = { METRICS, VID_RE, trackVisit, bump, report, isEnabled, _reset };
