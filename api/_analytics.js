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
/*
 * 셀 수 있는 지표 이름.
 *
 * ★ 이 목록에 없는 이름은 bump() 가 'unknown metric' 으로 조용히 버린다.
 *   프론트에 이벤트를 추가했는데 여기 이름을 안 넣으면 아무 오류 없이
 *   집계만 안 된다 — 반드시 양쪽을 같이 고칠 것.
 *
 * ★ 스키마는 건드리지 않았다. daily_metrics.metric 이 text 컬럼이라
 *   (supabase/2026-08-25-analytics.sql) 이름을 늘리는 데 마이그레이션이 필요 없다.
 *
 * ★ 이 테이블은 (날짜, 지표명, 횟수) 카운터다. product_id·검색어 같은 차원을
 *   담을 자리가 없고, 그래서 개인을 식별할 수 있는 값은 애초에 들어오지 않는다.
 *   차원이 필요해지면 그때 별도 테이블을 논의한다.
 *
 * 2026-08-29 UX 개편에서 추가한 것들:
 *   탐색  search_open / search_submit / search_result_click / product_view
 *   AI    ai_discovered / ai_open / ai_first_prompt / ai_followup
 *         ai_entry_* 는 진입 위치별 분해값(home·search·product·compare·fab)
 *   전환  price_history_open / comparison_open / wishlist_add /
 *         price_alert_add / external_shop_click
 */
const METRICS = [
  'search', 'click',
  'search_open', 'search_submit', 'search_result_click', 'product_view',
  /*
   * related_product_click (2026-08-30 추가)
   *
   * 추천 섹션(오늘의 셀렉션 · 관심 카테고리 · 찾으시던 상품 · 이달의
   * 큐레이션 · 최근 본 상품)에서 일어난 상품 클릭. 검색 결과 클릭
   * (search_result_click)과 나눠 센다 — 뭉치면 "검색 퍼널이 도는가"와
   * "우리 큐레이션이 눌리는가"를 구분할 수 없다.
   *
   * 이 값이 없어서 홈에서 일어난 상품 클릭이 지표에 통째로 빠져 있었다.
   */
  'related_product_click',
  'ai_discovered', 'ai_open', 'ai_first_prompt', 'ai_followup',
  'ai_entry_home', 'ai_entry_search', 'ai_entry_product', 'ai_entry_compare', 'ai_entry_fab',
  /*
   * ai_entry_noresult (2026-08-30 추가)
   *
   * 검색 결과 0건 화면에서 누른 AI 진입. ai_entry_search 와 나눠 센다 —
   * 결과가 있는데 좁히려고 부르는 것과, 아무것도 못 찾아서 부르는 것은
   * 성격이 정반대다. 뭉치면 "검색이 실패한 뒤 AI 가 건졌는가" 를
   * 볼 수 없다.
   */
  'ai_entry_noresult',
  'price_history_open', 'comparison_open',
  'wishlist_add', 'price_alert_add', 'external_shop_click'
];

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

/*
 * 로컬 개발 차단 스위치 (ANALYTICS_DISABLED=1).
 *
 * ★ 왜 필요한가 — 2026-08-29 실제 사고
 *   .env.local 에는 운영 Supabase 자격증명이 들어 있다. 그래서 localhost 로
 *   띄운 개발 서버가 /api/stats 를 부르면 그 카운터가 운영 daily_metrics 에
 *   그대로 쌓인다. UX 계측을 검증하다가 실제로 운영 지표에 16종 30건을
 *   남겼고(사후 삭제), visitors 에도 개발용 브라우저가 방문자 한 명으로
 *   들어갔다. 지표는 "틀려도 조용한" 데이터라 시간이 지나면 실제 사용자
 *   행동과 검증 흔적을 구분할 방법이 없어진다.
 *
 * 켜는 곳은 .env.local 하나뿐이다. Vercel(운영·프리뷰) 환경변수에는 절대
 * 넣지 않는다 — 넣는 순간 운영 집계가 통째로 멈추고, 그것도 조용히 멈춘다.
 *
 * migration 미적용 자동 차단(enabled)과 별도의 변수로 둔다. 두 이유를 한
 * 플래그에 섞으면 "스키마가 없어서 꺼진 것"과 "개발자가 끈 것"을 진단에서
 * 구분할 수 없다 (reason 문자열도 각각 다르게 돌려준다).
 *
 * 값을 캐시하지 않고 매번 읽는다. 테스트가 켜고 끄며 양쪽 경로를 모두
 * 확인할 수 있어야 하고, 비용은 문자열 비교 한 번이라 무시할 만하다.
 */
function localDisabled() {
  return String(process.env.ANALYTICS_DISABLED || '').trim() === '1';
}

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
function isEnabled() { return enabled && !localDisabled(); }

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
  // 로컬에서는 방문도 남기지 않는다 — visitors 에 개발용 브라우저가 섞이면
  // '오늘 방문자'·'재방문자' 수가 그만큼 부풀고 되돌릴 수 없다.
  if (localDisabled()) return { ok: false, reason: 'local-disabled' };
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
  if (localDisabled()) return { ok: false, reason: 'local-disabled' };
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
    // 진단에서 "왜 안 세지는가"를 바로 알 수 있게 두 이유를 나눠 보여준다.
    // 조회 자체는 막지 않는다 — 읽기는 운영 데이터를 오염시키지 않는다.
    enabled: isEnabled(),
    localDisabled: localDisabled(),
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
    /*
     * UX 지표는 통째로 함께 내보낸다. 필드를 하나씩 늘리면 지표를 추가할
     * 때마다 이 함수도 같이 고쳐야 하고, 빠뜨리면 쌓이기만 하고 아무도
     * 못 보는 값이 된다. 0 으로 채워 두어 "아직 한 번도 안 일어남"과
     * "집계가 안 됨"을 구분할 수 있게 한다.
     */
    out.ux = {};
    METRICS.filter(m => m !== 'search' && m !== 'click')
      .forEach(m => { out.ux[m] = byMetric[m] || 0; });
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
