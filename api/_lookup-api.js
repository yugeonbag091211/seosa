'use strict';
/*
 * GET /api/lookup — ④ 브라우저 확장이 부르는 읽기 전용 API.
 *
 * ── 라우팅 ────────────────────────────────────────────────────────
 *
 * 새 서버리스 함수가 아니다 (Vercel Hobby 12/12). vercel.json 이 /api/lookup 을
 * /api/history?__route=lookup 으로 보내고, history.js 첫 줄의 _v2router 가 이
 * 모듈의 handler 로 넘긴다 (docs/seosa2/CONTRACTS.md §1).
 *
 * ── 계약 (CONTRACTS.md §3 ④) ──────────────────────────────────────
 *
 *   쿼리  productId(숫자) · vendorItemId(숫자, 선택) · itemId(숫자, 선택) · mall(기본 쿠팡) · title(≤200)
 *   응답  { ok, match:{ status:'EXACT'|'SIMILAR'|'NONE', productId, mall, title, tier, reasons[] },
 *           points, level, timing|null, anomaly|null,
 *           offers:[{ mall, mallLabel, title, price, url, observedDate, identity:{tier} }], waitroomUrl }
 *
 *   match 에는 계약 필드 외에 vendorItemId · mallLabel · url 을 «덧붙인다» (화면이 SIMILAR 상품을
 *   열 수 있게). 계약 필드는 하나도 바꾸지 않았다.
 *
 * ── 지키는 선 ─────────────────────────────────────────────────────
 *
 * ★ 읽기 전용. 어떤 표에도 쓰지 않는다 (테스트가 state.writes.length === 0 을 고정한다).
 * ★ 외부 쇼핑 API(쿠팡·ADPICK)를 한 번도 부르지 않는다. 이미 쌓인 products·price_history 만 읽는다.
 *   조회 수 상한: 계열 2회(+ SIMILAR 계열 2회) + 제목 검색 ≤ 2회 + 오퍼 후보 1회 + 오퍼 가격 1회.
 * ★ 제목으로 찾은 상품(SIMILAR)의 기록을 이 페이지 상품의 기록(EXACT)으로 내보내지 않는다.
 *   판정 규칙은 api/_lookup.js 머리 주석.
 */

const supabase = require('./_supabase');
const { applyCors, cachePublic, fail } = require('./_http');
const { guard } = require('./_ratelimit');
const { loadSeries, productSummary } = require('./_series');
const { fairness, loadStats } = require('./_pricestat');
const { vendorIdOf } = require('./_price');
const { kstToday } = require('./_kst');
const L = require('./_lookup');

/** CDN 캐시(초). 가격은 하루 몇 번 수집되므로 10분이면 충분히 새롭다. */
const CACHE_SECONDS = 600;
/** 확장 사용자 한 명(IP)이 분당 누를 수 있는 횟수. 사람 손으로는 넘기 어려운 값이다. */
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60 * 1000;

const PRODUCT_COLS = 'product_id, mall, mall_label, vendor_item_id, title, lprice, image, link, keyword, collected_at';

/* ==================================================================
 *  ①·⑥ 모듈 — 없을 수도 있다 (CONTRACTS.md §3-7)
 * ================================================================== */

/*
 * 다른 기능 브랜치가 아직 합쳐지지 않았으면 파일이 없다. 그때는 필드를 null 로 둔다.
 * 파일은 있는데 «그 안에서» 터진 오류(문법 오류 등)는 숨기지 않고 던진다 — 조용히 null 이
 * 되면 ① · ⑥ 이 깨진 것을 아무도 모른다 (_v2router.dispatch 가 모듈 없음과 모듈 안 오류를
 * 가르는 것과 같은 이유).
 *
 * 테스트는 _internal.setOptional 로 가짜 모듈을 끼워 매핑과 오류 처리를 확인한다.
 */
const optional = { timing: undefined, anomaly: undefined };
const OPTIONAL_PATHS = { timing: './_timing', anomaly: './_anomaly' };

function loadOptional(name) {
  if (optional[name] !== undefined) return optional[name];
  try {
    optional[name] = require(OPTIONAL_PATHS[name]);
  } catch (e) {
    if (!e || e.code !== 'MODULE_NOT_FOUND') throw e;
    optional[name] = null;
  }
  return optional[name];
}

/** 모듈이 있으면 부르고, 모양이 맞지 않거나 던지면 null. 조회 전체를 막지 않는다. */
function analyzeTiming(points, ctx) {
  const mod = loadOptional('timing');
  if (!mod || typeof mod.analyze !== 'function') return null;
  try {
    return L.timingOf(mod.analyze(points, { today: ctx.today, horizon: L.TIMING_HORIZON, product: ctx.product }));
  } catch (e) {
    console.warn(`[v2-lookup] timing.analyze 실패(null 로 진행): ${e && e.message}`);
    return null;
  }
}

