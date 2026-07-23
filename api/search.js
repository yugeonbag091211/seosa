const https = require('https');

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const keyword = (req.query && req.query.keyword) || '';
  if (!keyword) {
    res.status(400).json({ error: '키워드 없음' });
    return;
  }

  const options = {
    hostname: 'openapi.naver.com',
    path: '/v1/search/shop.json?query=' + encodeURIComponent(keyword) + '&display=8&sort=sim',
    headers: {
      'X-Naver-Client-Id': process.env.NAVER_ID || '',
      'X-Naver-Client-Secret': process.env.NAVER_SECRET || ''
    }
  };

  const req2 = https.get(options, function(r) {
    let data = '';
    r.on('data', function(chunk) { data += chunk; });
    r.on('end', function() {
      try {
        const json = JSON.parse(data);
        const items = (json.items || []).map(function(it) {
          return {
            title: it.title.replace(/<[^>]*>/g, ''),
            lprice: parseInt(it.lprice) || 0,
            link: it.link || '',
            image: it.image || '',
            mall: it.mallName || '네이버쇼핑',
            productId: String(it.productId || '')
          };
        }).filter(function(i) { return i.lprice > 0; });
        res.json(items);
      } catch(e) {
        res.status(500).json({ error: e.message });
      }
    });
  });

  req2.on('error', function(e) {
    res.status(500).json({ error: e.message });
  });
};