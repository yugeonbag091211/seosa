const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// 네이버 검색
async function getNaverResults(keyword) {
  if (!process.env.NAVER_ID || !keyword) return [];
  const url = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(keyword)}&display=8&sort=sim`;
  try {
    const res = await fetch(url, {
      headers: {
        'X-Naver-Client-Id': process.env.NAVER_ID,
        'X-Naver-Client-Secret': process.env.NAVER_SECRET
      }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.items || []).map(it => ({
      title: it.title.replace(/<[^>]*>/g, ''),
      lprice: parseInt(it.lprice) || 0,
      oprice: parseInt(it.hprice) || 0,
      savePct: it.hprice > it.lprice ? Math.round((1 - it.lprice / it.hprice) * 100) : 0,
      link: it.link || '',
      image: it.image || '',
      mall: it.mallName || '네이버쇼핑',
      isCoupang: false,
      productId: String(it.productId || '')
    })).filter(i => i.lprice > 0);
  } catch (e) {
    console.error('네이버 오류:', e.message);
    return [];
  }
}

// Supabase에 저장
async function saveProducts(keyword, items) {
  if (!items.length) return;
  const rows = items.map(it => ({
    keyword,
    title: it.title,
    price: it.lprice,
    link: it.link,
    mall: it.mall,
    image: it.image,
    product_id: it.productId
  }));
  await supabase.from('products').upsert(rows, { onConflict: 'title,mall' });
}

// Vercel API 핸들러
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const keyword = req.query.keyword || '';
  if (!keyword) return res.status(400).json({ error: '키워드 없음' });

  try {
    const items = await getNaverResults(keyword);
    await saveProducts(keyword, items);
    res.json(items);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};