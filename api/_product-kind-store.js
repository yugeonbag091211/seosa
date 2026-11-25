'use strict';
/*
 * "본품 vs 부속" GPT 1회 분류 결과를 product_id 당 캐싱한다.
 *
 * api/_product-kind-classifier.js 가 "어떻게 물어볼까" 라면, 이 파일은
 * "언제 묻고 언제 DB에서 꺼내 쓸까" 다.
 *
 *   1) 이번 검색에 나온 상품 중, 이미 물어본 적 있는 건 DB(products.product_kind)
 *      에서 그대로 읽어 쓴다 — 다시 묻지 않는다.
 *   2) 처음 보는 상품만 모아서 한 번에 묻는다(_product-kind-classifier.classifyBatch).
 *   3) 그 결과를 DB에 저장해 다음부터는 1)번 경로를 타게 한다.
 *
 * ── 시간 제한 ────────────────────────────────────────────────────
 * GPT 호출은 느릴 수 있다. 검색 응답이 그걸 기다리다 느려지면 본말전도다.
 * timeBudgetMs 안에 못 끝내면 그 회차는 그냥 분류 없이 넘어간다(기존 제목
 * 기반 가드만 적용됨) — 다음 검색에서 다시 시도된다. 이 모듈 때문에 검색이
 * 느려지거나 실패하는 일은 없다.
 *
 * ── 실패 처리 ────────────────────────────────────────────────────
 * DB 읽기/쓰기가 실패해도(컬럼이 아직 없는 환경 포함) 예외를 던지지 않는다.
 * 그런 경우 이번 회차는 전부 'unknown' 취급 — 기존 동작과 같다.
 */

const DEFAULT_TIME_BUDGET_MS = 4000;

function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {Array<{productId:string, title:string}>} items
 * @param {object} [opts]
 * @param {object}   [opts.supabase]     주입 가능 — 테스트에서 가짜 DB로 교체한다.
 * @param {Function} [opts.classify]     주입 가능 — 기본은 _product-kind-classifier.classifyBatch.
 * @param {number}   [opts.timeBudgetMs] 전체(조회+분류+저장) 제한 시간.
 * @returns {Promise<Map<string,'main'|'accessory'|'unknown'>>}
 *   값이 없는 productId 는 "이번 회차엔 판단 못 함" 이다. 호출부는 이를 기존
 *   제목 기반 가드로만 판단하면 된다(안전 기본값).
 */
async function syncProductKinds(items, opts = {}) {
  const list = Array.isArray(items) ? items.filter(it => it && it.productId && it.title) : [];
  const out = new Map();
  if (!list.length) return out;

  const supabase = opts.supabase || require('./_supabase');
  const classify = opts.classify || require('./_product-kind-classifier').classifyBatch;
  const timeBudgetMs = Math.max(500, Number(opts.timeBudgetMs) || DEFAULT_TIME_BUDGET_MS);
  const deadline = Date.now() + timeBudgetMs;

  const work = (async () => {
    const ids = [...new Set(list.map(it => String(it.productId)))];

    let cached = [];
    try {
      const { data, error } = await supabase
        .from('products')
        .select('product_id, product_kind')
        .in('product_id', ids);
      if (error) throw new Error(error.message || String(error));
      cached = Array.isArray(data) ? data : [];
    } catch (e) {
      // 컬럼이 아직 없거나(마이그레이션 전) DB가 잠깐 안 받아도, 전부 "모른다"로
      // 떨어뜨리고 넘어간다 — 검색 자체는 막지 않는다.
      console.warn(`[product-kind] 기존 분류 조회 실패(이번 회차는 분류 생략): ${e.message}`);
      return out;
    }

    const known = new Map();
    for (const row of cached) {
      if (row && row.product_kind) known.set(String(row.product_id), row.product_kind);
    }
    for (const [pid, kind] of known) out.set(pid, kind);

    // 같은 productId가 여러 mall 행으로 중복될 수 있다 — 제목은 첫 번째 것만 쓴다.
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
    if (remaining < 200) return out; // 조회만으로 시간 예산을 다 썼다 — 분류는 다음 회차에.

    let kinds;
    try {
      kinds = await classify(missing.map(m => m.title), { budgetMs: remaining - 100 });
    } catch (e) {
      console.warn(`[product-kind] 분류 호출 실패(이번 회차는 생략): ${e.message}`);
      return out;
    }
    if (!Array.isArray(kinds) || kinds.length !== missing.length) return out;

    /*
     * ★ null 은 "답을 못 받았다"(타임아웃·호출 실패) — 맵에도 안 넣고 DB에도
     *   안 쓴다. 다음 검색에서 다시 "안 물어본 상품" 취급돼 재시도된다.
     *
     *   2026-11-25 실측 리허설에서 이걸 안 가리고 전부 캐싱한 적이 있다:
     *   "마우스" 검색에서 GPT 응답이 타임아웃났는데(=null이어야 할 상황) 9개
     *   상품이 그대로 'unknown' 으로 영구 저장돼, 재검색 때도 다시 안 물어봤다
     *   (api/_product-kind-classifier.js 상단 주석 참고). unknown 은 "GPT가
     *   실제로 답했는데 애매했다" 는 뜻일 때만 저장한다 — 그건 또 물어봐도
     *   똑같이 애매할 가능성이 커서 재질문을 막는 게 맞다.
     */
    const writes = [];
    missing.forEach((m, i) => {
      const kind = kinds[i];
      if (kind == null) return; // null — 모른다, 재시도 대상. 맵/DB 둘 다 건드리지 않는다.
      out.set(m.productId, kind);
      writes.push({ productId: m.productId, kind });
    });
    if (!writes.length) return out;

    try {
      await Promise.all(writes.map(w => supabase
        .from('products')
        .update({ product_kind: w.kind })
        .eq('product_id', w.productId)));
    } catch (e) {
      // 저장 실패는 "다음에 또 물어본다" 는 비용 문제일 뿐, 이번 응답에는 영향 없다.
      console.warn(`[product-kind] 분류 결과 저장 실패(다음 검색에서 재시도됨): ${e.message}`);
    }

    return out;
  })();

  return withTimeout(work, timeBudgetMs, out);
}

module.exports = { syncProductKinds, DEFAULT_TIME_BUDGET_MS };
