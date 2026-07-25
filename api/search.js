const crypto = require('crypto');

function coupangAuth(method, path, query, accessKey, secretKey) {
  const date = new Date();
  const ts = date.getUTCFullYear().toString().slice(-2)
    + String(date.getUTCMonth()+1).padStart(2,'0')
    + String(date.getUTCDate()).padStart(2,'0')
    + 'T'
    + String(date.getUTCHours()).padStart(2,'0')
    + String(date.getUTCMinutes()).padStart(2,'0')
    + String(date.getUTCSeconds()).padStart(2,'0')
    + 'Z';
  const sig = crypto.createHmac('sha256', secretKey).update(ts + method + path + query).digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${ts}, signature=${sig}`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const keyword = (req.query && req.query.keyword) || '';
  if (!keyword) return res.status(400).json({ error: '키워드 없음' });

  try {
    const naverUrl = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(keyword)}&display=8&sort=sim`;
    const naverRes = await fetch(naverUrl, {
      headers: {
        'X-Naver-Client-Id': process.env.NAVER_ID || '',
        'X-Naver-Client-Secret': process.env.NAVER_SECRET || ''
      }
    });
    const naverItems = naverRes.ok ? ((await naverRes.json()).items || []).map(it => ({
      title: it.title.replace(/<[^>]*>/g, ''),
      lprice: parseInt(it.lprice) || 0,
      link: it.link || '',
      image: it.image || '',
      mall: it.mallName || '네이버쇼핑',
      productId: String(it.productId || '')
    })).filter(i => i.lprice > 0) : [];

    const path = '/v2/providers/affiliate_open_api/apis/openapi/products/search';
    const query = `keyword=${encodeURIComponent(keyword)}&limit=6`;
    const cupRes = await fetch(`https://api-gateway.coupang.com${path}?${query}`, {
      headers: { Authorization: coupangAuth('GET', path, query, process.env.COUPANG_ACCESS_KEY || '', process.env.COUPANG_SECRET_KEY || '') }
    });
    const cupData = cupRes.ok ? await cupRes.json() : {};
    const cupItems = ((cupData.data && cupData.data.productData) || []).map(it => ({
      title: it.productName || '',
      lprice: parseInt(it.discountPrice || it.productPrice) || 0,
      link: it.productUrl || '',
      image: it.productImage || '',
      mall: '쿠팡',
      productId: String(it.productId || '')
    })).filter(i => i.lprice > 0);

    const items = [];
    const mx = Math.max(naverItems.length, cupItems.length);
    for (let i = 0; i < mx; i++) {
      if (naverItems[i]) items.push(naverItems[i]);
      if (cupItems[i]) items.push(cupItems[i]);
    }

    res.json(items);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};