'use strict';
/*
 * 검색 결과 필터/정렬용 부가 정보.
 *
 * ★ 이 파일은 Vercel 함수가 아니다 (api/_ 로 시작하는 파일은 배포되지 않는다).
 *   함수 12/12 를 쓰고 있으므로 새 엔드포인트를 만들지 않고 기존 /api/search 가
 *   가져다 쓴다.
 *
 * 여기서 하지 않는 것
 *   - 가격 신뢰도 계산 (api/_trust.js 담당. 손대지 않는다)
 *   - 검색 관련도 계산 (api/_search.js 담당. 손대지 않는다)
 *   - 하락 판정 기준 신설 (api/_price.plausibleDrop 을 그대로 쓴다)
 *
 * 여기서 하는 것은 하나다: 이미 있는 데이터를 상품에 붙여서
 * 프론트가 필터/정렬을 걸 수 있게 만드는 것.
 */

const supabase = require('./_supabase');
const { plausibleDrop, parsePrice } = require('./_price');

/** product_id in (...) 한 번에 넣을 개수. _trust.js 와 같은 이유로 나눠 보낸다. */
const CHUNK = 100;

/**
 * 상품 목록에 "최근 가격 하락" 정보를 붙인다 (제자리 수정 후 같은 배열 반환).
 *
 * 근거 데이터는 price_drop_top 뷰다. 홈 시세판(api/init.js)이 쓰는 바로 그 뷰이고,
 * 통과 기준도 같은 _price.plausibleDrop() 이다. 검색 결과에서 "가격 하락"이라고
 * 표시한 상품이 홈 시세판 기준으로는 하락이 아닌 상황을 만들지 않기 위해서다.
 *
 * ★ "지금 싸다" 와 "내려갔다" 는 다르다.
 *   현재가가 낮다는 이유로 하락 표시를 붙이지 않는다. 직전 관측(prev_price)
 *   대비 실제로 내려갔고, 그 폭이 설명 가능한 범위(80% 미만)일 때만 붙인다.
 *
 * ★ 연결은 product_id + mall 로만 한다. title 은 쓰지 않는다.
 *
 * 조회 실패는 검색을 막지 않는다 — 하락 정보 없이 그대로 진행한다
 * (필터 버튼은 프론트에서 자동으로 숨겨진다).
 *
 * @param {Array} items toClientProduct / fetchCoupang 이 만든 항목
 * @returns {Array} 같은 배열. 해당하는 항목에만 it.priceChange 가 붙는다.
 */
async function attachPriceChange(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return list;

  const ids = [...new Set(list.map(it => it && it.productId).filter(Boolean).map(String))];
  if (!ids.length) return list;

  // 같은 product_id 의 다른 몰 행이 섞이지 않게 키까지 맞춰 본다.
  const wanted = new Set(list
    .filter(it => it && it.productId)
    .map(it => `${it.productId}|${it.mall || ''}`));

  const byKey = new Map();

  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await supabase
      .from('price_drop_top')
      .select('product_id, mall, current_price, prev_price, all_time_low, drop_amount, drop_pct, is_all_time_low, link')
      .in('product_id', ids.slice(i, i + CHUNK));

    if (error) {
      console.warn(`[facets] 가격 하락 조회 실패(하락 정보 없이 진행): ${error.message}`);
      return list;
    }

    (data || []).forEach(r => {
      const key = `${r.product_id}|${r.mall}`;
      if (!wanted.has(key)) return;        // product_id 는 같지만 몰이 다른 행
      if (!plausibleDrop(r)) return;       // 홈 시세판과 같은 기준
      byKey.set(key, r);
    });
  }

  list.forEach(it => {
    if (!it || !it.productId) return;
    const r = byKey.get(`${it.productId}|${it.mall || ''}`);
    if (!r) return;
    it.priceChange = {
      prevPrice: parsePrice(r.prev_price) || 0,
      currentPrice: parsePrice(r.current_price) || 0,
      dropAmount: Number(r.drop_amount) || 0,
      dropPct: Number(r.drop_pct) || 0,
      isAllTimeLow: !!r.is_all_time_low
    };
  });

  return list;
}

module.exports = { attachPriceChange };
