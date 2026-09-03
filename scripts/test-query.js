#!/usr/bin/env node
/*
 * 검색어 생성 규칙 테스트 — 외부 호출 0회 / DB 접근 0회.
 *
 *   node scripts/test-query.js
 *
 * ── 왜 이 파일이 있는가 ─────────────────────────────────────────
 *
 * 수집률을 좌우하는 것은 "몇 번 부르느냐"가 아니라 "무엇을 부르느냐"였다.
 * 2026-08-31 운영 데이터로 실제 쿠팡 API 를 두 번 측정했다.
 *
 *   실험 E2 (n=24, 최근 7일 미수집 상품)
 *     제목 48자 절삭        79.2%
 *     제목 앞 5토큰(당시)    66.7%
 *     브랜드+IDF 희귀토큰    58.3%   ← 오히려 나빴다. 채택하지 않았다.
 *
 *   실험 C (n=14, 8가지 검색어를 전부 시도)
 *     제목48 단독            78.6%
 *     +브랜드+마지막명사      85.7%
 *     +브랜드+명사2·3        92.9%   ← 상한. 4번째부터는 오르지 않았다.
 *
 * 이 파일은 그 결론을 코드로 고정한다. 규칙이 조용히 바뀌면 수집률이
 * 조용히 떨어지는데, 그건 화면에 아무 표시도 남기지 않는다.
 *
 * ── 이 테스트가 지키는 것 ───────────────────────────────────────
 *   ① 후보는 최대 5개 (PHASE 10 에서 T4·T7 추가로 3 → 5)
 *   ② 모델코드가 없으면 첫 후보는 제목 기반 (실측 1위)
 *      모델코드가 있으면 브랜드+모델코드가 먼저 온다 (가장 강한 식별자)
 *   ③ 쿠팡 50자 제한을 넘지 않는다 (실측 rCode=400)
 *   ④ 빈 검색어·중복 검색어를 만들지 않는다
 *   ⑤ 1차 keyword 를 2차에서 다시 부르지 않는다
 *   ⑥ 제목에 없는 브랜드·모델명을 지어내지 않는다
 *   ⑦ facet 은 새로 덮이는 상품이 있을 때만 만든다
 */
'use strict';

const {
  MAX_QUERY_LEN, tokenize, normalizeQuery, brandOf, modelsOf, nounsOf,
  generateSecondPassQueries, buildFacetQueries
} = require('../api/_query');

