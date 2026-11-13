// SEOSA AI v3 100-question automated test
// 브라우저 콘솔에서 실행하거나 Node.js로 실행
// Usage: node scripts/test-100-questions.js https://seosa.ai.kr

const BASE = process.argv[2] || 'https://seosa.ai.kr';
const ENDPOINT = `${BASE}/api/ai`;

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

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function testOne(q, i) {
  const start = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: q }),
    });
    const elapsed = Date.now() - start;
    const data = await res.json();
    const version = res.headers.get('x-ai-version') || 'unknown';
    const hasAnswer = !!(data.answer && data.answer.trim());
    const hasCards = Array.isArray(data.cards) && data.cards.length > 0;
    const ok = res.status === 200 && hasAnswer;
    return { i: i + 1, q, ok, status: res.status, version, hasAnswer, hasCards, cardCount: hasCards ? data.cards.length : 0, elapsed, answer: (data.answer || '').slice(0, 80), error: data.error || null };
  } catch (e) {
    return { i: i + 1, q, ok: false, status: 0, version: 'error', hasAnswer: false, hasCards: false, cardCount: 0, elapsed: Date.now() - start, answer: '', error: e.message };
  }
}

async function run() {
  console.log(`\n🧪 SEOSA AI 100-Question Test — ${BASE}\n`);
  const results = [];
  for (let i = 0; i < questions.length; i++) {
    const r = await testOne(questions[i], i);
    const icon = r.ok ? '✅' : '❌';
    const cards = r.hasCards ? ` 📦${r.cardCount}` : '';
    console.log(`${icon} #${String(r.i).padStart(3)} [${r.version}] ${r.elapsed}ms${cards} — ${r.q}`);
    if (!r.ok) console.log(`     ↳ ${r.error || r.answer || `HTTP ${r.status}`}`);
    results.push(r);
    // Rate limit: 300ms between requests
    if (i < questions.length - 1) await sleep(300);
  }

  const success = results.filter(r => r.ok);
  const fail = results.filter(r => !r.ok);
  const v3Count = results.filter(r => r.version === 'v3').length;
  const legacyCount = results.filter(r => r.version === 'legacy').length;
  const avgTime = Math.round(results.reduce((s, r) => s + r.elapsed, 0) / results.length);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`📊 결과 요약`);
  console.log(`${'='.repeat(60)}`);
  console.log(`✅ 성공: ${success.length}/100`);
  console.log(`❌ 실패: ${fail.length}/100`);
  console.log(`🤖 v3 응답: ${v3Count}회 / legacy 응답: ${legacyCount}회`);
  console.log(`⏱  평균 응답시간: ${avgTime}ms`);

  if (fail.length) {
    console.log(`\n❌ 실패 목록:`);
    fail.forEach(r => {
      console.log(`  #${r.i} — ${r.q}`);
      console.log(`     ${r.error || r.answer || `HTTP ${r.status}`}`);
    });
  }

  console.log(`\n📦 카드 포함 응답: ${results.filter(r => r.hasCards).length}회`);
  console.log(`💬 텍스트만 응답: ${results.filter(r => r.ok && !r.hasCards).length}회`);
}

run().catch(console.error);
