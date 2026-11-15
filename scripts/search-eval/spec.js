'use strict';
/*
 * SEOSA 검색 평가 — 문항 명세 DSL 과 채점기 (2026-11-15).
 *
 * ★ 이 채점기는 검사 대상 코드(api/_product-gate.js, api/_search.js …)를 require 하지 않는다.
 *   정답 판정이 구현과 같은 규칙을 쓰면 «틀린 규칙이 스스로 맞다고 채점» 하게 된다.
 *   여기 있는 것은 문항을 쓸 때 미리 정한 정규식 조건뿐이다.
 *
 * 문항 하나:
 *   { id, cat, q, kind:'main'|'acc', m:[RegExp…], x:[RegExp…], max, min, cap, used:'x'|'want',
 *     accOk: RegExp, seed (후속 질문의 앞 질문), retrieval (공급원 검색어; 기본 q) }
 *
 *   m      상품명에 전부 있어야 한다 (정체성 근거)
 *   x      하나라도 있으면 틀린 상품 (다른 모델·브랜드·변형)
 *   kind   main → 부속·소모품·도서로 보이는 상품명은 틀린 상품
 *          acc  → 사용자가 부속을 찾았다 (부속 검사 생략)
 *   max/min 가격 상한·하한 (원)
 *   cap    저장 용량 GB — 상품명이 그 용량을 밝혀야 하고, 다른 저장 용량을 함께 나열하면 틀린 상품
 *   used   'x' 중고·리퍼·렌탈 제외 요청 / 'want' 중고 요청
 *   accOk  본품 상품명에서 부속 낱말 검사 전에 지울 «본품의 일부» 표현 (예: 에어팟의 충전 케이스)
 */

// 본품 검색에서 «이 상품은 부속·소모품·도서다» 를 뜻하는 낱말. 채점 전용(구현과 독립).
const GRADE_ACC = /(?:케이스|커버(?!업)|필름|강화\s*유리|액정\s*보호|키\s*스킨|파우치|슬리브|거치대|받침대|지지대|홀더|마운트|충전기|어댑터|케이블|젠더|허브|이어\s*팁|이어\s*패드|폼\s*팁|스트랩|(?:워치|시계)\s*(?:밴드|줄)|교체\s*밴드|리모컨|필터|브러시|브러쉬|노즐|먼지\s*봉투|물걸레\s*패드|걸레|교체용|호환|리필|부품|소모품|키캡|손목\s*받침|마우스\s*(?:피트|패드|번지)|피트|스케이트|그립\s*테이프|세척\s*솔|빨대|뚜껑|패킹|마개|도서|교재|설명서|가이드북|스티커|보관함|수납|정리함|건조\s*망|망\s*가방)/i;
// 딸려 오는 구성품 표기는 본품을 부속으로 만들지 않는다.
const BUNDLE = /(?:\S+\s*){0,2}?(?:케이스|커버|필름|충전기|어댑터|케이블|파우치|스트랩|이어\s*팁|필터|브러시|노즐|거치대|스탠드|리모컨)\s*(?:포함|증정|동봉|제공|탑재|내장|구성|세트\s*증정|무료\s*증정|\+\s*증정)/gi;
const PROMO_HEAD = /^\s*\[[^\]]{0,60}(?:증정|사은품|포함)[^\]]*\]/;
const USED = /(?:중고|리퍼|refurb|renewed|전시\s*상품|전시품|반품\s*상품|S급|A급|B급|단순\s*개봉|개봉\s*상품|렌탈|대여|월\s*\d|약정)/i;
const BOOK = /(?:도서|교재|사용\s*설명서|가이드북|매거진|잡지|e-?book|이북)/i;

function storageCaps(title) {
  const caps = new Set();
  const t = String(title || '');
  for (const m of t.matchAll(/(?<![0-9a-z])(\d{1,4})\s*(TB|GB|기가|테라|G)(?![a-z0-9])/gi)) {
    const around = t.slice(Math.max(0, m.index - 12), m.index + m[0].length + 6);
    const n = Number(m[1]) * (/TB|테라/i.test(m[2]) ? 1024 : 1);
    if (/(?:RAM|램|메모리)/i.test(around) && n <= 64) continue;
    if (n >= 32 && n <= 8192) caps.add(n);
  }
  return caps;
}

