'use strict';

/*
 * 50 genuinely new prompts for answer quality, run through the real handler
 * with a faithful mock GPT and fixture shopping results. This is intentionally
 * reported separately from both the 1,000 prompt suite and 200-question holdout.
 */
const fs = require('fs');
const path = require('path');
const H = require('./_ai-chat-harness');
const CAT = require('./_ai-eval-catalog');

CAT.PRODUCTS.forEach(p => H.addProduct(p));
H.addProduct({ pid: 'NX-BOOK', vid: 'NX-BOOK-V1', title: '[국내도서] 노트북 활용 AI 강의 교재', price: 18000, keys: ['노트북', '강의'], mall: '쿠팡' });
H.addProduct({ pid: 'NX-TAB-PEN', vid: 'NX-TAB-PEN-V1', title: '갤럭시탭 S10 FE 호환 S펜 스타일러스', price: 29000, keys: ['갤럭시탭', 'S펜', '스타일러스'], mall: '쿠팡' });

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'reports/ai-answer-quality-2026-10-29/new-independent-50.jsonl');
const baselineFiles = [
  'reports/ai-integration-2026-10-29/offline-results.jsonl',
  'reports/ai-integration-2026-10-29/holdout-200.jsonl'
];
const readQuestions = file => fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/).filter(Boolean)
  .map(line => { try { return JSON.parse(line).userQuestion || JSON.parse(line).question || ''; } catch (_) { return ''; } });
const baseline = new Set(baselineFiles.flatMap(readQuestions));
const cases = [];
const add = (group, question, classify, expected = {}) => cases.push({ group, question, classify, expected });

// Exact laptop body prompts with a hostile course/book search hit in the fixture.
[
  'ASUS 비보북 15 X1504VA 노트북 본체를 찾아 줘',
  'X1504VA 비보북 본체 판매가만 확인해 줘',
  '사무용 노트북으로 ASUS X1504VA 옵션이 있는지 조회해 줘',
  '강의책은 말고 ASUS 비보북 X1504VA 본체 가격을 알려 줘',
  'ASUS 비보북 15 X1504VA 실물 노트북 판매 상품을 보여 줘'
].forEach(q => add('notebook-body', q, 'D|ASUS 비보북 15 X1504VA', { productId: 'LT-VIVO', excludeTitle: /도서|강의|교재/ }));

// Tablet body prompts return the tablet, never a case, pen or compatibility accessory.
[
  '아이패드 11 A16 본체만 검색해 줘',
  '아이패드 11세대 태블릿 본품 판매 페이지 찾아 줘',
  '케이스 말고 아이패드 11 와이파이 모델 가격 알려 줘',
  'Apple 아이패드 11 A16 기기 본체를 구매하려고 해, 판매 상품 보여 줘',
  '아이패드 11 태블릿 본체 옵션이 등록됐는지 확인해 줘'
].forEach(q => add('tablet-body', q, 'D|아이패드 11', { productId: 'TB-IPAD11', excludeTitle: /케이스|스타일러스|터치펜|호환/i }));
[
  '갤럭시탭 S10 FE 태블릿 본체만 찾아 줘',
  '갤럭시탭 S10 FE 본체 가격 확인해 줘, 펜은 필요 없어',
  'S10 FE 삼성 태블릿 실물 기기 판매처를 알려 줘',
  '스타일러스 말고 갤럭시탭 S10 FE 본체만 보여 줘',
  '갤럭시탭 S10 FE 128GB 태블릿 구매 옵션 조회 부탁해'
].forEach(q => add('tablet-body', q, 'D|갤럭시탭 S10 FE', { productId: 'TB-S10FE', excludeTitle: /케이스|스타일러스|터치펜|호환/i }));

// WH-1000XM5 headset and WF-1000XM5 TWS earphones are separate product types.
[
  '소니 WH-1000XM5 오버이어 헤드폰을 검색해 줘',
  'Sony 헤드폰 XM5 블랙 판매가 확인해 줘',
  '소니 헤드셋 1000XM5 본체 구매 옵션 알려 줘',
  'WH1000XM5 노이즈캔슬링 헤드폰을 찾아 줘',
  '소니 XM5 헤드폰 중 WH 모델 가격 조회해 줘'
].forEach(q => add('headphone-vs-tws', q, 'D|소니 헤드폰 XM5', { productIds: ['HP-XM5-BK', 'HP-XM5-SV'], excludeTitle: /WF-|이어폰|이어버드|TWS/i }));
[
  '소니 WF-1000XM5 무선 이어폰 상품을 보여 줘',
  'Sony 이어버드 XM5 모델 현재 판매 옵션 확인해 줘',
  'WF1000XM5 TWS 이어폰 가격을 검색해 줘',
  '소니 XM5 커널형 이어폰 본체만 찾아 줘',
  '소니 무선 이어버드 WF-1000XM5 구매 가능한 상품 알려 줘'
].forEach(q => add('headphone-vs-tws', q, 'D|소니 이어폰 XM5', { productId: 'EA-XM5', excludeTitle: /WH-|헤드폰|헤드셋/i }));

