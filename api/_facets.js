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
// vendorIdOf — 컬럼이 없으면 link 에서 옵션 식별자를 뽑는 공식 helper.
// 여기서 새 파싱을 만들지 않는다 (규칙이 갈라지면 한쪽만 고쳐진다).
const { plausibleDrop, parsePrice, vendorIdOf } = require('./_price');

/** product_id in (...) 한 번에 넣을 개수. _trust.js 와 같은 이유로 나눠 보낸다. */
const CHUNK = 100;

/**
 * 이 상품에 붙여도 되는 시세판 행을 고른다. 확신이 없으면 아무것도 고르지 않는다.
 *
 * ── 왜 "고르기" 가 어려운가 ────────────────────────────────────────
 *
 * price_drop_top 은 (product_id, mall, vendor_item_id) 단위로 계산되는데
 * 결과 컬럼에 vendor_item_id 가 없다. 행이 어느 옵션의 것인지 알려 주는 값이
 * 응답 안에 하나도 없다.
 *
 * link 로 가를 수 있을 것 같지만 안 된다. 뷰의 link 는 price_history 가 아니라
 * products 에서 오고, join 조건이 (product_id, mall) 뿐이라 같은 상품의 모든
 * 행이 같은 link 를 단다.
 *   2026-09-05 운영 실측: 뷰 행이 2개 이상인 상품 451개 중
 *   행마다 link 의 vid 가 갈리는 상품 = 0개. 전부 같은 옵션을 가리킨다.
 *
 * ── 그래서 어떻게 하는가 ──────────────────────────────────────────
 *
 *   행이 하나뿐   → 옵션이 갈릴 여지가 없다. 다만 그 하나가 이 상품이 지금
 *                   파는 옵션인지까지는 뷰만으로 확인할 수 없으므로,
 *                   link 의 옵션과 상품의 옵션이 어긋나면 붙이지 않는다.
 *   행이 여럿     → 어느 것이 이 옵션의 것인지 알 수 없다. 붙이지 않는다.
 *
 * 마지막 행을 고르는 것은 "고르는" 것이 아니라 순서에 맡기는 것이다.
 * 모르면 모른다고 두는 편이, 남의 옵션 가격을 이 상품의 하락이라고
 * 말하는 것보다 낫다 — 붙지 않으면 하락 배지가 안 뜰 뿐이다.
 *
 * 완전한 해결은 뷰가 vendor_item_id 를 내보내는 것이다. 그건 SQL 변경이라
 * 별도 승인 작업으로 둔다.
 *
 * @param {Array} rows  이 (product_id, mall) 의 뷰 행들
 * @param {object} it   상품 항목
 * @returns {object|null} 붙여도 되는 행, 없으면 null
 */
function pickRowForItem(rows, it) {
  if (rows.length > 1) return null;        // 옵션을 가릴 수 없다 — 추측하지 않는다

  const row = rows[0];
  const itemVid = vendorIdOf(it);
  const rowVid = vendorIdOf(row);

  // 어느 한쪽이라도 옵션을 모르면 예전처럼 상품 단위로 붙인다(옛 데이터 회귀 방지).
  if (!itemVid || !rowVid) return row;

  return itemVid === rowVid ? row : null;
}

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
 * ★ 연결은 product_id + mall + 옵션(vendor_item_id) 으로 한다. title 은 쓰지 않는다.
 *   옵션을 가릴 수 없으면 붙이지 않는다 — pickRowForItem 주석 참고.
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
      /*
       * ★ 덮어쓰지 않고 모아 둔다 (2026-09-05).
       *
       * 예전에는 byKey.set(key, r) 이라 같은 상품에 뷰 행이 여럿이면
       * "마지막에 온 행" 이 이겼다. price_drop_top 은 (pid, mall, vid) 단위라
       * 옵션이 둘 이상 살아 있으면 행도 여럿이다.
       *
       * 2026-09-05 운영 실측: 뷰 행이 2개 이상인 상품 451개, 그중 228개는
       * 행마다 current_price 가 다르다. 예)
       *   125351695|쿠팡  후보 [13,340 , 44,490] → 44,490 이 붙었다
       *   1336185682|쿠팡 후보 [9,500 , 15,330]  → 15,330 이 붙었다
       * 13,340원짜리 옵션을 보고 있는 사용자에게 44,490원 옵션의 하락
       * 정보를 붙인 것이다. 어느 쪽이 맞는지는 순서가 정했다.
       */
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(r);
    });
  }

  list.forEach(it => {
    if (!it || !it.productId) return;
    const rows = byKey.get(`${it.productId}|${it.mall || ''}`);
    if (!rows || !rows.length) return;
    const r = pickRowForItem(rows, it);
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

module.exports = {
  attachPriceChange,
  // 테스트용 순수 함수 (다른 모듈이 부르지 않는다).
  _internal: { pickRowForItem }
};
