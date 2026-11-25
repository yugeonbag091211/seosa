'use strict';
/*
 * "모델코드+용 OOO" 호환 액세서리 신호 — 순수 함수.
 *
 * ── 왜 필요한가 (2026-11-25, PR #248 "accessory host context"에서 추출) ──
 *
 * 본품/액세서리 판별은 지금까지 두 갈래로 풀어 왔다.
 *   1) _aiidentity.isAccessoryToken — ACCESSORY_CATEGORY_WORDS 같은 "닫힌 사전"에
 *      등록된 낱말만 액세서리로 인식한다.
 *   2) _ai-v31-taxonomy.TYPES — 노트북·모니터 같은 "본품(호스트)" 종류 16개만
 *      등록돼 있다. 액세서리 자체의 이름(트레이·레일·브라켓…)은 여기 없다.
 *
 * 그래서 "DS224+용 트레이", "60cm용 서랍 레일" 처럼 사전에 없는 액세서리
 * 낱말이 오면 둘 다 아무 신호도 못 준다 — 실측(node 직접 호출, 2026-11-25):
 *
 *   splitNegations('DS224+용 트레이 찾는 중이야')
 *     → { positive: 'DS224 plus 용 트레이 찾는 중이야', negated: [] }   (부정 처리 없음 — 맞다, 부정문이 아니다)
 *   TAX.explicitType('DS224 plus 용 트레이 찾는 중이야') → ''            (본품 종류 못 찾음 — 트레이가 호스트가 아니므로 맞다)
 *   TAX.typeMentions(...) → []                                         (마찬가지)
 *
 * 이 자체는 틀리지 않았다 — "트레이"는 노트북·모니터 같은 "검색 대상 본품
 * 카테고리"가 아니다. 문제는 그 다음 단계다: 사전에 없는 낱말이 나오면 폴백이
 * "모델코드(DS224)가 곧 찾는 상품"으로 떨어져, 모델코드 자체(나스 본체)가
 * 1순위로 올라갈 위험이 있다. 실제로는 사용자가 "DS224용 부속"을 찾는 것이지
 * "DS224 본체"를 찾는 게 아니다.
 *
 * 이 함수는 새 사전 항목을 추가하는 대신 — 사전은 추가할수록 다음에 또
 * 모르는 낱말이 나온다(2026-11-25 대화의 "가방 감점 → 책 감점 → 필름 감점"과
 * 같은 문제) — 문장 구조로 판단한다: "모델코드/숫자+용" 또는 "OOO에 쓸·사용할"
 * 바로 뒤에 오는 명사는, 사전에 있든 없든, 사려는 물건이고 앞의 모델코드는
 * "호환 대상(호스트)"일 뿐이다.
 *
 * ── 범위 ──
 * 이 함수는 긍정 신호 하나만 더한다. 기존 판정(브랜드·조건·부정 등)을
 * 대체하거나 순서를 바꾸지 않는다 — 그래서 기존 verdict/buildContract 흐름에
 * 안전하게 "추가 입력"으로만 연결할 수 있다(아직 연결은 안 했다. 아래 참고).
 *
 * ── 아직 안 한 일 ──
 * 실제 검색 파이프라인(verdict/buildContract, _shop.relevantRows)에 이
 * 신호를 꽂는 일은 운영 키·DB로 기존 eval(scripts/eval-ai-holdout-*.js 등)을
 * 돌려 회귀가 없는지 확인한 뒤에 해야 한다. 이 환경에는 그 키가 없어서
 * 순수 함수 단위까지만 만들고 테스트했다 — 연결은 하지 않았다.
 */

/**
 * "모델코드+용" 또는 "OOO에 쓸/사용할/사용하는" 뒤에 오는 명사(구)를 뽑는다.
 * 그 명사가 바로 "호환 액세서리" 이름이고, 앞의 호스트는 검색 대상이 아니다.
 *
 * @param {string} text
 * @returns {string} 액세서리 명사. 패턴이 없으면 빈 문자열.
 */
function compatibilityAccessoryNoun(text) {
  const raw = String(text || '').normalize('NFKC');
  const m = raw.match(
    /(?:[a-z0-9+\-]*\d[a-z0-9+\-]*용|[가-힣a-z0-9]{2,20}에\s*(?:쓸|쓰는|사용할|사용하는))\s+([^.!?]{2,70})/iu
  );
  if (!m) return '';
  const phrase = m[1].split(
    /\s+(?:찾는|찾고|찾아줘|찾아주세요|찾아|구매하고|구매하려고|구매할래|구매|사고|보여줘|보여주세요|보여|추천해줘|추천해주세요|추천|원해|살래|주문|사려고|사려는데|사려)(?=\s|$)/u
  )[0];
  const words = (phrase.match(/[가-힣a-z0-9]{2,}/giu) || []).filter(
    w => !/^(?:전용|호환|정품|제품|상품|부품)$/.test(w)
  );
  return (words.at(-1) || '').replace(/(?:만|을|를)$/u, '');
}

/**
 * 이 문장이 "모델코드+용" 패턴으로 액세서리를 찾고 있는지 여부만 돌려준다.
 * (추출된 낱말을 아직 어디에도 안 쓰고, "이 문장은 호환-액세서리 질의다"
 *  라는 사실만 필요할 때 쓴다.)
 */
function isCompatibilityAccessoryQuery(text) {
  return compatibilityAccessoryNoun(text).length > 0;
}

module.exports = { compatibilityAccessoryNoun, isCompatibilityAccessoryQuery };
