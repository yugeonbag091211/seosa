const supabase = require('./_supabase');
const { TODAY_PICKS, toClientProduct, roundRobin } = require('./_shop');

const PAGE_SIZE = 8;

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
  res.setHeader('Access-Control-Allow-Origin', '*');
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
        .limit(200);
      if (error) throw new Error(error.message);

      return res.json({
        keyword: cats.join(' · '),
        products: roundRobin(data, keywords, PAGE_SIZE).map(toClientProduct)
      });
    }

    // 그 외(오늘의 셀렉션 / 이 키워드 더보기)는 기존대로 단일 키워드 조회
    const keyword = q.keyword || TODAY_PICKS[Math.floor(Math.random() * TODAY_PICKS.length)];
    const offset = Math.max(0, parseInt(q.offset || '0', 10) || 0);

    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('keyword', keyword)
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);

    res.json({
      keyword,
      products: (data || []).map(toClientProduct)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
