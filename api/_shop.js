// 쿠팡 HMAC 서명은 api/_coupang.js 한 곳에만 있다.
// 여기(또는 다른 파일)에 서명 함수를 다시 만들면 캐시·분당 상한·차단 감지를
// 통째로 우회하게 된다. 쿠팡 호출은 반드시 searchCoupang()로.
const supabase = require('./_supabase');
const { searchCoupang } = require('./_coupang');
const {
  parsePrice, classifyPrice,
  vendorIdOf, itemIdOf, productLifecycle, LIFECYCLE, MAX_DISPLAY_AGE_DAYS,
  kstToday
} = require('./_price');

const TODAY_PICKS = ['수영복', '물놀이 용품', '아이스크림', '방수팩', '차량용 햇빛 가리개', '여행용 캐리어', '서큘레이터', '쿨토시'];

/** 정가(oprice) 대비 할인율(%). 정가 정보가 없거나 역전이면 0. */
function discountPct(lprice, oprice) {
  if (!(oprice > 0) || !(lprice > 0) || oprice <= lprice) return 0;
  return Math.round((1 - lprice / oprice) * 100);
}

/* ------------------------------------------------------------------ *
 *  검색어–상품 관련도
 *
 *  쿠팡 검색 API가 검색어와 전혀 상관없는 상품을 돌려주는 일이 있다.
 *  실제로 "수영복"으로 받아온 6건이 선스틱·생새우살·복숭아·돈까스·펩시·연어였고,
 *  그게 그대로 products 에 keyword='수영복' 으로 저장돼 홈 "오늘의 셀렉션 · 수영복"에
 *  펩시가 떴다. 저장 단계와 노출 단계 양쪽에서 걸러야 한다.
 * ------------------------------------------------------------------ */

/** 검색어 → 비교에 쓸 토큰. 한 글자는 아무 데나 걸리므로 뺀다. */
function keywordTokens(keyword) {
  return String(keyword || '')
    .toLowerCase().replace(/[^0-9a-z가-힣\s]/g, ' ')
    .split(/\s+/).filter(t => t.length >= 2);
}

/**
 * 상품명이 검색어와 관련 있어 보이는가.
 *
 * 한국어 상품명은 띄어쓰기가 제각각이라("무선 이어폰" vs "무선이어폰")
 * 공백을 지우고 부분 문자열로 본다. 토큰 하나만 걸려도 통과시킨다 —
 * "무선 이어폰" 검색에 "이어폰 케이스"가 나오는 건 정상이기 때문이다.
 */
function matchesKeyword(tokens, title) {
  if (!tokens.length) return true;   // 판단 근거가 없으면 통과
  const flat = String(title || '').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
  return tokens.some(t => flat.indexOf(t) > -1);
}

/**
 * 검색어와 관련 있는 항목만 남긴다.
 *
 * 규칙은 하나다: 하나라도 맞는 게 있으면 맞는 것만 남기고, 하나도 없으면 전부 버린다.
 *
 *   - 일부만 맞는 경우 → 안 맞는 건 버린다. 정확도를 재현율보다 우선한다.
 *     최저가 비교 서비스에서 "수영복"에 연어가 섞이는 쪽이 몇 건 덜 보이는 것보다 나쁘다.
 *   - 하나도 안 맞는 경우 → 응답 자체가 이상한 것이다. 저장하지도, 보여주지도 않는다.
 *
 * @returns {{kept: Array, dropped: number, allMismatch: boolean}}
 */
function relevantItems(keyword, items) {
  const list = items || [];
  const tokens = keywordTokens(keyword);
  if (!tokens.length || !list.length) return { kept: list, dropped: 0, allMismatch: false };

  const kept = list.filter(it => matchesKeyword(tokens, it && it.title));
  if (!kept.length) return { kept: [], dropped: list.length, allMismatch: true };
  return { kept, dropped: list.length - kept.length, allMismatch: false };
}

/*
 * 옵션·수량 꼬리표. 상품명 뒤에 붙는 "12개", "60g", "2세트" 같은 토큰은
 * 검색어로 쓰면 오히려 결과를 망친다.
 */
