#!/usr/bin/env node
'use strict';
/*
 * SEOSA HOT — 같은 상품 묶기 · 현재 최저가 · 설명 가능한 신호.
 *
 * ★ 외부 호출 0회. Supabase·쿠팡·ADPICK·OpenRouter 를 한 번도 부르지 않는다.
 *
 * ★ 여기서 지키는 것은 하나다 — **틀린 병합을 하지 않는다.**
 *   중복이 하나 남는 것보다 서로 다른 상품이 한 카드가 되는 쪽이 훨씬 나쁘다.
 *   그래서 이 파일의 절반은 "합쳐지면 안 되는 것들"이다.
 *
 * ★ 기대값을 통과시키려고 고치지 않는다. 판정이 바뀌어야 한다면 엔진을 고친다.
 *   아래 오병합 사례는 전부 2026-09-07 운영 데이터 read-only 스캔에서
 *   실제로 나온 것이다 (지어낸 예가 아니다).
 */

const HG = require('../api/_hotgroup');
const HD = require('../api/_hotdeal');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? `  — ${detail}` : ''}`); }
}
function eq(actual, expected, name) {
  ok(actual === expected, name, actual === expected ? String(actual) : `기대 ${expected} / 실제 ${actual}`);
}

/** 병합 판정 한 쌍. df 는 그 두 제목만으로 계산한다(작은 카탈로그 가정). */
function pair(a, b, extra) {
  const A = Object.assign({ title: a, price: 10000, productId: 'pA', vendorItemId: '' }, (extra || {}).a);
  const B = Object.assign({ title: b, price: 10000, productId: 'pB', vendorItemId: '' }, (extra || {}).b);
  const df = HG.modelCodeFrequency((extra && extra.catalog) || [a, b]);
  return HG.canMerge(A, B, df);
}
const merges = (a, b, extra) => pair(a, b, extra).merge;

console.log('=== SEOSA HOT 묶기 · 최저가 · 신호 (외부 호출 0회) ===\n');

/* ─────────────────────────────────────────────────────────────
   [1] 스펙 숫자 — _identity 가 보지 못하는 «단위 없는 숫자»
   ───────────────────────────────────────────────────────────── */
console.log('[1] 스펙 숫자');
eq([...HG.specNumbers('LG전자 2025 그램 16 코어Ultra5')].sort().join(','), '16,2025', '맨숫자만 뽑는다');
eq(HG.specNumbers('갤럭시 버즈3 프로').size, 0, '토큰에 붙은 숫자는 맨숫자가 아니다');
eq([...HG.specNumbers('닌텐도 스위치 12')].join(','), '12', '띄어 쓴 세대 숫자');
ok(!HG.specNumbers('vid 95134972901').has('95134972901'), '5자리 이상 식별자는 스펙이 아니다');

/* ─────────────────────────────────────────────────────────────
   [2] 대칭 유사도 — min 기준 겹침의 함정
   ───────────────────────────────────────────────────────────── */
console.log('\n[2] 대칭 유사도');
const shortIn = ['브리츠 BZ-AX1 스피커', '브리츠 BZ-AX1 스피커 완전 방수 미니 휴대용 오렌지 이마트몰'];
ok(HG.jaccard(shortIn[0], shortIn[1]) < 0.8, '짧은 제목이 통째로 들어가도 1.0 이 아니다',
  String(Math.round(HG.jaccard(shortIn[0], shortIn[1]) * 100) + '%'));
eq(HG.jaccard('가 나 다', '다 나 가'), 1, '어순만 다르면 1.0');
eq(HG.jaccard('', '무엇'), 0, '빈 제목은 0');

/* ─────────────────────────────────────────────────────────────
   [3] 모델코드 변별력 — WIN11 은 식별자가 아니다
   ───────────────────────────────────────────────────────────── */
console.log('\n[3] 모델코드 변별력');
const bigCatalog = [];
for (let i = 0; i < 10; i++) bigCatalog.push(`제조사${i} 노트북 ${i}호 WIN11 Home 모델${i}`);
const df = HG.modelCodeFrequency(bigCatalog);
ok((df.get('WIN11') || 0) > HG.MODEL_CODE_MAX_DF, 'WIN11 은 여러 상품에 붙어 df 가 크다', String(df.get('WIN11')));
eq(HG.discriminativeCodes('제조사1 노트북 1호 WIN11 Home 모델1', df).indexOf('WIN11'), -1,
  'df 가 큰 코드는 변별력 목록에서 빠진다');
// 같은 제목이 여러 번 들어와도 df 는 1 이어야 한다 (중복 수집이 변별력을 깎으면 안 된다)
eq(HG.modelCodeFrequency(['소니 WF-1000XM5 이어폰', '소니 WF-1000XM5 이어폰',
  '소니 WF-1000XM5 이어폰']).get('WF-1000XM5'), 1, '같은 상품 중복은 한 번으로 센다');

/* ─────────────────────────────────────────────────────────────
   [4] 합쳐야 하는 것
   ───────────────────────────────────────────────────────────── */
console.log('\n[4] 합쳐야 하는 것');
ok(merges('빙그레 붕어싸만코 저당 아이스크림 24개', '빙그레 저당 붕어싸만코 24개 /아이스크림'),
  '어순·구분자만 다른 같은 상품');
ok(merges('필립스 데일리 컬렉션 토스터기 HD2582/00', '필립스 데일리 컬렉션 HD2582/00 토스터기'),
  '모델코드가 같고 낱말이 같다');
ok(merges('닌텐도 스위치 리듬천국 미라클 스타즈', '닌텐도 스위치 리듬천국 미라클 스타즈'),
  '완전히 같은 제목 (다른 product_id 로 재등록)');
// 몰이 달라도 같은 물건이면 합친다 — TASK 4 의 «현재 최저가 몰» 이 여기 걸려 있다
ok(merges('안녕, 피터팬 - 중증자폐인 아들을 두고 떠나는 시한부 아버지의 마지막 소원',
  '안녕, 피터팬 : 중증자폐인 아들을 두고 떠나는 시한부 아버지의 마지막 소원'),
  '구두점만 다른 같은 책 (ADPICK ↔ 쿠팡)');
// vendorItemId 가 같으면 같은 오퍼다. 판매자가 제목을 고쳐도 마찬가지.
ok(merges('로지텍 무소음 무선 마우스', '로지텍 무소음 무선 마우스 (신형)',
  { a: { vendorItemId: '777' }, b: { vendorItemId: '777' } }),
  'vendorItemId 가 같으면 제목이 달라도 같은 오퍼');

/* ─────────────────────────────────────────────────────────────
   [5] 절대 합치면 안 되는 것 — 전부 실측 사례
   ───────────────────────────────────────────────────────────── */
console.log('\n[5] 절대 합치면 안 되는 것');

// ① 스펙 숫자 충돌. _identity 만으로는 tier A 가 나온다(WIN11 을 모델코드로 본다).
const gram16 = 'LG전자 2025 그램 16 코어Ultra5 스노우 화이트 256GB 16GB WIN11 Home';
const gram17 = 'LG전자 2025 그램 17 코어Ultra5 스노우 화이트 256GB 16GB WIN11 Home';
eq(require('../api/_identity').judgeSameProduct(gram16, gram17).tier, 'A',
  '(전제) _identity 는 이 둘을 tier A 로 본다');
ok(!merges(gram16, gram17, { a: { price: 2200000 }, b: { price: 2419000 } }),
  '그램 16 ↔ 그램 17 은 합치지 않는다');

// ② 부속끼리. min 기준 겹침이면 통과했다.
ok(!merges('LG 그램 AI 2026 14Z95U 14ZD95U 무광 팜레스트 터치패드 필름 2매',
  'LG 그램 AI 2026 14Z95U 14ZD95U 무광 하판보호필름 2매'),
  '같은 기기의 서로 다른 부속');

// ③ 옵션(vendorItemId)이 다르면 제목이 같아도 안 된다.
ok(!merges('HP 2025 노트북 15 N-시리즈', 'HP 2025 노트북 15 N-시리즈',
  { a: { vendorItemId: '951431', price: 402300 }, b: { vendorItemId: '943231', price: 521250 } }),
  '옵션 식별자가 다르면 제목이 같아도 안 합친다');
eq(pair('HP 2025 노트북 15', 'HP 2025 노트북 15',
  { a: { vendorItemId: '1' }, b: { vendorItemId: '2' } }).reason,
  '옵션(vendorItemId)이 다르다', '이유를 남긴다');

// ④ 값 차이가 터무니없다 — 본체 자리에 부속·낱개가 섞이는 마지막 방어
ok(!merges('필립스 데일리 컬렉션 토스터기 HD2582/00', '필립스 데일리 컬렉션 HD2582/00 토스터기',
  { a: { price: 41830 }, b: { price: 4900 } }),
  '값이 1/8 이면 같은 물건으로 보지 않는다');

// ⑤ 세대·연식·묶음 — _identity 의 방어가 그대로 살아 있는가
ok(!merges('에이수스 2025 비보북 S 16', '에이수스 2026 비보북 S 16'), '연식이 다르다');
ok(!merges('아픔이 길이 되려면', '지혜문학 + 아픔이 길이 되려면 세트'), '단품 ↔ 묶음');
ok(!merges('Charlie Puth Nine Track Mind LP', 'Charlie Puth Nine Track Mind CD'), '매체가 다르다');
ok(!merges('쿠쿠 전기압력밥솥 CRP-DHAS069FWM', '쿠쿠 전기압력밥솥 CRP-DHAS069FW'), '모델코드 한 글자 차이');
ok(!merges('삼성 갤럭시 버즈3 프로', '삼성 갤럭시 버즈3'), '프로 ↔ 일반');
ok(!merges('아이폰 17', '아이폰 17 케이스'), '본체 ↔ 케이스');

// ⑥ 모델코드도 완전일치 제목도 없으면 붙이지 않는다
ok(!merges('무명 브랜드 튼튼한 방수 백팩 대용량', '무명 브랜드 튼튼한 방수 백팩 초대용량'),
  '근거가 될 코드가 없으면 합치지 않는다');

/* ─────────────────────────────────────────────────────────────
   [6] 군집 — 대표와만 견준다 (사슬 병합 금지)
   ───────────────────────────────────────────────────────────── */
console.log('\n[6] 군집');
const off = (key, title, price, mall, extra) => Object.assign({
  key, title, price, mall, url: 'https://x/' + key, productId: 'p' + key,
  vendorItemId: '', status: 'GOOD_DEAL', hotScore: 50, deal: true, checkedAt: '2026-09-07T00:00:00Z'
}, extra || {});

{
  const g = HG.groupOffers([
    off('a', '필립스 데일리 컬렉션 토스터기 HD2582/00', 41830, 'ADPICK'),
    off('b', '필립스 데일리 컬렉션 HD2582/00 토스터기', 39000, '쿠팡'),
    off('c', '소니 WF-1000XM5 무선 이어폰', 289000, '쿠팡')
  ]);
  eq(g.groups.length, 2, '같은 상품 둘은 한 군집, 다른 상품은 따로');
  const t = g.byKey.get('a');
  eq(t.size, 2, '군집 크기');
  eq(t.mallCount, 2, '몰 개수');
  eq(t.lowestPrice, 39000, '현재 최저가');
  eq(t.lowestMall, '쿠팡', '최저가 몰');
  eq(t.primaryKey, 'b', '대표는 가장 싼 «딜» 오퍼');
  eq(t.offers.length, 2, '오퍼 목록');
  eq(t.offers[0].price, 39000, '오퍼는 싼 순');
  eq(g.byKey.get('b').groupKey, g.byKey.get('a').groupKey, '같은 군집이면 group_key 가 같다');
  eq(g.byKey.get('c').size, 1, '혼자인 상품은 크기 1');
}

{
  // 딜이 아닌 오퍼도 «최저가» 후보다 — 없으면 더 비싼 곳을 권하게 된다.
  const g = HG.groupOffers([
    off('deal', '엑토 무선이어폰 BTE-38', 47100, 'ADPICK'),
    off('norm', '엑토 무선이어폰 BTE-38', 35900, '쿠팡', { status: 'NORMAL', hotScore: 0, deal: false })
  ]);
  const t = g.byKey.get('deal');
  eq(t.lowestPrice, 35900, '딜이 아니어도 최저가 후보다');
  eq(t.primaryKey, 'deal', '카드는 «딜인» 오퍼가 대표');
}

{
  // 사슬 병합 금지: A~B 는 되고 B~C 는 돼도 A~C 가 아니면 한 덩어리가 아니다.
  const g = HG.groupOffers([
    off('x', '브리츠 BZ-AX1 스피커', 64900, 'ADPICK'),
    off('y', '브리츠 BZ-AX1 스피커', 65900, 'ADPICK'),
    off('z', '브리츠 BZ-AX2 스피커', 69900, 'ADPICK')
  ]);
  eq(g.byKey.get('x').size, 2, '같은 모델만 묶인다');
  eq(g.byKey.get('z').size, 1, '다른 모델은 사슬로 끌려오지 않는다');
}

{
  // 결정론 — 입력 순서가 달라도 같은 군집이 나와야 한다
  const list = [
    off('a', '필립스 데일리 컬렉션 토스터기 HD2582/00', 41830, 'ADPICK'),
    off('b', '필립스 데일리 컬렉션 HD2582/00 토스터기', 39000, '쿠팡'),
    off('c', '소니 WF-1000XM5 무선 이어폰', 289000, '쿠팡')
  ];
  const one = HG.groupOffers(list);
  const two = HG.groupOffers(list.slice().reverse());
  eq(two.byKey.get('a').groupKey, one.byKey.get('a').groupKey, '순서가 바뀌어도 같은 대표');
  eq(two.byKey.get('a').lowestPrice, one.byKey.get('a').lowestPrice, '순서가 바뀌어도 같은 최저가');
}

{
  // affiliate URL 은 오퍼마다 그대로 살아 있어야 한다 (구매 경로를 잃으면 안 된다)
  const g = HG.groupOffers([
    off('a', '닌텐도 스위치 리듬천국 미라클 스타즈', 64800, 'ADPICK'),
    off('b', '닌텐도 스위치 리듬천국 미라클 스타즈', 62900, '쿠팡')
  ]);
  const urls = g.byKey.get('a').offers.map(o => o.url).sort();
  eq(urls.join(','), 'https://x/a,https://x/b', '오퍼별 구매 링크가 유지된다');
}

{
  // 군집이 비정상적으로 커지지 않는다
  const many = [];
  for (let i = 0; i < HG.MAX_GROUP + 5; i++) many.push(off('k' + i, '동일 상품 이름 XYZ-100', 1000 + i, 'ADPICK'));
  const g = HG.groupOffers(many);
  ok(g.groups.every(x => x.size <= HG.MAX_GROUP), `군집 상한 ${HG.MAX_GROUP} 을 넘지 않는다`,
    String(Math.max.apply(null, g.groups.map(x => x.size))));
}

eq(HG.groupOffers([]).groups.length, 0, '빈 입력은 빈 결과');
eq(HG.groupOffers(null).groups.length, 0, 'null 입력도 죽지 않는다');

/* ─────────────────────────────────────────────────────────────
   [7] 목록 다양성 — 버리지 않고 미룬다
   ───────────────────────────────────────────────────────────── */
console.log('\n[7] 목록 다양성');
{
  const items = [
    { id: 1, f: 'lg' }, { id: 2, f: 'lg' }, { id: 3, f: 'lg' }, { id: 4, f: 'lg' },
    { id: 5, f: 'sony' }, { id: 6, f: 'sony' }
  ];
  const out = HG.diversify(items, it => it.f, 2);
  eq(out.length, items.length, '항목을 버리지 않는다');
  eq(out.map(x => x.id).slice().sort((a, b) => a - b).join(','), '1,2,3,4,5,6', '같은 항목들이다');
  let worst = 0, run = 0, last = null;
  out.forEach(x => { if (x.f === last) run++; else { last = x.f; run = 1; } if (run > worst) worst = run; });
  ok(worst <= 2, '같은 계열이 3개 연달아 나오지 않는다', `최대 연속 ${worst}`);
  // 미룰 곳이 없으면 어쩔 수 없이 이어 붙인다 — 그래도 사라지지는 않는다
  const only = HG.diversify([{ id: 1, f: 'a' }, { id: 2, f: 'a' }, { id: 3, f: 'a' }], it => it.f, 2);
  eq(only.length, 3, '한 계열뿐이어도 전부 남는다');
}
{
  const fam = HG.familyKeyOf('소니 WF-1000XM5 무선 이어폰');
  ok(fam.indexOf('소니') === 0, '계열 키는 브랜드로 시작한다', fam);
  ok(HG.familyKeyOf('소니 WF-1000XM5 무선 이어폰') === HG.familyKeyOf('소니 WF-1000XM5 이어폰 화이트'),
    '같은 모델의 변형은 같은 계열');
  ok(HG.familyKeyOf('소니 WF-1000XM5 이어폰') !== HG.familyKeyOf('소니 WH-1000XM6 헤드폰'),
    '다른 모델은 다른 계열');
}

/* ─────────────────────────────────────────────────────────────
   [8] 설명 가능한 신호 — 없는 값을 만들지 않는다
   ───────────────────────────────────────────────────────────── */
console.log('\n[8] 설명 가능한 신호');
const TODAY = '2026-09-07';
const day = n => new Date(Date.parse(TODAY + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
const pts = arr => arr.map((price, i) => ({ date: day(arr.length - 1 - i), price }));

{
  const b = HD.baselineFrom(pts([30000, 30000, 30000, 28000, 24000]), 24000, TODAY);
  const s = HD.signalsOf(b);
  eq(s.currentPrice, 24000, '현재가');
  eq(s.referenceKind, 'median30', '기준은 최근 30일 중앙값');
  eq(s.referencePrice, 30000, '기준 가격');
  eq(s.priceDropAmount, 6000, '하락 금액');
  eq(s.priceDropPercent, 20, '하락률');
  eq(s.previousPrice, 28000, '직전 관측');
  eq(s.previousDropAmount, 4000, '직전 대비 하락 금액');
  eq(s.historyCount, 5, '이력 개수');
  eq(s.freshness, 'fresh', '오늘 관측 → fresh');
  eq(s.currentObserved, true, '오늘 그 값을 관측했다');
}
{
  // 값이 올랐다 — 하락 신호를 만들어 내면 안 된다
  const b = HD.baselineFrom(pts([20000, 20000, 20000, 22000, 26000]), 26000, TODAY);
  const s = HD.signalsOf(b);
  eq(s.priceDropAmount, null, '오르면 하락 금액은 null');
  ok(s.priceDropPercent < 0, '하락률은 음수로 사실대로', String(s.priceDropPercent));
  eq(s.nearHistoricalLow, false, '최저가가 아니다');
}
{
  // 이력이 없다 — 아무 숫자도 지어내지 않는다
  const s = HD.signalsOf(HD.baselineFrom([], 10000, TODAY));
  eq(s.referenceKind, null, '기준이 없으면 null');
  eq(s.priceDropPercent, null, '하락률 없음');
  eq(s.historyCount, 0, '이력 0');
  eq(s.observedLow, null, '관측 최저 없음');
  eq(s.pricePercentile, null, '순위 없음');
}
{
  // 이력 1개 — 그 한 점을 «중앙값» 이라 부르며 "20% 저렴"이라고 말하지 않는다.
  const b = HD.baselineFrom([{ date: day(2), price: 50000 }], 40000, TODAY);
  const s = HD.signalsOf(b);
  eq(s.referenceKind, 'previous', '한 점은 중앙값이 아니라 «직전 확인» 이다');
  eq(s.historyCount, 1, '이력 1');
  eq(s.pricePercentile, null, '한 점으로 순위를 말하지 않는다');
}
{
  /*
   * 이력이 오늘 한 점뿐 — 비교 대상이 아예 없다.
   * 오늘 값을 «직전 값» 이라 부르며 자기 자신과 비교하면 어떤 하락도
   * 만들어 낼 수 있다. 기준이 없으면 없다고 말한다.
   */
  const s = HD.signalsOf(HD.baselineFrom([{ date: TODAY, price: 50000 }], 40000, TODAY));
  eq(s.referenceKind, null, '오늘 한 점뿐이면 기준이 없다');
  eq(s.priceDropPercent, null, '자기 자신과 비교하지 않는다');
  eq(s.previousPrice, null, '직전 관측이 없다');
}
{
  // 값이 한 번도 움직이지 않은 계열 — "최저가"는 착시다
  const b = HD.baselineFrom(pts([10000, 10000, 10000, 10000, 10000]), 10000, TODAY);
  const s = HD.signalsOf(b);
  eq(s.nearHistoricalLow, false, '고정가에 최저가 배지를 달지 않는다');
  eq(s.pricePercentile, null, '고정가에 순위를 매기지 않는다');
  eq(s.priceDropPercent, 0, '하락률 0');
}
{
  // 오래된 이력
  const old = [{ date: '2026-08-01', price: 30000 }, { date: '2026-08-03', price: 30000 },
    { date: '2026-08-05', price: 30000 }];
  const s = HD.signalsOf(HD.baselineFrom(old, 24000, TODAY));
  eq(s.freshness, 'stale', '오래되면 stale');
  ok(s.staleDays > HD.MAX_STALE_DAYS, '며칠 지났는지 숫자로도 준다', String(s.staleDays));
  eq(s.currentObserved, false, '오래된 확인은 «지금 값 확인» 이 아니다');
}
{
  const b = HD.baselineFrom(pts([20000, 18000, 20000, 18000, 18000]), 18000, TODAY);
  const s = HD.signalsOf(b);
  eq(s.nearHistoricalLow, true, '다른 날에도 본 최저가면 최저가 근접');
  eq(s.observedLow, 18000, '관측 최저');
  eq(s.observedHigh, 20000, '관측 최고');
}
eq(HD.freshnessOf(0), 'fresh', 'freshness 경계 0');
eq(HD.freshnessOf(1), 'fresh', 'freshness 경계 1');
eq(HD.freshnessOf(2), 'recent', 'freshness 경계 2');
eq(HD.freshnessOf(HD.CONFIRM_MAX_STALE_DAYS + 1), 'aging', 'freshness 경계 aging');
eq(HD.freshnessOf(HD.MAX_STALE_DAYS + 1), 'stale', 'freshness 경계 stale');

{
  // evaluate() 가 signals 를 함께 돌려준다 — 프론트 계약의 뿌리
  const v = HD.evaluate({
    candidate: { title: '삼성전자 갤럭시 버즈3 프로 SM-R630N 실버', salePrice: 24000 },
    storedTitle: '삼성전자 갤럭시 버즈3 프로 SM-R630N 실버',
    points: pts([30000, 30000, 30000, 28000, 24000]), today: TODAY
  });
  ok(v.signals && typeof v.signals === 'object', 'evaluate 가 signals 를 준다');
  eq(v.signals.priceDropPercent, 20, 'signals 가 baseline 과 같은 값을 말한다');
  // 문장·점수·신호가 갈리면 안 된다
  const saysLow = v.reasons.some(r => r.kind === 'low');
  eq(saysLow, v.signals.nearHistoricalLow, '근거 문장과 신호가 일치한다');
}

/* ─────────────────────────────────────────────────────────────
   [9] 수집기 조립 — 군집 결과를 행에 붙이기
   ───────────────────────────────────────────────────────────── */
console.log('\n[9] 수집기 조립');
{
  const C = require('./collect-hotdeals.js');
  eq(C.offerKeyOf('internal-history', 'p1|v1', '쿠팡'), 'internal-history|p1|v1|쿠팡', '오퍼 키 모양');
  eq(C.CONFIDENCE_RANK.HIGH, 3, 'HIGH 3');
  eq(C.CONFIDENCE_RANK.INSUFFICIENT, 0, 'INSUFFICIENT 0');
  ok(C.CONFIDENCE_RANK.HIGH > C.CONFIDENCE_RANK.MEDIUM
    && C.CONFIDENCE_RANK.MEDIUM > C.CONFIDENCE_RANK.LOW
    && C.CONFIDENCE_RANK.LOW > C.CONFIDENCE_RANK.INSUFFICIENT, 'confidence 순서가 뒤집히지 않는다');

  const row = { source: 's', source_external_id: 'e', mall: 'm', current_price: 1000 };
  C.applyGroup(row, null);
  eq(row.is_primary, true, '군집이 없으면 혼자서 대표');
  eq(row.group_size, 1, '크기 1');
  eq(row.group_lowest_price, 1000, '자기 값이 최저가');
  eq(row.group_offers.length, 0, '혼자면 오퍼 목록을 싣지 않는다');

  const row2 = { source: 's', source_external_id: 'e', mall: 'm', current_price: 1000 };
  C.applyGroup(row2, {
    groupKey: 'g', size: 3, primaryKey: 's|other|m', lowestPrice: 900, lowestMall: '쿠팡',
    offers: [{ mall: '쿠팡', price: 900 }, { mall: 'm', price: 1000 }]
  });
  eq(row2.is_primary, false, '대표가 아니면 false');
  eq(row2.group_lowest_price, 900, '군집 최저가를 싣는다');
  eq(row2.group_lowest_mall, '쿠팡', '최저가 몰을 싣는다');
  eq(row2.group_offers.length, 2, '군집이 여럿이면 오퍼 목록을 싣는다');
}

/* ── 요약 ────────────────────────────────────────────────────── */
console.log('\n====================================================');
console.log(`PASS ${pass}  /  FAIL ${fail}`);
if (fail) { console.log('실패: ' + failures.join(', ')); process.exit(1); }
