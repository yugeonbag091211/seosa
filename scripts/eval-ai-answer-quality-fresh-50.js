'use strict';

// A second, newly authored 50-question set. It is deliberately disjoint from
// the 1,250 reviewed questions and from the first fresh-50 set. All GPT and
// shopping responses are mocked; the production handler and fixture prices
// are real code/data paths, with no external calls or database writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./_ai-chat-harness');
const CAT = require('./_ai-eval-catalog');
const gradeAnswer = require('./audit-ai-answer-quality').grade;

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'reports/ai-answer-quality-2026-10-29/fresh-independent-50.jsonl');
CAT.PRODUCTS.forEach(product => H.addProduct(product));
const byPid = pid => CAT.PRODUCTS.filter(product => product.pid === pid);
const exact = (pid, vid) => ({ productId: pid, vendorItemId: vid || (byPid(pid)[0] || {}).vid });
const oneTurn = [];
const add = (group, question, classify, expected) => oneTurn.push({ group, question, classify, expected });

// Notebook and tablet body requests.
[
  ['notebook-body', '레노버 아이디어패드 슬림3 실물 노트북 본체 판매 페이지 보여 줘', 'D|레노버 아이디어패드 슬림3', exact('LT-IDEAPAD')],
  ['notebook-body', 'ASUS 비보북 15 X1504VA 기기 자체를 검색해 줘', 'D|ASUS 비보북 15 X1504VA', exact('LT-VIVO')],
  ['notebook-body', '갤럭시북4 NT750XGR 노트북 본품 가격 조회해 줘', 'D|갤럭시북4 NT750XGR', exact('LT-BOOK4')],
  ['notebook-body', '그램16 16Z90S 노트북 본체 제품만 보여 줘', 'D|그램16 16Z90S', exact('LT-GRAM16')],
  ['notebook-body', '맥북 에어 M3 스타라이트 노트북 기기 판매 옵션 찾아 줘', 'D|맥북 에어 M3 스타라이트', exact('LT-MBA-STAR')],
  ['tablet-body', '아이패드 11 A16 태블릿 기기 본체만 검색 부탁해', 'D|아이패드 11 A16', exact('TB-IPAD11')],
  ['tablet-body', 'S10 FE 갤럭시탭 본품을 케이스 없이 가격 확인해 줘', 'D|갤럭시탭 S10 FE', exact('TB-S10FE')],
  ['tablet-body', '아이패드 에어 M2 본체 판매 상품을 찾아 줘, 펜은 제외', 'D|아이패드 에어 M2', exact('TB-IPADAIR')],
  ['tablet-body', '레노버 탭 P12 태블릿 단말 자체의 가격을 확인해 줘', 'D|레노버 탭 P12', exact('TB-P12')],
  ['tablet-body', '갤럭시탭 S9 FE 본체 모델만 알려 줘', 'D|갤럭시탭 S9 FE', exact('TB-S9FE')]
].forEach(row => add(...row));

// Over-ear headset and TWS earbud identity must remain separate.
[
  ['headphone-type', '소니 WH1000XM5 블랙 오버이어 헤드폰 본체 찾아 줘', 'D|소니 헤드폰 XM5', exact('HP-XM5-BK')],
  ['headphone-type', 'WH-1000XM5 플래티넘 실버 헤드셋 판매 옵션 확인해 줘', 'D|소니 헤드폰 XM5 실버', exact('HP-XM5-SV')],
  ['headphone-type', '보스 QC 울트라 헤드폰 제품 페이지를 검색해 줘', 'D|보스 QC 울트라 헤드폰', exact('HP-QCU')],
  ['headphone-type', '에어팟 맥스 USB-C 스페이스그레이 헤드폰 가격 알려 줘', 'D|에어팟 맥스 USB-C 스페이스그레이', exact('HP-APMAX', 'HP-APMAX-GY')],
  ['headphone-type', '브리츠 W820 헤드셋 기기만 보여 주세요', 'D|브리츠 W820 헤드셋', exact('HP-DAILY')],
  ['earbud-type', 'WF1000XM5 무선 이어버드 이어폰 모델 찾아 줘', 'D|소니 이어폰 XM5', exact('EA-XM5')],
  ['earbud-type', '갤럭시 버즈3 프로 화이트 TWS 이어폰 옵션 알려 줘', 'D|갤럭시 버즈3 프로 화이트', exact('EA-BUDS3PRO', 'EA-BUDS3PRO-WH')],
  ['earbud-type', 'QCY T13 ANC 커널형 무선 이어폰을 검색해 줘', 'D|QCY T13 ANC', exact('EA-QCY')],
  ['earbud-type', 'JBL 튠 비즈2 블루투스 이어버드 판매가 확인해 줘', 'D|JBL 튠 비즈2', exact('EA-JBL')],
  ['earbud-type', '젠하이저 모멘텀 트루 와이어리스 4 TWS 상품을 찾아 줘', 'D|젠하이저 모멘텀 트루 와이어리스 4', exact('EA-MOMENTUM')]
].forEach(row => add(...row));

