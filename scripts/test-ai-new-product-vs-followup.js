#!/usr/bin/env node
/**
 * 새 상품 요청과 진짜 후속 질문을 가른다. 2026-11-02. 완전 오프라인(핸들러 전체, GPT·판매처 대역).
 *
 *   node scripts/test-ai-new-product-vs-followup.js
 *
 *   1. 새 상품을 물으면 이전 상품 기억보다 새 요청이 앞선다
 *   2. "아까 그 제품 가격은?" 은 직전 상품을 유지한다
 *   3. 상품명을 말한 가격 질문과 이전 상품의 가격 재확인을 구별한다
 *   4. 예산·제외 조건이 불필요하게 지워지거나 다른 종류의 상품에 잘못 걸리지 않는다
 */
'use strict';

const H = require('./_ai-chat-harness');

let pass = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 240) : ''}`);
}
const hist = t => [{ role: 'user', text: t }, { role: 'assistant', text: '추천드렸어요.' }];
const classify = (q, prior) => {
  const log = console.log; console.log = () => {};
  try { return H.I.heuristicIntent(q, hist(prior), { source: 'none' }); } finally { console.log = log; }
};
const titles = r => ((r.body && r.body.items) || []).map(i => i.title);
const prices = r => ((r.body && r.body.items) || []).map(i => Number(i.lprice));

/* ── 3. 파서: 이름 있는 가격 질문 vs 재확인 ──────────── */
const PRIOR = '가벼운 사무용 노트북 추천해줘';
for (const [q, want] of [
  ['비보북 얼마야', '비보북'], ['후보 중 비보북 판매가 다시 조회해 줘', '비보북'], ['다시 보니 젠북은 얼마야', '젠북'], ['그램 16 가격 알려줘', '그램'],
  ['맥북 에어 M3 지금 얼마야', '맥북'], ['씽크패드 현재가 알려줘', '씽크패드'], ['첫 번째 후보 말고 아이디어패드 가격 확인해줘', '아이디어패드'], ['갤럭시북5 프로는 얼마예요?', '갤럭시북']
]) {
  const d = classify(q, PRIOR);
  ok(String(d.query || '').includes(want) && !d.stateQuery, `3 이름 있는 가격 질문: «${q}»`, { query: d.query, stateQuery: d.stateQuery });
}
for (const q of ['아까 그 제품 가격은?', '그거 얼마야?', '방금 그 제품 가격 다시 알려줘', '현재가 다시 확인해줘', '그 제품 지금 얼마라고?', '가격이 얼마였죠?', '아까 추천한 거 지금 얼마야', '그거 최신 가격으로 얼마야']) {
  const d = classify(q, PRIOR);
  const query = String(d.query || '');
  ok(!query || query.includes('노트북'), `3 재확인은 새 상품을 만들지 않는다: «${q}»`, { query });
}

(async () => {
  const notebooks = [
    ['nb-hp', 'HP 2026 비전 15 사무용 노트북', 999000], ['nb-gram', 'LG전자 그램 14 14Z90T 사무용 노트북', 1390000],
    ['nb-book', '삼성전자 갤럭시북5 프로 사무용 노트북', 1490000], ['nb-vivo', 'ASUS 비보북 15 X1504 사무용 노트북', 650000]
  ];
  notebooks.forEach(([pid, title, price]) => H.addProduct({ pid, vid: pid + 'v', title, price, keys: ['노트북', '사무용', ...(/비보북/.test(title) ? ['비보북'] : [])], history: [[0, price], [5, price + 20000], [12, price + 30000]] }));
  H.addProduct({ pid: 'nb-mac', vid: 'nb-macv', title: 'Apple 맥북 에어 M3 13 노트북', price: 2100000, keys: ['맥북', '노트북'], history: [[0, 2100000], [5, 2120000], [12, 2150000]] });
  [['eb-ap', 'Apple 에어팟 프로 3 무선 이어폰', 340000], ['eb-so', '소니 WF-1000XM5 무선 이어폰', 290000], ['eb-qc', 'QCY T13 무선 이어폰', 25000]].forEach(([pid, title, price]) =>
    H.addProduct({ pid, vid: pid + 'v', title, price, keys: ['이어폰', '무선 이어폰'], history: [[0, price], [5, price + 5000], [12, price + 9000]] }));
  H.addProduct({ pid: 'wt-aw', vid: 'wt-awv', title: 'Apple 애플워치 시리즈 10 46mm 스마트워치', price: 599000, keys: ['애플워치', '스마트워치'], history: [[0, 599000], [5, 609000], [12, 619000]] });
  [['tb-ip', 'Apple 아이패드 11세대 128GB 태블릿', 549000], ['tb-gx', '삼성전자 갤럭시탭 S9 FE 128GB 태블릿', 499000]].forEach(([pid, title, price]) =>
    H.addProduct({ pid, vid: pid + 'v', title, price, keys: ['태블릿', '필기용 태블릿'], history: [[0, price], [5, price + 5000], [12, price + 9000]] }));

  const say = (s, q, classifyAs) => s.say(q, { answer: '확인했습니다.', classify: classifyAs || '?', resolve: '' });

  /* 1·2·4 — 노트북 대화 안에서 이름 있는 상품을 묻고, 되돌아온다 */
  {
    const s = H.session();
    await say(s, '사무용 노트북 150만원 이하로 추천해줘');
    await say(s, 'HP 말고 다른 브랜드로');
    const named = await say(s, '비보북 얼마야');
    ok(titles(named)[0] && /비보북/.test(titles(named)[0]), '1 새 상품 가격 질문은 그 상품을 찾는다', titles(named));
    const again = await say(s, '아까 그 제품 가격은?');
    ok(titles(again).every(t => /비보북/.test(t)), '2 «아까 그 제품» 은 직전 상품을 유지한다', titles(again));
    ok(again.searches === 0 || titles(again).length > 0, '2 재확인 턴도 답을 낸다', again.searches);
    const back = await say(s, '최종 추천 하나 궁금해');
    ok(titles(back).length > 0 && titles(back).every(t => /노트북/.test(t)), '4 후속 말은 찾던 종류 안에 머문다', titles(back));
    ok(prices(back).every(p => p <= 1500000), '4 이름 있는 가격 질문 뒤에도 예산이 남는다', prices(back));
    ok(!titles(back).some(t => /\bHP\b/.test(t)), '4 이름 있는 가격 질문 뒤에도 제외가 남는다', titles(back));
  }

  /* 4 — 예산 밖 상품을 이름으로 물어도 답하고, 옛 예산으로 가리지 않는다 */
  {
    const s = H.session();
    await say(s, '사무용 노트북 150만원 이하로 추천해줘');
    const r = await say(s, '맥북 에어 M3 지금 얼마야');
    ok(titles(r).some(t => /맥북/.test(t)), '4 예산 밖 상품도 이름으로 물으면 가격을 답한다', titles(r));
    const next = await say(s, '이제 다시 사무용 노트북으로 볼게. 최종 추천 하나 궁금해');
    ok(titles(next).length > 0, '4 되돌아온 턴은 카드를 낸다', titles(next));
  }

  /* 4 — 종류가 바뀌면 앞 상품의 브랜드 제외·예산이 새 상품에 걸리지 않는다 */
  {
    const s = H.session();
    await say(s, '필기용 태블릿 60만원 이하로 추천해줘');
    await say(s, '애플 제품은 빼줘');
    const inTablet = await say(s, '좀 더 싼 거 찾아줘');
    ok(!titles(inTablet).some(t => /Apple|아이패드/.test(t)), '4 같은 종류에서는 제외가 유지된다', titles(inTablet));
    const switched = await say(s, '이제 무선 이어폰 추천해줘');
    ok(titles(switched).some(t => /이어폰/.test(t)), '1 다른 종류로 바꾸면 새 요청이 앞선다', titles(switched));
    /*
     * 종류가 바뀌면 앞 상품에만 걸린 제외는 프롬프트에서도 사라진다. 카드 수는 «새 주제 한 장» 규칙이
     * 정하므로(api/_ai-budget-window.oneCardFollowup) 카드 목록으로 제외 여부를 판정하지 않는다.
     */
    ok(!/빼 달라고 한 브랜드·이름/.test(switched.system) && !/크게 내렸다/.test(switched.system),
      '4 태블릿에서 뺀 애플이 이어폰 프롬프트에 걸리지 않는다', (String(switched.system).match(/빼 달라고 한[^\n]*|크게 내렸다[^\n]*/g) || []));
    ok(prices(switched).some(p => p > 0), '4 카드가 있다', prices(switched));
  }

  /* 4 — 뺀 브랜드만 파는 종류로 옮기면 그 브랜드가 다시 후보가 된다 (카드로 확인) */
  {
    const s = H.session();
    await say(s, '필기용 태블릿 60만원 이하로 추천해줘');
    await say(s, '애플 제품은 빼줘');
    const r = await say(s, '이제 애플워치 추천해줘');
    ok(titles(r).length > 0 && titles(r).some(t => /Apple|애플/.test(t)),
      '4 뺀 브랜드만 있는 새 종류에서는 그 브랜드가 다시 후보가 된다', titles(r));
  }

  /* 4 — 같은 사람이 모든 상품에 적용한다고 말한 제외는 다른 종류에도 남는다 */
  {
    const s = H.session();
    await say(s, '무선 이어폰 추천해줘');
    await say(s, '애플 제품은 앞으로 전부 빼줘');
    const r = await say(s, '이제 필기용 태블릿 추천해줘');
    ok(titles(r).length > 0 && !titles(r).some(t => /Apple|아이패드/.test(t)), '4 «앞으로 전부» 제외는 종류가 바뀌어도 남는다', titles(r));
  }

  console.log(`=== 결과: ${pass}/${pass + failures.length} PASS ===`);
  failures.forEach(f => console.log('  [FAIL]', f));
  process.exit(failures.length ? 1 : 0);
})();
