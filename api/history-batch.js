const supabase = require('./_supabase');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  let titles;
  try {
    titles = JSON.parse((req.query && req.query.titles) || '[]');
  } catch (e) {
    return res.status(400).json({ error: 'titles 파싱 실패' });
  }
  if (!Array.isArray(titles)) return res.status(400).json({ error: 'titles는 배열이어야 함' });

  titles = titles.filter(t => typeof t === 'string' && t).slice(0, 100);
  if (!titles.length) return res.json({});

  try {
    const { data, error } = await supabase
      .from('price_history')
      .select('title, recorded_date, price')
      .in('title', titles)
      .order('recorded_date', { ascending: true });
    if (error) throw new Error(error.message);

    // 조회된 제목만 채우면 프론트가 map[t] === undefined로 건너뛰므로 전부 빈 배열로 초기화한다.
    const map = {};
    titles.forEach(t => { map[t] = []; });
    (data || []).forEach(r => {
      if (map[r.title]) map[r.title].push({ date: r.recorded_date, price: r.price });
    });

    res.json(map);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
