const supabase = require('./_supabase');

// 하루에 여러 몰의 행이 쌓이므로 "행 수"와 "일 수"는 다르다.
// 넉넉히 최신순으로 가져온 뒤 날짜 단위로 접고, 마지막에 일 수로 자른다.
const MAX_ROWS = 3000;
const MAX_DAYS = 365;

/** [{recorded_date, price}] → 날짜당 최저가 한 점, 오름차순 */
function collapseToDaily(rows, maxDays) {
  const byDate = new Map();
  (rows || []).forEach(r => {
    const cur = byDate.get(r.recorded_date);
    if (cur === undefined || r.price < cur) byDate.set(r.recorded_date, r.price);
  });

  const points = [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, price]) => ({ date, price }));

  return maxDays ? points.slice(-maxDays) : points;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const title = (req.query && req.query.title) || '';
  if (!title) return res.status(400).json({ error: '상품명 없음' });

  try {
    // 오름차순 + limit으로 가져오면 가장 "오래된" 행만 남아서
    // 기록이 limit을 넘는 순간 최신 가격이 차트에서 사라진다. 반드시 최신순으로 자른다.
    const { data, error } = await supabase
      .from('price_history')
      .select('recorded_date, price')
      .eq('title', title)
      .order('recorded_date', { ascending: false })
      .limit(MAX_ROWS);
    if (error) throw new Error(error.message);

    // 프론트는 오름차순 [{date, price}] 배열을 기대한다 (sparkSVG / 차트 라벨).
    res.json(collapseToDaily(data, MAX_DAYS));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
