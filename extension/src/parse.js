/*
 * SEOSA 가격 기록 확장 — 주소 · 제목 해석. 순수 함수만 있다.
 *
 * 브라우저(콘텐츠 스크립트 · 서비스 워커)와 Node(테스트) 양쪽에서 같은 파일을 쓴다.
 * 그래서 빌드 도구 없이 이 파일 하나가 두 환경을 모두 안다 (맨 아래 내보내기).
 *
 * ── 왜 주소를 이렇게 까다롭게 읽는가 ─────────────────────────────
 *
 * 이 함수가 null 이 아닌 값을 돌려주는 순간, 그 값이 서버로 가는 요청의 근거가 된다.
 * 서비스 워커(background.js)는 «메시지를 보낸 탭의 주소» 를 이 함수로 한 번 더 읽어서
 * 지원하는 상품 페이지가 아니면 요청을 만들지 않는다. 그러니 여기가 느슨하면
 *
 *     https://www.coupang.com.evil.example/vp/products/1
 *     https://evilcoupang.com/vp/products/1
 *     https://www.coupang.com@evil.example/vp/products/1
 *     http://www.coupang.com/vp/products/1        (암호화되지 않은 페이지)
 *
 * 같은 주소가 «쿠팡 상품 페이지» 로 통과한다. 그래서 문자열 검사가 아니라 URL 파서로
 * 호스트를 뽑고, 호스트는 «정확히 같을 때만» 인정한다 (접미사·포함 비교 금지).
 *
 * ── 지원 페이지 (manifest.json content_scripts 와 같은 범위) ────────
 *
 *   쿠팡     https://www.coupang.com/vp/products/{productId}?itemId=..&vendorItemId=..   → 번호로 정확히 (EXACT)
 *   11번가   https://www.11st.co.kr/products/{번호}                                     → 제목으로 (SIMILAR)
 *   G마켓    https://item.gmarket.co.kr/Item?goodscode={번호}                           → 제목으로 (SIMILAR)
 *
 * 11번가·G마켓의 번호는 SEOSA 카탈로그의 번호와 다른 체계다. 그래서 확장은 그 번호를
 * 서버로 보내지 않는다 (background.js 주석 — 우연히 같은 숫자인 쿠팡 상품과 섞이면 안 된다).
 */
