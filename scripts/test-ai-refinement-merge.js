#!/usr/bin/env node
/**
 * 이어지는 말로 다음 검색어 만들기 — 앞 상품 + 브랜드·등급·칩 고르기 (2026-11-16). 완전 오프라인.
 *
 *   node scripts/test-ai-refinement-merge.js
 *
 * main e3d8efb 에서 실측한 결함 (api/ai.js 핸들러 전체, GPT·검색은 가짜):
 *   "노트북 추천해줘" → "삼성 제품만"  검색어 «삼성»          (종류가 빠졌다)
 *   "갤럭시 탭 S9"   → "FE 모델로"    검색어 «갤럭시 S9 FE»   (탭이 빠져 휴대폰이 됐다)
 *   "맥북 에어"      → "M3 칩으로"    검색어 «M3 칩으로»      (앞 상품이 빠지고 조사가 남았다)
 *
 * 원인 (api/_aiidentity.js)
 *   · refinementOf 의 '(으)로' 정규식이 이름을 두 글자 이상으로 잡아 «칩으로» 를 «칩으» + 로 로 자르고 «칩으» 를 브랜드로 읽었다.
 *   · "삼성 제품만" 은 api/_intent.js contentText 를 지나면 «삼성» 만 남는다 — 회사 이름 하나를 새 상품으로 읽었다.
 *   · extractQuery 가 한 글자 한글을 버리는데 «탭» 이 ONE_CHAR_PRODUCTS 에 없었다.
 *
 * 1부는 실제 핸들러로 두 턴을 돌려 H.searchLog(실제로 검색한 말)와 첫 카드를 본다. 분류 LLM 대역은 세 가지로 돈다 —
 * 검색어 없이 쇼핑(C), 이번 말만 검색어로 쓴 쇼핑(C|…), 잡담 오판(A). 어느 쪽이든 서버가 누적한 검색어가 이겨야 한다.
 * 2부는 처음 보는 말투(다른 브랜드·계열·칩·조사)를 분류기(api/_intent.js classify)로 본다. 3부는 한 턴 질문이 그대로인지 본다.
 * 외부 호출 0회, DB 쓰기 0회.
 */
'use strict';

const H = require('./_ai-chat-harness');
const Intent = require('../api/_intent');
const AIID = require('../api/_aiidentity');

let pass = 0, fail = 0;
const failures = [];
let current = '';
function section(name) { current = name; console.log(`\n── ${name} ──`); }
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); return; }
  fail++; failures.push(`${current} :: ${name}`);
  console.log(`  [FAIL] ${name}${detail ? ` — ${String(detail).slice(0, 500)}` : ''}`);
}

/* 검색 대역은 검색어에 key 조각이 들어 있는 상품을 돌려준다(scripts/_ai-chat-harness.js). */
[
  { pid: 'RM-LAP-SS', vid: 'V1', title: '삼성전자 갤럭시북4 프로 NT940XGK 노트북 16GB 512GB', price: 1590000, keys: ['노트북', '삼성'] },
  { pid: 'RM-LAP-LG', vid: 'V1', title: 'LG전자 그램 15 15ZD90S 노트북 16GB 512GB', price: 1290000, keys: ['노트북', '그램'] },
  { pid: 'RM-LAP-HP', vid: 'V1', title: 'HP 15s 노트북 인텔 i5 8GB 512GB', price: 690000, keys: ['노트북'] },
  { pid: 'RM-TAB-S9FE', vid: 'V1', title: '삼성전자 갤럭시탭 S9 FE 128GB Wi-Fi 태블릿', price: 479000, keys: ['갤럭시 탭', '갤럭시탭'] },
  { pid: 'RM-TAB-S9', vid: 'V1', title: '삼성전자 갤럭시탭 S9 128GB Wi-Fi 태블릿', price: 899000, keys: ['갤럭시 탭', '갤럭시탭'] },
  // 결함 검색어 «갤럭시 s9 fe» 가 걸리는 휴대폰 — 고친 검색어 «갤럭시 탭 s9 fe» 에는 «갤럭시 s9» 조각이 없다.
  { pid: 'RM-PH-S9', vid: 'V1', title: '삼성 갤럭시 S9 자급제 64GB 스마트폰', price: 199000, keys: ['갤럭시 s9'] },
  { pid: 'RM-MAC-M2', vid: 'V1', title: 'Apple 맥북 에어 13 M2 8GB 256GB', price: 1190000, keys: ['맥북 에어'] },
  { pid: 'RM-MAC-M3', vid: 'V1', title: 'Apple 맥북 에어 13 M3 8GB 256GB', price: 1390000, keys: ['맥북 에어'] },
  { pid: 'RM-EAR-SONY', vid: 'V1', title: '소니 WF-1000XM5 무선 이어폰 노이즈캔슬링', price: 329000, keys: ['이어폰', '소니'] },
  { pid: 'RM-EAR-QCY', vid: 'V1', title: 'QCY T13 무선 이어폰 블루투스', price: 19900, keys: ['이어폰'] },
  { pid: 'RM-LEN-P12', vid: 'V1', title: '레노버 탭 P12 128GB Wi-Fi 태블릿', price: 329000, keys: ['레노버'] },
  { pid: 'RM-LEN-P12PRO', vid: 'V1', title: '레노버 탭 P12 프로 256GB 태블릿', price: 699000, keys: ['레노버'] }
].forEach(p => H.addProduct(Object.assign({ mall: '쿠팡', history: [[0, p.price], [3, p.price]] }, p)));

