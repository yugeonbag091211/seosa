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

/* ------------------------------------------------------------------ *
 *  검색어–상품 관련도
 *
 *  쿠팡 검색 API가 검색어와 전혀 상관없는 상품을 돌려주는 일이 있다.
 *  실제로 "수영복"으로 받아온 6건이 선스틱·생새우살·복숭아·돈까스·펩시·연어였고,
 *  그게 그대로 products 에 keyword='수영복' 으로 저장돼 홈 "오늘의 셀렉션 · 수영복"에
 *  펩시가 떴다. 저장 단계와 노출 단계 양쪽에서 걸러야 한다.
 * ------------------------------------------------------------------ */

/** 검색어 → 비교에 쓸 토큰. 한 글자는 아무 데나 걸리므로 뺀다. */
function keywordTokens(keyword) {
  return String(keyword || '')
    .toLowerCase().replace(/[^0-9a-z가-힣\s]/g, ' ')
    .split(/\s+/).filter(t => t.length >= 2);
}

/**
 * 상품명이 검색어와 관련 있어 보이는가.
 *
 * 한국어 상품명은 띄어쓰기가 제각각이라("무선 이어폰" vs "무선이어폰")
 * 공백을 지우고 부분 문자열로 본다. 토큰 하나만 걸려도 통과시킨다 —
 * "무선 이어폰" 검색에 "이어폰 케이스"가 나오는 건 정상이기 때문이다.
 */
function matchesKeyword(tokens, title) {
  if (!tokens.length) return true;   // 판단 근거가 없으면 통과
  const flat = String(title || '').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
  return tokens.some(t => flat.indexOf(t) > -1);
}

/**
 * 검색어와 관련 있는 항목만 남긴다.
 *
 * 규칙은 하나다: 하나라도 맞는 게 있으면 맞는 것만 남기고, 하나도 없으면 전부 버린다.
 *
 *   - 일부만 맞는 경우 → 안 맞는 건 버린다. 정확도를 재현율보다 우선한다.
 *     최저가 비교 서비스에서 "수영복"에 연어가 섞이는 쪽이 몇 건 덜 보이는 것보다 나쁘다.
 *   - 하나도 안 맞는 경우 → 응답 자체가 이상한 것이다. 저장하지도, 보여주지도 않는다.
 *
 * @returns {{kept: Array, dropped: number, allMismatch: boolean}}
 */
function relevantItems(keyword, items) {
  const list = items || [];
  const tokens = keywordTokens(keyword);
  if (!tokens.length || !list.length) return { kept: list, dropped: 0, allMismatch: false };

  const kept = list.filter(it => matchesKeyword(tokens, it && it.title));
  if (!kept.length) return { kept: [], dropped: list.length, allMismatch: true };
  return { kept, dropped: list.length - kept.length, allMismatch: false };
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
  // 검색어와 무관한 상품은 여기서 끊는다. 통과시키면 그대로 products 에 저장되고
  // 홈 섹션에까지 올라간다 (로그에는 성공으로만 남는다).
  const rel = relevantItems(keyword, items);
  if (rel.allMismatch) {
    console.warn(
      `[search:${keyword}] 검색어와 일치하는 상품 0/${items.length}건 — 응답을 버립니다`
      + ` (예: ${String(items[0].title).slice(0, 40)})`
    );
  } else if (rel.dropped) {
    console.log(`[search:${keyword}] 무관한 상품 ${rel.dropped}건 제외 (${rel.kept.length}건 유지)`);
  }

  // 캐시로 상품을 채웠으면 오류로 취급하지 않는다 (사용자에겐 정상 결과다).
  const error = items.length && r.from !== 'api' ? null : r.error;
  return {
    items: rel.kept,
    error,
    from: r.from,
    blocked: !!r.blocked,
    // 상품은 받았는데 전부 검색어와 무관했다 — "결과 없음"과 구분해서 알려야 한다.
    mismatch: rel.allMismatch
  };
}

/**
 * 쿠팡을 조회해 결과를 돌려준다.
 *
 * from / blocked 를 같이 돌려주는 이유: 호출부(=/api/search)가 이 값을 응답 헤더로
 * 내보내야 프론트가 "지금 보는 가격이 방금 받아온 값인지, 캐시인지"를 구분해서
 * 사용자에게 알릴 수 있다. 차단 중에 옛 가격을 아무 말 없이 현재가처럼 보여주면
 * 사용자는 클릭해서야 다른 가격을 보게 된다.
 */
