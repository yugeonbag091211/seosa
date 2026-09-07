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

/** 어디서 일어났는가. 모르면 빈 문자열. */
const SOURCES = ['hotdeal', 'search', 'product', 'radar', 'ai', 'compare', 'home'];

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
      .select('gmv, commission')
      .gte('order_date', since)
      .limit(20000);
  } catch (e) {
    conv = { error: { message: e && e.message } };
  }

  if (conv && !conv.error && Array.isArray(conv.data) && conv.data.length) {
    out.conversions = conv.data.length;
    out.gmv = conv.data.reduce((s, c) => s + (Number(c.gmv) || 0), 0);
    out.commission = conv.data.reduce((s, c) => s + (Number(c.commission) || 0), 0);
  } else {
    /*
     * ★ gmv 를 0 으로 두지 않는다.
     *
     * 0 은 "팔린 것이 없다" 이고 null 은 "아직 알 수 없다" 다. 2026-09-07
     * 현재 파트너스 정산 리포트가 연결돼 있지 않아 전환 행이 만들어질 경로
     * 자체가 없으므로, 사실인 쪽은 null 이다. 0 으로 적으면 «측정 실패» 가
     * «성과 0» 으로 잘못 읽히고, 그 숫자를 근거로 기능을 접게 된다.
     *
     * 리포트가 한 건이라도 적재되면 위 분기로 넘어가 자동으로 실수치가 된다.
     */
    out.conversionsPending = true;
  }
  return out;
}

module.exports = { track, report, FUNNEL_EVENTS, SOURCES, _internal: { _reset, missingObject } };
