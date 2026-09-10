'use strict';
/*
 * 구매 퍼널 계측 — 상품 단위.
 *
 * ── daily_metrics 와의 분업 ────────────────────────────────────────
 *
 *   api/_analytics.js   (날짜, 지표) → 카운트. 대량 이벤트 전부.
 *   여기                구매에 닿는 소수 이벤트만 행으로. 상품·몰·가격이 붙는다.
 *
 * 검색·조회까지 행으로 쌓으면 하루 수만 행이 된다(2026-08-25 마이그레이션
 * 주석의 판단이고 지금도 옳다). 그래서 «무엇이 돈이 됐는가» 를 답해야 하는
 * 이벤트만 여기 남긴다.
 *
 * ── 절대 하지 않는 것 ──────────────────────────────────────────────
 *
 *   ★ 클릭을 구매로 기록하지 않는다.
 *     affiliate_click 은 funnel_events 에 들어가고, 확정 전환은 conversions
 *     라는 다른 표에만 들어간다. GMV 는 conversions 에서만 나온다.
 *     이 파일에는 conversions 에 «쓰는» 코드가 없다 — 클릭 경로에서 그 표에
 *     닿을 방법 자체를 만들지 않기 위해서다.
 *
 *   ★ 개인을 식별하지 않는다.
 *     IP·User-Agent·이메일을 저장하지 않는다. visitor_id 는 브라우저가 만든
 *     난수이고, 계정과 잇지 않는다. 핑거프린팅을 하지 않는다.
 *
 * ── 실패해도 조용하다 ──────────────────────────────────────────────
 *
 * 계측이 안 됐다고 사용자 화면에 오류를 띄울 이유가 없다. 표가 없으면
 * (마이그레이션 전) 한 번 경고하고 스스로 꺼진다 — _analytics.js 와 같은 방식.
 */

const supabase = require('./_supabase');
const { kstToday } = require('./_kst');

/**
 * 행으로 남길 이벤트.
 *
 * ★ 화이트리스트가 실제 관문이다. 아무 문자열이나 쌓이지 않는다.
 * ★ 여기에 'conversion' 류를 넣지 않는다. 확정 전환은 이 경로로 들어오지
 *   않는다 — 정산 리포트만이 출처다.
 */
const FUNNEL_EVENTS = [
  'affiliate_click',      // 제휴 링크를 눌렀다 (구매가 아니다)
  'radar_save',
  'radar_remove',
  'target_price_set',
  'target_price_reached',
  'compare_open',
  'buy_wait_watch_view'
];

/*
 * 어디서 일어났는가. 모르면 빈 문자열.
 *
 * ★ 이 목록이 관문이다 — 여기 없는 이름은 조용히 ''(모름) 으로 기록된다.
 *   funnel_events.source 는 제약 없는 text 컬럼이라 이름을 늘리는 데
 *   마이그레이션이 필요하지 않다.
 *
 * hero_book 은 홈 히어로의 책등(2026-09-10). 'home' 과 굳이 나눈 이유는
 * 같은 홈이라도 «책 한 권을 집어서» 나가는 것과 검색 결과 카드를 눌러
 * 나가는 것이 서로 다른 행동이기 때문이다. 섞으면 책등이 실제로 돈을
 * 벌어 오는지 아닌지를 따로 볼 수 없다.
 */
const SOURCES = ['hotdeal', 'search', 'product', 'radar', 'ai', 'compare', 'home', 'hero_book'];

/** visitorId 로 받아들일 모양. _analytics.VID_RE 와 같은 규칙. */
const VID_RE = /^[a-z0-9]{8,64}$/i;

let enabled = true;
let warned = false;