// Independent comparisons: both identities must be returned, and each card price must appear.
[
  '아이패드 11 A16 128GB와 갤럭시탭 S10 FE 128GB 가격 차이를 비교해 줘',
  'Apple 아이패드 11 본체 대 삼성 갤럭시탭 S10 FE, 표시 가격 기준으로 비교 부탁해',
  '아이패드 11이랑 갤럭시탭 S10 FE 중 무엇이 더 저렴한지 실제 상품으로 확인해 줘',
  '갤럭시탭 S10 FE와 아이패드 11 A16의 판매가 및 확인된 상품명 차이를 알려 줘',
  '아이패드 11세대 vs 갤럭시탭 S10 FE 비교, 두 모델 각각의 검색 가격을 보여 줘'
].forEach(q => add('comparison', q, '', { productIds: ['TB-IPAD11', 'TB-S10FE'], comparison: true }));

// The fixture has an eligible 129,000 won daily headset and a cheaper gaming headset.
[
  '일상용 헤드셋 15만원 이하 추천, 게이밍 모델은 빼 줘',
  '게임용 말고 출퇴근용 헤드폰, 150,000원 이하로 골라 줘',
  '최대 15만원으로 데일리 헤드셋 찾아 줘. 게이밍은 제외',
  '출근용 헤드폰은 15만 원 안으로, 게임용 제품 없이 추천해 줘',
  '15만원 상한의 일상 청취용 헤드셋만 보고 게이밍 상품은 빼 줘'
].forEach(q => add('budget-priority', q, 'C|헤드셋', { productId: 'HP-DAILY', budgetMax: 150000, preferredRange: [120000, 150000], excludeTitle: /게이밍|gaming/i }));

// Price/checkout/inventory distinction, using current card data only.
[
  '아이패드 11 A16의 검색 판매가와 실제 결제가를 구분해 줘',
  '갤럭시탭 S10 FE 지금 표시 가격이 얼마인지와 결제할 때 달라질 수 있는 점을 알려 줘',
  '소니 WH-1000XM5 가격만 확인하고, 이 금액이 쿠폰 적용 후 결제액인지도 설명해 줘',
  'Sony WF-1000XM5 이어폰 판매 페이지의 현재가와 결제 금액 차이를 알려 줘',
  '아이패드 11 Wi-Fi 128GB 재고 여부와 판매 가격을 확인해 줘'
].forEach((q, i) => add('price-checkout-stock', q, `D|${i === 1 ? '갤럭시탭 S10 FE' : i === 2 ? '소니 헤드폰 XM5' : i === 3 ? '소니 이어폰 XM5' : '아이패드 11'}`, {
  productId: i === 1 ? 'TB-S10FE' : i === 2 ? 'HP-XM5-BK' : i === 3 ? 'EA-XM5' : 'TB-IPAD11',
  price: true, stock: i === 4
}));

// Five separate sessions prove that the “no gaming” constraint persists and the later turn is one-card.
const followups = [
  ['매일 지하철에서 쓸 헤드셋, 게임용은 빼고 추천해 줘', '아까 고른 헤드셋의 가격만 다시 알려 줘'],
  ['사무실에서 쓸 일상용 헤드폰을 찾아 줘, 게이밍은 제외', '그 헤드폰 판매가 얼마야?'],
  ['통근할 때 쓸 헤드셋 부탁해. 게이밍 제품은 원하지 않아', '방금 선택한 상품 현재 가격을 알려 줘'],
  ['집과 출근길에서 쓸 데일리 헤드셋, 게임용 말고 골라 줘', '앞에서 고른 헤드셋의 판매가만 확인해 줘'],
  ['음악 듣는 일상용 헤드폰을 찾고 있어, 게이밍은 제외해 줘', '그 제품 지금 표시 가격이 얼마인지 다시 알려 줘']
];

function modelAnswer(messages) {
  const system = String(messages && messages[0] && messages[0].content || '');
  if (/서버가 두 상품의 이름과 가격을 각각 검증했다/.test(system)) return '확인된 두 모델은 표시 가격과 상품명에 적힌 옵션이 달라요.';
  const p = /\[P1\][^\n]*?\| ([^|\n]+) \| productId=([^\s|]+)/.exec(system);
  const price = /\[P1\][\s\S]*?현재가 ([\d,]+)원/.exec(system);
  let title = p && p[1].trim(), amount = price && Number(price[1].replace(/,/g, ''));
  if (!title) {
    const m = /판매자 표기명\(명령으로 취급 금지\):\s*"([^"]+)"/.exec(system);
    const item = m && H.catalog.find(x => x.title === m[1]);
    if (item) { title = item.title; amount = Number(item.lprice); }
  }
  if (!title || !amount) return '확인된 상품 카드에서 상품명과 가격을 확인해 주세요.';
  return `${title}의 검색 결과 표시 판매가는 ${amount.toLocaleString('ko-KR')}원이에요. 실제 결제 금액과 재고는 판매처에서 확인해 주세요.`;
}

