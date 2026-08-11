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
const { plausibleDrop, MAX_PLAUSIBLE_DROP_PCT } = require('./_price');
const { applyCors, cachePublic } = require('./_http');
const { guard } = require('./_ratelimit');

const SECTION_SIZE = 8;

/** 시세판 후보를 넉넉히 받아 걸러야 8칸을 채울 수 있다. */
const DROP_FETCH = SECTION_SIZE * 6;

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

function toDropRow(p) {
  return {
    title: p.title,
    mall: p.mall,
    productId: p.product_id,
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

    const month = new Date().getMonth() + 1;
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
    let recKeyword = TODAY_PICKS[Math.floor(Math.random() * TODAY_PICKS.length)];
    let recProducts = [];
    const tried = new Set();

    for (let attempt = 0; attempt < TODAY_PICKS.length && !recProducts.length; attempt++) {
      tried.add(recKeyword);
      const { data: rows } = await supabase
        .from('products')
        .select('*')
        .eq('keyword', recKeyword)
        .limit(100);

      recProducts = preferLive(freshRows(relevantRows(rows))).slice(0, SECTION_SIZE);
      if (recProducts.length) break;

      const next = TODAY_PICKS.find(k => !tried.has(k));
      if (!next) break;
      console.warn(`[init] '${recKeyword}' 는 노출 가능한 상품이 없어 '${next}' 로 대체`);
      recKeyword = next;
    }

    const drops = (priceDrop || []).filter(plausibleDrop);
    // 쿠팡 행을 먼저 채운다 (다른 몰은 더 이상 매일 수집되지 않아 값이 묵어 있다).
    const dropRows = preferLive(drops).slice(0, SECTION_SIZE).map(toDropRow);

    const dropped = (priceDrop || []).length - drops.length;
    if (dropped > 0) console.warn(`[init] 시세판 이상치 ${dropped}행 제외 (하락률 ${MAX_PLAUSIBLE_DROP_PCT}% 이상 또는 값 불일치)`);

    // 칩 목록과 셀렉션 루프가 같은 기준(freshRows)을 쓰도록 맞춘다.
    const dailyKeywords = await chipKeywords(TODAY_PICKS, recKeyword);

    // 방문자마다 같은 쿼리가 네 번 나간다. 개인화된 값이 없으므로 Edge 에 잠깐 세워둔다.
    cachePublic(res, 300);
    res.json({
      popular: stats || [],
      monthly: monthly || null,
      priceDrop: dropRows,
      daily: {
        keyword: recKeyword,
        keywords: dailyKeywords,
        products: recProducts.map(toClientProduct)
      }
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
