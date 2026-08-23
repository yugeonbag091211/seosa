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
 * 한국시간(Asia/Seoul) 기준 오늘 날짜 'YYYY-MM-DD'.
 *
 * ★ 이 값을 price_history.recorded_date 와 직접 비교하지 말 것.
 *
 *   recorded_date 는 우리가 정하는 값이 아니다. 운영 DB 가 recorded_at 을
 *   UTC 로 잘라 덮어쓴다 (생성 컬럼이거나 트리거). 2026-08-23 실측:
 *     · recorded_at=2026-08-22T18:11Z 인 행에 recorded_date='2026-08-23' 을
 *       보냈지만 저장된 값은 '2026-08-22' 였다 — 보낸 값이 무시된다.
 *     · price_history 15,155행 전부가 recorded_date === UTC(recorded_at). 예외 0건.
 *
 *   수집 크론은 KST 01·03·06시(= UTC 16·18·21시)에 돈다. 그래서 KST 달력으로
 *   오늘 받아온 가격이 전부 '어제' 라벨을 달고 저장된다. 라벨을 KST 로 착각하면:
 *     recorded_date === kstToday()  → 항상 0건 (그 라벨은 아직 존재하지 않는다)
 *     recorded_date <  kstToday()   → 오늘 새벽에 쓴 행까지 '직전 관측' 으로 딸려온다
 *   둘 다 실제로 났던 사고다 (알림 메일 전면 중단 / 직전 관측을 자기 자신과 비교).
 *
 *   그래서 "KST 로 어느 날인가" 는 라벨이 아니라 절대 시각 recorded_at 으로
 *   판정한다 — 읽어온 값은 observedKstDate(), 질의 경계는 kstDayStartUtc().
 *   그러면 DB 가 라벨을 어느 시간대로 자르든 결과가 달라지지 않는다.
 *
 * KST 는 UTC+9 고정이고 서머타임이 없어서 9시간을 더해 자르면 정확하다.
 */
