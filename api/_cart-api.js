'use strict';
/*
 * POST /api/cart — ⑤ 장바구니 최저가 (CONTRACTS.md §3 ⑤).
 *
 * ── 왜 새 서버리스 함수가 아닌가 ───────────────────────────────────
 *
 * Vercel Hobby 함수 12개 상한 때문에 api/history.js 의 __route 분기에 얹는다
 * (api/_v2router.js 표: cart → ./_cart-api, 호스트 history, POST, public CORS).
 * 이 파일은 «읽기» 만 한다. 계산은 전부 순수 모듈 api/_cart.js 에 있다 —
 * DB 없이 테스트할 수 있어야 최적화가 정말 최저가인지 완전 탐색과 대조할 수 있다.
 *
 * ── 조회 횟수 (상품 N개, N ≤ 20) ──────────────────────────────────
 *
 *   products  상품 번호로          1회 (in, 60개씩 청크 — 20개면 1회)
 *   products  상품명으로           상품명만 준 상품마다 최대 2회 (단서 2개 → 못 찾으면 1개)
 *   products  같은 검색어 후보군    서로 다른 검색어마다 1회 (최대 N회, 병렬)
 *   price_history (loadStats)     받아들인 오퍼 60개씩 청크
 *
 *   상품마다 따로 도는 조회는 «상수 번» 을 넘지 않는다. 후보 하나하나에 조회를
 *   내지 않는다(N+1 없음).
 *
 * ★ 어떤 표에도 쓰지 않는다. 외부 쇼핑 API 를 부르지 않는다 — 이미 쌓인
 *   products · price_history 만 읽는다 (CONTRACTS.md §0).
 * ★ 장바구니는 개인 정보다. 응답을 중간 캐시에 남기지 않는다(no-store).
 */

const supabase = require('./_supabase');
const { applyCors, noStore, readBody, tooLarge, fail } = require('./_http');
const { guard } = require('./_ratelimit');
const { loadStats } = require('./_pricestat');
const { kstToday } = require('./_kst');
const C = require('./_cart');

/** 후보 판정에 필요한 열만. link 는 기존 제휴 링크 그대로 내보낸다. */
const COLS = 'product_id, mall, mall_label, vendor_item_id, title, lprice, link, keyword, collected_at';
/** in(...) 한 번에 넣을 개수 — URL 길이 제한 (_pricestat.CHUNK 와 같은 이유). */
const CHUNK = 60;
/** 같은 검색어 후보군 크기. _radarapi 대체 상품(ALT_POOL)과 같은 값 — 최근 수집순 60개. */
const POOL_LIMIT = 60;
/** 상품명 검색 결과 상한. */
const TITLE_LIMIT = 60;

function badInput(res, error) {
  return res.status(400).json({ ok: false, error, code: 'BAD_INPUT' });
}

async function loadByIds(ids) {
  const byId = new Map();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await supabase.from('products').select(COLS).in('product_id', ids.slice(i, i + CHUNK));
    if (error) throw new Error(`products 조회 실패: ${error.message}`);
    (data || []).forEach(r => {
      const k = String(r.product_id);
      if (!byId.has(k)) byId.set(k, []);
      byId.get(k).push(r);
    });
  }
  return byId;
}

/**
 * 상품명 → 후보 행. 단서 두 개를 AND 로 먼저 찾고, 없으면 첫 단서 하나로 한 번 더.
 * 여기서 고른 행을 곧바로 쓰지 않는다 — _cart.resolveBase 가 tier A 만 받아들인다.
 */
async function searchByTitle(title) {
  const tokens = C.titleSearchTokens(title);
  if (!tokens.length) return [];
  const run = async toks => {
    let q = supabase.from('products').select(COLS);
    toks.forEach(t => { q = q.ilike('title', `%${t}%`); });
    const { data, error } = await q.order('collected_at', { ascending: false }).limit(TITLE_LIMIT);
    if (error) throw new Error(`products 상품명 조회 실패: ${error.message}`);
    return data || [];
  };
  const rows = await run(tokens);
  if (rows.length || tokens.length < 2) return rows;
  return run(tokens.slice(0, 1));
}

async function loadPools(keywords) {
  const pools = new Map();
  await Promise.all(keywords.map(async kw => {
    const { data, error } = await supabase.from('products').select(COLS)
      .eq('keyword', kw)
      .order('collected_at', { ascending: false })
      .limit(POOL_LIMIT);
    if (error) throw new Error(`products 후보군 조회 실패: ${error.message}`);
    pools.set(kw, data || []);
  }));
  return pools;
}

async function handler(req, res) {
  if (!applyCors(req, res, 'public')) return;
  // 무엇을 사려는지가 담긴 요청이다. CDN·브라우저 캐시에 남기지 않는다.
  noStore(res);
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST 로만 계산할 수 있어요.', code: 'METHOD_NOT_ALLOWED' });
  }
  if (!guard(req, res, { name: 'v2-cart', limit: 30, windowMs: 60 * 1000 })) return;

  if (typeof req.body === 'string' && Buffer.byteLength(req.body, 'utf8') > C.MAX_BODY_BYTES) {
    return badInput(res, '장바구니 정보가 너무 커요 (32KB 이하).');
  }
  const body = readBody(req);
  if (tooLarge(body, C.MAX_BODY_BYTES)) return badInput(res, '장바구니 정보가 너무 커요 (32KB 이하).');
  const v = C.validateCart(body);
  if (!v.ok) return badInput(res, v.error);
  const { items, shipping, coupons } = v.value;

  try {
    const today = kstToday();

    /* ── 1. 기준 행: 상품 번호 → (없으면) 상품명 ── */
    const ids = [...new Set(items.map(it => it.productId).filter(Boolean))];
    const byId = ids.length ? await loadByIds(ids) : new Map();
    const titleRows = await Promise.all(items.map(it => {
      const needs = it.title && (!it.productId || !(byId.get(it.productId) || [])
        .some(r => !it.mall || String(r.mall || '') === it.mall));
      return needs ? searchByTitle(it.title) : Promise.resolve([]);
    }));
    const resolutions = items.map((it, i) =>
      C.resolveBase(it, it.productId ? (byId.get(it.productId) || []) : [], titleRows[i]));

    /* ── 2. 같은 검색어 후보군 → 동일상품 판정 ── */
    const keywords = [...new Set(resolutions
      .map(r => (r.base && r.base.row.keyword ? String(r.base.row.keyword) : ''))
      .filter(Boolean))];
    const pools = keywords.length ? await loadPools(keywords) : new Map();
    const screens = resolutions.map((r, i) => (r.base
      ? C.screenPool(r, items[i], (pools.get(String(r.base.row.keyword || '')) || []).concat(r.extraPool || []))
      : null));

    /* ── 3. 가격 확인: 받아들인 오퍼만 price_history 에서 ── */
    const stats = await loadStats(C.statKeys(screens));

    return res.status(200).json(C.assemble({ items, resolutions, screens, stats, shipping, coupons, today }));
  } catch (e) {
    return fail(res, e, { where: 'v2-cart', route: '/api/cart', message: '장바구니를 계산하지 못했어요.' });
  }
}

module.exports = { handler, _internal: { searchByTitle, loadPools, loadByIds } };
