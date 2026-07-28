const supabase = require('./_supabase');

const MAX_TITLES = 100;
// 잘릴 경우 오래된 쪽이 버려지도록 최신순으로 가져온다 (history.js와 같은 이유).
const MAX_ROWS = 10000;
const MAX_DAYS = 365;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  let titles;
  try {
    titles = JSON.parse((req.query && req.query.titles) || '[]');
  } catch (e) {
    return res.status(400).json({ error: 'titles 파싱 실패' });
  }
  if (!Array.isArray(titles)) return res.status(400).json({ error: 'titles는 배열이어야 함' });

  titles = titles.filter(t => typeof t === 'string' && t).slice(0, MAX_TITLES);
  if (!titles.length) return res.json({});

  try {
    const { data, error } = await supabase
      .from('price_history')
      .select('title, recorded_date, price')
      .in('title', titles)
      .order('recorded_date', { ascending: false })
      .limit(MAX_ROWS);
    if (error) throw new Error(error.message);

    // 같은 상품명이 여러 몰에 있으면 하루에 여러 행이 생기므로
    // history.js와 같은 규칙으로 날짜당 최저가 한 점만 남긴다.
    const perTitle = new Map();
    (data || []).forEach(r => {
      if (!perTitle.has(r.title)) perTitle.set(r.title, new Map());
      const byDate = perTitle.get(r.title);
      const cur = byDate.get(r.recorded_date);
      if (cur === undefined || r.price < cur) byDate.set(r.recorded_date, r.price);
    });

    // 조회된 제목만 채우면 프론트가 map[t] === undefined로 건너뛰므로 전부 빈 배열로 초기화한다.
    const map = {};
    titles.forEach(t => { map[t] = []; });
    perTitle.forEach((byDate, title) => {
      if (!(title in map)) return;
      map[title] = [...byDate.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([date, price]) => ({ date, price }))
        .slice(-MAX_DAYS);
    });

    res.json(map);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
