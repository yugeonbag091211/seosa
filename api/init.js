const supabase = require('./_supabase');

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
      .single();

    const { data: priceDrop } = await supabase
      .from('price_drop_top')
      .select('*')
      .limit(8);

    const TODAY_PICKS = ['노트북','무선 이어폰','스마트워치','텀블러','향수','가방','키보드','스피커'];
    const recKeyword = TODAY_PICKS[Math.floor(Math.random() * TODAY_PICKS.length)];
    const { data: recProducts } = await supabase
      .from('products')
      .select('*')
      .eq('keyword', recKeyword)
      .limit(4);

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
        products: (recProducts || []).map(p => ({
          title: p.title,
          lprice: p.lprice,
          link: p.link,
          image: p.image,
          mall: p.mall,
          productId: p.product_id,
          isCoupang: p.mall === '쿠팡'
        }))
      }
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};