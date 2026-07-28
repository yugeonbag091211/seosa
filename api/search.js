const { searchAll, saveProducts } = require('./_shop');
const { applyCors } = require('./_http');
const { guard } = require('./_ratelimit');

const MAX_KEYWORD_LEN = 80;

module.exports = async function handler(req, res) {
  if (!applyCors(req, res, 'public')) return;

  // 이 엔드포인트는 호출 한 번당 네이버/쿠팡 API를 각각 호출하고 DB에도 쓴다.
  // 무제한으로 열어두면 외부 API 일일 쿼터와 DB 비용이 그대로 소진된다.
  if (!guard(req, res, { name: 'search', limit: 30, windowMs: 60 * 1000 })) return;

  const keyword = ((req.query && req.query.keyword) || '').trim().slice(0, MAX_KEYWORD_LEN);
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