/*
 * 로컬 개발 차단 스위치 (ANALYTICS_DISABLED=1) — _analytics.js 와 «같은» 스위치다.
 *
 * ★ 왜 여기에도 필요한가 (2026-09-07 활성화 검증에서 발견)
 *
 *   .env.local 에는 운영 Supabase 자격증명이 들어 있다. 그래서 localhost 로
 *   띄운 개발 서버가 /api/stats 를 부르면 그 행이 운영 funnel_events 에
 *   그대로 쌓인다. _analytics.js 는 2026-08-29 실제 사고(개발 브라우저가
 *   운영 지표에 16종 30건을 남김) 뒤에 이 가드를 얻었는데, 나중에 만든
 *   이쪽에는 빠져 있었다.
 *
 *   이 표는 그때보다 더 나쁘다. daily_metrics 는 (날짜, 지표) 카운터라
 *   되돌리기라도 하지만, funnel_events 는 product_id·mall·price 를 단 행이라
 *   개발 중 누른 클릭이 «실제 사용자가 그 상품을 눌렀다» 로 남는다.
 *   그 값으로 무엇이 돈이 되는지 판단하게 되므로 오염을 그냥 둘 수 없다.
 *
 *   켜는 곳은 .env.local 하나뿐이다. Vercel 환경변수에는 절대 넣지 않는다 —
 *   넣는 순간 운영 퍼널 계측이 통째로, 그것도 조용히 멈춘다.
 */
function localDisabled() {
  return String(process.env.ANALYTICS_DISABLED || '').trim() === '1';
}

function disable(what, why) {
  if (!warned) {
    warned = true;
    console.warn(`[funnel] ${what} 없음 — supabase/2026-09-07-funnel.sql 을 실행하세요. (${why})`);
  }
  enabled = false;
}

function missingObject(msg) {
  return /does not exist|schema cache|could not find/i.test(String(msg || ''));
}

/** 테스트가 상태를 되돌릴 때 쓴다. */
function _reset() { enabled = true; warned = false; }

function clean(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }

/**
 * 이벤트 하나를 남긴다. ★ 절대 throw 하지 않는다.
 *
 * @param {object} e {event, productId, mall, price, source, visitorId}
 * @returns {Promise<{ok:boolean, reason:string}>}
 */
