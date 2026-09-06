'use strict';
/*
 * ADPICK 쇼핑메이트 핫딜 상품 리스트 API — 단일 통로.
 *
 * ── 공식 계약 (2026-09-06 리뷰에서 정정) ────────────────────────────
 *
 *   GET https://adpick.co.kr/apis/sdk_shopping_hotdeal.php?affid=<회원아이디>
 *
 *   응답  { list: [ { product_name, photo, mall, price_sale, price_org,
 *                     commission, buyurl }, ... ] }
 *
 *   제한  · 주기적으로 DB/파일에 저장해서 쓸 것
 *         · 최대 1분 1회 이하
 *
 * ── 왜 _adpick.js 와 다른 파일인가 ─────────────────────────────────
 *
 * 같은 회사지만 계약이 다르다.
 *   _adpick.js       biz.adpick.co.kr/api/{apikey}/search   — 인증이 «API 키»
 *   여기             adpick.co.kr/apis/sdk_...php?affid=..  — 인증이 «회원아이디»
 * 호스트·인증·응답 모양·호출 한도가 전부 다르므로 리미터를 같이 쓰면 어느
 * 쪽 한도인지 알 수 없게 된다. 한도가 1분 1회로 훨씬 빡빡한 쪽을 섞지 않는다.
 *
 * ── 이전 구현이 틀렸던 점 ──────────────────────────────────────────
 *
 * 처음에는 `/api/{apikey}/hotdeal` 을 probe 해 404 를 받고 "핫딜 API 없음"
 * 으로 적었다. 그건 search API 와 같은 호스트·같은 인증을 가정한 추측이었고,
 * 공식 핫딜 API 는 아예 다른 SDK 엔드포인트였다. 그래서 ADPICK_HOTDEAL_FUNCTION
 * (function 이름을 받는 계약)도 통째로 틀렸다 — 여기에는 function 이름이
 * 없고 affid 하나만 있다.
 *
 * ── 자격증명 ───────────────────────────────────────────────────────
 *
 *   ADPICK_AFFILIATE_ID   서버 전용. 회원아이디이며 URL 질의문자열에 실린다.
 *
 * ★ URL 에 식별자가 들어가므로 URL 을 통째로 로그에 남기지 않는다. 오류 본문에
 *   섞여 돌아올 수도 있으므로 redact() 를 거쳐서만 기록한다.
 * ★ 이 값은 저장소·커밋·로그 어디에도 들어가지 않는다.
 */

const HOST = process.env.ADPICK_HOTDEAL_HOST || 'https://adpick.co.kr';
const PATH = '/apis/sdk_shopping_hotdeal.php';

/** 공식 제한: 최대 1분 1회. 우리는 여유를 두고 이 간격을 강제한다. */
const MIN_INTERVAL_MS = Number(process.env.ADPICK_HOTDEAL_MIN_INTERVAL_MS) || 60 * 1000;
const TIMEOUT_MS = Number(process.env.ADPICK_HOTDEAL_TIMEOUT_MS) || 15000;
/** 한 번에 받아 쓸 최대 항목 수. 응답이 커도 무한정 처리하지 않는다. */
const MAX_ITEMS = Number(process.env.ADPICK_HOTDEAL_MAX_ITEMS) || 200;

/* 프로세스 안에서만 사는 호출 기록. 수집기는 하루 두 번 도는 단일 프로세스라
 * 이것으로 1분 제한을 지키기에 충분하다. 여러 인스턴스가 동시에 뜨는 구조가
 * 되면 hotdeal_job_state 로 옮겨야 한다. */
let lastCallAt = 0;

function affid() {
  return String(process.env.ADPICK_AFFILIATE_ID || '').trim();
}

/** 자격증명이 준비됐는가. 값 자체는 절대 돌려주지 않는다. */
function hasCredential() { return !!affid(); }

/**
 * 로그·오류에 실릴 문자열에서 회원아이디를 지운다.
 * 값을 모르면 지울 수도 없으므로, 질의문자열 형태도 함께 막는다.
 */