const UNIT_TOKEN = /^\d+(\.\d+)?(g|kg|ml|l|개|매|입|세트|팩|병|캔|장|가지|종|구|p|ea|cm|mm|인치|호|년|월|일)?$/i;
/** 어느 상품에나 붙는 말. 브랜드·모델명 자리를 차지하면 안 된다. */
const GENERIC_TOKEN = new Set([
  '정품', '무료배송', '당일발송', '무료', '증정', '사은품', '최신형', '신상품', '한정',
  '대용량', '초경량', '프리미엄', '국내산', '국내배송', '공식', '인증', '正品'
]);

/**
 * 상품명 → 이 상품을 다시 찾아올 검색어.
 *
 * 왜 필요한가: products 의 쿠팡 행 654개 중 287개가 keyword 가 비어 있다
 * (옛 CSV 이관분). scripts/collect-all-prices.js 는 keyword 로 검색해서
 * 상품을 다시 찾는 구조라, 이 287개는 수집 대상에서 아예 빠져 있었다.
 * 가격이 영원히 갱신되지 않는다는 뜻이다.
 *
 * 완벽한 검색어를 만들려는 게 아니다. 쿠팡 검색 상위 10개 안에 그 상품이
 * 다시 나오기만 하면 되고, 안 나오면 호출 1회를 쓰고 0건으로 끝난다
 * (productId 로 대조하므로 엉뚱한 상품이 섞일 위험은 없다).
 *
 *   "아이스팩토리 12가지 아이스크림 세트, 12개, 60g" → "아이스팩토리 아이스크림 세트"
 *   "로보락 S10 MaxV Ultra 직배수 로봇청소기, 화이트" → "로보락 S10 MaxV"
 */
function searchPhraseFromTitle(title, maxTokens = 3) {
  const tokens = String(title || '')
    .replace(/\[[^\]]*\]/g, ' ')     // [브랜드인증] 같은 머리표
    .replace(/\([^)]*\)/g, ' ')      // (한정판) 같은 꼬리표
    .split(',')[0]                   // 쿠팡 상품명은 콤마 뒤가 옵션이다
    .replace(/[^0-9a-zA-Z가-힣\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2 && !UNIT_TOKEN.test(t) && !GENERIC_TOKEN.has(t));

  return tokens.slice(0, maxTokens).join(' ').trim();
}

/**
 * 쿠팡 검색.
 *
 * 직접 fetch 하지 않고 _coupang.js를 거친다. 그쪽에 캐시 / 분당 상한 /
 * 차단 감지가 들어 있어서, 여기서 따로 호출하면 전부 우회하게 된다.
 * 실패해도 throw 하지 않고 빈 목록을 준다.
 */
async function fetchCoupang(keyword, limit = 6, opts = {}) {
  const r = await searchCoupang(keyword, { limit, ...opts });
  const items = r.items.map(it => ({
    title: it.title,
    lprice: it.lprice,
    link: it.link,
    image: it.image,
    mall: '쿠팡',
    productId: it.productId,
    isCoupang: true,
    oprice: it.oprice,
    savePct: discountPct(it.lprice, it.oprice),
    // 판매 단위 식별자. 저장 단계에서 옵션 교체를 가격 변동과 구분하는 데 쓴다.
    itemId: it.itemId || '',
    vendorItemId: it.vendorItemId || ''
  }));
  // 검색어와 무관한 상품은 여기서 끊는다. 통과시키면 그대로 products 에 저장되고
  // 홈 섹션에까지 올라간다 (로그에는 성공으로만 남는다).
  const rel = relevantItems(keyword, items);
  if (rel.allMismatch) {
    console.warn(
      `[search:${keyword}] 검색어와 일치하는 상품 0/${items.length}건 — 응답을 버립니다`
      + ` (예: ${String(items[0].title).slice(0, 40)})`
    );
  } else if (rel.dropped) {
    console.log(`[search:${keyword}] 무관한 상품 ${rel.dropped}건 제외 (${rel.kept.length}건 유지)`);
  }

  // 캐시로 상품을 채웠으면 오류로 취급하지 않는다 (사용자에겐 정상 결과다).
  const error = items.length && r.from !== 'api' ? null : r.error;
  return {
    items: rel.kept,
    error,
    from: r.from,
    blocked: !!r.blocked,
    // 상품은 받았는데 전부 검색어와 무관했다 — "결과 없음"과 구분해서 알려야 한다.
    mismatch: rel.allMismatch
  };
}

