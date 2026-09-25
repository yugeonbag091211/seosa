'use strict';
/*
 * POST /api/investigate — ③ AI 쇼핑 조사관 (docs/seosa2/CONTRACTS.md §3 ③).
 *
 *   { question: "30만원 이하 가벼운 노트북 알아봐 줘", limit?: 1~8 }
 *   질문에 "3개" 처럼 개수가 있으면 그 수만큼 (limit 이 오면 limit 이 우선).
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
 * ── 재검색 (2026-09-24) ─────────────────────────────────────────
 * 찾는 «종류» 가 모자라면 검색어를 바꿔 다시 찾는다. 횟수는 정해져 있다.
 *   본체를 찾을 때   1) 상품명에 기기 이름(노트북·랩탑)   2) 상품명에 제품군(그램·맥북…)
 *                    3) 수집 키워드에 기기 이름 — 상품명은 여전히 역할 판별을 거친다
 *   부속을 찾을 때   1) 상품명에 기기 이름 + 부속 낱말   2) 수집 키워드 + 상품명에 부속 낱말
 *   목록 밖 종류     1) 상품명에 머리 명사              2) 수집 키워드에 머리 명사
 * 충분히 모이면(STOP_AT) 멈춘다. 실시간 검색(승인 필요)은 그래도 모자랄 때 1회뿐이다.
 *
 * ── DB 부하 ─────────────────────────────────────────────────────
 * products 최대 MAX_DB_ATTEMPTS(3)회 × 200행 + price_history 최대 24개 상품 × 90일,
 * 10개씩 묶어 페이지로 읽는다. PostgREST 는 한 번에 1,000행까지만 주므로 range 로 이어 받는다
 * (check-alerts.js 와 같은 이유). 전부 읽기다 — 어떤 표에도 쓰지 않는다.
 */

const supabase = require('./_supabase');
const { applyCors, noStore, readBody, fail } = require('./_http');
const { guard } = require('./_ratelimit');
const { kstToday } = require('./_kst');
const { sameVendorRows } = require('./_price');
const { toDailyPoints } = require('./_series');
const INV = require('./_investigator');

const POOL_LIMIT = 200;
/** products 를 읽는 최대 횟수 (재검색 포함). */
const MAX_DB_ATTEMPTS = 3;
/** 실시간 검색(쿠팡 파트너스 — _shop.searchAll 의 분당 상한·캐시·서킷을 그대로 탄다) 최대 횟수. */
const MAX_LIVE_ATTEMPTS = 1;
/** 한 번에 ilike 로 넣는 낱말 수 상한 (URL 길이 — 30개 × 30자 ≈ 1KB). */
const MAX_TERMS = 30;
const HISTORY_DAYS = 90;
const ID_CHUNK = 10;
const PAGE = 1000;

/** PostgREST or() 에 넣을 수 있게 — 쉼표·괄호·마침표·와일드카드를 없앤다. */
function safeToken(t) { return String(t || '').replace(/[^0-9A-Za-z가-힣]/g, '').slice(0, 30); }

/**
 * ilike 에 넣을 낱말. safeToken 과 같이 PostgREST or() 문법 글자(쉼표·괄호·마침표)를 없애되,
 * 여러 낱말("갤럭시 탭", "캐논 EOS")은 사이를 % 로 이어 붙여 쓰기·띄어쓰기 둘 다 맞게 한다.
 */
function likeTerm(t) {
  return String(t || '').replace(/[^0-9A-Za-z가-힣\s-]/g, '').trim().replace(/\s+/g, '%').slice(0, 30);
}
function uniqTerms(list) {
  return [...new Set((list || []).map(likeTerm).filter(t => t.replace(/%/g, '').length >= 2))].slice(0, MAX_TERMS);
}

/**
 * 한 번의 검색 = products 한 번 읽기.
 * @param {{any:{col:string, terms:string[]}, all?:{col:string, term:string}}} plan
 *   any  이 낱말들 중 하나가 col 에 있다 (or)
 *   all  그리고 이 낱말이 col 에 있다 (ilike)
 */
async function loadPool(plan) {
  const any = plan && plan.any;
  const terms = uniqTerms(any && any.terms);
  if (!terms.length) return [];
  let q = supabase.from('products')
    .select('product_id, mall, mall_label, vendor_item_id, title, lprice, oprice, image, link, keyword, collected_at')
    .or(terms.map(t => `${any.col}.ilike.%${t}%`).join(','));
  if (plan.all) {
    const t = likeTerm(plan.all.term);
    if (t.replace(/%/g, '').length >= 2) q = q.ilike(plan.all.col, `%${t}%`);
  }
  const { data, error } = await q.order('collected_at', { ascending: false }).limit(POOL_LIMIT);
  if (error) throw new Error(`products 조회 실패: ${error.message}`);
  return data || [];
}

