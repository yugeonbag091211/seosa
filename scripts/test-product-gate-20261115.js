'use strict';
/*
 * 2026-11-15 검색 재구축 — 문제 A~E 재현과 회귀 고정 (외부 호출 0 · DB 대역).
 *
 *   A  본품 검색에 부속·도서가 본품과 같은 관련도로 섞인다 (아이패드 10세대 ↔ 매직키보드 1.00)
 *   B  검색어 일부만 맞는 상품 (로지텍 G304 ↔ 다른 브랜드·G304 마우스피트·WF/WH)
 *   C  가격 정렬이 정체성 검증보다 먼저다 (노트북 ↔ 8,000원 키스킨이 최저가 1위)
 *   D  무관한 상품이 DB 에 저장된다 (수영복 ↔ 콜라·연어 — 검색·AI·크론 저장 공통 경로)
 *   E  수집기가 잘못된 분류를 매일 다시 쓴다 (가격 갱신 성공 ≠ 분류 정확)
 *
 * 규칙은 특정 상품명 예외가 아니라 일반 규칙이므로, 같은 규칙을 다른 범주(태블릿·노트북·
 * 이어폰·스마트폰·청소기·생활·패션)에서 함께 확인한다.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

let pass = 0;
const failures = [];
function check(cond, name, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail !== undefined ? '  — ' + JSON.stringify(detail).slice(0, 300) : ''}`); }
}
function section(t) { console.log(`\n[${t}]`); }

/* ── DB 대역: 쓰기를 기록만 한다 ── */
const writes = [];
function fakeQuery(table) {
  const o = {};
  ['select', 'eq', 'in', 'gte', 'lte', 'lt', 'gt', 'order', 'limit', 'range', 'is', 'not', 'or', 'filter', 'neq'].forEach(m => { o[m] = () => o; });
  o.maybeSingle = () => Promise.resolve({ data: null, error: null });
  o.single = () => Promise.resolve({ data: null, error: null });
  o.upsert = rows => { writes.push({ table, rows: Array.isArray(rows) ? rows : [rows] }); return Promise.resolve({ data: null, error: null }); };
  o.insert = o.upsert;
  o.then = (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject);
  return o;
}
const fakeSupabase = { from: t => fakeQuery(t), rpc: () => Promise.resolve({ data: [], error: null }) };
const realLoad = Module._load;
Module._load = function (request, parent) {
  if ((request === './_supabase' || request === './_supabase.js') && parent && /[\\/]api[\\/]/.test(parent.filename || '')) return fakeSupabase;
  return realLoad.apply(this, arguments);
};
delete process.env.SEOSA_DB_READONLY;
delete process.env.IDENTITY_CANONICAL_CONSUMER_ENABLED;
global.fetch = async url => { throw new Error(`외부 호출 금지: ${url}`); };

const Gate = require('../api/_product-gate');
const shop = require('../api/_shop');
const trust = require('../api/_trust');
const facets = require('../api/_facets');
require('../api/_ratelimit').guard = () => true;
trust.attachTrust = async () => {};
facets.attachPriceChange = async () => {};

let pool = [];
shop.searchAll = async keyword => {
  const items = pool.map((p, i) => ({ title: p[0], lprice: p[1], productId: `g${i}`, mall: '쿠팡', link: `https://example.invalid/${i}`, _source: 'api' }));
  const rel = shop.relevantItems(keyword, items);
  return { items: rel.kept, from: 'api', failed: false, blocked: false, errors: [] };
};
const handler = require('../api/search');
async function search(keyword, rows) {
  pool = rows;
  writes.length = 0;
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.statusCode = n; return this; }, json(x) { this.body = x; return this; } };
  const quiet = [console.log, console.warn];
  console.log = () => {}; console.warn = () => {};
  try { await handler({ method: 'GET', headers: {}, query: { keyword } }, res); }
  finally { [console.log, console.warn] = quiet; }
  assert.equal(res.statusCode, 200, keyword);
  const savedTitles = writes.filter(w => w.table === 'products').flatMap(w => w.rows.map(r => r.title));
  return { shown: (res.body || []).map(x => x.title), body: res.body || [], savedTitles };
}
const titles = r => r.shown;