/**
 * 쿠팡을 조회해 결과를 돌려준다.
 *
 * from / blocked 를 같이 돌려주는 이유: 호출부(=/api/search)가 이 값을 응답 헤더로
 * 내보내야 프론트가 "지금 보는 가격이 방금 받아온 값인지, 캐시인지"를 구분해서
 * 사용자에게 알릴 수 있다. 차단 중에 옛 가격을 아무 말 없이 현재가처럼 보여주면
 * 사용자는 클릭해서야 다른 가격을 보게 된다.
 */
async function searchAll(keyword, { coupangLimit = 6, coupangOpts = {} } = {}) {
  const coupang = await fetchCoupang(keyword, coupangLimit, coupangOpts)
    .catch(e => ({ items: [], error: `쿠팡 예외: ${e.message}`, from: 'none', blocked: false }));

  if (coupang.error) console.error(`[search:${keyword}]`, coupang.error);

  return {
    items: coupang.items,
    errors: coupang.error ? [coupang.error] : [],
    from: coupang.from || 'none',
    blocked: !!coupang.blocked,
    mismatch: !!coupang.mismatch
  };
}

/**
 * 이 응답을 "오늘 관측한 가격"으로 기록해도 되는가.
 *
 *   api         — 방금 받아왔다. 기록한다.
 *   cache       — 6시간 이내에 받아둔 값이다. 하루 한 번 스냅샷에는 충분하다.
 *   stale-cache — 쿠팡을 못 불러서 꺼낸 옛날 값이다. 기록하면 안 된다.
 *   none        — 데이터가 없다.
 *
 * stale-cache 를 기록하면 "오늘 이 가격이었다"는 거짓 기록이 남는다.
 * 차트에는 값이 변하지 않은 평평한 선으로 보이는데, 실제로는 확인조차 못 한
 * 날이다. 그 위에서 역대 최저가·30일 평균·알림 판정이 전부 굴러간다.
 */
function isRecordableSource(from) {
  return from === 'api' || from === 'cache';
}

/* ------------------------------------------------------------------ *
 *  가격 저장
 *
 *  두 테이블은 역할이 다르다. 섞으면 안 된다.
 *
 *    price_history — "그날 쿠팡이 이 값을 줬다"는 관측 기록.
 *                    값이 값의 꼴을 갖췄으면 이상해 보여도 남긴다.
 *                    남겨야 다음 관측에서 확인(corroboration)이 가능하고,
 *                    무슨 일이 있었는지 나중에 볼 수 있다.
 *    products      — 사용자에게 "현재가"로 보여줄 값.
 *                    앞뒤가 맞는 관측만 여기까지 올라온다.
 *
 *  이 구분이 없어서 34,500원짜리 노트북 필름의 현재가가 1,528,000원이 된
 *  적이 있다(product_id=9579684471, 2026-07-30).
 * ------------------------------------------------------------------ */

/** 확인용 직전 관측을 찾을 때 몇 개 행까지 훑을지. pid 100개 × 여유. */
const PREV_LOOKUP_ROWS = 2000;
/** product_id in(...) 한 번에 넣을 개수. URL 길이 때문에 나눠 보낸다. */
const PREV_CHUNK = 100;

/*
 * item_id / vendor_item_id 컬럼 존재 여부.
 *
 * supabase/2026-08-price-accuracy.sql 을 아직 안 돌린 환경에서도 저장이
 * 통째로 실패하면 안 된다. 한 번 없다고 확인되면 그 뒤로는 빼고 보낸다.
 * (check-alerts.js 의 alerts.sent_at 처리와 같은 방식)
 */
let itemIdColumns = true;

function missingColumn(msg) {
  return /column .* does not exist|could not find the .* column|schema cache/i.test(msg || '');
}

/**
 * [{productId, mall}] → 직전 관측 Map<"pid|mall", {price, observedAt}>
 *
 * "직전"에서 오늘 행은 뺀다. /api/search 는 같은 상품을 하루에도 여러 번
 * 저장하는데, 오늘 이미 들어간 행을 직전 값으로 삼으면 자기 자신과 비교하게
 * 되어(ratio≈1) 검증이 무력해진다. 오늘 한 번 잘못 들어간 값이 그 뒤의
 * 모든 저장을 통과시키는 통로가 된다.
 */
