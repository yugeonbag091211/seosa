const supabase = require('./_supabase');
const { readBody, dbError } = require('./_http');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    if (req.method === 'GET') {
      const email = (req.query && req.query.email) || '';
      if (!email) return res.status(400).json({ error: '이메일 없음' });

      const { data, error } = await supabase
        .from('alerts')
        .select('title, target_price, current_price, link, image, mall, sent')
        .eq('email', email)
        .order('created_at', { ascending: false });
      const msg = dbError(error, 'alerts');
      if (msg) throw new Error(msg);

      return res.json((data || []).map(a => ({
        title: a.title,
        targetPrice: a.target_price,
        currentPrice: a.current_price,
        link: a.link || '',
        image: a.image || '',
        mall: a.mall || '',
        sent: a.sent ? 'Y' : 'N'
      })));
    }

    if (req.method === 'POST') {
      const { email, title, targetPrice, currentPrice, link, image, mall } = readBody(req);
      if (!email || !title) return res.status(400).json({ error: '이메일 또는 상품명 없음' });

      const { error } = await supabase.from('alerts').upsert({
        email,
        title,
        target_price: parseInt(targetPrice) || 0,
        current_price: parseInt(currentPrice) || 0,
        link: link || '',
        image: image || '',
        mall: mall || '',
        sent: false
      }, { onConflict: 'email,title' });
      const msg = dbError(error, 'alerts');
      if (msg) throw new Error(msg);

      return res.json({ success: true, msg: '알림 신청 완료!' });
    }

    if (req.method === 'DELETE') {
      const { email, title } = readBody(req);
      if (!email || !title) return res.status(400).json({ error: '이메일 또는 상품명 없음' });

      const { error } = await supabase.from('alerts').delete().eq('email', email).eq('title', title);
      const msg = dbError(error, 'alerts');
      if (msg) throw new Error(msg);

      return res.json({ success: true });
    }

    res.status(405).json({ error: 'GET / POST / DELETE만 지원' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
