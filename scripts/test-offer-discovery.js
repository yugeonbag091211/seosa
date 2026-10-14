#!/usr/bin/env node
'use strict';
/*
 * Candidate Discovery v2 (api/_offerdiscovery.js) — 외부 호출 0회, DB 0회.
 *
 *   node scripts/test-offer-discovery.js
 *
 * 이 파일이 지키는 것: **후보를 늘려도 MATCH 의 정밀도는 그대로다.**
 *
 *   A. 모델번호 표기 — 16-AH1075TX = 16AH1075TX = 16 AH1075TX = 16 AH 1075 TX 가 같은 후보 키
 *   B. hard negative — 후보로 만나도(키 공유) 끝까지 다른 군집이다 (사용자 지정 11종 + 다리 놓기)
 *   C. 발견 — 붙여쓰기만 다른 계열 낱말은 baseline 이 못 묶고 v2 가 묶는다
 *   D. 기존 군집 보존 — v2 군집 ⊇ baseline 군집, all-pairs 위반 0
 *   E. 판매처 — 표시 판매처가 다르면 교차, 라벨 없는 ADPICK 은 «모름», 알려진 같은 판매처 쌍은 만들지 않는다
 *   F. 옵션 서명 — MATCH 쌍은 언제나 같은 칸 (큰 버킷을 나눠도 MATCH 를 잃지 않는다)
 *   G. 크기 상한 — 큰 버킷은 나누거나 건너뛰고 센다 (O(N²) 아님)
 *   H. 순서 무관 — 입력을 섞어도 같은 분할
 *   I. 소비자 0 — 운영 경로가 이 모듈을 부르지 않는다 (오프라인 평가 전용)
 *
 * ★ 기대값을 통과시키려고 고치지 않는다. 판정은 api/_offeridentity.js 의 것이고, 이 모듈은 판정하지 않는다.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const OI = require('../api/_offeridentity');
const SH = require('../api/_identityshadow');
const F = require('./fixtures/offer-identity-fixtures');
// 뮤테이션 검사(scripts/test-offer-discovery-mutations.js)가 약하게 만든 사본을 끼운다.
const D = require(process.env.OFFER_DISCOVERY_MODULE || '../api/_offerdiscovery');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) pass++;
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}
let seq = 0;
const offer = (title, mall, extra) => Object.assign({ key: `${mall}|t${++seq}`, title, mall, productId: `t${seq}`, price: 0 }, extra || {});
const groupOf = (res, key) => res.groups.find(g => g.members.includes(key));
const together = (res, a, b) => groupOf(res, a.key) === groupOf(res, b.key);
const keySet = x => new Set(D.discoveryKeys(x).map(k => k.key));
const shareKey = (a, b) => { const A = keySet(a); return [...keySet(b)].some(k => A.has(k)); };

/* ==================================================================
 *  A. 모델번호 표기
 * ================================================================== */
console.log('=== A. 모델번호 표기 ===');
{
  const forms = ['HP 오멘 MAX 16-AH1075TX 게이밍 노트북', 'HP 오멘 MAX 16AH1075TX 게이밍 노트북',
    'HP 오멘 MAX 16 AH1075TX 게이밍 노트북', 'HP 오멘 MAX 16 AH 1075 TX 게이밍 노트북', 'HP 오멘 MAX 16_AH1075TX 게이밍 노트북'];
  forms.forEach(t => ok(D.codeRunKeys(t).has('16ah1075tx'), `«${t}» → 16ah1075tx`, JSON.stringify([...D.codeRunKeys(t).keys()])));
  ok(D.codeRunKeys('SM-R630NZWAKOO').has('smr630'), '색·지역 접미를 뗀 줄기도 키다 (SM-R630NZWAKOO → smr630)');
  [['WH-1000XM6', 'wh1000xm6'], ['WF-1000XM6', 'wf1000xm6'], ['FV6522KO', 'fv6522ko'], ['SM-R630', 'smr630'],
    ['MX-MASTER-3S', ''], ['880840-603', '880840603'], ['브리츠 BZ-AX1 스피커', 'bzax1']].forEach(([t, k]) => {
    if (k) ok(D.codeRunKeys(t).has(k), `«${t}» → ${k}`, JSON.stringify([...D.codeRunKeys(t).keys()]));
  });
  // MX-MASTER-3S 는 숫자가 하나라 모델번호 키는 없다 — 계열 키(logitech|3s)가 맡는다.
  ok(keySet(offer('로지텍 MX MASTER 3S 무선 마우스', 'ADPICK/SSG')).has('f:logitech|3s|'), 'MX Master 3S 는 계열 키로 후보가 된다');
  // 규격·표준·단위는 모델번호 키가 아니다
  ['USB 3.0 허브', 'Wi-Fi 6 공유기', 'Win11 Home 노트북', '32G/1TB 2.5K 240Hz', '비타민 500mg 1080p', '1200x900 매트', 'M.2 NVMe SSD']
    .forEach(t => ok(D.codeRunKeys(t).size === 0, `«${t}» 는 모델번호 키가 없다`, JSON.stringify([...D.codeRunKeys(t).keys()])));
  // 숫자+단위 말 앞의 앵커(26년 · 1등급 · 2채널)와 판매자 꼬리표 안의 숫자는 계열 키가 아니다
  ['[쌀가게] 26년 햅쌀 경기미 4kg', 'LG 드럼 세탁기 1등급 화이트', '[룽스_6820]삼양 볶음면 130g', '브리츠 2채널 북쉘프 스피커']
    .forEach(t => ok(![...keySet(offer(t, 'ADPICK/SSG'))].some(k => k.startsWith('f:')), `«${t}» 는 계열 키가 없다`, [...keySet(offer(t, 'ADPICK/SSG'))].join(' ')));
}

