module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const keyword = (req.query && req.query.keyword) || '';
  if (!keyword) return res.status(400).json({ error: '키워드 없음' });

  try {
    const url = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(keyword)}&display=8&sort=sim`;
    const response = await fetch(url, {
      headers: {
        'X-Naver-Client-Id': process.env.NAVER_ID || '',
        'X-Naver-Client-Secret': process.env.NAVER_SECRET || ''
      }
    });

    if (!response.ok) return res.status(200).json([]);
    
    const data = await response.json();
    const items = (data.items || []).map(it => ({
      title: it.title.replace(/<[^>]*>/g, ''),
      lprice: parseInt(it.lprice) || 0,
      link: it.link || '',
      image: it.image || '',
      mall: it.mallName || '네이버쇼핑',
      productId: String(it.productId || '')
    })).filter(i => i.lprice > 0);

    res.json(items);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};