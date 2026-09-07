'use strict';
/*
 * /api/radar — 저장한 상품의 «지금 상태».
 *
 * ── 왜 새 서버리스 함수가 아닌가 ───────────────────────────────────
 *
 * Vercel Hobby 는 서버리스 함수 12개가 상한이고 이 저장소는 이미 12개다
 * (api/sync.js 주석 참고 — 그래서 profile 과 sync 도 한 파일에 합쳤다).
 * 파일을 하나 더 만들면 배포가 통째로 실패한다. 그래서 api/history.js 의
 * __route 분기에 얹는다. history.js 는 이미 batch·page·sitemap·product 를
 * 그렇게 나누고 있고, 이 라우트가 쓰는 모듈(_pricestat·_deal)도 그쪽이
 * 이미 들고 있다.
 *
 * ── 계약 ───────────────────────────────────────────────────────────
 *
 *   POST /api/radar
 *   { items: [ { productId, mall, vendorItemId?, title?,
 *                seenPrice?, targetPrice?, seenDecision? } ], limit? }
 *
 *   → { items:[...], summary:{...}, today, truncated }
 *
 * ★ 서버는 아무것도 저장하지 않는다. 목록은 브라우저가 들고 있다가 보낸다.
 *   그래서 로그인하지 않은 사용자도 전 기능을 쓰고, 서버는 «누가» 무엇을
 *   저장했는지 알지 못한다. 로그인한 사용자의 기기 간 동기화는 기존
 *   /api/sync(user_data.wish)가 이미 해 준다 — 여기서 다시 만들지 않는다.
 *
 * ★ 읽기 전용이다. 이 라우트는 어떤 표에도 쓰지 않는다.
 */

const supabase = require('./_supabase');
const { applyCors, noStore, fail } = require('./_http');
const { guard } = require('./_ratelimit');
const { loadStats } = require('./_pricestat');
const { kstToday } = require('./_kst');
const R = require('./_radar');

/** 한 번에 볼 수 있는 저장 상품 수. 이 이상은 잘라서 알려 준다. */
const MAX_ITEMS = 60;
/** in(...) 한 번에 넣을 product_id 개수 (URL 길이 제한 — _pricestat.CHUNK 와 같은 이유). */
const CHUNK = 60;

function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 200); }
function int(v) { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; }

/**
 * 요청 본문에서 저장 목록을 읽는다.
 *
 * GET(쿼리스트링)도 받는다 — 프론트가 링크 하나로 재방문 요약을 열 수 있게.
 * 다만 URL 길이 때문에 실제 목록은 POST 로 온다.
 */
function readItems(req) {
  let raw = null;
  const b = req.body;
  if (b && typeof b === 'object' && Array.isArray(b.items)) raw = b.items;
  else if (typeof b === 'string' && b) {
    try { const p = JSON.parse(b); if (p && Array.isArray(p.items)) raw = p.items; } catch (e) { /* 무시 */ }
  }
  if (!raw && req.query && req.query.items) {
    try { const p = JSON.parse(String(req.query.items)); if (Array.isArray(p)) raw = p; } catch (e) { /* 무시 */ }
  }
  if (!Array.isArray(raw)) return { items: [], truncated: false };

  const out = [];
  const seen = new Set();
  raw.forEach(it => {
    if (!it || typeof it !== 'object') return;
    const productId = str(it.productId, 120);
    if (!productId) return;                       // 식별자 없이는 어떤 기록도 붙일 수 없다
    const mall = str(it.mall, 40);
    const key = `${productId}|${mall}`;
    if (seen.has(key)) return;                    // 같은 상품을 두 번 저장했어도 한 번만 답한다
    seen.add(key);
    out.push({
      productId, mall,
      vendorItemId: str(it.vendorItemId, 120),
      title: str(it.title, 300),
      /* 사용자가 «마지막으로 본» 값. 변화 비교의 기준이 된다. */
      seenPrice: int(it.seenPrice),
      targetPrice: int(it.targetPrice),
      seenDecision: ['BUY', 'WAIT', 'WATCH'].indexOf(str(it.seenDecision, 10)) > -1
        ? str(it.seenDecision, 10) : ''
    });
  });
  return { items: out.slice(0, MAX_ITEMS), truncated: out.length > MAX_ITEMS };
}

/**
 * 현재가·상품 정보를 한 번에 읽는다.
 *
 * ★ 상품마다 한 번씩 부르지 않는다(N+1). product_id 를 청크로 묶어 in(...)
 *   한 번씩만 나간다. 저장 60개면 조회 1회다.
 */
