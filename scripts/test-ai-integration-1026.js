'use strict';
/*
 * 2026-10-26 통합(#196 → main) 검토에서 실제 핸들러로 재현한 결함의 회귀 테스트.
 * GPT·쇼핑 API·DB 는 _ai-chat-harness 대역 — 실제 호출 0, DB 쓰기 0.
 *
 *   A. 예산 상한 근처 우선 — 근처(상한의 80% 이상)에 상품이 없다고 예산 안 상품까지 거절하지 않는다.
 *      «그램 200만원 이하» 에 159만원·64.5만원 그램이 있는데 "197만~200만원에서 못 찾음" 으로 끝났다.
 *   B. 같은 대화의 후속 쇼핑 턴은 카드 한 장. 명시적 다중 상품 비교는 예외.
 *   C. 색상 옵션 제외 — "실버 얼마야? 스페이스그레이 가격은 제외해줘" 가 제외한 색만 보여 줬다.
 *      #196 은 «버즈3 프로 + 정해진 문장» 만 고쳤다(코드에 그 문장을 박았다). 어느 상품·어느 말투든 같아야 한다.
 *   D. "스페이스그레이" 의 '이' 를 조사로 떼어 색을 잃던 검색어.
 */
const H = require('./_ai-chat-harness');
const F = require('./_ai-chat-fixtures');
const I = require('../api/_intent');
const AIID = require('../api/_aiidentity');
const CS = require('../api/_convstate');
const BW = require('../api/_ai-budget-window');
F.ALL.forEach(H.addProduct);

// 1000문항 코퍼스에 없는 상품 — 같은 모델의 색 옵션 둘씩.
H.addProduct({ pid: 'APM', vid: 'APM-SILVER', mall: '쿠팡', title: 'Apple 에어팟 맥스 USB-C 실버', price: 699000, keys: ['에어팟 맥스', 'airpods max'], history: [[0, 699000]] });
H.addProduct({ pid: 'APM', vid: 'APM-GRAY', mall: '쿠팡', title: 'Apple 에어팟 맥스 USB-C 스페이스그레이', price: 649000, keys: ['에어팟 맥스', 'airpods max'], history: [[0, 649000]] });
H.addProduct({ pid: 'GW7', vid: 'GW7-GREEN', mall: '쿠팡', title: '삼성 갤럭시 워치7 44mm 그린', price: 289000, keys: ['워치7', '갤럭시 워치'], history: [[0, 289000]] });
H.addProduct({ pid: 'GW7', vid: 'GW7-SILVER', mall: '쿠팡', title: '삼성 갤럭시 워치7 44mm 실버', price: 259000, keys: ['워치7', '갤럭시 워치'], history: [[0, 259000]] });
[['HS1', '스카이 일상용 블루투스 무선 헤드셋 H5', 145000], ['HS2', '무선 블루투스 통화 헤드셋 Y2', 121000], ['HS3', '일반 블루투스 무선 헤드셋 3', 49900]]
  .forEach(([pid, title, price]) => H.addProduct({ pid, vid: pid + '-O', mall: '쿠팡', title, price, keys: ['헤드셋'], history: [[0, price]] }));

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + JSON.stringify(detail) : '')); }
}
const prices = r => (r.body.items || []).map(c => Number(c.lprice));
const titles = r => (r.body.items || []).map(c => c.title);
const ans = '서사에서 확인한 상품 기준으로 안내드려요.';

