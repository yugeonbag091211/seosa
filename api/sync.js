const supabase = require('./_supabase');
const { readBody, dbError, applyCors, readEmail, tooLarge } = require('./_http');
const { guard } = require('./_ratelimit');

const MAX_PAYLOAD_BYTES = 256 * 1024;   // 위시 + 조회기록 + 검색기록이면 충분한 크기

module.exports = async function handler(req, res) {
  // 개인 데이터라 Access-Control-Allow-Origin: * 를 붙이지 않는다.
  if (!applyCors(req, res, 'private')) return;

  // 이메일 주소를 바꿔가며 훑는 것을 늦춘다.
  if (!guard(req, res, { name: 'sync', limit: 40, windowMs: 60 * 1000 })) return;

  const email = readEmail(req.query && req.query.email);
  if (!email) return res.status(400).json({ error: '이메일 형식이 올바르지 않습니다' });

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('user_data')
        .select('data')
        .eq('email', email)
        .maybeSingle();
      const msg = dbError(error, 'user_data');
      if (msg) throw new Error(msg);

      // 프론트는 { success, data }를 기대하고 data를 다시 JSON 문자열로 감싼다.
      return res.json({ success: !!(data && data.data), data: (data && data.data) || {} });
    }

    if (req.method === 'POST') {
      const body = readBody(req);
      if (tooLarge(body, MAX_PAYLOAD_BYTES)) {
        return res.status(413).json({ error: '저장할 데이터가 너무 큽니다' });
      }

      const { error } = await supabase.from('user_data').upsert({
        email,
        data: body,
        updated_at: new Date().toISOString()
      }, { onConflict: 'email' });
      const msg = dbError(error, 'user_data');
      if (msg) throw new Error(msg);

      return res.json({ success: true });
    }

    res.status(405).json({ error: 'GET / POST만 지원' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