function analyzeAnomaly(series, ctx) {
  const mod = loadOptional('anomaly');
  if (!mod || typeof mod.analyze !== 'function') return null;
  try {
    return L.anomalyOf(mod.analyze({
      rawRows: series.rawRows, rows: series.rows, points: series.points,
      product: ctx.product, vendorItemId: series.vendorItemId, today: ctx.today
    }));
  } catch (e) {
    console.warn(`[v2-lookup] anomaly.analyze 실패(null 로 진행): ${e && e.message}`);
    return null;
  }
}

/* ==================================================================
 *  조회
 * ================================================================== */

/**
 * 제목으로 비슷한 상품을 찾는다. _lookup.searchPlans 의 계획을 차례로 쓰고, 받아들일 후보가
 * 생기면 멈춘다 (조회 최대 2회, 한 번에 ≤ 40행).
 */
async function findSimilar(title) {
  const plans = L.searchPlans(title);
  const seen = new Map();
  let ranked = { accepted: [], rejected: [] };

  for (const terms of plans) {
    let q = supabase.from('products').select(PRODUCT_COLS).in('mall', L.LIVE_MALLS);
    terms.forEach(t => { q = q.ilike('title', `%${t}%`); });
    const { data, error } = await q.order('collected_at', { ascending: false }).limit(L.SEARCH_LIMIT);
    if (error) throw new Error(`products 제목 검색 실패: ${error.message}`);
    (data || []).forEach(r => { if (r && r.product_id) seen.set(`${r.product_id}|${r.mall}`, r); });
    ranked = L.rankSimilar(title, [...seen.values()]);
    if (ranked.accepted.length) break;
  }
  return { best: ranked.accepted[0] || null, scanned: seen.size, rejected: ranked.rejected };
}

/** 같은 keyword 로 잡힌 카탈로그 행 → 오퍼. keyword 가 없으면 후보군을 만들 단서가 없다. */
async function findOffers(matched, matchedPrice, matchedVid) {
  if (!matched || !matched.keyword || !matched.title) return [];
  const { data, error } = await supabase.from('products')
    .select(PRODUCT_COLS)
    .eq('keyword', matched.keyword)
    .in('mall', L.LIVE_MALLS)
    .order('collected_at', { ascending: false })
    .limit(L.OFFER_POOL);
  if (error) throw new Error(`products 후보 조회 실패: ${error.message}`);
  const pool = data || [];

  const cands = L.offerCandidates(matched, pool);
  // loadStats 는 실패해도 throw 하지 않는다 (빈 Map → 카탈로그 값으로 폴백).
  const stats = cands.length
    ? await loadStats(cands.map(r => ({ productId: r.product_id, mall: r.mall, vendorItemId: vendorIdOf(r) })))
    : new Map();
  return L.buildOffers({ matched, matchedPrice, matchedVid, pool, stats });
}

/**
 * @param {{productId:string, vendorItemId:string, itemId:string, mall:string, title:string}} input
 * @returns {Promise<object>} 응답 본문
 */
