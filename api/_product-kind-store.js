'use strict';
/*
 * "본품 vs 부속" GPT 1회 분류 결과를 product_id 당 캐싱한다.
 *
 * api/_product-kind-classifier.js 가 "어떻게 물어볼까" 라면, 이 파일은
 * "언제 묻고 언제 DB에서 꺼내 쓸까" 다.
 *
 * ── 2026-11-25 구조 변경: 왜 함수가 두 개로 나뉘었나 ──────────────────
 * 처음엔 검색이 들어올 때마다 "모르는 상품이면 그 자리에서 GPT한테 물어보고
 * 저장까지" 한 번에 다 했다(syncProductKinds). 그런데 실제로 운영 환경에서
 * 돌려보니(Codex 실측) GPT를 처음 물어보는 순간 검색 한 번에 1.8~2.9초가
 * 그대로 더 걸렸다 — 손님은 그만큼 더 기다린 것이다.
 *
 * 그래서 "언제 GPT한테 물어볼까"와 "손님이 검색할 때 뭘 보여줄까"를 분리했다:
 *
 *   · lookupProductKinds — 손님이 검색할 때 쓴다. DB에 이미 저장된 값만
 *     읽어온다. GPT는 절대 안 부른다 — 그래서 빠르다(수십 ms 수준).
 *     아직 분류 안 된 상품은 그냥 "모른다"로 남고, 기존 제목 기반 가드만
 *     적용된다. 손님 입장에서 손해볼 게 없다.
 *
 *   · syncProductKinds — 손님과 상관없이 따로 도는 배치 작업
 *     (scripts/classify-product-kinds-batch.js)이 쓴다. 아직 분류 안 된
 *     상품들을 모아서 GPT에게 미리 물어보고 DB에 저장해 둔다. 여기서 1~2초
 *     걸리는 건 상관없다 — 아무도 그 시간만큼 기다리고 있지 않기 때문이다.
 *     그래서 다음 손님이 같은 상품을 검색할 땐 이미 저장된 답을
 *     lookupProductKinds가 바로 꺼내 쓴다.
 *
 * 비유하면: 손님이 계산대 앞에서 기다리는 동안 점원이 바코드를 찾아보는 게
 * 아니라(느림), 한가할 때 미리 상품마다 바코드를 붙여 놓고(배치 작업), 손님이
 * 오면 그냥 스캔만 하는 것(lookupProductKinds)이다.
 *
 * ── 실패 처리 ────────────────────────────────────────────────────
 * DB 읽기/쓰기가 실패해도(컬럼이 아직 없는 환경 포함) 예외를 던지지 않는다.
 * 그런 경우 이번 회차는 전부 "모른다" 취급 — 기존 제목 기반 가드만 적용된다.
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
 * @param {object} [opts.supabase]     주입 가능 — 테스트에서 가짜 DB로 교체한다.
 * @param {number} [opts.timeBudgetMs] 조회 제한 시간(기본 1200ms) — 이마저 못
 *   끝내면 빈 맵을 돌려주고, 기존 제목 기반 가드만 적용된다.
 * @returns {Promise<Map<string,'main'|'accessory'|'unknown'>>}
 */
async function lookupProductKinds(productIds, opts = {}) {
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
        .select('product_id, product_kind')
        .in('product_id', ids);
      if (error) throw new Error(error.message || String(error));
      const rows = Array.isArray(data) ? data : [];
      for (const row of rows) {
        if (row && row.product_kind) out.set(String(row.product_id), row.product_kind);
      }
    } catch (e) {
      // 컬럼이 아직 없거나 DB가 잠깐 안 받아도 검색은 막지 않는다 — 그냥 "모른다".
      console.warn(`[product-kind] 캐시 조회 실패(이번 회차는 생략): ${e.message}`);
    }
    return out;
  })();

  return withTimeout(work, timeBudgetMs, out);
}

/**
 * 배치 작업 전용(scripts/classify-product-kinds-batch.js) — 모르는 상품을
 * GPT에게 물어보고 DB에 저장까지 한다. 손님 요청 경로에서는 더 이상 쓰지
 * 않는다(1.8~2.9초 지연의 원인이었다) — 대신 lookupProductKinds를 쓴다.
 *
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

module.exports = {
  lookupProductKinds,
  syncProductKinds,
  DEFAULT_TIME_BUDGET_MS,
  DEFAULT_LOOKUP_BUDGET_MS
};