/** 찾는 것에 맞춘 검색 순서 (최대 MAX_DB_ATTEMPTS). */
function searchPlans(target) {
  if (!target) return [];
  const P = target.P;
  const nouns = P.generic ? [target.anchorText]
    : [].concat(...P.anchors.filter(a => a.kind === 'noun').map(a => a.db));
  const series = P.generic ? [] : [].concat(...P.anchors.filter(a => a.kind === 'series').map(a => a.db));
  const typed = target.anchorDb && target.anchorDb.length ? target.anchorDb : [target.anchorText];
  let plans;
  if (target.role === 'ACCESSORY') {
    const acc = target.accessory.synonyms.concat([target.accessory.term]);
    plans = [
      { label: `상품명에 «${target.anchorText}» + «${target.accessory.term}»`, where: 'title', any: { col: 'title', terms: acc }, all: { col: 'title', term: target.anchorText } },
      { label: `수집 키워드 «${target.anchorText}» + 상품명 «${target.accessory.term}»`, where: 'keyword', any: { col: 'title', terms: acc }, all: { col: 'keyword', term: target.anchorText } }
    ];
    if (target.anchorKind === 'noun' && series.length) {
      plans.push({ label: `상품명에 제품군(${series.slice(0, 3).join('·')}…) + «${target.accessory.term}»`, where: 'series',
        any: { col: 'title', terms: series }, all: { col: 'title', term: target.accessory.term } });
    }
  } else if (target.anchorKind === 'series') {
    // "맥북" 을 물었으면 맥북만 — 다른 제품군으로 넓히지 않는다.
    plans = [
      { label: `상품명에 «${typed.join('·')}»`, where: 'title', any: { col: 'title', terms: typed } },
      { label: `수집 키워드에 «${typed.join('·')}»`, where: 'keyword', any: { col: 'keyword', terms: typed } }
    ];
  } else {
    plans = [{ label: `상품명에 «${uniqTerms([target.anchorText].concat(nouns)).join('·')}»`, where: 'title', any: { col: 'title', terms: [target.anchorText].concat(nouns) } }];
    if (series.length) plans.push({ label: `상품명에 제품군(${series.slice(0, 3).join('·')}…)`, where: 'series', any: { col: 'title', terms: series } });
    plans.push({ label: `수집 키워드에 «${uniqTerms([target.anchorText].concat(nouns)).join('·')}»`, where: 'keyword', any: { col: 'keyword', terms: [target.anchorText].concat(nouns) } });
  }
  return plans.slice(0, MAX_DB_ATTEMPTS);
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
    const want = Math.max(1, Math.min(INV.MAX_CANDIDATES, Number(body.limit) || parsed.requestedCount || INV.MAX_CANDIDATES));
    // 이만큼 모이면 더 찾지 않는다 — 조건 검증에서 떨어질 몫을 남겨 둔다.
    const stopAt = Math.min(INV.MAX_VERIFY, Math.max(6, want * 3));
    const attempts = [];
    let pool = [];
    let source = 'catalog';
    let result = { keep: [], excluded: [], relevant: 0, accepted: 0 };
    for (const plan of searchPlans(parsed.target)) {
      const rows = await loadPool(plan);
      const before = new Set(pool.map(r => `${r.product_id}|${r.mall || ''}|${r.vendor_item_id || ''}`));
      const fresh = rows.filter(r => !before.has(`${r.product_id}|${r.mall || ''}|${r.vendor_item_id || ''}`));
      pool = pool.concat(fresh);
      result = INV.prefilter(pool, parsed);
      attempts.push({ step: attempts.length + 1, where: plan.where, label: plan.label, rows: rows.length, newRows: fresh.length, accepted: result.accepted });
      if (result.accepted >= stopAt) break;
    }
    let liveSearch = process.env.INVESTIGATOR_LIVE_SEARCH === '1' ? 'unused' : 'off';
    if (liveSearch === 'unused' && result.accepted < want) {
      for (let i = 0; i < MAX_LIVE_ATTEMPTS; i++) {
        const phrase = parsed.target && parsed.target.P
          ? require('./_product-role').searchPhraseOf(parsed.target, { prefix: (parsed.attributes || []).some(a => a.key === 'light') ? ['경량'] : [] })
          : parsed.searchPhrase;
        const live = await livePool(phrase);
        liveSearch = 'used';
        attempts.push({ step: attempts.length + 1, where: 'live', label: `실시간 검색 «${phrase}»`, rows: live ? live.length : 0, newRows: live ? live.length : 0, accepted: null });
        if (live && live.length) {
          source = 'catalog+live';
          pool = pool.concat(live);
          result = INV.prefilter(pool, parsed);
        }
        attempts[attempts.length - 1].accepted = result.accepted;
      }
    }
    const pointsByKey = await loadPoints(result.keep);
    const out = INV.investigate({
      parsed, rows: result.keep, pointsByKey, today, limit: body.limit,
      scanned: result.relevant, excluded: result.excluded, accepted: result.accepted, source,
      coverage: {
        scope: 'SEOSA가 가격을 기록 중인 상품(쿠팡·ADPICK 수집분)',
        attempts, maxDbAttempts: MAX_DB_ATTEMPTS, maxLiveAttempts: MAX_LIVE_ATTEMPTS, liveSearch
      }
    });
    return res.json(Object.assign({ ok: true, asOf: today }, out));
  } catch (e) {
    return fail(res, e, { where: 'v2-investigate', route: '/api/investigate', message: '조사를 마치지 못했어요. 잠시 후 다시 시도해 주세요.' });
  }
}

module.exports = { handler, MAX_DB_ATTEMPTS, MAX_LIVE_ATTEMPTS, _internal: { loadPool, loadPoints, safeToken, likeTerm, searchPlans } };
