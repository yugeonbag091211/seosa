#!/usr/bin/env node
/*
 * 동일 상품 매칭 회귀 테스트 — 외부 호출 0회 / Supabase 접근 0회.
 *
 *   node scripts/test-matching.js
 *
 * ── 왜 이 파일이 있는가 ─────────────────────────────────────────
 *
 * 2026-08-30 감사에서 실제 운영 화면이 이렇게 나갔다.
 *
 *   원본  "모두샵 소가죽 남자 슬림 반지갑 선물상자 MARLMS162"
 *   비교  오늘의집  남자샌들 아쿠아 스포츠샌들      26,900원
 *         쿠팡      소가죽 크로스백 숄더백          76,900원
 *   요약  "최대 절약 50,000원"
 *
 * 반지갑을 보던 사람에게 샌들과 크로스백을 나란히 놓고 5만원을 아낀다고
 * 말한 것이다. 가격비교 서비스에서 이것은 디자인 문제가 아니라 서비스를
 * 못 믿게 만드는 문제다.
 *
 * 원인은 매칭 문턱이었다.
 *   need = Math.min(2, keyTokens.length)   // 핵심 토큰 2개만 맞으면 통과
 *   → "소가죽" + "남자" 두 개만으로 샌들이 통과했다.
 *
 * ── 이 테스트가 지키는 것 ───────────────────────────────────────
 *
 *   ① 완전히 다른 상품이 비교에 들어오지 않는다
 *   ② 부속품(케이스·파우치·필름 …)이 본품과 비교되지 않는다
 *   ③ 용량·수량이 다르면 같은 상품으로 보지 않는다
 *   ④ 모델코드가 서로 다르면 같은 상품으로 보지 않는다
 *   ⑤ 같은 상품은 표기가 달라도 계속 비교된다 (과교정 방지)
 *   ⑥ "절약"은 모델코드로 확인된 경우에만 쓸 수 있다
 *
 * ── 프론트 코드를 어떻게 불러오는가 ─────────────────────────────
 *
 * public/index.html 의 Compare 는 export 되지 않는다. 규칙이 두 벌로
 * 갈라지지 않도록 파일에서 그대로 읽어 평가한다
 * (scripts/test-filters.js 가 Filters 를 다루는 방식과 같다).
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

/* ── 프론트의 Compare 객체를 파일에서 꺼내 온다 ─────────────────── */
function loadCompare() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const m = src.match(/\nvar Compare = \{[\s\S]*?\n\};/);
  if (!m) throw new Error('public/index.html 에서 var Compare 를 찾지 못했습니다');

  // Compare 가 참조하는 최소한의 주변 환경만 만들어 준다.
  const env = {
    Fmt: { int: v => parseInt(v, 10) || 0, mall: () => ({ cls: 'x', name: 'x' }),
           esc: s => s, won: v => String(v), safeUrl: u => u },
    setHTML: () => {}, setText: () => {}, show: () => {}, $: () => null,
    AppState: { products: {} }, Api: { call: () => {} }, Drop: {},
    Track: { ev() {} }, MallBrand: { render: () => '' }
  };
  const fn = new Function(...Object.keys(env), m[0] + '\nreturn Compare;');
  return fn(...Object.values(env));
}

const Compare = loadCompare();

/** 원본 제목 기준으로 후보를 채점한다 (render 가 하는 것과 같은 준비). */
function judge(srcTitle, candTitle) {
  const keyTokens = Compare.keyTokensOf(srcTitle);
  const models    = Compare.modelCodesOf(srcTitle);
  const srcAcc    = Compare.accessoriesOf(srcTitle);
  const srcSpecs  = Compare.specsOf(srcTitle);
  return Compare.matchOf(keyTokens, models, candTitle, srcAcc, srcSpecs);
}
/** 실제로 비교 표에 오르는가 (render 는 strong 만 남긴다). */
function shown(srcTitle, candTitle) {
  return judge(srcTitle, candTitle).level === 'strong';
}

console.log('=== 동일 상품 매칭 회귀 테스트 ===');

/* ================================================================
 *  1. 실제로 터졌던 사고 (Critical 회귀)
 * ================================================================ */
section('1. 2026-08-30 운영 사고 재현 — 반지갑에 샌들·크로스백이 붙었다');
{
  const SRC = '모두샵 소가죽 남자 슬림 반지갑 선물상자 MARLMS162';

  check(!shown(SRC, 'OMT 소가죽 남자샌들 여름트레킹화 물놀이 비치 운동화 아쿠아 스포츠샌들'),
    '★★ 반지갑에 샌들이 붙지 않는다');
  check(!shown(SRC, '남자들천연 소가죽 크로스백 숄더백 심플 캐주얼 크로스 가방 데일리 통근용'),
    '★★ 반지갑에 크로스백이 붙지 않는다');

  // 같은 상품은 계속 붙어야 한다 (과교정 방지)
  check(shown(SRC, '소가죽 남자 슬림 반지갑 MARLMS162 선물'),
    '★ 같은 상품은 다른 몰 표기여도 비교된다');
  check(shown(SRC, SRC), '자기 자신은 당연히 같은 상품');
}

/* ================================================================
 *  2. 부속품 — 본품보다 토큰이 더 잘 맞는 함정
 * ================================================================ */
