'use strict';
/*
 * ADPICK 성과추적(conversion) API 클라이언트.
 *
 *   GET https://biz.adpick.co.kr/api/{apikey}/conversion
 *
 * ── 공식 계약 (이 밖의 필드를 만들지 않는다) ────────────────────────
 *
 *   응답 행    idx cp_code o_cd trlog_id p_cd regdate confirm_date p_nm
 *              qty sales commission commission_rate status trans_comment
 *              p_data link_id api_date
 *   status     정상 · 확인중 · 확정 · 취소
 *   제약       IP whitelist 필수 · 최대 200 rows/page · 최대 조회 365일 ·
 *              p_data 최대 50자 · 일부 제휴몰(쿠팡 등)은 제공 제외
 *
 * ── 2026-09-07 실측 probe ───────────────────────────────────────────
 *
 *   HTTP 403 {"status":"error","code":403,
 *             "error":"성과추적 API를 사용하려면 API 키에 Whitelist 적용이 필수입니다."}
 *
 *   엔드포인트와 계약은 확인됐지만 **실데이터는 보지 못했다.** 그래서
 *   행 하나의 정확한 모양(특히 어느 식별자가 안정적인가)은 미확인이고,
 *   api/_conversion.js 가 그 판단을 환경변수로 미뤄 두었다.
 *
 * ── 키 취급 ─────────────────────────────────────────────────────────
 *
 * ★ ADPICK 은 API 키가 URL «경로» 에 들어간다. 그래서 오류 메시지·스택·
 *   로그 어디에도 URL 을 날것으로 남기면 안 된다. 모든 출력은 redact() 를
 *   거친다 (api/_adpick.js 와 같은 규칙, 같은 이유).
 * ★ 이 모듈은 브라우저로 나가지 않는다. 서버 스크립트에서만 부른다.
 */

const HOST = process.env.ADPICK_API_HOST || 'https://biz.adpick.co.kr';

/** 공식 상한. 넘겨 부르지 않는다. */
const MAX_ROWS_PER_PAGE = 200;
const MAX_RANGE_DAYS = 365;
/** 페이지를 무한히 돌지 않는다. 200 × 50 = 10,000행이면 한 회차로 충분하다. */
const MAX_PAGES = 50;
/** 페이지 사이 간격 — 상대 서버를 몰아붙이지 않는다. */
const PAGE_INTERVAL_MS = Number(process.env.ADPICK_CONV_INTERVAL_MS) || 1200;
const TIMEOUT_MS = Number(process.env.ADPICK_CONV_TIMEOUT_MS) || 20000;

function apiKey() { return String(process.env.ADPICK_API_KEY || '').trim(); }
function hasKey() { return !!apiKey(); }

/**
 * 로그·오류에서 키를 지운다.
 *
 * 키 문자열 자체와 경로 패턴 둘 다 지운다 — 키를 모르는 경로에서 만들어진
 * 문자열(예: 상대가 되돌려준 URL)도 있기 때문이다.
 */
