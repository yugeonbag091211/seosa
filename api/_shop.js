// 쿠팡 HMAC 서명은 api/_coupang.js 한 곳에만 있다.
// 여기(또는 다른 파일)에 서명 함수를 다시 만들면 캐시·분당 상한·차단 감지를
// 통째로 우회하게 된다. 쿠팡 호출은 반드시 searchCoupang()로.
const supabase = require('./_supabase');
const { searchCoupang } = require('./_coupang');

const TODAY_PICKS = ['수영복', '물놀이 용품', '아이스크림', '방수팩', '차량용 햇빛 가리개', '여행용 캐리어', '서큘레이터', '쿨토시'];

/** 정가(oprice) 대비 할인율(%). 정가 정보가 없거나 역전이면 0. */
function discountPct(lprice, oprice) {
  if (!(oprice > 0) || !(lprice > 0) || oprice <= lprice) return 0;
  return Math.round((1 - lprice / oprice) * 100);
}

/**
 * 쿠팡 검색.
 *
 * 직접 fetch 하지 않고 _coupang.js를 거친다. 그쪽에 캐시 / 분당 상한 /
 * 차단 감지가 들어 있어서, 여기서 따로 호출하면 전부 우회하게 된다.
 * 실패해도 throw 하지 않고 빈 목록을 준다.
 */
async function fetchCoupang(keyword, limit = 6, opts = {}) {
  const r = await searchCoupang(keyword, { limit, ...opts });
  const items = r.items.map(it => ({
    title: it.title,
    lprice: it.lprice,
    link: it.link,
    image: it.image,
    mall: '쿠팡',
    productId: it.productId,
    isCoupang: true,
    oprice: it.oprice,
    savePct: discountPct(it.lprice, it.oprice)
  }));
  // 캐시로 상품을 채웠으면 오류로 취급하지 않는다 (사용자에겐 정상 결과다).
  const error = items.length && r.from !== 'api' ? null : r.error;
  return { items, error, from: r.from };
}

/** 쿠팡을 조회해 결과를 돌려준다. */
async function searchAll(keyword, { coupangLimit = 6, coupangOpts = {} } = {}) {
  const coupang = await fetchCoupang(keyword, coupangLimit, coupangOpts)
    .catch(e => ({ items: [], error: `쿠팡 예외: ${e.message}` }));

  if (coupang.error) console.error(`[search:${keyword}]`, coupang.error);

  return { items: coupang.items, errors: coupang.error ? [coupang.error] : [] };
}

/**
 * products / price_history 두 테이블에 저장한다.
 * 서버리스에서는 응답 후 함수가 동결되므로 반드시 await로 호출할 것.
 */
async function saveProducts(keyword, items) {
  if (!items || !items.length) return { saved: 0, errors: [] };

  const errors = [];
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();

  // 같은 배치 안에서 키가 겹치면 upsert가 실패하므로 미리 중복을 제거한다.
  const byKey = new Map();
  for (const it of items) {
    const pid = it.productId || it.title;
    if (!pid || !it.title) continue;
    byKey.set(`${pid}|${it.mall}`, { ...it, productId: pid });
  }
  const uniq = [...byKey.values()];
  if (!uniq.length) return { saved: 0, errors: [] };

  const { error: pErr } = await supabase.from('products').upsert(
    uniq.map(it => ({
      product_id: it.productId,
      keyword,
      title: it.title,
      lprice: it.lprice,
      link: it.link || '',
      mall: it.mall,
      image: it.image || '',
      oprice: it.oprice || 0,
      save_pct: it.savePct || 0
    })),
    { onConflict: 'product_id,mall' }
  );
  if (pErr) errors.push(`products: ${pErr.message}`);

  const { error: hErr } = await supabase.from('price_history').upsert(
    uniq.map(it => ({
      product_id: it.productId,
      mall: it.mall,
      title: it.title,
      price: it.lprice,
      link: it.link || '',
      recorded_at: now,
      recorded_date: today
    })),
    { onConflict: 'product_id,mall,recorded_date' }
  );
  if (hErr) errors.push(`price_history: ${hErr.message}`);

  if (errors.length) console.error(`[save:${keyword}]`, errors.join(' | '));
  return { saved: errors.length ? 0 : uniq.length, errors };
}

/**
 * products 테이블 행 → 프론트가 쓰는 상품 모양.
 * rec.js / init.js가 각자 똑같이 풀어 쓰던 것을 한 곳으로 모은 것이라
 * 컬럼이 늘어나도 한 군데만 고치면 된다.
 */
function toClientProduct(p) {
  return {
    title: p.title,
    lprice: p.lprice,
    link: p.link,
    image: p.image,
    mall: p.mall,
    productId: p.product_id,
    isCoupang: p.mall === '쿠팡',
    oprice: p.oprice || 0,
    savePct: p.save_pct || 0
  };
}

/**
 * 키워드별로 번갈아 뽑아 한 키워드가 결과를 독차지하지 않게 한다.
 * (오늘의 셀렉션 / 이달의 추천 / 취향 추천이 모두 같은 규칙을 쓴다)
 */
function roundRobin(rows, keywords, take) {
  const buckets = new Map(keywords.map(k => [k, []]));
  (rows || []).forEach(p => {
    const b = buckets.get(p.keyword);
    if (b) b.push(p);
  });

  const picked = [];
  for (let i = 0; picked.length < take; i++) {
    let added = false;
    for (const k of keywords) {
      const b = buckets.get(k);
      if (b && b[i]) { picked.push(b[i]); added = true; }
      if (picked.length >= take) break;
    }
    if (!added) break;
  }
  return picked;
}

module.exports = {
  TODAY_PICKS, fetchCoupang,
  searchAll, saveProducts, toClientProduct, roundRobin
};
