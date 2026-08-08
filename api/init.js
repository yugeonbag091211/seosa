const supabase = require('./_supabase');
const { TODAY_PICKS, toClientProduct, roundRobin, preferLive, relevantRows } = require('./_shop');
const { applyCors, cachePublic } = require('./_http');
const { guard } = require('./_ratelimit');

const SECTION_SIZE = 8;

/*
 * 하루 사이에 이만큼 넘게 내려갔으면 실제 인하가 아니라 매칭 오류로 본다.
 *
 * 쿠팡 검색 API는 같은 productId 에 대해 옵션·묶음 중 최저가를 돌려줄 때가 있다.
 * 그 값이 그대로 기록되면 733,950원짜리 로봇청소기가 18,500원으로 "97.5% 하락"한
 * 것처럼 남는다. 이걸 홈 최상단 시세판 1위로 올리면 사용자는 눌러서 전혀 다른
 * 가격을 보게 되고, 사이트를 한 번 더 쓸 이유가 사라진다.
 *
 * 행을 지우지는 않는다. 원본은 price_history 에 그대로 두고 노출만 막는다.
 */
const MAX_PLAUSIBLE_DROP_PCT = 80;

/** 시세판 후보를 넉넉히 받아 걸러야 8칸을 채울 수 있다. */
const DROP_FETCH = SECTION_SIZE * 6;

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

/** 값이 앞뒤가 맞는 하락만 남긴다. */
function plausibleDrop(p) {
  const cur = Number(p.current_price) || 0;
  const prev = Number(p.prev_price) || 0;
  const pct = Number(p.drop_pct) || 0;
  if (cur <= 0 || prev <= 0) return false;
  if (cur >= prev) return false;                       // 하락이 아닌 행
  return pct > 0 && pct < MAX_PLAUSIBLE_DROP_PCT;
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

      monthly.products = roundRobin(preferLive(relevantRows(monthProducts)), monthKeywords, SECTION_SIZE)
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

      recProducts = preferLive(relevantRows(rows)).slice(0, SECTION_SIZE);
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

    // 방문자마다 같은 쿼리가 네 번 나간다. 개인화된 값이 없으므로 Edge 에 잠깐 세워둔다.
    cachePublic(res, 300);
    res.json({
      popular: stats || [],
      monthly: monthly || null,
      priceDrop: dropRows,
      daily: {
        keyword: recKeyword,
        keywords: TODAY_PICKS,
        products: recProducts.map(toClientProduct)
      }
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