(async () => {
  /* ── A ─────────────────────────────────────────────────────────── */
  section('A — 본품 검색에서 부속·도서·다른 세대가 빠진다 (매직키보드 1.00 재현 포함)');
  {
    const body = 'Apple 2022 아이패드 10세대 와이파이 64GB 실버';
    const bundled = 'Apple 아이패드 10세대 64GB 충전기 포함';
    const r = await search('아이패드 10세대', [[body, 529000], ['Apple 아이패드 10세대 전용 매직 키보드 폴리오', 349000],
      ['아이패드 10세대 10.9 저반사 액정보호필름 2매', 8900], ['아이패드 10세대 케이스 스마트커버 펜슬수납', 12900],
      ['엄마아빠를 위한 아이패드 사용설명서', 16200], ['Apple 아이패드 9세대 64GB 와이파이', 399000],
      ['Apple 아이패드 에어 11 M2', 899000], ['아이패드 10세대 충전기 20W C타입', 19800], [bundled, 499000]]);
    check(titles(r).includes(body) && titles(r).includes(bundled), '본품과 «충전기 포함» 본품은 남는다', titles(r));
    check(!titles(r).some(t => /매직 키보드|필름|케이스|사용설명서|20W/.test(t)), '키보드·필름·케이스·설명서·충전기 단품은 빠진다', titles(r));
    check(!titles(r).some(t => /9세대|에어/.test(t)), '다른 세대(9세대)·다른 라인(에어)은 빠진다', titles(r));
    const acc = await search('아이패드 10세대 케이스', [['아이패드 10세대 케이스 스마트커버 펜슬수납', 12900], [body, 529000], ['아이패드 에어 11 케이스', 15900]]);
    check(titles(acc).length === 1 && /10세대 케이스/.test(titles(acc)[0]), '부속을 찾으면 그 기기(10세대)의 부속만 남는다', titles(acc));
    const tab = Gate.gateItems('갤럭시 탭 S10 울트라', [{ title: '삼성 갤럭시탭 S10 울트라 256GB WiFi' }, { title: '갤럭시탭 S10 울트라 북커버 키보드 케이스' }, { title: '갤럭시탭 S10+ 256GB' }]).kept.map(x => x.title);
    check(tab.length === 1 && /256GB WiFi/.test(tab[0]), '태블릿: 북커버 키보드 케이스·다른 변형(S10+)은 빠진다', tab);
    const ear = await search('에어팟 프로 2', [['Apple 에어팟 프로 2세대 USB-C 블루투스 이어폰', 299000], ['에어팟 프로 2 실리콘 케이스', 6900],
      ['에어팟 프로2 이어팁 교체용 폼팁', 9900], ['Apple 에어팟 4 ANC', 249000], ['에어팟 프로 2세대 왼쪽 유닛 단품', 99000],
      ['Apple 에어팟 프로 2 MagSafe 충전 케이스 포함 블루투스 이어폰', 289000]]);
    check(titles(ear).length === 2 && titles(ear).every(t => /프로 2/.test(t) && /이어폰/.test(t)), '이어폰: 케이스·이어팁·단품 유닛·다른 세대는 빠지고 «충전 케이스 포함» 본품은 남는다', titles(ear));
  }

  /* ── B ─────────────────────────────────────────────────────────── */
  section('B — 브랜드·모델 번호·변형·용량이 다르면 후보에서 뺀다');
  {
    const r = await search('로지텍 G304 무선 마우스', [['로지텍 G304 LIGHTSPEED 무선 게이밍 마우스', 39000], ['로지텍 G304 마우스피트 교체용 스케이트', 5900],
      ['레이저 바이퍼 미니 무선 게이밍 마우스', 45000], ['앱코 A660 무선 마우스', 9900], ['로지텍 G102 2세대 유선 게이밍 마우스', 23900],
      ['G304 G305 호환 그립테이프 미끄럼방지', 4500], ['로지텍 G304 무선 리시버 단품', 15000], ['로지텍 G304 G102 G203 무선 마우스 모음', 19900]]);
    check(titles(r).length === 1 && /LIGHTSPEED/.test(titles(r)[0]), 'G304 본품 하나만 남는다 (다른 브랜드·G102·마우스피트·리시버·여러 모델 글 제외)', titles(r));
    const wh = Gate.gateItems('소니 WH-1000XM5', [{ title: '소니 WH-1000XM5 노이즈캔슬링 헤드폰 블랙' }, { title: '소니 WF-1000XM5 노이즈캔슬링 이어폰' }]).kept.map(x => x.title);
    check(wh.length === 1 && /WH-1000XM5/.test(wh[0]), '모델 코드의 영문 머리까지 같아야 한다 (WH ≠ WF)', wh);
    const gram = Gate.gateItems('LG 그램 16', [{ title: 'LG전자 2025 그램 16 코어 울트라5 16GB 512GB 16Z90T' }, { title: 'LG전자 그램 15 15Z90S 노트북' }, { title: 'LG전자 그램 프로 16 16Z90SP 노트북' }, { title: '삼성 갤럭시북4 16인치 노트북' }]).kept.map(x => x.title);
    check(gram.length === 1 && /16Z90T/.test(gram[0]), '노트북: 그램 15·그램 프로·다른 브랜드는 빠지고, 연식(2025)·CPU(울트라5)는 변형으로 읽지 않는다', gram);
    const phone = await search('갤럭시 S25 256GB', [['삼성 갤럭시 S25 256GB 자급제 SM-S931N', 1155000], ['삼성 갤럭시 S25 128GB 자급제', 1050000],
      ['갤럭시 S25 울트라 256GB 자급제', 1698000], ['갤럭시 S25 128GB/256GB/512GB 자급제', 1050000], ['갤럭시 S25+ 256GB 자급제', 1350000],
      ['삼성 갤럭시 S25 자급제', 1100000], ['[중고] 갤럭시 S25 256GB 공기계 S급', 690000]]);
    check(titles(phone)[0] === '삼성 갤럭시 S25 256GB 자급제 SM-S931N', '스마트폰: 256GB 본품이 1위', titles(phone));
    check(!titles(phone).some(t => /128GB 자급제$|울트라|128GB\/256GB|S25\+|^삼성 갤럭시 S25 자급제$/.test(t)), '다른 용량·옵션 여러 개·용량 미표기·울트라·플러스는 빠진다', titles(phone));
    check(phone.body.find(x => /중고/.test(x.title)).identity === 'unverified' && /중고/.test(titles(phone).at(-1)), '중고는 요청이 없으면 «확인 안 됨» 으로 맨 뒤', titles(phone));
    const used = Gate.gateItems('갤럭시 S25 중고 말고', [{ title: '[중고] 갤럭시 S25 256GB 공기계 S급' }, { title: '삼성 갤럭시 S25 256GB 자급제' }]).kept.map(x => x.title);
    check(used.length === 1 && !/중고/.test(used[0]), '«중고 말고» 는 중고를 뺀다', used);
    const ex = Gate.gateItems('로지텍 말고 무선 마우스', [{ title: '로지텍 M331 무선 마우스' }, { title: '앱코 A660 무선 마우스' }]).kept.map(x => x.title);
    check(ex.length === 1 && /앱코/.test(ex[0]), '«로지텍 말고» 는 로지텍을 뺀다', ex);
    const budget = Gate.gateItems('80만원 이하 노트북', [{ title: '레노버 아이디어패드 슬림3 15 라이젠5 노트북', lprice: 549000 }, { title: '삼성전자 갤럭시북4 15.6 인텔 코어 i5 노트북', lprice: 899000 }]).kept.map(x => x.title);
    check(budget.length === 1 && /아이디어패드/.test(budget[0]), '예산 상한을 넘는 상품은 뺀다', budget);
  }

  /* ── C ─────────────────────────────────────────────────────────── */
  section('C — 가격 정렬 전에 정체성 검증 (8,000원 키스킨이 최저가 1위가 되지 않는다)');
  {
    const r = await search('노트북', [['삼성전자 갤럭시북4 15.6 인텔 코어 i5 노트북 NT750XGR', 899000], ['노트북 키스킨 15.6인치 범용 실리콘', 8000],
      ['노트북 거치대 알루미늄 접이식', 15900], ['레노버 아이디어패드 슬림3 15 라이젠5 노트북', 549000], ['노트북 파우치 15.6인치', 12900],
      ['노트북 하나로 끝내는 엑셀 (도서)', 18000], ['HDMI 케이블 노트북 모니터 연결', 12590]]);
    const byPrice = r.body.slice().sort((a, b) => a.lprice - b.lprice);
    check(byPrice.length === 2 && byPrice[0].lprice === 549000, '응답 전체를 가격순으로 세워도 1위는 노트북 본품', byPrice.map(x => [x.lprice, x.title]));
    const ordered = Gate.orderByIdentity([{ title: 'b', identity: 'unverified', relevance: 1, lprice: 1000 }, { title: 'a', identity: 'verified', relevance: 0.6, lprice: 900000 }]);
    check(ordered[0].title === 'a', '확인된 상품이 확인 못 한 상품보다 먼저 선다 (관련도·가격보다 먼저)', ordered.map(x => x.title));
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    check(/var tier = function\(x\) \{ return x && x\.identity === 'unverified' \? 1 : 0; \};/.test(html)
      && /if \(tier\(a\) !== tier\(b\)\) return tier\(a\) - tier\(b\);/.test(html), '화면의 «최저가순» 도 확인된 상품끼리 먼저 겨룬다 (public/index.html byPrice)');
  }

  /* ── D ─────────────────────────────────────────────────────────── */
  section('D — 무관한 상품은 저장하지 않는다 (검색·AI·크론 공통 saveProducts)');
  {
    const r = await search('수영복', [['나이키 여성 원피스 수영복 NESSA', 74940], ['코카콜라 오리지널 300ml 24개', 13180],
      ['수영복 입을때 필요한 방수 선크림 로션', 13600], ['아레나 여성 탄탄이 원피스 수영복', 187060], ['수영복 건조 망 가방', 9900]]);
    check(titles(r).length === 2 && titles(r).every(t => /원피스 수영복/.test(t)), '수영복 검색에는 수영복만 (선크림·건조망 가방 제외)', titles(r));
    check(r.savedTitles.length === 2 && r.savedTitles.every(t => /원피스 수영복/.test(t)), '검색 저장도 수영복만', r.savedTitles);
    writes.length = 0;
    const quiet = console.log; console.log = () => {};
    const s = await shop.saveProducts('수영복', [
      { productId: 'c1', mall: '쿠팡', title: '코카콜라 오리지널 300ml 24개', lprice: 13180, _source: 'api' },
      { productId: 'c2', mall: '쿠팡', title: '쌜모네키친 노르웨이산 생연어 횟감용 200g', lprice: 15290, _source: 'api' },
      { productId: 'c3', mall: '쿠팡', title: '나이키 여성 원피스 수영복', lprice: 74940, _source: 'api' }
    ], { from: 'api', source: 'cron' });
    console.log = quiet;
    const savedNow = writes.filter(w => w.table === 'products').flatMap(w => w.rows.map(x => x.title));
    check(s.gateRejected === 2 && savedNow.length === 1 && /수영복/.test(savedNow[0]), '크론·AI 가 같은 함수로 저장해도 콜라·연어는 그 키워드로 기록되지 않는다', { s, savedNow });
  }

  /* ── E ─────────────────────────────────────────────────────────── */
  section('E — 수집기: 가격은 갱신하고, 틀린 분류의 카탈로그 행은 다시 쓰지 않는다');
  {
    check(Gate.classifyStoredRow('수영복', '코카콜라 오리지널').verdict === 'mismatch', '기록 행 분류: 수영복 ↔ 콜라 = mismatch');
    check(Gate.classifyStoredRow('수영복', '아레나 여성 탄탄이 원피스 수영복').verdict === 'match', '기록 행 분류: 수영복 ↔ 수영복 = match');
    check(Gate.classifyStoredRow('LG 그램 17', 'LG전자 그램 16 16Z90S').verdict === 'mismatch', '기록 행 분류: 그램 17 ↔ 그램 16 = mismatch');
    check(Gate.classifyStoredRow('할로윈 의상 및 소품', '할로윈 마녀 모자').verdict !== 'mismatch', '범주를 나열한 키워드는 머리 명사 하나로 판정하지 않는다');
    writes.length = 0;
    const quiet = [console.log, console.warn]; console.log = () => {}; console.warn = () => {};
    const rec = await shop.recordPrices([
      { productId: 'h1', mall: '쿠팡', keyword: '수영복', title: '코카콜라 오리지널', price: 13180, link: '', catalogHold: true },
      { productId: 'h2', mall: '쿠팡', keyword: '수영복', title: '아레나 원피스 수영복', price: 99000, link: '' }
    ], { source: 'collect', label: 'test' });
    [console.log, console.warn] = quiet;
    const hist = writes.filter(w => w.table === 'price_history').flatMap(w => w.rows.map(x => x.product_id));
    const cat = writes.filter(w => w.table === 'products').flatMap(w => w.rows.map(x => x.product_id));
    check(hist.includes('h1') && hist.includes('h2'), '가격 관측은 두 행 모두 원장에 남는다 (가격 갱신은 성공)', hist);
    check(!cat.includes('h1') && cat.includes('h2'), '분류가 틀린 행은 카탈로그(products)를 다시 쓰지 않는다 — 홈에 «방금 수집한 상품» 으로 되살아나지 않는다', cat);
    check(rec.recordedKeys.includes('h1|쿠팡'), '수집 성공 판정(recordedKeys)은 그대로다', rec.recordedKeys);
    const rows = shop.relevantRows([
      { keyword: '수영복', title: '수영복 입을때 필요한 방수 선크림 로션' },
      { keyword: '수영복', title: '나이키 여성 원피스 수영복' },
      { keyword: '아이패드 10세대', title: '아이패드 10세대 케이스 스마트커버' }
    ]);
    check(rows.length === 1 && /원피스/.test(rows[0].title), '홈 표시(relevantRows)도 같은 판정으로 걸러 지우지 않고 숨긴다', rows.map(r => r.title));
    const collector = fs.readFileSync(path.join(__dirname, 'collect-all-prices.js'), 'utf8');
    check(/catalogHold/.test(collector) && /classificationAudit/.test(collector), '수집기가 분류 점검 결과(classificationAudit)를 남기고 catalogHold 를 싣는다');
  }

  /* ── 일반 범주 ─────────────────────────────────────────────────── */
  section('일반화 — 같은 규칙이 생활·패션·가전에서도 동작한다');
  {
    const tum = Gate.gateItems('텀블러', [{ title: '스탠리 퀜처 진공 텀블러 887ml' }, { title: '텀블러 세척솔 3종 세트' }, { title: '텀블러 뚜껑 실리콘 패킹 교체용' }]).kept.map(x => x.title);
    check(tum.length === 1 && /스탠리/.test(tum[0]), '생활: 텀블러 ↔ 세척솔·패킹', tum);
    const car = Gate.gateItems('여행용 캐리어', [{ title: '샘소나이트 여행용 캐리어 24인치' }, { title: '어미닛데이 여행용 캐리어 가죽 네임택 2p' }, { title: '키누리 캐리어 휴대용 여행용 소형 자물쇠' }]).kept.map(x => x.title);
    check(car.length === 1 && /샘소나이트/.test(car[0]), '생활: 캐리어 ↔ 네임택·자물쇠', car);
    const vac = Gate.gateItems('로봇청소기', [{ title: '로보락 S8 MaxV Ultra 로봇청소기 물걸레 자동세척 먼지통비움' }, { title: '로봇청소기 물걸레 패드 10개 호환' }, { title: '로봇청소기 사이드브러시 교체용' }]).kept.map(x => x.title);
    check(vac.length === 1 && /로보락/.test(vac[0]), '가전: 물걸레 «기능» 은 본품, 물걸레 «패드 10개 호환» 은 부속', vac);
    const air = Gate.gateItems('공기청정기', [{ title: 'LG 퓨리케어 360 공기청정기 헤파필터 H13' }, { title: '위닉스 타워XQ500 공기청정기 W5필터 2개' }, { title: '차량용 미니 공기청정기 USB' }]).kept.map(x => x.title);
    check(air.length === 1 && /퓨리케어/.test(air[0]), '가전: 헤파필터 «사양» 은 본품, 필터 2개는 부속, 차량 전용은 가정용 검색에서 제외', air);
    const pack = Gate.gateItems('백팩', [{ title: 'JanSport 슈퍼브레이크 백팩' }, { title: '백팩 레인커버 방수' }]).kept.map(x => x.title);
    check(pack.length === 1 && /JanSport/.test(pack[0]), '패션: 부속 사전에 있는 말(백팩)도 그 자체를 찾으면 본품이다', pack);
    const rash = Gate.gateItems('남성 래쉬가드', [{ title: '남성 반팔 래쉬가드 UV차단' }, { title: '물놀이대장 남아 래쉬가드 상하복' }, { title: '여성 래쉬가드 집업' }]).kept.map(x => x.title);
    check(rash.length === 1 && /남성 반팔/.test(rash[0]), '패션: 성인 남성 검색에 아동(남아)·여성 상품 제외', rash);
  }

  console.log(`\nPRODUCT_GATE_${failures.length ? 'FAIL' : 'PASS'} ${pass} passed, ${failures.length} failed — external calls 0, DB fake only`);
  if (failures.length) process.exitCode = 1;
})().catch(e => { console.error('PRODUCT_GATE_FAIL', e.stack); process.exitCode = 1; });