async function loadProducts(items) {
  const byKey = new Map();
  const ids = [...new Set(items.map(i => i.productId))];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await supabase
      .from('products')
      .select('product_id, mall, mall_label, vendor_item_id, title, lprice, image, link, collected_at')
      .in('product_id', ids.slice(i, i + CHUNK));
    if (error) { console.warn(`[radar] products 조회 실패: ${error.message}`); continue; }
    (data || []).forEach(p => {
      /*
       * 같은 product_id 가 몰별로 여러 행일 수 있다. 몰까지 맞는 행을
       * 우선하고, 없으면 product_id 만 맞는 행을 폴백으로 둔다.
       */
      const exact = `${p.product_id}|${p.mall || ''}`;
      if (!byKey.has(exact)) byKey.set(exact, p);
      const any = `${p.product_id}|`;
      if (!byKey.has(any)) byKey.set(any, p);
    });
  }
  return byKey;
}

/**
 * 저장한 상품이 지금 핫딜인가.
 *
 * ★ 표가 없으면(마이그레이션 전) 조용히 빈 Map 을 돌려준다. 핫딜 정보가
 *   없다고 레이더 전체가 죽으면 안 된다.
 */
async function loadHotDeals(items) {
  const map = new Map();
  const ids = [...new Set(items.map(i => i.productId))].filter(Boolean);
  if (!ids.length) return map;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await supabase
      .from('hotdeals')
      .select('id, product_id, mall, deal_status, hot_score, current_price,'
        + ' group_lowest_price, group_lowest_mall, lifecycle')
      .in('product_id', ids.slice(i, i + CHUNK))
      .in('deal_status', ['VERIFIED_HOT', 'GOOD_DEAL'])
      .in('lifecycle', ['NEW', 'ACTIVE', 'COOLING']);
    if (error) {
      if (/does not exist|schema cache|column/i.test(error.message)) return map;
      console.warn(`[radar] hotdeals 조회 실패: ${error.message}`);
      continue;
    }
    (data || []).forEach(h => {
      const k = String(h.product_id);
      const cur = map.get(k);
      // 같은 상품이 여러 건이면 점수가 높은 쪽을 대표로 둔다.
      if (!cur || (h.hot_score || 0) > (cur.hot_score || 0)) map.set(k, h);
    });
  }
  return map;
}

async function radarHandler(req, res) {
  if (!applyCors(req, res, 'public')) return;
  // 개인이 무엇을 저장했는지가 담긴 요청이다. 중간 캐시에 남으면 안 된다.
  noStore(res);
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'GET / POST만 지원' });
  }
  if (!guard(req, res, { name: 'radar', limit: 60, windowMs: 60 * 1000 })) return;

  const { items, truncated } = readItems(req);
  const today = kstToday();
  if (!items.length) {
    return res.json({ items: [], summary: R.summarize([]), today, truncated: false });
  }

  try {
    /* ── 조회는 세 번이 전부다 (상품 · 가격기록 · 핫딜) ── */
    const [products, stats, hot] = await Promise.all([
      loadProducts(items),
      loadStats(items.map(i => ({
        productId: i.productId, mall: i.mall, vendorItemId: i.vendorItemId
      }))),
      loadHotDeals(items)
    ]);

    const out = items.map(it => {
      const p = products.get(`${it.productId}|${it.mall}`) || products.get(`${it.productId}|`) || null;
      const stat = stats.get(`${it.productId}|${it.mall}`) || null;
      const title = it.title || (p && p.title) || '';
      /*
       * 현재가는 카탈로그 값이 먼저다 — 그것이 우리가 마지막으로 «수집한»
       * 값이다. 없으면 기록의 마지막 값으로 물러난다. 둘 다 없으면 0 이고,
       * 그때는 판정도 이벤트도 만들지 않는다(없는 가격을 지어내지 않는다).
       */
      const price = int(p && p.lprice) || int(stat && stat.lastPrice);
      const deal = R.decisionOf(stat, price, today, title);
      const hd = hot.get(it.productId) || null;

      /*
       * 신저가 판정은 통계가 직접 답한다 — lowIsLatest 는 "가장 최근 관측이
       * 곧 최저가" 이고, lowConfirmed 는 "다른 날에도 그 값을 봤다" 이다.
       * 확인되지 않은 하루짜리 최저가를 «신저가» 라고 부르지 않는다.
       */
      const isNewLow = !!(stat && stat.lowIsLatest && stat.lowConfirmed && stat.high > stat.low);

      /* 더 싼 판매처는 핫딜 군집이 이미 계산해 둔 값만 쓴다. 여기서 새로 묶지 않는다. */
      const cheaper = (hd && int(hd.group_lowest_price) > 0 && int(hd.group_lowest_price) < price)
        ? { mall: hd.group_lowest_mall || '', price: int(hd.group_lowest_price) }
        : null;

      const events = price > 0 ? R.changesFor(it, {
        price, decision: deal.decision, isNewLow, cheaper,
        hotDeal: hd ? { id: hd.id } : null
      }) : [];

      return {
        productId: it.productId,
        mall: it.mall || (p && (p.mall_label || p.mall)) || '',
        title,
        image: (p && p.image) || '',
        url: (p && p.link) || '',
        currentPrice: price || null,
        /* 사용자가 마지막으로 본 값 — 프론트가 그대로 되돌려 준 것이다. */
        seenPrice: it.seenPrice || null,
        targetPrice: it.targetPrice || null,
        targetReached: !!(it.targetPrice > 0 && price > 0 && price <= it.targetPrice),
        decision: deal.decision,
        decisionLabel: deal.label,
        verdict: deal.verdict,
        confidence: deal.confidence,
        dataState: deal.dataState,
        reason: deal.reason,
        reasons: deal.reasons,
        cautions: deal.cautions,
        evidence: deal.evidence,
        goodBuyPrice: deal.goodBuyPrice,
        goodBuyExplain: deal.goodBuyExplain,
        unit: deal.unit,
        hotDeal: hd ? { id: hd.id, status: hd.deal_status, score: hd.hot_score } : null,
        lowestPrice: cheaper ? cheaper.price : null,
        lowestMall: cheaper ? cheaper.mall : null,
        lastCheckedAt: (p && p.collected_at) || null,
        events
      };
    });

    return res.json({ items: out, summary: R.summarize(out), today, truncated });
  } catch (e) {
    return fail(res, e, { where: 'radar', route: '/api/radar', message: '저장한 상품을 불러오지 못했어요' });
  }
}

