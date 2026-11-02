#!/usr/bin/env node
/**
 * 후속 발화·사람 말이 검색어를 망치는 구조적 결함 회귀. 2026-11-02 Production 200문항 실측에서 온 유형을
 * 변형 문장 묶음으로 검사한다(특정 질문의 정답을 고정하지 않는다). 완전 오프라인.
 *
 *   node scripts/test-ai-followup-query-structure.js
 *
 *   A. 찾던 상품이 있는 대화의 후속 발화 → 그 낱말로 검색하지 않고 찾던 상품을 잇는다
 *   B. 대조군 — 대화 중이라도 새 상품을 말하면 새 상품을 찾는다
 *   C. 상황 설명·말투가 붙어도 검색어는 상품 구절이다
 *   D. 예산 구간 표현 (하한·상한·한글 금액)
 *   E. 비교 문형 — 두 모델을 나눈다
 *   F. 핸들러 25턴 — 기록 10개만 보내도 제외 브랜드·예산이 끝까지 유지되고, 엉뚱한 상품으로 검색하지 않는다
 *   G. 답변 표면 — 내부 공급자명, 관측 하루치의 «기록상 최저가 수준»
 */
'use strict';

const H = require('./_ai-chat-harness');
const { parseConstraints } = require('../api/_shopintent');
const { parseComparison } = require('../api/_ai-comparison');
const I = require('../api/_intent');
const FB = require('../api/_feedback');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; return; }
  fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}
const classify = (q, prior) => {
  const hist = prior ? [{ role: 'user', text: prior }, { role: 'assistant', text: '추천드렸어요.' }] : [];
  const log = console.log; console.log = () => {};
  try { return H.I.heuristicIntent(q, hist, { source: 'none' }); } finally { console.log = log; }
};

/* ── A ───────────────────────────────────────── */
const PRIORS = [['필기용 태블릿 추천해줘', '태블릿'], ['무선 이어폰 추천해줘', '이어폰'], ['가벼운 사무용 노트북 알아보는 중이에요', '노트북'], ['27인치 모니터 하나 골라줘', '모니터'], ['쿠션 좋은 러닝화 추천', '러닝화']];
const FOLLOWUPS = [
  '돈은 80만원밖에 못 써요', '가격은 50만원 안쪽이면 좋겠어', '상한은 30만원으로 할게요', '비싸다. 한 단계 싼 걸로 빨리 알려줘', '좀 더 싼 거 찾아줘', '이것보다 싼 후보 있어요?',
  '최종 추천 하나 궁금해', '딱 하나만 골라줘', '결론만 말해줘, 뭐 사?', '하나로 정해줘', '위 두 제품 중에 뭐가 나아?', '후보 두 개 차이가 뭐야', '두 번째 후보는 뭐야?', '다른 후보도 있어?',
  '색은 그레이 쪽으로 할게', '화이트 색상으로 바꿔서 봐줘', '실버 컬러가 좋아요', '신품으로만 추천해', '중고 들어가면 안 돼요', '리퍼랑 중고는 빼고', '미개봉 새 제품만요',
  '첫 번째 추천 다시 얘기하자', '처음에 추천했던 제품 다시 보여줘', '원래 보던 걸로 돌아갈게', '애플 제품은 빼줘', 'HP 말고 다른 브랜드로', '난 소니 안 좋아해. 빼고 봐줘', '참고로 PDF에 필기 하려고 사는 거예요', '주로 출퇴근할 때 써요'
];
for (const [prior, noun] of PRIORS) for (const q of FOLLOWUPS) {
  const d = classify(q, prior);
  ok(String(d.query || '').includes(noun), `A 후속 발화가 찾던 상품을 잇는다: «${prior}» → «${q}»`, `query=${d.query} intent=${d.intent}`);
}
// 대화 내용을 묻는 말은 검색 자체를 하지 않는다
const META = ['오늘 대화 요약해줘', '지금까지 대화 정리해줄래', '그럼 지금 조건 전체 다시 말해봐', '현재 적용된 조건 알려줘', '지금 예산 얼마로 보고 있어?', '예산 다시 확인해줘', '바꾼 예산 기준이 맞아요?', '아까 추천한 제품 이름이 뭐였지?', '네가 마지막에 추천한 게 뭐였어?', '추천이 왜 바뀌었어?', '처음 추천이랑 달라진 이유 알려줘'];
for (const [prior] of PRIORS) for (const q of META) {
  const d = classify(q, prior);
  ok(!d.query, `A 대화 내용 질문은 검색하지 않는다: «${q}»`, `query=${d.query}`);
}
// 찾던 상품 이름을 끝에 덧붙여도 새 검색이 아니다
for (const tail of ['필기용 태블릿 기준으로요', '지금 보는 필기용 태블릿 말이야', '(필기용 태블릿)']) {
  const d = classify(`오늘 대화 요약해줘 ${tail}`, '필기용 태블릿 추천해줘');
  ok(!d.query, `A 찾던 상품 이름 덧붙임: ${tail}`, `query=${d.query}`);
}

