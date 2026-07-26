const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const TODAY_PICKS = ['노트북','무선 이어폰','스마트워치','텀블러','향수','가방','키보드','스피커'];
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const keyword = req.query.keyword || TODAY_PICKS[Math.floor(Math.random() * TODAY_PICKS.length)];
  try {
    const { data } = await supabase.from('products').select('*').eq('keyword', keyword).limit(8);
    res.json({ keyword, products: (data || []).map(p => ({ title: p.title, lprice: p.lprice, link: p.link, image: p.image, mall: p.mall, productId: p.product_id, isCoupang: p.mall === '쿠팡' })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
};
