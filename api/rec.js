const supabase = require('./_supabase');
const { TODAY_PICKS } = require('./_shop');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const q = req.query || {};

  try {
    // getProfileRecommendations는 관심 카테고리 배열을 cats로 넘긴다.
    let pool = TODAY_PICKS;
    if (q.cats) {
      try {
        const cats = JSON.parse(q.cats);
        if (Array.isArray(cats) && cats.length) pool = cats.filter(c => typeof c === 'string' && c);
      } catch (e) { /* 파싱 실패 시 기본 목록 사용 */ }
    }

    const keyword = q.keyword || pool[Math.floor(Math.random() * pool.length)];

    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('keyword', keyword)
      .limit(8);
    if (error) throw new Error(error.message);

    res.json({
      keyword,
      products: (data || []).map(p => ({
        title: p.title,
        lprice: p.lprice,
        link: p.link,
        image: p.image,
        mall: p.mall,
        productId: p.product_id,
        isCoupang: p.mall === '쿠팡'
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
