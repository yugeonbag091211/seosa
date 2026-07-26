const supabase = require('./_supabase');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const keyword = (req.query && req.query.keyword) || '';
  if (!keyword) return res.status(400).json({ error: '키워드 없음' });

  try {
    const { data: row, error: selErr } = await supabase
      .from('search_stats')
      .select('id, count')
      .eq('keyword', keyword)
      .maybeSingle();
    if (selErr) throw new Error(selErr.message);

    if (row) {
      const { error } = await supabase
        .from('search_stats')
        .update({ count: (row.count || 0) + 1 })
        .eq('id', row.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabase.from('search_stats').insert({ keyword, count: 1 });
      if (error) throw new Error(error.message);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