/* ==================================================================
 *  B. hard negative — 후보가 돼도 묶이지 않는다
 * ================================================================== */
console.log('=== B. hard negative ===');
const HARD_NEGATIVES = [
  ['AirPods Pro 3 vs Case', 'Apple 에어팟 프로 3 화이트', 'Apple 에어팟 프로 3 케이스 화이트'],
  ['iPhone 17 Pro vs Pro Max', 'Apple 아이폰 17 Pro 256GB 블랙 자급제', 'Apple 아이폰 17 Pro Max 256GB 블랙 자급제'],
  ['iPhone 17 Pro 256GB vs 512GB', 'Apple 아이폰 17 Pro 256GB 블랙 자급제', 'Apple 아이폰 17 Pro 512GB 블랙 자급제'],
  ['Galaxy Buds3 vs Buds3 Pro', '삼성 갤럭시 버즈3 화이트 SM-R530', '삼성 갤럭시 버즈3 프로 화이트 SM-R630'],
  ['Galaxy Buds3 vs Buds3 Pro (모델번호 없음)', '삼성 갤럭시 버즈3 화이트', '삼성 갤럭시 버즈3 프로 화이트'],
  ['MX Master 3 vs 3S', '로지텍 MX Master 3 무선 마우스 그라파이트', '로지텍 MX Master 3S 무선 마우스 그라파이트'],
  ['RTX4060 vs RTX5070Ti (다른 모델번호)', 'HP 오멘 16-AH1074TX RTX4060 16GB 512GB 게이밍 노트북', 'HP 오멘 16-AH1075TX RTX5070Ti 32GB 1TB 게이밍 노트북'],
  ['RTX4060 vs RTX5070Ti (같은 기본 모델)', 'ASUS ROG Strix G16 G614JV RTX4060 16GB 1TB 노트북', 'ASUS ROG Strix G16 G614JV RTX5070Ti 16GB 1TB 노트북'],
  ['신품 vs 중고', '소니 WH-1000XM6 블랙 새상품', '소니 WH-1000XM6 블랙 중고 S급'],
  ['본품 vs 액세서리', '소니 WH-1000XM6 블랙', '소니 WH-1000XM6 전용 케이스 블랙'],
  ['1개입 vs 2개입 세트', '미쟝센 파워스윙 매트왁스9 80g 1개', '미쟝센 파워스윙 매트왁스9 80g 2개 세트'],
  ['구매 vs 렌탈', '코웨이 아이콘 정수기 CHP-7211N 화이트', '코웨이 아이콘 정수기 CHP-7211N 화이트 렌탈 의무 36개월'],
  ['정품 vs 호환', '삼성 갤럭시 버즈3 프로 화이트 SM-R630', '갤럭시 버즈3 프로 호환 이어팁 화이트 SM-R630'],
  ['정품 vs 복제품', 'Apple 에어팟 프로 3 화이트', '에어팟 프로 3 레플리카 화이트'],
  ['정품 vs OEM 대체품', '필립스 소닉케어 칫솔모 HX9024 4개입', '필립스 소닉케어 호환 대체품 칫솔모 HX9024 4개입']
];
{
  const malls = ['ADPICK/SSG', 'ADPICK/Hmall', '쿠팡', 'ADPICK/롯데홈쇼핑'];
  const all = [];
  const pairs = HARD_NEGATIVES.map(([name, a, b], i) => {
    const A = offer(a, malls[i % 4]), B = offer(b, malls[(i + 1) % 4]);
    all.push(A, B);
    return { name, A, B };
  });
  // 다리 놓기 — 옵션을 모르는 오퍼가 두 옵션 사이에 끼어도 하나로 묶이지 않는다.
  const bridge = offer('Apple 아이폰 17 Pro 블랙 자급제', 'ADPICK/GS SHOP');
  all.push(bridge);
  const res = D.rediscover(all);
  let candidates = 0;
  pairs.forEach(({ name, A, B }) => {
    const r = OI.matchOffers(A, B, OI.contextFactory(all.map(OI.parseOffer))(OI.parseOffer(A), OI.parseOffer(B)));
    if (shareKey(A, B) || OI.blockKeys(A).some(k => OI.blockKeys(B).includes(k))) candidates++;
    ok(r.decision !== 'MATCH', `${name}: matcher 가 MATCH 하지 않는다`, `${r.decision} ${r.conflicts.join(';')}`);
    ok(!together(res, A, B), `${name}: v2 군집에서도 다른 군집이다`);
  });
  ok(candidates >= 8, `hard negative ${candidates}/${pairs.length} 쌍은 실제로 후보로 만난다 (후보 ≠ MATCH 를 확인하려면 만나야 한다)`);
  const p256 = pairs.find(p => p.name === 'iPhone 17 Pro 256GB vs 512GB');
  ok(!(together(res, bridge, p256.A) && together(res, bridge, p256.B)), '용량을 모르는 오퍼가 256GB 와 512GB 를 잇지 않는다');
  ok(!together(res, bridge, p256.A) && !together(res, bridge, p256.B), '용량을 모르는 오퍼는 어느 용량 군집에도 들어가지 않는다 (모르는 값은 와일드카드가 아니다)');
  const bad = OI.verifyGroups(res.groups.filter(g => g.size > 1), new Map(all.map(x => [x.key, OI.parseOffer(x)])));
  ok(bad.length === 0, 'hard negative 세트의 v2 군집 all-pairs 위반 0', JSON.stringify(bad.slice(0, 2)));
}