function redact(text) {
  let s = String(text == null ? '' : text);
  const id = affid();
  if (id) s = s.split(id).join('***AFFID***');
  return s.replace(/affid=[^&\s"']*/gi, 'affid=***');
}

/**
 * 공식 응답 → 우리 후보 raw 형태.
 *
 * ★ 순수 함수다. 네트워크를 타지 않으므로 fixture 로 검증할 수 있다.
 *   affid 가 없는 환경에서도 이 부분은 전부 테스트된다.
 *
 * @returns {{items: Array, dropped: number}}
 */
function parseHotdealResponse(body) {
  const out = [];
  let dropped = 0;

  // 공식 응답은 { list: [...] } 다. 방어적으로 배열 자체도 받는다.
  const list = Array.isArray(body) ? body
    : (body && Array.isArray(body.list) ? body.list : null);
  if (!list) return { items: [], dropped: 0, malformed: true };

  list.slice(0, MAX_ITEMS).forEach(raw => {
    const it = raw && typeof raw === 'object' ? raw : null;
    if (!it) { dropped++; return; }

    const buyurl = String(it.buyurl || '').trim();
    const name = String(it.product_name || '').trim();
    // buyurl 은 이 상품의 유일한 식별자이자 구매 경로다. 없으면 쓸 수 없다.
    if (!buyurl || !name) { dropped++; return; }

    out.push({
      // normalizeCandidate 가 읽는 이름으로 맞춰서 넘긴다.
      title: name,
      price_sale: it.price_sale,
      price_org: it.price_org,
      photo: it.photo,
      mall: it.mall,
      buyurl,
      commission: it.commission,
      // 외부 식별자: buyurl 이 같은 상품이면 재수집 때도 같다.
      externalId: buyurl
    });
  });

  return { items: out, dropped, malformed: false };
}

/**
 * 핫딜 목록을 받아온다. ★ 절대 throw 하지 않는다.
 *
 * source 하나가 실패해도 internal-history 는 계속 돌아야 하므로, 실패는
 * 예외가 아니라 값으로 돌려준다.
 *
 * @returns {{ok:boolean, items:Array, reason:string, status:number}}
 */
async function fetchHotdeals(opts) {
  const o = opts || {};
  const now = Date.now();

  if (!hasCredential()) {
    return { ok: false, items: [], reason: 'no-credential', status: 0 };
  }

  // 공식 제한 — 1분 1회 이하. 넘으면 부르지 않는다(오류가 아니라 정상 동작).
  const since = now - lastCallAt;
  if (lastCallAt && since < MIN_INTERVAL_MS) {
    return { ok: false, items: [], reason: 'rate-limited', status: 0, retryInMs: MIN_INTERVAL_MS - since };
  }

  const url = `${HOST}${PATH}?affid=${encodeURIComponent(affid())}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs || TIMEOUT_MS);
  lastCallAt = now;      // 실패해도 간격은 소모된 것으로 본다 (재시도 폭주 방지)

  let r, text;
  try {
    r = await fetch(url, {
      signal: ac.signal,
      headers: {
        'User-Agent': process.env.ADPICK_USER_AGENT || 'SEOSA/1.0 (+https://seosa.ai.kr)',
        Accept: 'application/json'
      }
    });
    text = await r.text();
  } catch (e) {
    const timedOut = e && e.name === 'AbortError';
    // ★ e.message 에 URL 이 실려 올 수 있다. 반드시 redact 한다.
    console.warn(`[adpick-hot] ${timedOut ? '시간 초과' : '네트워크 오류'}: ${redact(e && e.message)}`);
    return { ok: false, items: [], reason: timedOut ? 'timeout' : 'network', status: 0 };
  } finally {
    clearTimeout(timer);
  }

  if (!r.ok) {
    console.warn(`[adpick-hot] HTTP ${r.status}: ${redact((text || '').replace(/<[^>]*>/g, ' ')).slice(0, 150)}`);
    return { ok: false, items: [], reason: `http-${r.status}`, status: r.status };
  }

  let body;
  try { body = JSON.parse(text); }
  catch (e) {
    console.warn('[adpick-hot] 응답이 JSON 이 아니다');
    return { ok: false, items: [], reason: 'parse', status: r.status };
  }

  const parsed = parseHotdealResponse(body);
  if (parsed.malformed) {
    console.warn('[adpick-hot] 응답에 list 배열이 없다');
    return { ok: false, items: [], reason: 'malformed', status: r.status };
  }
  if (parsed.dropped) console.warn(`[adpick-hot] 쓸 수 없는 항목 ${parsed.dropped}건 제외`);
  return { ok: true, items: parsed.items, reason: 'ok', status: r.status, dropped: parsed.dropped };
}

/** 테스트가 프로세스 기억을 지우기 위해 부른다. */
function _resetRateLimit() { lastCallAt = 0; }

module.exports = {
  hasCredential, redact, parseHotdealResponse, fetchHotdeals,
  MIN_INTERVAL_MS, MAX_ITEMS,
  _internal: { _resetRateLimit }
};
