const crypto = require('crypto');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const accessKey = process.env.COUPANG_ACCESS_KEY;
  const secretKey = process.env.COUPANG_SECRET_KEY;

  if (!accessKey || !secretKey) {
    return res.json({ error: 'COUPANG keys not set', accessKey: !!accessKey, secretKey: !!secretKey });
  }

  const keyword = (req.query && req.query.keyword) || '마우스';
  const limit = 10;
  const path = '/v2/providers/affiliate_open_api/apis/openapi/products/search';
  const query = `keyword=${encodeURIComponent(keyword)}&limit=${limit}`;

  const date = new Date();
  const ts = date.getUTCFullYear().toString().slice(-2)
    + String(date.getUTCMonth() + 1).padStart(2, '0')
    + String(date.getUTCDate()).padStart(2, '0')
    + 'T'
    + String(date.getUTCHours()).padStart(2, '0')
    + String(date.getUTCMinutes()).padStart(2, '0')
    + String(date.getUTCSeconds()).padStart(2, '0')
    + 'Z';

  const hmacMessage = ts + 'GET' + path + query;
  const sig = crypto.createHmac('sha256', secretKey).update(hmacMessage).digest('hex');
  const authHeader = `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${ts}, signature=${sig}`;

  const url = `https://api-gateway.coupang.com${path}?${query}`;

  try {
    const r = await fetch(url, { headers: { Authorization: authHeader } });
    const text = await r.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }

    res.json({
      keyword,
      url,
      hmacMessage_preview: hmacMessage.slice(0, 60) + '...',
      accessKey_len: accessKey.length,
      secretKey_len: secretKey.length,
      http_status: r.status,
      response_raw: text.slice(0, 2000),
      parsed_rCode: parsed ? parsed.rCode : null,
      parsed_rMessage: parsed ? parsed.rMessage : null,
      productData_count: (parsed && parsed.data && parsed.data.productData) ? parsed.data.productData.length : 0,
      first_product: (parsed && parsed.data && parsed.data.productData && parsed.data.productData[0])
        ? { productId: parsed.data.productData[0].productId, productName: (parsed.data.productData[0].productName || '').slice(0, 60) }
        : null
    });
  } catch (e) {
    res.json({ error: e.message });
  }
};