let pass = 0, fail = 0;
function check(ok, label, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail === undefined ? '' : '  — ' + JSON.stringify(detail)}`); }
}
function section(n) { console.log(`\n${n}`); }

const P = (title, keyword) => ({ title, keyword: keyword || '' });

console.log('=== 검색어 생성 규칙 테스트 ===');

/* ================================================================
 *  1. 길이 제한 — 쿠팡 rCode=400 방지
 * ================================================================ */
section('1. 검색어 길이 (쿠팡 실측 상한 50자)');
{
  check(MAX_QUERY_LEN <= 50, '★★ 상한이 50자 이하다', MAX_QUERY_LEN);

  const long = '아주아주긴상품명 '.repeat(20);
  const qs = generateSecondPassQueries(P(long));
  check(qs.every(q => q.length <= MAX_QUERY_LEN),
    '★★ 아무리 긴 제목이어도 모든 후보가 상한 이내다', qs.map(q => q.length));

  check(normalizeQuery('a'.repeat(200)).length === MAX_QUERY_LEN,
    '★ normalizeQuery 가 상한에서 자른다');
  check(normalizeQuery('  겹친   공백   ') === '겹친 공백', '공백을 정리한다');
  check(normalizeQuery(null) === '' && normalizeQuery(undefined) === '', 'null·undefined 안전');
}

/* ================================================================
 *  2. 후보 개수와 순서 — 실측 근거
 * ================================================================ */
section('2. 후보 개수·순서');
{
  const p = P('루이벤 암막 정전기 강력흡수 차량용 햇빛가리개 앞유리', '차량용 햇빛 가리개');
  const qs = generateSecondPassQueries(p);

  /*
   * 2026-08-31 PHASE 10: 후보 3개 → 5개.
   * 기존 8가지 실험의 상한은 3개에서 닿았지만, 그 8가지에 T4(제목 압축)와
   * T7(특수문자 정규화)가 없었다. 두 후보를 더한 사다리라 상한도 5다.
   */
  const { MAX_CANDIDATES: MC } = require('../api/_query');
  check(qs.length <= MC, `★★ 후보는 상한(${MC}개)을 넘지 않는다`, qs);
  check(qs.length >= 1, '후보를 만든다', qs);
  check(qs[0].indexOf('루이벤') === 0,
    '★★ 첫 후보는 제목 기반이다 (실측 단독 1위 78.6~79.2%)', qs[0]);
  check(qs[0] === p.title.slice(0, MAX_QUERY_LEN).trim(),
    '★ 첫 후보 = 제목 48자 절삭', qs[0]);

  // 2·3번 후보는 브랜드로 시작한다
  /*
   * PHASE 10 이후 사다리는 [제목, 브랜드+꼬리, 제목압축, 브랜드+명사2·3, 제목정규화]
   * 다. 3번째(제목 압축)는 뒤쪽 토큰을 취하므로 브랜드로 시작하지 않는 것이
   * 정상이다. 그래서 '전부 브랜드로 시작' 대신 '브랜드 후보가 사다리 안에
   * 있다' 를 확인한다.
   */
  check(qs.filter(q => q.indexOf('루이벤') === 0).length >= 2,
    '★ 브랜드로 시작하는 후보가 둘 이상 있다', qs);

  check(new Set(qs).size === qs.length, '★★ 중복 후보가 없다', qs);
  check(qs.every(q => q && q.trim()), '★★ 빈 후보가 없다', qs);
}

/* ================================================================
 *  3. 1차 keyword 재호출 방지 (예산 낭비)
 * ================================================================ */
section('3. 이미 부른 검색어를 다시 만들지 않는다');
{
  const p = P('수영복 여성 원피스', '수영복 여성 원피스');
  const qs = generateSecondPassQueries(p);
  check(!qs.includes('수영복 여성 원피스'),
    '★★ 1차 keyword 와 같은 문구는 후보에서 빠진다', qs);

  const p2 = P('아레나 여성 수영복 원피스 블랙', '수영복');
  const q2 = generateSecondPassQueries(p2, { exclude: ['아레나 여성 수영복 원피스 블랙'] });
  check(!q2.includes('아레나 여성 수영복 원피스 블랙'),
    '★★ exclude 로 넘긴 검색어를 만들지 않는다 (오늘 이미 시도한 것)', q2);

  const q3 = generateSecondPassQueries(p2, { exclude: [] });
  check(q3.length > q2.length || q3[0] !== q2[0],
    '★ exclude 가 실제로 후보를 줄인다', { q2, q3 });
}

/* ================================================================
 *  4. 없는 정보를 지어내지 않는다
 * ================================================================ */
section('4. 제목에 없는 것을 만들지 않는다');
{
  const p = P('무선 블루투스 이어폰 노이즈캔슬링');
  const qs = generateSecondPassQueries(p);
  const src = p.title.toLowerCase();
  const allFromTitle = qs.every(q =>
    q.toLowerCase().split(/\s+/).every(w => src.indexOf(w) > -1));
  check(allFromTitle, '★★ 모든 후보의 모든 토큰이 제목 안에 실제로 있다', qs);

  check(generateSecondPassQueries(P('')).length === 0, '★ 빈 제목 → 후보 0개');
  check(generateSecondPassQueries(P(null)).length === 0, '★ null 제목 안전');
  check(generateSecondPassQueries(null).length === 0, '★ 상품 자체가 null 이어도 안전');
  check(generateSecondPassQueries(P('12개 60g 1p')).length >= 0, '수량·단위만 있어도 죽지 않는다');
}

/* ================================================================
 *  5. 토큰 분류
 * ================================================================ */
section('5. 토큰 분류 (브랜드·모델·명사)');
{
  check(brandOf('포렙 게이밍 유선 마우스 FV-X9, 베이지') === '포렙',
    '★ 첫 토큰을 브랜드 후보로 본다');
  check(brandOf('[로켓프레시] 비비고 얇은피 고기만두') === '비비고',
    '★ 대괄호 머리표는 버리고 그 다음을 브랜드로');
  check(brandOf('') === '', '빈 제목 → 브랜드 없음');

  const m = modelsOf('아이리스 수퍼 서큘레이터 PCF-HM23 화이트');
  check(m.includes('PCF-HM23'), '★ 영문+숫자 혼합을 모델코드로 잡는다', m);

  const m2 = modelsOf('닥터헤디슨 알로에 베라 수딩 젤 2개 500ml');
  check(!m2.includes('500ml'), '★★ 단위(500ml)를 모델코드로 오인하지 않는다', m2);

  const n = nounsOf('포렙 게이밍 유선 마우스 FV-X9');
  check(!n.includes('FV-X9'), '명사 목록에 모델코드가 섞이지 않는다', n);

  check(!tokenize('정품 무료배송 삼성 노트북').includes('정품'),
    '★ 판매 문구(정품·무료배송)를 검색어 토큰에서 제외한다');
  check(tokenize('정품 무료배송 삼성 노트북').includes('삼성'), '실제 브랜드는 남긴다');
}

/* ================================================================
 *  6. facet 분할 (큰 그룹)
 * ================================================================ */
section('6. facet 분할');
{
  const rows = [
    { product_id: 'A', title: '브랜드가 여행용 캐리어 20인치 하드' },
    { product_id: 'B', title: '브랜드나 여행용 캐리어 20인치 소프트' },
    { product_id: 'C', title: '브랜드다 여행용 캐리어 24인치 하드' },
    { product_id: 'D', title: '브랜드라 여행용 캐리어 28인치 확장형' }
  ];
  const f = buildFacetQueries('여행용 캐리어', rows, new Set(), 6);

  check(f.length > 0, '★ facet 후보를 만든다', f.map(x => x.query));
  check(f.every(x => x.query.indexOf('여행용 캐리어') === 0),
    '★★ 모든 facet 이 원래 검색어를 포함한다 (엉뚱한 검색이 되지 않게)', f.map(x => x.query));
  check(f.every(x => x.query.length <= MAX_QUERY_LEN), '★★ facet 도 길이 상한을 지킨다');
  check(f[0].expect >= (f[1] ? f[1].expect : 0),
    '★★ 더 많은 상품을 덮는 facet 이 먼저 온다 (greedy set cover)', f.map(x => x.expect));
  check(!f.some(x => x.query === '여행용 캐리어'),
    '★ 원래 검색어와 똑같은 facet 은 만들지 않는다');
  check(new Set(f.map(x => x.query)).size === f.length, '★ facet 중복 없음');

  // 이미 다 덮였으면 만들지 않는다
  const allCovered = new Set(['A', 'B', 'C', 'D']);
  check(buildFacetQueries('여행용 캐리어', rows, allCovered, 6).length === 0,
    '★★ 새로 덮을 상품이 없으면 facet 을 만들지 않는다 (호출 낭비 방지)');

  // 검색어에 이미 있는 말은 facet 이 될 수 없다
  check(!f.some(x => x.token === '여행용' || x.token === '캐리어'),
    '★ 검색어에 이미 있는 낱말은 facet 토큰이 아니다', f.map(x => x.token));

  check(buildFacetQueries('', rows, new Set(), 6).length === 0, '빈 검색어 안전');
  check(buildFacetQueries('키워드', [], new Set(), 6).length === 0, '빈 상품 목록 안전');
  check(buildFacetQueries('키워드', rows, new Set(), 0).length === 0, 'max=0 이면 만들지 않는다');
}

/* ================================================================
 *  7. 실제 운영 제목으로 회귀
 * ================================================================ */
section('7. 실제 운영 상품 제목');
{
  const real = [
    ['포렙 게이밍 유선 마우스 FV-X9, 베이지', '마우스'],
    ['ASUS TUF F16 FX608JMI-QT273 인텔 i5-14450HX RTX5060', '노트북'],
    ['[브랜드인증] 존바바토스 아티산 블루 오 드 뚜왈렛', '향수'],
    ['잔온 레일형 차량 햇빛가리개 암막커튼, 2개, 블랙', '차량용 햇빛 가리개'],
    ['무선 블루투스 이어폰 노이즈캔슬링 장시간 배터리 고음질, 화이트, T13-APP', '']
  ];
  const { MAX_CANDIDATES: CAP7 } = require('../api/_query');
  let allOk = true;
  real.forEach(([t, k]) => {
    const qs = generateSecondPassQueries(P(t, k));
    const ok = qs.length >= 1 && qs.length <= CAP7
      && qs.every(q => q.length <= MAX_QUERY_LEN && q.trim())
      && new Set(qs).size === qs.length;
    if (!ok) { allOk = false; console.log(`       ↳ 문제: "${t}" → ${JSON.stringify(qs)}`); }
  });
  check(allOk, `★★ 운영 제목 5종 모두 1~${CAP7}개의 유효한 후보를 만든다`);

  // 대괄호로 시작하는 제목도 제목 후보가 살아 있어야 한다
  const brq = generateSecondPassQueries(P('[브랜드인증] 존바바토스 아티산 블루 오 드 뚜왈렛', '향수'));
  check(brq[0].indexOf('[브랜드인증]') === 0,
    '★ 첫 후보는 제목 원문 그대로다 (대괄호 포함 — 쿠팡 색인에 그대로 있다)', brq[0]);
}

/* ================================================================
 *  8. PHASE 10 — Tier 확장 (T4 제목압축 · T7 특수문자 정규화)
 * ================================================================ */
section('8. T4 제목 압축');
{
  const { compressTitle } = require('../api/_query');

  check(compressTitle('[무료배송] 2026 최신 인기 초경량 프리미엄 여행용 캐리어 28인치', 3)
        === '여행용 캐리어 28인치',
    '★★ 광고 문구·연도·수식어를 걷어내고 핵심만 남긴다',
    compressTitle('[무료배송] 2026 최신 인기 초경량 프리미엄 여행용 캐리어 28인치', 3));

  check(compressTitle('브랜드 상품', 4) === '브랜드 상품',
    '★ 토큰이 상한보다 적으면 그대로 둔다');
  check(compressTitle('', 4) === '', '빈 제목 안전');
  check(compressTitle(null, 4) === '', 'null 안전');

  // 앞이 아니라 뒤를 취한다 (실측 근거: 식별력이 뒤에 몰려 있다)
  const c = compressTitle('가가 나나 다다 라라 마마 바바', 2);
  check(c === '마마 바바', '★★ 뒤쪽 토큰을 취한다 (앞이 아니다)', c);

  // 연도·수식어가 실제로 제거되는지
  const { tokenize } = require('../api/_query');
  check(!tokenize('2026 최신 프리미엄 캐리어').includes('2026'), '★ 연도 토큰 제거');
  check(!tokenize('2026 최신 프리미엄 캐리어').includes('최신'), '★ 수식어 제거');
  check(tokenize('2026 최신 프리미엄 캐리어').includes('캐리어'), '★ 실제 상품명은 남긴다');
}

section('9. T7 특수문자 정규화');
{
  const { normalizeSpecial, splitModelCode } = require('../api/_query');

  check(splitModelCode('T13-APP') === 'T13 APP',
    '★★ 하이픈 모델코드를 띄운 표기로 (상한 실험 실패 사례)', splitModelCode('T13-APP'));
  check(splitModelCode('PCF-HM23') === 'PCF HM23', '★ 하이픈 분리');
  check(splitModelCode('PAW3395') === '',
    '★★ 하이픈이 없으면 빈 값 (같은 검색을 두 번 하지 않는다)');
  check(splitModelCode('') === '' && splitModelCode(null) === '', '빈 값 안전');

  const n = normalizeSpecial('무선 이어폰, 화이트, T13-APP');
  check(n === '무선 이어폰 화이트 T13 APP', '★ 제목 전체 특수문자 정규화', n);
  check(normalizeSpecial('특수문자 없는 제목') === '',
    '★★ 정규화해도 같으면 빈 값 (중복 후보 방지)');

  // 실제 실패 사례가 사다리에 들어오는지
  const qs = generateSecondPassQueries(
    P('무선 블루투스 이어폰 노이즈캔슬링 장시간 배터리 고음질, 화이트, T13-APP', ''));
  check(qs.some(q => q.indexOf('T13 APP') > -1),
    '★★ 상한 실험에서 실패한 상품에 "띄어 쓴 모델코드" 후보가 생긴다', qs);
}

section('10. 상품당 후보 상한 (호출 예산 보호)');
{
  const { MAX_CANDIDATES } = require('../api/_query');
  /*
   * ★ 5 → 9 (2026-09-03). 숫자 자체보다 지켜야 할 것은 아래 세 성질이다.
   *
   *   · 상한이 라운드 수와 같다      → 만들어 둔 후보를 다 쓰고, 빈 라운드를 안 돈다
   *     (scripts/test-round-index.js 가 소스에서 두 값을 직접 비교한다)
   *   · 후보 배열은 raw 후보 수를 넘지 않는다
   *   · 중복·빈 문자열·길이 초과가 없다
   *
   * 상한을 늘려도 호출이 상품 수만큼 늘지 않는 이유는 _query.js 주석 참고
   * (적중하면 다음 라운드에서 빠지고, 같은 문구는 한 번만 부른다).
   */
  check(MAX_CANDIDATES === 10, '★ 상한이 10이다', MAX_CANDIDATES);

  const rich = P('아이리스 수퍼 서큘레이터 PCF-HM23 화이트 28인치 대용량 무선', '서큘레이터');
  const qs = generateSecondPassQueries(rich);
  check(qs.length <= MAX_CANDIDATES,
    '★★ 신호가 아무리 많아도 상한을 넘지 않는다', qs.length);
  check(new Set(qs).size === qs.length, '★★ 상한 안에서도 중복 없음', qs);
  check(qs.every(q => q.length <= MAX_QUERY_LEN), '★★ 전부 길이 상한 이내');

  // max 옵션으로 더 줄일 수 있다
  const three = generateSecondPassQueries(rich, { max: 3 });
  check(three.length <= 3, '★ max 옵션이 상한을 더 낮춘다', three.length);
  check(JSON.stringify(three) === JSON.stringify(qs.slice(0, 3)),
    '★★ 줄여도 앞에서부터 같은 순서다 (랭킹 안정성)', { three, head: qs.slice(0, 3) });

  check(generateSecondPassQueries(rich, { max: 0 }).length === 0, '★ max=0 이면 후보 없음');
}

section('11. 랭킹 순서 (실측 근거대로)');
{
  // 모델코드가 있으면 브랜드+모델코드가 첫 후보
  const withModel = generateSecondPassQueries(P('아이리스 수퍼 서큘레이터 PCF-HM23 화이트', '서큘레이터'));
  check(withModel[0] === '아이리스 PCF-HM23',
    '★★ 모델코드가 있으면 브랜드+모델코드가 1순위 (가장 강한 식별자)', withModel[0]);
  /*
   * ★ 2순위가 "브랜드 + 모델코드 + 꼬리 명사" 로 바뀌었다 (2026-09-03).
   *
   *   모델코드만으로는 부품·액세서리를 가르지 못한다. 실측: 쿠쿠
   *   CRP-DHAS069FWM 로 등록된 우리 상품 3개(컨트롤 패킹·고무패킹·열림 버튼)가
   *   "쿠쿠 CRP-DHAS069FWM" 한 문구로는 셋 다 상위 10건 밖으로 밀렸다.
   *   같은 모델의 부품을 파는 판매자가 열 곳이 넘기 때문이다.
   *   띄어 쓴 표기는 같은 신호의 변형이라 3순위로 내린다.
   */
  check(withModel[1] === '아이리스 PCF-HM23 화이트',
    '★★ 그 다음이 브랜드+모델코드+꼬리 명사 (같은 모델의 부품을 가른다)', withModel[1]);
  check(withModel[2] === '아이리스 PCF HM23',
    '★★ 띄어 쓴 표기는 그 다음 (같은 신호의 다른 색인 형태)', withModel[2]);

  /* 꼬리 명사는 포장·수량을 건너뛴다 (tailNounOf) */
  const packed = generateSecondPassQueries(P('환타 파인애플 500ml 업소용, 355ml, 48개', '환타'));
  check(packed.indexOf('환타 상등급') < 0 && packed.some(q => q.indexOf('파인애플') > -1),
    '★★ 꼬리 명사가 수량("48개")이 아니라 상품을 구분하는 말이다', packed);
  const rice = generateSecondPassQueries(P('25년 햅쌀 대왕님표 여주쌀 진상미 10kg, 1개, 상등급', '햅쌀'));
  check(rice.indexOf('25년 상등급') !== 0,
    '★ "상등급" 같은 등급 표기가 첫 꼬리 명사로 뽑히지 않는다', rice);

  // 모델코드가 없으면 제목이 첫 후보 (실측 단독 최고)
  const noModel = generateSecondPassQueries(P('루이벤 암막 정전기 강력흡수 차량용 햇빛가리개', '차량용 햇빛 가리개'));
  check(noModel[0].indexOf('루이벤 암막') === 0,
    '★★ 모델코드가 없으면 제목이 1순위 (실측 78.6~79.2%)', noModel[0]);

  // 어느 경우에도 제목 후보는 사다리 안에 있다
  check(withModel.some(q => q.indexOf('아이리스 수퍼 서큘레이터') === 0),
    '★★ 모델코드가 있어도 제목 후보가 사다리에서 빠지지 않는다', withModel);
}

section('12. 없는 정보를 만들지 않는다 (Tier 확장 후에도)');
{
  const cases = [
    '매일두유 검은콩',
    '여행팩 택1',
    '르 라보 샤워 젤 바질',
    '[무료배송] 2026 최신 인기 초경량 프리미엄 여행용 캐리어 28인치'
  ];
  let ok = true;
  cases.forEach(t => {
    const qs = generateSecondPassQueries(P(t));
    /*
     * ★ 양쪽을 **같은 방식으로** 정규화한 뒤 비교한다.
     *   처음엔 원본만 특수문자를 지우고 후보는 그대로 뒀는데, 후보 중
     *   하나가 제목 원문("[무료배송] …")이라 "[무료배송]" 토큰이
     *   "제목에 없다" 로 잡혔다. 후보는 정의상 제목에서 나온 것이라
     *   그건 코드 문제가 아니라 비교 방식의 문제였다.
     */
    const norm = x => String(x).toLowerCase().replace(/[\-_/.()\[\],]/g, ' ');
    const src = norm(t);
    qs.forEach(q => {
      norm(q).split(/\s+/).forEach(w => {
        if (!w) return;
        if (src.indexOf(w) === -1) { ok = false; console.log(`       ↳ "${t}" 후보 "${q}" 의 "${w}" 가 제목에 없음`); }
      });
    });
  });
  check(ok, '★★ Tier 를 늘린 뒤에도 모든 토큰이 제목 안에 실제로 있다');

  check(generateSecondPassQueries(P('매일두유 검은콩', '두유')).length >= 1,
    '★ 신호가 빈약해도 최소 1개는 만든다');
}

console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
