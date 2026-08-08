const supabase = require('./_supabase');
const { applyCors, cachePublic } = require('./_http');
const { guard } = require('./_ratelimit');

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

/**
 * 오름차순 + limit으로 가져오면 가장 "오래된" 행만 남아서
 * 기록이 limit을 넘는 순간 최신 가격이 차트에서 사라진다. 반드시 최신순으로 자른다.
 */
function baseQuery() {
  return supabase
    .from('price_history')
    .select('recorded_date, price')
    .order('recorded_date', { ascending: false })
    .limit(MAX_ROWS);
}

module.exports = async function handler(req, res) {
  if (!applyCors(req, res, 'public')) return;

  if (!guard(req, res, { name: 'history', limit: 90, windowMs: 60 * 1000 })) return;

  const q = req.query || {};
  const title     = String(q.title || '').trim();
  const productId = String(q.productId || '').trim();
  const mall      = String(q.mall || '').trim();

  if (!title && !productId) return res.status(400).json({ error: '상품명 없음' });

  try {
    let rows = null;

    /*
     * 상품 단위(product_id + mall) 조회를 먼저 시도한다.
     *
     * 상품명으로만 찾으면 이름이 같은 다른 상품·다른 몰의 가격이 한 그래프에
     * 섞인다. price_history는 (product_id, mall, recorded_date)로 저장되므로
     * 프론트가 productId를 보낼 때는 그걸로 찾는 게 맞다.
     * (프론트는 예전부터 productId를 보내고 있었는데 여기서 읽지 않고 있었다)
     */
    if (productId) {
      let query = baseQuery().eq('product_id', productId);
      if (mall) query = query.eq('mall', mall);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      if (data && data.length) rows = data;
    }

    // 상품 단위로 못 찾으면(옛 기록·몰 이름 변경) 예전처럼 상품명으로 폴백한다.
    if (!rows && title) {
      const { data, error } = await baseQuery().eq('title', title);
      if (error) throw new Error(error.message);
      rows = data;
    }

    // 프론트는 오름차순 [{date, price}] 배열을 기대한다 (sparkSVG / 차트 라벨).
    cachePublic(res, 300);
    res.json(collapseToDaily(rows, MAX_DAYS));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