// Each side must be searched as its own exact product and grounded in the cards.
[
  ['그램15 15ZD90S하고 그램16 16Z90S 중 가격과 표기 사양 비교해 줘', ['그램15 15ZD90S', '그램16 16Z90S'], ['LT-GRAM15', 'LT-GRAM16']],
  ['아이패드 11 A16과 갤럭시탭 S10 FE 상품을 각각 찾아 차이를 알려 줘', ['아이패드 11 A16', '갤럭시탭 S10 FE'], ['TB-IPAD11', 'TB-S10FE']],
  ['WH-1000XM5와 보스 QC 울트라 헤드폰 두 모델을 비교해 줘', ['소니 헤드폰 XM5', '보스 QC 울트라'], ['HP-XM5-SV', 'HP-QCU']],
  ['아이패드 에어 M2 대 레노버 탭 P12 비교해 줘', ['아이패드 에어 M2', '레노버 탭 P12'], ['TB-IPADAIR', 'TB-P12']],
  ['버즈3 프로와 WF-1000XM5 이어폰의 가격 차이를 비교해 줘', ['갤럭시 버즈3 프로', '소니 이어폰 XM5'], ['EA-BUDS3PRO', 'EA-XM5']],
  ['갤럭시북4와 그램15 상품명 사양을 포함해 비교해 줘', ['갤럭시북4 NT750XGR', '그램15 15ZD90S'], ['LT-BOOK4', 'LT-GRAM15']],
  ['에어팟 프로 2세대와 에어팟 4세대의 검색 가격을 비교해 줘', ['에어팟 프로 2세대', '에어팟 4세대'], ['EA-APP2', 'EA-AP4']],
  ['소니 WH-1000XM5와 에어팟 맥스 USB-C 두 제품 중 어느 쪽이 더 싼지 비교해 줘', ['소니 헤드폰 XM5', '에어팟 맥스 USB-C'], ['HP-XM5-SV', 'HP-APMAX']],
  ['갤럭시탭 S9 FE vs 레노버 탭 P12 현재 판매가와 선택 기준 알려 줘', ['갤럭시탭 S9 FE', '레노버 탭 P12'], ['TB-S9FE', 'TB-P12']],
  ['그램16과 맥북 에어 M3 16GB 512GB 각각 검색해서 비교 부탁해', ['그램16 16Z90S', '맥북 에어 M3 16GB 512GB'], ['LT-GRAM16', 'LT-MBA-16']]
].forEach(([question, requested, ids]) => add('comparison', question, '', {
  productIds: ids, exactOffers: ids.map(pid => pid === 'EA-BUDS3PRO'
    ? exact(pid, 'EA-BUDS3PRO-WH') : pid === 'HP-APMAX' ? exact(pid, 'HP-APMAX-GY') : exact(pid)),
  comparison: true, requested
}));

