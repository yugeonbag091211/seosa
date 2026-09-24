#!/usr/bin/env node
'use strict';
/*
 * ③ AI 쇼핑 조사관 — 검색 정확도 회귀 (2026-09-24 실사용 신고). 완전 오프라인.
 *
 *   "100만 원 이하의 가볍고 배터리가 오래가는 노트북 3개"
 *     → 노트북 본체 0개, 교체용 배터리·건전지·키보드 8개
 *
 * 여기서 고정하는 것
 *   A) 상품명 → 본품/부속품/관련 없음 — 노트북만이 아니라 스마트폰·태블릿·카메라·헤드셋·
 *      모니터·스마트워치·키보드·마우스·목록 밖 카테고리까지 같은 규칙
 *   B) 질문 → 찾는 것 — 머리 명사 규칙 ("배터리가 오래가는 노트북" ≠ "노트북 배터리")
 *   C) 부속품만 있는 DB — 부속품을 추천하지 않고, 무엇을 왜 뺐는지 말한다 (카테고리별)
 *   D) 섞인 DB — 검색어를 바꿔 다시 찾아 본체를 찾아낸다 (최대 3회)
 *   E) 부속을 찾는 질문은 부속만
 *   F) 재검색 상한 — DB 3회 · 실시간 검색 1회, 충분하면 일찍 멈춘다
 *   G) «기록상 최저가» — 관측 7일·기간 14일 미만이면 말하지 않고, 말할 때는 기간을 밝힌다
 *   H) 확인 안 된 사양·가격을 만들지 않는다
 *   I) AI Concierge 검색 경로의 같은 규칙 (검색어 정리)
 *   J) 쓰기 0회 · 외부 호출 0회
 */

const kit = require('./_v2-testkit');
const { db, state, T, mkReq, mkRes, fetchCalls } = kit.setup('test-v2-investigator-accuracy');

const PR = require('../api/_product-role');
const PC = require('../api/_price-claims');
const INV = require('../api/_investigator');
const api = require('../api/_investigator-api');
const shop = require('../api/_shop');
const trust = require('../api/_trust');
const { rankItems } = require('../api/_shopintent');

const now = new Date().toISOString();
let pid = 20000;
let products = [];
let history = [];
function reset() { products = []; history = []; db.products = products; db.price_history = history; }
function product(title, price, o) {
  const opt = o || {};
  const id = String(++pid);
  const vid = String(pid * 10);
  products.push({ product_id: id, mall: '쿠팡', mall_label: '쿠팡', vendor_item_id: vid, title, lprice: price, oprice: 0,
    image: 'https://img.example/' + id + '.jpg', link: 'https://link.coupang.com/a?vendorItemId=' + vid,
    keyword: opt.keyword || '노트북', collected_at: now });
  const n = opt.days || 30;
  const prices = opt.prices || Array.from({ length: n }, (_, i) => (i === n - 1 ? price : price + ((i % 5) - 2) * 1000));
  history.push(...kit.historyRows({ productId: id, vendorItemId: vid, prices, startId: pid * 100 }));
  return id;
}
function productReads() { return state.reads.filter(r => r.table === 'products').length; }
async function ask(question, extra) {
  const res = mkRes();
  await api.handler(mkReq({ method: 'POST', body: Object.assign({ question }, extra || {}),
    headers: { origin: 'https://seosa.ai.kr' } }), res);
  return res;
}

const REPORTED = '100만 원 이하의 가볍고 배터리가 오래가는 노트북 3개';

