'use strict';
/*
 * 오프라인 모드의 «GPT 플래너» 대역 — 결정적(같은 질문이면 같은 계획).
 *
 * 실제 운영의 planModel(OpenAI search_products 도구 호출)이 돌려주는 모양
 * { mode, query, compareQuery, category, maxPrice, exclusions, mallOnly, exactModel } 을 흉내 낸다.
 * 예산·브랜드·제외·모델 코드는 엔진(sanitizePlan)이 사용자 발화에서 다시 뽑으므로 여기서는
 * 검색어·비교 대상만 정한다. 오프라인 결과는 «서버 파이프라인(검색·검증·상태)» 의 성능이지
 * GPT 계획 품질이 아니다 — 보고서에 그렇게 적는다.
 */
const { explicitType, canonicalName } = require('../../api/_ai-v31-taxonomy');

const BUDGET = /(?:예산\s*)?\d[\d,.]*\s*(?:만\s*원|만원|원|천\s*원)\s*(?:대|이하|이내|미만|안쪽|아래|까지|짜리|정도|으로|로)?/g;
// 긴 군말은 어디서든 지운다. 짧은 낱말(더·좀·줘…)은 «따로 선 낱말» 일 때만 — '블렌더' 의 '더' 를 지우면 안 된다.
const FILLER = /(?:추천\s*해\s*줘|추천해줘|추천\s*좀|추천|알려\s*줘|찾아\s*줘|보여\s*줘|골라\s*줘|뭐가\s*(?:좋아|나아|나을까|좋을까)|뭐\s*사야\s*돼|뭐\s*있어|있어|좋은\s*거|괜찮은\s*거|가성비|최저가|가격\s*비교|비교\s*해\s*줘|비교|어디(?:가|서)\s*(?:제일\s*)?싸|어디서\s*사는\s*게\s*제일\s*싸|싼\s*거|비싼\s*거|\?|!|~|\.)/g;
const SHORT = /(?<![가-힣A-Za-z0-9])(?:더|좀|줘|해줘|하나|중에|제품|요즘|지금|거)(?![가-힣A-Za-z0-9])/g;
const FOLLOWUP = /(?:더\s*(?:싼|비싼|가벼운|좋은)|다른\s*(?:색상|브랜드|거|걸)|[첫두세네]\s*번째|말고|파는\s*거만|무선으로|유선으로|배송|이거|그거|그중|이\s*중)/;
const COMPARE_HINT =/(?:\bvs\.?\b|비교|차이|뭐가\s*(?:나아|나을까|좋아|좋을까)|뭐\s*사야)/i;
const SPLIT = /\s*(?:\bvs\.?\b|이랑|랑|하고|와|과)\s+/i;

// GPT 가 «상품 종류 낱말 없이» 모델명만 들어도 아는 종류 — 운영 플래너와 같은 세계 지식만 흉내 낸다
// (예: «삼성 T7 1TB» → 외장 SSD, «소니 WH-1000XM5» → 헤드폰). 엔진은 이 category 를 사용자 발화로
// 다시 검증하지 않는다(canonicalCategory 가 planCategory 를 받는다) — 그래서 좁게 둔다.
const KNOWN_MODEL_CATEGORY = [
  [/(?:\bT7\b|\bT9\b|\bT5\s*EVO\b|\bP9\b|익스트림\s*포터블|extreme\s*portable)/i, '외장 SSD'],
  [/(?:WH-?1000\s*XM\d|QC\s*\d{2}\b|quietcomfort|에어팟\s*맥스|airpods\s*max)/i, '헤드폰']
];
const knownCategory = text => (KNOWN_MODEL_CATEGORY.find(([re]) => re.test(text)) || [null, ''])[1];

const tidy = s =>String(s || '').replace(BUDGET, ' ').replace(FILLER, ' ').replace(SHORT, ' ')
  .replace(/\s+/g, ' ').trim().slice(0, 40);

function planFor(message) {
  const text = String(message || '');
  if (COMPARE_HINT.test(text) && SPLIT.test(text)) {
    const [a, b] = text.split(SPLIT);
    const qa = tidy(a), qb = tidy(b);
    if (qa && qb) {
      const type = explicitType(text) || explicitType(qb) || explicitType(qa) || '';
      return { mode: 'compare', query: qa, compareQuery: qb, category: canonicalName(type) || type || '',
        maxPrice: null, exclusions: [], mallOnly: '', exactModel: '' };
    }
  }
  const type = explicitType(text) || knownCategory(text) || '';
  // 상품 낱말이 없는 후속 질문(«더 싼 거 없어?» «첫 번째 거») — GPT 는 검색어를 비우거나 앞 검색어를
  // 다시 쓴다. 비우면 엔진이 상태의 lastQuery 를 쓴다(sanitizePlan).
  const followup = !type && FOLLOWUP.test(text);
  const query = followup ? '' : tidy(text);
  return { mode: followup || query || type ? 'recommend' : 'none', query, compareQuery: '', category: canonicalName(type) || type || '',
    maxPrice: null, exclusions: [], mallOnly: /쿠팡/.test(text) ? '쿠팡' : '', exactModel: '' };
}

module.exports = { planFor, tidy };
