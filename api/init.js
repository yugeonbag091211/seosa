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

    // 프론트의 Monthly.show는 monthly.products를 그리는데 monthly_curation 행에는
    // 그 컬럼이 없다. 이달의 키워드로 products를 조회해 붙여준다.
    const monthKeywords = (monthly && Array.isArray(monthly.keywords)) ? monthly.keywords.filter(Boolean) : [];
    if (monthKeywords.length) {
      const { data: monthProducts } = await supabase
        .from('products')
        .select('*')
        .in('keyword', monthKeywords)
        .limit(200);

      // 키워드 하나가 결과를 독차지하지 않도록 키워드별로 번갈아 8개를 고른다.
      const buckets = new Map(monthKeywords.map(k => [k, []]));
      (monthProducts || []).forEach(p => {
        const b = buckets.get(p.keyword);
        if (b) b.push(p);
      });

      const picked = [];
      for (let i = 0; picked.length < 8; i++) {
        let addedThisRound = false;
        for (const k of monthKeywords) {
          const b = buckets.get(k);
          if (b && b[i]) { picked.push(b[i]); addedThisRound = true; }
          if (picked.length >= 8) break;
        }
        if (!addedThisRound) break;
      }

      monthly.products = picked.map(p => ({
        title: p.title,
        lprice: p.lprice,
        link: p.link,
        image: p.image,
        mall: p.mall,
        productId: p.product_id,
        isCoupang: p.mall === '쿠팡'
      }));
    } else if (monthly) {
      monthly.products = [];
    }

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