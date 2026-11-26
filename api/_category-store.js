'use strict';
/*
 * 상품 카테고리 GPT 분류 결과를 product_id 당 캐싱한다.
 * api/_product-kind-store.js 와 완전히 같은 구조 — "언제 묻고 언제 DB에서
 * 꺼내 쓸까"를 분리한 것도 똑같은 이유다(검색 때마다 GPT를 부르면 느려진다).
 *
 *   · lookupCategories — 손님이 검색할 때 쓴다. DB에 이미 저장된 값만
 *     읽어온다. GPT는 절대 안 부른다 — 그래서 빠르다(수십 ms 수준).
 *   · syncCategories — 손님과 상관없이 따로 도는 배치 작업
 *     (scripts/classify-product-categories-batch.js)이 쓴다.
 *
 * 실패 처리도 동일하다: DB 읽기/쓰기가 실패해도(컬럼이 아직 없는 환경 포함)
 * 예외를 던지지 않는다. 그런 경우 이번 회차는 전부 "모른다" 취급 — 카테고리
 * 안전망(api/_search-category-guard.js)은 적용되지 않을 뿐, 검색 자체는
 * 기존 글자 매칭 그대로 동작한다.
 */

const DEFAULT_TIME_BUDGET_MS = 4000;
const DEFAULT_LOOKUP_BUDGET_MS = 1200;

function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 손님 검색 경로 전용 — DB에 이미 저장된 분류만 읽는다. GPT는 절대 호출하지
 * 않으므로 느려질 일이 없다(읽기 1번, 수십 ms).
 *
 * @param {Array<string>} productIds
 * @param {object} [opts]
 * @param {object} [opts.supabase]
 * @param {number} [opts.timeBudgetMs]
 * @returns {Promise<Map<string,string>>} productId -> category (또는 'unknown')
 */
async function lookupCategories(productIds, opts = {}) {
  const ids = [...new Set(
    (Array.isArray(productIds) ? productIds : [])
      .map(id => (id == null ? '' : String(id)))
      .filter(Boolean)
  )];
  const out = new Map();
  if (!ids.length) return out;

  const supabase = opts.supabase || require('./_supabase');
  const timeBudgetMs = Math.max(200, Number(opts.timeBudgetMs) || DEFAULT_LOOKUP_BUDGET_MS);

  const work = (async () => {
    try {
      const { data, error } = await supabase
        .from('products')
        .select('product_id, category')
        .in('product_id', ids);
      if (error) throw new Error(error.message || String(error));
      const rows = Array.isArray(data) ? data : [];
      for (const row of rows) {
        if (row && row.category) out.set(String(row.product_id), row.category);
      }
    } catch (e) {
      console.warn(`[category] 캐시 조회 실패(이번 회차는 생략): ${e.message}`);
    }
    return out;
  })();

  return withTimeout(work, timeBudgetMs, out);
}

/**
 * 배치 작업 전용(scripts/classify-product-categories-batch.js) — 모르는
 * 상품을 GPT에게 물어보고 DB에 저장까지 한다.
 *
 * @param {Array<{productId:string, title:string}>} items
 * @param {object} [opts]
 * @param {object}   [opts.supabase]
 * @param {Function} [opts.classify]  주입 가능 — 기본은 _category-classifier.classifyBatch.
 * @param {number}   [opts.timeBudgetMs]
 * @returns {Promise<Map<string,string>>}
 */
async function syncCategories(items, opts = {}) {
  const list = Array.isArray(items) ? items.filter(it => it && it.productId && it.title) : [];
  const out = new Map();
  if (!list.length) return out;

  const supabase = opts.supabase || require('./_supabase');
  const classify = opts.classify || require('./_category-classifier').classifyBatch;
  const timeBudgetMs = Math.max(500, Number(opts.timeBudgetMs) || DEFAULT_TIME_BUDGET_MS);
  const deadline = Date.now() + timeBudgetMs;

  const work = (async () => {
    const ids = [...new Set(list.map(it => String(it.productId)))];

    let cached = [];
    try {
      const { data, error } = await supabase
        .from('products')
        .select('product_id, category')
        .in('product_id', ids);
      if (error) throw new Error(error.message || String(error));
      cached = Array.isArray(data) ? data : [];
    } catch (e) {
      console.warn(`[category] 기존 분류 조회 실패(이번 회차는 분류 생략): ${e.message}`);
      return out;
    }

    const known = new Map();
    for (const row of cached) {
      if (row && row.category) known.set(String(row.product_id), row.category);
    }
    for (const [pid, cat] of known) out.set(pid, cat);

    const seen = new Set();
    const missing = [];
    for (const it of list) {
      const pid = String(it.productId);
      if (known.has(pid) || seen.has(pid)) continue;
      seen.add(pid);
      missing.push({ productId: pid, title: it.title });
    }
    if (!missing.length) return out;

    const remaining = deadline - Date.now();
    if (remaining < 200) return out;

    let cats;
    try {
      cats = await classify(missing.map(m => m.title), { budgetMs: remaining - 100 });
    } catch (e) {
      console.warn(`[category] 분류 호출 실패(이번 회차는 생략): ${e.message}`);
      return out;
    }
    if (!Array.isArray(cats) || cats.length !== missing.length) return out;

    // null 은 "답을 못 받았다" — 맵에도 안 넣고 DB에도 안 쓴다(재시도 대상).
    // api/_product-kind-store.js 의 2026-11-25 교훈과 같은 원칙.
    const writes = [];
    missing.forEach((m, i) => {
      const cat = cats[i];
      if (cat == null) return;
      out.set(m.productId, cat);
      writes.push({ productId: m.productId, category: cat });
    });
    if (!writes.length) return out;

    try {
      await Promise.all(writes.map(w => supabase
        .from('products')
        .update({ category: w.category })
        .eq('product_id', w.productId)));
    } catch (e) {
      console.warn(`[category] 분류 결과 저장 실패(다음에 재시도됨): ${e.message}`);
    }

    return out;
  })();

  return withTimeout(work, timeBudgetMs, out);
}

module.exports = {
  lookupCategories,
  syncCategories,
  DEFAULT_TIME_BUDGET_MS,
  DEFAULT_LOOKUP_BUDGET_MS
};
