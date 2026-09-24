'use strict';
/*
 * POST /api/investigate — ③ AI 쇼핑 조사관 (docs/seosa2/CONTRACTS.md §3 ③).
 *
 *   { question: "30만원 이하 가벼운 노트북 알아봐 줘", limit?: 1~8 }
 *
 * 새 서버리스 함수가 아니다 — api/ai.js 첫 줄의 v2 훅이 이리로 넘긴다 (api/_v2router.js).
 * AI Concierge 와 같은 함수 안에 산다. 판단은 api/_investigator.js 의 순수 함수가 한다.
 *
 * ── 비용 · 외부 호출 ─────────────────────────────────────────────
 * 기본값은 외부 호출 0회다. SEOSA 가 이미 가격을 기록하고 있는 카탈로그(products ·
 * price_history)만 조사한다. LLM 도 부르지 않는다.
 * INVESTIGATOR_LIVE_SEARCH=1 이면 카탈로그에서 못 찾았을 때만 기존 검색 경로
 * (_shop.searchAll — 캐시·분당 상한·서킷 그대로)를 한 번 탄다. 운영에서 켜려면 승인이 필요하다.
 *
 * ── DB 부하 ─────────────────────────────────────────────────────
 * products 1회(최대 200행) + price_history 최대 24개 상품 × 90일, 10개씩 묶어 페이지로 읽는다.
 * PostgREST 는 한 번에 1,000행까지만 주므로 range 로 이어 받는다 (check-alerts.js 와 같은 이유).
 */

const supabase = require('./_supabase');
const { applyCors, noStore, readBody, fail } = require('./_http');
const { guard } = require('./_ratelimit');
const { kstToday } = require('./_kst');
const { sameVendorRows } = require('./_price');
const { toDailyPoints } = require('./_series');
const INV = require('./_investigator');

const POOL_LIMIT = 200;
const HISTORY_DAYS = 90;
const ID_CHUNK = 10;
const PAGE = 1000;

/** PostgREST or() 에 넣을 수 있게 — 쉼표·괄호·마침표·와일드카드를 없앤다. */
function safeToken(t) { return String(t || '').replace(/[^0-9A-Za-z가-힣]/g, '').slice(0, 30); }

async function loadPool(tokens) {
  const toks = tokens.map(safeToken).filter(t => t.length >= 2);
  if (!toks.length) return [];
  const ors = [];
  toks.forEach(t => { ors.push(`title.ilike.%${t}%`); ors.push(`keyword.ilike.%${t}%`); });
  const { data, error } = await supabase.from('products')
    .select('product_id, mall, mall_label, vendor_item_id, title, lprice, oprice, image, link, keyword, collected_at')
    .or(ors.join(','))
    .order('collected_at', { ascending: false })
    .limit(POOL_LIMIT);
  if (error) throw new Error(`products 조회 실패: ${error.message}`);
  return data || [];
}

/** 후보들의 일별 곡선 — key `${pid}|${mall}|${vid}` → [{date, price}] */
async function loadPoints(rows) {
  const cutoff = kstToday(new Date(Date.now() - HISTORY_DAYS * 86400000));
  const ids = [...new Set(rows.map(r => r.product_id))];
  const byPm = new Map();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase.from('price_history')
        .select('id, product_id, mall, vendor_item_id, price, recorded_date, recorded_at')
        .in('product_id', chunk)
        .gte('recorded_date', cutoff)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`price_history 조회 실패: ${error.message}`);
      (data || []).forEach(r => {
        const k = `${r.product_id}|${r.mall || ''}`;
        if (!byPm.has(k)) byPm.set(k, []);
        byPm.get(k).push(r);
      });
      if (!data || data.length < PAGE) break;
    }
  }
  const out = new Map();
  rows.forEach(r => {
    const all = byPm.get(`${r.product_id}|${r.mall || ''}`) || [];
    out.set(`${r.product_id}|${r.mall || ''}|${r.vendor_item_id || ''}`, toDailyPoints(sameVendorRows(all, r.vendor_item_id)));
  });
  return out;
}

/** 승인 후에만 켜는 실시간 검색 — 기존 _shop.searchAll 경로 그대로 (저장하지 않는다). */
async function livePool(phrase) {
  if (process.env.INVESTIGATOR_LIVE_SEARCH !== '1' || !phrase) return null;
  try {
    const { searchAll } = require('./_shop');
    const r = await searchAll(phrase, { coupangLimit: 10, coupangOpts: { source: 'investigator', maxWaitMs: 1200 } });
    return ((r && r.items) || []).map(it => ({
      product_id: String(it.productId || ''), mall: it.mall || '', mall_label: it.mall || '',
      vendor_item_id: String(it.vendorItemId || ''), title: it.title, lprice: it.price, image: it.image,
      link: it.link, keyword: phrase, collected_at: new Date().toISOString()
    })).filter(r => r.product_id);
  } catch (e) {
    console.warn(`[investigate] 실시간 검색 실패(카탈로그 결과만 사용): ${e.message}`);
    return null;
  }
}

async function handler(req, res) {
  if (!applyCors(req, res, 'private')) return;
  noStore(res);
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST만 지원해요', code: 'METHOD' });
  if (!guard(req, res, { name: 'v2-investigate', limit: 20, windowMs: 60 * 1000 })) return;

  const body = readBody(req);
  const parsed = INV.parseQuestion(body.question);
  if (!parsed) return res.status(400).json({ ok: false, error: '무엇을 찾을지 알려 주세요 (예: 30만원 이하 가벼운 노트북)', code: 'BAD_INPUT' });
  if (!parsed.searchTokens.length) {
    return res.status(400).json({ ok: false, error: '어떤 상품을 찾는지 알 수 없어요. 상품 종류를 함께 적어 주세요.', code: 'BAD_INPUT', query: { raw: parsed.raw } });
  }

  try {
    const today = kstToday();
    let pool = await loadPool(parsed.searchTokens);
    let source = 'catalog';
    let { keep, excluded, relevant } = INV.prefilter(pool, parsed);
    if (!keep.length) {
      const live = await livePool(parsed.searchPhrase);
      if (live && live.length) {
        source = 'catalog+live';
        pool = pool.concat(live);
        ({ keep, excluded, relevant } = INV.prefilter(pool, parsed));
      }
    }
    const pointsByKey = await loadPoints(keep);
    const result = INV.investigate({
      parsed, rows: keep, pointsByKey, today, limit: body.limit,
      scanned: relevant, excluded, source
    });
    return res.json(Object.assign({ ok: true, asOf: today }, result));
  } catch (e) {
    return fail(res, e, { where: 'v2-investigate', route: '/api/investigate', message: '조사를 마치지 못했어요. 잠시 후 다시 시도해 주세요.' });
  }
}

module.exports = { handler, _internal: { loadPool, loadPoints, safeToken } };
