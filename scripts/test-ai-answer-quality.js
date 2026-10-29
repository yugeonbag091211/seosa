'use strict';

// Answer-quality regressions are deliberately separate from card/function checks.
const assert = require('node:assert/strict');
const H = require('./_ai-chat-harness');
const CAT = require('./_ai-eval-catalog');
const COMP = require('../api/_ai-comparison');
const AIID = require('../api/_aiidentity');
const INTENT = require('../api/_intent');

CAT.PRODUCTS.forEach(p => H.addProduct(p));
const cases = [
  ['갤럭시 A35 128GB 지금 결제 가격만 찾아줘', 'D|갤럭시 A35 128GB', 'PH-A35', 'PH-A35-V1', 499000],
  ['갤럭시탭 S9 FE 지금 결제 가격만 찾아줘', 'D|갤럭시탭 S9 FE', 'TB-S9FE', 'TB-S9FE-V1', 479000],
  ['필립스 에어프라이어 HD9252 지금 결제 가격만 찾아줘', 'D|필립스 에어프라이어 HD9252', 'AP-PHILIPS', 'AP-PHILIPS-V1', 139000],
  ['갤럭시 S25 512GB 아이시블루 단일 옵션의 재고 가격을 조회해 줘', 'D|갤럭시 S25 512GB 아이시블루', 'PH-S25', 'PH-S25-512', 1298000],
  ['맥북 에어 M3 스타라이트 단일 옵션의 재고 가격을 조회해 줘', 'D|맥북 에어 M3 스타라이트', 'LT-MBA-STAR', 'LT-MBA-STAR-V', 1350000],
  ['갤럭시탭 S9 FE 가격 알려 줘', 'D|갤럭시탭 S9 FE', 'TB-S9FE', 'TB-S9FE-V1', 479000]
];