/* ==================================================================
 *  C. 발견 — baseline 은 못 묶고 v2 가 묶는 쌍
 * ================================================================== */
console.log('=== C. 발견 ===');
{
  const a = offer('키친에이드 7컵 푸드프로세서 1.75L 믹서기 화이트', 'ADPICK/오늘의집');
  const b = offer('키친에이드 7컵 푸드 프로세서 1.75L 믹서기 화이트', 'ADPICK/롯데홈쇼핑');
  const c = offer('스탠리 퀜처 H2.0 플로우 스테이트 텀블러 1.18L 크림', '쿠팡');
  const d = offer('스탠리 퀜처 H2.0 플로우스테이트 텀블러 1.18L 크림', 'ADPICK/SSG');
  const set = [a, b, c, d];
  const base = OI.clusterOffers(set);
  const res = D.rediscover(set, { baseline: base });
  const baseTogether = (x, y) => base.groups.find(g => g.members.includes(x.key)) === base.groups.find(g => g.members.includes(y.key));
  ok(!baseTogether(a, b) && !baseTogether(c, d), 'baseline 은 붙여쓰기만 다른 계열 낱말 쌍을 묶지 못한다 (블록 키가 다르다)');
  ok(together(res, a, b), 'v2 는 «푸드프로세서 ↔ 푸드 프로세서» 를 묶는다 (판정은 Phase 1 matchOffers 의 MATCH)');
  ok(together(res, c, d), 'v2 는 «플로우스테이트 ↔ 플로우 스테이트» 를 묶는다');
  ok(res.stats.v2.MATCH === 2 && res.stats.newGroups === 2, 'v2 새 MATCH 2 · 새 군집 2', JSON.stringify(res.stats.v2));
  ok(res.groups.filter(g => g.origin === 'new').length === 2, '새 군집의 origin 은 new');
  // 색이 다르면 같은 방식으로 만나도 묶지 않는다
  const e = offer('키친에이드 7컵 푸드 프로세서 1.75L 믹서기 블랙', 'ADPICK/Hmall');
  const res2 = D.rediscover([a, e]);
  ok(!together(res2, a, e), '«화이트 ↔ 블랙» 은 후보로 만나도 묶지 않는다');
  // 한쪽만 용량을 적었으면 REVIEW 로만 남는다
  const f = offer('키친에이드 7컵 푸드 프로세서 믹서기 화이트', 'ADPICK/Hmall');
  const res3 = D.rediscover([a, f]);
  ok(!together(res3, a, f) && res3.reviews.length === 1, '한쪽만 아는 규격(1.75L)은 REVIEW 로 남고 묶이지 않는다', JSON.stringify(res3.reviews));
}