async function loadPrevObservations(keys, today) {
  const pids = [...new Set(keys.map(k => k.productId))].filter(Boolean);
  const prev = new Map();

  for (let i = 0; i < pids.length; i += PREV_CHUNK) {
    const chunk = pids.slice(i, i + PREV_CHUNK);
    const { data, error } = await supabase
      .from('price_history')
      .select('product_id, mall, price, recorded_date, recorded_at')
      .in('product_id', chunk)
      .lt('recorded_date', today)
      .order('recorded_date', { ascending: false })
      .limit(PREV_LOOKUP_ROWS);
    if (error) {
      // 직전 값을 못 읽으면 검증 없이 저장한다. 저장 자체를 막는 것보다는 낫다.
      console.warn(`[save] 직전 관측 조회 실패(검증 생략): ${error.message}`);
      return prev;
    }
    (data || []).forEach(r => {
      const k = `${r.product_id}|${r.mall}`;
      const cur = prev.get(k);
      if (!cur || String(r.recorded_date) > String(cur.recordedDate)) {
        prev.set(k, {
          price: r.price,
          recordedDate: r.recorded_date,
          observedAt: r.recorded_at || r.recorded_date
        });
      }
    });
  }
  return prev;
}

/**
 * products 에 이미 있는 행의 옵션 식별자.
 *
 * vendor_item_id 컬럼이 비어 있으면 같은 행의 link 에서 뽑아 쓴다
 * (_price.vendorIdOf 주석 참고). 컬럼은 2026-08-09 에 막 생겨서 기존
 * 654행이 전부 비어 있지만 link 에는 처음부터 값이 있었다. 이 폴백이
 * 없으면 "다음 수집 때부터" 옵션 교체 감지가 켜지는데, 폴백을 두면
 * 지금 당장 전 행에 적용된다. DB 에 쓰지 않는다.
 *
 * 컬럼 자체가 없는 환경(마이그레이션 미적용)에서는 link 만으로 동작한다.
 */
async function loadStoredVendorIds(keys) {
  const out = new Map();
  const pids = [...new Set(keys.map(k => k.productId))].filter(Boolean);
  const cols = itemIdColumns
    ? 'product_id, mall, link, vendor_item_id'
    : 'product_id, mall, link';

  for (let i = 0; i < pids.length; i += PREV_CHUNK) {
    const chunk = pids.slice(i, i + PREV_CHUNK);
    let { data, error } = await supabase.from('products').select(cols).in('product_id', chunk);

    if (error && itemIdColumns && missingColumn(error.message)) {
      itemIdColumns = false;
      console.warn('[save] products.vendor_item_id 컬럼 없음 — link 에서 식별자를 뽑아 계속합니다 '
        + '(supabase/2026-08-price-accuracy.sql 을 실행하면 컬럼에도 저장됩니다).');
      ({ data, error } = await supabase.from('products').select('product_id, mall, link').in('product_id', chunk));
    }
    if (error) {
      console.warn(`[save] 옵션 식별자 조회 실패(옵션 교체 감지 생략): ${error.message}`);
      return out;
    }

    (data || []).forEach(r => out.set(`${r.product_id}|${r.mall}`, vendorIdOf(r)));
  }
  return out;
}

/** item_id/vendor_item_id 를 붙여 upsert 하고, 컬럼이 없으면 빼고 다시 시도한다. */
async function upsertProducts(rows) {
  if (itemIdColumns) {
    const { error } = await supabase.from('products').upsert(rows, { onConflict: 'product_id,mall' });
    if (!error) return null;
    if (!missingColumn(error.message)) return error.message;
    itemIdColumns = false;
    console.warn('[save] products.item_id / vendor_item_id 컬럼 없음 — 해당 값 없이 저장합니다.');
  }
  const slim = rows.map(r => {
    const { item_id, vendor_item_id, ...rest } = r;   // eslint-disable-line no-unused-vars
    return rest;
  });
  const { error } = await supabase.from('products').upsert(slim, { onConflict: 'product_id,mall' });
  return error ? error.message : null;
}

