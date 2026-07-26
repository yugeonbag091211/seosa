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

    // 같은 상품명이 여러 몰에 있으면 하루에 여러 행이 생긴다.
    // 차트 x축이 날짜라서 하루 한 점으로 접어야 하고, 이 앱은 최저가를 추적하므로 최솟값을 쓴다.
    const byDate = new Map();
    (data || []).forEach(r => {
      const cur = byDate.get(r.recorded_date);
      if (cur === undefined || r.price < cur) byDate.set(r.recorded_date, r.price);
    });

    // 프론트는 오름차순 [{date, price}] 배열을 기대한다 (sparkSVG / 차트 라벨).
    res.json([...byDate.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, price]) => ({ date, price })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