function kstToday(now = new Date()) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  const src = Number.isFinite(t) ? t : Date.now();
  return new Date(src + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * KST 달력 하루가 시작하는 절대 시각(ISO, UTC).
 *
 * "KST 로 오늘 이후인가 / 이전인가" 를 DB 에 물을 때 쓰는 경계값이다.
 * recorded_date 라벨은 UTC 로 잘려 있어 경계로 쓸 수 없고(kstToday 주석 참고),
 * recorded_at 은 시간대가 섞일 여지가 없는 절대 시각이라 정확하다.
 *
 *   kstDayStartUtc('2026-08-23') → '2026-08-22T15:00:00.000Z'
 *   (KST 2026-08-23 00:00 == UTC 2026-08-22 15:00)
 *
 * @param {string} kstDate 'YYYY-MM-DD' (KST 달력)
 * @returns {string} ISO 시각. 날짜 형식이 아니면 빈 문자열
 */
function kstDayStartUtc(kstDate) {
  const s = String(kstDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const t = Date.parse(s + 'T00:00:00Z');
  if (!Number.isFinite(t)) return '';
  return new Date(t - 9 * 60 * 60 * 1000).toISOString();
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

  /*
   * 옵션 교체 감지.
   *
   * ★ price_history 의 저장 단위와 혼동하지 말 것.
   *
   *   저장 identity   product_id + mall + vendor_item_id + recorded_date
   *                   → 옵션별로 독립된 이력 계열을 남긴다.
   *   검증 identity   product_id + mall  (vid 는 "바뀌었는가" 를 보는 값)
   *                   → 직전 관측을 vid 없이 찾아야 옵션이 바뀐 것을 알 수 있다.
   *                     (_shop.loadPrevObservations 가 pid|mall 로 키를 잡는 이유)
   *
   *   즉 vid 는 저장에서는 "키" 지만 검증에서는 "비교 대상 속성" 이다.
   *   검증까지 vid 를 키에 넣으면 옵션이 바뀐 순간 직전 값을 못 찾아
   *   비교 자체가 사라지고, 아래 방어가 통째로 무력해진다.
   *
   * 쿠팡은 같은 productId 아래 색상·용량 옵션을 묶어 두고 검색 API 는 그중
   * 한 옵션의 가격을 돌려준다. 어떤 옵션이 올지 우리가 고를 수 없다. 옵션이
   * 바뀐 게 확인되면(vendorItemId 변경) 2배만 벌어져도 같은 상품의 가격
   * 변동이라고 단정할 수 없으므로 더 엄격한 기준을 쓴다.
   */
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
 * "오늘의 가격 하락"에 올리려면 가격 기록이 이만큼 안에 있어야 한다.
 *
 * plausibleDrop 은 하락폭이 그럴듯한지만 본다. 언제 관측된 하락인지는 보지
 * 않는다 — price_drop_top 뷰에 날짜 컬럼이 아예 없기 때문이다.
 *
 * 2026-08-12 운영 DB 실측: 시세판 상위 8행 중 4행의 최신 price_history 가
 * 2026-07-30, 즉 13일 전이었다. 그런데 화면에는 "현재가 19,900원 · ★기록상
 * 최저"로 떴다. 13일 전 값을 오늘 가격이라고 말한 셈이다. 최저가 비교
 * 서비스에서 이건 단순한 낡은 데이터가 아니라 틀린 정보다.
 *
 * 7일인 이유. 수집기는 매일 돌지만 키워드를 3개씩 나눠 도는 탓에 상품
 * 하나가 며칠 걸러 갱신되는 경우가 흔하다. 1~3일로 잡으면 정상적으로
 * 수집되고 있는 상품까지 떨어져 나간다. MAX_DISPLAY_AGE_DAYS(10)보다는
 * 짧게 잡는다 — "오늘의" 하락이라고 이름 붙인 자리이기 때문이다.
 */
const DROP_MAX_AGE_DAYS = 7;

/**
 * 가격 기록 점들 중 "현재 가격 기록"으로 인정할 수 있는 가장 최근 날짜.
 *
 * 미래 날짜는 건너뛴다. 수집기 시각이 어긋나거나 손으로 넣은 행이 내일
 * 날짜로 들어오면, 그게 정렬상 맨 앞에 와서 아무리 묵은 상품도 "방금
 * 확인됨"으로 보이게 된다. 오늘까지만 현재로 친다.
 *
 * @param {Array<{recorded_date:string, recorded_at?:string}>} points
 *        _trust.loadRecentHistory 가 준 배열
 * @param {string} today  'YYYY-MM-DD' (KST 달력)
 * @returns {string} 'YYYY-MM-DD' — 쓸 수 있는 기록이 없으면 빈 문자열
 */
/**
 * 가격 기록 한 점이 KST 달력으로 며칠에 관측된 것인가.
 *
 * ★ recorded_at 을 먼저 본다. recorded_date 를 그대로 믿지 않는다.
 *
 *   recorded_date 는 관측 시각에서 뽑아 둔 라벨일 뿐이고, 그 라벨을 어느
 *   시간대로 잘랐는지는 그 값을 쓴 코드에 달려 있다. 배포본은 오래 UTC 로
 *   잘라 왔다 (new Date().toISOString().slice(0,10)). 수집 크론이 KST
 *   01·03·06시(= UTC 16·18·21시)에 도는 탓에, KST 달력으로 오늘 받아온
 *   가격이 전부 '어제' 라벨을 달고 저장된다.
 *
 *   2026-08-22 운영 DB 실측: price_history 14,579행 중 6,258행(42.9%)에서
 *   recorded_date 가 recorded_at 의 KST 달력일보다 하루 이르다. 그날 수집분
 *   498행은 recorded_at 이 KST 08-22 01:35~03:33 인데 recorded_date 는 전부
 *   2026-08-21 이었고, recorded_date = KST 오늘 인 행은 0건이었다. 라벨만
 *   보면 "오늘 수집된 상품이 하나도 없다"가 되어 시세판이 통째로 빈다.
 *
 *   recorded_at 은 시간대가 섞일 여지가 없는 절대 시각이라, 여기서 KST 로
 *   환산하면 어느 쪽 코드가 라벨을 썼든 같은 답이 나온다. 운영 14,579행
 *   전부에 recorded_at 이 있다 (결측 0건).
 *
 *   recorded_at 이 없는 점(단위 테스트의 고정값 등)은 recorded_date 로
 *   폴백한다 — 기존 동작 그대로다.
 *
 * @param {{recorded_date?:string, recorded_at?:string}} pt
 * @returns {string} 'YYYY-MM-DD' — 판정할 수 없으면 빈 문자열
 */
function observedKstDate(pt) {
  const at = pt && pt.recorded_at;
  if (at) {
    const t = Date.parse(at);
    if (Number.isFinite(t)) return kstToday(t);
  }
  return String((pt && pt.recorded_date) || '').slice(0, 10);
}

function latestObservedDate(points, today) {
  let latest = '';
  (points || []).forEach(pt => {
    const d = observedKstDate(pt);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    if (today && d > today) return;          // 미래 날짜는 현재 기록이 아니다
    if (d > latest) latest = d;
  });
  return latest;
}

/**
 * 이 시세판 행이 "오늘(KST) 실제로 내려간 가격" 인가 — price_history 원장으로
 * 다시 확인한다.
 *
 * ── 왜 뷰만으로는 부족한가 ──────────────────────────────────────
 *
 * price_drop_top 은 (product_id, mall, vendor_item_id) 안에서 최신 두 기록을
 * 비교할 뿐 날짜를 보지 않는다. 그래서 두 가지가 새어 나온다.
 *
 *  ① prev_price 가 "어제" 가 아닐 수 있다. 같은 옵션의 직전 관측이 며칠 전
 *     이면 그 값이 prev_price 로 온다. 그 사이 같은 상품이 다른 옵션으로
 *     이미 그 가격에 팔리고 있었어도 뷰는 모른다.
 *  ② current_price 가 오늘 값이 아닐 수 있다. 오늘은 다른 옵션만 수집됐고
 *     이 옵션은 며칠째 안 잡혔다면, 그 옵션의 마지막 값이 current_price 로
 *     온다. 상품 단위로는 "오늘 수집됨" 이라 최신성 검사를 통과해 버린다.
 *
 * 2026-08-22 운영 DB 실측 (①의 사례):
 *   pid=8085515094 "날개없는 선풍기" — 뷰는 64,800 → 59,800 (-7.7%) 라고
 *   했지만 원장의 직전 관측(2026-08-21)은 이미 59,800 이었다. 옵션 식별자만
 *   95023374766 → 90052570350 으로 바뀌었을 뿐 값은 그대로다. 즉 "오늘
 *   7.7% 하락" 은 사실이 아니었다.
 *
 * ── 무엇을 확인하는가 ──────────────────────────────────────────
 *
 *   ① 화면에 현재가로 찍을 값(current_price)이 오늘 실제로 관측된 값인가
 *   ② 오늘 이전의 가장 최근 관측이 그보다 비쌌는가  (= 오늘 가격 < 직전 가격)
 *   ③ 화면에 이전 기록가로 찍을 값(prev_price)이 바로 그 직전 관측인가
 *
 * 둘 다 이미 받아 둔 points 로 판정한다 — 조회를 새로 만들지 않는다.
 * 판정 근거가 없으면(기록이 없거나 오늘 기록이 없으면) 통과시키지 않는다.
 * "오늘의 가격 하락" 은 근거가 있을 때만 하는 주장이다.
 *
 * @param {object} row     price_drop_top 행
 * @param {Array}  points  _trust.loadRecentHistory 가 준 해당 상품의 기록
 * @param {string} today   'YYYY-MM-DD' (KST)
 */
function todayDropConfirmed(row, points, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today || ''))) return false;
  const cur = Number(row && row.current_price) || 0;
  if (cur <= 0) return false;

  // 같은 날 여러 기록이 있으면 늦게 관측된 쪽이 그날의 값이다.
  let todayPrice = null, todayKey = '';
  let prevPrice = null, prevKey = '';
  (points || []).forEach(pt => {
    const d = observedKstDate(pt);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    if (d > today) return;                    // 미래 기록은 근거가 아니다
    const price = Number(pt && pt.price) || 0;
    if (price <= 0) return;
    const key = d + ' ' + String((pt && pt.recorded_at) || '');
    if (d === today) {
      if (todayPrice === null || key > todayKey) { todayPrice = price; todayKey = key; }
    } else if (prevPrice === null || key > prevKey) {
      prevPrice = price; prevKey = key;
    }
  });

  if (todayPrice === null) return false;      // 오늘 수집분이 없다
  if (todayPrice !== cur) return false;       // 현재가로 찍을 값이 오늘 관측값이 아니다
  if (prevPrice === null) return false;       // 비교할 직전 관측이 없다
  if (prevPrice <= todayPrice) return false;  // 오늘 가격 < 직전 가격

  /*
   * 화면에 '이전 기록가'로 찍을 값(row.prev_price)도 원장의 직전 관측이어야 한다.
   *
   * 뷰의 prev_price 는 '같은 vid 의 직전 관측' 이라 날짜를 보지 않는다. 옵션이
   * 바뀐 상품에서는 그 값이 며칠~몇 주 전 가격일 수 있고, 그러면 카드가 어제
   * 가격이 아닌 값을 '이전 기록가' 라고 말하게 된다. 하락 자체는 사실이지만
   * 숫자가 틀린다 — 그리고 상품을 눌러 보는 가격 이력 차트는 상품 단위라
   * 카드와 차트가 서로 다른 어제를 가리킨다.
   *
   * 2026-08-22 운영 DB 실측 (오늘 확정 21건 중 3건):
   *   9500290355 샤오미 패드  카드 219,800→219,000(-0.4%)
   *                          원장 229,800(8/21)→219,000(-4.7%)
   *                          ← 219,800 은 같은 vid 의 7/31 값, 22일 전이다
   *   7014943794 크리넥스     카드 4,470→4,460(-0.2%)
   *                          원장 5,580(8/21)→4,460(-20.1%)
   *   8717120207 삼성노트북    카드 206,000→201,990(-1.9%)
   *                          원장 205,000(8/21)→201,990(-1.5%)
   *
   * 표시값을 여기서 고쳐 쓰지는 않는다. drop_amount·drop_pct·is_all_time_low
   * 가 전부 같은 뷰 행에서 나오므로 하나만 갈아끼우면 카드 안에서 숫자가
   * 서로 어긋난다. 근거가 맞는 행만 내보내는 쪽이 안전하다.
   */
  return Number(row.prev_price) === prevPrice;
}