/**
 * 관측한 가격들을 검증해서 저장한다.
 *
 * @param {Array} observations
 *   productId, mall, title, keyword, price(원본 그대로), oprice, savePct,
 *   link, image, itemId, vendorItemId
 * @param {object} opts
 *   label      로그에 붙일 이름 (보통 키워드)
 *   updateCatalog  products 를 갱신할지. false 면 price_history 만 남긴다.
 *
 * @returns {{saved, recorded, rejected, suspect, errors}}
 */
async function recordPrices(observations, opts = {}) {
  const label = opts.label || '';
  const updateCatalog = opts.updateCatalog !== false;
  const errors = [];

  const nowDate = opts.now instanceof Date ? opts.now : new Date();
  const now = nowDate.toISOString();
  /*
   * recorded_date 는 KST 기준으로 남긴다. now (=recorded_at) 는 UTC 인스턴트
   * 그대로 두고, 달력 하루의 경계만 KST 로 잡는다.
   *
   * 왜: KST 01:xx 크론이 UTC 로는 어제 자정 이후라, UTC 를 쓰면 그날 수집분이
   * 통째로 어제 날짜로 저장됐다. price_job_state.job_date 는 KST 였으므로
   * 두 값이 서로 다른 달력을 가리켰다. 이제 저장·조회·job_state 가 모두
   * 같은 KST 기준을 쓴다 (_price.kstToday 주석 참고).
   */
  const today = kstToday(nowDate);

  // 같은 배치 안에서 키가 겹치면 upsert 가 통째로 실패한다. 먼저 접는다.
  const byKey = new Map();
  for (const it of observations || []) {
    if (!it) continue;
    /*
     * product_id 에 상품명을 넣는 폴백은 없앴다.
     *
     * 예전에는 `it.productId || it.title` 이었다. 그러면 상품명이 그대로
     * 기본키가 되어, 이름이 같은 다른 상품이 한 행으로 합쳐지고 가격이
     * 서로를 덮어쓴다. 실제로 price_drop_top 에 product_id 가
     * "미스터빈 크라프트 드립백 봉투" 인 행이 남아 있다.
     * 식별자가 없으면 저장하지 않는 게 맞다.
     */
    if (!it.productId || !it.title || !it.mall) continue;

    /*
     * 배치 안 중복 접기 — vendor_item_id 도 키에 포함한다.
     *
     * price_history 의 UNIQUE 가 (pid, mall, vid, recorded_date) 라서, 같은
     * 상품 페이지의 옵션이 여러 개 오면 옵션별로 독립된 행이 남아야 한다.
     * 여기서 (pid, mall) 로만 접으면 옵션 하나만 살아남아 DB 에 나가고
     * 나머지는 관측 사실이 사라진다.
     *
     * 값이 비면 빈 문자열로 둔다 (DB 컬럼도 NOT NULL DEFAULT '' 이라 동일).
     */
    /*
     * ★ 저장할 때와 똑같은 방법으로 vid 를 구해야 한다.
     *   historyRows 는 vendorIdOf(it) 로 저장하는데(컬럼이 비면 link 에서 뽑는다),
     *   여기서 it.vendorItemId 만 보면 "호출부가 필드를 안 채웠지만 link 에는
     *   서로 다른 vid 가 들어 있는" 두 옵션이 같은 키로 접혀 한 건이 사라진다.
     *   접기 키와 저장 키는 반드시 같은 함수로 구해야 한다.
     */
    const vid = vendorIdOf(it);
    const key = `${it.productId}|${it.mall}|${vid}`;
    const seen = byKey.get(key);
    /*
     * 겹치면 싼 쪽을 남긴다. "마지막에 온 것이 이긴다"가 아니다.
     *
     * 같은 vid 안에서 같은 상품이 두 번 들어오는 경우다. 순서에 기대지 않는다 —
     * 예전에 이 규칙이 없어서 39,900원짜리 커튼이 75,000원으로 저장된 적이 있다.
     */
    if (seen) {
      const a = parsePrice(seen.price);
      const b = parsePrice(it.price);
      if (!(b && (!a || b < a))) continue;
    }
    byKey.set(key, it);
  }
  const uniq = [...byKey.values()];
  if (!uniq.length) return { saved: 0, recorded: 0, rejected: 0, suspect: 0, errors };

  const keys = uniq.map(it => ({ productId: it.productId, mall: it.mall }));
  const [prevMap, vendorMap] = await Promise.all([
    loadPrevObservations(keys, today),
    updateCatalog ? loadStoredVendorIds(keys) : Promise.resolve(new Map())
  ]);

  const historyRows = [];
  const catalogRows = [];
  let rejected = 0;
  let suspect = 0;

  for (const it of uniq) {
    const k = `${it.productId}|${it.mall}`;
    const prevObs = prevMap.get(k);
    const prev = prevObs
      ? { price: prevObs.price, observedAt: prevObs.observedAt, vendorItemId: vendorMap.get(k) || '' }
      : null;

    const verdict = classifyPrice(it.price, prev, { vendorItemId: it.vendorItemId || '' });

    if (verdict.status === 'invalid') {
      rejected++;
      console.warn(`[save${label ? ':' + label : ''}] 저장 거부 — ${verdict.reason}`
        + ` (${it.mall} ${it.productId} ${String(it.title).slice(0, 30)})`);
      continue;
    }

    // 관측 사실은 남긴다. 이 값이 남아 있어야 다음 관측에서 확인이 된다.
    // vendor_item_id / item_id 는 catalogRows 와 같은 방식으로 link 폴백까지
    // 거쳐 채운다. 없으면 옵션별 이력 체인이 시작되지 않아 price_drop_top 뷰가
    // "vid 별 파티션" 을 만들지 못한다.
    historyRows.push({
      product_id: it.productId,
      mall: it.mall,
      title: it.title,
      price: verdict.price,
      link: it.link || '',
      recorded_at: now,
      recorded_date: today,
      item_id: itemIdOf(it),
      vendor_item_id: vendorIdOf(it)
    });

    if (verdict.status === 'suspect') {
      suspect++;
      console.warn(`[save${label ? ':' + label : ''}] 현재가 보류 — ${verdict.reason}`
        + ` (${it.mall} ${it.productId} ${String(it.title).slice(0, 30)})`
        + ' — price_history 에는 기록했고, 다음 수집에서 같은 값이 다시 나오면 현재가로 반영됩니다.');
      continue;
    }

    if (!updateCatalog) continue;

    // 정가와 할인율은 넘어온 값을 그대로 믿지 않고 확정된 판매가에서 다시 만든다.
    // (호출부마다 계산 시점이 달라 lprice 와 어긋난 savePct 가 저장될 수 있다)
    const rawOprice = parsePrice(it.oprice) || 0;
    const oprice = rawOprice > verdict.price ? rawOprice : verdict.price;
    catalogRows.push({
      product_id: it.productId,
      mall: it.mall,
      keyword: it.keyword || '',
      title: it.title,
      lprice: verdict.price,
      link: it.link || '',
      image: it.image || '',
      oprice,
      save_pct: discountPct(verdict.price, oprice),
      /*
       * 이 값을 언제 확인했는지.
       *
       * 예전 upsert 는 collected_at 을 보내지 않았다. on conflict do update 는
       * 보낸 컬럼만 건드리므로, 이미 있는 행은 처음 등록된 날짜를 영원히
       * 유지했다. 프론트가 카드에 찍는 "M/D 수집 기준"이 실제 확인 시점이
       * 아니라 최초 등록일이었다는 뜻이다.
       */
      collected_at: now,
      // 호출부가 안 넘겼으면 link 에서 뽑는다. 쿠팡 제휴 링크에는 항상 들어 있다.
      item_id: itemIdOf(it),
      vendor_item_id: vendorIdOf(it)
    });
  }

  if (historyRows.length) {
    /*
     * onConflict 는 실제 활성 UNIQUE 와 반드시 일치해야 한다.
     * 매칭되는 UNIQUE 가 없으면 Postgres 가 42P10 으로 거부하고, 그러면
     * search / cron / GH Actions 수집기의 모든 가격 쓰기가 통째로 실패한다.
     * (2026-08-14 에 정확히 이 상황이 났었다 — 그 사고 이후에
     *  price_history_pid_mall_vid_date_key (pid, mall, vid, recorded_date)
     *  를 도입해 지금 활성 상태이므로 그 키를 대상으로 삼는다)
     */
    const { error } = await supabase.from('price_history').upsert(
      historyRows, { onConflict: 'product_id,mall,vendor_item_id,recorded_date' }
    );
    if (error) errors.push(`price_history: ${error.message}`);
  }

  /*
   * products 는 (pid, mall) 로 한 행이다 (supabase/2026-08-products-unique-restore.sql).
   * 배치 단계에서는 vid 별로 관측을 나눠 두었으므로 catalogRows 에 같은
   * (pid, mall) 이 여러 번 있을 수 있다. 이 상태로 upsert 를 보내면
   * "ON CONFLICT DO UPDATE command cannot affect row a second time" 로 배치가
   * 통째로 실패한다. 여기서 최저가만 남기고 접는다 (앞서 price_history 처럼
   * 순서에 의존하지 않는 접기).
   */
  const catalogByPidMall = new Map();
  for (const row of catalogRows) {
    const k = `${row.product_id}|${row.mall}`;
    const cur = catalogByPidMall.get(k);
    if (!cur || row.lprice < cur.lprice) catalogByPidMall.set(k, row);
  }
  const catalogUpsertRows = [...catalogByPidMall.values()];

  if (catalogUpsertRows.length) {
    const msg = await upsertProducts(catalogUpsertRows);
    if (msg) errors.push(`products: ${msg}`);
  }

  if (errors.length) console.error(`[save${label ? ':' + label : ''}]`, errors.join(' | '));

  return {
    saved: errors.length ? 0 : catalogUpsertRows.length,
    recorded: errors.length ? 0 : historyRows.length,
    rejected,
    suspect,
    errors
  };
}