/* ── B 대조군 ─────────────────────────────────── */
const NEW_PRODUCTS = [['이제 노트북 추천해줘', '노트북'], ['칼림바 추천해줘', '칼림바'], ['그거 말고 로봇청소기 알아봐줘', '로봇청소기'], ['갤럭시탭 S9 FE 얼마야', 'S9'], ['에어팟 프로 3 가격 알려줘', '에어팟'], ['선크림도 하나 추천해줘', '선크림']];
for (const [q, want] of NEW_PRODUCTS) {
  const d = classify(q, '무선 마우스 추천해줘');
  ok(String(d.query || '').toLowerCase().includes(want.toLowerCase()), `B 새 상품은 새로 찾는다: «${q}»`, `query=${d.query}`);
}
const OPTION = classify('256GB 모델로 볼게', '갤럭시탭 S10 FE 추천해줘');
ok(/256gb/i.test(OPTION.query) && /s10/i.test(OPTION.query), 'B 옵션 낱말은 앞 상품에 누적한다', `query=${OPTION.query}`);

for (const [opt, want] of [['실버로 바꾸면?', '실버'], ['512GB로 바꿔줘', '512'], ['스타라이트로 바꿔줘', '스타라이트'], ['화이트로 보여줘', '화이트']]) {
  const product = I.conversationProduct([{ role: 'user', text: '소니 WH-1000XM5 블랙 가격 알려줘' }, { role: 'assistant', text: 'x' }, { role: 'user', text: opt }, { role: 'assistant', text: 'y' }]);
  ok(product.toLowerCase().includes(want) && /xm5/i.test(product), `B 옵션 정정이 찾던 상품에 누적된다: «${opt}»`, product);
}

// 사전에 없는 상품 이름을 가격으로 물으면 후속 단서(후보·다시)가 있어도 그 상품을 찾는다 (독립 홀드아웃 회귀).
for (const [q, want] of [['후보 중 비보북 판매가 다시 조회해 줘', '비보북'], ['후보 중에 젠북 가격 다시 알려줘', '젠북'], ['다시 보니 씽크패드는 얼마야', '씽크패드'], ['첫 번째 후보 말고 아이디어패드 가격 확인해줘', '아이디어패드']]) {
  const d = classify(q, '15만원 이하 노트북 추천해줘');
  ok(!d.followupKind && String(d.query || '').includes(want), `B 사전에 없는 상품의 가격 질문: «${q}»`, `query=${d.query} kind=${d.followupKind}`);
}
// 대조군 — 상품 이름 없이 가격만 다시 묻는 말과 예산만 말한 문장은 찾던 상품을 잇는다.
for (const q of ['다른 후보 가격 다시 알려줘', '가격은 50만원 안쪽이면 좋겠어', '현재가 다시 확인해줘']) {
  const d = classify(q, '가벼운 사무용 노트북 추천해줘');
  ok(String(d.query || '').includes('노트북'), `B 대조군: 찾던 상품을 잇는다 «${q}»`, `query=${d.query}`);
}