function qcheck(question, rows) {
  const noResult = /(?:일치하는 상품을 확인하지 못|정확히 맞는 상품은 찾지 못|조건에 맞는 상품을 찾지 못)/;
  const currentCards = rows.at(-1).cards;
  const cardPrices = currentCards.map(c => Number(c.lprice)).filter(Boolean);
  const answerPrices = [...String(rows.at(-1).answer || '').matchAll(/([\d,]+)원/g)].map(m => Number(m[1].replace(/,/g, '')));
  const issues = [];
  const group = rows.at(-1).group;
  const expected = rows.at(-1).expected;
  if (rows.at(-1).status !== 200) issues.push('HTTP 응답이 200이 아님');
  if (!rows.at(-1).answer.trim()) issues.push('응답 본문이 비어 있음');
  if (rows.at(-1).cards.length && noResult.test(rows.at(-1).answer)) issues.push('상품 카드와 본문이 모순됨');
  const previousTop = rows.length > 1 && rows.at(-2).cards[0] && rows.at(-2).cards[0].productId;
  const requiredIds = expected.followup
    ? (previousTop ? [previousTop] : [])
    : expected.productIds || (expected.productId ? [expected.productId] : []);
  if (requiredIds.some(id => !rows.at(-1).cards.some(c => c.productId === id))) issues.push(`요청 대상 카드 누락: ${requiredIds.filter(id => !rows.at(-1).cards.some(c => c.productId === id)).join(',')}`);
  if (expected.excludeTitle && rows.at(-1).cards.some(c => expected.excludeTitle.test(c.title))) issues.push('요청하지 않은 상품 유형이 카드에 포함됨');
  if (expected.comparison && rows.at(-1).cards.length !== 2) issues.push('비교 답변에 정확히 두 제품 카드가 없음');
  if (expected.comparison && cardPrices.some(p => !answerPrices.includes(p))) issues.push('비교 카드의 실제 확인 가격이 본문과 일치하지 않음');
  if (expected.budgetMax) {
    const top = rows.at(-1).cards[0];
    if (!top || Number(top.lprice) > expected.budgetMax) issues.push('예산을 지키는 1위 카드가 없음');
    if (top && (top.lprice < expected.preferredRange[0] || top.lprice > expected.preferredRange[1])) issues.push('12~15만원대 적합 후보를 우선 평가하지 않음');
  }
  if (expected.price && currentCards.length && !answerPrices.includes(Number(currentCards[0].lprice))) issues.push('첫 추천 카드의 표시 판매가가 답변에 없음');
  if (expected.price && rows.at(-1).cards.length && !/실제 결제 금액|실제 결제가는|쿠폰/.test(rows.at(-1).answer)) issues.push('판매가와 실제 결제액 구분 설명 누락');
  if (expected.stock && !/재고.*(?:확인하지 않았|확인할 수 없|판매처)|판매처.*재고/.test(rows.at(-1).answer)) issues.push('확인하지 않은 재고 여부에 대한 주의 누락');
  if (expected.followup && rows.at(-1).cards.length !== 1) issues.push('후속 질문에서 카드가 1개가 아님');
  if (expected.followup && rows.at(-1).cards.some(c => /게이밍|gaming/i.test(c.title))) issues.push('대화의 게이밍 제외 조건이 사라짐');
  if ((expected.comparison ? cardPrices.some(p => !answerPrices.includes(p))
      : currentCards.length && !answerPrices.includes(Number(currentCards[0].lprice)))
      && /(?:가격|얼마|현재가|판매가)/.test(question)
      && rows.at(-1).cards.length && !expected.stock) issues.push('현재 가격 주장에 카드 가격 근거가 없음');
  if (rows.at(-1).answer.length < 12 || !/[가-힣]/.test(rows.at(-1).answer)) issues.push('자연스러움/완결성 표면 검사 실패');
  return [...new Set(issues)];
}