function redact(text) {
  let s = String(text == null ? '' : text);
  const key = apiKey();
  if (key) s = s.split(key).join('***');
  return s.replace(/\/api\/[^/\s"']+\//g, '/api/***/');
}

function ymd(d) {
  const t = new Date(d);
  return t.getUTCFullYear().toString()
    + String(t.getUTCMonth() + 1).padStart(2, '0')
    + String(t.getUTCDate()).padStart(2, '0');
}

/**
 * 조회 기간을 공식 상한 안으로 자른다.
 * @returns {{from:string,to:string,days:number}}
 */
function range(days) {
  /*
   * ★ 0 을 «지정 안 함» 과 구분한다.
   *   parseInt(0)||7 로 쓰면 days=0 요청이 조용히 7일이 된다 — 부른 쪽이
   *   요청한 것보다 «더 많이» 가져오는 것이라, 조회 상한을 두는 의미가 없어진다.
   */
  const raw = parseInt(days, 10);
  const n = Number.isFinite(raw)
    ? Math.max(1, Math.min(MAX_RANGE_DAYS, raw))
    : 7;
  const to = new Date();
  const from = new Date(Date.now() - (n - 1) * 86400000);
  return { from: ymd(from), to: ymd(to), days: n };
}

/** whitelist 거부인가. 이 경우 재시도해도 소용없다 — 즉시 멈춘다. */
function isWhitelistError(status, body) {
  if (status !== 403) return false;
  return /whitelist/i.test(String(body || '')) || /화이트리스트|Whitelist/.test(String(body || ''));
}

/**
 * 한 페이지를 읽는다. ★ 절대 throw 하지 않는다.
 *
 * @returns {Promise<{ok:boolean, rows:Array, reason:string, status:number, whitelist:boolean}>}
 */
async function fetchPage(from, to, page) {
  if (!hasKey()) return { ok: false, rows: [], reason: 'no-credential', status: 0, whitelist: false };

  const q = 'sdate=' + encodeURIComponent(from)
    + '&edate=' + encodeURIComponent(to)
    + '&page=' + encodeURIComponent(String(page))
    + '&limit=' + encodeURIComponent(String(MAX_ROWS_PER_PAGE));
  const url = HOST + '/api/' + encodeURIComponent(apiKey()) + '/conversion?' + q;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    const text = await res.text();

    if (!res.ok) {
      const wl = isWhitelistError(res.status, text);
      return {
        ok: false, rows: [], status: res.status, whitelist: wl,
        reason: redact(text.replace(/\s+/g, ' ')).slice(0, 200)
      };
    }

    let json;
    try { json = JSON.parse(text); }
    catch (e) {
      return { ok: false, rows: [], status: res.status, whitelist: false,
        reason: 'JSON 아님: ' + redact(text.replace(/\s+/g, ' ')).slice(0, 120) };
    }

    /*
     * 응답 봉투 모양은 실데이터로 확인하지 못했다(403). 그래서 흔한 두 모양을
     * 모두 받아들이되, 배열을 «찾지 못하면» 조용히 0건으로 넘어가지 않고
     * 그 사실을 reason 으로 올린다 — 조용한 0건이 가장 위험하다.
     */
    const rows = Array.isArray(json) ? json
      : Array.isArray(json && json.data) ? json.data
      : Array.isArray(json && json.list) ? json.list
      : null;
    if (!rows) {
      return { ok: false, rows: [], status: res.status, whitelist: false,
        reason: '배열을 찾지 못함. top keys=' + JSON.stringify(Object.keys(json || {})).slice(0, 120) };
    }
    return { ok: true, rows: rows, status: res.status, whitelist: false, reason: '' };
  } catch (e) {
    const msg = (e && e.name === 'AbortError') ? 'timeout' : redact(e && e.message);
    return { ok: false, rows: [], status: 0, whitelist: false, reason: String(msg).slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 기간 전체를 페이지 단위로 읽는다.
 *
 * ★ 부분 실패를 격리한다. 3페이지에서 실패해도 1~2페이지 결과는 살려서
 *   돌려주고, 실패 사실을 errors 에 남긴다. 한 페이지가 깨졌다고 그날
 *   전환을 통째로 버리지 않는다.
 *
 * @returns {Promise<{ok:boolean, rows:Array, pages:number, errors:Array, whitelist:boolean}>}
 */
async function fetchConversions(opts) {
  const o = opts || {};
  const r = range(o.days);
  const maxPages = Math.max(1, Math.min(MAX_PAGES, parseInt(o.maxPages, 10) || MAX_PAGES));
  const out = { ok: false, rows: [], pages: 0, errors: [], whitelist: false, range: r };

  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchPage(r.from, r.to, page);
    out.pages = page;

    if (!res.ok) {
      out.errors.push({ page: page, status: res.status, reason: res.reason });
      // whitelist 거부는 재시도·다음 페이지가 의미 없다. 즉시 멈춘다.
      if (res.whitelist) { out.whitelist = true; break; }
      if (res.reason === 'no-credential') break;
      break;   // 그 밖의 오류도 뒤 페이지를 신뢰할 수 없으므로 멈춘다
    }

    out.rows.push.apply(out.rows, res.rows);
    // 마지막 페이지 — 상한 미만이면 더 없다.
    if (res.rows.length < MAX_ROWS_PER_PAGE) break;
    if (page < maxPages) await new Promise(f => setTimeout(f, PAGE_INTERVAL_MS));
  }

  out.ok = out.errors.length === 0 || out.rows.length > 0;
  return out;
}

module.exports = {
  HOST, MAX_ROWS_PER_PAGE, MAX_RANGE_DAYS, MAX_PAGES,
  hasKey, redact, range, isWhitelistError, fetchPage, fetchConversions
};