(function () {
  'use strict';

  /** 서버 주소. 확장이 네트워크로 나가는 곳은 이 출처의 /api/lookup 하나뿐이다. */
  var SEOSA_ORIGIN = 'https://seosa.ai.kr';
  /** 제목 상한 — 서버(api/_lookup.js MAX_TITLE)와 같은 값. */
  var MAX_TITLE = 200;
  /** 쿠팡 식별자는 전부 숫자. 20자리면 int64 를 넉넉히 덮는다. */
  var ID_RE = /^\d{1,20}$/;

  var HOSTS = {
    coupang: 'www.coupang.com',
    '11st': 'www.11st.co.kr',
    gmarket: 'item.gmarket.co.kr'
  };

  function isId(v) {
    return typeof v === 'string' && ID_RE.test(v);
  }

  /** 선택 식별자 — 숫자가 아니면 버린다(빈 값). 고쳐 읽지 않는다: "12a" 를 "12" 로 읽으면 남의 상품이다. */
  function optionalId(v) {
    return isId(v) ? v : '';
  }

  /** 대소문자 무관 쿼리 값 (G마켓은 goodscode · goodsCode 를 섞어 쓴다). 같은 키가 둘이면 모호하니 버린다. */
  function queryValue(params, name) {
    var want = name.toLowerCase();
    var found = [];
    params.forEach(function (value, key) {
      if (String(key).toLowerCase() === want) found.push(String(value));
    });
    return found.length === 1 ? found[0] : '';
  }

  /**
   * 상품 상세 페이지 주소 → 식별자. 상품 페이지가 아니거나 조금이라도 이상하면 null.
   *
   * @param {string} url
   * @returns {{site:'coupang'|'11st'|'gmarket', productId:string, itemId:string, vendorItemId:string}|null}
   */
  function parseProductUrl(url) {
    if (typeof url !== 'string' || !url || url.length > 2048) return null;
    var u;
    try { u = new URL(url); } catch (e) { return null; }
    if (u.protocol !== 'https:') return null;             // 암호화되지 않은 페이지는 받지 않는다
    if (u.username || u.password) return null;            // https://www.coupang.com@evil.example/ 류
    if (u.port && u.port !== '443') return null;
    var host = u.hostname.toLowerCase();
    var m;

    if (host === HOSTS.coupang) {
      m = /^\/vp\/products\/(\d{1,20})\/?$/.exec(u.pathname);
      if (!m) return null;
      return {
        site: 'coupang',
        productId: m[1],
        itemId: optionalId(queryValue(u.searchParams, 'itemId')),
        vendorItemId: optionalId(queryValue(u.searchParams, 'vendorItemId'))
      };
    }
    if (host === HOSTS['11st']) {
      m = /^\/products\/(\d{1,20})\/?$/.exec(u.pathname);
      if (!m) return null;
      return { site: '11st', productId: m[1], itemId: '', vendorItemId: '' };
    }
    if (host === HOSTS.gmarket) {
      if (!/^\/item\/?$/i.test(u.pathname)) return null;
      var code = queryValue(u.searchParams, 'goodscode');
      if (!isId(code)) return null;
      return { site: 'gmarket', productId: code, itemId: '', vendorItemId: '' };
    }
    return null;
  }

  /** 같은 상품 · 같은 옵션인가 — 주소 감시(content.js)가 «다른 상품으로 넘어갔는지» 를 가를 때 쓴다. */
  function productKey(p) {
    return p ? [p.site, p.productId, p.vendorItemId || ''].join('|') : '';
  }

  /*
   * 페이지 제목에 붙는 몰 이름을 뗀다. 서버(api/_lookup.js cleanTitle)와 같은 규칙이다 —
   * scripts/test-v2-extension.js 가 둘의 출력이 같음을 고정한다.
   * 몰 이름이 남으면 SEOSA 가 제목을 비교할 때 '쿠팡' 을 상품 낱말로 세어 같은 상품을 놓친다.
   */
  var MALL_NAMES = '(?:쿠팡!?|coupang|11번가|11st|g마켓|gmarket|지마켓)';
  var SEP = '[-|:·–—]';
  var TITLE_RULES = [
    new RegExp('\\s+-\\s+[^-|]{1,30}\\s*\\|\\s*쿠팡!?\\s*$', 'i'),
    new RegExp('\\s*' + SEP + '\\s*' + MALL_NAMES + '\\s*$', 'i'),
    new RegExp('^\\s*\\[\\s*' + MALL_NAMES + '\\s*\\]\\s*', 'i'),
    new RegExp('^\\s*' + MALL_NAMES + '\\s*' + SEP + '\\s*', 'i')
  ];
  var ONLY_MALL_RE = new RegExp('^' + MALL_NAMES + '$', 'i');

  /**
   * 페이지 제목 정리 — 제어문자 제거 · 공백 접기 · 몰 이름 떼기 · 200자.
   * @param {*} raw
   * @returns {string}
   */
  function cleanTitle(raw) {
    var s = String(raw == null ? '' : raw)
      .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    for (var i = 0; i < 3; i++) {
      var before = s;
      for (var k = 0; k < TITLE_RULES.length; k++) s = s.replace(TITLE_RULES[k], '').trim();
      if (s === before) break;
    }
    if (ONLY_MALL_RE.test(s)) s = '';
    return Array.from(s).slice(0, MAX_TITLE).join('').trim();
  }

  var SEOSAParse = {
    SEOSA_ORIGIN: SEOSA_ORIGIN,
    MAX_TITLE: MAX_TITLE,
    ID_RE: ID_RE,
    HOSTS: HOSTS,
    isId: isId,
    parseProductUrl: parseProductUrl,
    productKey: productKey,
    cleanTitle: cleanTitle
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SEOSAParse;
  else self.SEOSAParse = SEOSAParse;
})();