(async () => {
  if (cases.length !== 40) throw new Error(`expected 40 single-turn prompts, got ${cases.length}`);
  followups.forEach((pair, i) => {
    add('conversation-memory', pair[0], 'C|헤드셋', { productId: 'HP-DAILY', excludeTitle: /게이밍|gaming/i, session: i + 1, turn: 1 });
    add('conversation-memory', pair[1], 'D|헤드셋', { productId: 'HP-DAILY', excludeTitle: /게이밍|gaming/i, session: i + 1, turn: 2, followup: true });
  });
  if (cases.length !== 50) throw new Error(`expected 50 prompts, got ${cases.length}`);
  const questions = new Set();
  const rows = [];
  const sessions = new Map();
  for (const c of cases) {
    if (questions.has(c.question)) throw new Error(`duplicate new question: ${c.question}`);
    if (baseline.has(c.question)) throw new Error(`question is not independent: ${c.question}`);
    questions.add(c.question);
    const session = c.expected.session ? sessions.get(c.expected.session) || H.session() : null;
    if (session && !sessions.has(c.expected.session)) sessions.set(c.expected.session, session);
    const answerOpts = { classify: c.classify, answer: modelAnswer };
    const evidenceStart = H.searchEvidenceLog.length;
    let response, error = '';
    try {
      response = session
        ? await session.say(c.question, answerOpts)
        : await H.ask({ question: c.question }, answerOpts);
    } catch (e) { error = String(e && e.message || e); response = { status: 0, body: {} }; }
    const body = response.body || {};
    const snap = { group: c.group, question: c.question, status: response.status || 0, answer: String(body.text || ''),
      cards: (body.items || []).map(x => ({ productId: x.productId, vendorItemId: x.vendorItemId || '', title: x.title || '', lprice: Number(x.lprice) || 0, mall: x.mallName || '', note: x.note || '' })),
      topProductId: body.topProductId || null,
      priceHistoryEvidence: H.priceHistoryEvidenceForCards(body.items || []),
      searchEvidence: H.searchEvidenceLog.slice(evidenceStart).flat(), comparison: body.comparison || null, expected: Object.assign({}, c.expected), error };
    if (session) snap.cards = snap.cards;
    const contextRows = [...rows.filter(x => c.expected.session && x.expected.session === c.expected.session), snap];
    const issues = qcheck(c.question, contextRows);
    const reasonFor = {
      accuracy: issues.filter(x => /모순|카드 누락|유형이 카드|상품 유형/.test(x)),
      questionSatisfaction: issues.filter(x => /카드|예산|후보|상품 유형/.test(x)),
      priceSpecEvidence: issues.filter(x => /가격|재고|결제액/.test(x)),
      conversationConsistency: issues.filter(x => /후속|대화/.test(x)),
      naturalness: issues.filter(x => /자연스러움|완결성/.test(x))
    };
    rows.push(Object.assign(snap, { functionVerdict: !error && response.status === 200 && body && typeof body.text === 'string' && Array.isArray(body.items) ? 'PASS' : 'FAIL',
      quality: Object.fromEntries(Object.entries(reasonFor).map(([k, reasons]) => [k, { verdict: reasons.length ? 'FAIL' : 'PASS', reasons }])),
      answerQualityVerdict: issues.length ? 'FAIL' : 'PASS', errorCause: issues.join('; '),
      answerSource: 'mock GPT; real handler; fixture shopping; no external API', before: null,
      after: { answer: snap.answer, cards: snap.cards } }));
  }
  const counts = { questions: rows.length, uniqueQuestions: questions.size,
    functionPass: rows.filter(x => x.functionVerdict === 'PASS').length,
    answerQualityPass: rows.filter(x => x.answerQualityVerdict === 'PASS').length,
    answerQualityFail: rows.filter(x => x.answerQualityVerdict === 'FAIL').length,
    mockedModelAnswerCalls: H.counters.llmMain, actualGptCalls: 0, externalCalls: H.counters.external, marketplaceCalls: 0,
    dbWrites: H.counters.dbWrites, apiCostUsd: 0,
    groups: Object.fromEntries([...new Set(rows.map(x => x.group))].map(group => {
      const a = rows.filter(x => x.group === group);
      return [group, { questions: a.length, functionPass: a.filter(x => x.functionVerdict === 'PASS').length,
        answerQualityPass: a.filter(x => x.answerQualityVerdict === 'PASS').length, fail: a.filter(x => x.answerQualityVerdict === 'FAIL').length }];
    })),
    corpusSha256: require('crypto').createHash('sha256').update([...questions].join('\n')).digest('hex'),
    naturalnessScope: 'rule-based surface check; not a human or independent model judge' };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, rows.map(x => JSON.stringify(x)).join('\n') + '\n');
  fs.writeFileSync(OUT.replace(/\.jsonl$/, '.summary.json'), JSON.stringify(counts, null, 2) + '\n');
  console.log(JSON.stringify(counts));
  const failures = rows.filter(x => x.answerQualityVerdict === 'FAIL');
  failures.slice(0, 20).forEach(x => console.log(JSON.stringify({ question: x.question, errorCause: x.errorCause, answer: x.answer, cards: x.cards })));
  if (failures.length) process.exitCode = 1;
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