// Budget and displayed-price/checkout distinction.
[
  ['budget', '15만 원을 넘지 않는 출퇴근용 헤드폰을 찾아 줘. 게임용은 제외', 'C|헤드폰', { productIds: ['HP-DAILY'], maxPrice: 150000, excludeTitle: /게이밍|gaming/i }],
  ['budget', '예산 15만원 안에서 데일리 헤드셋을 골라 주세요, 게이밍 제외', 'C|헤드셋', { productIds: ['HP-DAILY'], maxPrice: 150000, excludeTitle: /게이밍|gaming/i }],
  ['budget', '12만~15만원 사이 일상용 무선 헤드폰 중 하나 추천해 줘', 'C|헤드폰', { productIds: ['HP-DAILY'], maxPrice: 150000 }],
  ['budget', '예산 상한 50만원으로 WH-1000XM5 헤드폰 판매 옵션 검색해 줘', 'D|소니 헤드폰 XM5', { productIds: ['HP-XM5-SV'], maxPrice: 500000 }],
  ['budget', '25만원 이하 무선 이어폰 중 게이밍 말고 음악용 추천해 줘', 'C|무선 이어폰', { anyProductIds: ['EA-REDMI', 'EA-QCY', 'EA-BUDS3', 'EA-BUDS3PRO', 'EA-AP4', 'EA-AP4ANC'], maxPrice: 250000, excludeTitle: /게이밍|gaming/i }],
  ['price-checkout', '갤럭시탭 S9 FE의 검색 표시 가격과 결제액을 구분해서 알려 줘', 'D|갤럭시탭 S9 FE', { productIds: ['TB-S9FE'], price: true }],
  ['price-checkout', '에어팟 프로 2세대 현재 판매 페이지 가격만 알려 주고 결제 시 주의점도 설명해 줘', 'D|에어팟 프로 2세대', { productIds: ['EA-APP2'], price: true }],
  ['price-checkout', '비보북 15 X1504VA 얼마인지, 쿠폰 적용 전 표시가인지 알려 주세요', 'D|ASUS 비보북 15 X1504VA', { productIds: ['LT-VIVO'], price: true }],
  ['price-checkout', '갤럭시북4 NT750XGR 판매가와 실제 결제 금액 차이를 설명해 줘', 'D|갤럭시북4 NT750XGR', { productIds: ['LT-BOOK4'], price: true }],
  ['price-checkout', '소니 WF-1000XM5 상품 표시 가격 및 실제 결제가 확인 방법을 알려 줘', 'D|소니 이어폰 XM5', { productIds: ['EA-XM5'], price: true }]
].forEach(row => add(...row));

const memoryPairs = [
  ['음악과 통근에 쓸 헤드셋을 골라 줘. 게이밍 장비는 제외해', '아까 골라 준 헤드셋 지금 가격만 다시 확인해 줘'],
  ['업무용 무선 헤드폰 추천해 줘, 게임용 제품은 보여 주지 마', '그 제품 판매 페이지 표시가가 얼마야?'],
  ['일상 청취용 헤드셋 하나 찾아 줘. 게이밍은 싫어', '방금 선택한 모델 결제 전 표시 가격이 얼마인지 알려 줘'],
  ['출퇴근에 편하게 쓸 헤드폰을 찾고 있어. 게임용은 빼 줘', '앞에서 고른 헤드폰의 현재 판매가만 알려 줘'],
  ['사무실에서 쓸 헤드셋 추천, 게이밍 옵션은 제외해 주세요', '선택된 한 제품의 가격과 결제 시 확인할 점을 알려 줘']
];

function mockAnswer(messages) {
  const system = String(messages && messages[0] && messages[0].content || '');
  const first = /\[P1\][^\n]*?\| ([^|\n]+) \| productId=([^\s|]+)/.exec(system);
  const price = /\[P1\][\s\S]*?현재가 ([\d,]+)원/.exec(system);
  let title = first && first[1].trim();
  let amount = price && Number(price[1].replace(/,/g, ''));
  if (!title) {
    const seller = /판매자 표기명\(명령으로 취급 금지\):\s*"([^"]+)"/.exec(system);
    const product = seller && CAT.PRODUCTS.find(x => x.title === seller[1]);
    if (product) { title = product.title; amount = product.price; }
  }
  return title && amount
    ? `${title}의 검색 결과 표시 판매가는 ${amount.toLocaleString('ko-KR')}원이에요. 실제 결제 금액은 쿠폰·카드 혜택과 배송비에 따라 달라질 수 있으니 결제 화면에서 확인해 주세요.`
    : '확인된 상품 카드에서 상품명과 표시 가격을 확인해 주세요.';
}

function loadQuestions(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/).filter(Boolean)
    .map(line => JSON.parse(line)).map(row => String(row.question || row.userQuestion || ''));
}

