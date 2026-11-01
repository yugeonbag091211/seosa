'use strict';

// Answer-quality regressions are deliberately separate from card/function checks.
const assert = require('node:assert/strict');
const H = require('./_ai-chat-harness');
const CAT = require('./_ai-eval-catalog');
const COMP = require('../api/_ai-comparison');
const AIID = require('../api/_aiidentity');
const INTENT = require('../api/_intent');
const ANSWER_QUALITY = require('./audit-ai-answer-quality').grade;
const GROUNDED_ANSWER = require('../api/_ai-grounded-answer');

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
  assert.deepEqual(COMP.parseComparison('WH-1000XM5와 보스 QC 울트라 헤드폰 두 모델을 비교해 줘'),
    ['소니 헤드폰 WH-1000XM5', '보스 QC 울트라 헤드폰'],
    'a WH-1000XM5 anchor identifies the over-ear model family, not WF/TWS earbuds');
  assert.equal(INTENT.extractUseCase('업무용 헤드폰, 게임용 제품은 보여 주지 마'), '업무',
    'a negative gaming clause must not override the positive work use case');
  assert.equal(require('../api/_ai-budget-window').gamingPreference('게임용 제품은 보여 주지 마'), true,
    '"게임용 제품은 보여 주지 마" must establish a persistent gaming exclusion');
  assert.equal(INTENT.extractUseCase('게이밍 말고 음악용 무선 이어폰 추천'), '음악 감상',
    'a negated gaming mention must not become the requested use case');
  assert.equal(GROUNDED_ANSWER.isProductSpecQuestion('그램16 16Z90S 얼마야?'), false,
    'the "그램" laptop family name must not be mistaken for a RAM specification request');
  assert.equal(GROUNDED_ANSWER.isProductSpecQuestion('갤럭시탭 S10 FE 무게 얼마나 나가?'), true,
    'the word "얼마나" in a weight question must not be mistaken for a price question');
  assert.equal(GROUNDED_ANSWER.isProductSpecQuestion('노스페이스 눕시 M 사이즈 얼마야?'), false,
    'an option-size query asking "얼마야" is a product-price request, not a clothing measurement question');
  assert.equal(GROUNDED_ANSWER.isProductSpecQuestion('스타벅스 하우스블렌드 원두 칼로리 얼마야?'), true,
    'an amount question about calories is a nutrition request, not a product-price request');
  const particleTitle = 'Apple 맥북 에어 13 M3 16GB 512GB 미드나이트';
  assert.equal(GROUNDED_ANSWER.repairProductParticles(`${particleTitle}을 먼저 안내해요.`, [{ title: particleTitle }]),
    `${particleTitle}를 먼저 안내해요.`, 'product particles should agree with the final Hangul syllable');
  assert.equal(INTENT.classify('코소리 에어프라이어 5.5L 가격 떨어진 거 맞아?', []).query.includes('5.5L'), true,
    'decimal liter capacity is part of the exact product identity and must remain intact in history searches');
  const coffeeHistoryIntent = INTENT.classify('스타벅스 하우스블렌드 원두 최근 한 달 가격 흐름 알려줘', []);
  assert.equal(coffeeHistoryIntent.intent, 'E');
  assert.equal(AIID.verdict(AIID.buildContract({ query: coffeeHistoryIntent.query, userText: '스타벅스 하우스블렌드 원두 최근 한 달 가격 흐름 알려줘' }),
    { title: '스타벅스 하우스블렌드 원두 1.13kg' }).tier, AIID.TIER.EXACT,
  'history wording must not break an exact coffee-bean product identity');

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

  const musicEarbuds = await H.ask({ question: '25만원 이하 무선 이어폰 중 게이밍 말고 음악용 추천해 줘' }, {
    classify: 'C|무선 이어폰', answer: '확인된 상품 정보를 안내할게요.'
  });
  assert.ok((musicEarbuds.body.items || []).length > 0,
    'music use-case wording must retain the explicit wireless-earbud category in the search');
  assert.ok((musicEarbuds.body.items || []).every(x => !/게이밍|gaming/i.test(x.title)),
    'the gaming exclusion must filter product cards');

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
  assert.match(priceComparison, /실제 결제 금액.*결제 화면/);
  assert.match(priceComparison, /가격을 우선하면 첫 번째 상품이 유리/);
  assert.doesNotMatch(priceComparison, /이\(가\)|을\(를\)/);
  assert.equal((priceComparison.match(/300,000원/g) || []).length, 1,
    'the confirmed price difference must be stated once, without repeating the same rationale');

  const capacityComparison = COMP.formatComparison(
    ['필립스 HD9252', '코소리 CAF-L501'],
    [
      { title: '필립스 에어프라이어 HD9252 4.1L', price: 139000, mall: '쿠팡' },
      { title: '코소리 에어프라이어 5.5L CAF-L501', price: 99000, mall: '쿠팡' }
    ], 'search'
  );
  assert.match(capacityComparison, /4\.1L/);
  assert.match(capacityComparison, /5\.5L/);

  // The answer-quality evaluator must reject deliberately injected defects,
  // independently of function/card success. This prevents the rubric from
  // passing the exact classes of errors found in the recorded answers.
  const title1 = 'LG전자 그램15 15ZD90S 인텔 i5 16GB 512GB 노트북';
  const title2 = 'LG전자 그램16 16Z90S 인텔 울트라7 32GB 1TB 노트북';
  const compareCards = [
    { productId: 'LT-GRAM15', vendorItemId: 'LT-GRAM15-V1', title: title1, lprice: 1290000 },
    { productId: 'LT-GRAM16', vendorItemId: 'LT-GRAM16-V1', title: title2, lprice: 1590000 }
  ];
  const goodCompare = {
    question: '그램15랑 그램16 비교해줘', category: 'compare',
    text: `두 상품을 각각 검색해 확인했어요.\n1. ${title1} — 1,290,000원\n2. ${title2} — 1,590,000원\n표시 가격 차이는 300,000원이고, 첫 번째 상품이 더 저렴해요.\n상품명 표기 차이: 첫 번째 16GB, 512GB, i5; 두 번째 32GB, 1TB, 울트라7.\n선택 기준: 가격을 우선하면 첫 번째 상품이 유리해요. 실제 성능 우열은 이 정보만으로 판단하기 어려워요.\n표시 가격은 실제 결제 금액과 다를 수 있으니 쿠폰과 배송비를 결제 화면에서 확인해 주세요.`,
    cards: compareCards, searchEvidence: [], comparison: { complete: true },
    session: null, turn: null, sessionKind: null, reusePreviousCard: false
  };
  assert.deepEqual(Object.values(ANSWER_QUALITY(goodCompare, []).quality).map(x => x.verdict),
    ['PASS', 'PASS', 'PASS', 'PASS', 'PASS'], 'grounded concise comparison should pass all five independent criteria');
  const gradeBad = (row, text) => ANSWER_QUALITY(Object.assign({}, row, { text }), []).quality;
  assert.equal(gradeBad(goodCompare, goodCompare.text.replace('더 저렴해요', '더 저렴해요. 표시 가격 차이는 300,000원')).naturalness.verdict, 'FAIL',
    'duplicate price rationale must fail naturalness');
  assert.equal(gradeBad(goodCompare, goodCompare.text.replace('선택 기준: 가격을 우선하면 첫 번째 상품이 유리해요. ', '')).questionSatisfaction.verdict, 'FAIL',
    'comparison without an actionable selection basis must fail satisfaction');
  assert.equal(gradeBad(goodCompare, goodCompare.text.replace('첫 번째 상품이 더 저렴해요', '첫 번째 상품이 더 저렴해요. 그 상품이(가) 최고예요')).naturalness.verdict, 'FAIL',
    'exposed Korean particle placeholders must fail naturalness');
  assert.equal(gradeBad({ ...goodCompare, category: 'search', question: `${particleTitle} 얼마야?`, cards: [{ productId: 'LT-MBA-16', title: particleTitle, lprice: 1890000 }] },
    `${particleTitle}을 추천해요. 현재가는 1,890,000원이에요.`).naturalness.verdict, 'FAIL',
    'a grammatically mismatched particle after an exact product title must fail naturalness');
  assert.equal(gradeBad(goodCompare, goodCompare.text + ' 실제 결제 금액은 1,290,000원입니다.').priceSpecEvidence.verdict, 'FAIL',
    'an unsupported checkout amount must fail price evidence even when it matches a listing price');
  assert.equal(gradeBad(goodCompare, goodCompare.text + ' 배터리는 72시간 사용할 수 있어요.').priceSpecEvidence.verdict, 'FAIL',
    'an unsupported specification must fail evidence');
  const contradictory = ANSWER_QUALITY({
    question: '아이패드 11 A16 현재가 알려줘', category: 'search',
    expected: '요청 모델 TB-IPAD11 판매 상품 확인', text: '일치하는 상품을 확인하지 못했어요.',
    cards: [{ productId: 'TB-IPAD11', vendorItemId: 'TB-IPAD11-V1', title: 'Apple 아이패드 11 A16 128GB', lprice: 499000 }],
    searchEvidence: [], comparison: null
  }, []);
  assert.equal(contradictory.quality.accuracy.verdict, 'FAIL',
    'the evaluator must fail a no-result answer that contradicts its exact product card');
  assert.equal(gradeBad(goodCompare, goodCompare.text.replace('상품명 표기 차이: 첫 번째 16GB, 512GB, i5; 두 번째 32GB, 1TB, 울트라7.', '')).questionSatisfaction.verdict, 'FAIL',
    'the evaluator must require verified listed-spec differences when they are available');
  const repeatedCardFact = ANSWER_QUALITY({
    question: '갤럭시 A35 128GB 가격 알려 줘', category: 'search',
    text: '첫 번째 추천 카드: 삼성전자 갤럭시 A35 128GB 자급제 — 499,000원. 삼성전자 갤럭시 A35 128GB 자급제의 표시 가격은 499,000원이에요. 실제 결제액은 쿠폰과 배송비에 따라 달라질 수 있어요.',
    cards: [{ productId: 'PH-A35', vendorItemId: 'PH-A35-V1', title: '삼성전자 갤럭시 A35 128GB 자급제', lprice: 499000 }],
    searchEvidence: [], comparison: null
  }, []);
  assert.equal(repeatedCardFact.quality.naturalness.verdict, 'FAIL',
    'the evaluator must flag a card title and exact card price repeated in the body');

  const unresponsiveSpec = ANSWER_QUALITY({
    question: '맥북 에어 M3 16GB 512GB 무게 몇 kg이야?', category: 'spec',
    text: 'Apple 맥북 에어를 먼저 추천드려요. 현재가는 1,890,000원이에요.',
    cards: [{ productId: 'LT-MBA-16', vendorItemId: 'LT-MBA-16-V1', title: 'Apple 맥북 에어 13 M3 16GB 512GB', lprice: 1890000 }],
    searchEvidence: [], priceHistoryEvidence: [], comparison: null
  }, []);
  assert.equal(unresponsiveSpec.quality.questionSatisfaction.verdict, 'FAIL',
    'a correct card and price cannot pass a spec question that never answers or discloses missing weight data');

  const unresponsiveHistory = ANSWER_QUALITY({
    question: '갤럭시탭 S10 FE 최저가 기록은 언제였어?', category: 'history',
    text: '갤럭시탭 S10 FE를 추천드려요. 현재가는 629,000원이에요.',
    cards: [{ productId: 'TB-S10FE', vendorItemId: 'TB-S10FE-V1', title: '삼성전자 갤럭시탭 S10 FE 128GB', lprice: 629000 }],
    searchEvidence: [], priceHistoryEvidence: [{ productId: 'TB-S10FE', vendorItemId: 'TB-S10FE-V1', mall: '쿠팡', price: 629000, observedDate: '2026-10-29' }],
    comparison: null
  }, []);
  assert.equal(unresponsiveHistory.quality.questionSatisfaction.verdict, 'FAIL',
    'a current price cannot pass a historical-low date question without addressing the available record');

  // These real-handler regressions reproduce answers that passed card checks
  // while ignoring the requested spec or price-history question.
  const targetedAnswerCases = [
    ['맥북 에어 M3 16GB 512GB 무게 몇 kg이야?', 'D|맥북 에어 M3 16GB 512GB', /무게|확인할 수 없|확인되지 않/],
    ['맥북 에어 M3 16GB 512GB 영상 편집할 만한 성능이야?', 'D|맥북 에어 M3 16GB 512GB', /영상 편집|성능|확인할 수 없|판단하기 어렵/],
    ['갤럭시탭 S10 FE 지금 할인 중이야?', 'E|갤럭시탭 S10 FE', /할인|정가|표시 가격/],
    ['갤럭시탭 S10 FE 더 기다리는 게 나아?', 'E|갤럭시탭 S10 FE', /가격 기록|기록이|판단하기 어렵/],
    ['갤럭시탭 S10 FE 최저가 기록은 언제였어?', 'E|갤럭시탭 S10 FE', /기록|관측|최저가/],
    ['코소리 에어프라이어 5.5L 최근 한 달 가격 흐름 알려줘', 'E|코소리 에어프라이어 5.5L', /기록|관측|가격 흐름/],
    ['스타벅스 하우스블렌드 원두 최근 한 달 가격 흐름 알려줘', 'E|스타벅스 하우스블렌드 원두', /기록|관측|가격 흐름/],
    ['스타벅스 하우스블렌드 원두 칼로리 얼마야?', 'D|스타벅스 하우스블렌드 원두', /칼로리|확인할 수 없|확인되지 않/]
  ];
  for (const [question, classify, topic] of targetedAnswerCases) {
    const r = await H.ask({ question }, { classify, answer: '삼성전자 갤럭시탭 S10 FE를 먼저 추천드려요. 현재가는 629,000원으로 확인돼요.' });
    assert.match(r.body.text, topic, `${question}: answer must address the requested fact\n${r.body.text}`);
    assert.doesNotMatch(r.body.text, /먼저 추천드려요/, `${question}: do not replace a fact question with an unsolicited recommendation`);
  }
  const cosoriHistory = await H.ask({ question: '코소리 에어프라이어 5.5L 최근 한 달 가격 흐름 알려줘' }, {
    classify: 'E|코소리 에어프라이어 5.5L', answer: '검색된 상품을 추천드려요.'
  });
  assert.ok((cosoriHistory.body.items || []).some(x => x.productId === 'AP-COSORI' && x.vendorItemId === 'AP-COSORI-V1'),
    'decimal capacity history question must retain the exact product and vendorItemId');
  assert.match(cosoriHistory.body.text, /가격 기록|관측/);
  const northfaceSizePrice = await H.ask({ question: '노스페이스 눕시 M 사이즈 얼마야?' }, {
    classify: 'D|노스페이스 눕시 M', answer: 'M 옵션 가격을 확인했어요.'
  });
  assert.match(northfaceSizePrice.body.text, /379,000원/,
    'an M-size option-price question must include its verified card price');
  assert.doesNotMatch(northfaceSizePrice.body.text, /사이즈 자료가 없어/);


  // CROSS_PRODUCT_EVIDENCE_20261029 — negative controls must fail the rubric,
  // even when a different search hit actually has the claimed price/spec.
  const matchedOffer = { productId: 'QA-A', vendorItemId: 'QA-A-V1',
    title: '검증용 노트북 A 8GB 256GB', lprice: 500000 };
  const unrelatedOffer = { productId: 'QA-B', vendorItemId: 'QA-B-V1',
    title: '검증용 노트북 B 32GB 1TB', lprice: 690000 };
  const unrelatedEvidence = [matchedOffer, unrelatedOffer];
  const borrowedPrice = ANSWER_QUALITY({
    question: '검증용 노트북 A 판매가 얼마야?', category: 'search',
    text: '검증용 노트북 A의 현재가는 690,000원이에요. 실제 결제 금액은 판매처에서 확인해 주세요.',
    cards: [matchedOffer], searchEvidence: unrelatedEvidence, priceHistoryEvidence: []
  }, []);
  assert.equal(borrowedPrice.quality.priceSpecEvidence.verdict, 'FAIL',
    'a different search candidate must not authenticate the selected option price');
  const borrowedSpec = ANSWER_QUALITY({
    question: '검증용 노트북 A 램 사양 알려줘', category: 'spec',
    text: '검증용 노트북 A는 32GB 램을 장착했어요.',
    cards: [matchedOffer], searchEvidence: unrelatedEvidence, priceHistoryEvidence: []
  }, []);
  assert.equal(borrowedSpec.quality.priceSpecEvidence.verdict, 'FAIL',
    'a different search candidate must not authenticate the selected option specification');

  // BUDGET_RELAXATION_PROVENANCE_20261029: an explicitly unselected over-cap
  // candidate may be quoted in a budget relaxation, but is not an option price.
  const budgetRow = {
    question: '스마트폰 40만원 이하 추천해줘', category: 'budget',
    text: '40만원 이하 상품은 이번 검색 결과에 없었어요. 예산을 499,000원까지(99,000원 더) 늘리면 후보가 있어요.',
    cards: [], searchEvidence: [{ productId: 'QA-PHONE', vendorItemId: 'QA-PHONE-V1',
      title: '검증용 스마트폰', lprice: 499000 }], priceHistoryEvidence: []
  };
  assert.equal(ANSWER_QUALITY(budgetRow, []).quality.priceSpecEvidence.verdict, 'PASS',
    'a genuine unmatched over-budget search offer may support a clearly labeled relaxation');
  assert.equal(ANSWER_QUALITY({ ...budgetRow, text: budgetRow.text + ' 또는 777,000원이면 확실해요.' }, []).quality.priceSpecEvidence.verdict, 'FAIL',
    'unverified relaxation amount must still fail even in no-result guidance');

  const validPrice = ANSWER_QUALITY({
    question: '검증용 노트북 A 판매가 얼마야?', category: 'search',
    text: '검증용 노트북 A의 표시 판매가는 500,000원이에요. 실제 결제 금액은 판매처에서 확인해 주세요.',
    cards: [matchedOffer], searchEvidence: unrelatedEvidence, priceHistoryEvidence: []
  }, []);
  assert.equal(validPrice.quality.priceSpecEvidence.verdict, 'PASS',
    'matching option price remains supported');

  // A vague model fallback may not send the user away to read a price card.
  for (const [question, classify, productId, price] of [
    ['갤럭시탭 S9 FE의 검색 표시 가격과 결제액을 구분해서 알려 줘', 'D|갤럭시탭 S9 FE', 'TB-S9FE', 479000],
    ['레노버 탭 P12 태블릿 단말 자체의 가격을 확인해 줘', 'D|레노버 탭 P12', 'TB-P12', 329000]
  ]) {
    const reply = await H.ask({ question }, { classify,
      answer: '확인된 상품 카드에서 상품명과 표시 가격을 확인해 주세요.' });
    const matched = (reply.body.items || []).find(c => c.productId === productId);
    assert.ok(matched && Number(matched.lprice) === price, question + ': exact priced card missing');
    assert.match(reply.body.text, new RegExp('표시 판매가는 ' + price.toLocaleString('en-US') + '원'),
      question + ': server must answer the verified listing price directly');
    assert.doesNotMatch(reply.body.text, /확인된 상품 카드에서 상품명과 (?:표시 )?가격을 확인해 주세요/,
      question + ': vague card-only model fallback escaped to the user');
    assert.match(reply.body.text, /실제 결제 금액/, question + ': checkout price is distinct');
  }


  // RELEASE_15_REPRO_20261029: seven distinct price-history products, two
  // user intents each.  A correct listing price alone is not the answer.
  const historyQualityTargets = [
    ['에어팟 프로 2세대', 'EA-APP2'],
    ['코웨이 공기청정기 AP-1019C', 'AP-COWAY'],
    ['소니 WH-1000XM5 블랙', 'HP-XM5-BK'],
    ['코소리 에어프라이어 5.5L', 'AP-COSORI'],
    ['그램16 16Z90S', 'LT-GRAM16'],
    ['나이키 에어포스1 화이트 270', 'CL-AF1-WH'],
    ['스타벅스 하우스블렌드 원두', 'FD-SBUX']
  ];
  for (const [model, id] of historyQualityTargets) {
    for (const suffix of ['가격 떨어진 거 맞아?', '이 가격이면 싼 편이야?']) {
      const question = model + ' ' + suffix;
      const start = H.searchEvidenceLog.length;
      const reply = await H.ask({ question }, {
        classify: 'E|' + model,
        answer: () => '먼저 추천드려요. 현재가는 검색 결과에 나온 금액이에요. 실제 결제가는 판매처에서 확인해 주세요.'
      });
      const cards = (reply.body.items || []).map(c => ({
        productId: c.productId, vendorItemId: c.vendorItemId, title: c.title,
        lprice: Number(c.lprice), note: c.note || ''
      }));
      assert.ok(cards.some(c => c.productId === id), question + ': expected verified model');
      const graded = ANSWER_QUALITY({
        question, category: 'history', text: reply.body.text, cards,
        searchEvidence: H.searchEvidenceLog.slice(start).flat(),
        priceHistoryEvidence: H.priceHistoryEvidenceForCards(reply.body.items || [])
      }, []);
      assert.equal(graded.quality.questionSatisfaction.verdict, 'PASS',
        question + ': price history/cheapness answer must directly address the question: ' + reply.body.text);
      assert.doesNotMatch(reply.body.text,
        /(?:무조건 최저가|반드시 내려|확실히 더 싸질)/,
        question + ': do not invent a price-history verdict');
    }
  }

  const explicitPhilipsSession = H.session();
  const forPhilips = [
    ['공기청정기 35만원 아래 제품 찾아 줘', 'C|공기청정기'],
    ['소음 적은 가정용이면 좋겠어', 'C|공기청정기'],
    ['이번엔 에어프라이어 12만원 이하로 검색', 'C|에어프라이어'],
    ['예산은 그대로 두고 필립스 모델만', 'D|필립스 에어프라이어']
  ];
  let philipsReply;
  for (const [question, classify] of forPhilips) {
    philipsReply = await explicitPhilipsSession.say(question, {
      classify, answer: () => '코소리 에어프라이어 5.5L CAF-L501 기준으로 현재가는 99,000원입니다.'
    });
  }
  assert.equal((philipsReply.body.items || []).length, 0,
    'the 120,000-won ceiling must continue to exclude the 139,000-won Philips option');
  assert.doesNotMatch(philipsReply.body.text, /코소리|5\\.5L|99,000원/,
    'a Philips-only follow-up may not reuse the previously selected Cosori model/spec/price');
  assert.match(philipsReply.body.text, /필립스|예산|조건|확인|찾지 못/,
    'the response must explain the missing requested offer rather than silently switching products');


  // A previous signed-session user budget is the only acceptable numeric
  // provenance for "예산은 그대로"; other brands' prices cannot authorize it.
  const inheritedBudgetState = [];
  inheritedBudgetState.__budgetMax = 120000;
  const philipsBudgetEvidence = {
    question: '예산은 그대로 두고 필립스 모델만', category: 'conversation', session: 'qa:5', turn: 4,
    cards: [], searchEvidence: [
      { productId: 'QA-PHILIPS', vendorItemId: 'QA-PHILIPS-V1', title: '필립스 에어프라이어 4.1L', lprice: 139000 },
      { productId: 'QA-COSORI', vendorItemId: 'QA-COSORI-V1', title: '코소리 에어프라이어 5.5L', lprice: 99000 }
    ], priceHistoryEvidence: [],
    text: '필립스 모델은 예산 12만원 이하 상품이 이번 검색 결과에 없었어요. 예산을 139,000원까지(19,000원 더) 늘리면 선택할 수 있어요.'
  };
  assert.equal(ANSWER_QUALITY(philipsBudgetEvidence, inheritedBudgetState).quality.priceSpecEvidence.verdict, 'PASS',
    'verified exact-brand budget relaxation must pass with signed previous user budget');
  assert.equal(ANSWER_QUALITY({ ...philipsBudgetEvidence,
    text: philipsBudgetEvidence.text + ' 코소리 가격은 99,000원입니다.' }, inheritedBudgetState).quality.priceSpecEvidence.verdict, 'FAIL',
    'an unrelated brand must not be allowed as a Philips offer price');
  assert.equal(ANSWER_QUALITY(philipsBudgetEvidence, []).quality.priceSpecEvidence.verdict, 'FAIL',
    'a prior signed user budget is mandatory for inherited-budget arithmetic');

  assert.equal(H.counters.external, 0);
  assert.equal(H.counters.dbWrites, 0);
  console.log(`AI_ANSWER_QUALITY ${cases.length} original contradiction cases + tablet/headphone/TWS identity and exclusion cases + 4 budget-identity cases + relaxation evidence + 2 comparisons + injected evaluator defects PASS; real GPT 0, external 0, DB writes 0`);
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
