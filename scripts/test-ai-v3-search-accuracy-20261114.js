#!/usr/bin/env node
/*
 * v3 검색 정확도 수정 (2026-11-14) — 외부 호출 0회 · DB 0회.
 *
 *   node scripts/test-ai-v3-search-accuracy-20261114.js
 *
 * 100문항 오프라인 실행(동결 카탈로그 77,737행)에서 잘못된 카드가 나온 원인을 하나씩 고정한다.
 *   Q005/Q008/Q010  액세서리 요청(노트북 거치대·아이패드 케이스·모니터 암)에 «본체» 카드
 *   Q020            «3만원짜리» 예산이 안 잡혀 14만~22만원 마우스 + «그레이마우스 열차 티켓»
 *   Q034            «아이패드 미니 7» 에 «mini(A20 Pro)» 신형이 같은 모델로
 *   Q046            «더 싼 거 없어?» 에 같은 4장을 다시
 *   Q051            «좀 더 비싼 거» 를 «싼 거» 로 읽음(수정 중 발견) · 악기 «전자키보드» 를 키보드로
 *   그리고 사용자가 상품을 분명히 말했는데 «구체적으로 알려주세요» 로 끝나던 답
 */
'use strict';

process.env.AI_V3_STATE_SECRET = 'search-accuracy-test-secret';
global.fetch = async url => { throw new Error('offline test: ' + url); };

