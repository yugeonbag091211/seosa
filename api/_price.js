'use strict';
/*
 * 가격 값 하나를 다루는 규칙을 전부 여기 모은다.
 *
 * 왜 따로 뺐는가 — 2026-08-09 감사에서 확인한 것
 *   SEOSA 가 75,000원으로 보여주는 상품이 쿠팡에서는 39,900원이었다. 원인은
 *   "가격을 잘못 파싱해서"가 아니라 가격이 흐르는 경로가 세 갈래인데
 *   (api/search, api/cron, scripts/collect-all-prices) 각자 다른 규칙으로
 *   쓰고 있었기 때문이다. 규칙이 흩어져 있으면 한 곳을 고쳐도 나머지 두 곳으로
 *   같은 오염이 계속 들어온다. 가격 판정은 이 파일 하나만 고치면 되게 한다.
 *
 * 실측 근거 (2026-08-09, 운영 Supabase)
 *   - products.lprice 와 같은 날 쿠팡 캐시 가격이 200건 중 39건(19.5%) 불일치.
 *     최대 2.42배 차이. 예: DB 75,000 / 쿠팡 39,900 (암막커튼)
 *   - 같은 product_id 에 서로 다른 상품명(=옵션)이 붙은 사례 9건.
 *     예: 9536222150 "블루 그레이-GY" / "펄 화이트-WT"
 *   - 같은 product_id 의 가격이 하루 만에 34,500 → 1,528,000 (44배)로 튄 사례.
 *     연속 관측 803쌍 중 7쌍(0.9%)이 3배 이상 급변.
 */

/*
 * 쿠팡 파트너스 검색 API 의 가격 필드 — 무엇을 확인했고 무엇은 확인 못 했나.
 *
 * ── 확인된 것 (관측 근거 있음) ────────────────────────────────────
 *   1) 이 엔드포인트 응답에서 우리가 실제로 본 가격 필드는 productPrice 하나다.
 *      · coupang_search_cache 53개 항목의 저장된 item 키 조합 3종을 전수 확인:
 *        어디에도 discountPrice 에서 유래한 값이 없다.
 *      · 같은 캐시의 표본에서 lprice === oprice 다. oprice 는
 *        parseInt(productPrice) 이므로, discountPrice 가 응답에 있었다면
 *        두 값이 갈렸을 것이다.
 *      · scripts/test-coupang.js 의 fixture 도 같은 필드 구성이다
 *        (productId / productName / productPrice / productImage / productUrl).
 *   2) 따라서 basePrice / salePrice / originalPrice 같은 별도 정가 필드를
 *      이 엔드포인트에서 얻을 수 없다. 정가 대비 할인율은 계산 근거가 없다.
 *
 * ── 확인하지 못한 것 (단정하지 말 것) ─────────────────────────────
 *   productPrice 가 상품 페이지(PDP)의 실판매가와 "항상" 같은지는 확인되지
 *   않았다. 확인하려면 같은 시점의 PDP 가격과 대조해야 하는데, 그건 이
 *   엔드포인트로 할 수 없는 일이고 대량 호출도 하지 않기로 했다.
 *   알려진 위험 요인만 적어 둔다 — 검색 API 는 색인 시점 값을 줄 수 있고,
 *   쿠폰적용가 · 회원가 · 카드할인가는 애초에 응답에 없다.
 *
 * ── 그래서 코드가 하는 일 ─────────────────────────────────────────
 *   productPrice   우리가 가진 유일한 가격이므로 이것을 판매가로 쓴다.
 *                  "가장 정확한 값"이어서가 아니라 "유일하게 확인된 값"이라서다.
 *   discountPrice  관측된 적이 없다. 쿠팡이 나중에 추가할 수 있으므로
 *                  "있고, 유효하고, productPrice 이하일 때만" 판매가로 인정한다.
 *                  (예전 코드는 `discountPrice || productPrice` 라서 그 값이
 *                   정가처럼 더 크게 들어와도 그대로 판매가로 삼았을 것이다)
 */

/** 이 이상은 상품 가격이 아니라 파싱 사고로 본다. */
const MAX_PRICE = 100000000;   // 1억원

