const crypto = require('crypto');
const supabase = require('./_supabase');

const TODAY_PICKS = ['수영복', '물놀이 용품', '아이스크림', '방수팩', '차량용 햇빛 가리개', '여행용 캐리어', '서큘레이터', '쿨토시'];

function coupangAuth(method, path, query, accessKey, secretKey) {
  const date = new Date();
  const ts = date.getUTCFullYear().toString().slice(-2)
    + String(date.getUTCMonth() + 1).padStart(2, '0')
    + String(date.getUTCDate()).padStart(2, '0')
    + 'T'
    + String(date.getUTCHours()).padStart(2, '0')
    + String(date.getUTCMinutes()).padStart(2, '0')
    + String(date.getUTCSeconds()).padStart(2, '0')
    + 'Z';
  const sig = crypto.createHmac('sha256', secretKey).update(ts + method + path + query).digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${ts}, signature=${sig}`;
}

async function fetchNaver(keyword, display = 8) {
  // Vercel은 NAVER_ID/NAVER_SECRET, GitHub Actions는 NAVER_CLIENT_ID/NAVER_CLIENT_SECRET로
  // 세팅되어 있어서 어느 쪽 이름이든 받는다.
  const naverId     = process.env.NAVER_CLIENT_ID     || process.env.NAVER_ID;
  const naverSecret = process.env.NAVER_CLIENT_SECRET || process.env.NAVER_SECRET;
  if (!naverId || !naverSecret) {
    return { items: [], error: 'NAVER_CLIENT_ID / NAVER_CLIENT_SECRET (또는 NAVER_ID / NAVER_SECRET) 환경변수 없음' };
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
  const items = ((await r.json()).items || []).map(it => ({
    title: it.title.replace(/<[^>]*>/g, ''),
    lprice: parseInt(it.lprice) || 0,
    link: it.link || '',
    image: it.image || '',
    mall: it.mallName || '네이버쇼핑',
    productId: String(it.productId || ''),
    isCoupang: false,
    oprice: parseInt(it.hprice) || 0,
    savePct: 0
  })).filter(i => i.lprice > 0);
  return { items, error: null };
}

async function fetchCoupang(keyword, limit = 6) {
  if (!process.env.COUPANG_ACCESS_KEY || !process.env.COUPANG_SECRET_KEY) {
    return { items: [], error: 'COUPANG_ACCESS_KEY / COUPANG_SECRET_KEY 환경변수 없음' };
  }
  const path = '/v2/providers/affiliate_open_api/apis/openapi/products/search';
  const query = `keyword=${encodeURIComponent(keyword)}&limit=${limit}`;
  const r = await fetch(`https://api-gateway.coupang.com${path}?${query}`, {
    headers: {
      Authorization: coupangAuth('GET', path, query, process.env.COUPANG_ACCESS_KEY, process.env.COUPANG_SECRET_KEY)
    }
  });
  if (!r.ok) {
    return { items: [], error: `쿠팡 API ${r.status}: ${(await r.text()).slice(0, 200)}` };
  }
  const data = await r.json();
  const items = ((data.data && data.data.productData) || []).map(it => ({
    title: it.productName || '',
    lprice: parseInt(it.discountPrice || it.productPrice) || 0,
    link: it.productUrl || '',
    image: it.productImage || '',
    mall: '쿠팡',
    productId: String(it.productId || ''),
    isCoupang: true,
    oprice: parseInt(it.productPrice) || 0,
    savePct: 0
  })).filter(i => i.lprice > 0);
  return { items, error: null };
}

/** 네이버 + 쿠팡을 동시에 조회해 번갈아 섞은 목록을 돌려준다. */
async function searchAll(keyword, { naverDisplay = 8, coupangLimit = 6 } = {}) {
  const [naver, coupang] = await Promise.all([
    fetchNaver(keyword, naverDisplay).catch(e => ({ items: [], error: `네이버 예외: ${e.message}` })),
    fetchCoupang(keyword, coupangLimit).catch(e => ({ items: [], error: `쿠팡 예외: ${e.message}` }))
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
      image: it.image || ''
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

module.exports = { TODAY_PICKS, coupangAuth, fetchNaver, fetchCoupang, searchAll, saveProducts };