(async () => {
  for (const [question, classify, pid, vid, price] of cases) {
    // Reproduce the exact contradiction in holdout-200.jsonl.
    const r = await H.ask({ question }, { classify, answer: '일치하는 상품을 확인하지 못했어요.' });
    const card = (r.body.items || []).find(x => x.productId === pid && x.vendorItemId === vid);
    assert.ok(card, `${question}: exact product option card missing`);
    assert.equal(Number(card.lprice), price, `${question}: card price changed`);
    assert.doesNotMatch(r.body.text, /(?:일치하는 상품을 확인하지 못|정확히 맞는 상품은 찾지 못|조건에 맞는 상품을 찾지 못)/,
      `${question}: answer contradicts the exact card\n${r.body.text}`);
    assert.match(r.body.text, new RegExp(price.toLocaleString('en-US')),
      `${question}: verified price missing from answer\n${r.body.text}`);
    assert.match(r.body.text, /결제|판매처/,
      `${question}: answer must distinguish observed listing price from checkout\n${r.body.text}`);
    if (/재고/.test(question)) {
      assert.match(r.body.text, /재고 보유 여부는 이 검색으로 확인하지 않았/,
        `${question}: do not imply inventory was confirmed\n${r.body.text}`);
    }
  }

  // Brand-new independent prompts for the two identity regressions found by
  // auditing full answer text: an excluded case must not exclude the tablet,
  // and a shortened XM5 model anchor must still identify WH-1000XM5.
  const ipadBody = await H.ask({ question: '아이패드 케이스 말고 아이패드 11 본체 가격 확인해줘' }, {
    classify: 'D|아이패드 11', answer: '아이패드 11의 가격을 확인할게요.'
  });
  assert.ok((ipadBody.body.items || []).some(x => x.productId === 'TB-IPAD11'),
    'excluding the case must retain the exact iPad body');
  assert.doesNotMatch(ipadBody.body.text, /(?:일치하는 상품을 확인하지 못|정확히 맞는 상품은 찾지 못)/);

  const sonyHeadphone = await H.ask({ question: '소니 헤드폰 xm5 가격 좀' }, {
    classify: 'D|소니 헤드폰 xm5', answer: '확인한 상품 정보를 안내할게요.'
  });
  assert.ok((sonyHeadphone.body.items || []).some(x => x.productId === 'HP-XM5-BK'),
    'XM5 suffix should match WH-1000XM5 headphone');
  assert.doesNotMatch(sonyHeadphone.body.text, /(?:일치하는 상품을 확인하지 못|정확히 맞는 상품은 찾지 못)/);

  const tabletPenContract = AIID.buildContract({
    query: '갤럭시탭 S10 FE 본체 가격 확인해 줘, 펜은 필요 없어',
    userText: '갤럭시탭 S10 FE 본체 가격 확인해 줘, 펜은 필요 없어',
    titles: ['삼성전자 갤럭시탭 S10 FE 128GB Wi-Fi 태블릿', '갤럭시탭 S10 FE 호환 S펜 스타일러스']
  });
  assert.equal(AIID.verdict(tabletPenContract, { title: '갤럭시탭 S10 FE 호환 S펜 스타일러스' }).tier, AIID.TIER.MISMATCH,
    'a compatible S Pen must not pass as a tablet body when the user says they do not need a pen');

  const earbudContract = AIID.buildContract({ query: 'Sony 이어버드 XM5 모델', userText: 'Sony 이어버드 XM5 모델' });
  assert.equal(AIID.verdict(earbudContract, { title: '소니 WF-1000XM5 노이즈캔슬링 무선 이어폰 블랙' }).tier, AIID.TIER.EXACT,
    'Korean Sony earbud listing should satisfy English/earbud type aliases');
  assert.equal(AIID.verdict(earbudContract, { title: '소니 WH-1000XM5 노이즈캔슬링 헤드폰 블랙' }).tier, AIID.TIER.MISMATCH,
    'a WH over-ear headphone must not satisfy an earbud request');
  const twsContract = AIID.buildContract({ query: 'WF1000XM5 TWS 이어폰', userText: 'WF1000XM5 TWS 이어폰' });
  assert.equal(AIID.verdict(twsContract, { title: '소니 WF-1000XM5 노이즈캔슬링 무선 이어폰 블랙' }).tier, AIID.TIER.EXACT,
    'TWS feature token must not override the product type after a model-first query');
  assert.equal(COMP.parseComparison('게임용 말고 출퇴근용 헤드폰, 150,000원 이하로 골라 줘'), null,
    'an exclusion plus a budget comma is a single recommendation, not a comparison');

  const budgetIdentityQuestions = [
    '가격 상한 1,800,000원으로 스마트폰 후보를 찾아 줘',
    '스마트폰는 결제액 1,800,000원 안에서만 골라 줘',
    '1,800,000원을 넘기지 말고 스마트폰 추천해 줘',
    '스마트폰 구매 한도를 딱 1,800,000원으로 놓고 검색해 줘'
  ];
  assert.equal(INTENT.classify(budgetIdentityQuestions[2], []).query, '스마트폰',
    'a grouped won amount must stay intact while the prohibition clause is parsed');
  for (const question of budgetIdentityQuestions) {
    const r = await H.ask({ question }, { classify: 'C|스마트폰', answer: '검색한 스마트폰 후보를 확인했어요.' });
    assert.ok((r.body.items || []).length > 0, `${question}: budget language must not invalidate smartphone identity`);
    assert.ok((r.body.items || []).every(x => Number(x.lprice) <= 1800000), `${question}: candidate exceeded stated ceiling`);
    assert.doesNotMatch(r.body.text, /(?:조건에 맞는 상품을 찾지 못|이번 검색 결과에서 찾지 못)/);
  }

  const relaxation = require('../api/_noresult').relaxations(
    [{ price: 690000, title: '실제 검색 후보' }, { price: 790000, title: '두 번째 실제 후보' }],
    { budgetMax: 575000, budgetSoft: true, budgetSaid: 500000 }, []
  );
  assert.match(relaxation[0].label, /690,000원까지\(190,000원 더\)/,
    'relaxation delta must use the user-stated 500,000 won, not the internal 575,000 won soft ceiling');

  // A plausible but unsupported stock claim must be replaced, and even an
  // otherwise clean price answer must distinguish listing price from checkout.
  const stockQuestion = '맥북 에어 M3 스타라이트 재고 여부와 가격을 알려줘';
  const stockAnswer = await H.ask({ question: stockQuestion }, {
    classify: 'D|맥북 에어 M3 스타라이트',
    answer: '맥북 에어 M3 스타라이트는 재고가 있어요. 현재가는 1,350,000원입니다.'
  });
  assert.doesNotMatch(stockAnswer.body.text, /재고가 있어요/);
  assert.match(stockAnswer.body.text, /재고 보유 여부는 이 검색으로 확인하지 않았/);
  assert.match(stockAnswer.body.text, /실제 결제 금액.*판매처/);

  const plainPrice = await H.ask({ question: '맥북 에어 M3 스타라이트 현재가 알려줘' }, {
    classify: 'D|맥북 에어 M3 스타라이트',
    answer: '현재가는 1,350,000원이에요.'
  });
  assert.match(plainPrice.body.text, /(?:검색 결과 가격은 판매 페이지에 표시된 판매가|위 금액은 검색 결과에 표시된 판매가)/);
  assert.match(plainPrice.body.text, /실제 결제 금액.*판매처/);

  const priceComparison = COMP.formatComparison(
    ['그램15', '그램16'],
    [
      { title: 'LG전자 그램15 15ZD90S 인텔 i5 16GB 512GB 노트북', price: 1290000, mall: '쿠팡' },
      { title: 'LG전자 그램16 16Z90S 인텔 울트라7 32GB 1TB 노트북', price: 1590000, mall: '쿠팡' }
    ], 'search'
  );
  assert.match(priceComparison, /표시 가격 차이는 300,000원/);
  assert.match(priceComparison, /상품명에 표기된 차이/);
  assert.match(priceComparison, /16GB.*512GB/);
  assert.match(priceComparison, /32GB.*1TB/);
  assert.match(priceComparison, /실제 결제 금액.*판매처/);
  assert.match(priceComparison, /가격만 기준으로 고르면.*그램15/);

  const capacityComparison = COMP.formatComparison(
    ['필립스 HD9252', '코소리 CAF-L501'],
    [
      { title: '필립스 에어프라이어 HD9252 4.1L', price: 139000, mall: '쿠팡' },
      { title: '코소리 에어프라이어 5.5L CAF-L501', price: 99000, mall: '쿠팡' }
    ], 'search'
  );
  assert.match(capacityComparison, /4\.1L/);
  assert.match(capacityComparison, /5\.5L/);

  assert.equal(H.counters.external, 0);
  assert.equal(H.counters.dbWrites, 0);
  console.log(`AI_ANSWER_QUALITY ${cases.length} original contradiction cases + tablet/headphone/TWS identity and exclusion cases + 4 budget-identity cases + relaxation evidence + 2 comparisons PASS; real GPT 0, external 0, DB writes 0`);
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