/**
 * products / price_history 두 테이블에 저장한다.
 * 서버리스에서는 응답 후 함수가 동결되므로 반드시 await로 호출할 것.
 *
 * @param {object} opts
 *   from — 이 상품들이 어디서 왔는지. stale-cache/none 이면 저장하지 않는다.
 *          (예전에는 출처를 몰라서, 쿠팡이 차단된 동안 옛 캐시 값이 매일
 *           "오늘 가격"으로 쌓이고 있었다)
 */
async function saveProducts(keyword, items, opts = {}) {
  const from = opts.from || 'api';   // 출처를 안 넘기는 옛 호출부는 기존대로 동작
  if (!isRecordableSource(from)) {
    console.warn(`[save:${keyword}] 출처가 '${from}' 이라 저장하지 않습니다 (오늘 관측한 가격이 아님)`);
    return { saved: 0, errors: [], skipped: true };
  }

  if (!items || !items.length) return { saved: 0, errors: [] };

  const r = await recordPrices((items || []).map(it => ({
    productId: it.productId,
    mall: it.mall,
    keyword,
    title: it.title,
    price: it.lprice,
    oprice: it.oprice,
    savePct: it.savePct,
    link: it.link,
    image: it.image,
    itemId: it.itemId,
    vendorItemId: it.vendorItemId
  })), { label: keyword, now: opts.now });

  return { saved: r.saved, errors: r.errors, rejected: r.rejected, suspect: r.suspect };
}

