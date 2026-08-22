const supabase = require('./_supabase');
const { searchAll, saveProducts, TODAY_PICKS } = require('./_shop');
const { attachTrust } = require('./_trust');
const { attachPriceChange } = require('./_facets');
const { applyCors, cachePublic } = require('./_http');
const { guard } = require('./_ratelimit');
const { normalizeText, splitTokens, sortByRelevance, suggestKeywords } = require('./_search');

const MAX_KEYWORD_LEN = 80;

/** 보정 후보를 만들 때 훑을 실제 검색어 수. */
const DICT_LIMIT = 80;

/**
 * 보정/대체 검색어의 재료.
 *
 * 새로 만들어내지 않는다. 우리가 실제로 가진 것만 쓴다.
 *   search_stats  — 사람들이 실제로 친 검색어
 *   products      — 실제로 수집된 상품이 있는 키워드
 *   TODAY_PICKS   — 코드에 박혀 있는 큐레이션 키워드
 *
 * 결과가 있을 때는 부르지 않는다 — 검색 한 번에 DB 조회를 늘릴 이유가 없다.
 */
async function loadKeywordDictionary() {
  const words = new Set(TODAY_PICKS);
  try {
    const [{ data: stats }, { data: prods }] = await Promise.all([
      supabase.from('search_stats').select('keyword').order('count', { ascending: false }).limit(DICT_LIMIT),
      supabase.from('products').select('keyword').limit(500)
    ]);
    (stats || []).forEach(r => { if (r.keyword) words.add(r.keyword); });
    (prods || []).forEach(r => { if (r.keyword) words.add(r.keyword); });
  } catch (e) {
    // 사전을 못 읽어도 검색 자체는 이미 끝났다. 제안만 못 할 뿐이다.
    console.warn(`[search] 보정 사전 조회 실패(제안 생략): ${e.message}`);
  }
  // 집계용 내부 키워드는 사용자에게 보여줄 말이 아니다.
  return [...words].filter(w => !/^__/.test(w));
}

/** 헤더에 실을 수 있게 만든다. 한글은 그대로 넣으면 헤더가 깨진다. */
function encodeList(list) {
  return (list || []).filter(Boolean).map(s => encodeURIComponent(s)).join('|');
}

/*
 * 검색 결과로 돌려줄 상품 수.
 *
 * 24로 올렸다가 되돌렸다. 쿠팡이 limit>10 요청을 rCode=400("limit is out of range")으로 거부해서,
 * 올리는 순간 검색이 0건이 된다 (_coupang.js FETCH_LIMIT 주석 참고).
 * 실제로 그 상태가 배포돼 프로덕션 검색이 잠시 깨졌다.
 *
 * 쿠팡 검색 API 의 limit 상한은 10 이다. 더 올리려면 쿠팡이 상한을 바꾼 뒤에.
 * 이 값만 올리면 소용없다 — 실제 요청 크기는 FETCH_LIMIT 이 정한다.
 */
const RESULT_LIMIT = 10;

