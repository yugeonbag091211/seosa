'use strict';
// v3.2 regression tests for the 2026-11-06 online-200 root causes.
// Every case below is a pattern observed in docs/ai-v31-online-200-2026-11-06-*
// and classified in docs/ai-v31-rootcause-2026-11-06/. Titles are real seller
// titles from the read-only catalog evidence (db-oracle.jsonl) or the run.
const assert = require('node:assert/strict');
const intent = require('../api/_ai-v32-intent');
const { principalItem } = require('../api/_ai-v32-listing');
const taxonomy = require('../api/_ai-v31-taxonomy');
const identity = require('../api/_ai-v3-identity');
const retrieval = require('../api/_ai-v31-retrieval');
const core = require('../api/_ai-v3-core');
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + ': ' + String(e.message).slice(0, 400)); }
}
const row = (id, title, lprice, mall = '쿠팡') => ({ productId: id, title, lprice, mall, link: 'https://example.org/' + id, shippingFee: null });
const acceptAll = async ({ candidates }) => ({ productIds: candidates.map(c => c.id) });

(async () => {
  // ── A. intent ────────────────────────────────────────────────────────
  await test('informational questions are not shopping (N193/N194 + controls)', () => {
    for (const q of ['블루투스 코덱 aptX의 원리를 설명해줘', 'OLED 모니터가 LCD와 어떤 차이가 있니?',
      'ANC와 수동 차음의 차이를 알려줘', 'IPS 패널이 무슨 뜻인지 알려줘', '노트북 배터리 수명은 왜 줄어들어?',
      '공기청정기 필터를 얼마나 자주 갈아야 해?', '태블릿이 뭐야?'])
      assert.equal(intent.analyzeUtterance(q).informational, true, q);
    for (const q of ['100만원 이하 태블릿 뭐가 좋아?', '갤럭시 S25 엣지와 S25 기본형 비교해 줘', 'ANC 헤드폰 차이 알려주고 추천해줘'])
      assert.equal(intent.analyzeUtterance(q).informational, false, q);
    assert.equal(intent.analyzeUtterance('제품을 추천해줘서 고마워! 다음에 올게').thanks, true);
  });
  await test('budget words: band, 이내/아래/안에서, exclusive 미만, ranges (N005/N011/N154)', () => {
    const b = q => { const x = intent.parseBudget(q); return [x.min, x.max, x.maxExclusive]; };
    assert.deepEqual(b('헤드폰 7만원대 골라줘'), [70000, 79999, false]);
    assert.deepEqual(b('중고 갤럭시 워치4 3만원대 제품 찾아'), [30000, 39999, false]);
    assert.deepEqual(b('외장 SSD 500GB 8만원 이내 추천'), [null, 80000, false]);
    assert.deepEqual(b('블루투스 마우스 4만원 아래'), [null, 40000, false]);
    assert.deepEqual(b('노트북 본체 50만원 미만'), [null, 500000, true]);
    assert.deepEqual(b('무선 헤드폰 중 11만원부터 15만원 제품 추천'), [110000, 150000, false]);
    assert.deepEqual(b('그중에서 12만원 이상 15만원 이하로 골라줘'), [120000, 150000, false]);
  });
  await test('single-product price comparison is a price lookup (N070)', () => {
    assert.equal(intent.analyzeUtterance('삼성 T9 1TB 외장 SSD 가격 비교해줘').priceLookup, true);
    assert.equal(intent.analyzeUtterance('아이폰 16과 갤럭시 S25 가격 비교해줘').priceLookup, false);
  });
  await test('references to displayed cards include 위에서 (N186) and one-pick wording', () => {
    for (const q of ['그중에서 하나만 선택해줘', '위에서 딱 하나 추천해줘', '그중 가장 좋은 거 하나 추천해줘'])
      assert.equal(intent.analyzeUtterance(q).referencesDisplayed && intent.analyzeUtterance(q).wantsSingle, true, q);
  });
  await test('exclusions come from user words, never IDs or particles (N174/N182/N188)', () => {
    assert.deepEqual(intent.userExclusions('그중 게이밍 제품은 제외해줘'), ['게이밍']);
    assert.deepEqual(intent.userExclusions('할부원금 조건 제외하고 휴대폰 70만원 이하 추천'), ['할부원금']);
    assert.deepEqual(intent.userExclusions('그중 로봇청소기는 빼줘'), ['로봇청소기']);
    assert.deepEqual(intent.userExclusions('게이밍 PC 스피커 RGB 제외하고 추천'), ['RGB']);
    assert.deepEqual(intent.userExclusions('헤드셋 마이크 말고 음악 듣는 헤드폰'), ['헤드셋 마이크']);
    assert.deepEqual(intent.groundExclusions(['쿠팡:9785392067', '제품은', '게이밍'], '그중 게이밍 제품은 제외해줘'), ['게이밍']);
    assert.equal(intent.excludedBy('Machenike L9X1 게이밍 마우스', ['게임용']), '게임용');
  });
  // ── B. head-noun category ────────────────────────────────────────────
  await test('the requested product is the head noun, not the first mention', () => {
    const c = q => taxonomy.explicitType(q);
    assert.equal(c('일렉기타 헤드폰 앰프가 아닌 일반 헤드폰 5만원대'), '헤드폰');
    assert.equal(c('태블릿 말고 키보드 달린 일반 노트북 60만원 이하'), '노트북');
    assert.equal(c('마우스 번들 아닌 독립 무선 키보드 9만원 이하'), '키보드');
    assert.equal(c('스마트폰 앱 연결되는 공기청정기 30만원 이하'), '공기청정기');
    assert.equal(c('헤드폰 앰프 아닌 일렉기타 본체만 검색'), '기타');
    assert.equal(c('노이즈캔슬링 헤드셋 9만원 이하이며 이어폰은 제외'), '헤드폰');
    assert.equal(c('애플 매직 키보드 아이패드 에어 11 호환형 추천'), '키보드');
    assert.equal(c('스마트워치 스트랩 말고 본체 8만원 이하'), '시계');
  });
  await test('guitar and watch requests are recognised; stored "기타" round-trips (N157-N168, N154)', () => {
    assert.equal(taxonomy.explicitType('클래식 기타 15만원 이하 추천해'), '기타');
    assert.equal(taxonomy.explicitType('앰프 없이 기타 본체만 14만원 이하 추천'), '기타');
    assert.equal(taxonomy.explicitType('중고 갤럭시 워치4 3만원대 제품 찾아'), '시계');
    assert.equal(taxonomy.canonicalName('기타'), '기타');
    assert.equal(taxonomy.productTypeMatches('케이투엠 입문용 일렉기타 ELECTRIC GUITAR', '기타', '일렉기타 20만원 이하'), true);
    assert.equal(taxonomy.productTypeMatches('[기타] 욕실매트 발매트 1개', '기타', '기타 본체'), false);
    assert.equal(taxonomy.canonicalCategory({ message: '선물 추천해줘', planCategory: '기타' }), '');
  });
  // ── C. what a listing sells ──────────────────────────────────────────
  await test('principal item: accessories and parts are not devices', () => {
    const acc = t => assert.equal(principalItem(t).kind, 'accessory', t);
    acc('[필터왕국]위닉스 타워XQ500 공기청정기 AGX590W-W5필터 일반형 헤파탈취 2개');
    acc('샤오미 공기청정기 AC-M2-AA 블루 필터 미에어 3C 1+1');
    acc('크린포유 삼성 제트 비스포크AI LED 무선 청소기 슬림 헤드, 1개');
    acc('LG전자 노트북 바닥 지지대 COV37834701');
    acc('[보리보리] 아트박스 POOM 아트박스/쓰리엠 3M 보안 필름 노트북 화면터치 15형 4:3 비율 BP150C3B');
    acc('LG 그램 노트북 핀 타입 19V 이우 2.53A 48 엘지전자');
    acc('[보리보리] 웅진북센 기초부터 연주곡까지 한 권으로 완성하는 올바른 통기타 교본 종합 강습일렉기타 클래식 기타 공통 레슨');
    acc('[하프클럽/알티피아]SD 효도라디오 감미로운 클래식 기타');
    acc('다이슨 v10 튜브 호환 디지털슬림 교체품 다이슨 v12 튜브 청소기');
    acc('[해외] INS 코리아 미피 토끼 심플 옐로우 패션은 아이패드 A16 2024 11인치, 2025 에어 5/4, 10.9인치 아이패드 10, 9.7인치에 적합합니다.');
    // a list of laptop lines names compatible hosts: no device is sold
    assert.notEqual(principalItem('[보리보리] 아트박스 POOM 아트박스/바투카 3D티타늄 40.6cm(16인치) 맥북프로16 그램 갤럭시북5').kind, 'device');
    acc('홈앤힐링 고경도 문턱 경사대 로봇청소기 휠체어 문턱방지턱 1~7cm');
  });
  await test('principal item: devices with included extras or specs stay devices', () => {
    const dev = (t, type) => { const p = principalItem(t); assert.equal(p.kind + ':' + p.type, 'device:' + type, t); };
    dev('보랄 차량용 진공 청소기 전용 노즐 + 보관가방 포함 BR-CV800H', '청소기');
    dev('[씨게이트] 씨게이트 외장하드 2TB OneTouch 외장HDD 스페이스그레이 데이터복구+암호화+파우치 증정', '외장하드');
    dev('로지텍 G304X 무선 게이밍 마우스 USB-C 케이블 별매', '마우스');
    dev('브리츠 PURI5 미니 원룸공기청정기 헤파필터H13 소형', '공기청정기');
    dev('삼성 외장 SSD T7 USB-C 1TB 맥북 호환', '외장하드');
    dev('아이패드 에어 11 M4 M2 M3 프로11 2세대 3세대 4세대 슬림형 키보드 케이스, 1개', '키보드');
    dev('다이슨 V12 오리진 플러피 (니켈/퍼플) /국내배송/정품/ iuy', '청소기');
  });
  await test('ENC call noise reduction is not ANC; app/HEPA/TV features need title evidence', () => {
    assert.equal(taxonomy.productTypeMatches('에먼트 블루투스 6.0 커널형 무선 이어폰 ENC 노이즈캔슬링', '이어폰', 'ANC 무선 이어폰'), false);
    assert.equal(taxonomy.productTypeMatches('[해외] HAYLOU Flowbuds N50 ANC 블루투스 6.0 무선 이어폰 액티브 노이즈 캔슬링', '이어폰', 'ANC 무선 이어폰'), true);
    assert.equal(taxonomy.productTypeMatches('위닉스 제로S 공기청정기 43.1m2', '공기청정기', '스마트폰 앱 연결되는 공기청정기'), false);
    assert.equal(taxonomy.productTypeMatches('벤딕트 스마트 IoT 핀치 미니 공기 청정기 20m2', '공기청정기', '스마트폰 앱 연결되는 공기청정기'), true);
    assert.equal(taxonomy.productTypeMatches('브리츠 BZ-SP200X 컴퓨터 PC 사운드바 스피커', '스피커', 'TV에 연결하는 사운드바 스피커'), false);
  });
  await test('negated mentions are not requirements (N179 robot, rental)', () => {
    assert.equal(taxonomy.productTypeMatches('캐치웰 무선청소기 초경량 스틱 핸디 진공청소기 HC02', '청소기', '그중 로봇청소기는 빼줘'), true);
    assert.equal(taxonomy.productTypeMatches('[렌탈] 삼성 공기청정기렌탈 60개월 52100', '공기청정기', '렌탈 말고 공기청정기'), false);
  });
  await test('multi-model compatibility listings and random assortments are not devices (N048, N050)', () => {
    assert.equal(taxonomy.productTypeMatches('삼성 갤럭시 S25 엣지 플러스 울트라 S24 FE, Z 폴드 7 6 5 4 3 2 플립 7, S23 S22 S21 S21+ S20 FE 5G S10 S10e S9 S8 노트', '스마트폰', '갤럭시 S25 엣지'), false);
    assert.equal(taxonomy.productTypeMatches('초가성비 사무용 노트북 배터리없음(전원연결사용) 랜덤기획전 (삼성,LG,레노버,HP,아수스,에이서,델등), NT200B5B', '노트북', '사무용 노트북'), false);
    assert.equal(taxonomy.productTypeMatches('[해외] BOYA 미니 2 무선 라발리에 핀 마이크 소음 감소 아이폰 6-17 USB-C 안드로이드 스마트폰 PC 라이브 스트리밍용', '스마트폰', '안드로이드 스마트폰'), false);
    assert.equal(taxonomy.productTypeMatches('삼성 갤럭시 A15 LTE 128GB 가개통 미사용 새제품 공기계 SM-A155', '스마트폰', '30만원 이하 새 안드로이드 스마트폰'), true);
  });
  // ── D. identity ──────────────────────────────────────────────────────
  await test('watch and Galaxy Book identities (N145/N151/N152, N059 Pro vs Pro 360)', () => {
    const want = identity.requestedIdentity('갤럭시 워치7 44mm 블루투스 모델 찾아');
    assert.deepEqual(want, { family: 'galaxywatch', series: '7', network: 'bluetooth', caseMm: 44 });
    assert.equal(identity.checkListingIdentity('삼성전자 갤럭시워치7 44mm SM-L315 가개통 미개봉 블루투스용', want).ok, true);
    assert.equal(identity.checkListingIdentity('삼성 갤럭시워치8 44mm 블루투스 실버 SM-L330', want).ok, false);
    const book = identity.requestedIdentity('삼성 갤럭시북5 프로 16인치 본체 추천해 줘');
    assert.equal(identity.checkListingIdentity('[와멤데 전용특가]삼성 갤럭시북5 프로360 NT960QHA 16인치', book).ok, false);
    assert.equal(identity.checkListingIdentity('삼성전자 갤럭시북5 프로 NT960XHA-K51A 인텔 울트라5 16인치', book).ok, true);
  });
  await test('screen size from cm and marketing classes; "테라" storage (N079, N062/N069)', () => {
    assert.equal(identity.checkListingIdentity('LG전자 WFHD 울트라와이드 모니터, 86.7cm, 34WP550', { screenInches: 34 }, { category: '모니터' }).ok, true);
    assert.equal(identity.checkListingIdentity('인터픽셀 32인치 80cm', { screenInches: 32 }, { category: '모니터' }).ok, true);
    assert.equal(identity.checkListingIdentity('삼성 갤럭시북4 15.6인치', { screenInches: 16 }, { category: '노트북' }).ok, false);
    assert.equal(identity.requestedIdentity('외장하드 진짜 2테라 하드').storageGb, 2048);
  });
  // ── E. brands and model codes ────────────────────────────────────────
  await test('brand matching is boundary-aware and category-aware (N136, N095, N092)', () => {
    assert.equal(retrieval.brandMatches('보노보스 2.1채널 우퍼 컴퓨터 PC용 게이밍 앰프 스피커', '보스 블루투스 스피커', '스피커'), false);
    assert.equal(retrieval.brandMatches('코스트코 보스 사운드링크 플렉스 SE 2세대 블루투스 스피커', '보스 블루투스 스피커', '스피커'), true);
    assert.deepEqual(retrieval.brandsFromUser('아이패드 에어 11 M4 키보드 케이스만 찾아줘', '키보드'), []);
    assert.equal(retrieval.brandMatches('DUNNO 아이패드 에어 13 M4 블루투스 키보드 케이스', '애플 매직 키보드', '키보드'), false);
    assert.deepEqual(retrieval.brandsFromUser('아이폰 호환 블루투스 이어폰 7만원 이하', '이어폰'), []);
  });
  await test('model phrases are verified token-wise with variant suffixes (N022, N061, N134, N148)', () => {
    const ok = (t, u) => retrieval.modelEvidence(t, u).ok;
    assert.equal(ok('[현대백화점] [소니] 소니 노이즈캔슬링 무선 이어폰 WF-C700N', '소니 WF-C700N 이어버드 본체를 찾아줘'), true);
    assert.equal(ok('삼성전자 외장 SSD T7 2TB 외장하드', '삼성 T7 Shield 2TB 외장 SSD'), false);
    assert.equal(ok('삼성/포터블 외장SSD T7실드 2TB (인증점)', '삼성 T7 Shield 2TB 외장 SSD'), true);
    assert.equal(ok('[기타] 제이비엘 플립 에센셜 3 포터블 스피커', 'JBL Flip 6 무선 스피커'), false);
    assert.equal(ok('샤오미 레드미 워치5 액티브', '샤오미 레드미 워치 5 스마트워치'), false);
    assert.equal(ok('Apple 2024 에어팟 4 액티브 노이즈 캔슬링 블루투스 이어폰', '에어팟 4 ANC 완제품 추천'), true);
    assert.equal(ok('로지텍 MX Keys Mini 무선 키보드', '로지텍 MX Keys S 무선 키보드'), false);
    assert.equal(ok('899번 아수스 15인치 UHD 업무용 사무용 노트북', 'ASUS 비보북 60만원 이하 신품 노트북'), false);
  });
  // ── F. engine ────────────────────────────────────────────────────────
  await test('explanation questions never search even when the planner asks to (N194)', async () => {
    let searched = false;
    const out = await core.createEngine({
      planModel: async () => ({ mode: 'recommend', query: 'OLED 모니터', category: '모니터' }),
      searchProducts: async () => { searched = true; return []; }, decideModel: acceptAll
    }, { message: 'OLED 모니터가 LCD와 어떤 차이가 있니?' });
    assert.equal(searched, false);
    assert.equal(out.stats.searched, false);
  });
  await test('"X 가격 비교" of one product searches and lists sellers by price (N070)', async () => {
    const listings = [row('a', '삼성전자 삼성 포터블 외장SSD T9 USB 3.2 Gen 2x2 공식인증 (정품), 1TB 블랙, 1TB', 332000),
      row('b', '[클릭시 5% 쿠폰] 삼성전자 포터블 외장SSD T9 1TB USB 3.2 Gen 2x2 MU-PG1T0B/WW (정품)', 298300, 'ADPICK')];
    const out = await core.createEngine({
      planModel: async () => ({ mode: 'compare', query: '삼성 T9 1TB 외장 SSD', compareQuery: '', category: '외장 SSD' }),
      searchProducts: async () => listings, decideModel: acceptAll
    }, { message: '삼성 T9 1TB 외장 SSD 가격 비교해줘' });
    assert.equal(out.stats.searched, true);
    assert.deepEqual(out.cards.map(c => c.price), [298300, 332000]);
    assert.match(out.answer, /298,300원~332,000원/);
  });
  await test('an unresolved request keeps the budget the user just stated (N162/N167 state)', async () => {
    const out = await core.createEngine({
      planModel: async () => ({ mode: 'recommend', query: '', category: '' }),
      searchProducts: async () => { throw new Error('no search'); }, decideModel: acceptAll
    }, { message: '이거 15만원 이하로 추천해' });
    assert.equal(out.stats.searched, false);
    assert.equal(out.state.maxPrice, 150000);
  });
  await test('그중 follow-ups re-validate the cards shown last turn by ID (N174/N179/N182/N188)', async () => {
    const shown = [row('m1', '빅트랙 FHD 165Hz 컨커 게이밍 모니터', 109400), row('m2', 'ZSUS 휴대용 모니터 16 inch IPS FHD', 88200),
      row('m3', '제우스랩 FHD 포터블 게이밍 모니터', 149000), row('m4', '크로스오버 245F199 IPS FHD 사무용 모니터', 83000)];
    const ids = shown.map(r => '쿠팡:' + r.productId);
    let searched = 0;
    const deps = {
      // The planner copies displayed IDs into exclusions, as GPT did live.
      planModel: async () => ({ mode: 'recommend', query: '모니터', category: '모니터', exclusions: ids }),
      searchProducts: async () => { searched++; return []; }, decideModel: acceptAll,
      loadDisplayed: async want => shown.filter(r => want.includes('쿠팡:' + r.productId))
    };
    const state = { lastQuery: '모니터', category: '모니터', maxPrice: 200000, presentedProductIds: ids, exclusions: [] };
    const out = await core.createEngine(deps, { message: '그중 10만원 이상인 것만 골라줘', state });
    assert.equal(searched, 0);
    assert.deepEqual(out.cards.map(c => c.price), [109400, 149000]);
    assert(!out.state.exclusions.some(x => x.includes(':')));
    const one = await core.createEngine({ ...deps, decideModel: async ({ candidates }) => ({ productIds: [candidates[1].id] }) },
      { message: '그중 하나만 남겨줘', state: out.state });
    assert.equal(one.cards.length, 1);
    assert.equal(one.cards[0].price, 149000);
    const gaming = await core.createEngine(deps, { message: '그중 게이밍 제품은 제외해줘', state });
    assert.deepEqual(gaming.cards.map(c => c.price), [88200, 83000]);
  });
  await test('comparison keeps one card per side even if GPT picks only side A (N048 class)', async () => {
    const a = [1, 2, 3, 4].map(i => row('e' + i, '삼성전자 갤럭시 S25 Edge 자급제 SM-S937N ' + i, 999000 + i));
    const b = [row('b1', '삼성전자 갤럭시 S25 자급제 SM-S931N', 725810)];
    const out = await core.createEngine({
      planModel: async () => ({ mode: 'compare', query: '갤럭시 S25 엣지', compareQuery: '갤럭시 S25 기본형', category: '스마트폰' }),
      searchProducts: async q => (q.includes('엣지') ? a : b),
      decideModel: async ({ candidates }) => ({ productIds: candidates.filter(c => c.id.includes(':e')).map(c => c.id) })
    }, { message: '갤럭시 S25 엣지와 S25 기본형 비교해 줘' });
    assert.equal(out.cards.length, 2);
    assert.equal(out.cards[1].price, 725810);
  });
  await test('a price far below the same identity market is not offered (N043/N064 risk)', async () => {
    const listings = [row('cheap', '고속 전송 USB3.0 + Type-C 2TB 외장하드 대용량 초고속 휴대용 저장장치', 35800),
      row('wd', '[WD공식스토어]WD NEW My Passport 2TB 외장하드', 179000), row('sg', '씨게이트 외장하드 2TB OneTouch 외장HDD', 189000),
      row('ts', '도시바 칸비오 외장하드 어드밴스 2세대 2TB', 185000)];
    const out = await core.createEngine({
      planModel: async () => ({ mode: 'recommend', query: '2TB 외장하드', category: '외장하드', maxPrice: 200000 }),
      searchProducts: async () => listings, decideModel: acceptAll
    }, { message: '2TB 외장하드 20만원 이하' });
    assert(!out.cards.some(c => c.price === 35800));
    assert.equal(out.stats.rejectedReasons.price_outlier_low, 1);
  });
  await test('fitted iPad keyboard case: set-membership compatibility, not "11색" (N092)', () => {
    const host = { family: 'ipad', variant: 'air', screenInches: 11, chip: 'm4' };
    assert.equal(core.compatibilityEvidence('아이패드 에어 11 M4 M2 M3 프로11 2세대 3세대 4세대 슬림형 키보드 케이스', host).ok, true);
    assert.equal(core.compatibilityEvidence('한국형 아이패드 에어 13인치 (M4/M3/M2) & 프로 12.9인치 한글각인 키보드 케이스, 11색 백라이트', host).ok, false);
  });
  console.log(JSON.stringify({ passed, failed, total: passed + failed }));
  if (failed) process.exitCode = 1;
})().catch(e => { console.error('Unexpected test failure:', e); process.exitCode = 1; });