async function searchAll(keyword, { coupangLimit = 6, coupangOpts = {} } = {}) {
  const coupang = await fetchCoupang(keyword, coupangLimit, coupangOpts)
    .catch(e => ({ items: [], error: `쿠팡 예외: ${e.message}`, from: 'none', blocked: false }));

  if (coupang.error) console.error(`[search:${keyword}]`, coupang.error);

  return {
    items: coupang.items,
    errors: coupang.error ? [coupang.error] : [],
    from: coupang.from || 'none',
    blocked: !!coupang.blocked,
    mismatch: !!coupang.mismatch
  };
}

/**
 * 이 응답을 "오늘 관측한 가격"으로 기록해도 되는가.
 *
 *   api         — 방금 받아왔다. 기록한다.
 *   cache       — 6시간 이내에 받아둔 값이다. 하루 한 번 스냅샷에는 충분하다.
 *   stale-cache — 쿠팡을 못 불러서 꺼낸 옛날 값이다. 기록하면 안 된다.
 *   none        — 데이터가 없다.
 *
 * stale-cache 를 기록하면 "오늘 이 가격이었다"는 거짓 기록이 남는다.
 * 차트에는 값이 변하지 않은 평평한 선으로 보이는데, 실제로는 확인조차 못 한
 * 날이다. 그 위에서 역대 최저가·30일 평균·알림 판정이 전부 굴러간다.
 */
function isRecordableSource(from) {
  return from === 'api' || from === 'cache';
}

/**
 * products / price_history 두 테이블에 저장한다.
 * 서버리스에서는 응답 후 함수가 동결되므로 반드시 await로 호출할 것.
 *
 * @param {object} opts
 *   from — 이 상품들이 어디서 왔는지. stale-cache/none 이면 저장하지 않는다.
 *          (예전에는 출처를 몰라서, 쿠팡이 차단된 동안 옛 캐시 값이 매일
 *           "오늘 가격"으로 쌓이고 있었다)
 */
async function saveProducts(keyword, items, opts = {}) {
  const from = opts.from || 'api';   // 출처를 안 넘기는 옛 호출부는 기존대로 동작
  if (!isRecordableSource(from)) {
    console.warn(`[save:${keyword}] 출처가 '${from}' 이라 저장하지 않습니다 (오늘 관측한 가격이 아님)`);
    return { saved: 0, errors: [], skipped: true };
  }

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
    savePct: p.save_pct || 0,
    // 이 가격을 언제 받아온 값인지. DB에서 읽는 섹션(오늘의 셀렉션·이달의 추천·
    // 취향 추천)은 실시간 검색이 아니라 마지막 수집분을 보여주는 것이라,
    // 오래된 값이면 프론트가 "N월 N일 기준"이라고 밝힐 수 있어야 한다.
    collectedAt: p.collected_at || ''
  };
}

/**
 * 홈 섹션에 올릴 순서.
 *
 * 1) 쿠팡 행을 먼저 — 네이버 연동을 걷어낸 뒤로 다른 몰 행은 새로 수집되지 않아서
 *    가격이 며칠씩 묵어 있다. 그대로 '최저가 구매'를 걸면 사용자가 눌러서 보는
 *    가격과 다르고, 파트너스 수수료도 발생하지 않는다.
 * 2) 같은 몰끼리는 최근 수집분 먼저.
 *
 * 행을 버리지는 않는다. 쿠팡 행이 모자라면 나머지가 그대로 뒤를 채운다.
 */
/**
 * products 행 중 자기 keyword 와 관련 있는 것만 남긴다.
 *
 * 저장 단계 필터는 앞으로 들어올 데이터에만 듣는다. 이미 저장된 오염분
 * (예: keyword='수영복' 인데 제목이 "펩시 제로슈거")은 노출 단계에서 걸러야
 * 홈 화면이 지금 당장 정상으로 보인다. 행을 지우지는 않는다.
 */
function relevantRows(rows) {
  const out = [];
  let dropped = 0;
  (rows || []).forEach(r => {
    if (!r) return;
    if (matchesKeyword(keywordTokens(r.keyword), r.title)) out.push(r);
    else dropped++;
  });
  if (dropped) console.log(`[rec] keyword 와 무관한 저장분 ${dropped}행 노출 제외`);
  return out;
}

function preferLive(rows) {
  return (rows || []).slice().sort((a, b) => {
    const ac = a.mall === '쿠팡' ? 0 : 1;
    const bc = b.mall === '쿠팡' ? 0 : 1;
    if (ac !== bc) return ac - bc;
    return String(b.collected_at || '').localeCompare(String(a.collected_at || ''));
  });
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
  searchAll, saveProducts, toClientProduct, roundRobin, preferLive,
  relevantItems, relevantRows, matchesKeyword, keywordTokens, isRecordableSource
};