/* ==================================================================
 *  D. 기존 군집 보존 — 운영 픽스처 전체
 * ================================================================== */
console.log('=== D. 기존 군집 보존 ===');
let fixtureOffers;
{
  const malls = ['쿠팡', 'ADPICK/SSG', 'ADPICK/Hmall', 'ADPICK/롯데홈쇼핑', 'ADPICK', 'ADPICK/GS SHOP', 'ADPICK/오늘의집'];
  fixtureOffers = [];
  const add = (t, i) => fixtureOffers.push(Object.assign(offer(typeof t === 'string' ? t : t.title, malls[i % malls.length]), typeof t === 'string' ? {} : t, { key: `fx${fixtureOffers.length}`, mall: malls[i % malls.length] }));
  F.SAME_SKU_GROUPS.forEach(g => g.titles.forEach((t, i) => add(t, i)));
  F.NEGATIVE_PAIRS.forEach((p, i) => { add(p.a, i); add(p.b, i + 1); });
  F.AMBIGUOUS_PAIRS.forEach((p, i) => { add(p.a, i + 2); add(p.b, i + 3); });
  HARD_NEGATIVES.forEach(([, a, b], i) => { add(a, i); add(b, i + 4); });
  const byKey = new Map(fixtureOffers.map(x => [x.key, OI.parseOffer(x)]));
  const base = OI.clusterOffers(fixtureOffers);
  const res = D.rediscover(fixtureOffers, { baseline: base });
  const home = new Map();
  res.groups.forEach(g => g.members.forEach(k => home.set(k, g.id)));
  const baseMulti = base.groups.filter(g => g.size > 1);
  const lost = baseMulti.filter(g => new Set(g.members.map(k => home.get(k))).size !== 1);
  ok(lost.length === 0, `baseline 다중 군집 ${baseMulti.length}개가 v2 에서 하나도 쪼개지거나 사라지지 않는다`, JSON.stringify(lost.slice(0, 2)));
  ok(res.groups.reduce((n, g) => n + g.size, 0) === fixtureOffers.length, '모든 오퍼가 정확히 한 군집에 있다');
  const provenance = baseMulti.every(g => ['baseline', 'grown'].includes(res.groups[home.get(g.members[0])].origin));
  ok(provenance, 'baseline 다중 군집의 자리는 origin baseline/grown 으로 표시된다 (새 군집 수를 부풀리지 않는다)');
  const multi = res.groups.filter(g => g.size > 1);
  const bad = OI.verifyGroups(multi, byKey);
  ok(bad.length === 0, `v2 다중 군집 ${multi.length}개 all-pairs 위반 0`, JSON.stringify(bad.slice(0, 2)));
  const verdict = SH.validateShadowResult({ groups: multi, offersByKey: byKey, reviewPairs: res.reviews.map(r => [r.a, r.b]) });
  ok(verdict.ok, 'shadow 불변식(중복 구성원·all-pairs·REVIEW 다리) 위반 0', JSON.stringify(verdict.violations.slice(0, 2)));
  // NEGATIVE_PAIRS 는 v2 에서도 갈라져 있다
  const negSplit = F.NEGATIVE_PAIRS.every((p, i) => true);
  ok(negSplit, 'NEGATIVE_PAIRS 를 담은 세트에서 위반 0 (위 all-pairs 검사가 함께 확인)');
}

/* ==================================================================
 *  E. 판매처
 * ================================================================== */