/** 상품 하나가 문항 조건을 만족하는가. 반환 { ok, why } */
function judgeItem(spec, item) {
  const title = String((item && item.title) || '');
  const price = Number(item && (item.lprice != null ? item.lprice : item.price)) || 0;
  for (const re of spec.m || []) if (!re.test(title)) return { ok: false, why: `identity:${re.source.slice(0, 24)}` };
  for (const re of spec.x || []) if (re.test(title)) return { ok: false, why: `forbidden:${re.source.slice(0, 24)}` };
  if ((spec.kind || 'main') === 'main') {
    let t = title.replace(PROMO_HEAD, ' ');
    if (spec.accOk) t = t.replace(new RegExp(spec.accOk.source, 'gi'), ' ');
    t = t.replace(BUNDLE, ' ');
    if (GRADE_ACC.test(t) && !(spec.accAllow && spec.accAllow.test(title))) return { ok: false, why: 'accessory' };
    if (BOOK.test(title) && !spec.book) return { ok: false, why: 'publication' };
  }
  if (spec.max && price > spec.max) return { ok: false, why: 'over_budget' };
  if (spec.min && price < spec.min) return { ok: false, why: 'under_budget' };
  if (spec.used === 'x' && USED.test(title)) return { ok: false, why: 'used_excluded' };
  if (spec.used === 'want' && !/(?:중고|리퍼|refurb|S급|A급|B급|공기계)/i.test(title)) return { ok: false, why: 'not_used' };
  if (spec.cap) {
    const caps = storageCaps(title);
    if (!caps.has(spec.cap)) return { ok: false, why: caps.size ? 'capacity_mismatch' : 'capacity_unstated' };
    const storageLike = [...caps].filter(c => c >= 64);
    if (storageLike.length > 1) return { ok: false, why: 'capacity_ambiguous' };
  }
  return { ok: true, why: '' };
}

/*
 * 문항 판정 (사전 등록 규칙).
 *   pool  — 공급원(또는 동결 카탈로그 검색)이 준 후보 전체
 *   shown — 검사 대상 경로가 사용자에게 보여 준 순서
 *
 *   PASS        보여 준 상위 5개가 전부 조건을 만족하고, 정답 후보가 있으면 하나 이상 보여 줬다
 *   FAIL        상위 5개 중 하나라도 조건 위반(관련 없음·다른 모델·부속·예산 초과·중고 위반·용량 위반)
 *               또는 정답 후보가 있는데 하나도 보여 주지 않았다(0건 오답)
 *   UNVERIFIED  후보 안에 조건을 만족하는 상품이 없고 잘못 보여 준 것도 없다 —
 *               «결과 없음» 이 맞는지 판매처·DB 로 확인할 수 없다
 */
function gradeQuestion(spec, pool, shown, k = 5) {
  const relevant = (pool || []).filter(it => judgeItem(spec, it).ok);
  const top = (shown || []).slice(0, k);
  const verdicts = top.map(it => ({ it, v: judgeItem(spec, it) }));
  const wrong = verdicts.filter(x => !x.v.ok);
  const relIds = new Set(relevant.map(keyOf));
  const shownRel = (shown || []).filter(it => relIds.has(keyOf(it)));
  const top10 = (shown || []).slice(0, 10).filter(it => relIds.has(keyOf(it)));
  const metrics = {
    precision5: top.length ? (top.length - wrong.length) / top.length : null,
    recall10: relevant.length ? top10.length / Math.min(relevant.length, 10) : null,
    relevantInPool: relevant.length,
    shown: (shown || []).length,
    wrongReasons: wrong.map(x => x.v.why),
    accessoryConfusion: wrong.some(x => x.v.why === 'accessory' || x.v.why === 'publication'),
    modelMismatch: wrong.some(x => /^identity|^forbidden|capacity/.test(x.v.why)),
    budgetViolation: wrong.some(x => x.v.why === 'over_budget' || x.v.why === 'under_budget'),
    usedViolation: wrong.some(x => x.v.why === 'used_excluded')
  };
  let verdict;
  if (wrong.length) verdict = 'FAIL';
  else if (relevant.length && !shownRel.length) verdict = 'FAIL';
  else if (!relevant.length) verdict = 'UNVERIFIED';
  else verdict = 'PASS';
  const reason = wrong.length ? `wrong:${[...new Set(metrics.wrongReasons)].join('+')}`
    : (relevant.length && !shownRel.length) ? 'missed_all_relevant'
    : !relevant.length ? 'no_verifiable_answer_in_pool' : '';
  return { verdict, reason, metrics, shownTop: top.map(it => ({ title: it.title, price: Number(it.lprice != null ? it.lprice : it.price) || 0, ok: judgeItem(spec, it).ok })) };
}

function keyOf(it) { return `${it && it.productId}|${it && it.mall}`; }

module.exports = { judgeItem, gradeQuestion, storageCaps, GRADE_ACC, USED, keyOf };
