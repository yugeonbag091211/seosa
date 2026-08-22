#!/usr/bin/env node
/*
 * 검색 품질 회귀 테스트 — 쿠팡 호출 0회 / Supabase 접근 0회.
 *
 *   node scripts/test-search.js
 *
 * 여기 나오는 상품명은 지어낸 것이 아니다. 2026-08-09~10 에 실제로
 * coupang_search_cache 에 들어 있던 응답 466건에서 그대로 가져온 것이고,
 * 각 검사는 그때 실측으로 확인된 문제 하나에 대응한다.
 *
 * 무엇을 지키는가
 *   ① 한 토큰만 걸려서 엉뚱한 상품이 통과하는 일 (실측 104건)
 *   ② 표기가 달라서 정답을 통째로 버리는 일       (실측 104건)
 *   ③ 숫자가 용량 표기에 걸리는 일                (16인치 ↔ 16GB)
 *   ④ 가격이 싸다는 이유로 관련도 낮은 상품이 위로 올라오는 일
 *   ⑤ title 로 서로 다른 상품을 합치는 일
 *   ⑥ 오타 보정이 검색 의도를 바꾸는 일
 */
'use strict';

const S = require('../api/_search');

let pass = 0, fail = 0;

function check(ok, label, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail === undefined ? '' : '  — ' + JSON.stringify(detail)}`); }
}
function section(name) { console.log(`\n${name}`); }

/** 점수 한 건. titles 를 주면 브랜드 판정에 쓴다(실제 검색과 같은 조건). */
function score(keyword, title, titles) {
  const a = S.analyzeQuery(keyword, { titles: titles || [title] });
  return S.scoreTitle(a, title).score;
}

/* ================================================================ *
 *  1. 검색어 정규화
 * ================================================================ */
section('1. 검색어 정규화');

check(S.normalizeText('  LG   그램  ') === 'lg 그램', '앞뒤·연속 공백 정리');
check(S.normalizeText('ＬＧ 그램') === 'lg 그램', '전각 영문 → 반각 소문자');
check(S.normalizeText('LG전자 14ZD95U-GX56K') === 'lg전자 14zd95u gx56k', '특수문자는 토큰 경계로');
check(S.normalizeText('아이패드/11프로(검정)') === '아이패드 11프로 검정',
      '괄호·슬래시 제거', S.normalizeText('아이패드/11프로(검정)'));
check(S.canonicalKey('무선 이어폰') === S.canonicalKey('무선이어폰'), '띄어쓰기 차이는 같은 키');
check(S.canonicalKey('무선 이어폰') !== S.canonicalKey('유선 이어폰'), '다른 말은 다른 키');

check(JSON.stringify(S.splitTokens('코어ultra5')) === '["코어","ultra5"]',
      '한글/영문 경계에서 끊는다', S.splitTokens('코어ultra5'));
check(JSON.stringify(S.splitTokens('11프로')) === '["11","프로"]',
      '숫자/한글 경계에서 끊는다', S.splitTokens('11프로'));
check(JSON.stringify(S.splitTokens('14zd95u')) === '["14zd95u"]',
      '모델명은 쪼개지 않는다', S.splitTokens('14zd95u'));

/*
 * 회귀. 인코딩이 깨진 검색어("������Ʈ")가 그대로 들어와 쿠팡 호출 1회를
 * 쓰고, 무관한 인기상품 9행이 products 에 저장된 적이 있다.
 * api/search.js 는 토큰이 0개면 쿠팡을 부르기 전에 400 으로 끊는다.
 */
check(S.splitTokens(S.normalizeText('���Ʈ')).length === 0,
      '깨진 문자만 있는 검색어는 토큰이 0개',
      S.splitTokens(S.normalizeText('���Ʈ')));
check(S.splitTokens(S.normalizeText('!!! ??? ...')).length === 0,
      '특수문자만 있는 검색어도 토큰이 0개');
check(S.splitTokens(S.normalizeText('노트북')).length === 1, '멀쩡한 검색어는 통과');

/* ================================================================ *
 *  2. 정확한 상품명 / 브랜드+제품 / 모델번호
 * ================================================================ */
section('2. 정확한 상품명 · 브랜드 + 제품 · 모델번호');

const GRAM_TITLES = [
  'LG전자 2025 그램 프로 AI 16 코어 Ultra5',
  'LG전자 2026 그램 AI 16 라이젠 AI 400 시리즈, 에어로미늄 화이트, 256GB, 16GB, WIN11 Home, 16Z95U-GR5EK',
  'LG전자 2024 그램 15 코어 Ultra5, 에센스 화이트, 256GB, 16GB, WIN11 Home, 15Z90S-GA5VK',
  'LG전자 2025 그램 프로 17 코어 Ultra5 지포스 RTX 5050'
];

const exactPro16 = score('LG 그램 프로 16', GRAM_TITLES[0], GRAM_TITLES);
const nonPro16   = score('LG 그램 프로 16', GRAM_TITLES[1], GRAM_TITLES);
const gram15     = score('LG 그램 프로 16', GRAM_TITLES[2], GRAM_TITLES);

check(exactPro16 === 1, '정확히 맞는 상품은 1.0', exactPro16);
check(exactPro16 > nonPro16, '"프로" 가 빠진 상품은 아래', { exactPro16, nonPro16 });
check(nonPro16 > gram15, '16인치가 아닌 15인치는 더 아래', { nonPro16, gram15 });

// ③ 숫자가 용량에 걸리는 문제 — 15인치 제품은 "16GB" 때문에 16 이 맞은 것으로 세면 안 된다
const a15 = S.analyzeQuery('LG 그램 프로 16', { titles: GRAM_TITLES });
check(S.scoreTitle(a15, GRAM_TITLES[2]).misses.indexOf('16') > -1,
      '숫자 16 이 램 용량 16GB 에 걸리지 않는다', S.scoreTitle(a15, GRAM_TITLES[2]).misses);

const LAPTOP_TITLES = [
  '(LG전자) LG 그램 AI AMD 14ZD95U-GX56K (Ryzen AI 5 435/16GB/256GB/FD)',
  'LG그램2026 14ZD95U-GX56K AMD 라이젠 AI 5 16GB 256GB 프리도스, 실버',
  'LG전자 2026 그램 AI 16 코어 Ultra5, 스노우 화이트, 16ZB90S-GA5PK, 512GB, 16GB, WIN11 Home',
  'LG전자 2026 그램14 14ZD95U-GX5WK 키보드키커버 키스킨 실리스킨 키덮개 액체유입방지'
];
const modelExact  = score('LG전자 LG그램 14ZD95U', LAPTOP_TITLES[0], LAPTOP_TITLES);
const modelWrong  = score('LG전자 LG그램 14ZD95U', LAPTOP_TITLES[2], LAPTOP_TITLES);
const modelAccess = score('LG전자 LG그램 14ZD95U', LAPTOP_TITLES[3], LAPTOP_TITLES);

check(modelExact >= S.MIN_SCORE, '모델번호가 맞는 상품은 통과', modelExact);
check(modelWrong < S.MIN_SCORE, '모델번호가 다른 노트북은 제외 (예전에는 "LG전자" 하나로 통과했다)', modelWrong);
check(modelAccess < modelExact, '같은 모델번호를 단 키스킨은 본품보다 아래', { modelExact, modelAccess });

/* ================================================================ *
 *  3. 띄어쓰기 / 영문·한글 변형
 * ================================================================ */
section('3. 띄어쓰기 · 영문/한글 변형');

check(score('무선이어폰', '필립스 무선 ENC노이즈캔슬링 블루투스 이어폰') >= S.MIN_SCORE,
      '"무선이어폰"(붙여씀) 으로 "무선 … 이어폰" 을 찾는다',
      score('무선이어폰', '필립스 무선 ENC노이즈캔슬링 블루투스 이어폰'));
check(score('무선 이어폰', 'QCY 블루투스 이어폰') >= S.MIN_SCORE,
      '"무선 이어폰" 으로 "블루투스 이어폰" 을 찾는다 (동의어)');
check(score('빨대텀블러', '디유 더블벤티 대용량 텀블러 빨대 스텐 보온보냉') >= S.MIN_SCORE,
      '"빨대텀블러" → "텀블러 … 빨대" (합성어 분해)');
check(score('전기포트', '키친아트 솔리드 전기주전자, KAEK-B1500FT') >= S.MIN_SCORE,
      '"전기포트" → "전기주전자" (동의어)');
check(score('서큘레이터', '홈플래닛 에어 써큘레이터') >= S.MIN_SCORE,
      '"서큘레이터" → "써큘레이터" (표기 차이)');
check(score('여행용 캐리어', '트립앤라인 브릭 캐리어') >= S.MIN_SCORE,
      '"여행용" 접미사가 달라도 찾는다');
check(score('차량용 햇빛 가리개', '솔라보 티타늄 코팅 자동차 앞유리 햇빛가리개 원터치') >= S.MIN_SCORE,
      '"차량용 햇빛 가리개" → "자동차 … 햇빛가리개"');
check(score('LG 그램 프로 16', 'LG전자 2025 그램 Pro AI 16 WQXGA 코어Ultra7') >= 0.9,
      '한글 "프로" ↔ 영문 "Pro"');

/* ================================================================ *
 *  4. 너무 일반적인 검색어 / 관련 없는 유사 상품명
 * ================================================================ */
section('4. 일반적인 검색어 · 무관한 상품');

// 실측: keyword='수영복' 으로 저장된 쿠팡 상품이 화장지·건전지·쌀이었다
['쿠팡베이직 네추럴 3겹 천연펄프 롤화장지 30m, 30개입, 1개',
 '듀라셀 알카라인 AA 건전지, 20개입, 1개',
 '안성마춤농협 경기미 안성골 호랭이쌀 추청 특등급, 10kg, 1개'].forEach(t => {
  check(score('수영복', t) < S.MIN_SCORE, `"수영복" 에 무관 상품 제외 — ${t.slice(0, 18)}…`, score('수영복', t));
});

// 브랜드가 다른 상품 — 실측에서 "11프로" 부분 일치로 통과했다
const IPAD_TITLES = [
  '아이패드 프로11 M4 케이스 포함 10세대 4세대 에어5 호환 키보드 9세대 에어11 프로11 마우스패드',
  '레노버 탭 P11 프로 M10 플러스 리전Y700 심플 캐릭터 거치대 펜홀더 플립 가죽 태블릿 케이스',
  '아이패드 키보드 케이스 터치패드 11프로 에어5/4/3/2 9/8/7/6/5세대 (키스킨증정)',
  '월드온 태블릿 케이스 핸드 스트랩 회전케이스 범퍼케이스 실리콘케이스 A9플러스 에어11 프로13 에어13'
];
const ipadOk    = score('아이패드 11프로 케이스 검정', IPAD_TITLES[0], IPAD_TITLES);
const lenovoBad = score('아이패드 11프로 케이스 검정', IPAD_TITLES[1], IPAD_TITLES);
check(ipadOk >= S.MIN_SCORE, '아이패드 케이스는 통과', ipadOk);
check(lenovoBad < S.MIN_SCORE, '레노버 탭 케이스는 제외 (브랜드 불일치)', lenovoBad);
check(ipadOk > lenovoBad, '아이패드가 레노버보다 위', { ipadOk, lenovoBad });

// 한 글자 토큰은 아무 데나 걸린다 — 판단 근거로 쓰지 않는다
check(S.analyzeQuery('가').tokens.length === 1, '한 글자도 토큰으로는 만든다');
check(score('노트북', 'HP 2025 VICTUS 15 GAMING LAPTOP 15.6 라이젠9') >= S.MIN_SCORE,
      '일반 검색어 "노트북" 은 LAPTOP 표기도 찾는다');

/* ================================================================ *
 *  5. 중복 제거 — product_id + mall 만 본다
 * ================================================================ */
section('5. 중복 제거');

const dup = S.dedupeItems([
  { productId: '100', mall: '쿠팡', title: '암막커튼', lprice: 109000 },
  { productId: '100', mall: '쿠팡', title: '암막커튼', lprice: 39900 },
  { productId: '100', mall: '쿠팡', title: '암막커튼', lprice: 75000 }
]);
check(dup.items.length === 1, '같은 product_id + mall 은 한 건으로');
check(dup.items[0].lprice === 39900, '겹치면 싼 쪽을 남긴다 (순서에 기대지 않는다)', dup.items[0].lprice);
check(dup.removed === 2, '접은 건수를 알려준다', dup.removed);

const sameTitle = S.dedupeItems([
  { productId: '53530143052', mall: '네이버', title: '로랜텍 커널형 버즈 RSM-R510 블랙', lprice: 20000 },
  { productId: '53530143052', mall: '네이버쇼핑', title: '로랜텍 커널형 버즈 RSM-R510 블랙', lprice: 21000 }
]);
check(sameTitle.items.length === 2,
      '상품명이 같아도 mall 이 다르면 합치지 않는다 (실측 64그룹)', sameTitle.items.length);

const optionDiff = S.dedupeItems([
  { productId: '900', mall: '쿠팡', title: '텀블러 500ml', lprice: 10000 },
  { productId: '901', mall: '쿠팡', title: '텀블러 900ml', lprice: 14000 }
]);
check(optionDiff.items.length === 2, '판매 단위가 다르면 다른 상품이다');

const noId = S.dedupeItems([
  { productId: '', mall: '쿠팡', title: 'A', lprice: 1000 },
  { productId: '', mall: '쿠팡', title: 'B', lprice: 2000 }
]);
check(noId.items.length === 2, '식별자가 없으면 합치지 않는다 (title 로 합치지 않는다)');

/* ================================================================ *
 *  6. 정렬 — 싸다고 위로 올라오면 안 된다
 * ================================================================ */
section('6. 정렬 (관련도 → 신뢰도 → 가격)');

const sorted = S.sortByRelevance([
  { title: '싼데 관련 없음', relevance: 0.35, lprice: 1000,  trust: { score: 90 } },
  { title: '딱 맞는 상품',   relevance: 0.95, lprice: 90000, trust: { score: 80 } },
  { title: '맞는데 비쌈',    relevance: 0.95, lprice: 99000, trust: { score: 80 } },
  { title: '맞는데 신뢰↓',   relevance: 0.95, lprice: 50000, trust: { score: 10 } }
]);
check(sorted[0].title === '딱 맞는 상품', '관련도가 가장 높고 신뢰도 높은 것이 1위', sorted[0].title);
check(sorted[3].title === '싼데 관련 없음',
      '가격이 1/90 이어도 관련도가 낮으면 맨 아래', sorted.map(x => x.title));
check(sorted[1].title === '맞는데 비쌈' && sorted[2].title === '맞는데 신뢰↓',
      '같은 관련도 계단에서는 신뢰도가 가격보다 먼저', sorted.map(x => x.title));

const tie = S.sortByRelevance([
  { title: '비쌈', relevance: 0.9, lprice: 20000, trust: { score: 80 } },
  { title: '쌈',   relevance: 0.9, lprice: 10000, trust: { score: 80 } }
]);
check(tie[0].title === '쌈', '관련도·신뢰도가 같으면 싼 쪽이 위');

/*
 * 회귀. 관련도를 0.1 계단으로 묶었더니 0.88 과 0.80 이 한 칸에 들어가서
 * 7,980원짜리 키스킨이 1,799,000원짜리 노트북 본품 위에 섰다
 * (브라우저 검증에서 "LG전자 LG그램 14ZD95U" 로 실제 재현됐다).
 */
const accessoryOrder = S.sortByRelevance([
  { title: '키스킨(액세서리)', relevance: 0.80, lprice: 7980,    trust: { score: 90 } },
  { title: '노트북 본품',      relevance: 0.88, lprice: 1799000, trust: { score: 90 } }
]);
check(accessoryOrder[0].title === '노트북 본품',
      '0.88 이 0.80 보다 확실히 위 — 계단 경계로 순서가 뒤집히지 않는다',
      accessoryOrder.map(x => x.title));

/* ================================================================ *
 *  7. rankItems — 걸러내기 + 중복 제거 + relevance 부여
 * ================================================================ */
section('7. rankItems');

const ranked = S.rankItems('수영복', [
  { productId: '1', mall: '쿠팡', title: '나이키 여성 원피스 수영복', lprice: 30000 },
  { productId: '2', mall: '쿠팡', title: '풀무원샘물 생수 무라벨, 1L, 24개', lprice: 9000 },
  { productId: '1', mall: '쿠팡', title: '나이키 여성 원피스 수영복', lprice: 28000 }
]);
check(ranked.items.length === 1, '무관 1건 제외 + 중복 1건 통합', ranked.items.length);
check(ranked.items[0].lprice === 28000, '중복은 싼 쪽', ranked.items[0].lprice);
check(ranked.dropped === 1 && ranked.removed === 1, '제외/통합 건수를 각각 보고', ranked);
check(ranked.items[0].relevance > 0, 'relevance 가 붙는다', ranked.items[0].relevance);

const allBad = S.rankItems('수영복', [
  { productId: '9', mall: '쿠팡', title: '펩시 제로슈거 라임', lprice: 1000 }
]);
check(allBad.allBelow === true && allBad.items.length === 0,
      '전부 무관하면 응답을 통째로 버린다 (예전에 홈에 펩시가 떴다)');

const noKeyword = S.rankItems('', [{ productId: '1', mall: '쿠팡', title: '아무거나', lprice: 1 }]);
check(noKeyword.items.length === 1, '검색어가 없으면 거르지 않는다 (판단 근거가 없다)');

/* ================================================================ *
 *  8. 오타 / 자판 / 띄어쓰기 보정
 * ================================================================ */
section('8. 검색어 보정');

const DICT = ['무선 이어폰', '노트북', '스마트워치', '텀블러', '아이폰', '수영복', '제트스트림 리필심'];

check(S.toJamo('텀블러') === 'ㅌㅓㅁㅂㅡㄹㄹㅓ', '한글 자모 분해', S.toJamo('텀블러'));
check(S.editDistance('abc', 'acb') === 1, '인접 전치는 거리 1');

const typo = S.suggestKeywords('텀블르', DICT);
check(typo.corrected === '텀블러' && typo.reason === 'typo', '한 글자 오타 보정', typo);

const spacing = S.suggestKeywords('무선이어폰', DICT);
check(spacing.corrected === '무선 이어폰' && spacing.reason === 'spacing',
      '띄어쓰기 차이는 오타가 아니라 표기 차이로 구분', spacing);

const layout = S.fromKeyboardLayout('dkdlvhs');
check(layout === '아이폰', '영문 자판으로 친 한글 되돌리기', layout);
const layoutSug = S.suggestKeywords('dkdlvhs', DICT);
check(layoutSug.corrected === '아이폰' && layoutSug.reason === 'layout', '자판 오타 제안', layoutSug);

// ⑥ 보정이 의도를 바꾸면 안 된다
check(S.suggestKeywords('노트북', DICT).corrected === null,
      '사전에 있는 말은 보정하지 않는다');
check(S.suggestKeywords('수영복', DICT).corrected === null,
      '멀쩡한 검색어를 다른 말로 바꾸지 않는다');
check(S.suggestKeywords('선풍기', DICT).corrected === null,
      '사전에 없어도 닮은 말이 없으면 억지로 제안하지 않는다', S.suggestKeywords('선풍기', DICT));
check(S.suggestKeywords('노트북', DICT).corrected !== '스마트워치',
      '거리가 먼 말을 제안하지 않는다');
check(S.fromKeyboardLayout('노트북') === '', '이미 한글이면 자판 변환하지 않는다');
check(S.fromKeyboardLayout('gram16') === '', '숫자가 섞이면 자판 변환하지 않는다');

const alts = S.suggestKeywords('무선 이어폰 케이스', DICT);
check(alts.alternatives.indexOf('무선 이어폰') > -1,
      '0건일 때 겹치는 검색어를 대체안으로 제시', alts.alternatives);

const noAlt = S.suggestKeywords('zzz없는말zzz', DICT);
check(noAlt.alternatives.length === 0,
      '겹치는 게 없으면 아무 말이나 들이밀지 않는다', noAlt.alternatives);

/*
 * 회귀. 프론트는 검색할 때마다 /api/stats 로 검색어를 집계한다.
 * 그래서 오타를 한 번 검색하면 그 오타가 search_stats 에 들어가고,
 * 다음 검색부터 "사전에 있는 말" 이 되어 보정이 멈췄다.
 * (브라우저 검증에서 실제로 재현됐다 — "텀블르" 를 검색해도 제안이 안 떴다)
 */
const polluted = DICT.concat(['텀블르']);
check(S.suggestKeywords('텀블르', polluted).corrected === null,
      '기본값은 그대로 — 사전에 있으면 보정하지 않는다');
check(S.suggestKeywords('텀블르', polluted).alternatives.indexOf('텀블러') > -1,
      '사전에 있어도 대체 검색어는 계속 준다',
      S.suggestKeywords('텀블르', polluted).alternatives);
check(S.suggestKeywords('텀블르', polluted, { excludeSelf: true }).corrected === '텀블러',
      'excludeSelf: 내가 방금 남긴 검색 기록은 "맞는 말" 의 근거가 아니다',
      S.suggestKeywords('텀블르', polluted, { excludeSelf: true }));

/* ================================================================ *
 *  9. 가격 시스템을 건드리지 않았는지
 * ================================================================ */
section('9. 가격 시스템 불변 조건');

const shop = require('../api/_shop');
check(typeof shop.relevantItems === 'function' && typeof shop.recordPrices === 'function',
      '_shop 공개 함수는 그대로');

/*
 * 75,000원 커튼 사고 재발 방지 — 어느 함수가 막고 있는지 정확히 겨눈다.
 *
 * 이 단언은 원래 shop.relevantItems 가 옵션 중복을 접는다고 봤는데, 그 함수는
 * 검색어 관련도만 거른다. 접는 일은 처음부터 두 곳이 나눠 맡고 있었다
 * (origin/main 의 relevantItems 도 같은 모양이라 회귀가 아니라 오단언이었다).
 *
 *   _coupang.collapseOptions  같은 productId 를 최저가 한 건으로 접는다.
 *                             searchCoupang 의 API 경로·캐시 경로 양쪽에서
 *                             무조건 돈다.
 *   _shop.recordPrices        저장 직전 (pid, mall, vid) 로 한 번 더 접고,
 *                             겹치면 싼 쪽을 남긴다 (순서에 기대지 않는다).
 *                             → scripts/test-price.js 'Test 5' 가 덮는다.
 *
 * 그래서 여기서는 실제로 접는 함수를 부른다.
 */
const { collapseOptions } = require('../api/_coupang');
const folded = collapseOptions([
  { productId: '8729454920', mall: '쿠팡', title: '암막커튼 방한 차광', lprice: 109000 },
  { productId: '8729454920', mall: '쿠팡', title: '암막커튼 방한 차광', lprice: 39900 }
]);
check(folded.length === 1 && folded[0].lprice === 39900,
      '옵션 중복은 최저가 한 건으로 (75,000원 커튼 사고 재발 방지)', folded);

// relevantItems 는 관련도만 본다 — 접지 않는다는 사실 자체를 고정해 둔다.
const rel = shop.relevantItems('암막커튼', [
  { productId: '8729454920', mall: '쿠팡', title: '암막커튼 방한 차광', lprice: 109000 },
  { productId: '8729454920', mall: '쿠팡', title: '무선 이어폰', lprice: 39900 }
]);
check(rel.kept.length === 1 && rel.kept[0].lprice === 109000,
      'relevantItems 는 검색어와 무관한 행만 거른다 (가격 접기는 하지 않는다)', rel.kept);

check(S.rankItems('텀블러', [
  { productId: 'x', mall: '쿠팡', title: '스탠리 텀블러', lprice: 30000, itemId: 'i1', vendorItemId: 'v1' }
]).items[0].vendorItemId === 'v1', 'itemId / vendorItemId 는 손대지 않는다');

console.log(`\n결과: ${pass} PASS / ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
