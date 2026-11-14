// SEOSA AI v3 100-question automated test
// 브라우저 콘솔에서 실행하거나 Node.js로 실행
// Usage: node scripts/test-100-questions.js https://seosa.ai.kr

const BASE = (process.argv.slice(2).find(a => /^https:\/\//.test(a)) || 'https://seosa.ai.kr').replace(/\/+$/, '');
const ENDPOINT = BASE + '/api/ai?v=3';

const questions = [
  // 기본 추천 (1-15)
  '에어팟 추천해줘',
  '10만원대 블루투스 이어폰 뭐가 좋아?',
  '게이밍 키보드 추천',
  '가성비 좋은 무선 마우스 알려줘',
  '노트북 거치대 하나 찾아줘',
  '외장 SSD 1TB 추천해줘',
  '공부할 때 쓸 노이즈캔슬링 헤드폰 추천',
  '아이패드 케이스 추천해줘',
  'USB-C 허브 좋은 거 있어?',
  '모니터 암 추천',
  '전동 킥보드 추천해줘',
  '캠핑 의자 좋은 거 알려줘',
  '공기청정기 추천',
  '로봇청소기 뭐가 좋아?',
  '전자책 리더기 추천해줘',
  // 예산 지정 (16-25)
  '5만원 이하 이어폰 추천',
  '30만원 이하 태블릿 있어?',
  '예산 20만원으로 기계식 키보드 찾아줘',
  '100만원 이하 노트북 추천해줘',
  '3만원짜리 마우스 추천',
  '50만원대 안마의자 있어?',
  '15만원 이하 스마트워치',
  '10만원 이하 블렌더 추천해줘',
  '200만원 이하 세탁기',
  '2만원 이하 충전 케이블 추천',
  // 가격 비교 (26-35)
  '삼성 T7 1TB 최저가 알려줘',
  '에어팟 프로 2 가격 비교해줘',
  '갤럭시 버즈3 프로 어디가 제일 싸?',
  '다이슨 에어랩 최저가',
  '맥북 에어 M3 가격 비교',
  '닌텐도 스위치 어디서 사는 게 제일 싸?',
  '소니 WH-1000XM5 최저가 찾아줘',
  'LG 그램 17인치 가격 비교',
  '아이패드 미니 7 최저가',
  '삼성 오디세이 G5 모니터 가격 비교해줘',
  // 비교 질문 (36-45)
  '에어팟 프로 vs 갤럭시 버즈 뭐가 나아?',
  '맥북이랑 갤럭시북 비교해줘',
  '다이슨이랑 LG 무선청소기 뭐가 좋아?',
  '기계식 키보드랑 멤브레인 차이가 뭐야?',
  '아이패드 에어랑 프로 뭐가 나을까?',
  'SSD랑 HDD 뭐 사야 돼?',
  '로지텍이랑 라울 마우스 비교',
  '샤오미 공기청정기 vs 삼성 비스포크',
  'OLED TV랑 QLED 뭐가 좋아?',
  '보스 헤드폰이랑 소니 헤드폰 비교해줘',
  // 후속 질문 — 독립 테스트 (46-55)
  '더 싼 거 없어?',
  '다른 색상도 있어?',
  '첫 번째 거 좀 더 알려줘',
  '두 번째 거 어디서 사?',
  '무선으로 된 건 없어?',
  '좀 더 비싼 거 보여줘',
  '삼성 말고 다른 브랜드로',
  '이거 말고 다른 거 추천해줘',
  '쿠팡에서 파는 거만 보여줘',
  '배송 빠른 거 있어?',
  // 구매 타이밍 (56-62)
  '에어팟 지금 사도 돼?',
  '블랙프라이데이까지 기다려야 해?',
  '이 가격이면 괜찮은 거야?',
  '요즘 가격이 많이 올랐어?',
  '최근에 가격 변동 있었어?',
  '지금이 최저가야?',
  '좀 더 기다리면 싸질까?',
  // 스펙 질문 (63-70)
  '에어팟 프로 배터리 얼마나 가?',
  '이 모니터 주사율이 몇이야?',
  '갤럭시 S24 울트라 무게 알려줘',
  '이 SSD 읽기 속도 얼마야?',
  '아이패드 에어 저장 용량 옵션 뭐 있어?',
  '이 키보드 스위치 종류가 뭐야?',
  '이 이어폰 방수 돼?',
  '이 노트북 램 업그레이드 되나?',
  // 비쇼핑 질문 (71-80)
  '너 이름이 뭐야?',
  '오늘 날씨 어때?',
  'USB-C가 뭐야?',
  '블루투스 5.3이랑 5.0 차이가 뭐야?',
  'OLED가 뭔지 설명해줘',
  '노이즈캔슬링 원리가 뭐야?',
  '와이파이 6E가 뭐야?',
  'MagSafe가 뭐야?',
  '환율이 상품 가격에 영향을 미쳐?',
  '쿠팡 로켓배송이 뭐야?',
  // 감사/인사 (81-85)
  '고마워!',
  '잘 알겠어 감사해',
  '도움 많이 됐어',
  '오 딱 이거야 고마워',
  '안녕하세요',
  // 브랜드 지정 (86-92)
  '소니 이어폰 추천해줘',
  '삼성 모니터 중에 괜찮은 거',
  '애플 제품만 보여줘',
  '로지텍 마우스 추천',
  '다이슨 제품 뭐가 있어?',
  '샤오미 가성비 제품 추천',
  'LG 노트북 추천해줘',
  // 복합/엣지 (93-100)
  '중고 에어팟도 괜찮아?',
  '남자친구 선물로 10만원대 추천해줘',
  '자취 시작하는데 필요한 가전 추천',
  '코딩할 때 쓸 모니터 추천해줘',
  '아이 학습용 태블릿 추천',
  '운동할 때 쓸 이어폰 뭐가 좋아?',
  '가격 많이 떨어진 제품 있어?',
  'ㅁㄴㅇㄹ',
];



// Strict QA: HTTP 200 is transport success, not a verified shopping recommendation.
// Follow-up cases 46-55 are preceded by real (unscored) seed turns.
const fs = require('fs');
const crypto = require('crypto');
const argv = process.argv.slice(2);
const live = argv.includes('--live');
const requireV3 = argv.includes('--require-v3');
function option(name, fallback) {
  const arg = argv.find(x => x.startsWith('--' + name + '='));
  return arg ? arg.slice(name.length + 3) : fallback;
}
const maxQuestions = Math.max(1, Math.min(100, Number(option('max', '100')) || 100));
const delayMs = Math.max(5500, Number(option('delay-ms', '5500')) || 5500);
const reviewPath = option('review-file', '');
const review = reviewPath ? JSON.parse(fs.readFileSync(reviewPath, 'utf8')) : {};
const budgetLimits = { 16: 50000, 17: 300000, 18: 200000, 19: 1000000,
  20: 30000, 22: 150000, 23: 100000, 24: 2000000, 25: 20000 };
const seedQuestions = {
  46: '5만원 이하 무선 이어폰 추천해줘',
  47: '아이패드 에어 추천해줘',
  48: '100만원 이하 노트북 추천해줘',
  49: '에어팟 프로와 갤럭시 버즈 비교해줘',
  50: '유선 헤드폰 추천해줘',
  51: '20만원 이하 기계식 키보드 추천해줘',
  52: '삼성 모니터 추천해줘',
  53: '5만원 이하 무선 마우스 추천해줘',
  54: '게이밍 마우스 추천해줘',
  55: '기계식 키보드 추천해줘'
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const session = () => 'test_' + crypto.randomBytes(16).toString('hex');
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1];
};
const nextHistory = (history, question, data) => [
  ...history, { role: 'user', content: question },
  { role: 'assistant', content: String(data.answer || data.text || '').slice(0, 500) }
].slice(-8);
const nextLegacyHistory = (history, question, data) => [
  ...history, { role: 'user', text: question },
  { role: 'assistant', text: String(data.text || data.answer || '').slice(0, 450),
    ...(typeof data.turnSig === 'string' ? { sig: data.turnSig } : {}) }
].slice(-6);
const qualityChecks = (number, data) => {
  const reasons = [];
  const cards = Array.isArray(data.cards) ? data.cards
    : Array.isArray(data.items) ? data.items : [];
  for (const [index, card] of cards.entries()) {
    const price = Number(card.price == null ? card.lprice : card.price);
    if (!Number.isFinite(price) || price <= 0) reasons.push('card_' + index + '_invalid_price');
    const cap = budgetLimits[number];
    if (cap && price > cap) reasons.push('card_' + index + '_over_budget');
    const link = String(card.url || card.link || card.productUrl || '');
    if (link && !/^https:\/\//i.test(link)) reasons.push('card_' + index + '_non_https_link');
  }
  return reasons;
};
async function send(question, context) {
  const started = Date.now();
  try {
    const payload = {
      question, message: question, sessionId: context.sessionId,
      state: context.state, history: context.history,
      chatHistory: context.chatHistory
    };
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(40000)
    });
    const raw = await res.text();
    let data;
    try { data = JSON.parse(raw); } catch (_) { data = { error: 'non_json_response' }; }
    const version = res.headers.get('x-ai-version') || 'unknown';
    const answer = typeof data.answer === 'string' ? data.answer
      : typeof data.text === 'string' ? data.text : '';
    return { status: res.status, version, elapsedMs: Date.now() - started,
      data, answer, transportOk: res.status === 200 && !!answer.trim() && !data.error,
      error: data.error || null };
  } catch (e) {
    return { status: 0, version: 'network-error', elapsedMs: Date.now() - started,
      data: {}, answer: '', transportOk: false, error: String(e.message || e) };
  }
}
function classify(number, result, notes) {
  // No automatic PASS: only a reviewed verdict with a written reason can PASS.
  const failures = [...notes];
  if (!result.transportOk) failures.push('transport_or_empty_answer');
  if (requireV3 && result.version !== 'v3') failures.push('unexpected_version');
  failures.push(...qualityChecks(number, result.data));
  if (failures.length) return { verdict: 'FAIL', reasons: failures };
  const human = review[String(number)] || review['Q' + String(number).padStart(3, '0')];
  if (human && human.verdict === 'FAIL' && typeof human.evidence === 'string' && human.evidence.trim())
    return { verdict: 'FAIL', reasons: ['human_review: ' + human.evidence] };
  if (human && human.verdict === 'PASS' && typeof human.evidence === 'string' && human.evidence.trim())
    return { verdict: 'PASS', reasons: ['human_review: ' + human.evidence] };
  return { verdict: 'UNVERIFIED', reasons: ['answer_quality_not_independently_reviewed'] };
}
function projection(n, q, res, verdict, reasons, seed) {
  const cards = Array.isArray(res.data.cards) ? res.data.cards
    : Array.isArray(res.data.items) ? res.data.items : [];
  return { id: 'Q' + String(n).padStart(3, '0'), question: q, seedQuestion: seed || null,
    status: res.status, version: res.version, elapsedMs: res.elapsedMs,
    transportOk: res.transportOk, verdict, reasons, answer: res.answer,
    cardCount: cards.length,
    cards: cards.map(c => ({ title: String(c.title || '').slice(0, 200),
      price: c.price == null ? c.lprice : c.price, mall: c.mall || null,
      url: c.url || c.link || null })),
    stats: res.data.stats || null, error: res.error };
}
async function run() {
  const plannedSeeds = Object.keys(seedQuestions).filter(n => Number(n) <= maxQuestions).length;
  console.log('SEOSA AI strict QA | ' + ENDPOINT + ' | ' + maxQuestions
    + ' scored questions + ' + plannedSeeds + ' live seed turns');
  if (!live) {
    console.log('DRY RUN ONLY. Use --live to make billable production API requests.');
    console.log('HTTP 200 never counts as a quality PASS. No calls made.');
    return;
  }
  const results = [];
  let requests = 0, knownCostUsd = 0, unpricedRequests = 0;
  for (let i = 0; i < maxQuestions; i++) {
    const number = i + 1, q = questions[i], seed = seedQuestions[number];
    const ctx = { sessionId: session(), state: {}, history: [], chatHistory: [] };
    let seedError = '';
    if (seed) {
      const before = await send(seed, ctx);
      requests++;
      if (!before.transportOk || (requireV3 && before.version !== 'v3')) {
        seedError = 'followup_seed_failed_or_wrong_version';
      } else {
        ctx.state = before.data.state && typeof before.data.state === 'object' ? before.data.state : {};
        ctx.history = nextHistory(ctx.history, seed, before.data);
        ctx.chatHistory = nextLegacyHistory(ctx.chatHistory, seed, before.data);
      }
      await sleep(delayMs);
    }
    if (seedError) {
      results.push(projection(number, q, { status: 0, version: 'not-run',
        elapsedMs: 0, data: {}, answer: '', transportOk: false, error: seedError },
        'UNVERIFIED', [seedError], seed));
      continue;
    }
    const actual = await send(q, ctx);
    requests++;
    const assessment = classify(number, actual, []);
    const item = projection(number, q, actual, assessment.verdict, assessment.reasons, seed);
    results.push(item);
    const price = actual.data.stats && Number(actual.data.stats.costUsd);
    if (Number.isFinite(price) && price > 0) knownCostUsd += price;
    else unpricedRequests++;
    console.log(item.id + ' ' + item.verdict + ' HTTP ' + item.status
      + ' [' + item.version + '] ' + item.elapsedMs + 'ms ' + q);
    if (i !== maxQuestions - 1) await sleep(delayMs);
  }
  const latencies = results.filter(r => r.status > 0).map(r => r.elapsedMs);
  const summary = {
    evaluated: results.length, actualHttpRequests: requests,
    pass: results.filter(r => r.verdict === 'PASS').length,
    fail: results.filter(r => r.verdict === 'FAIL').length,
    unverified: results.filter(r => r.verdict === 'UNVERIFIED').length,
    http200: results.filter(r => r.status === 200).length,
    v3: results.filter(r => r.version === 'v3').length,
    legacy: results.filter(r => r.version === 'legacy').length,
    p95Ms: percentile(latencies, 0.95),
    avgMs: latencies.length ? Math.round(latencies.reduce((s, n) => s + n, 0) / latencies.length) : null,
    knownCostUsd: Number(knownCostUsd.toFixed(6)), unpricedRequests,
    costVerified: unpricedRequests === 0
  };
  const filename = 'test-100-questions-strict-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
  fs.writeFileSync(filename, JSON.stringify({
    createdAt: new Date().toISOString(), endpoint: ENDPOINT, requireV3, summary, results,
    caveat: 'HTTP success is not recommendation correctness. Cost is unverified when telemetry is missing.'
  }, null, 2), 'utf8');
  console.log(JSON.stringify(summary, null, 2));
  console.log('Report: ' + filename);
}
run().catch(err => { console.error(err); process.exitCode = 1; });
