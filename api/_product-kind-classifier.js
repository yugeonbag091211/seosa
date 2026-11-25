'use strict';
/*
 * GPT 1회 분류 — "본품 vs 부속" 을 사전(ACCESSORY_TIER)이 아니라 LLM 판단으로 보강한다.
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────
 *
 * api/_search.js 의 ACCESSORY_TIER 는 닫힌 목록이다. "팜레스트"·"손목받침"·
 * "키캡" 을 2026-11-25 에 겨우 추가했는데, 다음에 또 "트레이"·"거치판" 같은
 * 새 단어가 나오면 또 똑같이 놓친다 (api/_compat-accessory.js 주석 참고).
 *
 * 쿠팡이 주는 categoryName 은 "가전디지털" 처럼 너무 뭉뚱그려 있어서
 * (2026-11-25 실측: 키보드도 키보드 손목받침대도 똑같이 "가전디지털") 이
 * 문제를 대신 풀어주지 못한다.
 *
 * 그래서 제목을 보고 사람처럼 판단하는 GPT 에게 "이 상품, 그 자체로 파는
 * 본품이야 아니면 다른 기기에 딸린 부속품이야?" 를 물어본다. 사전에 없는
 * 단어라도 뜻을 보고 판단하므로 일반화된다.
 *
 * ── 비용/빈도 ────────────────────────────────────────────────────
 *
 * 검색할 때마다 묻지 않는다. 상품 하나(product_id)당 평생 "한 번만" 묻고
 * DB(products.product_kind)에 캐싱한다 — api/_shop.js 의 classifyNewProductKinds
 * 참고. 이 판단은 검색어에 안 달려 있다("키보드 손목받침대"는 어떤 검색에서
 * 나오든 늘 부속이다) — 그래서 product_id 만으로 캐싱해도 된다.
 *
 * ── 안전장치 ─────────────────────────────────────────────────────
 *
 * GPT 호출이 실패하거나, 응답을 못 알아듣거나, 네트워크가 막히면 전부
 * 'unknown' 으로 떨어진다. 'unknown' 은 "본품이 아니라고 확신 못 함" 과
 * 같은 뜻이라 — 이 모듈 때문에 상품이 사라지는 일은 없다(판단을 보류할
 * 뿐, kept 쪽에 남는다). 오늘 만든 _search-type-guard.js 와 같은 원칙이다.
 */

const DEFAULT_MAX_BATCH = 20;

/** 배치 하나를 LLM에게 물어볼 메시지로 만든다. */
function buildPrompt(titles) {
  const numbered = titles.map((t, i) => `${i + 1}. ${String(t || '').slice(0, 120)}`).join('\n');
  return [
    {
      role: 'system',
      content: '너는 쇼핑몰 상품 제목만 보고 "그 자체로 독립적으로 파는 본품"인지 '
        + '"다른 기기/본품에 딸려 쓰는 부속품·소모품·액세서리"인지 분류하는 판정기다. '
        + '예: "로지텍 G304 마우스"=main, "마우스패드"=accessory, "키보드 손목받침대"=accessory, '
        + '"DS224+용 트레이"=accessory(NAS 본체가 아니라 트레이 부품), "삼성 노트북"=main. '
        + '애매하면 unknown. 반드시 JSON 배열만 출력한다. 설명 금지.'
    },
    {
      role: 'user',
      content: `아래 번호 순서 그대로, 길이 ${titles.length}인 JSON 배열로만 답해라. `
        + `각 원소는 "main" | "accessory" | "unknown" 중 하나다.\n\n${numbered}`
    }
  ];
}

/** GPT 응답(코드펜스·설명 섞여도)에서 분류 배열을 뽑아낸다. 실패하면 전부 'unknown'. */
function parseResponse(text, count) {
  const fallback = () => Array.from({ length: count }, () => 'unknown');
  if (!text) return fallback();
  const m = String(text).match(/\[[\s\S]*\]/);
  if (!m) return fallback();
  let arr;
  try { arr = JSON.parse(m[0]); } catch (e) { return fallback(); }
  if (!Array.isArray(arr)) return fallback();
  const out = [];
  for (let i = 0; i < count; i++) {
    const v = String(arr[i] || '').trim().toLowerCase();
    out.push(v === 'main' || v === 'accessory' ? v : 'unknown');
  }
  return out;
}

/**
 * 상품 제목 묶음을 분류한다. 한 번의 LLM 호출로 처리한다(상품마다 호출하지 않는다).
 *
 * @param {string[]} titles
 * @param {object} [opts]
 * @param {Function} [opts.chat]  주입 가능 — 테스트에서 가짜 LLM으로 교체한다.
 * @returns {Promise<string[]>}  titles 와 같은 길이. 각 원소는 'main'|'accessory'|'unknown'.
 */
async function classifyBatch(titles, opts = {}) {
  const list = Array.isArray(titles) ? titles : [];
  if (!list.length) return [];
  if (list.length > DEFAULT_MAX_BATCH) {
    // 호출자가 쪼개지 않고 큰 배열을 던지면 여기서 나눠 처리한다(토큰 비용 상한).
    const head = list.slice(0, DEFAULT_MAX_BATCH);
    const rest = list.slice(DEFAULT_MAX_BATCH);
    const [a, b] = await Promise.all([
      classifyBatch(head, opts),
      classifyBatch(rest, opts)
    ]);
    return a.concat(b);
  }

  const chat = opts.chat || require('./_llm').chat;
  try {
    const r = await chat({
      messages: buildPrompt(list),
      role: 'classify',
      maxTokens: Math.max(60, list.length * 6),
      temperature: 0,
      budgetMs: opts.budgetMs || 8000
    });
    if (!r || !r.ok) return Array.from({ length: list.length }, () => 'unknown');
    return parseResponse(r.text, list.length);
  } catch (e) {
    console.warn(`[product-kind] 분류 실패(전부 unknown 처리): ${e.message}`);
    return Array.from({ length: list.length }, () => 'unknown');
  }
}

module.exports = { classifyBatch, buildPrompt, parseResponse, DEFAULT_MAX_BATCH };
