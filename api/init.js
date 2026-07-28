const supabase = require('./_supabase');
const { TODAY_PICKS, toClientProduct, roundRobin } = require('./_shop');

const SECTION_SIZE = 8;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
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

    const { data: priceDrop } = await supabase
      .from('price_drop_top')
      .select('*')
      .limit(SECTION_SIZE);

    // 프론트의 Monthly.show는 monthly.products를 그리는데 monthly_curation 행에는
    // 그 컬럼이 없다. 이달의 키워드로 products를 조회해 붙여준다.
    const monthKeywords = (monthly && Array.isArray(monthly.keywords)) ? monthly.keywords.filter(Boolean) : [];
    if (monthKeywords.length) {
      const { data: monthProducts } = await supabase
        .from('products')
        .select('*')
        .in('keyword', monthKeywords)
        .limit(200);

      monthly.products = roundRobin(monthProducts, monthKeywords, SECTION_SIZE).map(toClientProduct);
    } else if (monthly) {
      monthly.products = [];
    }

    const recKeyword = TODAY_PICKS[Math.floor(Math.random() * TODAY_PICKS.length)];
    const { data: recProducts } = await supabase
      .from('products')
      .select('*')
      .eq('keyword', recKeyword)
      .limit(SECTION_SIZE);

    res.json({
      popular: stats || [],
      monthly: monthly || null,
      priceDrop: (priceDrop || []).map(p => ({
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
      })),
      daily: {
        keyword: recKeyword,
        keywords: TODAY_PICKS,
        products: (recProducts || []).map(toClientProduct)
      }
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
