const { searchAll, saveProducts } = require('./_shop');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const keyword = (req.query && req.query.keyword) || '';
  if (!keyword) return res.status(400).json({ error: '키워드 없음' });

  try {
    const { items } = await searchAll(keyword);

    // 서버리스는 응답 직후 함수를 얼려버리므로 저장을 기다린 뒤에 응답한다.
    // (await 없이 호출하면 DB 쓰기가 중간에 끊긴다)
    await saveProducts(keyword, items);

    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
