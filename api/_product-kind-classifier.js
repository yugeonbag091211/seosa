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
 * null 로 떨어진다(= "못 물어봤다"). 이 모듈 때문에 상품이 사라지는 일은
 * 없다(null 은 호출부가 "모른다"로 다루고 kept 쪽에 남긴다). 오늘 만든
 * _search-type-guard.js 와 같은 원칙이다.
 *
 * ★ null 과 'unknown' 을 구분한다 (2026-11-25, 실측 운영 리허설에서 발견).
 *
 *   null     = 아예 답을 못 받았다(타임아웃·네트워크 실패·응답 파싱 실패).
 *              "다음에 다시 물어봐도 된다" — api/_product-kind-store.js 가
 *              이 경우 DB에 저장하지 않는다.
 *   'unknown'= GPT가 실제로 응답했는데 "애매하다"고 답했다.
 *              "또 물어봐도 똑같이 애매할 거다" — DB에 저장해 재질문을 막는다.
 *
 *   처음 구현은 이 둘을 구분하지 않고 전부 'unknown' 으로 캐싱했다. 그 결과
 *   "마우스" 검색에서 GPT 응답이 타임아웃났을 뿐인데 9개 상품이 영구히
 *   'unknown' 으로 저장돼, 다음 검색에서도 다시 묻지 않는 사고가 났다
 *   (실제로 못 물어본 건데 "물어봤는데 몰랐다"로 잘못 기록된 것).
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

/**
 * GPT 응답(코드펜스·설명 섞여도)에서 분류 배열을 뽑아낸다.
 * 응답 자체를 못 알아보면(배열이 없거나 JSON이 아니면) 전부 null —
 * "답을 못 받았다"와 같은 취급이다(위 "안전장치" 주석 참고). 배열은
 * 찾았는데 한 자리가 main/accessory/unknown이 아니면 그 자리만 'unknown'
 * 으로 — GPT가 뭔가 응답은 했으니 "애매하다"에 가깝게 본다.
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
 * @returns {Promise<Array<string|null>>}  titles 와 같은 길이. 각 원소는
 *   'main'|'accessory'|'unknown'(GPT가 답했다) 또는 null(못 물어봤다 — 재시도 대상).
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
    // r.ok === false 는 타임아웃·쿨다운·공급자 실패 전부를 뜻한다 — 답을
    // 못 받은 것이지 "몰랐다"가 아니다. null 로 돌려줘 재시도 대상으로 남긴다.
    if (!r || !r.ok) return Array.from({ length: list.length }, () => null);
    return parseResponse(r.text, list.length);
  } catch (e) {
    console.warn(`[product-kind] 분류 호출 실패(재시도 대상으로 남김): ${e.message}`);
    return Array.from({ length: list.length }, () => null);
  }
}

module.exports = { classifyBatch, buildPrompt, parseResponse, DEFAULT_MAX_BATCH };
