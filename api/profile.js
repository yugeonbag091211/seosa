const supabase = require('./_supabase');
const { readBody, dbError, applyCors, readEmail, tooLarge } = require('./_http');
const { guard } = require('./_ratelimit');

const MAX_PAYLOAD_BYTES = 16 * 1024;   // 닉네임/카테고리/예산/성별이면 충분

module.exports = async function handler(req, res) {
  // 개인 데이터라 Access-Control-Allow-Origin: * 를 붙이지 않는다.
  if (!applyCors(req, res, 'private')) return;

  if (!guard(req, res, { name: 'profile', limit: 40, windowMs: 60 * 1000 })) return;

  const email = readEmail(req.query && req.query.email);
  if (!email) return res.status(400).json({ error: '이메일 형식이 올바르지 않습니다' });

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('profiles')
        .select('data')
        .eq('email', email)
        .maybeSingle();
      const msg = dbError(error, 'profiles');
      if (msg) throw new Error(msg);

      return res.json((data && data.data) || {});
    }

    if (req.method === 'POST') {
      const body = readBody(req);
      if (tooLarge(body, MAX_PAYLOAD_BYTES)) {
        return res.status(413).json({ error: '저장할 데이터가 너무 큽니다' });
      }

      const { error } = await supabase.from('profiles').upsert({
        email,
        data: body,
        updated_at: new Date().toISOString()
      }, { onConflict: 'email' });
      const msg = dbError(error, 'profiles');
      if (msg) throw new Error(msg);

      return res.json({ success: true });
    }

    res.status(405).json({ error: 'GET / POST만 지원' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
