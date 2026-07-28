const supabase = require('./_supabase');
const { readBody, dbError, applyCors, readEmail } = require('./_http');
const { guard } = require('./_ratelimit');

const MAX_TITLE_LEN = 300;
const MAX_ALERTS_PER_EMAIL = 100;

module.exports = async function handler(req, res) {
  // 개인 데이터라 Access-Control-Allow-Origin: * 를 붙이지 않는다.
  if (!applyCors(req, res, 'private')) return;

  if (!guard(req, res, { name: 'alerts', limit: 40, windowMs: 60 * 1000 })) return;

  try {
    if (req.method === 'GET') {
      const email = readEmail(req.query && req.query.email);
      if (!email) return res.status(400).json({ error: '이메일 형식이 올바르지 않습니다' });

      const { data, error } = await supabase
        .from('alerts')
        .select('title, target_price, current_price, link, image, mall, sent')
        .eq('email', email)
        .order('created_at', { ascending: false })
        .limit(MAX_ALERTS_PER_EMAIL);
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
      const body = readBody(req);
      const email = readEmail(body.email);
      const title = String(body.title || '').trim().slice(0, MAX_TITLE_LEN);

      if (!email) return res.status(400).json({ error: '이메일 형식이 올바르지 않습니다' });
      if (!title) return res.status(400).json({ error: '상품명 없음' });

      const targetPrice = parseInt(body.targetPrice, 10) || 0;
      if (targetPrice <= 0) return res.status(400).json({ error: '목표 가격이 올바르지 않습니다' });

      const { error } = await supabase.from('alerts').upsert({
        email,
        title,
        target_price: targetPrice,
        current_price: parseInt(body.currentPrice, 10) || 0,
        link: String(body.link || '').slice(0, 2000),
        image: String(body.image || '').slice(0, 2000),
        mall: String(body.mall || '').slice(0, 100),
        // 다시 신청하면 조건 충족 시 또 받아볼 수 있어야 한다.
        sent: false
      }, { onConflict: 'email,title' });
      const msg = dbError(error, 'alerts');
      if (msg) throw new Error(msg);

      return res.json({ success: true, msg: '알림 신청 완료!' });
    }

    if (req.method === 'DELETE') {
      const body = readBody(req);
      const email = readEmail(body.email);
      const title = String(body.title || '').trim();

      if (!email) return res.status(400).json({ error: '이메일 형식이 올바르지 않습니다' });
      if (!title) return res.status(400).json({ error: '상품명 없음' });

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
