/*
 * SEOSA 가격 기록 확장 — 서비스 워커.
 *
 * ── 이 파일이 하는 일은 두 가지뿐이다 ─────────────────────────────
 *
 *   1) 콘텐츠 스크립트의 'seosa:lookup' 메시지를 받아 https://seosa.ai.kr/api/lookup 을
 *      «한 번» 부르고 결과를 돌려준다. 확장이 네트워크로 나가는 곳은 이 한 곳뿐이다.
 *   2) 툴바 아이콘을 누르면 «상품 페이지에 버튼 보이기» 설정을 켜고 끈다 (chrome.storage.local).
 *
 * ── 왜 콘텐츠 스크립트가 직접 부르지 않는가 ────────────────────────
 *
 * 콘텐츠 스크립트의 요청은 쿠팡 페이지의 출처(origin)로 나간다. 그러면 요청마다
 * 쿠팡 주소가 Origin/Referer 로 붙고, 페이지의 CSP·서비스 워커가 요청에 끼어들 여지가
 * 생긴다. 확장 서비스 워커에서 부르면 요청은 확장 출처에서, 쿠키 없이(credentials:'omit'),
 * 리퍼러 없이 나간다 — 서버가 받는 것은 쿼리에 적은 값뿐이다.
 *
 * ── 받는 메시지를 믿지 않는다 ─────────────────────────────────────
 *
 *   · 보낸 쪽이 이 확장인가               sender.id === chrome.runtime.id
 *   · 보낸 탭이 지원하는 상품 페이지인가   sender.url 을 parse.js 로 다시 읽는다
 *   · 메시지의 번호가 그 탭 주소의 번호와 같은가 (쿠팡)
 *   · 번호는 숫자, 제목은 200자            정규식으로 검사하고 고쳐 읽지 않는다
 *
 * ★ 11번가·G마켓 페이지에서는 제목만 보낸다. 그 몰의 상품 번호는 SEOSA 카탈로그(쿠팡 번호)와
 *   다른 체계라, 우연히 같은 숫자의 쿠팡 상품이 «정확히 같은 상품» 으로 잡힐 수 있다.
 * ★ 쿠키·방문 기록·다른 탭을 읽지 않는다. 그럴 권한(cookies·history·tabs)을 요청하지도 않았다.
 */
'use strict';

try {
  // 서비스 워커 기준 상대 경로 — src/parse.js. 같은 규칙을 콘텐츠 스크립트와 공유한다.
  importScripts('parse.js');
} catch (e) {
  // parse.js 를 못 읽으면 아래 check 가 전부 거절한다 (P 가 없으면 요청을 만들지 않는다).
}

var P = self.SEOSAParse || null;

/** 서버 주소 — 이 확장이 부르는 유일한 엔드포인트. host_permissions 와 같은 출처. */
var LOOKUP_URL = 'https://seosa.ai.kr/api/lookup';
/** 응답을 기다리는 최대 시간. 넘기면 끊고 문장으로 알린다. */
var TIMEOUT_MS = 10000;
/** chrome.storage.local 에 저장하는 유일한 값 — 버튼을 보일지 (기본: 보인다). */
var PREF_KEY = 'seosaShowButton';
var SITES = { coupang: true, '11st': true, gmarket: true };

function reject(error) {
  return { ok: false, error: error };
}

function senderUrl(sender) {
  if (!sender) return '';
  if (typeof sender.url === 'string' && sender.url) return sender.url;
  return sender.tab && typeof sender.tab.url === 'string' ? sender.tab.url : '';
}

/**
 * 메시지 검증 → 서버로 보낼 쿼리 파라미터 목록. 거절이면 { error }.
 * @returns {{params:Array<[string,string]>}|{error:string}}
 */
