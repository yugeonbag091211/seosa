const supabase = require('./_supabase');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const title = (req.query && req.query.title) || '';
  if (!title) return res.status(400).json({ error: '상품명 없음' });

  try {
    const { data, error } = await supabase
      .from('price_history')
      .select('recorded_date, price')
      .eq('title', title)
      .order('recorded_date', { ascending: true })
      .limit(365);
    if (error) throw new Error(error.message);

    // 프론트는 오름차순 [{date, price}] 배열을 기대한다 (sparkSVG / 차트 라벨).
    res.json((data || []).map(r => ({ date: r.recorded_date, price: r.price })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
