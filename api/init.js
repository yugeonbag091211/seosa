const supabase = require('./_supabase');
const { TODAY_PICKS, toClientProduct, roundRobin, preferLive, relevantRows, freshRows } = require('./_shop');
/*
 * 가격 하락 판정을 _price.js 로 옮겼다. 옮기기만 한 게 아니라 조건이 늘었다.
 *
 * 추가된 조건 — 재수집 가능한 몰인가 / product_id 가 숫자인가 / link 가 있는가.
 * 2026-08-11 운영 DB price_drop_top 상위 48행 전수 대조:
 *     구 조건 43/48  →  신 조건 29/48   (-14행)
 *     탈락 14행 = 쿠팡 아님 6 + product_id 자리에 상품명 8(전부 link=NULL)
 * SECTION_SIZE(8)의 3.6배가 남으므로 시세판이 비지는 않는다. 빠지는 것은
 * 눌러도 갈 곳이 없거나(link=NULL) 더 이상 갱신되지 않는(네이버) 행이다.
 * 케이스는 scripts/test-price.js 의 '시세판. plausibleDrop' 섹션에 고정해 두었다.
 */
const {
  plausibleDrop, MAX_PLAUSIBLE_DROP_PCT, todayDropConfirmed, kstToday,
  // 시세판 행의 옵션 식별자 — 뷰에 컬럼이 없어 link 에서 뽑는다(공식 helper).
  vendorIdOf, sameVendorRows
} = require('./_price');
const { attachTrust, loadRecentHistory } = require('./_trust');
const { isValidSuggestion } = require('./_search');
const { demandPicks } = require('./_picks');
const { applyCors, cachePublic, fail } = require('./_http');
const { guard } = require('./_ratelimit');
// 달력 월은 KST 기준이다. new Date().getMonth() 는 런타임 TZ(Vercel=UTC)를 따라가서
// KST 매월 1일 00:00~08:59 동안 지난달 큐레이션을 보게 된다 (_kst.kstMonth 주석 참고).
const { kstMonth } = require('./_kst');

const SECTION_SIZE = 8;

/*
 * 시세판 후보를 넉넉히 받아 걸러야 8칸을 채울 수 있다.
 *
 * 6배(48행)로는 모자란다. price_drop_top 은 drop_pct 내림차순인데 상위가
 * 더 이상 수집되지 않는 옛 몰·상품명이 product_id 자리에 들어간 이관분으로
 * 채워져 있어서, 정작 오늘 내려간 상품은 하락률이 한 자릿수라 뒤로 밀린다.
 *
 * 2026-08-22 운영 DB 실측 (뷰 2,202행 / SECTION_SIZE 8칸 기준):
 *    48행 → plausibleDrop 13 → 오늘 확정  5 → 5칸   (3칸이 빈다)
 *    96행 → plausibleDrop 29 → 오늘 확정 15 → 8칸
 *   200행 → plausibleDrop 33 → 오늘 확정 18 → 8칸   ← 채택
 *   400행 → plausibleDrop 33 → 오늘 확정 18 → 8칸   (200 이상은 더 늘지 않는다)
 *
 * 비용은 뷰 조회 한 번의 행 수뿐이다. 뒤이어 도는 이력 조회(loadRecentHistory)
 * 는 plausibleDrop 을 통과한 행(실측 33건)만 대상으로 하므로 늘지 않는다.
 */
const DROP_FETCH = 200;

/** 키워드 하나당 훑을 상품 수. 아래 셀렉션 루프의 limit(100)과 같은 기준. */
const KEYWORD_PROBE_ROWS = 100;