function buildQuery(msg, sender) {
  if (!P) return { error: '확장 파일 일부를 읽지 못했어요. 확장을 다시 로드해 주세요.' };
  if (!sender || sender.id !== chrome.runtime.id) return { error: '허용되지 않은 요청이에요.' };
  var page = P.parseProductUrl(senderUrl(sender));
  if (!page) return { error: '지원하는 상품 페이지에서만 가격 기록을 볼 수 있어요.' };

  var site = typeof msg.site === 'string' ? msg.site : '';
  if (!SITES[site] || site !== page.site) return { error: '페이지 정보가 맞지 않아요. 새로고침 후 다시 눌러 주세요.' };

  var productId = typeof msg.productId === 'string' ? msg.productId : '';
  var vendorItemId = typeof msg.vendorItemId === 'string' ? msg.vendorItemId : '';
  var itemId = typeof msg.itemId === 'string' ? msg.itemId : '';
  if (!P.isId(productId)) return { error: '상품 번호를 읽지 못했어요.' };
  if (vendorItemId && !P.isId(vendorItemId)) return { error: '옵션 번호 형식이 올바르지 않아요.' };
  if (itemId && !P.isId(itemId)) return { error: '아이템 번호 형식이 올바르지 않아요.' };
  if (productId !== page.productId) return { error: '페이지 정보가 맞지 않아요. 새로고침 후 다시 눌러 주세요.' };

  var rawTitle = typeof msg.title === 'string' ? msg.title : '';
  if (rawTitle.length > 2000) return { error: '상품명이 너무 길어요.' };
  var title = P.cleanTitle(rawTitle);

  var params = [];
  if (site === 'coupang') {
    params.push(['productId', productId]);
    if (vendorItemId) params.push(['vendorItemId', vendorItemId]);
    if (itemId) params.push(['itemId', itemId]);
    if (title) params.push(['title', title]);
  } else {
    // 11번가·G마켓 — 제목만 (맨 위 주석).
    if (Array.from(title).length < 2) return { error: '이 페이지에서 상품명을 읽지 못했어요.' };
    params.push(['title', title]);
  }
  return { params: params };
}

function toUrl(params) {
  return LOOKUP_URL + '?' + params.map(function (kv) {
    return encodeURIComponent(kv[0]) + '=' + encodeURIComponent(kv[1]);
  }).join('&');
}

/** 서버 오류 → 사용자 문장. 서버가 준 문장은 짧게 잘라 그대로 쓴다 (화면은 textContent 로만 그린다). */
function errorOf(status, body) {
  if (status === 429) return '요청이 너무 잦아요. 잠시 후 다시 눌러 주세요.';
  if (status === 501) return 'SEOSA 서버에 아직 이 기능이 준비되지 않았어요.';
  var msg = body && typeof body.error === 'string' ? body.error.slice(0, 200) : '';
  return msg || '가격 기록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.';
}

/**
 * @returns {Promise<{ok:true, data:object}|{ok:false, error:string}>}
 */
function lookup(msg, sender) {
  var q = buildQuery(msg || {}, sender);
  if (q.error) return Promise.resolve(reject(q.error));

  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
  return fetch(toUrl(q.params), {
    method: 'GET',
    credentials: 'omit',          // 쿠키를 싣지 않는다 — 서버는 누가 눌렀는지 알 수 없다
    referrerPolicy: 'no-referrer',
    redirect: 'error',            // 다른 주소로 넘어가지 않는다 — 나가는 곳은 이 엔드포인트 하나
    headers: { Accept: 'application/json' },
    signal: ctrl.signal
  }).then(function (r) {
    return r.json().catch(function () { return null; }).then(function (body) {
      if (!r.ok) return reject(errorOf(r.status, body));
      if (!body || body.ok !== true || !body.match || typeof body.match.status !== 'string') {
        return reject('서버 응답을 읽지 못했어요.');
      }
      return { ok: true, data: body };
    });
  }).catch(function (e) {
    if (e && e.name === 'AbortError') return reject('응답이 늦어요. 잠시 후 다시 시도해 주세요.');
    return reject('SEOSA 서버에 연결하지 못했어요. 네트워크를 확인해 주세요.');
  }).then(function (out) {
    clearTimeout(timer);
    return out;
  });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'seosa:lookup') return false;
  lookup(msg, sender).then(sendResponse, function () {
    sendResponse(reject('가격 기록을 불러오지 못했어요.'));
  });
  return true;   // 비동기로 답한다
});

/*
 * 툴바 아이콘 = 버튼 보이기/숨기기. 패널의 «버튼 숨기기» 로 숨긴 뒤 다시 켜는 길이 여기다.
 * 탭 정보(주소 등)는 읽지 않는다 — 설정 값 하나만 뒤집는다.
 */
if (chrome.action && chrome.action.onClicked && chrome.storage && chrome.storage.local) {
  chrome.action.onClicked.addListener(function () {
    chrome.storage.local.get(PREF_KEY, function (items) {
      var shown = !items || items[PREF_KEY] !== false;
      var next = {};
      next[PREF_KEY] = !shown;
      chrome.storage.local.set(next);
    });
  });
}