/* ── C 상황 설명 ─────────────────────────────── */
const LEADS = ['커뮤니티에서 추천 많길래요.', '월급 들어와서 하나 지르려고요.', '다음 주 출장 전에 필요해서요.', '제가 이런 쪽을 잘 몰라서요,', '퇴근길에 잠깐 찾아보는 중인데', '주변에서 다들 좋다길래', '오늘 처음 이 사이트 써봐요.', '부모님 드릴 거라 실패하면 안 돼요.'];
const TAILS = ['', ' 솔직하게 말해주세요', ' 답변 고마워요', ' 너무 길지 않게요', ' 꼭 답해줘', ' 쉽게 설명해줘', ' 결론부터 말해줘', ' 초보라 잘 몰라요'];
const CORES = [['공기청정기 추천해줘', ['공기청정기']], ['로지텍 MX Master 3S 가격 알려줘', ['로지텍', 'MX', 'Master', '3S']], ['갤럭시탭 S10 FE 지금 사도 돼요?', ['갤럭시탭', 'S10', 'FE']], ['유모차 보여줘', ['유모차']], ['삼성 T7 500GB 얼마예요?', ['삼성', 'T7', '500']], ['다이슨 V12 파는 곳 있어?', ['다이슨', 'V12']]];
const NOISE = /많길래|길래|지르려고|출장|몰라서|퇴근|찾아보|좋다길래|사이트|솔직|고마워|길지|답해|설명|결론|초보|실패|부모님|월급/;
for (const lead of LEADS) for (const tail of TAILS) for (const [core, want] of CORES) {
  const q = `${lead} ${core}${tail}`;
  const d = classify(q);
  const got = String(d.query || '');
  ok(!NOISE.test(got), `C 검색어에 사람 말이 섞이지 않는다: «${q}»`, `query=${got}`);
  ok(want.every(w => got.toLowerCase().includes(w.toLowerCase())), `C 상품 구절이 남는다: «${q}»`, `query=${got}`);
}
// 수식어만 부정한 말에서 상품 이름을 잃지 않는다
for (const [q, want] of [['다이슨 V12 중고 말고 정품 새 상품 찾아줘', 'V12'], ['에어팟 프로 2 케이스 말고 본체 가격', '에어팟'], ['아이패드 에어 필름 빼고 본체 찾아줘', '아이패드'], ['맥북 에어 M3 리퍼 제외하고 얼마야', '맥북']]) {
  ok(String(classify(q).query || '').includes(want), `C 수식어 부정: «${q}»`, classify(q).query);
}
// 대조군 — 사전에 없는 상품도 그대로 찾는다
for (const [q, want] of [['레고 블록 추천해줘', '레고'], ['닭가슴살 4만원 이하로 추천해줘', '닭가슴살'], ['캠핑용 빔프로젝터 추천해줘', '빔프로젝터'], ['엄마 드릴 안마기 뭐가 좋아?', '안마기'], ['음파 칫솔 예산 상한은 9만원입니다. 추천 부탁드려요', '칫솔']]) {
  ok(String(classify(q).query || '').includes(want), `C 대조군: «${q}»`, classify(q).query);
}
// 이름 난 상품의 가격을 물으면 지식 답변으로 빠지지 않는다
for (const q of ['다이슨 V12 평소 가격이랑 비교하면 어때요', 'Q Revo 몇 시 기준 가격인지 알려줘', '소니 WH-1000XM5 할인 중인 가격이야?']) {
  const d = classify(q);
  ok(['C', 'D', 'E'].includes(d.intent) && d.query, `C 가격 질문은 검색한다: «${q}»`, `intent=${d.intent} q=${d.query}`);
}

/* ── D 예산 ──────────────────────────────────── */
const BUDGET = [
  ['6만원은 넘되 120,000원은 안 넘는 운동화', 60000, 120000], ['110만은 넘되 170만원은 안 넘는 카메라', 1100000, 1700000], ['예산 최소 5만원, 최대 15만로 헤드폰', 50000, 150000],
  ['노트북 최소 120만은 줘야 쓸 만하다던데', 1200000, 0], ['십삼만원 이상은 써도 되니까 헤드셋', 130000, 0], ['돈이 35만원밖에 없는데 에어프라이어', 0, 350000],
  ['12만원 이상 15만원 이하 키보드', 120000, 150000], ['15만원 이하이면서 12만원 이상 키보드', 120000, 150000], ['12만 5천원부터 15만원까지 마우스', 125000, 150000],
  ['20만을 넘기지 않는 선에서 외장하드', 0, 200000], ['적어도 30만원은 넘는 모니터', 300000, 0], ['이십만원 이하 이어폰', 0, 200000], ['30만원 넘는 모니터', 300000, 0]
];
for (const [q, min, max] of BUDGET) {
  const c = parseConstraints(q);
  ok(c.budgetMin === min && c.budgetMax === max, `D 예산 «${q}»`, `min=${c.budgetMin} max=${c.budgetMax}`);
}
ok(parseConstraints('10만원 무선 이어폰').budgetSoft === true, 'D 대조군: 단서 없는 금액은 그대로 여유 상한');
ok(!parseConstraints('이어폰 삼만 원어치 말고').budgetMin, 'D 대조군: 한글 금액 변환이 하한을 만들지 않는다');
ok(parseConstraints('오늘 이만 갈게').budgetMax === 0, 'D 대조군: «이만» 은 금액이 아니다');

