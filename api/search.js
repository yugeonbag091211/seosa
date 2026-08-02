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
    // 쿠팡은 _coupang.js를 거친다. 캐시가 신선하면 API 호출 0회로 끝난다.
    //
    // maxWaitMs는 "간격 대기를 얼마나 참을지"다. 0으로 두면 1초 안에 검색이
    // 두 번 들어오기만 해도 뒤쪽은 쿠팡 결과를 통째로 잃는다. 한 칸(약 1.2초)은
    // 기다리고, 그보다 더 밀리면(=앞에 여러 건이 쌓였으면) 기다리지 않고
    // 캐시/네이버 결과로 응답한다. 사용자를 무한정 세워두지 않는다.
    const { items } = await searchAll(keyword, {
      coupangOpts: { source: 'search', maxWaitMs: 1500 }
    });

    // 서버리스는 응답 직후 함수를 얼려버리므로 저장을 기다린 뒤에 응답한다.
    // (await 없이 호출하면 DB 쓰기가 중간에 끊긴다)
    await saveProducts(keyword, items);

    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