const cards = r => (r && r.body && r.body.items) || [];

/** 두 턴 대화. 두 번째 턴에서 실제로 검색한 말과 응답을 돌려준다. */
async function twoTurns(first, second, classify2) {
  const s = H.session();
  await s.say(first, { classify: 'C', answer: '확인했습니다.' });
  const n = H.searchLog.length;
  const r = await s.say(second, { classify: classify2, answer: '확인했습니다.' });
  return { searched: H.searchLog.slice(n), r };
}

(async () => {
  console.log('=== 이어지는 말 → 다음 검색어 (앞 상품 + 브랜드·등급·칩) — 외부 호출 0회, DB 쓰기 0회 ===');

  /* ================================================================ */
  section('1. 실측 결함 세 가지 — 실제 핸들러, 두 턴');
  const reported = [
    { first: '노트북 추천해줘', second: '삼성 제품만', want: '삼성 노트북', top: 'RM-LAP-SS', bareLlm: '삼성' },
    { first: '갤럭시 탭 S9', second: 'FE 모델로', want: '갤럭시 탭 s9 fe', top: 'RM-TAB-S9FE', bareLlm: 'FE 모델' },
    { first: '맥북 에어', second: 'M3 칩으로', want: '맥북 에어 m3', top: 'RM-MAC-M3', bareLlm: 'M3 칩' }
  ];
  for (const c of reported) {
    for (const cls of ['C', `C|${c.bareLlm}`, 'A']) {
      const { searched, r } = await twoTurns(c.first, c.second, cls);
      ok(searched.length === 1 && searched[0] === c.want,
        `"${c.first}" → "${c.second}" (분류 대역 ${cls}): «${c.want}» 로 검색한다`, JSON.stringify(searched));
      ok(cards(r).length > 0 && cards(r)[0].productId === c.top,
        `"${c.first}" → "${c.second}" (분류 대역 ${cls}): 첫 카드는 ${c.top}`, JSON.stringify(cards(r).map(x => x.productId)));
    }
  }
  {
    const { r } = await twoTurns('갤럭시 탭 S9', 'FE 모델로', 'C');
    ok(!cards(r).some(x => x.productId === 'RM-PH-S9'), '"FE 모델로" 가 휴대폰(갤럭시 S9)을 카드로 내보내지 않는다',
      JSON.stringify(cards(r).map(x => x.title)));
  }

  /* ================================================================ */
  section('1-2. 처음 보는 말투 — 실제 핸들러, 두 턴');
  const unseen = [
    { first: '무선 이어폰 추천해줘', second: '소니 제품만 보여줘', want: '소니 무선 이어폰', top: 'RM-EAR-SONY' },
    { first: '레노버 탭 P12', second: '프로 모델로', want: '레노버 탭 p12 프로', top: 'RM-LEN-P12PRO' },
    { first: '맥북 에어 M2', second: 'M3 칩으로요', want: '맥북 에어 m3', top: 'RM-MAC-M3' },
    { first: '노트북 추천해줘', second: 'LG 걸로', want: 'lg 노트북', top: 'RM-LAP-LG' }
  ];
  for (const c of unseen) {
    const { searched, r } = await twoTurns(c.first, c.second, 'C');
    ok(searched.length === 1 && searched[0] === c.want, `"${c.first}" → "${c.second}": «${c.want}» 로 검색한다`, JSON.stringify(searched));
    ok(cards(r).length > 0 && cards(r)[0].productId === c.top, `"${c.first}" → "${c.second}": 첫 카드는 ${c.top}`,
      JSON.stringify(cards(r).map(x => x.productId)));
  }

  /* ================================================================ */
  section('2. 분류기 — 다음 검색어 (api/_intent.js classify, 앞 대화 포함)');
  const follow = (turns) => {
    const hist = [];
    turns.forEach((t, i) => { hist.push({ role: 'user', text: t }); if (i < turns.length - 1) hist.push({ role: 'assistant', text: '확인했습니다.' }); });
    return Intent.classify(turns[turns.length - 1], hist);
  };
  const table = [
    // 브랜드 고르기 — 종류·꾸밈말은 남고, 다른 회사의 이름·계열·모델 번호는 빠진다
    [['노트북 추천해줘', '삼성만'], '삼성 노트북'],
    [['노트북 추천해줘', '삼성 제품으로만 보여줘'], '삼성 노트북'],
    [['노트북 추천해줘', '애플 거 있어?'], '애플 노트북'],
    [['청소기 추천해줘', '다이슨만'], '다이슨 청소기'],
    [['게이밍 노트북 추천해줘', '삼성 제품만'], '삼성 게이밍 노트북'],
    [['아이폰 16 프로 가격', '삼성으로'], '삼성 스마트폰'],
    [['에어팟 프로 2 가격', '소니 제품으로'], '소니 이어폰'],
    [['삼성노트북 추천', 'LG로'], 'LG 노트북'],
    [['갤럭시 탭 S9', '삼성 제품만'], '갤럭시 탭 S9'],
    [['LG 노트북 추천', '그램으로'], 'LG 그램 노트북'],
    [['노트북 추천해줘', '아이폰으로'], '아이폰'],
    // 계열 낱말(탭)은 남고 등급만 바뀐다
    [['갤럭시 탭 S10', '울트라로'], '갤럭시 탭 S10 울트라'],
    [['갤럭시 탭 S9 찾아줘', 'FE로'], '갤럭시 탭 S9 FE'],
    // 칩·메모리 — 속성 이름과 조사는 버리고 값만 반영한다
    [['맥북 프로', 'M4 칩으로'], '맥북 프로 M4'],
    [['아이패드 에어', 'M2 칩으로'], '아이패드 에어 M2'],
    [['맥북 에어', '16GB 메모리로'], '맥북 에어 16gb'],
    // 예전 계약 (scripts/test-live-redteam-regressions.js C6 와 같은 말)
    [['삼성 노트북 찾아줘', 'LG로 바꿔'], 'LG 노트북'],
    [['노트북 추천', '삼성으로'], '삼성 노트북'],
    [['노트북 추천', '삼성 말고 LG로'], 'LG 노트북'],
    [['MX Master 3', '3S로'], 'MX Master 3S'],
    [['아이폰 17 프로 찾아줘', '그중 256GB', '검정색'], '아이폰 17 프로 256gb 검정색']
  ];
  for (const [turns, want] of table) {
    const c = follow(turns);
    ok(c.query === want && c.stateQuery === true, `${turns.join(' → ')}  ⇒  «${want}»`, JSON.stringify({ query: c.query, stateQuery: c.stateQuery }));
  }

  /* ================================================================ */
  section('2-2. 조사 떼기 · 브랜드 판정 (api/_aiidentity.js refinementOf)');
  {
    const chip = AIID.refinementOf('M3 칩으로');
    ok(chip.refinement === true && chip.brands.length === 0, '"M3 칩으로" — 칩 + 으로 (예전: «칩으» 를 브랜드로 읽었다)', JSON.stringify(chip));
    const brand = AIID.refinementOf('삼성');
    ok(brand.refinement === true && brand.brands.join() === '삼성', '"삼성" 만 남은 말 — 회사 이름은 고른 브랜드다', JSON.stringify(brand));
    const neg = AIID.refinementOf('삼성 말고');
    ok(neg.brands.length === 0, '"삼성 말고" — 뺀 브랜드는 고른 것이 아니다', JSON.stringify(neg));
    const pro = AIID.refinementOf('프로로');
    ok(pro.refinement === true && pro.brands.length === 0 && AIID.mergeRefinement('아이폰 16', '프로로') === '아이폰 16 프로',
      '"프로로" — 프로 + 로, "프로" 는 떼지 않는다', JSON.stringify(pro));
    const wireless = AIID.mergeRefinement('소니 이어폰', '무선으로');
    ok(wireless === '소니 이어폰 무선', '"무선으로" 는 브랜드가 아니라 덧붙이는 조건이다 (예전: 소니를 «무선» 으로 바꿨다)', wireless);
    const fresh = AIID.refinementOf('소니 WH-1000XM5');
    ok(fresh.refinement === false, '"소니 WH-1000XM5" — 회사 이름 + 모델 번호는 새 상품이다', JSON.stringify(fresh));
    // 넓게 잡지 않는다 — 아래는 main 과 같은 판정이어야 한다.
    for (const [q, why] of [['애플 호환 케이스', '회사 이름 + 부속은 새 상품'], ['완제품만', '«만» 은 알려진 브랜드에만'],
      ['에어팟프로', '붙여 쓴 계열+등급의 «로» 는 조사가 아니다'], ['코드제로', '알려진 이름의 «로» 는 조사가 아니다'],
      ['DDR5 메모리', '조사 없는 속성 이름은 상품일 수 있다']]) {
      const r = AIID.refinementOf(q);
      ok(r.refinement === false && r.brands.length === 0, `"${q}" — ${why}`, JSON.stringify(r));
    }
    const use = AIID.refinementOf('게임용으로');
    ok(use.refinement === true && use.brands.length === 0, '"게임용으로" — 용도는 이어지는 조건이지 브랜드가 아니다', JSON.stringify(use));
  }

  /* ================================================================ */
  section('3. 한 턴 질문은 그대로 — 새 규칙이 첫 질문의 검색어를 바꾸지 않는다');
  const solo = q => Intent.classify(q, [{ role: 'user', text: q }]);
  for (const [q, want] of [['삼성 노트북 추천해줘', '삼성 노트북'], ['DDR5 메모리 추천해줘', 'DDR5 메모리'],
    ['소니 WH-1000XM5 가격', '소니 WH-1000XM5'], ['맥북 에어 M3 찾아줘', '맥북 에어 M3']]) {
    const c = solo(q);
    ok(c.query === want && c.confidence === 'high' && !c.refinement, `"${q}" ⇒ «${want}» (확신 높음, 이어지는 말 아님)`, JSON.stringify(c).slice(0, 300));
  }
  {
    const c = solo('갤럭시 탭 S9 찾아줘');
    ok(c.query === '갤럭시 탭 S9', '"갤럭시 탭 S9 찾아줘" ⇒ «갤럭시 탭 S9» (예전: «갤럭시 S9» — 휴대폰을 찾았다)', c.query);
  }

  /* ================================================================ */
  section('4. «탭» 은 검색어에만 남는다 — 식별 계약은 그대로');
  {
    ok(AIID.slotOf('탭') === 'generic', 'slotOf("탭") 은 generic (식별 낱말이 아니다)', AIID.slotOf('탭'));
    const c = AIID.buildContract({ query: '갤럭시 탭 S9 FE', titles: [] });
    ok(c.core === '갤럭시' && c.anchors.join() === 's9', '계약의 계열 이름은 «갤럭시», 모델 번호는 «s9»', JSON.stringify({ core: c.core, anchors: c.anchors }));
    const glued = AIID.verdict(c, { title: '삼성전자 갤럭시탭 S9 FE 128GB Wi-Fi 태블릿' });
    ok(glued.tier === AIID.TIER.EXACT, '붙여 쓴 «갤럭시탭 S9 FE» 판매 글은 여전히 정확히 맞는 상품이다', JSON.stringify(glued));
  }

  ok(H.counters.external === 0 && H.counters.dbWrites === 0, '외부 호출 0회 · DB 쓰기 0회', JSON.stringify(H.counters));

  console.log(`\n=== ${pass} PASS / ${fail} FAIL ===`);
  if (fail) { failures.forEach(f => console.log(`  - ${f}`)); process.exitCode = 1; }
  else console.log('AI_REFINEMENT_MERGE: brand filter keeps product type, line words survive, chip/particle refinements merge; mocked GPT, external 0, DB writes 0');
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