/* ── E 비교 ──────────────────────────────────── */
const PAIRS = [['갤럭시 버즈 FE', '에어팟 4'], ['LG 그램 17', '맥북 프로 14 M4'], ['FC750R PD', '키크론 K2'], ['닌텐도 스위치 2', '플레이스테이션 5 슬림'], ['로보락 S8', '로보락 Q Revo'], ['소니 WH-1000XM5', '보스 QC 울트라']];
const FORMS = [
  (a, b) => `${a} 살까 ${b} 살까 고민이에요`, (a, b) => `${a} vs ${b} 뭐가 더 나아?`, (a, b) => `${b} 대신 ${a} 사도 후회 안 할까?`,
  (a, b) => `${a}에서 ${b}로 넘어갈 만한 차이가 있어?`, (a, b) => `${a}, ${b} 둘 다 후보인데 하나만 정해줘`, (a, b) => `${a}랑 ${b} 중에 가성비 좋은 쪽은?`,
  (a, b) => `${a}와 ${b}의 가격 차이가 지금 얼마나 나요?`, (a, b) => `주변에서 다들 좋다길래 ${a}랑 ${b} 중에 뭐가 나아요?`, (a, b) => `다음 주 출장 전에 필요해서요. ${a} vs ${b} 비교해줘 꼭 답해줘`
];
for (const [a, b] of PAIRS) for (const f of FORMS) {
  const q = f(a, b);
  const r = parseComparison(q);
  const sides = r ? [r.left || r[0] || r.a, r.right || r[1] || r.b].map(String) : [];
  const has = x => sides.some(s => s.toLowerCase().replace(/\s+/g, '').includes(x.toLowerCase().replace(/\s+/g, '')));
  ok(r && has(a) && has(b) && sides.every(s => !/길래|출장|살까|고민|사도|의$|중$/.test(s)), `E 비교 분리: «${q}»`, JSON.stringify(sides));
}
for (const q of ['아이패드 추천해줘', '20만원 이하 키보드랑 마우스 세트 추천해줘', '게이밍 말고 사무용 마우스 추천']) {
  ok(!parseComparison(q), `E 대조군: 비교가 아니다 «${q}»`);
}

/* ── 제외 읽기 ───────────────────────────────── */
for (const [q, name] of [['제습기 살 건데 LG 제품은 절대 싫어요', 'LG'], ['운동화 살 건데 아디다스 제품은 절대 싫어요', '아디다스'], ['앤커 빼고 보조배터리 추천해줘', '앤커'], ['리바트만 아니면 돼요. 책상 뭐 좋아?', '리바트'], ['삼성 말고 다른 브랜드 냉장고', '삼성']]) {
  const ex = FB.readFeedback(q).excludes.map(e => e.name);
  ok(ex.includes(name), `제외 읽기 «${q}»`, JSON.stringify(ex));
}
ok(FB.readFeedback('애플 빼달라는 거 취소').excludes.length === 0, '제외를 거두는 말은 제외가 아니다');
{
  const list = FB.applyExcludes([{ title: 'Apple 아이패드 에어 M3' }, { title: '갤럭시탭 S10 FE' }, { title: 'LG전자 그램 14' }], [{ name: '애플', hard: true }, { name: 'LG', hard: true }]);
  ok(list.length === 1 && /갤럭시탭/.test(list[0].title), '브랜드 제외는 그 브랜드의 제품군 이름까지 뺀다', JSON.stringify(list.map(x => x.title)));
}