/**
 * 이 상품의 가격 기록이 "오늘의 가격 하락"에 올릴 만큼 최근인가.
 *
 * 날짜는 전부 'YYYY-MM-DD' 문자열로만 비교한다. recorded_date 가 DATE
 * 컬럼이라 사전순 비교가 곧 시간순 비교이고, Date 로 바꿔 빼는 것보다
 * 시간대·서머타임 오차가 끼어들 여지가 없다.
 *
 * today 는 호출부가 넘긴다. 저장 쪽(_shop.recordPrices)이 kstToday() 로
 * recorded_date 를 쓰므로, 비교하는 today 도 같은 방식(kstToday())이어야 한다.
 * 예전에는 UTC 로 저장하고 여기서만 KST 로 비교해서, UTC 자정~09시(KST 09~18시)
 * 사이에 기록된 오늘치가 하루 묵은 것으로 계산된 적이 있었다 — 이제는
 * 두 쪽 모두 KST 라 그런 어긋남이 생기지 않는다.
 *
 * @param {Array} points  해당 상품의 가격 기록
 * @param {string} today  'YYYY-MM-DD'
 * @param {number} [maxAgeDays]  기본 DROP_MAX_AGE_DAYS
 */
function recentlyObserved(points, today, maxAgeDays) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today || ''))) return false;
  const latest = latestObservedDate(points, today);
  if (!latest) return false;               // 기록이 아예 없으면 제외한다
  const days = maxAgeDays == null ? DROP_MAX_AGE_DAYS : maxAgeDays;
  const cutoff = new Date(Date.parse(today) - days * 86400000).toISOString().slice(0, 10);
  return latest >= cutoff;
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
  MAX_PLAUSIBLE_DROP_PCT, LIFECYCLE, DROP_MAX_AGE_DAYS,
  parsePrice, isSanePrice, ageDays, kstToday, kstDayStartUtc, classifyPrice, coupangItemIds, isRefreshableMall,
  vendorIdOf, itemIdOf, productLifecycle, isDisplayable, plausibleDrop,
  latestObservedDate, recentlyObserved, observedKstDate, todayDropConfirmed
};