module.exports = async function handler(req, res) {
  if (!applyCors(req, res, 'public')) return;

  // 이 엔드포인트는 호출 한 번당 쿠팡 API를 호출하고 DB에도 쓴다.
  // 무제한으로 열어두면 외부 API 일일 쿼터와 DB 비용이 그대로 소진된다.
  if (!guard(req, res, { name: 'search', limit: 30, windowMs: 60 * 1000 })) return;

  const rawKeyword = ((req.query && req.query.keyword) || '').trim().slice(0, MAX_KEYWORD_LEN);
  if (!rawKeyword) return res.status(400).json({ error: '키워드 없음' });

  /*
   * 검색어 정리.
   *
   * 전각(ＬＧ)·대소문자·연속 공백만 정리한다. 띄어쓰기 자체는 건드리지 않는다 —
   * "무선 이어폰"에서 공백을 빼면 쿠팡이 주는 결과가 실제로 달라진다.
   * 여기서 하는 일은 같은 뜻의 표기가 서로 다른 캐시 항목을 만들지 않게 하는 것뿐이다.
   *
   * 화면과 집계에는 사용자가 친 그대로를 쓴다(rawKeyword).
   */
  const keyword = normalizeText(rawKeyword);

  /*
   * 글자다운 글자가 하나도 안 남았으면 검색하지 않는다.
   *
   * 2026-08-10 검증 중에 인코딩이 깨진 검색어("������Ʈ")가 그대로 들어왔다.
   * 그러면 세 가지가 한꺼번에 일어난다.
   *   1) 쿠팡 호출 1회를 그냥 쓴다 (쿼터는 하루치가 정해져 있다)
   *   2) 쿠팡이 검색어를 못 읽고 아무 인기상품 10건을 돌려준다
   *   3) 판단할 토큰이 없으니 관련도 필터도 통과해서 products 에 그대로 저장된다
   *      — 실제로 그렇게 9행이 들어갔다 (프라이팬·화장지·백팩…)
   *
   * 한글·영문·숫자가 하나도 없는 입력은 쿠팡에 물어봐도 의미가 없다.
   * 호출하기 전에 여기서 끊는다.
   */
  if (!splitTokens(keyword).length) {
    return res.status(400).json({ error: '검색어를 다시 입력해 주세요' });
  }

  try {
    // 쿠팡은 _coupang.js를 거친다. 캐시가 신선하면 API 호출 0회로 끝난다.
    //
    // maxWaitMs는 "간격 대기를 얼마나 참을지"다. 0으로 두면 1초 안에 검색이
    // 두 번 들어오기만 해도 뒤쪽은 쿠팡 결과를 통째로 잃는다. 한 칸(약 1.2초)은
    // 기다리고, 그보다 더 밀리면(=앞에 여러 건이 쌓였으면) 기다리지 않고
    // 캐시 결과로 응답한다. 사용자를 무한정 세워두지 않는다.
    const { items, allItems, from, blocked } = await searchAll(keyword, {
      coupangLimit: RESULT_LIMIT,
      coupangOpts: { source: 'search', maxWaitMs: 1500 }
    });

    await saveProducts(keyword, allItems || items, { from });

    /*
     * 가격 신뢰도.
     *
     * 저장이 끝난 뒤에 붙인다 — 방금 저장한 오늘 관측까지 포함해서
     * 교차 확인 여부를 판단해야 화면과 DB 가 어긋나지 않는다.
     * from 을 넘기면 '방금 확인'과 '오래된 캐시'를 구분한다.
     */
    await attachTrust(items, { source: from });

    /*
     * "최근 가격 하락" 정보.
     *
     * 홈 시세판과 같은 뷰(price_drop_top) · 같은 기준(_price.plausibleDrop)이다.
     * 쿠팡 API 는 부르지 않는다 — Supabase 조회 1회만 늘어난다.
     * 실패해도 검색은 그대로 진행된다(하락 필터 버튼이 안 뜰 뿐이다).
     */
    await attachPriceChange(items);

    /*
     * 순서.
     *
     * 관련도(_search.rankItems 가 붙인 relevance) → 가격 신뢰도 → 가격 순이다.
     * 신뢰도가 붙은 다음에 세워야 한다 — 그 전에 세우면 신뢰도는 아직 없다.
     *
     * 관련도는 0.1 단위 계단으로 본다. 계단이 다르면 가격은 아예 보지 않는다.
     * "싸지만 내가 찾던 게 아닌 상품"이 1위인 것은 최저가 비교 서비스에서
     * 가장 하기 쉬운 실수다 (_search.sortByRelevance 주석 참고).
     */
    const ranked = sortByRelevance(items);

    /*
     * 결과가 없을 때만 보정/대체 검색어를 만든다.
     *
     * 결과가 있는데도 "혹시 이거였나요"를 들이밀면 멀쩡한 검색을 의심하게 만든다.
     * 그리고 사전 조회는 DB 를 두 번 더 읽는다 — 매 검색마다 낼 비용이 아니다.
     * 쿠팡 API 는 여기서 한 번도 더 부르지 않는다.
     */
    if (!ranked.length) {
      const dict = await loadKeywordDictionary();
      // excludeSelf: 결과가 0건인데 검색 로그에 그 말이 있다는 사실은
      // 그 말이 맞다는 근거가 아니다 (_search.suggestKeywords 주석 참고).
      const s = suggestKeywords(rawKeyword, dict, { excludeSelf: true });
      if (s.corrected) {
        res.setHeader('X-Seosa-Correct', encodeURIComponent(s.corrected));
        res.setHeader('X-Seosa-Correct-Kind', s.reason);
      }
      if (s.alternatives.length) {
        res.setHeader('X-Seosa-Suggest', encodeList(s.alternatives));
      }
    }

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
    res.setHeader('Access-Control-Expose-Headers',
      'X-Seosa-Source, X-Seosa-Blocked, X-Seosa-Correct, X-Seosa-Correct-Kind, X-Seosa-Suggest');

    // 쿠팡 응답 자체가 이미 6시간 캐시된다. 같은 검색어가 몰릴 때 함수 실행과
    // DB 쓰기까지 줄이려고 Edge 에도 짧게 세워둔다. 결과가 달라지지는 않는다.
    // 단 stale-cache 는 캐시하지 않는다 — 차단이 풀린 직후에도 옛 값이 5분 더 남는다.
    if (ranked.length && from !== 'stale-cache') cachePublic(res, 300);
    res.json(ranked);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