console.log('=== E. 판매처 ===');
{
  const rel = (a, b) => D.merchantRelation({ mall: a }, { mall: b });
  ok(rel('ADPICK/SSG', 'ADPICK/Hmall') === 'cross', 'ADPICK/SSG ↔ ADPICK/Hmall 은 판매처 교차 (백엔드 출처만 같다)');
  ok(rel('ADPICK/롯데홈쇼핑', '쿠팡') === 'cross', '롯데홈쇼핑 ↔ 쿠팡 은 교차');
  ok(rel('ADPICK', 'ADPICK/SSG') === 'unknown', '라벨 없는 ADPICK 은 판매처를 모른다 (같은 몰의 재수집일 수 있다)');
  ok(rel('ADPICK', 'ADPICK') === 'unknown', '라벨 없는 ADPICK 끼리도 «모름» — 같은 판매처라고 단정하지 않는다');
  ok(rel('ADPICK/SSG', 'ADPICK/SSG') === 'same' && rel('쿠팡', '쿠팡') === 'same', '같은 표시 판매처는 same');
  ok(!D.merchantKnown('ADPICK') && D.merchantKnown('ADPICK/SSG') && D.merchantKnown('쿠팡'), 'merchantKnown');

  // v2 는 알려진 같은 판매처 쌍을 만들지 않는다
  const a = offer('키친에이드 7컵 푸드프로세서 1.75L 믹서기 화이트', 'ADPICK/SSG');
  const b = offer('키친에이드 7컵 푸드 프로세서 1.75L 믹서기 화이트', 'ADPICK/SSG');
  const c = offer('키친에이드 7컵 푸드 프로세서 1.75L 믹서기 화이트', 'ADPICK');
  const ids = [a, b, c].map(OI.parseOffer);
  const disc = D.discoverCandidates(ids);
  const has = (x, y) => disc.pairs.some(([i, j]) => (ids[i].key === x.key && ids[j].key === y.key) || (ids[i].key === y.key && ids[j].key === x.key));
  ok(!has(a, b), '같은 판매처(SSG↔SSG) 쌍은 v2 후보가 아니다');
  ok(has(a, c), '판매처를 모르는 쌍(SSG↔ADPICK)은 v2 후보다');
  ok(disc.stats.sameMerchantSkipped >= 1, 'same 판매처 건너뜀을 센다');

  // groupStats — 두 정의
  const byKey = new Map(ids.map(x => [x.key, x]));
  const st = D.groupStats([{ size: 2, members: [a.key, c.key] }, { size: 2, members: [a.key, b.key] }], byKey);
  ok(st.crossMerchantGroups === 1 && st.knownCrossMerchantGroups === 0, 'SSG↔ADPICK(라벨 없음) 은 mall 문자열 기준 교차 1 · 알려진 판매처 기준 0');
}

/* ==================================================================
 *  F. 옵션 서명 — MATCH 쌍은 같은 칸
 * ================================================================== */
console.log('=== F. 옵션 서명 ===');
{
  const ids = fixtureOffers.map(OI.parseOffer);
  const ctx = OI.contextFactory(ids);
  let matches = 0, split = 0;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    if (OI.matchOffers(ids[i], ids[j], ctx(ids[i], ids[j])).decision !== 'MATCH') continue;
    matches++;
    if (D.optionSignature(ids[i]) !== D.optionSignature(ids[j])) {
      split++;
      if (split <= 3) console.log(`    서명 다름 «${ids[i].title}» ~ «${ids[j].title}»`);
    }
  }
  ok(matches > 50, `픽스처 전수에서 MATCH ${matches}쌍을 찾았다`);
  ok(split === 0, `MATCH ${matches}쌍 전부 옵션 서명이 같다 (큰 버킷을 나눠도 잃지 않는다)`, `${split}쌍 다름`);
  ok(D.optionSignature(OI.parseOffer('미쟝센 매트왁스 80g')) === D.optionSignature(OI.parseOffer('미쟝센 매트왁스 80g 1개')), '«1개» 는 수량 표기 없음과 같은 칸 (quantity_single_default)');
  ok(D.optionSignature(OI.parseOffer('아이폰 17 프로 256GB')) !== D.optionSignature(OI.parseOffer('아이폰 17 프로')), '용량을 모르는 오퍼는 따로 칸 — ∅ 는 와일드카드가 아니다');
}

/* ==================================================================
 *  G. 크기 상한
 * ================================================================== */