/**
 * 직전 관측 대비 이 배수 이상 벌어지면 "확인 전까지는 현재가로 올리지 않는다".
 *
 * 5배 = 80% 변동. 이 선을 고른 이유:
 *   - 정상적인 대폭 할인은 여기 걸리지 않는다. 75,000 → 30,000 은 2.5배다.
 *     쿠팡의 실제 특가도 -70% 언저리가 상한이라 5배를 넘지 않는다.
 *   - 실제로 관측된 오염은 전부 이 선 바깥이었다.
 *     34,500 → 1,528,000 (44배), 733,950 → 18,500 (39배), 13,500 → 1,890 (7배)
 *   - api/init.js 가 시세판에서 쓰는 MAX_PLAUSIBLE_DROP_PCT(80%)와 같은 기준이다.
 *     노출 단계와 저장 단계가 다른 잣대를 쓰면 안 된다.
 */
const SUSPECT_RATIO = 5;

/**
 * 직전 관측이 이보다 오래됐으면 급변을 의심하지 않는다.
 *
 * 두 달 전 가격과 오늘 가격이 5배 차이 나는 건 이상한 일이 아니다.
 * 의심은 "짧은 시간에 튀었다"에만 걸어야 오탐이 없다.
 */
const SUSPECT_WINDOW_DAYS = 21;

/**
 * 옵션이 바뀌었을 때 급변을 의심하기 시작하는 배수.
 *
 * 쿠팡은 같은 productId 아래 색상·용량·수량 옵션을 묶어 두고, 검색 API 는
 * 그중 한 옵션의 가격을 돌려준다. 어떤 옵션이 올지는 우리가 고를 수 없다.
 * 실제로 같은 productId 가 "블루 그레이-GY"와 "펄 화이트-WT"로 번갈아 왔다.
 * 옵션이 바뀐 게 확인되면(vendorItemId 변경) 2배만 벌어져도 같은 상품의
 * 가격 변동이라고 단정할 수 없다.
 */
const OPTION_SWITCH_RATIO = 2;

/**
 * 문자열/숫자 무엇이 오든 원 단위 정수로. 값이 아니면 null.
 *
 * null 을 돌려주는 것이 중요하다. 0 을 돌려주면 호출부가 "0원짜리 상품"과
 * "가격을 못 읽음"을 구분하지 못한다. 예전 코드의 `parseInt(...) || 0` 이
 * 정확히 그 상태였다.
 *
 *   parsePrice(30000)      → 30000
 *   parsePrice('30,000')   → 30000
 *   parsePrice('30,000원') → 30000
 *   parsePrice('₩ 30,000') → 30000
 *   parsePrice(0)          → null
 *   parsePrice(-1)         → null
 *   parsePrice(undefined)  → null
 *   parsePrice('무료')     → null
 *   parsePrice(NaN)        → null
 *   parsePrice(1e9)        → null   (MAX_PRICE 초과)
 */
function parsePrice(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;

  let n;
  if (typeof v === 'number') {
    n = v;
  } else {
    // 숫자와 소수점만 남긴다. 쉼표 · 원 · ₩ · 공백 · KRW 전부 여기서 사라진다.
    const cleaned = String(v).replace(/[^\d.]/g, '');
    if (!cleaned || !/\d/.test(cleaned)) return null;
    n = Number(cleaned);
  }

  if (!Number.isFinite(n)) return null;
  n = Math.round(n);
  if (n <= 0 || n > MAX_PRICE) return null;
  return n;
}

/** 저장해도 되는 가격인가. parsePrice 를 이미 통과한 값에 쓴다. */
function isSanePrice(n) {
  return Number.isInteger(n) && n > 0 && n <= MAX_PRICE;
}

/** ISO 문자열 두 개 사이의 일수. 못 읽으면 Infinity(=오래됨). */
function ageDays(iso, now) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return Infinity;
  return ((now === undefined ? Date.now() : now) - t) / 86400000;
}