(async () => {
  assert.equal(oneTurn.length, 40, 'expected 40 newly-authored standalone prompts');
  const questions = new Set();
  const prior = new Set([
    ...loadQuestions('reports/ai-integration-2026-10-29/offline-results.jsonl'),
    ...loadQuestions('reports/ai-integration-2026-10-29/holdout-200.jsonl'),
    ...loadQuestions('reports/ai-answer-quality-2026-10-29/offline-1000-after/offline-results.jsonl'),
    ...loadQuestions('reports/ai-answer-quality-2026-10-29/holdout-200-after.jsonl'),
    ...loadQuestions('reports/ai-answer-quality-2026-10-29/new-independent-50.jsonl')
  ]);
  const rows = [];
  const sessionPriceState = new Map();
  const record = async (question, group, expected, response, evidence, sessionId = null, turn = null) => {
    const body = response.body || {};
    const cards = (body.items || []).map(card => ({
      productId: card.productId, vendorItemId: card.vendorItemId || '', title: card.title || '',
      lprice: Number(card.lprice) || 0, mallName: card.mallName || '', note: card.note || ''
    }));
    const text = String(body.text || '');
    const issues = [];
    if (response.status !== 200 || !text.trim()) issues.push(`응답 실패 status=${response.status}`);
    for (const want of expected.exactOffers || (expected.productIds || []).map(pid => exact(pid))) {
      if (!cards.some(card => card.productId === want.productId && card.vendorItemId === want.vendorItemId && card.lprice > 0)) {
        issues.push(`정확한 상품 옵션 누락: ${want.productId}/${want.vendorItemId}`);
      }
    }
    if (expected.anyProductIds && !expected.anyProductIds.some(pid => cards.some(card => card.productId === pid && card.lprice > 0))) {
      issues.push(`적합 상품 후보 누락: ${expected.anyProductIds.join(',')}`);
    }
    if (expected.comparison && (cards.length !== 2 || !(body.comparison && body.comparison.complete))) issues.push('양쪽 독립 검색 또는 비교 완료 표시 누락');
    if (expected.maxPrice && cards.some(card => card.lprice > expected.maxPrice)) issues.push(`예산 초과 카드가 있음: ${expected.maxPrice}원`);
    if (expected.excludeTitle && cards.some(card => expected.excludeTitle.test(card.title))) issues.push('요청에서 제외한 게임용 카드가 포함됨');
    if (expected.price && cards.length && !text.includes(cards[0].lprice.toLocaleString('ko-KR') + '원')) issues.push('확인된 카드 가격이 본문에 없음');
    if (expected.price && cards.length && !/(?:실제 결제 금액|결제액|결제가는)/.test(text)) issues.push('표시가와 실제 결제액의 차이를 설명하지 않음');
    if (sessionId && turn === 2 && cards.length !== 1) issues.push('후속 질문에서 핵심 카드 하나만 반환하지 않음');
    if (sessionId && turn === 2 && cards.some(card => /게이밍|gaming/i.test(card.title))) issues.push('후속 턴에서 게이밍 제외 조건이 사라짐');
    if (cards.length && /(?:일치하는 상품을 확인하지 못|조건에 맞는 상품을 찾지 못|상품을 찾지 못했어요)/.test(text)) issues.push('상품 카드와 본문이 모순됨');
    const functionVerdict = issues.length ? 'FAIL' : 'PASS';
    const prior = sessionId ? sessionPriceState.get(sessionId) || { prices: [], top: '' } : { prices: [], top: '' };
    const previousPrices = prior.prices.slice();
    previousPrices.__topProductId = prior.top;
    const audit = gradeAnswer({ question, category: expected.comparison ? 'compare' : group,
      expected: JSON.stringify(expected), text, cards, searchEvidence: evidence,
      priceHistoryEvidence: H.priceHistoryEvidenceForCards(body.items || []), comparison: body.comparison || null,
      session: sessionId, turn, sessionKind: sessionId ? 'gaming-exclusion' : null,
      reusePreviousCard: !!body.reusePreviousCard, topProductId: body.topProductId || null }, previousPrices);
    const qualityKeys = Object.keys(audit.quality);
    const qualityPass = qualityKeys.every(key => audit.quality[key].verdict === 'PASS');
    rows.push({ question, group, expected, functionVerdict, functionIssues: issues,
      answerQualityVerdict: qualityPass ? 'PASS' : 'FAIL', quality: audit.quality, errorCause: audit.errorCause,
      answerSource: 'mock GPT + real handler + fixture shopping; no external API',
      text, cards, searchEvidence: evidence,
      priceHistoryEvidence: H.priceHistoryEvidenceForCards(body.items || []),
      comparison: body.comparison || null, status: response.status || 0, session: sessionId, turn,
      topProductId: body.topProductId || null,
      actualGptCalls: 0, apiCostUsd: 0 });
    if (sessionId) {
      prior.prices.push(...cards.map(card => Number(card.lprice)).filter(Boolean));
      prior.top = body.topProductId || (cards[0] && cards[0].productId) || prior.top;
      sessionPriceState.set(sessionId, prior);
    }
    return rows[rows.length - 1];
  };
  const run = async (test, session, sessionId, turn) => {
    assert.ok(!questions.has(test.question), `duplicate new question: ${test.question}`);
    assert.ok(!prior.has(test.question), `question overlaps prior test sets: ${test.question}`);
    questions.add(test.question);
    const evidenceStart = H.searchEvidenceLog.length;
    const response = session
      ? await session.say(test.question, { classify: test.classify, answer: mockAnswer })
      : await H.ask({ question: test.question }, { classify: test.classify, answer: mockAnswer });
    await record(test.question, test.group, test.expected, response, H.searchEvidenceLog.slice(evidenceStart), sessionId, turn);
  };
  for (const test of oneTurn) await run(test, null, null, null);
  memoryPairs.forEach((pair, i) => {
    pair.forEach((question, turn) => oneTurn.push({
      group: 'conversation-memory', question,
      classify: turn === 0 ? 'C|헤드셋' : 'D|브리츠 헤드셋',
      expected: turn === 0
        ? { productIds: ['HP-DAILY'], excludeTitle: /게이밍|gaming/i }
        : { productIds: ['HP-DAILY'], price: true, excludeTitle: /게이밍|gaming/i }
    }));
  });
  // The memory questions are intentionally run as five persistent conversations.
  for (let i = 0; i < memoryPairs.length; i++) {
    const session = H.session();
    for (let turn = 0; turn < 2; turn++) {
      const test = oneTurn[40 + i * 2 + turn];
      assert.ok(!questions.has(test.question), `duplicate new question: ${test.question}`);
      assert.ok(!prior.has(test.question), `question overlaps prior test sets: ${test.question}`);
      questions.add(test.question);
      const evidenceStart = H.searchEvidenceLog.length;
      const response = await session.say(test.question, { classify: test.classify, answer: mockAnswer });
      let expected = test.expected;
      if (turn === 1) {
        const previous = rows[rows.length - 1];
        const selected = previous.cards.find(card => card.productId === previous.topProductId) || previous.cards[0];
        expected = Object.assign({}, expected, {
          productIds: selected ? [selected.productId] : [],
          exactOffers: selected ? [{ productId: selected.productId, vendorItemId: selected.vendorItemId }] : []
        });
      }
      await record(test.question, test.group, expected, response, H.searchEvidenceLog.slice(evidenceStart), i + 1, turn + 1);
    }
  }
  assert.equal(rows.length, 50);
  const functionPass = rows.filter(row => row.functionVerdict === 'PASS').length;
  const qualityPass = rows.filter(row => row.answerQualityVerdict === 'PASS').length;
  const grouped = {};
  for (const row of rows) {
    const group = grouped[row.group] || (grouped[row.group] = { questions: 0, functionPass: 0, qualityPass: 0, fail: 0 });
    group.questions++;
    if (row.functionVerdict === 'PASS') group.functionPass++;
    if (row.answerQualityVerdict === 'PASS') group.qualityPass++;
    if (row.functionVerdict === 'FAIL' || row.answerQualityVerdict === 'FAIL') group.fail++;
  }
  const summary = { kind: 'FRESH_50_OFFLINE_MOCK_GPT_QUALITY_AUDIT', questions: rows.length,
    uniqueQuestions: questions.size, overlapQuestions: 0, functionPass, answerQualityPass: qualityPass,
    failed: rows.length - rows.filter(row => row.functionVerdict === 'PASS' && row.answerQualityVerdict === 'PASS').length,
    groups: grouped, mockedModelAnswerCalls: H.counters.llmMain, actualGptCalls: 0,
    marketplaceCalls: H.counters.external, dbWrites: H.counters.dbWrites, apiCostUsd: 0,
    corpusSha256: require('crypto').createHash('sha256').update(rows.map(row => row.question).join('\n')).digest('hex'),
    naturalnessScope: 'five independent rubric dimensions; naturalness uses a strict rule-based screen, not a human or model judge' };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  fs.writeFileSync(OUT.replace(/\.jsonl$/i, '.summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary));
  assert.equal(functionPass, 50, 'all new functional scenarios must pass');
  assert.equal(qualityPass, 50, 'all new answer quality scenarios must pass');
  assert.equal(H.counters.external, 0, 'fresh offline test must not call external APIs');
  assert.equal(H.counters.dbWrites, 0, 'fresh offline test must not write a database');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