/* ==================================================================
 *  대체 상품 — TASK 7
 *
 *  GET /api/radar?__route=alternatives&pid=..&mall=..&limit=5
 *
 *  ★ 추천 모델을 새로 만들지 않는다. 이 상품이 잡힌 검색어(products.keyword)
 *    로 같은 후보군을 다시 읽고, 순위는 api/_radar.alternativesFor 가
 *    결정론으로 매긴다. 부속 제외·가격대 제한도 그쪽 규칙이다.
 * ================================================================== */

const ALT_POOL = 60;

async function alternativesHandler(req, res) {
  if (!applyCors(req, res, 'public')) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET만 지원' });
  if (!guard(req, res, { name: 'radar-alt', limit: 60, windowMs: 60 * 1000 })) return;

  const q = req.query || {};
  const pid = str(q.pid || q.productId, 120);
  const mall = str(q.mall, 40);
  const limit = Math.max(1, Math.min(10, parseInt(q.limit, 10) || 5));
  if (!pid) return res.status(400).json({ error: '상품 식별자가 없어요' });

  try {
    let base = supabase.from('products')
      .select('product_id, mall, mall_label, title, lprice, image, link, keyword')
      .eq('product_id', pid);
    if (mall) base = base.eq('mall', mall);
    const { data: baseRows, error: baseErr } = await base.limit(1);
    if (baseErr) throw new Error(baseErr.message);
    const b = (baseRows || [])[0];
    if (!b) return res.status(404).json({ error: '상품을 찾을 수 없어요' });
    if (!b.keyword) return res.json({ base: { productId: pid }, items: [] });

    /*
     * 같은 검색어에서 잡힌 상품이 후보다. 카테고리 분류기를 새로 만들지
     * 않는다 — keyword 는 우리가 실제로 그 상품을 발견한 맥락이라
     * 「같은 것을 찾던 사람이 함께 본 상품」 에 가장 가깝다.
     */
    const { data: pool, error: poolErr } = await supabase
      .from('products')
      .select('product_id, mall, mall_label, title, lprice, image, link')
      .eq('keyword', b.keyword)
      .order('collected_at', { ascending: false })
      .limit(ALT_POOL);
    if (poolErr) throw new Error(poolErr.message);

    const items = R.alternativesFor(
      { productId: b.product_id, title: b.title, price: int(b.lprice) },
      (pool || []).map(p => ({
        productId: p.product_id, title: p.title, price: int(p.lprice),
        mall: p.mall_label || p.mall, image: p.image, url: p.link
      })),
      limit
    );

    /* 후보에도 판단 근거를 붙인다 — 값만 나열하면 비교가 되지 않는다. */
    const stats = await loadStats(items.map(i => ({ productId: i.productId, mall: i.mall })));
    const today = kstToday();
    const withDeal = items.map(i => {
      const st = stats.get(`${i.productId}|${i.mall}`) || null;
      const d = R.decisionOf(st, i.price, today, i.title);
      return Object.assign({}, i, {
        decision: d.decision, confidence: d.confidence, dataState: d.dataState,
        reason: d.reason, goodBuyPrice: d.goodBuyPrice, unit: d.unit,
        historyCount: d.evidence.historyCount
      });
    });

    const { cachePublic } = require('./_http');
    cachePublic(res, 300);
    return res.json({
      base: {
        productId: b.product_id, title: b.title, price: int(b.lprice),
        mall: b.mall_label || b.mall, keyword: b.keyword,
        unit: R.unitPriceOf(b.title, int(b.lprice))
      },
      items: withDeal
    });
  } catch (e) {
    return fail(res, e, { where: 'radar-alt', route: '/api/radar?__route=alternatives',
      message: '비슷한 상품을 불러오지 못했어요' });
  }
}

module.exports = { radarHandler, alternativesHandler, MAX_ITEMS, _internal: { readItems } };
