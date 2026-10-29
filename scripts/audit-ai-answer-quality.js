'use strict';

/*
 * Independently grades recorded handler responses; it never invokes a model.
 * Naturalness is a conservative surface screen, not a human or LLM judgment.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const files = {
  old1000: arg('before-1000', 'reports/ai-integration-2026-10-29/offline-results.jsonl'),
  old200: arg('before-200', 'reports/ai-integration-2026-10-29/holdout-200.jsonl'),
  new1000: arg('after-1000', 'reports/ai-answer-quality-2026-10-29/offline-1000-after/offline-results.jsonl'),
  new200: arg('after-200', 'reports/ai-answer-quality-2026-10-29/holdout-200-after.jsonl'),
  new50: arg('after-new-50', 'reports/ai-answer-quality-2026-10-29/new-independent-50.jsonl'),
  out: arg('out', 'reports/ai-answer-quality-2026-10-29/quality-review.jsonl')
};
const readJsonl = p => fs.readFileSync(path.resolve(ROOT, p), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const flatten = (source, rows) => rows.map(row => {
  const response = row.response || {};
  return {
    question: row.userQuestion || row.question,
    questionKey: row.question,
    category: row.category || row.group || row.c || 'unknown',
    functionVerdict: row.functionVerdict || row.verdict || 'UNVERIFIED',
    expected: typeof row.expected === 'string' ? row.expected : JSON.stringify(row.expected || ''),
    text: typeof row.text === 'string' ? row.text : (typeof row.answer === 'string' ? row.answer : (response.text || '')),
    cards: Array.isArray(row.cards) ? row.cards : Array.isArray(row.products) ? row.products : Array.isArray(response.cards) ? response.cards.map(c => {
      if (c && typeof c === 'object') return c;
      const m = /^(.*?)\/(.*?)@(\d+)$/.exec(String(c));
      return m ? { productId: m[1], vendorItemId: m[2], lprice: Number(m[3]), title: '' } : { productId: String(c), vendorItemId: '', lprice: 0, title: '' };
    }) : Array.isArray(row.productIds) ? row.productIds.map(s => {
      const m = /^([^/]+)\/(.*)$/.exec(String(s));
      return m ? { productId: m[1], vendorItemId: m[2], lprice: 0, title: '' } : { productId: String(s), vendorItemId: '', lprice: 0, title: '' };
    }) : [],
    searchEvidence: Array.isArray(row.searchEvidence) ? row.searchEvidence : [],
    comparison: row.responseMeta && row.responseMeta.comparison || row.comparison || response.comparison || null,
    constraints: row.responseMeta && row.responseMeta.constraints || null,
    reusePreviousCard: !!(row.responseMeta && row.responseMeta.reusePreviousCard || response.reusePreviousCard),
    topProductId: row.topProductId || row.responseMeta && row.responseMeta.topProductId || response.topProductId || null,
    session: row.session ? `${source}:${row.session}` : row.extra && row.extra.session ? `${source}:${row.extra.session}` : row.expected && row.expected.session ? `${source}:${row.expected.session}` : null,
    turn: row.turn || row.extra && row.extra.turn || row.expected && row.expected.turn || null,
    sessionKind: row.sessionKind || row.extra && row.extra.sessionKind || (row.group === 'conversation-memory' ? 'gaming-exclusion' : null),
    status: row.status || response.status || null,
    source
  };
});
const won = text => [...String(text || '').matchAll(/(?<!\d)(\d{1,3}(?:,\d{3})+|\d{5,})\s*원/g)].map(m => Number(m[1].replace(/,/g, '')));
const budgetMax = q => {
  const m = /(?:예산|상한|이하|이내|넘기지|안에서|안으로)?\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*(만원|만\s*원|원)\s*(?:이하|이내|안|내|넘기지|으로|에서)?/i.exec(String(q || ''));
  if (!m) return 0;
  const n = Number(m[1].replace(/,/g, ''));
  return /만/.test(m[2]) ? n * 10000 : n;
};
const hardBudgetMax = q => /(?:이하|이내|넘기지|최대|상한|한도|안에서|안으로)/.test(String(q || '')) ? budgetMax(q) : 0;
const noResult = /(?:일치하는 상품을 확인하지 못|조건에 맞는 상품을 찾지 못|정확히 맞는 상품은 찾지 못|검색 결과가 없었|방금 검색했지만 결과가 없었|이번 검색 결과에서 찾지 못했|상품을 찾지 못했어요|이번 검색 결과에 없었어요|예산에 맞는 상품은 이번 검색 결과에 없었어요)/;
const compareAsk = row => /^(?:compare|comparison)$/.test(row.category)
  || /(?:비교|\bvs\b|뭐가 더|어느 쪽|둘 중|둘 다|둘의 현재가|두 개.*(?:판매가|현재가|가격)|두 제품|두 모델|두 상품|앞의 두|비교한)/i.test(row.question);
const priceAsk = q => /가격|얼마|판매가|현재가|결제가|결제액|가격만|재고/.test(String(q || ''));
function exactRequestedCard(row) {
  if (row.expected) {
    const ids = [...row.expected.matchAll(/\b[A-Z]{2,}(?:-[A-Z0-9]+){1,}\b/g)].map(m => m[0]);
    if (ids.some(id => row.cards.some(c => String(c.productId || '').includes(id)))) return true;
    if (/정확히 맞는 상품이 없다고|요청 모델.*없|판매 중인 것처럼 말하지/.test(row.expected)) return false;
  }
  const titleText = row.cards.map(c => String(c.title || '')).join(' ').toLowerCase().replace(/\s+/g, '');
  const modelTokens = [...String(row.question || '').matchAll(/\b(?:[A-Z]{1,5}[- ]?\d{1,5}[A-Z0-9-]*|\d{2,4}\s?(?:GB|TB))\b/gi)].map(m => m[0].replace(/\s+/g, '').toLowerCase());
  return modelTokens.some(token => titleText.includes(token));
}
const status = reasons => reasons.length ? 'FAIL' : 'PASS';

function grade(row, previousSessionPrices) {
  const { question: q, text, cards } = row;
  const issues = { accuracy: [], questionSatisfaction: [], priceSpecEvidence: [], conversationConsistency: [], naturalness: [] };
  if (!text.trim()) issues.accuracy.push('답변 본문이 비어 있음');
  if (cards.length && noResult.test(text) && exactRequestedCard(row)) issues.accuracy.push('정확한 상품 카드가 있는데 본문은 상품을 찾지 못했다고 말함');
  if (/성능이\s*(?:두\s*배|\d+배)|역대\s*최저|무조건\s*최고|재고가\s*있(?:어요|습니다)|품절이\s*아니/.test(text)) {
    const support = cards.some(c => /최저|역대|재고|품절|성능/.test(String(c.note || '')));
    if (!support) issues.accuracy.push('카드 데이터에서 확인할 수 없는 성능·최저가·재고 단정');
  }

  if (compareAsk(row)) {
    const complete = !!(row.comparison && row.comparison.complete);
    const explicitMissing = /(?:한쪽|하나|비교 대상 중 하나).*(?:확인하지 못|찾지 못)|찾지 못.*(?:비교|상품)/.test(text);
    if (cards.length < 2 && !explicitMissing) issues.questionSatisfaction.push('비교 질문에 확인된 두 제품 카드가 없음');
    if (cards.length >= 2 && !complete) issues.questionSatisfaction.push('두 제품 독립 확인 완료 표시가 없음');
    if (cards.length >= 2 && !/(?:차이|더 저렴|가격만 기준|표시 가격)/.test(text)) issues.questionSatisfaction.push('두 제품의 차이와 선택 기준을 설명하지 않음');
  } else if (priceAsk(q) && cards.length && !won(text).some(n => cards.some(c => Number(c.lprice) === n))) {
    issues.questionSatisfaction.push('가격 질문인데 확인된 카드 가격을 본문에 답하지 않음');
  }
  if (/재고|품절|구매\s*가능/.test(q) && cards.length
      && !/재고.*(?:확인하지 않았|확인할 수 없|판매처)|판매처.*재고/.test(text)) {
    issues.questionSatisfaction.push('재고 질문에 재고를 확인하지 않았다는 설명이 없음');
  }
  if (/결제|현재가|판매가|가격만/.test(q) && cards.length && !/(?:실제 결제 금액|실제 결제가는|쿠폰·카드|쿠폰)/.test(text)) {
    issues.questionSatisfaction.push('표시 판매가와 실제 결제 금액의 차이를 밝히지 않음');
  }
  if (/노트북/.test(q) && !/책|강의|교육|콘텐츠|클래스/.test(q)
      && cards.some(c => /책|강의|교육|콘텐츠|클래스/.test(String(c.title || '')))) {
    issues.questionSatisfaction.push('노트북 본체 요청에 교육 콘텐츠가 카드로 포함됨');
  }
  if (/(?:아이패드|갤럭시탭|태블릿)/.test(q) && !/(?:케이스|펜|펜촉|스타일러스|터치펜|액정|호환)/.test(q)
      && cards.some(c => /(?:케이스|스타일러스|터치펜|액정 교체|호환용 펜)/.test(String(c.title || '')))) {
    issues.questionSatisfaction.push('태블릿 본체 요청에 액세서리·호환 부품이 포함됨');
  }
  if (/헤드셋|헤드폰/.test(q) && !/이어폰|이어버드|TWS|버즈|에어팟/.test(q)
      && cards.some(c => /(?:이어폰|이어버드|TWS|버즈|에어팟(?!\s*맥스))/i.test(String(c.title || '')))) {
    issues.questionSatisfaction.push('헤드셋 요청에 이어폰/TWS 유형이 포함됨');
  }
  const max = hardBudgetMax(q);
  if (max && cards.length && cards[0].lprice && cards[0].lprice > max && !/(?:예산|상한).*(?:없|넘|초과)|(?:없|넘|초과).*(?:예산|상한)/.test(text)) {
    issues.questionSatisfaction.push(`첫 추천 가격 ${cards[0].lprice}원이 예산 ${max}원을 넘음`);
  }
  if (max === 150000 && cards.length) {
    const near = cards.some(c => Number(c.lprice) >= 120000 && Number(c.lprice) <= 150000);
    if (near && Number(cards[0].lprice) < 120000 && !/(?:더 저렴|낮은 가격|가격 차이|더 싼).*(?:ANC|노이즈 캔슬링|확인된 기능|지원)/i.test(text)) {
      issues.questionSatisfaction.push('15만원 예산에서 12~15만원 적합 후보가 있는데 더 싼 후보 우선의 근거가 없음');
    }
  }
  const budgetEvidence = row.searchEvidence.filter(c => {
    const title = String(c.title || '');
    if (/호환|케이스|필터|액세서리|스타일러스|터치펜|부품/i.test(title)) return false;
    if (/로봇청소기/.test(q)) return /로봇청소기/.test(title);
    if (/무선청소기/.test(q)) return /무선청소기/.test(title);
    return true;
  });
  if (max && !cards.length && budgetEvidence.some(c => Number(c.lprice) > 0 && Number(c.lprice) <= max)
      && /(?:노트북|스마트폰|태블릿|아이패드|갤럭시탭|이어폰|헤드폰|헤드셋|청소기|공기청정기|에어프라이어)/.test(q)) {
    issues.questionSatisfaction.push('검색 증거에 예산 안 후보가 있는데 추천 카드나 그 이유가 없음');
  }
  if (row.category !== 'security' && /(?:추천|찾아|보여|검색)/.test(q) && !cards.length && !noResult.test(text)) issues.questionSatisfaction.push('상품 탐색 요청에 카드도 검색 결과 부재 안내도 없음');

  const evidencePrices = row.searchEvidence.map(c => Number(c.lprice)).filter(Boolean);
  const allowedWon = new Set([...won(q), ...(budgetMax(q) ? [budgetMax(q)] : []), ...cards.map(c => Number(c.lprice)).filter(Boolean), ...evidencePrices, ...previousSessionPrices]);
  const allPrices = [...new Set([...cards.map(c => Number(c.lprice)), ...evidencePrices].filter(Boolean))];
  for (let i = 0; i < allPrices.length; i++) for (let j = i + 1; j < allPrices.length; j++) allowedWon.add(Math.abs(allPrices[i] - allPrices[j]));
  const cap = budgetMax(q);
  if (cap) allPrices.forEach(price => allowedWon.add(Math.abs(price - cap)));
  const badWon = won(text).filter(n => !allowedWon.has(n));
  if (badWon.length) issues.priceSpecEvidence.push(`질문·카드·비교 차이 근거에 없는 금액 ${[...new Set(badWon)].join(', ')}원`);
  const specRe = /\b(\d+(?:\.\d+)?\s?(?:GB|TB|L|인치|형|mAh|kg|W|시간|Hz|mm|cm|년|개월|%))\b/gi;
  const evidenceText = `${q} ${cards.concat(row.searchEvidence).map(c => `${c.title || ''} ${c.note || ''}`).join(' ')}`;
  const specKey = token => {
    const m = /^(\d+(?:\.\d+)?)(gb|tb)$/i.exec(String(token).replace(/\s+/g, ''));
    if (m) return `${Number(m[1]) * (m[2].toLowerCase() === 'tb' ? 1024 : 1)}gb`;
    return String(token).replace(/\s+/g, '').toLowerCase();
  };
  const evidenceSpecs = new Set([...evidenceText.matchAll(specRe)].map(m => specKey(m[0])));
  const unsupportedSpecs = [...text.matchAll(specRe)].map(m => m[0]).filter(token => !evidenceSpecs.has(specKey(token)));
  if (unsupportedSpecs.length) issues.priceSpecEvidence.push(`질문·상품명·카드 메모에 없는 사양/수치 ${[...new Set(unsupportedSpecs)].join(', ')}`);
  if (/(?:재고가\s*있(?:어요|습니다)|품절이\s*아니|할인율\s*\d+%)/.test(text)
      && !cards.some(c => String(c.note || '').includes(text.match(/\d+%/)?.[0] || '재고'))) {
    issues.priceSpecEvidence.push('재고 또는 할인율 근거가 카드에 없음');
  }
  if (/역대\s*최저|다음\s*(?:달|주)에?\s*(?:더\s*)?(?:내려|오를|비싸)/.test(text)
      && !cards.some(c => /역대|최저|가격 기록/.test(String(c.note || '')))) {
    issues.priceSpecEvidence.push('가격 기록 데이터에 없는 과거·미래 가격 주장');
  }

  if (row.session && Number(row.turn) > 1) {
    const top = row.topProductId || cards[0] && cards[0].productId;
    const prev = previousSessionPrices.__topProductId;
    if (row.reusePreviousCard && (!prev || !top || prev !== top)) issues.conversationConsistency.push('이전 카드와 다른 상품에 재사용 힌트를 설정함');
    if (!compareAsk(row) && cards.length > 1) issues.conversationConsistency.push('비교가 아닌 후속 질문에 상품 카드가 여러 개 반환됨');
  }
  if (row.sessionKind === 'gaming-exclusion' && Number(row.turn) > 1
      && cards.some(c => /(?:게이밍|gaming|ROG|스트릭스)/i.test(String(c.title || '')))) {
    issues.conversationConsistency.push('일상용 요청 뒤 게이밍 제외 조건이 후속 턴에서 사라짐');
  }
  if (row.sessionKind === 'budget-gaming-exclusion' && Number(row.turn) > 1
      && cards.some(c => /(?:게이밍|gaming|ROG|스트릭스)/i.test(String(c.title || '')))) {
    issues.conversationConsistency.push('게임용 제외 조건이 후속 턴에서 사라짐');
  }
  if (cards.length && noResult.test(text) && exactRequestedCard(row)) issues.conversationConsistency.push('대화 본문과 반환된 정확 상품 카드가 서로 모순됨');

  const internal = /\[P\d\]|서버 상품 식별 결과|<상품데이터>|OPENAI_API_KEY|OPENROUTER_API_KEY|시스템 프롬프트:|\[독립세션\d+·\d+/.test(text);
  const sentences = text.split(/(?<=[.!?。])\s+|\n+/).map(s => s.trim()).filter(Boolean);
  const repeated = sentences.some((s, i) => sentences.indexOf(s) !== i);
  if (text.trim().length < 12 || !/[가-힣]/.test(text) || internal || repeated) {
    issues.naturalness.push(internal ? '내부 라벨/시스템 문자열 노출' : repeated ? '같은 문장 반복' : '응답이 비어 있거나 한국어 답변으로 너무 짧음');
  }
  const quality = Object.fromEntries(Object.entries(issues).map(([k, v]) => [k, { verdict: status(v), reasons: v }]));
  return { quality, errorCause: Object.values(issues).flat().join('; ') };
}

function main() {
  const old1000Source = /before-full/.test(files.old1000) ? 'before-baseline-full-f20cb76' : 'before-mock-1000-truncated-400';
  const old200Source = /before-full/.test(files.old200) ? 'before-baseline-full-f20cb76' : 'before-mock-200-truncated-180';
  const old = [...flatten(old1000Source, readJsonl(files.old1000)),
    ...flatten(old200Source, readJsonl(files.old200))];
  const fresh = [...flatten('after-mock-1000-full', readJsonl(files.new1000)),
    ...flatten('after-mock-200-full', readJsonl(files.new200)),
    ...flatten('after-mock-new-50', readJsonl(files.new50))];
  const beforeByKey = new Map(old.map(x => [x.questionKey, x]));
  const all = [];
  const sessionState = new Map();
  const beforeSessionState = new Map();
  for (const row of fresh) {
    const prior = beforeByKey.get(row.questionKey) || beforeByKey.get(row.question) || null;
    const oldState = prior && prior.session ? beforeSessionState.get(prior.session) || { prices: [], top: '' } : { prices: [], top: '' };
    const oldSnapshot = oldState.prices.slice();
    oldSnapshot.__topProductId = oldState.top;
    const priorGrade = prior ? grade(prior, oldSnapshot) : null;
    if (prior && prior.session) {
      oldState.prices.push(...prior.cards.map(c => Number(c.lprice)).filter(Boolean));
      oldState.top = prior.topProductId || prior.cards[0] && prior.cards[0].productId || oldState.top;
      beforeSessionState.set(prior.session, oldState);
    }
    const state = row.session ? sessionState.get(row.session) || { prices: [], top: '' } : { prices: [], top: '' };
    const contextPrices = state.prices.slice();
    contextPrices.__topProductId = state.top;
    const graded = grade(row, contextPrices);
    if (row.session) {
      state.prices.push(...row.cards.map(c => Number(c.lprice)).filter(Boolean));
      state.top = row.topProductId || row.cards[0] && row.cards[0].productId || state.top;
      sessionState.set(row.session, state);
    }
    const before = prior ? {
      answer: prior.text, verdict: prior.functionVerdict,
      source: prior.source,
      answerSource: prior.source.includes('before-baseline-full')
        ? 'reconstructed baseline handler + deterministic mock GPT + fixture shopping'
        : 'original report artifact',
      responseCompleteness: prior.source.includes('before-baseline-full')
        ? 'full answer reconstructed from base commit f20cb76'
        : prior.source.includes('truncated') ? 'truncated in source report' : 'recorded',
      cards: prior.cards.map(c => ({ productId: c.productId, vendorItemId: c.vendorItemId || '', lprice: Number(c.lprice) || 0, title: c.title || '', mall: c.mallName || c.mall || '', priceNote: c.note || '' })),
      searchEvidence: prior.searchEvidence,
      comparison: prior.comparison,
      expected: prior.expected,
      session: prior.session,
      turn: prior.turn,
      sessionKind: prior.sessionKind
    } : null;
    all.push({
      question: row.question, questionKey: row.questionKey, category: row.category,
      answerSource: 'mock GPT; actual GPT calls 0; fixture catalog; real handler',
      functionCheck: { before: before && before.verdict || 'UNVERIFIED', after: row.functionVerdict },
      before: before && Object.assign({}, before, { quality: priorGrade && priorGrade.quality, errorCause: priorGrade && priorGrade.errorCause }),
      after: { answer: row.text, expected: row.expected, cards: row.cards.map(c => ({ productId: c.productId, vendorItemId: c.vendorItemId || '', title: c.title || '', lprice: Number(c.lprice) || 0, mall: c.mallName || '', priceNote: c.note || '' })), searchEvidence: row.searchEvidence, comparison: row.comparison, responseStatus: row.status || null, source: row.source, session: row.session, turn: row.turn, sessionKind: row.sessionKind, reusePreviousCard: row.reusePreviousCard, topProductId: row.topProductId },
      quality: graded.quality, errorCause: graded.errorCause,
      fix: graded.errorCause ? '' : 'No static quality defect detected; naturalness verdict is a rule-based screen.'
    });
  }
  const keys = ['accuracy', 'questionSatisfaction', 'priceSpecEvidence', 'conversationConsistency', 'naturalness'];
  const qualityCounts = Object.fromEntries(keys.map(k => [k, { pass: 0, fail: 0, unverified: 0 }]));
  for (const row of all) for (const k of keys) qualityCounts[k][row.quality[k].verdict.toLowerCase()]++;
  const passRows = all.filter(r => keys.every(k => r.quality[k].verdict === 'PASS'));
  const beforeFail = all.filter(r => r.before && r.before.quality && keys.some(k => r.before.quality[k].verdict === 'FAIL')).length;
  const beforeCauseCounts = {};
  for (const row of all) for (const result of Object.values(row.before && row.before.quality || {})) {
    for (const reason of result.reasons || []) beforeCauseCounts[reason] = (beforeCauseCounts[reason] || 0) + 1;
  }
  const failRows = all.filter(r => keys.some(k => r.quality[k].verdict === 'FAIL'));
  const categoryCounts = {};
  for (const row of all) {
    const c = categoryCounts[row.category] || (categoryCounts[row.category] = { questions: 0, functionPass: 0, qualityPass: 0, qualityFail: 0 });
    c.questions++;
    if (row.functionCheck.after === 'PASS') c.functionPass++;
    if (keys.every(k => row.quality[k].verdict === 'PASS')) c.qualityPass++;
    if (keys.some(k => row.quality[k].verdict === 'FAIL')) c.qualityFail++;
  }
  const summary = {
    kind: 'ANSWER_QUALITY_AUDIT_STATIC_RUBRIC_MOCK_GPT', totalQuestions: all.length,
    priorQuestionsEvaluated: all.filter(r => r.before).length,
    functionPass: all.filter(r => r.functionCheck.after === 'PASS').length,
    answerQualityPass: passRows.length, answerQualityFail: failRows.length,
    answerQualityUnverified: all.length - passRows.length - failRows.length,
    beforeQualityFail: beforeFail, beforeCauseCounts,
    criteria: qualityCounts, categories: categoryCounts,
    actualGptCalls: 0, mockedAnswerRuns: all.length, marketplaceCalls: 0, apiCostUsd: 0,
    beforeArtifactLimits: /before-full/.test(files.old1000) && /before-full/.test(files.old200)
      ? { originalReports: 'truncated source reports were reconstructed at full length from base commit f20cb76 using its real handler and deterministic mock GPT/fixture search' }
      : { thousand: 'prior report truncates answers at 400 characters', holdout: 'prior report truncates answers at 180 characters' },
    naturalnessScope: 'rule-based surface screen; not a human or independent LLM judge',
    deployment: 'not deployed'
  };
  const output = path.resolve(ROOT, files.out);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, all.map(x => JSON.stringify(x)).join('\n') + '\n');
  fs.writeFileSync(output.replace(/\.jsonl$/i, '.summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary));
}

main();
