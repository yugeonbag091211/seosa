const { searchAll, saveProducts } = require('./_shop');
const { applyCors, cachePublic } = require('./_http');
const { guard } = require('./_ratelimit');

const MAX_KEYWORD_LEN = 80;

/*
 * 검색 결과로 돌려줄 상품 수.
 *
 * 6개였는데, 최저가 비교 서비스에서 6개는 정렬·몰 필터·"몰별 가격 비교"가
 * 전부 의미를 잃는 숫자다. 쿠팡에는 어차피 한 번에 50개를 요청해 캐시에
 * 넣어두므로(_coupang.js FETCH_LIMIT) 이 값을 올려도 API 호출은 늘지 않는다.
 * 프론트는 12개만 먼저 그리고 나머지는 스크롤에 맞춰 붙인다(CONST.LAZY).
 */
const RESULT_LIMIT = 24;

module.exports = async function handler(req, res) {
  if (!applyCors(req, res, 'public')) return;

  // 이 엔드포인트는 호출 한 번당 쿠팡 API를 호출하고 DB에도 쓴다.
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
    // 캐시 결과로 응답한다. 사용자를 무한정 세워두지 않는다.
    const { items, from, blocked } = await searchAll(keyword, {
      coupangLimit: RESULT_LIMIT,
      coupangOpts: { source: 'search', maxWaitMs: 1500 }
    });

    // 서버리스는 응답 직후 함수를 얼려버리므로 저장을 기다린 뒤에 응답한다.
    // (await 없이 호출하면 DB 쓰기가 중간에 끊긴다)
    //
    // from 을 같이 넘긴다. 오래된 캐시로 응답한 경우에는 저장하지 않는다 —
    // 그걸 기록하면 "오늘 이 가격이었다"는 사실이 아닌 기록이 남는다.
    await saveProducts(keyword, items, { from });

    /*
     * 이 가격이 어디서 왔는지 프론트에 알린다.
     *
     * api         — 방금 쿠팡에서 받아온 값
     * cache       — 6시간 이내 캐시 (사실상 현재가)
     * stale-cache — 쿠팡을 못 불러서 꺼낸 오래된 값
     * none        — 보여줄 게 없음
     *
     * 본문 형태(배열)를 바꾸면 프론트 전체를 같이 고쳐야 하므로 헤더로 내보낸다.
     * stale-cache 를 아무 표시 없이 보여주면 사용자는 클릭해서야 다른 가격을 본다.
     */
    res.setHeader('X-Seosa-Source', from);
    if (blocked) res.setHeader('X-Seosa-Blocked', '1');
    res.setHeader('Access-Control-Expose-Headers', 'X-Seosa-Source, X-Seosa-Blocked');

    // 쿠팡 응답 자체가 이미 6시간 캐시된다. 같은 검색어가 몰릴 때 함수 실행과
    // DB 쓰기까지 줄이려고 Edge 에도 짧게 세워둔다. 결과가 달라지지는 않는다.
    // 단 stale-cache 는 캐시하지 않는다 — 차단이 풀린 직후에도 옛 값이 5분 더 남는다.
    if (items.length && from !== 'stale-cache') cachePublic(res, 300);
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