/**
 * 새로 관측한 가격을 어떻게 다룰지 판정한다.
 *
 * @param {*} rawNext  이번에 받아온 가격 (문자열이어도 된다)
 * @param {object} prev 직전에 알고 있던 값
 *        price          직전 가격
 *        observedAt     직전 관측 시각 (ISO). 없으면 기간 조건을 보지 않는다
 *        vendorItemId   직전 옵션 식별자
 * @param {object} next 이번 관측의 부가 정보
 *        vendorItemId   이번 옵션 식별자
 *
 * @returns {{status:'ok'|'invalid'|'suspect', price:number|null, reason:string, ratio:number}}
 *
 *   ok       — 그대로 저장한다.
 *   invalid  — 값이 아니다. price_history 에도 products 에도 쓰지 않는다.
 *   suspect  — 값 자체는 멀쩡하지만 직전 관측과 앞뒤가 안 맞는다.
 *              관측 사실은 price_history 에 남기되 products 의 현재가로는
 *              올리지 않는다. 다음 관측에서 같은 수준이 다시 나오면
 *              (그때는 직전 가격이 이 값이라 ratio≈1 이 되어) 자동으로 승격된다.
 *              → 진짜 가격 변동은 하루 늦게 반영되고, 왔다 갔다 하는
 *                오염값은 영원히 현재가가 되지 못한다.
 */
function classifyPrice(rawNext, prev, next) {
  const price = parsePrice(rawNext);
  if (price === null) {
    return { status: 'invalid', price: null, ratio: 0, reason: `가격 값 아님(${JSON.stringify(rawNext)})` };
  }

  const prevPrice = prev && parsePrice(prev.price);
  if (!prevPrice) {
    // 처음 보는 상품이다. 비교할 대상이 없으면 의심할 근거도 없다.
    return { status: 'ok', price, ratio: 0, reason: '' };
  }

  const ratio = price > prevPrice ? price / prevPrice : prevPrice / price;

  const gap = prev.observedAt ? ageDays(prev.observedAt) : 0;
  if (gap > SUSPECT_WINDOW_DAYS) {
    return { status: 'ok', price, ratio, reason: '' };
  }

  const prevVendor = prev && prev.vendorItemId ? String(prev.vendorItemId) : '';
  const nextVendor = next && next.vendorItemId ? String(next.vendorItemId) : '';
  const optionSwitched = !!(prevVendor && nextVendor && prevVendor !== nextVendor);

  const limit = optionSwitched ? OPTION_SWITCH_RATIO : SUSPECT_RATIO;
  if (ratio >= limit) {
    return {
      status: 'suspect',
      price,
      ratio,
      reason: optionSwitched
        ? `옵션이 바뀌면서 ${ratio.toFixed(1)}배 변동 (${prevPrice}→${price}, vendorItemId ${prevVendor}→${nextVendor})`
        : `${Math.round(gap)}일 만에 ${ratio.toFixed(1)}배 변동 (${prevPrice}→${price})`
    };
  }

  return { status: 'ok', price, ratio, reason: '' };
}

/**
 * 쿠팡 제휴 링크에서 판매 단위 식별자를 뽑는다.
 *
 * productId 는 "상품 페이지" 단위라 색상·용량 옵션이 전부 한 값을 공유한다.
 * 실제로 팔리는 단위는 itemId / vendorItemId 다. 운영 DB 의 쿠팡 상품
 * 654행 전부가 링크에 이 두 값을 달고 있는데, 지금까지 버리고 있었다.
 * 그래서 옵션이 바뀐 것을 "가격이 내렸다"와 구분할 수 없었다.
 */
function coupangItemIds(url) {
  const s = String(url || '');
  const item = s.match(/[?&]itemId=(\d+)/);
  const vendor = s.match(/[?&]vendorItemId=(\d+)/);
  return {
    itemId: item ? item[1] : '',
    vendorItemId: vendor ? vendor[1] : ''
  };
}

/**
 * 이 몰의 가격을 지금도 다시 받아올 수 있는가.
 *
 * 네이버 연동은 제거됐다(커밋 844a497). 그런데 products 에는 그때 수집된
 * 네이버·네이버쇼핑·개별 판매자 몰 행이 700개 넘게 남아 있고, 홈 섹션이
 * 그 행의 lprice 를 아무 표시 없이 현재가로 그리고 있다. 다시 받아올 방법이
 * 없으니 시간이 갈수록 반드시 틀려진다.
 *
 * 실제 사례: "삼성전자 갤럭시 핏3 SM-R390N" product_id=55900277517
 *   mall=네이버, link=search.shopping.naver.com/catalog/...,
 *   lprice=75,000, collected_at=2026-07-27 이후 갱신 없음.
 *   같은 상품의 실제 판매가는 3만원대다.
 */