/**
 * 칩으로 내보낼 키워드 — 지금 보여줄 수 있는 상품이 실제로 있는 것만.
 *
 * 왜 필요한가.
 *   freshRows 를 켜면 "저장된 상품은 있는데 전부 10일 넘게 확인 안 된" 키워드가
 *   생긴다. 2026-08-11 운영 DB 기준 TODAY_PICKS 8종 중 '수영복' 이 그렇다
 *   (44행 → 관련도 통과 7행 → 전부 dead-mall, 최신 관측 2026-07-27 = 15일 전).
 *
 *   아래 셀렉션 루프는 이미 그런 키워드를 건너뛰고 다른 것으로 대체한다.
 *   그런데 칩 목록은 TODAY_PICKS 를 그대로 내보내고 있었다. 그래서 사용자가
 *   '#수영복' 칩을 누르면 /api/rec 이 0건을 주고, 프론트의 Rec.loadKeyword 에는
 *   빈 결과 분기가 없어서 추천 자리에 "검색 결과가 없습니다"가 뜬다.
 *   (Rec.more 에는 재시도가 있지만 칩 클릭 경로에는 없다)
 *
 *   판단 기준을 하나로 맞추는 것뿐이다 — 셀렉션 루프가 쓸 수 없다고 본 키워드는
 *   칩에도 올리지 않는다. 추천 로직 자체는 건드리지 않는다.
 *
 * 판단 근거를 못 얻으면(조회 실패·전멸) 기존대로 전부 내보낸다. 근거 없이
 * 내비게이션을 지우지는 않는다.
 */
async function chipKeywords(keywords, activeKeyword) {
  if (!keywords.length) return keywords;

  // 상품 카드를 그리는 게 아니라 "살아 있는 키워드"만 세면 되므로 필요한 컬럼만 받는다.
  // (relevantRows 는 keyword/title, productLifecycle 은 product_id/mall/lprice/collected_at)
  const { data, error } = await supabase
    .from('products')
    .select('product_id, mall, keyword, title, lprice, collected_at')
    .in('keyword', keywords)
    .limit(keywords.length * KEYWORD_PROBE_ROWS);

  if (error) {
    console.warn(`[init] 칩 키워드 신선도 조회 실패(전체 노출): ${error.message}`);
    return keywords;
  }

  const alive = new Set(freshRows(relevantRows(data)).map(r => r.keyword));
  // 지금 화면에 그려지는 키워드는 항상 칩에 있어야 한다 (활성 칩이 목록에 없으면 안 된다).
  if (activeKeyword) alive.add(activeKeyword);

  const kept = keywords.filter(k => alive.has(k));
  if (!kept.length) {
    console.warn('[init] 노출 가능한 키워드가 하나도 없어 칩 목록을 그대로 내보냅니다.');
    return keywords;
  }
  if (kept.length < keywords.length) {
    console.log(`[init] 칩 키워드 ${keywords.length}→${kept.length}종 `
      + `(제외: ${keywords.filter(k => !alive.has(k)).join(', ')})`);
  }
  return kept;
}

/**
 * 인기 검색어 → 홈 칩으로 내보낼 것만.
 *
 * 홈 칩은 광고로 처음 들어온 사람이 가장 먼저 누르는 버튼이다. 그런데 목록을
 * search_stats 상위 10개에서 그대로 뽑고 있어서, 사람이 오타로 친 말도
 * 횟수만 쌓이면 그대로 홈 화면에 올라간다.
 *
 * 2026-08-12 운영 기준 5번째 칩이 "텀블르"(4회)였다. 바로 뒤 8위에 제대로 된
 * "텀블러"(3회)가 있는데도 오타 쪽이 노출됐고, 누르면 /api/search 가 0건을
 * 준다 — 첫 클릭이 빈 화면이다. (보정 사전에도 "텀블러" 가 없어서 "혹시
 * 이거였나요" 제안조차 뜨지 않았다)
 *
 * 판단 기준은 하나다: 그 말로 검색했을 때 실제로 상품이 저장된 적이 있는가.
 * 검색이 결과를 낸 키워드는 saveProducts 가 products 에 남긴다. 한 행도 없는
 * 키워드는 "사람이 쳤지만 아무것도 안 나온 말"이고, 홈 칩에 올릴 이유가 없다.
 *
 * freshRows(수집 신선도)는 쓰지 않는다. 칩을 누르면 /api/rec 이 아니라 쿠팡
 * 실시간 검색이 돌기 때문에, 최근에 수집되지 않았다는 사실은 결과가 안 나온다는
 * 뜻이 아니다. 아래 chipKeywords(오늘의 셀렉션)와 기준이 다른 이유다.
 *
 * 판단 근거를 못 얻으면 원래대로 전부 내보낸다. 근거 없이 지우지 않는다.
 */
