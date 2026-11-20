#!/usr/bin/env node
/*
 * 검색 결과 잡음 제거 회귀 테스트 — 외부 호출 0회 / Supabase 접근 0회.
 *
 *   node scripts/test-search-noise.js
 *
 * ── 왜 이 파일이 있는가 ────────────────────────────────────────────
 *
 * 2026-11-20, 프로덕션 "노트북" 검색 결과 14건 실측:
 *
 *     32,170원  AI 비서 제미나이LM(노트북LM) 완전 정복…       [인프런]
 *     59,400원  노코드 RAG 끝판왕, 노트북 LM으로…             [인프런]
 *    199,000원  노트북 하나로 3억 번 AI 바이브코딩 사업의 모든것  [크몽]
 *
 * 세 건 모두 **강의**다. 상품명에 "노트북"이 들어 있다는 이유만으로
 * _shop.matchesKeyword 를 통과했다. 그 결과 화면 최상단의
 *
 *     「결과 중 최저 32,170원」 · 「가격대 32,170~3,449,000원」
 *
 * 이 강의 가격이 되었다. 가격비교 서비스가 가장 크게 보여주는 숫자가
 * 상품이 아닌 것의 가격이었다는 뜻이다.
 *
 * 같은 결과에 중고(21.9만 · 87.9만)와 리퍼(73.5만)가 신품과 아무 구분 없이
 * 가격순으로 섞여 있었다. 중고 21.9만이 신품 27.0만보다 위에 뜨면 사용자는
 * "노트북이 22만원부터"로 읽는다 — 틀린 비교다.
 *
 * ── 무엇을 지키는가 ────────────────────────────────────────────────
 *   ① 강의·전자책 플랫폼(인프런·크몽 등)은 쇼핑 결과에 들어오지 않는다
 *   ② 그 결과 최저가/가격대가 실제 상품 기준으로 계산된다
 *   ③ 중고·리퍼·해외직구는 **거르지 않고** 뱃지로 표시된다
 *   ④ 상태 판정은 제목·판매처명에 적힌 말만 본다 — 연식·가격으로 추측하지 않는다
 *   ⑤ 멀쩡한 신품에 중고 딱지가 붙지 않는다 (오탐이 미탐보다 나쁘다)
 */
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(ok, label, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail === undefined ? '' : '  — ' + JSON.stringify(detail)}`); }
}
function section(name) { console.log(`\n${name}`); }

/* ------------------------------------------------------------------ *
 *  규칙을 소스에서 직접 꺼낸다.
 *
 *  api/_adpick.js 와 api/_shop.js 는 모듈을 읽는 것만으로 Supabase 클라이언트를
 *  만들려 하므로(환경변수 필요) require 하지 않는다. 테스트가 제 규칙을 따로
 *  베껴 쓰면 소스가 바뀌어도 테스트는 계속 통과하므로, 파일에서 그대로 읽어
 *  평가한다 (scripts/test-filters.js 가 프론트 Filters 를 다루는 방식과 같다).
 * ------------------------------------------------------------------ */
function loadRules() {
  const adpickSrc = fs.readFileSync(path.join(__dirname, '..', 'api', '_adpick.js'), 'utf8');
  const shopSrc   = fs.readFileSync(path.join(__dirname, '..', 'api', '_shop.js'), 'utf8');

  const cm = adpickSrc.match(/const CONTENT_PLATFORM_PATTERN = (\/.*?\/[a-z]*);/);
  if (!cm) throw new Error('api/_adpick.js 에서 CONTENT_PLATFORM_PATTERN 을 찾지 못했습니다');

  const fnm = shopSrc.match(/const USED_PATTERN[\s\S]*?\nfunction detectCondition\([\s\S]*?\n\}/);
  if (!fnm) throw new Error('api/_shop.js 에서 detectCondition 을 찾지 못했습니다');

  // eslint-disable-next-line no-new-func
  const factory = new Function(`${fnm[0]}\nreturn { detectCondition, CONTENT_PLATFORM_PATTERN: ${cm[1]} };`);
  return factory();
}

const { detectCondition, CONTENT_PLATFORM_PATTERN } = loadRules();
const isContentPlatform = cp => CONTENT_PLATFORM_PATTERN.test(String(cp || ''));

/* ------------------------------------------------------------------ *
 *  2026-11-20 프로덕션 "노트북" 검색 결과 14건 (실측 그대로).
 * ------------------------------------------------------------------ */
const LAPTOP_SEARCH_2026_11_20 = [
  { price: 569900,  cp: '쿠팡',       title: 'BIRDPLAY 노트북 15.6인치 윈도우11 사무 학생용 180도 힌지 휴대 가성비 노트북, JA, WIN11 Home, 8GB, 256GB, 실버' },
  { price: 199000,  cp: '크몽',       title: '노트북 하나로 3억 번 AI 바이브코딩 사업의 모든것' },
  { price: 32170,   cp: '인프런',     title: 'AI 비서 제미나이LM(노트북LM) 완전 정복: 직장인의 보고서·회의·데이터 분석 효율 10배 높이기' },
  { price: 270630,  cp: 'SSG',        title: '[삼성] 삼성전자 NT370E5L 6세대 인텔i5 윈도우11 가성비 노트북[이마트몰] [NT370E5L]' },
  { price: 735790,  cp: '리퍼연구소', title: 'LG 올화이트/실버 i7/i5 최신형 RAM 16GB 756GB UHD GRAPHICS 울트라 노트북 WIN11 PRO' },
  { price: 2640000, cp: 'Hmall',      title: '[ LG 직배송]LG 그램 Pro AI 2026 노트북 [16Z95U-G.AS5ZK] (AMD 라이젠 AI 5 / 윈도우11 탑재 / 40.6cm) +무이자12개월' },
  { price: 59400,   cp: '인프런',     title: '노코드 RAG 끝판왕, 노트북 LM으로 지식 관리 마스터하기' },
  { price: 369000,  cp: '쿠팡',       title: '레노버 씽크패드 L580 15.6 인텔i5 윈도우11 사무용 인강용 노트북' },
  { price: 1649000, cp: '쿠팡',       title: '삼성전자 갤럭시북6 14인치 휴대용 가성비 학생 새학기 노트북, 그레이, NT740VJQ-A51A, 256GB, 16GB, Linux' },
  { price: 460500,  cp: '알리',       title: '[해외] 17.3인치 휴대용 노트북, 인텔 7100U 프로세서, 윈도우 11, 32GB RAM, 2TB HDD, 지문 인식 잠금 기능, 게이밍, 학습, 사무용으로 적합' },
  { price: 1599000, cp: '11번가',     title: '[최종145만]삼성 갤럭시북5 NT750XHW-A51A 16GB 256GB 가성비노트북 대학생 추천노트북' },
  { price: 3449000, cp: '롯데홈쇼핑', title: '삼성 갤럭시북5 프로 NT960XHZ-AD72G U7 258V 32GB 1TB 고성능노트북' },
  { price: 219000,  cp: '쿠팡',       title: '루나텍 삼성중고노트북 NT501R5L-luna01 i5-6세대 인터넷서핑 문서작업, 블랙그레이, NT501R5L-luna01, 128GB, 4GB, WIN11 Pro' },
  { price: 879000,  cp: 'GS SHOP',    title: '삼성 갤럭시북 이온 NT951XCJ (i7-10510U 16GB S512GB Win10) [중고노트북]' },
];

/* ------------------------------------------------------------------ */
section('1. 강의·전자책 플랫폼은 쇼핑 결과가 아니다');

const kept    = LAPTOP_SEARCH_2026_11_20.filter(x => !isContentPlatform(x.cp));
const removed = LAPTOP_SEARCH_2026_11_20.filter(x =>  isContentPlatform(x.cp));

check(removed.length === 3, '실측 14건 중 강의 3건이 제외된다', { 제외: removed.length });
check(removed.every(x => /인프런|크몽/.test(x.cp)), '제외된 것은 인프런·크몽 상품뿐이다',
  removed.map(x => x.cp));
check(kept.length === 11, '나머지 11건은 그대로 남는다', { 유지: kept.length });

// 플랫폼이 추가돼도 같은 규칙으로 걸려야 한다.
['인프런', 'Inflearn', '크몽', 'kmong', '클래스101', '패스트캠퍼스', '유데미', 'Udemy']
  .forEach(cp => check(isContentPlatform(cp), `콘텐츠 플랫폼으로 인식: ${cp}`));

/* ★ 실제 쇼핑몰이 잘못 걸리면 멀쩡한 상품이 사라진다 — 오탐이 가장 위험하다. */
['쿠팡', 'SSG', 'Hmall', '11번가', '롯데홈쇼핑', 'GS SHOP', '알리', 'G마켓', '오늘의집', '예스이십사', '리퍼연구소']
  .forEach(cp => check(!isContentPlatform(cp), `실제 쇼핑몰은 통과: ${cp}`));

/* ------------------------------------------------------------------ */
section('2. 최저가·가격대가 실제 상품 기준으로 계산된다');

const prices = kept.map(x => x.price);
const lowest = Math.min(...prices);
const highest = Math.max(...prices);

check(lowest !== 32170, '★ 최저가가 더 이상 강의 가격(32,170원)이 아니다', { 최저가: lowest });
check(lowest === 219000, '최저가 = 219,000원 (실제 상품 중 최저)', { 최저가: lowest });
check(highest === 3449000, '최고가 = 3,449,000원', { 최고가: highest });

// 강의가 섞여 있던 시절의 가격대 하한과 다르다는 것을 명시적으로 고정한다.
check(lowest > 200000, '가격대 하한이 노트북으로서 말이 되는 범위다', { 최저가: lowest });

/* ------------------------------------------------------------------ */
section('3. 중고·리퍼·해외직구는 거르지 않고 표시한다');

const flagged = kept.map(x => Object.assign({}, x, detectCondition(x.title, x.cp)));

const used     = flagged.filter(x => x.isUsed);
const refurb   = flagged.filter(x => x.isRefurb);
const overseas = flagged.filter(x => x.isOverseas);

check(used.length === 2, '중고 2건을 찾아낸다', used.map(x => x.price));
check(used.some(x => x.price === 219000), '루나텍 중고(21.9만)에 중고 표시');
check(used.some(x => x.price === 879000), '갤럭시북 이온 [중고노트북](87.9만)에 중고 표시');

check(refurb.length === 1, '리퍼 1건을 찾아낸다', refurb.map(x => x.price));
check(refurb.some(x => x.price === 735790),
  '★ 제목엔 없고 판매처명(리퍼연구소)에만 있어도 리퍼로 인식한다');

check(overseas.length === 1, '해외직구 1건을 찾아낸다', overseas.map(x => x.price));
check(overseas.some(x => x.price === 460500), '알리 [해외] 상품에 해외직구 표시');

// 거르지 않는다 — 중고를 일부러 찾는 사용자가 있다.
check(flagged.length === kept.length, '★ 상태 뱃지는 표시일 뿐, 한 건도 버리지 않는다',
  { 입력: kept.length, 출력: flagged.length });

/* ------------------------------------------------------------------ */
section('4. 신품에 중고 딱지를 붙이지 않는다 (오탐 방지)');

const newOnly = flagged.filter(x => !x.isUsed && !x.isRefurb);
check(newOnly.length === 8, '신품으로 판정된 것은 8건', { 신품: newOnly.length });

/*
 * ★ 6세대 i5(2016년 모델)는 구형이지만 "중고"라고 적혀 있지 않다.
 *   연식으로 중고를 추측하면 이 상품이 잘못 걸린다.
 */
const nt370 = flagged.find(x => x.price === 270630);
check(nt370 && !nt370.isUsed,
  '★ 구형(6세대 i5)이어도 "중고"라고 적혀 있지 않으면 중고가 아니다');

const birdplay = flagged.find(x => x.price === 569900);
check(birdplay && !birdplay.isUsed && !birdplay.isRefurb && !birdplay.isOverseas,
  '평범한 신품에는 아무 뱃지도 붙지 않는다');

// 상태를 말하지 않는 제목에서 뱃지를 만들어내지 않는다.
[
  '삼성전자 갤럭시북5 프로 NT960XHZ 32GB 1TB 고성능노트북',
  'LG 그램 Pro AI 2026 노트북 16Z95U',
  '레노버 씽크패드 L580 사무용 인강용 노트북',
].forEach(t => {
  const c = detectCondition(t, '쿠팡');
  check(!c.isUsed && !c.isRefurb && !c.isOverseas, `뱃지 없음: ${t.slice(0, 28)}…`);
});

/* ------------------------------------------------------------------ */
section('5. 상태 표기 변형을 읽는다');

check(detectCondition('[중고] 맥북 프로', '').isUsed,       '[중고] 대괄호 표기');
check(detectCondition('맥북 프로 [중고노트북]', '').isUsed, '[중고노트북] 붙은 표기');
check(detectCondition('삼성중고노트북 NT501', '').isUsed,   '붙여 쓴 "중고" 표기');
check(detectCondition('리퍼 아이패드', '').isRefurb,        '리퍼 표기');
check(detectCondition('아이패드', '리퍼연구소').isRefurb,   '판매처명의 리퍼');
check(detectCondition('[해외] 노트북', '').isOverseas,      '[해외] 표기');
check(detectCondition('노트북 해외직구', '').isOverseas,    '직구 표기');
check(detectCondition('노트북 구매대행', '').isOverseas,    '구매대행 표기');

check(!detectCondition('', '').isUsed,        '빈 제목에 뱃지 없음');
check(!detectCondition(null, null).isUsed,    'null 입력에도 터지지 않는다');

/* ------------------------------------------------------------------ */
section('6. 프론트가 뱃지를 실제로 그린다');

const frontSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
check(/conditionHTML:\s*function/.test(frontSrc), 'Card.conditionHTML 이 존재한다');
check(/\+ Card\.conditionHTML\(it\)/.test(frontSrc), '카드 렌더에서 conditionHTML 을 부른다');
check(/\.cond-tag\s*\{/.test(frontSrc), '.cond-tag 스타일이 정의되어 있다');
check(/\.card \.cond-row\{order:0/.test(frontSrc), '상태 뱃지가 제목보다 먼저 온다 (order:0)');

/* ------------------------------------------------------------------ */
console.log('\n' + '='.repeat(66));
console.log(`검색 결과 잡음 제거 테스트:  ${pass} PASS / ${fail} FAIL`);
console.log('='.repeat(66));
process.exit(fail ? 1 : 0);