const T = require('../api/_ai-v31-taxonomy');
const { parseBudget } = require('../api/_ai-v32-intent');
const { principalItem } = require('../api/_ai-v32-listing');
const I = require('../api/_ai-v3-identity');
const { createEngine } = require('../api/_ai-v3-core');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail === undefined ? '' : '  — ' + JSON.stringify(detail).slice(0, 300)}`); }
}
function section(t) { console.log(`\n[${t}]`); }

const item = (id, title, lprice, over) => Object.assign({ productId: id, title, lprice, shippingFee: 0, mall: '쿠팡',
  link: 'https://example.com/' + id, _source: 'api' }, over || {});

function deps(catalog, plan, seen) {
  return {
    planModel: async ({ message }) => (typeof plan === 'function' ? plan(message) : plan),
    decideModel: async ({ candidates }) => ({ productIds: candidates.slice(0, 4).map(c => c.id) }),
    searchProducts: async (_q, opts) => { if (seen) seen.push(opts); return catalog.filter(x => (!opts.maxPrice || x.lprice <= opts.maxPrice) && (!opts.minPrice || x.lprice >= opts.minPrice)); },
    loadDisplayed: async ids => catalog.filter(x => ids.includes('쿠팡:' + x.productId)),
    classifyModel: async () => ({ category: 'C' })
  };
}
const P = (query, category, mode) => ({ mode: mode || 'recommend', query, compareQuery: '', category, maxPrice: null, exclusions: [], mallOnly: '', exactModel: '' });

(async () => {
  console.log('=== v3 검색 정확도 수정 (2026-11-14) ===');

  section('1) 액세서리 요청은 본체 유형이 아니다 (taxonomy)');
  const acc = ['노트북 거치대 하나 찾아줘', '아이패드 케이스 추천해줘', '모니터 암 추천', '아이패드용 케이스', '에어팟 케이스',
    '아이패드 에어 11 M3 케이스', '갤럭시 탭 S9 FE 커버', '마우스 패드 추천', '갤럭시 워치 스트랩', '공기청정기 필터', '노트북 가방', '로봇청소기 물걸레'];
  ok(acc.every(s => T.explicitType(s) === '' && T.accessoryRequest(s)), '★ 12가지 «기기 + 액세서리» 는 기기 유형으로 풀리지 않는다', acc.map(s => [s, T.explicitType(s)]));
  const host = [['아이패드 키보드 케이스', '키보드'], ['키보드 케이스 추천', '키보드'], ['노트북 추천', '노트북'], ['아이패드 에어 11 M3', '태블릿'],
    ['맥북에 연결할 외장 SSD', '외장하드'], ['스마트 밴드 추천', '시계'], ['노트북 거치대 말고 노트북 추천', '노트북'], ['아이폰 호환 이어폰', '이어폰'],
    ['노트북 추천해줘 가방도 필요해', '노트북'], ['아이패드에 쓸 블루투스 키보드', '키보드']];
  ok(host.every(([s, w]) => T.explicitType(s) === w), '기기 요청·키보드 케이스·호환 대상 표현은 예전 그대로', host.map(([s]) => [s, T.explicitType(s)]));
  ok(T.canonicalCategory({ message: '노트북 거치대도 보여줘', priorCategory: '노트북', planCategory: '노트북' }) === '',
    '★ 앞 턴이 노트북이어도(GPT 가 노트북이라 해도) 거치대 요청은 노트북 검색이 아니다');
  ok(T.accessoryRequest('아이패드 에어 11 M3 케이스').phrase === '아이패드 에어 11 M3 케이스', '안내 문구용 구절');
  const t0 = Date.now(); for (let i = 0; i < 3000; i++) T.explicitType('아이패드 ' + 'a1 '.repeat(14) + 'x 추천');
  ok(Date.now() - t0 < 1500, '긴 모델 낱말 열에도 빠르다(역추적 없음) ' + (Date.now() - t0) + 'ms');

  section('2) 근사 가격 «N만원짜리 / 정도 / 내외»');
  ok(parseBudget('3만원짜리 마우스 추천').max === 34500 && parseBudget('3만원 정도 마우스').max === 34500 && parseBudget('30만원 내외 태블릿').max === 345000,
    '★ «약 N» → 상한 N×1.15 (예전: 예산 없음)');
  ok(parseBudget('3만원대 마우스').min === 30000 && parseBudget('3만원대 마우스').max === 39999 && parseBudget('5만원 이하').max === 50000 && parseBudget('갤럭시 S24 무게').max == null,
    '대(band)·이하·숫자 없는 문장은 예전 그대로');

  section('3) 상품이 아닌 목록 · 악기 건반');
  ok(principalItem('크라이스트처치-그레이마우스 TranzAlpine 열차 티켓').noun === 'non_goods' && !T.productTypeMatches('크라이스트처치-그레이마우스 TranzAlpine 열차 티켓', '마우스', ''),
    '★ 열차 티켓은 «마우스» 가 아니다(지명 그레이마우스)');
  ok(T.productTypeMatches('로지텍 G304 무선 마우스 + 스타벅스 상품권 증정', '마우스', '') && T.productTypeMatches('소니 WH-1000XM5 헤드폰 투어링 에디션', '헤드폰', ''),
    '증정 상품권·«투어링» 은 상품을 막지 않는다');
  ok(!T.productTypeMatches('야마하 전자키보드 PSR-F52 공식대리점 정품', '키보드', '기계식 키보드') && T.productTypeMatches('야마하 전자키보드 PSR-F52', '키보드', '전자키보드 추천'),
    '★ 악기 «전자키보드» 는 컴퓨터 키보드 요청에 나오지 않는다(악기를 찾으면 나온다)');

  section('4) 아이패드 미니 세대');
  const mini7 = I.requestedIdentity('아이패드 미니 7 최저가');
  ok(mini7.generation === 7, '★ «미니 7» → 7세대 (예전: 세대 없음)', mini7);
  ok(!I.checkListingIdentity('Apple 2026 아이패드 mini(A20 Pro 모델)', mini7).ok && I.checkListingIdentity('[셀러허브] Apple 아이패드 미니 7세대 퍼플 512GB', mini7).ok
    && I.checkListingIdentity('Apple iPad mini A17 Pro Wi-Fi 128GB', mini7).ok && !I.checkListingIdentity('애플 아이패드 미니 6세대 64GB', mini7).ok,
    '★ A20 Pro·6세대는 빠지고 7세대·A17 Pro 는 통과');
  ok(I.requestedIdentity('아이패드 미니 7.9인치').generation == null, '«미니 7.9인치» 의 7 은 세대가 아니다');

  section('5) 엔진 — 정직한 «카드 없음»');
  const laptops = [item('lap1', 'HP 노트북 15.6인치 i5', 359000), item('stand1', '알루미늄 노트북 거치대 각도조절', 19900)];
  let r = await createEngine(deps(laptops, P('노트북 거치대', '노트북')), { message: '노트북 거치대 하나 찾아줘' });
  ok(r.cards.length === 0 && r.stats.noResult === 'unsupported_accessory' && /액세서리/.test(r.answer) && !/359,000/.test(r.answer),
    '★ 노트북 거치대 → 노트북 카드 없음, 액세서리 미지원 안내', { a: r.answer, n: r.stats.noResult });
  r = await createEngine(deps([], P('USB-C 허브', '허브')), { message: 'USB-C 허브 좋은 거 있어?' });
  ok(r.stats.noResult === 'unsupported_type' && /USB-C 허브/.test(r.answer) && !/구체적으로/.test(r.answer), '★ 이름을 댄 미지원 상품군 → «아직 검증 못 하는 종류» (예전: 구체적으로 알려주세요)', r.answer);
  r = await createEngine(deps([], P('애플 제품', '')), { message: '애플 제품만 보여줘' });
  ok(r.stats.noResult === 'needs_type_with_brand' && /애플 제품 중 어떤 종류/.test(r.answer), '브랜드만 → 종류를 함께 말해 달라는 안내', r.answer);
  r = await createEngine(deps([], P('', '', 'recommend')), { message: '음 뭐 좋은 거' });
  ok(/구체적으로/.test(r.answer) && r.stats.noResult === 'needs_detail', '정말 모호하면 예전 안내 그대로');

  section('6) 엔진 — 예산·후속 가격');
  const seenA = [];
  const mice = [item('m1', '로지텍 G102 유선 마우스', 19900), item('m2', '로지텍 G502 X 무선 게이밍 마우스', 145180),
    item('m3', '크라이스트처치-그레이마우스 TranzAlpine 열차 티켓', 18150)];
  r = await createEngine(deps(mice, P('마우스', '마우스'), seenA), { message: '3만원짜리 마우스 추천' });
  ok(seenA[0] && seenA[0].maxPrice === 34500 && r.cards.every(c => c.price <= 34500) && r.cards.length === 1 && /G102/.test(r.cards[0].title),
    '★ 3만원짜리 → 34,500원 상한, 티켓은 빠지고 G102 만', r.cards.map(c => c.title));
  const buds = [item('e1', 'A 무선 이어폰', 49900), item('e2', 'B 무선 이어폰', 22950), item('e3', 'C 무선 이어폰', 9800), item('e4', 'D 무선 이어폰', 12900)];
  const seenB = [];
  const d = deps(buds, m => P(/더 싼/.test(m) ? '' : '무선 이어폰', /더 싼/.test(m) ? '' : '이어폰'), seenB);
  const first = await createEngine({ ...d, decideModel: async ({ candidates }) => ({ productIds: candidates.filter(c => c.price >= 22950).map(c => c.id) }) },
    { message: '5만원 이하 무선 이어폰 추천해줘' });
  ok(first.cards.length === 2, '앞 턴: 22,950·49,900원 두 장');
  r = await createEngine(d, { message: '더 싼 거 없어?', state: first.state });
  ok(seenB[seenB.length - 1].maxPrice === 22949 && r.cards.length > 0 && r.cards.every(c => c.price < 22950),
    '★ «더 싼 거 없어?» → 앞 카드 중 최저가(22,950)보다 싼 것만 (예전: 같은 카드)', r.cards.map(c => c.price));
  const kbs = [item('k1', '에이투 게이밍 기계식 키보드 갈축', 59900), item('k2', '큐센 Q104 가스켓 기계식 키보드', 64800),
    item('k3', '칠키 풀메탈 기계식 키보드 SF60', 258500), item('k4', '야마하 전자키보드 PSR-F52', 169000), item('k5', '앱코 기계식 키보드', 23900)];
  const seenC = [];
  const dk = deps(kbs, m => P(/비싼/.test(m) ? '' : '기계식 키보드', /비싼/.test(m) ? '' : '키보드'), seenC);
  const kfirst = await createEngine({ ...dk, decideModel: async ({ candidates }) => ({ productIds: candidates.filter(c => c.price >= 59900 && c.price <= 64800).map(c => c.id) }) },
    { message: '20만원 이하 기계식 키보드 추천해줘' });
  r = await createEngine(dk, { message: '좀 더 비싼 거 보여줘', state: kfirst.state });
  const last = seenC[seenC.length - 1];
  ok(last.minPrice === 64801 && last.maxPrice == null && r.cards.length && r.cards.every(c => c.price > 64800),
    '★ «좀 더 비싼 거» → 앞 카드 최고가보다 비싸게, 옛 상한(20만원)은 풀린다 (수정 중: «싼 거» 로 잘못 읽힘)', { last, cards: r.cards.map(c => c.price) });
  ok(r.cards.every(c => !/전자키보드/.test(c.title)), '★ 악기 건반은 끼지 않는다', r.cards.map(c => c.title));
  const seenD = [];
  const lap = [item('l1', 'LG 그램 15 노트북', 720000), item('mm', '로지텍 무선 마우스', 30000)];
  const dl = deps(lap, m => (/마우스/.test(m) ? P('마우스', '마우스') : P('노트북', '노트북')), seenD);
  const l1 = await createEngine(dl, { message: '노트북 추천해줘' });
  await createEngine(dl, { message: '저렴한 마우스 추천해줘', state: l1.state });
  ok(seenD[seenD.length - 1].maxPrice == null, '다른 상품(노트북 → 마우스)의 «저렴한» 은 앞 카드 가격 상한을 물려받지 않는다');

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
  if (fail) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