async function track(e) {
  if (localDisabled()) return { ok: false, reason: 'local-disabled' };
  if (!enabled) return { ok: false, reason: 'disabled' };
  try {
    const event = clean(e && e.event, 40).toLowerCase();
    if (FUNNEL_EVENTS.indexOf(event) === -1) return { ok: false, reason: 'unknown event' };

    const vid = clean(e && e.visitorId, 64);
    const source = clean(e && e.source, 20).toLowerCase();
    const price = Math.round(Number(e && e.price));

    const row = {
      event_date: kstToday(),
      event,
      product_id: clean(e && e.productId, 120),
      mall: clean(e && e.mall, 40),
      // 가격은 «관측된 값» 일 때만 남긴다. 0 이나 음수를 0원으로 적지 않는다.
      price: Number.isFinite(price) && price > 0 ? price : 0,
      source: SOURCES.indexOf(source) > -1 ? source : '',
      visitor_id: VID_RE.test(vid) ? vid : ''
    };

    const { error } = await supabase.from('funnel_events').insert(row);
    if (error) {
      if (missingObject(error.message)) { disable('funnel_events 표', error.message); return { ok: false, reason: 'disabled' }; }
      return { ok: false, reason: error.message };
    }
    return { ok: true, reason: '' };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * 퍼널 요약 (관리자용).
 *
 * ★ conversions 가 비어 있으면 GMV 를 0 이 아니라 null 로 답한다.
 *   0 은 "팔린 게 없다" 이고 null 은 "아직 알 수 없다" 다. 전환 데이터
 *   출처가 없는 지금은 후자가 사실이다. 이 둘을 섞으면 대시보드에
 *   «매출 0» 이 뜨고, 그건 측정 실패를 성과 실패로 잘못 읽게 만든다.
 */
async function report(days) {
  const n = Math.max(1, Math.min(90, parseInt(days, 10) || 7));
  const since = kstToday(new Date(Date.now() - (n - 1) * 86400000));
  const out = { days: n, since, events: {}, byMall: {}, topProducts: [], gmv: null, conversions: null };
  /*
   * ★ 절대 throw 하지 않는다 (track 과 같은 규칙).
   *
   * 이 값은 /api/stats?report=1 이 방문자·매출 지표와 «함께» 내는 값이다.
   * 여기서 예외가 나가면 관리자 지표 전체가 500 이 된다 — 퍼널 한 조각을
   * 못 읽었다고 나머지 지표까지 못 보게 만들 이유가 없다.
   */
  try {
    return await collect(out, since);
  } catch (e) {
    return Object.assign(out, { error: e && e.message ? e.message : String(e) });
  }
}

async function collect(out, since) {
  const { data, error } = await supabase
    .from('funnel_events')
    .select('event, product_id, mall, price')
    .gte('event_date', since)
    .limit(20000);
  if (error) {
    if (missingObject(error.message)) return Object.assign(out, { pending: true });
    return Object.assign(out, { error: error.message });
  }

  const byProduct = new Map();
  (data || []).forEach(r => {
    out.events[r.event] = (out.events[r.event] || 0) + 1;
    if (r.event !== 'affiliate_click') return;
    if (r.mall) out.byMall[r.mall] = (out.byMall[r.mall] || 0) + 1;
    if (!r.product_id) return;
    const cur = byProduct.get(r.product_id) || { productId: r.product_id, clicks: 0, lastPrice: 0 };
    cur.clicks++;
    if (r.price > 0) cur.lastPrice = r.price;
    byProduct.set(r.product_id, cur);
  });
  out.topProducts = [...byProduct.values()].sort((a, b) => b.clicks - a.clicks).slice(0, 20);

  /*
   * 확정 전환. 표가 없거나 비어 있으면 null 을 유지한다 — 위 주석 참고.
   * ★ 여기서 클릭 수로 GMV 를 «추정» 하지 않는다. 그럴 자리 자체를 두지 않는다.
   */
  let conv = null;
  // 전환 조회가 실패해도 위에서 모은 퍼널 수치는 살린다.
  try {
    conv = await supabase
      .from('conversions')
      /*
       * ★ status 를 반드시 함께 읽는다.
       *
       * 예전에는 gmv/commission 만 읽어 전부 더했다. 그 상태로 전환 리포트를
       * 붙이면 «아직 확정되지 않은 주문» 과 «취소된 주문» 이 확정 매출과 한
       * 덩어리가 된다. 그건 GMV 가 아니라 희망이다.
       */
      .select('gmv, commission, status')
      .gte('order_date', since)
      .limit(20000);
  } catch (e) {
    conv = { error: { message: e && e.message } };
  }

  /*
   * status 컬럼이 아직 없는 DB(2026-09-08 마이그레이션 전)에서는 한 번 더
   * 물러난다. 그때는 상태를 모르므로 «확정» 이라고 말할 수 없다 —
   * 아래에서 confirmedGmv 를 내지 않고 statusUnavailable 로 알린다.
   */
  let statusUnavailable = false;
  if (conv && conv.error && /status|column|schema cache/i.test(String(conv.error.message || ''))) {
    statusUnavailable = true;
    try {
      conv = await supabase.from('conversions').select('gmv, commission')
        .gte('order_date', since).limit(20000);
    } catch (e) { conv = { error: { message: e && e.message } }; }
  }

  const rows = (conv && !conv.error && Array.isArray(conv.data)) ? conv.data : null;

  if (rows && rows.length) {
    const C = require('./_conversion');
    const s = C.summarize(rows);
    out.conversions = s.total;
    out.conversionStatus = s.byStatus;
    /*
     * ── 절대 섞지 않는다 ──────────────────────────────────────────
     *   orderedGmv        주문됐다 (확정 아님) — 참고값이지 매출이 아니다
     *   confirmedGmv      확정된 실제 결제 금액 — ★ 이것만 매출이다
     *   cancelledGmv      취소된 금액
     *   commissionRevenue 확정 건의 실제 수수료만
     */
    out.orderedGmv = s.orderedGmv;
    out.confirmedGmv = statusUnavailable ? null : s.confirmedGmv;
    out.cancelledGmv = s.cancelledGmv;
    out.commissionRevenue = statusUnavailable ? null : s.commissionRevenue;
    if (statusUnavailable) out.statusUnavailable = true;
  } else {
    /*
     * ★ 0 으로 두지 않는다.
     *
     * 0 은 "팔린 게 없다" 이고 null 은 "아직 알 수 없다" 다. 전환 행이
     * 만들어질 경로가 아직 없으므로 사실인 쪽은 null 이다. 0 으로 적으면
     * «측정 실패» 가 «성과 0» 으로 잘못 읽히고, 그 숫자를 근거로 기능을 접는다.
     */
    out.conversionsPending = true;
    out.confirmedGmv = null;
    out.commissionRevenue = null;
  }

  /*
   * ── 부분 커버리지 ─────────────────────────────────────────────────
   *
   * ADPICK 만 연결됐는데 그 매출만 합쳐 놓고 "SEOSA GMV = 50만원" 이라고
   * 하면 거짓이다. 쿠팡이 우리 트래픽의 대부분인데 그쪽 전환을 못 세고
   * 있으므로, 그 합계는 «전체 GMV» 가 아니라 «측정된 일부» 다.
   *
   *   measuredConfirmedGmv  지금 셀 수 있는 만큼의 확정 매출
   *   gmv                   모든 활성 provider 가 연결됐을 때만 숫자
   *
   * 이것이 이 파일에서 가장 중요한 회계적 방어선이다. 한쪽만 연결된 상태의
   * 숫자를 전체 매출로 부르는 순간, 그 숫자로 내린 판단이 전부 틀어진다.
   */
  const coverage = conversionCoverage();
  out.conversionCoverage = coverage.byProvider;
  out.coverageComplete = coverage.complete;
  out.measuredConfirmedGmv = out.confirmedGmv;
  out.gmv = coverage.complete ? out.confirmedGmv : null;
  return out;
}

/**
 * 지금 «전환을 셀 수 있는» affiliate source 가 어디까지인가.
 *
 * connected      전환 리포트가 실제로 연결돼 적재 중
 * not_verified   계약/응답을 확인하지 못해 importer 를 켜지 않았다
 * blocked        계약은 확인됐지만 실행 조건(IP whitelist 등)을 못 갖췄다
 * inactive       그 source 로 나가는 트래픽이 없다 (자격증명 없음)
 */
function conversionCoverage() {
  const byProvider = {};

  /*
   * ADPICK — 공식 계약 확인 + 엔드포인트 probe 로 존재 확인(2026-09-07).
   * 다만 성과추적 API 는 IP whitelist 가 필수이고 현재 실행 환경은 출구 IP 가
   * 고정되지 않는다. 그래서 «연결됨» 이 아니라 blocked 다.
   */
  byProvider.adpick = process.env.ADPICK_API_KEY
    ? (process.env.ADPICK_CONVERSION_WHITELISTED === '1' ? 'connected' : 'blocked')
    : 'inactive';

  /*
   * 쿠팡 — 2026-09-07 read-only probe 에서 orders 는 200/rCode 0 이지만 0건이라
   * 행의 모양을 못 봤고 cancel 경로는 404 였다. 주문 금액·취소를 확인하지
   * 못했으므로 전환을 셀 수 없다.
   */
  byProvider.coupang = (process.env.COUPANG_ACCESS_KEY && process.env.COUPANG_SECRET_KEY)
    ? 'not_verified' : 'inactive';

  /* 활성(트래픽이 나가는) provider 가 전부 connected 여야 전체 GMV 를 말한다. */
  const active = Object.keys(byProvider).filter(k => byProvider[k] !== 'inactive');
  const complete = active.length > 0 && active.every(k => byProvider[k] === 'connected');
  return { byProvider: byProvider, complete: complete, active: active };
}

module.exports = {
  track, report, conversionCoverage, FUNNEL_EVENTS, SOURCES,
  _internal: { _reset, missingObject }
};
