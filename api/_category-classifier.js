'use strict';
/*
 * GPT 1회 분류 — 상품 제목을 보고 대분류 카테고리를 매긴다.
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────
 *
 * "그래픽카드" 를 검색하면 진짜 GPU 말고도 "그래픽 맨투맨 ... 트럼프카드"
 * 같은 옷이 섞여 들어왔다(2026-11-26). 원인은 글자 매칭(api/_search.js의
 * tokenQuality)이 "그래픽"·"카드" 두 조각이 제목 어디에든 있으면 거의
 * 일치로 쳐준 것 — 조각 매칭 자체를 아무리 정교하게 고쳐도, 한국어는
 * 단어 경계 표시가 없어서 "우연히 글자가 겹치는" 경우가 또 나올 수 있다.
 *
 * 그래서 글자 매칭과는 독립적인 두 번째 안전망을 둔다: 상품이 "전자기기"인지
 * "패션의류"인지처럼 큰 틀의 카테고리를 GPT로 한 번 분류해 두면, 검색어의
 * 카테고리와 상품의 카테고리가 완전히 다를 때 글자가 아무리 겹쳐도 걸러낼
 * 수 있다. api/_search-category-guard.js 가 이 캐싱된 값을 읽어서 쓴다.
 *
 * ── 비용/빈도 ────────────────────────────────────────────────────
 *
 * api/_product-kind-classifier.js 와 똑같은 패턴 — product_id 당 평생 한 번만
 * 묻고 DB(products.category)에 캐싱한다. 검색어와 무관한 "상품 자체의 성격"
 * 이라 캐싱해도 안전하다.
 *
 * ── 안전장치 ─────────────────────────────────────────────────────
 *
 * GPT 호출이 실패하거나 응답을 못 알아들으면 전부 null("못 물어봤다") —
 * api/_product-kind-classifier.js 와 같은 원칙. null 과 'unknown' 을 구분한다:
 *   null     = 답을 못 받음(재시도 대상, DB에 안 쓴다).
 *   'unknown'= GPT가 답했는데 애매하다고 함(또 물어봐도 같을 거라 DB에 쓴다).
 */

const DEFAULT_MAX_BATCH = 20;

/** 카테고리 고정 목록. 상품 자체의 "큰 틀" 만 가른다 — 세부 분류가 아니다. */
const CATEGORIES = [
  '전자기기', '패션의류', '패션잡화', '뷰티', '식품',
  '생활용품', '가구인테리어', '스포츠레저', '완구취미',
  '반려동물용품', '도서문구', '여행티켓', '기타'
];

function buildPrompt(titles) {
  const numbered = titles.map((t, i) => `${i + 1}. ${String(t || '').slice(0, 120)}`).join('\n');
  return [
    {
      role: 'system',
      content: '너는 쇼핑몰 상품 제목만 보고 가장 알맞은 큰 틀의 카테고리 하나를 고르는 '
        + '판정기다. 고를 수 있는 카테고리는 정확히 이 목록뿐이다: '
        + CATEGORIES.join(', ') + '. '
        + '예: "RTX 4070 그래픽카드"=전자기기, "트럼프카드 니트 맨투맨"=패션의류, '
        + '"루이비통 자카드 후드티셔츠"=패션의류, "아이폰 실리콘 케이스"=전자기기, '
        + '"보스턴 여행가방"=패션잡화, "삼성 노트북"=전자기기. '
        + '애매하면 unknown. 반드시 JSON 배열만 출력한다. 설명 금지.'
    },
    {
      role: 'user',
      content: `아래 번호 순서 그대로, 길이 ${titles.length}인 JSON 배열로만 답해라. `
        + `각 원소는 위 카테고리 목록 중 하나 또는 "unknown" 이다.\n\n${numbered}`
    }
  ];
}

/**
 * GPT 응답에서 분류 배열을 뽑아낸다. 응답을 아예 못 알아보면 전부 null —
 * "답을 못 받았다"와 같은 취급. 배열은 찾았는데 한 자리가 고정 목록에 없으면
 * 그 자리만 'unknown' — GPT가 뭔가 응답은 했으니 "애매하다"에 가깝게 본다.
 */
function parseResponse(text, count) {
  const unreachable = () => Array.from({ length: count }, () => null);
  if (!text) return unreachable();
  const m = String(text).match(/\[[\s\S]*\]/);
  if (!m) return unreachable();
  let arr;
  try { arr = JSON.parse(m[0]); } catch (e) { return unreachable(); }
  if (!Array.isArray(arr)) return unreachable();
  const out = [];
  for (let i = 0; i < count; i++) {
    const v = String(arr[i] || '').trim();
    out.push(CATEGORIES.includes(v) ? v : 'unknown');
  }
  return out;
}

/**
 * 상품 제목 묶음을 분류한다. 한 번의 LLM 호출로 처리한다(상품마다 호출하지 않는다).
 *
 * @param {string[]} titles
 * @param {object} [opts]
 * @param {Function} [opts.chat]  주입 가능 — 테스트에서 가짜 LLM으로 교체한다.
 * @returns {Promise<Array<string|null>>}  titles 와 같은 길이. 각 원소는
 *   CATEGORIES 중 하나 | 'unknown'(GPT가 답했다) | null(못 물어봤다 — 재시도 대상).
 */
async function classifyBatch(titles, opts = {}) {
  const list = Array.isArray(titles) ? titles : [];
  if (!list.length) return [];
  if (list.length > DEFAULT_MAX_BATCH) {
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
    if (!r || !r.ok) return Array.from({ length: list.length }, () => null);
    return parseResponse(r.text, list.length);
  } catch (e) {
    console.warn(`[category] 분류 호출 실패(재시도 대상으로 남김): ${e.message}`);
    return Array.from({ length: list.length }, () => null);
  }
}

module.exports = { classifyBatch, buildPrompt, parseResponse, CATEGORIES, DEFAULT_MAX_BATCH };