async function popularChips(stats) {
  /*
   * 형태부터 거른다 — 아래 "실적" 검사보다 먼저.
   *
   * 이 목록은 홈 칩으로만 쓰이는 게 아니다. 프론트는 검색 결과가 0건이고
   * 서버 제안(X-Seosa-Suggest)도 비었을 때 이 목록을 그대로
   * "이런 검색어는 어떠세요" 자리에 그린다 (public/index.html Search.emptyHtml).
   * 그래서 소음이 여기 남아 있으면 그 자리로 새어 나간다.
   *
   * 아래 실적 검사(products 에 저장된 적이 있는가)만으로도 대부분 걸리지만,
   * 그 검사는 조회 실패·전멸 시 rows 를 그대로 돌려주는 폴백이 두 군데 있다.
   * 형태 검사를 앞에 두면 어느 경로로 나가든 소음은 빠진다.
   *
   * 판정은 _search.isValidSuggestion 한 곳에 있다 — 프론트에 같은 규칙을
   * 복제하지 않는다 (규칙이 갈라지면 한쪽만 고쳐지고 다른 쪽이 남는다).
   */
  const rows = (stats || []).filter(s => s && s.keyword && isValidSuggestion(s.keyword));
  const keywords = [...new Set(rows.map(s => s.keyword))];
  if (!keywords.length) return rows;

  const { data, error } = await supabase
    .from('products')
    .select('keyword, title')
    .in('keyword', keywords)
    .limit(keywords.length * KEYWORD_PROBE_ROWS);

  if (error) {
    console.warn(`[init] 인기 검색어 실적 조회 실패(전체 노출): ${error.message}`);
    return rows;
  }

  const proven = new Set(relevantRows(data).map(r => r.keyword));
  const kept = rows.filter(s => proven.has(s.keyword));
  if (!kept.length) {
    console.warn('[init] 실적이 있는 인기 검색어가 없어 목록을 그대로 내보냅니다.');
    return rows;
  }
  if (kept.length < rows.length) {
    console.log(`[init] 인기 검색어 ${rows.length}→${kept.length}종 `
      + `(제외: ${rows.filter(s => !proven.has(s.keyword)).map(s => s.keyword).join(', ')})`);
  }
  return kept;
}

function toDropRow(p) {
  return {
    title: p.title,
    mall: p.mall,
    // 화면 표시용 몰 이름(ADPICK은 cp_name 기반, 예: '알리'). price_drop_top 뷰가
    // products.mall_label을 그대로 실어 준다(supabase/2026-08-mall-label.sql).
    mallLabel: p.mall_label || '',
    productId: p.product_id,
    /*
     * 옵션 식별자 — 카드를 눌렀을 때 열리는 모달이 이 옵션의 이력만 그리게 한다.
     *
     * 예전에는 이 필드가 없어서 프론트 histKey 가 `pid|mall` 로 떨어졌고,
     * /api/history 가 옵션을 좁히지 못해 시세판 모달만 옵션 혼합 곡선을
     * 그렸다. 같은 상품을 검색 카드에서 열면 옵션 곡선이 나왔다 — 한 상품이
     * 어디서 열렸느냐에 따라 다른 숫자를 말했다.
     *
     * 뷰에는 vendor_item_id 컬럼이 없다. 값은 link 에서 뽑는다 — link 는
     * products 에서 온 것이라 "이 카드를 누르면 실제로 가게 되는 옵션" 을
     * 가리키고, 모달이 보여줘야 할 것도 바로 그 옵션이다.
     */
    vendorItemId: vendorIdOf(p),
    link: p.link || '',
    image: p.image || '',
    lprice: p.current_price,
    oprice: p.prev_price,
    dropAmount: p.drop_amount,
    savePct: p.drop_pct,
    isAllTimeLow: p.is_all_time_low,
    isCoupang: p.mall === '쿠팡'
  };
}

