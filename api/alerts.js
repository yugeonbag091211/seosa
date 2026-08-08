const supabase = require('./_supabase');
const { readBody, dbError, applyCors, readEmail, noStore } = require('./_http');
const { guard } = require('./_ratelimit');
const { requireAuth } = require('./_auth');

const MAX_TITLE_LEN = 300;
const MAX_ALERTS_PER_EMAIL = 100;

module.exports = async function handler(req, res) {
  // 개인 데이터라 Access-Control-Allow-Origin: * 를 붙이지 않는다.
  if (!applyCors(req, res, 'private')) return;
  noStore(res);   // 개인 데이터 — 중간 캐시에 남으면 안 된다

  if (!guard(req, res, { name: 'alerts', limit: 40, windowMs: 60 * 1000 })) return;

  try {
    if (req.method === 'GET') {
      const email = readEmail(req.query && req.query.email);
      if (!email) return res.status(400).json({ error: '이메일 형식이 올바르지 않습니다' });
      // 남의 이메일로 조회하면 그 사람이 무엇을 사려는지가 그대로 보인다.
      if (!requireAuth(req, res, email)) return;

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
      // 인증 없이 열어두면 아무 주소로나 알림 메일을 보내게 만들 수 있다.
      if (!requireAuth(req, res, email)) return;

      const targetPrice = parseInt(body.targetPrice, 10) || 0;
      if (targetPrice <= 0) return res.status(400).json({ error: '목표 가격이 올바르지 않습니다' });

      const row = {
        email,
        title,
        target_price: targetPrice,
        current_price: parseInt(body.currentPrice, 10) || 0,
        link: String(body.link || '').slice(0, 2000),
        image: String(body.image || '').slice(0, 2000),
        mall: String(body.mall || '').slice(0, 100),
        // 다시 신청하면 조건 충족 시 또 받아볼 수 있어야 한다.
        sent: false
      };

      /*
       * 상품 단위 식별자를 같이 저장한다.
       *
       * 프론트는 예전부터 productId 를 보내고 있었는데 여기서 버렸고, 그래서
       * check-alerts.js 가 상품명만으로 오늘 가격을 찾는다. 쿠팡에는 같은 이름의
       * 다른 상품이 흔해서, 엉뚱한 상품 가격으로 "목표가 달성" 메일이 나갈 수 있다.
       *
       * product_id 컬럼은 supabase/2026-08-hardening.sql 에서 추가된다.
       * 아직 실행하지 않은 DB에서도 알림 신청 자체는 되어야 하므로,
       * 컬럼이 없다는 오류면 빼고 한 번 더 시도한다 (check-alerts.js 와 같은 방식).
       */
      const productId = String(body.productId || '').slice(0, 100);

      let { error } = await supabase
        .from('alerts')
        .upsert({ ...row, product_id: productId }, { onConflict: 'email,title' });

      if (error && /product_id|column/i.test(error.message)) {
        console.warn('[alerts] product_id 컬럼 없음 — supabase/2026-08-hardening.sql을 실행하세요.');
        ({ error } = await supabase.from('alerts').upsert(row, { onConflict: 'email,title' }));
      }

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
      if (!requireAuth(req, res, email)) return;

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
