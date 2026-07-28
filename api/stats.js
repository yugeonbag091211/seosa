const supabase = require('./_supabase');

const MAX_KEYWORD_LEN = 80;

/**
 * select 후 update 하는 방식은 같은 키워드가 동시에 검색되면 카운트가 유실된다.
 * increment_search_stat RPC(단일 statement)를 우선 쓰고,
 * 아직 supabase/schema.sql을 실행하지 않은 환경에서는 예전 방식으로 폴백한다.
 */
async function incrementFallback(keyword) {
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
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const keyword = ((req.query && req.query.keyword) || '').trim().slice(0, MAX_KEYWORD_LEN);
  if (!keyword) return res.status(400).json({ error: '키워드 없음' });

  try {
    const { error: rpcErr } = await supabase.rpc('increment_search_stat', { kw: keyword });
    if (rpcErr) {
      // 함수가 아직 없는 환경(스키마 미적용)만 폴백한다. 그 외 오류는 그대로 올린다.
      if (!/function|schema cache|does not exist/i.test(rpcErr.message)) {
        throw new Error(rpcErr.message);
      }
      await incrementFallback(keyword);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
