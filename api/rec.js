const supabase = require('./_supabase');
const { TODAY_PICKS, toClientProduct, roundRobin, preferLive, relevantRows, freshRows } = require('./_shop');
const { applyCors, cachePublic } = require('./_http');
const { guard } = require('./_ratelimit');

const PAGE_SIZE = 8;
// 한 키워드의 상품 풀 상한. 정렬을 JS에서 하기 때문에 한 번에 받아둔다.
// (키워드당 실제 상품 수는 수십 개 수준이라 이 값이면 전부 들어온다)
const MAX_POOL = 200;

// 카테고리는 그 자체로 products.keyword에 없기 때문에
// 취향 기반 추천을 뽑을 때는 카테고리를 실제 상품 키워드 풀로 매핑한다.
const CATEGORY_KEYWORDS = {
  '테크':     ['무선 이어폰', '노트북', '스마트워치', '키보드', '마우스', '스피커'],
  '패션':     ['가방', '가죽 가방', '운동화', '지갑', '선글라스'],
  '홈리빙':   ['조명', '의자', '텀블러', '향초', '디퓨저'],
  '뷰티':     ['향수', '데일리 향수'],
  '아웃도어': ['텀블러', '방수팩', '캠핑', '쿨토시', '서큘레이터'],
  '식품':     ['아이스크림']
};

function mapCatsToKeywords(cats) {
  const out = new Set();
  cats.forEach(c => {
    const kws = CATEGORY_KEYWORDS[c];
    if (kws) kws.forEach(k => out.add(k));
    else if (c) out.add(c); // 알 수 없는 카테고리는 그대로 시도
  });
  return [...out];
}

module.exports = async function handler(req, res) {
  if (!applyCors(req, res, 'public')) return;

  if (!guard(req, res, { name: 'rec', limit: 60, windowMs: 60 * 1000 })) return;

  const q = req.query || {};

  try {
    // getProfileRecommendations는 관심 카테고리 배열을 cats로 넘긴다.
    // 카테고리가 오면 카테고리→키워드 매핑을 거쳐 여러 키워드 상품을 섞는다.
    if (q.cats && !q.keyword) {
      let cats = [];
      try {
        const parsed = JSON.parse(q.cats);
        if (Array.isArray(parsed)) cats = parsed.filter(c => typeof c === 'string' && c);
      } catch (e) { /* 무시 */ }

      const keywords = cats.length ? mapCatsToKeywords(cats) : TODAY_PICKS;

      const { data, error } = await supabase
        .from('products')
        .select('*')
        .in('keyword', keywords)
        .limit(MAX_POOL);
      if (error) throw new Error(error.message);

      // freshRows: 더 이상 수집되지 않는 몰 / 오래 확인 못 한 행은 현재가가 아니다.
      cachePublic(res, 300);
      return res.json({
        keyword: cats.join(' · '),
        products: roundRobin(preferLive(freshRows(relevantRows(data))), keywords, PAGE_SIZE)
          .map(toClientProduct)
      });
    }

    // 그 외(오늘의 셀렉션 / 이 키워드 더보기)는 기존대로 단일 키워드 조회
    const keyword = q.keyword || TODAY_PICKS[Math.floor(Math.random() * TODAY_PICKS.length)];
    const offset = Math.max(0, parseInt(q.offset || '0', 10) || 0);

    /*
     * order 없이 range()로 페이지를 넘기면 안 된다.
     *
     * Postgres는 order by가 없으면 행 순서를 보장하지 않는다. "이 키워드 더보기"를
     * 누를 때마다 1페이지에 있던 상품이 2페이지에 다시 나오거나 아예 건너뛰어졌다.
     * product_id로 고정 순서를 잡아 한 번에 받아온 뒤, 노출 우선순위(쿠팡·최신순)를
     * 적용하고 잘라낸다.
     */
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('keyword', keyword)
      .order('product_id', { ascending: true })
      .limit(MAX_POOL);
    if (error) throw new Error(error.message);

    // keyword 와 무관하게 저장된 행은 노출하지 않는다 (_shop.relevantRows 주석 참고).
    // freshRows 는 "가격이 더 이상 갱신되지 않는 행"을 뺀다 (_shop.freshRows 참고).
    const pool = preferLive(freshRows(relevantRows(data)));

    cachePublic(res, 300);
    res.json({
      keyword,
      products: pool.slice(offset, offset + PAGE_SIZE).map(toClientProduct)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