/**
 * products 테이블 행 → 프론트가 쓰는 상품 모양.
 * rec.js / init.js가 각자 똑같이 풀어 쓰던 것을 한 곳으로 모은 것이라
 * 컬럼이 늘어나도 한 군데만 고치면 된다.
 */
function toClientProduct(p) {
  return {
    title: p.title,
    lprice: p.lprice,
    link: p.link,
    image: p.image,
    mall: p.mall,
    productId: p.product_id,
    isCoupang: p.mall === '쿠팡',
    oprice: p.oprice || 0,
    savePct: p.save_pct || 0,
    // 이 가격을 언제 받아온 값인지. DB에서 읽는 섹션(오늘의 셀렉션·이달의 추천·
    // 취향 추천)은 실시간 검색이 아니라 마지막 수집분을 보여주는 것이라,
    // 오래된 값이면 프론트가 "N월 N일 기준"이라고 밝힐 수 있어야 한다.
    collectedAt: p.collected_at || ''
  };
}

/**
 * 현재가로 내보내도 되는 행만 남긴다 (= 라이프사이클이 live 인 행).
 *
 * 판정은 _price.productLifecycle 한 곳에 있다. 노출·수집·운영지표가 전부
 * 같은 정의를 써야 "화면에는 있는데 지표에는 없는" 상태가 안 생긴다.
 *
 * 걸러낸 뒤 남는 게 없으면 호출부가 섹션을 비우거나 다른 키워드로 넘어간다.
 * 틀린 가격을 채워 넣는 것보다 비는 편이 낫다.
 */