module.exports = async function handler(req, res) {
  if (!applyCors(req, res, 'public')) return;

  if (!guard(req, res, { name: 'init', limit: 60, windowMs: 60 * 1000 })) return;

  try {
    const { data: stats } = await supabase
      .from('search_stats')
      .select('keyword, count')
      .order('count', { ascending: false })
      .limit(10);

    const month = kstMonth();
    const { data: monthly } = await supabase
      .from('monthly_curation')
      .select('*')
      .eq('month', month)
      .maybeSingle();

    // 정렬을 뷰에 맡기지 않는다. order 없이 limit 을 걸면 어떤 8행이 올지
    // 보장되지 않아서 "오늘의 가격 하락 TOP"이 TOP 이 아니게 된다.
    const { data: priceDrop } = await supabase
      .from('price_drop_top')
      .select('*')
      .order('drop_pct', { ascending: false })
      .limit(DROP_FETCH);

    // 프론트의 Monthly.show는 monthly.products를 그리는데 monthly_curation 행에는
    // 그 컬럼이 없다. 이달의 키워드로 products를 조회해 붙여준다.
    const monthKeywords = (monthly && Array.isArray(monthly.keywords)) ? monthly.keywords.filter(Boolean) : [];
    if (monthKeywords.length) {
      const { data: monthProducts } = await supabase
        .from('products')
        .select('*')
        .in('keyword', monthKeywords)
        .limit(200);

      monthly.products = roundRobin(preferLive(freshRows(relevantRows(monthProducts))), monthKeywords, SECTION_SIZE)
        .map(toClientProduct);
    } else if (monthly) {
      monthly.products = [];
    }

    /*
     * 오늘의 셀렉션.
     *
     * 무정렬 limit(8)이면 같은 키워드에서도 매번 다른 8개가 오고, 그중 상당수가
     * 더 이상 갱신되지 않는 옛 몰 행이었다. 쿠팡·최신순으로 정렬한 뒤 자른다.
     *
     * 그리고 keyword 와 무관한 저장분을 걸러내면 남는 게 0건인 키워드가 생긴다
     * (예: '수영복' 은 저장된 쿠팡 상품이 전부 식료품이라 통째로 빠진다).
     * 그때 빈 섹션을 내보내지 않도록 다른 키워드로 몇 번 더 시도한다.
     */
    /*
     * ★ 셀렉션 키워드는 수요(검증된 인기 검색어)가 먼저다 (2026-09-02).
     *   TODAY_PICKS 는 7월 큐레이션과 같은 하드코딩이라 9월에도 수영복·쿨토시를
     *   냈다. 인기 검색어(무선 이어폰·노트북·마우스 …)로 채우고 모자라면
     *   큐레이션으로 보충한다 (api/_picks.js). popularChips 가 형태·실적을
     *   이미 걸렀으므로 여기 오는 키워드는 전부 상품이 있는 말이다.
     */
    const popularRows = await popularChips(stats);
    const picks = demandPicks(popularRows, TODAY_PICKS);

    let recKeyword = picks[Math.floor(Math.random() * picks.length)];
    let recProducts = [];
    const tried = new Set();

    for (let attempt = 0; attempt < picks.length && !recProducts.length; attempt++) {
      tried.add(recKeyword);
      const { data: rows } = await supabase
        .from('products')
        .select('*')
        .eq('keyword', recKeyword)
        .limit(100);

      recProducts = preferLive(freshRows(relevantRows(rows))).slice(0, SECTION_SIZE);
      if (recProducts.length) break;

      const next = picks.find(k => !tried.has(k));
      if (!next) break;
      console.warn(`[init] '${recKeyword}' 는 노출 가능한 상품이 없어 '${next}' 로 대체`);
      recKeyword = next;
    }

    const drops = (priceDrop || []).filter(plausibleDrop);

    /*
     * "오늘의 가격 하락"에는 오늘(KST) 실제로 내려간 상품만 올린다.
     *
     * price_drop_top 뷰는 최신 두 기록을 비교할 뿐 날짜를 보지 않는다.
     * 그래서 8/17에 하락한 상품이 수집이 끊긴 채로 8/21에도 계속 표시됐다.
     * 판정은 _price.todayDropConfirmed 한 곳에 모아 두었다 — 오늘 수집분이
     * 있는지, 화면에 찍을 현재가가 그 오늘 값인지, 직전 관측보다 실제로
     * 내려갔는지를 price_history 원장으로 다시 확인한다 (그 주석 참고).
     *
     * ★ 자르기(slice) 전에 거른다. 뒤에서 거르면 8칸 중 몇 칸이 빈 채로 나간다.
     *
     * 조회에 실패하면 거르지 않고 전부 통과시킨다. 근거를 못 얻었다고 해서
     * 시세판을 통째로 비우는 것은 과한 대응이다 (기존 동작으로 되돌아갈 뿐이다).
     */
    /*
     * ★ 원장 검증을 옵션(vendor_item_id) 계열로 좁힌다 (2026-09-05).
     *
     * ── 왜 필요한가 ────────────────────────────────────────────
     *
     * price_drop_top 은 (product_id, mall, vendor_item_id) 단위로 계산되는데
     * 결과 컬럼에 vendor_item_id 가 없다. 그래서 여기까지 오면 이 행이 어느
     * 옵션의 것인지 알 수 없고, 예전에는 상품 단위(모든 옵션 합산) 이력으로
     * 검증했다. 그러면 다른 옵션의 관측이 "직전 가격" 이 되어 없던 하락을
     * 만들거나, 반대로 진짜 하락을 지워 버린다.
     *
     * ── 무엇을 기준으로 좁히는가 ───────────────────────────────
     *
     * 뷰의 link 는 products 에서 온 것이라 그 상품이 지금 알고 있는 옵션
     * 하나를 가리킨다 (2026-09-05 실측: 뷰 쿠팡 1,923행 전부에서 추출 성공).
     * 그 옵션이 바로 카드를 눌렀을 때 사용자가 실제로 가게 되는 곳이다.
     * 그러므로 "이 카드가 말하는 하락" 은 그 옵션의 하락이어야 한다.
     *
     * 링크의 옵션과 다른 옵션의 행이라면 아래 검증에서 값이 맞지 않아
     * 자연스럽게 탈락한다 — 같은 상품에 뷰 행이 여럿일 때(운영 451건)
     * 어느 행이 이 옵션의 것인지 고르는 일까지 원장이 대신 해 준다.
     *
     * 옵션 판정 자체는 _price.sameVendorRows 한 곳에 있다. 옵션 표시가 없는
     * 옛 기록만 있는 상품은 예전처럼 상품 단위로 본다(회귀 아님).
     */
    let fresh = drops;
    const today = kstToday();
    if (drops.length) {
      try {
        const hist = await loadRecentHistory(drops.map(r => ({
          productId: String(r.product_id),
          mall: r.mall || '',
          // 새 파싱을 만들지 않는다 — 컬럼이 없으면 link 에서 뽑는 공식 helper.
          vendorItemId: vendorIdOf(r)
        })));
        fresh = drops.filter(r => {
          const points = hist.get(`${r.product_id}|${r.mall || ''}`) || [];
          return todayDropConfirmed(r, sameVendorRows(points, vendorIdOf(r)), today);
        });
      } catch (e) {
        console.warn(`[init] 시세판 최신성 확인 실패(기존대로 노출): ${e.message}`);
        fresh = drops;
      }
    }

    /*
     * 여기서 8칸이 안 차도 오래된 행으로 채우지 않는다.
     * 며칠 전 값을 오늘 가격이라고 말하는 것보다 적게 보여주는 편이 낫다.
     */
    /*
     * 상품당 카드 한 장으로 접는다.
     *
     * 뷰는 (product_id, mall, vendor_item_id) 단위라 같은 상품의 옵션이 둘 이상
     * 살아남을 수 있다. 두 옵션이 오늘 같은 값으로 관측되면 원장 검증도 둘 다
     * 통과해서(숫자는 전부 맞다) 같은 상품이 카드 두 장으로 뜬다.
     * 8칸짜리 섹션에서 그건 자리 낭비이고, 사용자에게는 그냥 중복으로 보인다.
     *
     * 남기는 기준은 하락폭이 큰 쪽이다 — 섹션의 정렬 기준과 같다.
     */
    const byProduct = new Map();
    preferLive(fresh).forEach(r => {
      const k = `${r.product_id}|${r.mall}`;
      const cur = byProduct.get(k);
      if (!cur || (Number(r.drop_pct) || 0) > (Number(cur.drop_pct) || 0)) byProduct.set(k, r);
    });
    const deduped = [...byProduct.values()];
    if (deduped.length < fresh.length) {
      console.log(`[init] 시세판 중복 옵션 ${fresh.length - deduped.length}행 접음 (상품당 1장)`);
    }

    // 쿠팡 행을 먼저 채운다 (다른 몰은 더 이상 매일 수집되지 않아 값이 묵어 있다).
    const dropRows = deduped.slice(0, SECTION_SIZE).map(toDropRow);

    const dropped = (priceDrop || []).length - drops.length;
    if (dropped > 0) console.warn(`[init] 시세판 이상치 ${dropped}행 제외 (하락률 ${MAX_PLAUSIBLE_DROP_PCT}% 이상 또는 값 불일치)`);

    const staleDropped = drops.length - fresh.length;
    if (staleDropped > 0) {
      console.warn(`[init] 시세판 ${staleDropped}행 제외`
        + ` (오늘(${today}) 수집분이 아니거나 직전 관측보다 내려가지 않음)`
        + ` — 후보 ${fresh.length}행`);
    }
    if (fresh.length < SECTION_SIZE) {
      console.warn(`[init] 시세판 후보가 ${fresh.length}행뿐이라 ${SECTION_SIZE}칸을 다 채우지 못합니다`
        + ' (오래된 기록으로 채우지 않습니다).');
    }

    // 칩 목록과 셀렉션 루프가 같은 기준(freshRows)을 쓰도록 맞춘다.
    const dailyKeywords = await chipKeywords(picks, recKeyword);

    const dailyProducts = recProducts.map(toClientProduct);

    /*
     * 가격 신뢰도를 세 섹션에 한 번에 붙인다.
     *
     * 섹션별로 따로 부르면 price_history 조회가 세 번 나간다. 한 번에 모으면
     * product_id in (...) 쿼리 한 번으로 끝난다 (한 응답에 최대 24개 상품).
     */
    await attachTrust([
      ...dailyProducts,
      ...((monthly && monthly.products) || []),
      ...dropRows
    ]);

    // 방문자마다 같은 쿼리가 네 번 나간다. 개인화된 값이 없으므로 Edge 에 잠깐 세워둔다.
    cachePublic(res, 300);
    const resp = {
      popular: popularRows,
      monthly: monthly || null,
      priceDrop: dropRows,
      daily: {
        keyword: recKeyword,
        keywords: dailyKeywords,
        products: dailyProducts
      }
    };
    res.json(resp);
  } catch(e) {
    fail(res, e, { where: 'init', route: '/api/init', message: '홈 데이터를 불러오지 못했어요.' });
  }
};