section('2. 부속품이 본품과 비교되지 않는다');
{
  // "무선 이어폰" 의 핵심 토큰은 [이어폰] 하나뿐이라, 케이스가 100% 일치한다.
  check(!shown('무선 이어폰', '무선 이어폰 케이스 실리콘 커버'),
    '★★ 이어폰 ↔ 이어폰 케이스 (토큰 100% 일치인데도 막는다)');
  check(!shown('Apple 아이폰 16 128GB 자급제', 'Apple 아이폰 16 케이스 투명 범퍼'),
    '★★ 아이폰 ↔ 아이폰 케이스');
  check(!shown('삼성 갤럭시북4 노트북 NT750XGR', '삼성 갤럭시북4 노트북 파우치 가방'),
    '★★ 노트북 ↔ 노트북 파우치');
  check(!shown('아이패드 11프로', '아이패드 11프로 강화유리 보호필름 2매'),
    '태블릿 ↔ 보호필름');

  // 반대 방향도 같다
  check(!shown('아이패드 11프로 케이스 젤리', '아이패드 11프로 자급제 128GB'),
    '★ 반대 방향 — 케이스를 보다가 본품이 붙지 않는다');

  // 부속품끼리는 비교해도 된다
  check(shown('아이패드 11프로 케이스 투명', '아이패드 11프로 케이스 투명 젤리'),
    '★ 케이스끼리는 계속 비교된다 (부속품 자체가 상품일 때)');
  check(!shown('아이패드 11프로 케이스 투명', '아이패드 11프로 파우치 가방'),
    '케이스 ↔ 파우치는 다른 부속품이라 비교하지 않는다');
}

/* ================================================================
 *  3. 용량 · 수량
 * ================================================================ */
section('3. 규격이 다르면 같은 상품이 아니다');
{
  check(!shown('코카콜라 제로 190ml 30캔', '코카콜라 제로 1.5L 6개'),
    '★★ 190ml 30캔 ↔ 1.5L 6개');
  check(!shown('삼다수 2L 12개', '삼다수 500ml 20개'),
    '생수 용량·수량이 다르면 비교하지 않는다');

  // 한쪽에만 규격이 적힌 경우는 판단하지 않는다 (표기 생략이 흔하다)
  check(shown('로지텍 MX Master 3S 무선마우스', '로지텍 MX Master 3S 무선마우스 그래파이트'),
    '★ 한쪽에만 표기가 없으면 규격으로 배제하지 않는다');
}

/* ================================================================
 *  4. 모델코드
 * ================================================================ */
section('4. 모델코드가 다르면 같은 상품이 아니다');
{
  check(!shown('필립스 토스터기 HD2581 화이트', '필립스 토스터기 HD2582 블랙'),
    '★★ 모델코드 충돌 — HD2581 ↔ HD2582');
  check(shown('필립스 토스터기 데일리 컬렉션 HD2581', '필립스 데일리 컬렉션 토스터기 HD2581 화이트'),
    '★ 같은 모델코드는 어순이 달라도 비교된다');

  const m = judge('필립스 토스터기 HD2581', '필립스 데일리 토스터기 HD2581 화이트');
  check(m.modelHit === true, '모델코드 일치를 modelHit 으로 알린다', m);

  // 순수 숫자는 모델코드로 보지 않는다 (용량·사이즈일 때가 많다)
  check(Compare.modelCodesOf('나이키 에어포스1 270').length === 0,
    '★ 순수 숫자(270)를 모델코드로 오인하지 않는다');
}

/* ================================================================
 *  5. 서로 다른 모델 (브랜드만 같은 경우)
 * ================================================================ */
section('5. 브랜드만 같은 다른 모델');
{
  check(!shown('나이키 에어포스1 07 화이트 270', '나이키 에어맥스 90 블랙 270'),
    '★★ 에어포스1 ↔ 에어맥스90 (브랜드·사이즈만 겹친다)');
  check(!shown('갤럭시 워치8 44mm 실버', '샤오미 레드미 워치 실버 블루투스'),
    '색상·연결방식만 겹치는 남의 상품이 통과하지 않는다');
}

/* ================================================================
 *  6. 등급과 표현의 대응
 * ================================================================ */
section('6. 확신도에 따라 쓸 수 있는 말이 달라진다');
{
  const codeMatch = judge('필립스 토스터기 HD2581', '필립스 토스터기 HD2581 화이트');
  check(codeMatch.level === 'strong' && codeMatch.modelHit === true,
    '★ 모델코드 일치 → strong + modelHit (「최대 절약」 사용 가능)', codeMatch);

  const tokenOnly = judge('로지텍 MX Master 3S 무선마우스', '로지텍 MX Master 3S 무선마우스 그래파이트');
  check(tokenOnly.level === 'strong' && tokenOnly.modelHit === false,
    '★ 코드 없이 토큰만 일치 → strong 이지만 modelHit=false (「가격 차이」만)', tokenOnly);

  const weak = judge('무선 이어폰', '무선 이어폰 케이스');
  check(weak.level === 'weak' && weak.why === 'accessory',
    '★ 왜 뺐는지 이유가 남는다 (why=accessory)', weak);
}

/* ================================================================
 *  7. 경계 · 방어
 * ================================================================ */
section('7. 빈 값 · 깨진 입력');
{
  check(judge('무선 이어폰', '').level === 'weak', '빈 제목은 비교하지 않는다');
  check(Compare.keyTokensOf('').length === 0, '빈 문자열은 토큰이 없다');
  check(Compare.specsOf('').length === 0, '빈 문자열은 규격이 없다');
  check(Compare.accessoriesOf('').length === 0, '빈 문자열은 부속품이 없다');
  check(Compare.modelCodesOf(null).length === 0, 'null 도 안전하다');

  // 일반 낱말(색상·연결방식)만으로는 통과하지 못한다
  check(!shown('무선 블루투스 이어폰 화이트', '무선 블루투스 스피커 화이트'),
    '★ 이어폰 ↔ 스피커 (일반 낱말만 겹친다)');
}

/* ── 결과 ── */
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
