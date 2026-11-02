#!/usr/bin/env node
'use strict';
/*
 * FAIL 을 공통 원인(RC)으로 묶는다. 사용자 지시의 우선 6개 묶음을 그대로 쓴다.
 * 한 질문이 여러 원인에 걸리면 각 원인에 한 번씩 센다(합이 FAIL 수보다 크다).
 * 서버 로그의 검색어(kwSeen)가 있는 건은 «검색어 자체가 상품을 가리켰는가» 로 원인을 확정한다.
 */
const fs = require('fs');
const path = require('path');
const DIR = path.resolve(__dirname, '../../reports/production-ai-5000');
const rd = p => fs.readFileSync(path.join(DIR, p), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

const RC = {
  'RC1 후속 발화를 새 검색어로 오해': f => f.session && f.fails.some(x => ['memory_context_lost', 'wrong_product', 'query_contaminated'].includes(x.type)) || (f.session && f.fails.some(x => x.type === 'memory_failure') && /찾지 못|결과가 없/.test(f.answer)),
  'RC2 예산·제외·추천 상품 기억 실패': f => f.session && f.fails.some(x => ['memory_failure', 'exclusion_violation', 'budget_violation', 'used_violation', 'budget_misstated', 'cheaper_failed', 'price_inconsistent'].includes(x.type)),
  'RC3 비교 두 모델 분리 실패': f => f.fails.some(x => ['compare_parse_failure', 'compare_missing'].includes(x.type)) || (f.category === 'compare' && f.fails.some(x => x.type === 'query_contaminated')),
  'RC4 상품 종류·모델 판단 오류': f => !f.session && f.fails.some(x => ['wrong_product', 'wrong_model', 'option_mismatch', 'rental_as_price', 'ranking_outlier', 'irrelevant_products'].includes(x.type)),
  'RC4b 단일 질문의 조건 무시(예산·제외·판매처)': f => !f.session && f.fails.some(x => ['budget_violation', 'exclusion_violation', 'used_violation', 'mall_violation'].includes(x.type)),
  'RC5 검색어에 상황 설명 혼입': f => !f.session && f.fails.some(x => x.type === 'query_contaminated'),
  'RC6 근거와 다른 가격·구매 판단': f => f.fails.some(x => ['false_price', 'false_history_claim', 'trivial_lowest_claim', 'price_card_mismatch', 'logic_cheapest', 'overconfident_buy', 'logic_contradiction', 'false_no_exact', 'no_price_answer', 'no_search_attempted'].includes(x.type)),
  'RC7 미확인 사실·내부 공급자명 노출': f => f.fails.some(x => x.type === 'internal_leak' || x.type.startsWith('unfounded') || x.type === 'hallucinated_product' || x.type === 'card_text_mismatch')
};
const F = rd('failures.jsonl');
const out = {};
for (const [k, fn] of Object.entries(RC)) {
  const hit = F.filter(fn);
  out[k] = { n: hit.length, critical: hit.filter(x => x.severity === 'critical').length, ids: hit.slice(0, 12).map(x => x.id) };
}
const none = F.filter(f => !Object.values(RC).some(fn => fn(f)));
console.log(JSON.stringify(out, null, 0).replace(/},/g, '},\n'));
console.log('미분류', none.length, none.slice(0, 10).map(x => x.id + ':' + x.fails[0].type).join(' '));
const sev = {}; F.forEach(f => { sev[f.severity] = (sev[f.severity] || 0) + 1; });
console.log('등급', sev);
