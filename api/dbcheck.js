const supabase = require('./_supabase');

// 임시 진단 엔드포인트 — 수집 커버리지 검증용
// CRON_SECRET 또는 ?secret= 로 보호
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const secret = process.env.CRON_SECRET;
  const provided = req.query.secret || (req.headers.authorization || '').replace('Bearer ', '');
  if (secret && provided !== secret) {
    return res.status(401).json({ error: '인증 실패' });
  }

  try {
    const TODAY = new Date().toISOString().slice(0, 10);

    // 1. products 총 개수
    const { count: total } = await supabase
      .from('products').select('*', { count: 'exact', head: true });

    // 2. 오늘 price_history
    const { data: todayRows, error: hErr } = await supabase
      .from('price_history')
      .select('product_id, mall, title')
      .eq('recorded_date', TODAY);
    if (hErr) throw new Error(hErr.message);

    // 3. 최근 7일 날짜별 행 수
    const { data: recent } = await supabase
      .from('price_history')
      .select('recorded_date')
      .gte('recorded_date', new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10))
      .order('recorded_date', { ascending: false });

    const dateCounts = {};
    (recent || []).forEach(r => {
      dateCounts[r.recorded_date] = (dateCounts[r.recorded_date] || 0) + 1;
    });

    // 4. products 전체 (미수집 찾기)
    const all = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await supabase.from('products')
        .select('product_id, mall, title, keyword')
        .order('product_id', { ascending: true })
        .range(from, from + 999);
      all.push(...(data || []));
      if (!data || data.length < 1000) break;
    }

    const covered = new Set(todayRows.map(r => r.product_id + '|' + r.mall));
    const missing = all.filter(p => !covered.has(p.product_id + '|' + p.mall));

    // 키워드별 분포
    const kwStat = {};
    all.forEach(p => {
      const k = p.keyword || '(없음)';
      if (!kwStat[k]) kwStat[k] = { total: 0, missing: 0 };
      kwStat[k].total++;
    });
    missing.forEach(p => {
      const k = p.keyword || '(없음)';
      if (!kwStat[k]) kwStat[k] = { total: 0, missing: 0 };
      kwStat[k].missing++;
    });

    const coverage = total > 0 ? (todayRows.length / total * 100).toFixed(1) : 0;

    res.json({
      date: TODAY,
      products_total: total,
      history_today: todayRows.length,
      coverage_pct: parseFloat(coverage),
      missing_count: missing.length,
      by_keyword: Object.fromEntries(
        Object.entries(kwStat)
          .sort((a, b) => b[1].missing - a[1].missing)
          .map(([k, s]) => [k, { total: s.total, collected: s.total - s.missing, missing: s.missing,
            pct: Math.round((s.total - s.missing) / s.total * 100) }])
      ),
      missing_products: missing.slice(0, 50).map(p => ({
        mall: p.mall, keyword: p.keyword || null,
        product_id: p.product_id, title: p.title.slice(0, 60)
      })),
      recent_dates: dateCounts
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
