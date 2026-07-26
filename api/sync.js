const supabase = require('./_supabase');
const { readBody, dbError } = require('./_http');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const email = (req.query && req.query.email) || '';
  if (!email) return res.status(400).json({ error: '이메일 없음' });

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