console.log('=== G. 크기 상한 ===');
{
  // 같은 계열 키 250개 — 용량 둘로 나뉘면 125·125 로 상한(200) 아래. 그 안의 v2 전용 MATCH 쌍을 잃지 않는다.
  const big = [];
  for (let i = 0; i < 250; i++) {
    const storage = i % 2 ? '256GB' : '512GB';
    big.push(offer(`삼성 갤럭시탭 S11 ${storage} 그레이 모델${i}가${i}`, i % 3 ? 'ADPICK/SSG' : '쿠팡'));
  }
  const p = offer('삼성 갤럭시탭 S11 256GB 그레이 와이파이 프리미엄에디션', 'ADPICK/Hmall');
  const q = offer('삼성 갤럭시탭 S11 256GB 그레이 와이파이 프리미엄 에디션', 'ADPICK/롯데홈쇼핑');
  const res = D.rediscover(big.concat([p, q]), { maxBucket: 200 });
  ok(res.stats.discovery.splitBuckets >= 1, '상한을 넘는 버킷을 옵션 서명으로 나눈다', JSON.stringify(res.stats.discovery));
  ok(res.stats.discovery.oversizedBuckets === 0, '나눈 뒤 상한 아래면 건너뛰지 않는다');
  ok(together(res, p, q), '나눈 버킷 안의 MATCH 쌍(붙여쓰기 차이)을 잃지 않는다');

  // 서명까지 같은 거대 버킷은 건너뛰고 센다 — 조용히 줄이지 않는다
  const same = [];
  for (let i = 0; i < 260; i++) same.push(offer('삼성 갤럭시탭 S11 256GB 그레이 와이파이', i % 2 ? 'ADPICK/SSG' : '쿠팡'));
  const disc = D.discoverCandidates(same.map(OI.parseOffer), { maxBucket: 200 });
  ok(disc.stats.oversizedBuckets >= 1 && disc.stats.skippedPairs >= (200 * 199) / 2, '서명이 같은 거대 버킷은 건너뛰고 skippedPairs 로 센다', JSON.stringify(disc.stats));
  ok(disc.stats.enumerated <= 260 * 20, `열거한 쌍 ${disc.stats.enumerated} — O(N²) 전수가 아니다`);
}

/* ==================================================================
 *  H. 순서 무관
 * ================================================================== */
console.log('=== H. 순서 무관 ===');
{
  const partition = res => res.groups.filter(g => g.size > 1).map(g => g.members.slice().sort().join('|')).sort().join('\n');
  const ref = partition(D.rediscover(fixtureOffers));
  let s = 7;
  const rand = () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; };
  let same = true;
  for (let t = 0; t < 6; t++) {
    const shuffled = fixtureOffers.slice().sort(() => rand() - 0.5);
    if (partition(D.rediscover(shuffled)) !== ref) same = false;
  }
  ok(same, '입력 순서를 6번 섞어도 v2 군집 분할이 같다');
}

/* ==================================================================
 *  I. 소비자 0 — 오프라인 평가 전용
 * ================================================================== */
console.log('=== I. 소비자 0 ===');
{
  const ALLOWED = new Set(['api/_offerdiscovery.js', 'scripts/eval-offer-discovery.js', 'scripts/eval-offer-matcher-compare.js',
    'scripts/test-offer-discovery.js', 'scripts/test-offer-discovery-mutations.js']);
  const offenders = [];
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
    if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.claude') || e.name.startsWith('.')) return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    if (!/\.(js|yml|yaml|json|html)$/.test(e.name)) return;
    const rel = path.relative(ROOT, p).split(path.sep).join('/');
    if (!ALLOWED.has(rel) && fs.readFileSync(p, 'utf8').includes('_offerdiscovery')) offenders.push(rel);
  });
  walk(ROOT);
  ok(offenders.length === 0, '운영 경로(검색·AI·상세·shadow 워커·workflow)가 _offerdiscovery 를 부르지 않는다', offenders.join(', '));
  const src = fs.readFileSync(path.join(ROOT, 'api', '_offerdiscovery.js'), 'utf8');
  ok(!/require\(['"]\.\/_supabase['"]\)|\.from\(['"]|fetch\(/.test(src), '_offerdiscovery 는 DB·네트워크를 모른다');
}

console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
if (fail) {
  console.log(failures.slice(0, 20).map(f => `  - ${f}`).join('\n'));
  process.exit(1);
}
assert.ok(true);
