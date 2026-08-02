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

async function fetchNaver(keyword, display = 8) {
  // 통일 기준: NAVER_CLIENT_ID / NAVER_CLIENT_SECRET (Vercel 환경변수도 이 이름으로 설정 필요)
  // 세팅되어 있어서 어느 쪽 이름이든 받는다.
  const naverId     = process.env.NAVER_CLIENT_ID;
  const naverSecret = process.env.NAVER_CLIENT_SECRET;
  if (!naverId || !naverSecret) {
    return { items: [], error: 'NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수 없음' };
  }
  const url = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(keyword)}&display=${display}&sort=sim`;
  const r = await fetch(url, {
    headers: {
      'X-Naver-Client-Id': naverId,
      'X-Naver-Client-Secret': naverSecret
    }
  });
  if (!r.ok) {
    return { items: [], error: `네이버 API ${r.status}: ${(await r.text()).slice(0, 200)}` };
  }
  const items = ((await r.json()).items || []).map(it => {
    const lprice = parseInt(it.lprice) || 0;
    const oprice = parseInt(it.hprice) || 0;   // 네이버는 최고가를 hprice로 준다
    return {
      title: it.title.replace(/<[^>]*>/g, ''),
      lprice,
      link: it.link || '',
      image: it.image || '',
      mall: it.mallName || '네이버쇼핑',
      productId: String(it.productId || ''),
      isCoupang: false,
      oprice,
      savePct: discountPct(lprice, oprice)
    };
  }).filter(i => i.lprice > 0);
  return { items, error: null };
}

/**
 * 쿠팡 검색.
 *
 * 직접 fetch 하지 않고 _coupang.js를 거친다. 그쪽에 캐시 / 분당 상한 /
 * 차단 감지가 들어 있어서, 여기서 따로 호출하면 전부 우회하게 된다.
 * 실패해도 throw 하지 않고 빈 목록을 준다 (네이버 결과는 그대로 나가야 한다).
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

/** 네이버 + 쿠팡을 동시에 조회해 번갈아 섞은 목록을 돌려준다. */
async function searchAll(keyword, { naverDisplay = 8, coupangLimit = 6, coupangOpts = {} } = {}) {
  const [naver, coupang] = await Promise.all([
    fetchNaver(keyword, naverDisplay).catch(e => ({ items: [], error: `네이버 예외: ${e.message}` })),
    fetchCoupang(keyword, coupangLimit, coupangOpts).catch(e => ({ items: [], error: `쿠팡 예외: ${e.message}` }))
  ]);

  const errors = [naver.error, coupang.error].filter(Boolean);
  if (errors.length) console.error(`[search:${keyword}]`, errors.join(' | '));

  const items = [];
  const mx = Math.max(naver.items.length, coupang.items.length);
  for (let i = 0; i < mx; i++) {
    if (naver.items[i]) items.push(naver.items[i]);
    if (coupang.items[i]) items.push(coupang.items[i]);
  }
  return { items, errors };
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
  TODAY_PICKS, fetchNaver, fetchCoupang,
  searchAll, saveProducts, toClientProduct, roundRobin
};