(async () => {
  console.log('[A] 예산 상한 근처 우선, 근처에 없으면 예산 안 상품');
  {
    const r = await H.ask({ question: '그램 노트북 200만원 이하로 추천해줘' }, { classify: 'C|그램 노트북', answer: ans });
    ok(r.status === 200 && prices(r).length >= 1, 'A1 200만원 이하 그램 — 예산 안 그램(159만·64.5만)을 보여 준다', { p: prices(r), t: r.body.text });
    ok(prices(r).every(p => p > 0 && p <= 2000000), 'A1 카드는 모두 200만원 이하 (상한은 그대로 지킨다)', prices(r));
    ok(!titles(r).some(t => /17Z90SP/.test(t)), 'A1 219만원 그램 프로는 빠진다', titles(r));
    ok(/가까운|근처/.test(r.body.text || '') && /200만원|2,000,000원/.test(r.body.text || ''),
      'A1 상한 근처에 없었다는 사실을 답에 밝힌다', r.body.text);
    ok(!/추천하지 않을게요/.test(r.body.text || ''), 'A1 예산 안 상품이 있는데 «추천하지 않을게요» 로 끝내지 않는다', r.body.text);

    const r2 = await H.ask({ question: '그램 노트북 100만원 이하로 추천해줘' }, { classify: 'C|그램 노트북', answer: ans });
    ok(prices(r2).length === 1 && prices(r2)[0] === 645000, 'A2 100만원 이하 → 64.5만원 그램15', prices(r2));

    // 근처에 상품이 있으면 근처만 (#192 정책 유지): 15만원 이하 헤드셋 → 12~15만원
    const r3 = await H.ask({ question: '헤드셋 15만원 이하로 추천해줘' }, { classify: 'C|헤드셋', answer: ans });
    ok(prices(r3).length >= 2 && prices(r3).every(p => p >= 120000 && p <= 150000), 'A3 15만원 이하 → 12~15만원 후보만', prices(r3));

    // 창 넓이 — 상한에 비례 (최소 3만원). 200만원 상한의 «근처» 가 197만원부터일 수는 없다.
    const w = BW.nearBudgetWindow([], { budgetMax: 2000000, budgetSaid: 2000000 }, '노트북 추천');
    ok(w.applies && w.lower === 1600000 && w.upper === 2000000, 'A4 200만원 상한의 근처 = 160만~200만원', w);
    const w2 = BW.nearBudgetWindow([], { budgetMax: 150000, budgetSaid: 150000 }, '헤드셋 추천');
    ok(w2.lower === 120000 && w2.upper === 150000, 'A4 15만원 상한의 근처 = 12만~15만원 (최소 폭 3만원)', w2);
    const w3 = BW.nearBudgetWindow([], { budgetMax: 50000, budgetSaid: 50000 }, '이어폰 추천');
    ok(!w3.applies, 'A4 5만원 이하 예산은 근처 창을 쓰지 않는다 (저예산 예외)', w3);
  }

  console.log('[B] 후속 쇼핑 질문은 카드 한 장, 명시적 비교는 여러 장');
  {
    const s = H.session();
    const a = await s.say('헤드셋 15만원 이하로 추천해줘', { classify: 'C|헤드셋', answer: ans });
    ok(prices(a).length >= 2, 'B1 첫 요청은 여러 장', prices(a));
    const b = await s.say('흠 일상용으로 쓰는 헤드셋 게임 헤드셋같은거 말고', { classify: 'C|헤드셋', answer: ans });
    ok(prices(b).length === 1, 'B2 같은 헤드셋을 이어 묻는 후속 질문은 한 장', prices(b));
    const c = await s.say('그럼 그램 노트북도 추천해줘', { classify: 'C|그램 노트북', answer: ans });
    ok(prices(c).length === 1 && /그램/.test(titles(c)[0] || ''), 'B3 종류가 바뀐 새 요청(헤드셋 → 노트북)도 새 검색에서 대표 카드 한 장', titles(c));
    const d = await s.say('배터리 오래가는 게 중요해', { classify: 'C|그램 노트북', answer: ans });
    ok(prices(d).length <= 1, 'B4 바뀐 주제(노트북)를 이어 묻는 후속 질문은 다시 한 장', titles(d));
  }

  console.log('[C] 색상 옵션 제외 — 상품·말투가 달라도 같은 규칙');
  const colorCases = [
    ['에어팟 맥스 실버 얼마야? 스페이스그레이 가격은 제외해줘', 'D|에어팟 맥스 실버', /실버/, /스페이스그레이/],
    ['에어팟 맥스 실버 얼마야? 스페이스그레이 금액과 섞지 말아줘', 'D|에어팟 맥스 실버', /실버/, /스페이스그레이/],
    ['갤럭시 워치7 그린 가격 알려줘. 실버 가격은 빼줘', 'D|갤럭시 워치7 그린', /그린/, /실버/],
    ['갤럭시 버즈3 프로 화이트 얼마야? 블랙 가격은 제외해줘', 'D|갤럭시 버즈3 프로 화이트', /화이트/, /블랙/],
    ['갤럭시 버즈3 프로 블랙 얼마야? 화이트 금액과 섞지 말아줘', 'D|갤럭시 버즈3 프로 블랙', /블랙/, /화이트/],
    ['버즈3 프로 화이트 가격 알려줘, 블랙은 제외하고', 'D|갤럭시 버즈3 프로 화이트', /화이트/, /블랙/],
    ['갤럭시 버즈3 프로 블랙 가격? 화이트랑 헷갈리지 말고', 'D|갤럭시 버즈3 프로 블랙', /블랙/, /화이트/],
    ['에어팟 맥스 스페이스그레이 얼마야? 실버랑 혼동하지 마', 'D|에어팟 맥스 스페이스그레이', /스페이스그레이/, /실버/]
  ];
  for (const [q, cls, want, notWant] of colorCases) {
    const r = await H.ask({ question: q }, { classify: cls, answer: ans });
    const t = titles(r);
    ok(t.length >= 1 && want.test(t[0]) && !t.some(x => notWant.test(x)), 'C ' + q, t);
  }
  {
    // 제외가 아닌 말은 그대로 — 두 색을 나란히 비교해 달라는 요청은 두 색 다.
    const r = await H.ask({ question: '갤럭시 버즈3 프로 블랙과 화이트 비교해줘' }, { classify: 'B', answer: '착용감과 케이스 색을 확인하세요.' });
    ok(titles(r).length === 2 && titles(r).some(x => /블랙/.test(x)) && titles(r).some(x => /화이트/.test(x)), 'C 두 색 비교 요청은 두 색 다 남는다', titles(r));
    const s = AIID.splitNegations('갤럭시 버즈3 프로 화이트 얼마야? 블랙 가격은 제외해줘');
    ok(s.negated.some(n => n.text === '블랙') && !/블랙/.test(s.positive), 'C splitNegations: «블랙 가격은 제외» 의 제외 대상은 블랙', s);
    const s2 = AIID.splitNegations('노트북 추천해줘. 중고 상품은 제외해줘');
    ok(s2.negated.some(n => n.text === '중고') && /노트북/.test(s2.positive), 'C splitNegations: «중고 상품은 제외» 의 제외 대상은 중고', s2);
    const s3 = AIID.splitNegations('추천하지 말고 가격만 알려줘');
    ok(!s3.negated.length, 'C «-지 말고» 는 여전히 부정 목록이 아니다', s3);
  }

  console.log('[D] 색 이름의 끝 글자 «이» 는 조사가 아니다');
  {
    const c = I.classify('에어팟 맥스 스페이스그레이 얼마야', []);
    ok(/스페이스그레이/.test(c.query), 'D1 검색어에 스페이스그레이가 그대로', c.query);
    const c2 = I.classify('노트북 그레이 색상으로 추천해줘', []);
    ok(/그레이/.test(c2.query), 'D2 검색어에 그레이가 그대로', c2.query);
    const c3 = I.classify('노트북이 필요해', []);
    ok(c3.query === '노트북', 'D3 일반 조사는 그대로 뗀다 (노트북이 → 노트북)', c3.query);
  }

  console.log('[E] 종류 판정 — 무게 단위 «그램» 은 노트북이 아니다');
  {
    ok(CS.productKindChanged('헤드셋', '그램 노트북'), 'E1 헤드셋 → 그램 노트북 은 종류가 바뀐 것');
    ok(!CS.productKindChanged('그램 노트북', '그램16 16Z90S'), 'E2 그램 노트북 → 그램16 은 같은 종류');
    ok(!CS.categoryNounsOf('닭가슴살 100 그램 30팩').includes('노트북'), 'E4 «100 그램» 은 노트북 별칭이 아니다', CS.categoryNounsOf('닭가슴살 100 그램 30팩'));
    ok(CS.categoryNounsOf('그램 16 추천').includes('노트북'), 'E5 «그램 16» 은 노트북', CS.categoryNounsOf('그램 16 추천'));
  }

  console.log('[F] 두 상품 비교 — 조사·앞말·종류 비교·예산');
  {
    const CMP = require('../api/_ai-comparison');
    const p = q => JSON.stringify(CMP.parseComparison(q));
    ok(p('그램16이랑 맥북에어 M3 가성비 비교') === '["그램16","맥북에어 M3"]', 'F1 «그램16이랑» 의 «이» 는 조사 (받침 뒤 이랑)', p('그램16이랑 맥북에어 M3 가성비 비교'));
    ok(p('에어팟 맥스 실버랑 스페이스그레이 비교해줘') === '["에어팟 맥스 실버","에어팟 맥스 스페이스그레이"]', 'F2 «실버랑 스페이스그레이» 는 같은 계열의 두 색', p('에어팟 맥스 실버랑 스페이스그레이 비교해줘'));
    ok(p('학생용으로 그램이랑 맥북 비교해줘') === '["그램","맥북"]', 'F3 앞의 용도는 검색어가 아니다', p('학생용으로 그램이랑 맥북 비교해줘'));
    ok(p('50만원 이하로 아이패드랑 갤럭시탭 비교해줘') === '["아이패드","갤럭시탭"]', 'F4 앞의 예산은 검색어가 아니다', p('50만원 이하로 아이패드랑 갤럭시탭 비교해줘'));
    ok(CMP.parseComparison('노트북과 태블릿 차이 알려줘') === null, 'F5 종류끼리의 차이는 상품 비교가 아니다');
    ok(CMP.parseComparison('무선 이어폰이랑 유선 이어폰 비교해줘') === null, 'F5 꾸밈말 + 종류도 상품 비교가 아니다');
    ok(p('아이패드랑 갤럭시탭을 비교해줘') === '["아이패드","갤럭시탭"]', 'F6 아이패드·갤럭시탭은 계열 이름이라 비교한다');

    H.addProduct({ pid: 'IPAD-1026', vid: 'IPAD-1026-V', mall: '쿠팡', title: 'Apple 아이패드 11 A16 128GB Wi-Fi 태블릿', price: 399000, keys: ['아이패드'], history: [[0, 399000]] });
    H.addProduct({ pid: 'GTAB-1026', vid: 'GTAB-1026-V', mall: '쿠팡', title: '삼성전자 갤럭시탭 S10 FE 128GB Wi-Fi 태블릿', price: 429000, keys: ['갤럭시탭'], history: [[0, 429000]] });
    const r = await H.ask({ question: '40만원 이하로 아이패드랑 갤럭시탭 비교해줘' }, { classify: 'B', answer: '사용 환경을 확인하세요.' });
    ok(r.body.comparison && r.body.comparison.complete === false, 'F7 예산 안에 한쪽만 있으면 비교는 완결이 아니다', r.body.comparison);
    ok(prices(r).length === 1 && prices(r)[0] === 399000, 'F7 카드는 예산 안의 아이패드(39.9만원)만', prices(r));
    ok(/예산\(40만원 이하\) 안에서 정확히 일치하는 판매 상품을 확인하지 못했어요/.test(r.body.text || ''), 'F7 갤럭시탭은 «예산 안에서 확인 못 함» 이라고 밝힌다', r.body.text);
    const r2 = await H.ask({ question: '아이패드랑 갤럭시탭 비교해줘' }, { classify: 'B', answer: '사용 환경을 확인하세요.' });
    ok(prices(r2).length === 2 && r2.body.comparison.complete === true, 'F8 예산이 없으면 두 상품 다', prices(r2));
    const r3 = await H.ask({ question: '노트북과 태블릿 차이 알려줘' }, { classify: 'B', answer: '휴대성과 입력 방식이 달라요.' });
    ok(!r3.body.comparison, 'F9 종류 차이 질문은 가격 비교 경로로 가지 않는다', r3.body.comparison);
  }

  console.log('\n결과: ' + pass + ' PASS / ' + fail + ' FAIL');
  console.log('AI_INTEGRATION_1026 ' + JSON.stringify({ pass, fail, realGptCalls: 0, externalCalls: H.counters.external, dbWrites: H.counters.dbWrites }));
  if (fail || H.counters.external || H.counters.dbWrites) process.exitCode = 1;
})().catch(e => { console.error('AI_INTEGRATION_1026_FATAL', e.stack || e); process.exitCode = 1; });