function freshRows(rows, opts = {}) {
  const out = [];
  const dropped = {};

  (rows || []).forEach(r => {
    if (!r) return;
    const { state } = productLifecycle(r, opts);
    if (state === LIFECYCLE.LIVE) { out.push(r); return; }
    dropped[state] = (dropped[state] || 0) + 1;
  });

  const total = Object.values(dropped).reduce((a, b) => a + b, 0);
  if (total) {
    console.log(`[display] 현재가로 쓸 수 없는 ${total}행 제외 — `
      + Object.entries(dropped).map(([k, v]) => `${k} ${v}`).join(', '));
  }
  return out;
}

/**
 * 홈 섹션에 올릴 순서.
 *
 * 1) 쿠팡 행을 먼저 — 네이버 연동을 걷어낸 뒤로 다른 몰 행은 새로 수집되지 않아서
 *    가격이 며칠씩 묵어 있다. 그대로 '최저가 구매'를 걸면 사용자가 눌러서 보는
 *    가격과 다르고, 파트너스 수수료도 발생하지 않는다.
 * 2) 같은 몰끼리는 최근 수집분 먼저.
 *
 * 행을 버리지는 않는다. 쿠팡 행이 모자라면 나머지가 그대로 뒤를 채운다.
 */
/**
 * products 행 중 자기 keyword 와 관련 있는 것만 남긴다.
 *
 * 저장 단계 필터는 앞으로 들어올 데이터에만 듣는다. 이미 저장된 오염분
 * (예: keyword='수영복' 인데 제목이 "펩시 제로슈거")은 노출 단계에서 걸러야
 * 홈 화면이 지금 당장 정상으로 보인다. 행을 지우지는 않는다.
 */
function relevantRows(rows) {
  const out = [];
  let dropped = 0;
  (rows || []).forEach(r => {
    if (!r) return;
    if (matchesKeyword(keywordTokens(r.keyword), r.title)) out.push(r);
    else dropped++;
  });
  if (dropped) console.log(`[rec] keyword 와 무관한 저장분 ${dropped}행 노출 제외`);
  return out;
}

function preferLive(rows) {
  return (rows || []).slice().sort((a, b) => {
    const ac = a.mall === '쿠팡' ? 0 : 1;
    const bc = b.mall === '쿠팡' ? 0 : 1;
    if (ac !== bc) return ac - bc;
    return String(b.collected_at || '').localeCompare(String(a.collected_at || ''));
  });
}

/**
 * 키워드별로 번갈아 뽑아 한 키워드가 결과를 독차지하지 않게 한다.
 * (오늘의 셀렉션 / 이달의 추천 / 취향 추천이 모두 같은 규칙을 쓴다)
 */
function roundRobin(rows, keywords, take) {
  const buckets = new Map(keywords.map(k => [k, []]));
  (rows || []).forEach(p => {
    const b = buckets.get(p.keyword);
    if (b) b.push(p);
  });

  const picked = [];
  for (let i = 0; picked.length < take; i++) {
    let added = false;
    for (const k of keywords) {
      const b = buckets.get(k);
      if (b && b[i]) { picked.push(b[i]); added = true; }
      if (picked.length >= take) break;
    }
    if (!added) break;
  }
  return picked;
}

module.exports = {
  TODAY_PICKS, fetchCoupang,
  searchAll, saveProducts, recordPrices, toClientProduct, roundRobin, preferLive,
  relevantItems, relevantRows, freshRows, matchesKeyword, keywordTokens, isRecordableSource,
  discountPct, searchPhraseFromTitle, MAX_DISPLAY_AGE_DAYS
};