async function lookup(input) {
  const today = kstToday();
  let status = 'NONE', tier = null, reasons = [], series = null, matched = null;
  let search = null, optionMismatch = false;

  /* ── 1. EXACT — 쿠팡 상품 번호 ─────────────────────────────── */
  if (input.productId) {
    const s = await loadSeries(
      { productId: input.productId, mall: L.EXACT_MALL, vendorItemId: input.vendorItemId },
      { days: L.SERIES_DAYS });
    if (s.product || s.points.length) {
      status = 'EXACT'; tier = 'A'; series = s; matched = s.product;
      reasons.push('쿠팡 상품 번호(productId)가 같아요 — 제목이 아니라 식별자로 찾았어요.');
      if (!s.product) reasons.push('카탈로그 행은 없고 가격 기록만 남아 있어요.');
      const catalogVid = s.product ? vendorIdOf(s.product) : '';
      if (input.vendorItemId && catalogVid && catalogVid !== input.vendorItemId) {
        /*
         * 같은 상품 페이지의 «다른 옵션» (색상·용량). 카탈로그 제목은 SEOSA 가 추적하는 옵션의
         * 것이라, 그 제목으로 다른 판매처를 찾으면 사용자가 보는 옵션이 아닌 물건이 나온다.
         * 그래서 곡선은 이 옵션의 행만(sameVendorRows), 오퍼는 싣지 않는다.
         */
        optionMismatch = true;
        reasons.push('보고 계신 옵션(vendorItemId)은 SEOSA가 추적하는 옵션과 달라요. 이 옵션의 기록만 보여 드리고, 다른 판매처 비교는 하지 않아요.');
      }
      if (!s.points.length) reasons.push('이 옵션의 가격 기록이 아직 없어요.');
    }
  }

  /* ── 2. SIMILAR — 제목 ─────────────────────────────────────── */
  if (status === 'NONE' && input.title) {
    search = await findSimilar(input.title);
    if (search.best) {
      const row = search.best.row;
      status = 'SIMILAR'; tier = search.best.tier; matched = row;
      reasons = ['이 페이지의 상품이 아니라, 제목으로 찾은 다른 판매처 상품의 기록이에요.']
        .concat(search.best.reasons);
      series = await loadSeries(
        { productId: String(row.product_id), mall: String(row.mall || ''), vendorItemId: vendorIdOf(row) },
        { days: L.SERIES_DAYS });
    }
  }

  /* ── 3. NONE ──────────────────────────────────────────────── */
  if (status === 'NONE') {
    return {
      ok: true,
      match: {
        status, productId: input.productId || null, mall: input.productId ? L.EXACT_MALL : null,
        vendorItemId: input.vendorItemId || null, mallLabel: null,
        title: input.title || null, url: null, tier: null,
        reasons: L.noneReasons(input, search)
      },
      points: [], level: null, timing: null, anomaly: null, offers: [],
      // 카탈로그에 없어도 쿠팡 번호가 있으면 대기실은 «추적 안 됨» 상태로 등록할 수 있다.
      waitroomUrl: process.env.WAITROOM_API_ENABLED === '1' && input.productId ? L.waitroomUrl({
        productId: input.productId, mall: L.EXACT_MALL, vendorItemId: input.vendorItemId, title: input.title
      }) : null
    };
  }

  /* ── 4. 기록 · 판단 ───────────────────────────────────────── */
  const key = {
    productId: status === 'EXACT' ? input.productId : String(matched.product_id),
    mall: status === 'EXACT' ? L.EXACT_MALL : String(matched.mall || ''),
    vendorItemId: series.vendorItemId
  };
  const product = productSummary(key, series);
  const points = series.points;
  const lastPrice = points.length ? points[points.length - 1].price : 0;
  const level = fairness(points, lastPrice, today);
  const ctx = { today, product };
  const timing = analyzeTiming(points, ctx);
  const anomaly = analyzeAnomaly(series, ctx);

  const offers = optionMismatch ? [] : await findOffers(matched, lastPrice, series.vendorItemId);
  // 옵션이 다르면 카탈로그 제목은 다른 옵션의 이름이다 — 페이지 제목을 먼저 쓴다.
  const title = (optionMismatch ? input.title || product.title : product.title || input.title) || null;

  return {
    ok: true,
    match: {
      status, productId: key.productId, mall: key.mall, vendorItemId: key.vendorItemId || null,
      mallLabel: product.mallLabel || key.mall, title, url: L.safeLink(product.url), tier, reasons
    },
    points, level, timing, anomaly, offers,
    // 대기실 등록 API 가 별도 승인으로 열리기 전에는 확장 API 에도 링크를 내보내지 않는다.
    waitroomUrl: process.env.WAITROOM_API_ENABLED === '1'
      ? L.waitroomUrl({ productId: key.productId, mall: key.mall, vendorItemId: key.vendorItemId, title })
      : null
  };
}

/* ==================================================================
 *  핸들러
 * ================================================================== */

async function handler(req, res) {
  if (!applyCors(req, res, 'public')) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ ok: false, error: 'GET 요청만 받아요.', code: 'METHOD_NOT_ALLOWED' });
  }
  if (!guard(req, res, { name: 'v2-lookup', limit: RATE_LIMIT, windowMs: RATE_WINDOW_MS })) return;

  const input = L.readQuery(req.query);
  if (!input.ok) return res.status(400).json({ ok: false, error: input.error, code: 'BAD_INPUT' });

  try {
    const body = await lookup(input);
    cachePublic(res, CACHE_SECONDS);
    return res.status(200).json(body);
  } catch (e) {
    return fail(res, e, { where: 'v2-lookup', route: '/api/lookup', message: '가격 기록을 불러오지 못했어요.' });
  }
}

module.exports = {
  handler, lookup,
  _internal: {
    findSimilar, findOffers, loadOptional,
    /** 테스트 전용 — ①·⑥ 모듈을 가짜로 끼우거나(객체) 없는 것으로(null) 만든다. undefined 는 초기화. */
    setOptional(name, mod) { optional[name] = mod; }
  }
};