/* ── F 핸들러 25턴 ───────────────────────────── */
async function fullSession() {
  const LAPTOP = [
    ['n1', 'HP 2026 비전 15 코어Ultra5 노트북', 999000, 'hp'], ['n2', 'LG전자 그램 14 14Z90T 사무용 노트북', 1390000, 'lg'], ['n3', '삼성전자 갤럭시북5 프로 노트북 NT940', 1490000, 'ss'],
    ['n4', '레노버 아이디어패드 슬림3 사무용 노트북', 720000, 'lv'], ['n5', 'ASUS 비보북 15 사무용 노트북 X1504', 650000, 'as']
  ];
  LAPTOP.forEach(([pid, title, price]) => H.addProduct({ pid, vid: pid + 'v', title, price, keys: ['노트북', '사무용'], history: [[0, price], [3, price + 20000], [10, price + 30000]] }));
  H.addProduct({ pid: 'bk1', vid: 'bk1v', title: '[국내도서] 얘기하자 최종완결판', price: 15000, keys: ['얘기하자', '최종', '나아', '돈'], history: [[0, 15000]] });
  H.addProduct({ pid: 'bk2', vid: 'bk2v', title: '[eBook] 노트북 활용 사무용 안내서', price: 9000, keys: ['노트북', '사무용'], history: [[0, 9000]] });
  const s = H.session();
  const script = [
    ['가벼운 사무용 노트북 추천해줘', {}], ['예산은 150만원까지야', { max: 1500000 }], ['HP 말고 다른 브랜드로', { max: 1500000, no: 'HP' }], ['문서 작업이 제일 중요해', { max: 1500000, no: 'HP' }],
    ['왜 이 제품이 1순위예요?', { no: 'HP' }], ['좀 더 싼 거 찾아줘', { max: 1500000, no: 'HP' }], ['실버 컬러가 좋아요', { max: 1500000, no: 'HP' }], ['지금 어떤 조건으로 찾고 있어?', { meta: true }],
    ['방금 추천 뭐였죠?', { meta: true }], ['LG 그램 14랑 비교하면 어때?', { skipCards: true }], ['지금 사는 게 나을까, 기다릴까?', { no: 'HP' }], ['첫 번째 추천 다시 얘기하자', { max: 1500000, no: 'HP' }],
    ['혹시 HP 제품 들어간 건 없지?', { max: 1500000, no: 'HP' }], ['그 제품 지금 얼마라고?', { no: 'HP' }], ['상한을 180만원으로 바꿀게요', { max: 1800000, no: 'HP' }], ['지금 예산 얼마로 보고 있어?', { meta: true }],
    ['512GB짜리 있어?', { max: 1800000, no: 'HP' }], ['미개봉 새 제품만요', { max: 1800000, no: 'HP' }], ['그거 말고 다음 순위는요?', { max: 1800000, no: 'HP' }], ['위 두 제품 중에 뭐가 나아?', { max: 1800000, no: 'HP' }],
    ['추천이 왜 바뀌었어?', { meta: true }], ['현재 적용된 조건 알려줘', { meta: true }], ['최종 추천 하나 궁금해', { max: 1800000, no: 'HP' }], ['하나로 정해줘', { max: 1800000, no: 'HP' }], ['오늘 대화 요약해줘', { meta: true }]
  ];
  let turn = 0;
  for (const [q, exp] of script) {
    turn++;
    const r = await s.say(q, { answer: '확인했습니다.', classify: 'C', resolve: '' });
    const items = (r.body && r.body.items) || [];
    ok(r.status === 200, `F#${turn} 응답 «${q}»`, `status=${r.status}`);
    ok(!items.some(i => /국내도서|eBook/.test(i.title)), `F#${turn} 책이 나오지 않는다 «${q}»`, JSON.stringify(items.map(i => i.title)));
    if (exp.skipCards) continue;
    if (exp.meta) ok(r.searches === 0, `F#${turn} 대화 내용 질문은 검색하지 않는다 «${q}»`, `searches=${r.searches}`);
    if (exp.max) ok(items.every(i => Number(i.lprice) <= exp.max), `F#${turn} 예산 유지 «${q}»`, JSON.stringify(items.map(i => [i.title, i.lprice])));
    if (exp.no) ok(!items.some(i => i.title.includes(exp.no)), `F#${turn} 제외 유지 «${q}»`, JSON.stringify(items.map(i => i.title)));
  }
  // 제외를 거두면 다시 나올 수 있다
  const rel = await s.say('이제 HP도 괜찮아, 다시 넣어줘', { answer: '확인했습니다.', classify: 'C', resolve: '' });
  const relItems = (rel.body && rel.body.items) || [];
  ok(!relItems.some(i => /국내도서|eBook/.test(i.title)), 'F 제외 해제 턴도 찾던 상품을 잇는다', JSON.stringify(relItems.map(i => i.title)));
}

/* ── G 답변 표면 ─────────────────────────────── */
function surfaces() {
  const Decision = require('../api/_decision');
  ok(/card\.mallLabel/.test(require('fs').readFileSync(require('path').join(__dirname, '../api/ai.js'), 'utf8')), 'G «첫 번째 추천 카드» 줄은 표시 이름을 쓴다');
  const names = Object.keys(Decision).join();
  ok(names.length > 0, 'G _decision 모듈 로드');
}

(async () => {
  surfaces();
  await fullSession();
  console.log(`=== 결과: ${pass}/${pass + fail} PASS ===`);
  failures.slice(0, 60).forEach(f => console.log('  [FAIL]', f.slice(0, 220)));
  process.exit(fail ? 1 : 0);
})();