async function main() {
  /* ── A. 상품명 → 역할 ─────────────────────────────────────── */
  T.section('A. 상품명 → 본품/부속품/관련 없음 (카테고리 공통 규칙)');
  const M = PR.MAIN, A = PR.ACCESSORY, O = PR.OTHER, U = PR.UNKNOWN;
  const CASES = [
    // 노트북 — 신고된 사례의 실제 모양
    ['가벼운 노트북', 'LG전자 2025 그램 14 14Z90T 인텔 울트라5 램 16GB 1.19kg 화이트', M],
    ['가벼운 노트북', '노트북 배터리 교체용 LG 그램 15Z90N 호환 72Wh', A],
    ['가벼운 노트북', '에너자이저 알카라인 건전지 AA 20개입', O],
    ['가벼운 노트북', '로지텍 K380 멀티 디바이스 블루투스 키보드', A],
    ['가벼운 노트북', '노트북 키보드 교체 부품 삼성 NT550', A],
    ['가벼운 노트북', '노트북 충전기 어댑터 65W USB-C', A],
    ['가벼운 노트북', '노트북 쿨링패드 17인치', A],
    ['가벼운 노트북', '삼성 DDR4 16GB PC4-25600 노트북용 램', A],
    ['가벼운 노트북', '맥북 에어 M2 13인치 호환 키스킨', A],
    ['가벼운 노트북', 'LG 그램 노트북 백라이트 키보드 대용량 배터리 인텔 i7', M],        // 설명 속 부속 낱말
    ['가벼운 노트북', '레노버 아이디어패드 슬림3 15인치 노트북 램 8GB SSD 256GB (마우스 증정)', M],   // 사은품 절
    ['가벼운 노트북', '삼성 갤럭시북3 i5 16GB 256GB 윈도우11 마우스 파우치 키스킨 증정', M],
    ['가벼운 노트북', 'LG 그램 노트북 + 마우스 + 파우치', M],
    ['가벼운 노트북', 'HP 15s-fq5111TU 인텔 i5 16GB 512GB 윈도우11 15.6인치', M],     // 이름 없이 사양만
    ['가벼운 노트북', '인텔 N100 미니PC 16GB 512GB 윈도우11', O],                      // 사양은 같아도 다른 기기
    ['가벼운 노트북', '갤럭시탭 S9 FE 128GB Wi-Fi', O],
    ['가벼운 노트북', '프로그램 개발 서적', U],                                          // "그램" 이 들어 있어도
    // 스마트폰
    ['스마트폰', '삼성 갤럭시 S24 256GB 자급제 SM-S921N', M],
    ['스마트폰', '아이폰 15 프로 케이스 맥세이프', A],
    ['스마트폰', '갤럭시 S24 울트라 강화유리 필름 2매', A],
    ['스마트폰', '갤럭시 S24 25W 고속 충전기', A],
    ['스마트폰', '애플 아이폰 15 128GB 자급제 + 케이스 증정', M],
    ['스마트폰', '샤오미 레드미노트 13 256GB 5G 무선 충전 지원', M],
    // 태블릿
    ['태블릿', '애플 아이패드 에어 11 M2 Wi-Fi 128GB', M],
    ['태블릿', '아이패드 에어 11 호환 종이질감 필름', A],
    ['태블릿', '삼성 갤럭시탭 S9 FE 128GB S펜 포함', M],
    ['태블릿', '갤럭시탭 S9 FE 북커버 키보드', A],
    ['태블릿', '애플펜슬 2세대 호환 터치펜', A],
    // 카메라
    ['미러리스 카메라', '소니 알파 A6400 미러리스 카메라 바디', M],
    ['미러리스 카메라', '소니 A6400 호환 배터리 NP-FW50', A],
    ['미러리스 카메라', '캐논 EOS R50 렌즈킷 18-45mm 2420만화소 4K', M],
    ['미러리스 카메라', '캐논 RF 50mm F1.8 STM 렌즈', A],
    ['미러리스 카메라', '카메라 가방 숄더백', A],
    ['미러리스 카메라', '홈캠 CCTV 카메라 실내 360도', O],
    ['미러리스 카메라', '소니 ZV-E10 바디 전용 케이지', A],
    // 헤드셋 · 이어폰
    ['게이밍 헤드셋', '로지텍 G PRO X 게이밍 헤드셋 7.1 서라운드', M],
    ['게이밍 헤드셋', '헤드셋 거치대 알루미늄', A],
    ['게이밍 헤드셋', '헤드셋 이어패드 교체용 쿠션', A],
    ['무선 이어폰', '에어팟 프로 2 맥세이프 충전케이스 USB-C', M],                         // 충전 케이스는 본체 구성
    ['무선 이어폰', '에어팟 프로 2 케이스 실리콘', A],
    ['무선 이어폰', '에어팟 프로 충전케이스 단품', A],
    // 모니터 · 스마트워치 · 키보드 · 마우스
    ['27인치 모니터', 'LG 27GR75Q 27인치 QHD 165Hz IPS 게이밍 모니터', M],
    ['27인치 모니터', '모니터암 싱글 27인치', A],
    ['27인치 모니터', '삼성 오디세이 G5 27인치 QHD 165Hz 커브드 높낮이 조절 스탠드', M],
    ['스마트워치', 'Apple 워치 SE 2세대 GPS 40mm 스타라이트 알루미늄 케이스 스타라이트 스포츠 밴드 S/M', M],
    ['스마트워치', '애플워치 스트랩 45mm 스포츠 밴드', A],
    ['무선 키보드', '레오폴드 FC900R PBT 키캡 기계식 키보드 갈축', M],
    ['무선 키보드', 'PBT 키캡 세트 체리 프로파일', A],
    ['무선 마우스', '로지텍 MX Master 3S 무선 마우스', M],
    ['무선 마우스', '게이밍 마우스패드 장패드 900x400', A],
    // 목록 밖 카테고리 — 머리 명사 + 검색 순위용 부속 낱말(읽기만)
    ['텀블러', '스탠리 텀블러 887ml', M],
    ['텀블러', '텀블러 뚜껑 교체용', A],
    ['텀블러', '뚜껑 있는 스테인리스 텀블러 500ml', M],
    ['로봇청소기', '로봇청소기 필터 교체용 호환', A]
  ];
  const wrong = [];
  CASES.forEach(([q, title, want]) => {
    const t = PR.targetOf(q);
    const got = PR.classify(title, t).role;
    if (got !== want) wrong.push(`${q} | ${title} → ${got} (기대 ${want})`);
  });
  T.check(wrong.length === 0, `${CASES.length}개 상품명 역할 판별 (10개 카테고리 + 목록 밖)`, wrong);
  {
    const profiles = new Set(CASES.map(([q]) => PR.targetOf(q).profile));
    T.check(['laptop', 'phone', 'tablet', 'camera', 'audio', 'monitor', 'watch', 'keyboard', 'mouse', 'generic'].every(p => profiles.has(p)),
      '노트북 전용이 아니다 — 같은 규칙이 10개 프로필에서 돈다', [...profiles]);
    const t = PR.targetOf('가벼운 노트북');
    const c = PR.classify('노트북 배터리 교체용 LG 그램 15Z90N 호환 72Wh', t);
    T.check(c.term === '배터리' && /그램/.test(c.why), '판별 근거가 남는다 (무엇 때문에 부속인지)', c);
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'api', '_search.js'), 'utf8');
    T.check(!/키보드|건전지/.test((src.match(/const ACCESSORY_TIER = \[[\s\S]*?\];/) || [''])[0]),
      '핫딜·검색이 같이 쓰는 _search.ACCESSORY_TIER 는 바꾸지 않았다 (읽기만)');
  }

  /* ── B. 질문 → 찾는 것 ─────────────────────────────────────── */
  T.section('B. 질문 이해 — 머리 명사 규칙');
  [
    [REPORTED, 'laptop', M, null],
    ['노트북 배터리 추천해줘', 'laptop', A, '배터리'],
    ['노트북 배터리 오래가는 거', 'laptop', M, null],
    ['키보드 좋은 노트북', 'laptop', M, null],
    ['노트북용 마우스', 'mouse', M, null],
    ['아이폰 15 케이스', 'phone', A, '케이스'],
    ['카메라 좋은 스마트폰', 'phone', M, null],
    ['배터리 오래가는 스마트폰 2개', 'phone', M, null],
    ['캐논 카메라 배터리', 'camera', A, '배터리'],
    ['가벼운 태블릿', 'tablet', M, null],
    ['갤럭시 탭 S9 보호필름', 'tablet', A, '보호필름'],
    ['게이밍 헤드셋', 'audio', M, null],
    ['에어팟 케이스', 'audio', A, '케이스'],
    ['맥북 충전기', 'laptop', A, '충전기']
  ].forEach(([q, profile, role, acc]) => {
    const t = PR.targetOf(q);
    T.check(t && t.profile === profile && t.role === role && (t.accessory ? t.accessory.term : null) === acc,
      `«${q}» → ${profile} ${role}${acc ? ` (${acc})` : ''}`, t && { profile: t.profile, role: t.role, acc: t.accessory });
  });
  {
    const p = INV.parseQuestion(REPORTED);
    T.check(p.target.profile === 'laptop' && p.target.role === M, '신고 문장 → 노트북 «본체»');
    T.check(p.searchPhrase === '노트북' && p.searchTokens.join() === '노트북',
      '★ 검색어에 배터리·오래가·가볍고·3개가 남지 않는다 (원래 버그: "가볍고 배터리 오래가 노트북 3개")', p.searchPhrase);
    T.check(p.requestedCount === 3, '"3개" → 3개만 보여 준다 (원래 8개)', p.requestedCount);
    const light = p.attributes.find(a => a.key === 'light');
    const bat = p.attributes.find(a => a.key === 'battery');
    T.check(light && light.threshold === 1500 && /SEOSA 기준/.test(light.basis), '"가볍고" → 무게 1.5kg 이하 (기준을 밝힌다)', light);
    T.check(bat && bat.threshold === null && /단정하지 않아요/.test(bat.basis), '"배터리가 오래가는" → 상품명 표기로만 확인 (기준 숫자를 지어내지 않는다)', bat);
    T.check(p.wantedFeatures.indexOf('경량') === -1, '무게는 숫자로 확인 — 기능 «경량» 으로 한 번 더 세지 않는다');
    T.check(p.constraints.budgetMax === 1000000, '예산 100만원');
    T.check(!INV.parseQuestion('1.5kg 이하 가벼운 노트북').attributes.some(a => a.key === 'light'), '숫자로 말했으면 그 숫자만 쓴다');
    T.check(INV.parseCount('3개월 쓴 노트북') === null && INV.parseCount('2~3개') && INV.parseCount('2~3개').value === 3
      && INV.parseCount('노트북 10개').value === 8 && INV.parseCount('노트북 10개').said === 10, '개수: 3개월 ≠ 개수, 2~3개 → 3, 10개 → 최대 8');
    T.check(INV.parseQuestion('추천해줘').searchTokens.length === 0 && PR.targetOf('추천해줘', { tokens: [] }) === null, '무엇을 찾는지 모르면 찾지 않는다');
  }

  /* ── C. 부속품만 있는 DB (카테고리별) ───────────────────────── */
  T.section('C. 부속품만 있는 DB — 부속품을 추천하지 않고 이유를 말한다');
  const ACC_ONLY = [
    { q: REPORTED, kw: '노트북 배터리', titles: [
      '노트북 배터리 교체용 LG 그램 15Z90N 호환 72Wh', '레노버 노트북 배터리 L19C4PF1 호환', '에너자이저 알카라인 건전지 AA 20개입',
      '로지텍 블루투스 키보드 K380 노트북 태블릿 호환', '노트북 키보드 교체 부품 삼성 NT550', '노트북 충전기 어댑터 65W USB-C',
      '노트북 파우치 14인치', '노트북 쿨링패드 17인치'], want: '노트북 본체', groups: ['배터리', '건전지'] },
    { q: '30만원 이하 가벼운 스마트폰', kw: '스마트폰', titles: ['아이폰 15 프로 케이스 맥세이프', '갤럭시 S24 울트라 강화유리 필름 2매',
      '갤럭시 S24 25W 고속 충전기', '스마트폰 거치대 차량용', '갤럭시 스마트폰 보조배터리 10000mAh'], want: '스마트폰 본체', groups: ['케이스'] },
    { q: '가벼운 태블릿 2개', kw: '태블릿', titles: ['아이패드 에어 11 호환 종이질감 필름', '갤럭시탭 S9 FE 북커버 키보드',
      '애플펜슬 2세대 호환 터치펜', '태블릿 거치대 알루미늄'], want: '태블릿 본체', groups: ['필름'] },
    { q: '미러리스 카메라 추천', kw: '카메라', titles: ['소니 A6400 호환 배터리 NP-FW50', '카메라 가방 숄더백', '카메라 삼각대 알루미늄',
      '캐논 RF 50mm F1.8 STM 렌즈', '카메라 SD카드 128GB'], want: '카메라 본체', groups: ['배터리'] },
    { q: '게이밍 헤드셋 비교해줘', kw: '헤드셋', titles: ['헤드셋 거치대 알루미늄', '헤드셋 이어패드 교체용 쿠션', '헤드셋 USB 케이블 2m',
      '헤드셋 마이크 커버 5개입'], want: '헤드셋·이어폰 본체', groups: ['거치대'] }
  ];
  for (const sc of ACC_ONLY) {
    reset();
    sc.titles.forEach((t, i) => product(t, 20000 + i * 1000, { keyword: sc.kw, days: 2 }));
    const r0 = productReads();
    const r = await ask(sc.q);
    const b = r.body || {};
    const reads = productReads() - r0;
    const groupNames = [].concat(...(b.excludedGroups || []).map(g => g.groups.map(x => x.name)));
    T.check(r.statusCode === 200 && b.ok && b.candidates.length === 0, `«${sc.q}» — 부속품 ${sc.titles.length}개를 후보로 올리지 않는다`, (b.candidates || []).map(c => c.title));
    T.check(b.excluded.length === sc.titles.length && b.excluded.every(e => /부속품|관련 없는|다른 종류/.test(e.reason)),
      `  모든 상품에 제외 사유가 남는다`, b.excluded.map(e => e.reason));
    T.check(sc.groups.every(g => groupNames.indexOf(g) > -1), `  종류별로 센다 (${sc.groups.join('·')} …)`, b.excludedGroups);
    T.check(b.summary.text.indexOf(`${sc.want}는 찾지 못했어요`) > -1 && /아니라서 뺐어요/.test(b.summary.text)
      && /실시간 쇼핑몰 검색은 꺼져 있어/.test(b.summary.text) && !/다시 검색할까요|다시 찾아볼까요/.test(b.summary.text),
      '  요약: 무엇을 못 찾았고, 무엇을 왜 뺐고, 어디까지 찾았는지 (되묻고 끝내지 않는다)', b.summary.text);
    T.check(b.summary.grounded.ok && !b.summary.grounded.replaced, '  요약의 숫자는 전부 센 값이다', b.summary.grounded);
    T.check(reads <= api.MAX_DB_ATTEMPTS && b.coverage.attempts.length <= api.MAX_DB_ATTEMPTS && b.coverage.attempts.length >= 2,
      `  검색어를 바꿔 다시 찾되 상한(${api.MAX_DB_ATTEMPTS}회)을 지킨다`, { reads, attempts: b.coverage.attempts });
  }

  /* ── D. 섞인 DB — 신고 사례 재현 ───────────────────────────── */
  T.section('D. 섞인 DB — 검색어를 바꿔 본체를 찾아낸다');
  reset();
  for (let i = 0; i < 12; i++) product(`노트북 배터리 교체용 LG 그램 15Z90N 호환 ${60 + i}Wh`, 39000 + i * 1000, { keyword: '노트북 배터리', days: 2 });
  for (let i = 0; i < 4; i++) product(`에너자이저 알카라인 건전지 AA ${10 + i}개입`, 9900 + i * 100, { keyword: '노트북 배터리', days: 1 });
  for (let i = 0; i < 4; i++) product(`로지텍 블루투스 키보드 K${380 + i} 노트북 태블릿 호환`, 45000, { keyword: '노트북 키보드', days: 3 });
  // 본체 — 상품명에 «노트북» 이 없는 것(제품군만 · 사양만)도 있다
  const gram = product('LG전자 2025 그램 14 14Z90T 인텔 울트라5 램 16GB 1.19kg 배터리 최대 20시간', 990000);
  const swift = product('에이서 스위프트 고 14 인텔 i5 16GB 512GB 1.25kg 윈도우11 노트북 65Wh', 849000);
  const book = product('삼성전자 갤럭시북4 노트북 인텔 i5 16GB 256GB 윈도우11 1.55kg', 899000);
  const hp = product('HP 15s-fq5111TU 인텔 i5 16GB 512GB 윈도우11 15.6인치 1.69kg', 699000);
  const noWeight = product('레노버 아이디어패드 슬림3 노트북 램 8GB SSD 256GB', 549000);
  const pricey = product('애플 맥북 프로 14 M3 램 16GB 1.55kg', 2390000);
  {
    const r = await ask(REPORTED);
    const b = r.body;
    const ids = b.candidates.map(c => c.productId);
    const allLaptops = [gram, swift, book, hp, noWeight, pricey];
    T.check(b.candidates.length > 0 && b.candidates.length <= 3, '★ 요청한 3개 이하만 보여 준다', ids.length);
    T.check(ids.every(id => allLaptops.indexOf(id) > -1), '★★ 후보는 전부 노트북 본체 (배터리·건전지·키보드 0개)', b.candidates.map(c => c.title));
    T.check(ids.indexOf(gram) > -1 && ids.indexOf(swift) > -1, '가볍고 예산 안인 본체 — 제품군 이름(그램)만 있는 상품도 찾아낸다', ids);
    T.check(b.coverage.attempts.length >= 2 && b.coverage.attempts[1].where === 'series' && b.coverage.attempts[1].newRows > 0,
      '★ 상품명 «노트북» 으로 모자라면 제품군(그램·맥북…)으로 다시 찾는다', b.coverage.attempts);
    T.check(b.candidates.every(c => c.price.value <= 1000000 && c.fits), '예산 100만원 안', b.candidates.map(c => c.price.value));
    const why = id => ((b.excluded.find(e => e.productId === id) || {}).reason || '');
    T.check(/«가벼운» 기준\(1\.5kg 이하\)보다 무거워요/.test(why(book)) && /무거워요/.test(why(hp)), '1.55kg · 1.69kg → «가벼운» 기준 초과로 제외', [why(book), why(hp)]);
    T.check(/예산/.test(why(pricey)), '239만원 → 예산 초과', why(pricey));
    const g = b.candidates.find(c => c.productId === gram);
    const lightG = g && g.attributes.find(a => a.key === 'light');
    const batG = g && g.attributes.find(a => a.key === 'battery');
    T.check(lightG && lightG.status === 'met' && lightG.evidence === '1.19kg', '가벼움 — 상품명의 1.19kg 으로 확인', lightG);
    T.check(batG && batG.status === 'claimed' && g.title.indexOf(batG.evidence) > -1 && /판매자 표기/.test(g.pros.map(p => p.text).join()),
      '배터리 — «최대 20시간» 은 판매자 표기로만 말한다 (충족이라고 단정하지 않는다)', batG);
    const s = b.excludedGroups.find(x => x.kind === 'accessory');
    T.check(s && s.count === 16 && s.groups[0].name === '배터리' && s.groups[0].count === 12, '부속품 16개(배터리 12·키보드 4)를 센다', b.excludedGroups);
    T.check(b.excluded[0].kind === 'condition', '제외 목록은 조건에 걸린 «본체» 가 먼저 (부속품 수십 개가 가리지 않게)', b.excluded.slice(0, 3));
    T.check(b.summary.grounded.ok && /부속품 16개\(배터리 12개·키보드 4개\), 관련 없는 상품 4개\(건전지 4개\)는 노트북 본체가 아니라서 뺐어요/.test(b.summary.text),
      '결과가 충분해도 요약에 뺀 종류·개수를 밝힌다', b.summary.text);
    const r5 = await ask(REPORTED.replace('3개', '5개'));
    T.check(/요청하신 5개 중 3개만 조건에 맞았어요/.test(r5.body.summary.text) && /노트북 본체 중 \d+개는 조건에 맞지 않아 뺐어요/.test(r5.body.summary.text)
      && r5.body.summary.grounded.ok, '모자라면 "요청하신 5개 중 3개만" 과 조건 탈락 수를 말한다', r5.body.summary.text);
    T.check(b.query.target.describe === '노트북 본체' && b.query.requestedCount === 3, '응답에 이해한 내용(찾는 것·개수)이 실린다', b.query.target);
  }

  /* ── E. 부속을 찾는 질문 ──────────────────────────────────── */
  T.section('E. 부속을 찾는 질문은 부속만');
  {
    const r = await ask('노트북 배터리 추천해줘');
    const b = r.body;
    T.check(b.candidates.length > 0 && b.candidates.every(c => /배터리/.test(c.title) && !/건전지/.test(c.title)),
      '"노트북 배터리" → 노트북용 배터리만', b.candidates.map(c => c.title));
    const main = b.excluded.find(e => e.kind === 'main');
    T.check(main && /노트북 본체예요 — 찾는 것은 노트북 배터리/.test(main.reason) && /배터리 최대 20시간/.test(main.title),
      '제목에 «배터리» 가 있는 노트북 본체는 사유와 함께 제외', main);
    T.check(!b.excluded.concat(b.candidates).some(x => /건전지|키보드/.test(x.title)),
      '검색 단계에서 이미 «배터리» 가 없는 상품(건전지·키보드)은 불러오지 않는다');
    T.check(b.query.target.role === A && b.query.target.accessory === '배터리', '찾는 것: 노트북용 배터리', b.query.target);
  }

  /* ── F. 재검색 상한 ───────────────────────────────────────── */
  T.section('F. 재검색 상한 — 충분하면 멈추고, 실시간 검색은 최대 1회');
  {
    reset();
    for (let i = 0; i < 30; i++) product(`에이수스 비보북 ${i} 노트북 인텔 i5 16GB 512GB 1.4kg`, 600000 + i * 1000);
    const r0 = productReads();
    const r = await ask('가벼운 노트북 추천');
    T.check(productReads() - r0 === 1 && r.body.coverage.attempts.length === 1, '첫 검색으로 충분하면 다시 찾지 않는다 (DB 1회)', r.body.coverage.attempts);

    reset();
    ['노트북 배터리 교체용 호환 A', '노트북 충전기 65W'].forEach((t, i) => product(t, 30000 + i, { keyword: '노트북', days: 2 }));
    let calls = 0, lastPhrase = '';
    const saved = shop.searchAll;
    shop.searchAll = async (phrase) => {
      calls++; lastPhrase = phrase;
      return { items: [
        { productId: '990001', vendorItemId: '9900010', mall: '쿠팡', title: '노트북 배터리 교체용 삼성 NT550 호환', price: 45000, link: 'https://link.coupang.com/l1' },
        { productId: '990002', vendorItemId: '9900020', mall: '쿠팡', title: 'LG 그램 15 노트북 인텔 i5 16GB 1.2kg', price: 890000, link: 'https://link.coupang.com/l2' }
      ] };
    };
    process.env.INVESTIGATOR_LIVE_SEARCH = '1';
    const r2 = await ask(REPORTED);
    delete process.env.INVESTIGATOR_LIVE_SEARCH;
    shop.searchAll = saved;
    T.check(calls === 1 && api.MAX_LIVE_ATTEMPTS === 1, '실시간 검색(쿠팡)은 켜져 있어도 1회뿐', calls);
    T.check(lastPhrase === '경량 노트북', '실시간 검색어도 정리된 말 («경량 노트북»)', lastPhrase);
    T.check(r2.body.coverage.liveSearch === 'used' && r2.body.coverage.source === 'catalog+live'
      && r2.body.candidates.length === 1 && /그램/.test(r2.body.candidates[0].title),
      '실시간 결과도 같은 판별을 거친다 — 본체만 후보', r2.body.candidates.map(c => c.title));
    T.check(r2.body.coverage.attempts.length <= api.MAX_DB_ATTEMPTS + api.MAX_LIVE_ATTEMPTS, '전체 검색 횟수 상한', r2.body.coverage.attempts.length);
  }

  /* ── G. «기록상 최저가» ───────────────────────────────────── */
  T.section('G. «기록상 최저가» — 관측 건수와 기간을 본다');
  {
    T.check(PC.recordLowNote({ count: 1, historyDays: 0, low: 50000 }, 50000) === null, '기록 1건 → 최저가라고 하지 않는다 (처음 본 값은 언제나 최저)');
    T.check(PC.recordLowNote({ count: 3, historyDays: 20, low: 50000 }, 50000) === null, '관측 3일 → 말하지 않는다');
    T.check(PC.recordLowNote({ count: 7, historyDays: 6, low: 50000 }, 50000) === null, '관측 7일이라도 기간 7일 → 말하지 않는다');
    T.check(PC.recordLowNote({ count: 7, historyDays: 20, low: 50000 }, 50000) === '21일 기록 중 최저가', '관측 7일 · 기간 21일 → "21일 기록 중 최저가" (기간을 밝힌다)');
    T.check(PC.recordLowNote({ count: 10, historyDays: 29, low: 50000 }, 51000) === null, '최저보다 비싸면 없음');
    const { toCard } = require('../api/ai')._internal;
    const thin = toCard({ productId: '1', title: 'A', lprice: 50000, mall: '쿠팡' }, { count: 2, historyDays: 1, low: 50000, avg30: 50000 });
    const thick = toCard({ productId: '1', title: 'A', lprice: 50000, mall: '쿠팡' }, { count: 10, historyDays: 29, low: 50000, avg30: 60000 });
    T.check(!/최저가/.test(thin.note || ''), '★ AI 카드: 기록 2건이면 "기록상 최저가" 를 붙이지 않는다 (원래 붙였다)', thin.note);
    T.check(thick.note === '30일 기록 중 최저가', 'AI 카드: 기록이 두꺼우면 기간과 함께', thick.note);
    // rankItems 는 후보가 둘 이상일 때만 점수를 매긴다.
    const notes = hist => rankItems([{ title: '테스트 노트북', price: 50000, hist }, { title: '다른 노트북', price: 90000 }], {}, '노트북')
      .find(it => it.title === '테스트 노트북').notes;
    // "이번 후보 중 최저가" 는 후보끼리의 비교(사실)라 그대로 둔다 — 막는 것은 «기록상» 주장뿐.
    T.check(!notes({ count: 2, historyDays: 1, low: 50000, avg30: 0 }).some(n => /기록상 최저가/.test(n)), 'AI 조건 대조 문장: 얇은 기록엔 «기록상 최저가» 없음');
    T.check(notes({ count: 10, historyDays: 29, low: 50000, avg30: 0 }).indexOf('기록상 최저가 수준 (30일·관측 10회 기준)') > -1, 'AI 조건 대조 문장: 두꺼우면 기간·건수와 함께');

    reset();
    const thinId = product('LG 그램 14 노트북 인텔 i5 16GB 1.2kg 신상', 700000, { days: 3, prices: [720000, 710000, 700000] });
    const thickId = product('LG 그램 15 노트북 인텔 i5 16GB 1.3kg', 800000, { prices: Array.from({ length: 30 }, (_, i) => (i === 29 ? 800000 : 820000 + (i % 3) * 5000)) });
    const r = await ask('100만원 이하 노트북 비교');
    const cThin = r.body.candidates.find(c => c.productId === thinId);
    const cThick = r.body.candidates.find(c => c.productId === thickId);
    T.check(cThin && cThin.priceHistory.obs === 3 && cThin.priceHistory.enough === false && cThin.deal === null
      && cThin.level.level === 'insufficient' && !cThin.pros.some(p => /최저가|하위|판정/.test(p.text)),
      '★ 조사관: 기록 3일인 상품은 현재가가 기록 최저여도 «최저가»·«하위 N%»·가격 판정을 말하지 않는다', cThin && cThin.pros);
    T.check(cThin && cThin.cons.some(p => /3일·관측 3회뿐이라 싼지 비싼지 아직 판단하기 일러요/.test(p.text)), '  대신 기록이 짧다는 사실을 기간·건수로 말한다', cThin && cThin.cons);
    T.check(cThick && cThick.priceHistory.enough && cThick.pros.some(p => /SEOSA 기록 30일·관측 30회 중 최저가예요 \(기록 이전 가격은 알 수 없어요\)/.test(p.text)),
      '조사관: 기록이 두꺼우면 «최저가» 를 기간·건수·한계와 함께', cThick && cThick.pros);
    T.check(r.body.summary.grounded.ok, '요약 근거 검사 통과');
  }

  /* ── H. 확인 안 된 사양·가격을 만들지 않는다 ─────────────── */
  T.section('H. 확인 안 된 사양·가격을 만들지 않는다');
  {
    reset();
    const plain = product('레노버 아이디어패드 슬림3 노트북 램 8GB SSD 256GB', 549000);
    const claim = product('초경량 대용량 배터리 노트북 인텔 N100 8GB 256GB', 399000);
    const r = await ask('가볍고 배터리 오래가는 노트북');
    const cs = r.body.candidates;
    const p = cs.find(c => c.productId === plain);
    const k = cs.find(c => c.productId === claim);
    T.check(p && p.attributes.every(a => a.status === 'unknown') && p.cons.some(x => /무게: 상품명에 표기가 없어/.test(x.text))
      && p.cons.some(x => /배터리: 상품명에 사용 시간·용량 표기가 없어/.test(x.text)),
      '표기가 없으면 «확인 안 됨» — 무게·배터리 시간을 추정하지 않는다', p && p.cons);
    T.check(k && k.attributes.every(a => a.status === 'unknown') && k.cons.some(x => /«초경량» 라고만/.test(x.text)) && k.cons.some(x => /«대용량 배터리» 라고만/.test(x.text)),
      '숫자 없는 판매자 문구(초경량·대용량 배터리)는 충족이 아니라 «문구만 있음»', k && k.cons);
    T.check(cs.every(c => Object.keys(c.specs.verified).every(key => c.title.indexOf(c.specs.verified[key].evidence) > -1)
      && c.attributes.every(a => !a.evidence || c.title.indexOf(a.evidence) > -1)), '모든 사양·조건 근거는 상품명 안의 글자다');
    T.check(cs.every(c => c.price.source === 'price_history' || c.price.verified === false), '가격은 원장 기록이거나, 아니면 미검증으로 밝힌다');
  }

  /* ── I. AI Concierge 검색 경로 ────────────────────────────── */
  T.section('I. AI Concierge 검색 경로 — 같은 규칙');
  {
    const AI = require('../api/ai')._internal;
    const t1 = AI.roleTargetOf('가볍고 배터리 오래가 노트북 3개');
    T.check(AI.roleSearchQuery('가볍고 배터리 오래가 노트북 3개', t1) === '경량 노트북', '검색어 정리: "가볍고 배터리 오래가 노트북 3개" → "경량 노트북"');
    const t2 = AI.roleTargetOf('배터리 오래가는 스마트폰 2개');
    T.check(AI.roleSearchQuery('배터리 오래가는 스마트폰 2개', t2) === '스마트폰', '스마트폰도 같은 규칙');
    const t3 = AI.roleTargetOf('노트북 배터리');
    T.check(AI.roleSearchQuery('노트북 배터리', t3) === '노트북 배터리', '부속을 찾는 검색어는 그대로');
    T.check(AI.roleSearchQuery('아이폰 15 케이스', AI.roleTargetOf('아이폰 15 케이스')) === '아이폰 15 케이스', '"아이폰 15 케이스" 그대로');
    T.check(AI.roleTargetOf('캠핑의자') === null, '목록 밖 카테고리는 Concierge 경로를 바꾸지 않는다');

    // screenByRole — 재검색 1회 · 예산이 없으면 재검색하지 않는다
    const savedS = shop.searchAll, savedSave = shop.saveProducts, savedT = trust.attachTrust;
    let n = 0;
    shop.searchAll = async () => { n++; return { items: [{ productId: 'L1', mall: '쿠팡', title: 'LG 그램 노트북 인텔 i5 16GB', price: 900000 }], allItems: [], from: 'api', blocked: false }; };
    shop.saveProducts = async () => {};
    trust.attachTrust = async list => list;
    const found = { ok: true, items: [{ productId: 'X1', mall: '쿠팡', title: '노트북 배터리 교체용 호환' }, { productId: 'X2', mall: '쿠팡', title: '알카라인 건전지 AA' }] };
    const rich = { remaining: () => 30000 };
    const sc = await AI.screenByRole(t1, found, '경량 노트북', rich);
    T.check(n === 1 && sc.retried === '노트북' && sc.found.items.length === 1 && sc.found.items[0].productId === 'L1' && sc.dropped === 2,
      'Concierge: 부속품을 빼고 «노트북» 으로 한 번 더 찾는다', { n, retried: sc.retried, items: sc.found.items.map(i => i.title) });
    n = 0;
    const poor = { remaining: () => 1000 };
    const sc2 = await AI.screenByRole(t1, found, '경량 노트북', poor);
    T.check(n === 0 && sc2.found.items.length === 0 && /노트북 본체는 찾지 못했어요/.test(sc2.userText), 'Concierge: 시간 예산이 없으면 재검색하지 않고 사실만 말한다', sc2.userText);
    shop.searchAll = savedS; shop.saveProducts = savedSave; trust.attachTrust = savedT;
  }

  T.section('J. 안전');
  T.check(state.writes.length === 0, '어떤 표에도 쓰지 않았다', state.writes.map(w => w.table));
  T.check(fetchCalls.length === 0, '외부 호출 0회', fetchCalls);

  T.done();
}

main().catch(e => { console.error(e); process.exitCode = 1; });