function isRefreshableMall(mall) {
  return String(mall || '') === '쿠팡';
}

/* ------------------------------------------------------------------ *
 *  가격 하락 판정
 *
 *  원래 api/init.js 안에만 있었다. 검색 결과에도 "가격 하락" 필터·정렬이
 *  생기면서 같은 판정을 두 곳에서 하게 됐고, 정의가 갈라지면 홈 시세판과
 *  검색 결과가 서로 다른 상품을 "하락"이라고 부르게 된다. 정의는 하나여야 한다.
 *  로직은 옮기기만 했고 기준은 그대로다.
 * ------------------------------------------------------------------ */

/**
 * 하루 사이에 이만큼 넘게 내려갔으면 실제 인하가 아니라 매칭 오류로 본다.
 *
 * 쿠팡 검색 API는 같은 productId 에 대해 옵션·묶음 중 최저가를 돌려줄 때가 있다.
 * 그 값이 그대로 기록되면 733,950원짜리 로봇청소기가 18,500원으로 "97.5% 하락"한
 * 것처럼 남는다. 이걸 홈 최상단 시세판 1위로 올리면 사용자는 눌러서 전혀 다른
 * 가격을 보게 되고, 사이트를 한 번 더 쓸 이유가 사라진다.
 *
 * SUSPECT_RATIO(5배 = 80%)와 같은 선이다. 저장 단계와 노출 단계가 다른 잣대를
 * 쓰면 안 된다.
 */
const MAX_PLAUSIBLE_DROP_PCT = 80;

/**
 * price_drop_top 한 행이 "실제로 값이 내려간 것"으로 보이는가.
 *
 * ★ 단순히 지금 가격이 싸다는 것과는 다르다. 직전 관측(prev_price)보다
 *   실제로 내려갔고, 그 폭이 설명 가능한 범위 안일 때만 하락으로 본다.
 *
 * @param {object} p price_drop_top 행
 *   (product_id, mall, current_price, prev_price, drop_pct, link)
 */
function plausibleDrop(p) {
  if (!p) return false;
  const cur = Number(p.current_price) || 0;
  const prev = Number(p.prev_price) || 0;
  const pct = Number(p.drop_pct) || 0;
  if (cur <= 0 || prev <= 0) return false;
  if (cur >= prev) return false;                       // 하락이 아닌 행
  /*
   * 다시 수집되지 않는 몰의 행은 하락으로 치지 않는다. 하락폭이 그럴듯해
   * 보여도 두 값 모두 옛날 값이라 "오늘의 가격 하락"이 아니다.
   * (product_id 자리에 상품명이 들어간 옛 이관분도 여기서 같이 걸러진다 —
   *  그런 행은 링크가 없어 클릭해도 갈 곳이 없다)
   */
  if (!isRefreshableMall(p.mall)) return false;
  if (!/^\d+$/.test(String(p.product_id || ''))) return false;
  if (!p.link) return false;
  return pct > 0 && pct < MAX_PLAUSIBLE_DROP_PCT;
}

/**
 * 이 행의 판매 단위 식별자. 컬럼이 비어 있으면 link 에서 뽑는다.
 *
 * products.vendor_item_id 는 2026-08-09 마이그레이션으로 막 생긴 컬럼이라
 * 기존 654행이 전부 빈 문자열이다. 그런데 같은 행의 link 에는 그 값이
 * 처음부터 들어 있었다 (654/654 확인). 컬럼이 채워지기를 기다릴 이유가 없다 —
 * 읽을 때 link 에서 뽑으면 옵션 교체 감지가 지금 당장 전 행에 적용된다.
 * DB 에 쓰지 않으므로 기존 데이터를 건드리지 않는다. 다음 수집부터는
 * 컬럼에도 값이 들어가고, 그때는 컬럼 값이 우선한다.
 */
function vendorIdOf(row) {
  if (!row) return '';
  const direct = row.vendor_item_id || row.vendorItemId;
  if (direct) return String(direct);
  return coupangItemIds(row.link).vendorItemId;
}

/** itemId 도 같은 규칙. */
function itemIdOf(row) {
  if (!row) return '';
  const direct = row.item_id || row.itemId;
  if (direct) return String(direct);
  return coupangItemIds(row.link).itemId;
}

/*
 * 상품 행의 생애 상태.
 *
 * 두 가지를 분리해서 판정한다. 섞으면 둘 다 틀린다.
 *
 *   state     — "이 가격을 지금 보여줘도 되는가" (노출 판정)
 *               오늘 확인한 값이면 정확한 값이다. 내일 다시 확인할 수 있는지는
 *               지금 이 가격의 정확성과 무관하다.
 *   reachable — "수집기가 이 상품을 다시 찾아갈 수 있는가" (수집 판정)
 *               keyword 가 없으면 검색을 시작할 단서가 없다.
 *
 *   처음에는 keyword 없는 행을 노출에서도 막았는데, 그러면 오늘 확인한
 *   정확한 가격까지 숨기게 된다. 어차피 갱신이 안 되면 maxAge 를 넘겨
 *   자연히 stale 로 떨어진다 — 그때 막으면 충분하다.
 *
 * 2026-08-09 실측(products 1,363행)
 *   dead-mall  709  네이버 등 연동이 끊긴 몰      → 다시 받아올 방법 없음, 노출 금지
 *   stale      467  확인이 오래됨                 → 수집이 돌면 살아난다
 *   live       187  최근 확인됨                   → 노출 가능
 *   그중 reachable=false (쿠팡인데 keyword 없음) 287행 → 수집기가 못 찾던 행
 *
 * 지우지 않는다. 상태를 붙여서 노출·수집 대상을 각각 결정할 뿐이다.
 * (기존 데이터를 삭제하면 price_history 의 과거 기록이 고아가 된다)
 */
const LIFECYCLE = {
  LIVE: 'live',
  STALE: 'stale',
  DEAD_MALL: 'dead-mall',
  INVALID: 'invalid'
};

/** 현재가로 내보내도 되는 최대 나이(일). 환경변수로 조정 가능. */
const MAX_DISPLAY_AGE_DAYS = Number(process.env.PRICE_MAX_DISPLAY_AGE_DAYS) || 10;

/**
 * @param {object} row  products 행 (product_id, mall, keyword, lprice, collected_at)
 * @returns {{state:string, reason:string, ageDays:number, reachable:boolean}}
 */
function productLifecycle(row, opts = {}) {
  const maxAge = opts.maxAgeDays || MAX_DISPLAY_AGE_DAYS;
  const age = ageDays(row && row.collected_at);
  // 수집기가 다시 찾아갈 수 있는가 — 노출 판정과 별개다.
  const reachable = !!(row && isRefreshableMall(row.mall) && row.keyword);
  const out = (state, reason) => ({ state, reason, ageDays: age, reachable });

  if (!row || !row.product_id) return out(LIFECYCLE.INVALID, '식별자 없음');
  if (!isRefreshableMall(row.mall)) return out(LIFECYCLE.DEAD_MALL, `${row.mall || '알 수 없는 몰'} 연동 없음`);
  if (!(Number(row.lprice) > 0)) return out(LIFECYCLE.INVALID, '가격 값 이상');
  if (age > maxAge) {
    return out(LIFECYCLE.STALE,
      Number.isFinite(age) ? `${Math.round(age)}일간 확인 안 됨` : '확인 시점 불명');
  }
  return out(LIFECYCLE.LIVE, '');
}

/** 현재가로 사용자에게 보여줘도 되는가. */
function isDisplayable(row, opts) {
  return productLifecycle(row, opts).state === LIFECYCLE.LIVE;
}

module.exports = {
  MAX_PRICE, SUSPECT_RATIO, SUSPECT_WINDOW_DAYS, OPTION_SWITCH_RATIO, MAX_DISPLAY_AGE_DAYS,
  MAX_PLAUSIBLE_DROP_PCT, LIFECYCLE,
  parsePrice, isSanePrice, ageDays, classifyPrice, coupangItemIds, isRefreshableMall,
  vendorIdOf, itemIdOf, productLifecycle, isDisplayable, plausibleDrop
};
