'use strict';
/*
 * 상품 정체성 관문 (product identity gate) — 2026-11-15 검색 재구축.
 *
 * 물음 하나에만 답한다: «이 판매 글이 사용자가 찾은 바로 그 상품인가?»
 *
 * ── 왜 새 파일인가 ──────────────────────────────────────────────────
 *
 *   같은 물음에 답하는 규칙이 다섯 군데에 흩어져 있었다.
 *     api/_search.js            관련도 점수(토큰 커버리지·핵심 명사·변형·상태)
 *     api/_ai-v31-taxonomy.js   AI 카드용 닫힌 기기 분류(16종)와 부품 규칙
 *     api/_ai-v32-listing.js    상품명 머리 명사로 «무엇을 파는가»
 *     api/_ai-v34-listing-guards.js  도서·약정가·묶음·키워드 도배
 *     api/_shop.js              matchesKeyword — 토큰 하나만 맞아도 통과
 *   /api/search 는 그중 점수만 썼고(minScore:0), 저장은 토큰 하나 규칙만 썼다. 그래서
 *   «아이패드 10세대» 에 매직키보드가 1.00 으로 서고, «수영복» 키워드로 콜라가 저장됐다.
 *
 *   이 파일은 위 모듈을 «판정 순서» 로 엮고, 빠져 있던 일반 규칙(같은 제품군 안의
 *   번호·세대·변형 충돌, 저장 용량, 브랜드·제품군 이름, 여러 모델을 한 글에 담은 판매 글,
 *   «X 전용 Y» 구조, 기록 행 분류)을 더한다. 특정 상품명·상품 ID 예외는 없다.
 *
 * ── 판정 등급 ──────────────────────────────────────────────────────
 *
 *   hard  틀린 상품이거나, 사용자가 분명히 말한 정체(모델 번호·세대·변형·용량·색상)를
 *         상품명이 증명하지 못한다 → 보여 주지도, 저장하지도 않는다
 *   soft  정체는 맞는데 부수 정보가 비어 있다(브랜드 표기 없음, 크기 미표기, 중고 등)
 *         → 보여 주되 «확인된» 상품 뒤에 둔다(identity:'unverified')
 *
 *   «다르다» 는 근거가 있거나 «정체 조건이 증명되지 않으면» hard. 가격 비교 서비스에서
 *   256GB 를 찾은 사람에게 용량이 안 적힌 글의 가격을 그 상품의 최저가로 보여 주면 안 된다.
 *
 * ── 쓰는 곳 ───────────────────────────────────────────────────────
 *   api/search.js           표시 전 판정·정렬(parseQuery → rankText → gateItems)
 *   api/_shop.js            saveProducts 저장 전 판정(saveFilter) · relevantRows 표시 판정(classifyStoredRow)
 *   api/ai.js               AI 검색 결과 저장(saveProducts 경유)
 *   scripts/collect-*.js    가격은 갱신하되 분류가 틀린 행은 카탈로그 갱신을 보류(classifyStoredRow)
 *   scripts/db-quality/*    운영 DB 오염 진단(읽기 전용)
 *
 * 네트워크·DB 를 쓰지 않는다. 순수 함수다.
 */

const S = require('./_search');
const TAX = require('./_ai-v31-taxonomy');
const LST = require('./_ai-v32-listing');
const LG = require('./_ai-v34-listing-guards');
const { BRANDS, aliasRegex } = require('./_ai-v32-brands');
const { listsManyModels } = require('./_ai-v3-identity');

const normalize = s => S.normalizeText(s);

/* ------------------------------------------------------------------ *
 *  어휘 — 상품 고유 이름이 아니라 «구조» 를 읽기 위한 말들
 * ------------------------------------------------------------------ */

// 같은 제품군 안에서 다른 상품을 가르는 변형 표기. 한/영은 같은 키로 묶는다.
const VARIANT = new Map(Object.entries({
  pro: 'pro', 프로: 'pro', max: 'max', 맥스: 'max', ultra: 'ultra', 울트라: 'ultra',
  plus: 'plus', 플러스: 'plus', air: 'air', 에어: 'air', mini: 'mini', 미니: 'mini',
  fe: 'fe', se: 'se', lite: 'lite', 라이트: 'lite', edge: 'edge', 엣지: 'edge',
  slim: 'slim', 슬림: 'slim', ti: 'ti', super: 'super', xl: 'xl', neo: 'neo', 네오: 'neo',
  oled: 'oled', flip: 'flip', 플립: 'flip', fold: 'fold', 폴드: 'fold', classic: 'classic', 클래식: 'classic'
}));
// 한 낱말에 두 변형이 붙은 표기 ("Promax", "프로맥스")
const VARIANT_COMPOUND = new Map(Object.entries({ promax: ['pro', 'max'], 프로맥스: ['pro', 'max'], 프로플러스: ['pro', 'plus'] }));
// 제품군(라인) 이름. 뒤에 오는 번호·변형이 그 상품의 정체다. 표기 차이는 같은 키로 묶는다.
const LINE = new Map(Object.entries({
  아이폰: 'iphone', iphone: 'iphone', 아이패드: 'ipad', ipad: 'ipad', 갤럭시: 'galaxy', galaxy: 'galaxy',
  탭: 'tab', tab: 'tab', 북: 'book', book: 'book', 워치: 'watch', watch: 'watch', 버즈: 'buds', buds: 'buds',
  에어팟: 'airpods', airpods: 'airpods', 맥북: 'macbook', macbook: 'macbook', 그램: 'gram', gram: 'gram',
  픽셀: 'pixel', pixel: 'pixel', 스위치: 'switch', switch: 'switch', 시리즈: 'series', series: 'series',
  히어로: 'hero', hero: 'hero', 모멘텀: 'momentum', momentum: 'momentum',
  오디세이: 'odyssey', odyssey: 'odyssey', 미밴드: 'miband', 밴드: 'band', band: 'band', rtx: 'rtx', gtx: 'gtx',
  아이디어패드: 'ideapad', ideapad: 'ideapad', 비보북: 'vivobook', vivobook: 'vivobook', 젠북: 'zenbook', zenbook: 'zenbook',
  씽크패드: 'thinkpad', thinkpad: 'thinkpad', 서피스: 'surface', surface: 'surface', 리전: 'legion', legion: 'legion',
  레드미: 'redmi', redmi: 'redmi', 요가: 'yoga', yoga: 'yoga', 인스피론: 'inspiron', inspiron: 'inspiron',
  파빌리온: 'pavilion', pavilion: 'pavilion', 플레이스테이션: 'playstation', playstation: 'playstation',
  버디: 'buddy', buddy: 'buddy', 퓨리케어: 'puricare', puricare: 'puricare', 울트라기어: 'ultragear', ultragear: 'ultragear',
  비스포크: 'bespoke', bespoke: 'bespoke', 오즈모: 'osmo', osmo: 'osmo', 포켓: 'pocket', pocket: 'pocket'
}));
// «노트북»·«넷북» 은 범주 낱말이지 «북» 제품군이 아니다.
const NOT_LINE_COMPOUND = /^(?:노트북|넷북|이북|e북|전자책|페이스북|스케치북|가이드북|핸드북|워크북|레슨북|헤어밴드|고무밴드|머리밴드|손목밴드|요가밴드|스마트밴드)$/;
// 같은 제품군 키를 갖는 표기들 («galaxy» ↔ «갤럭시») — 엄격 비교에서도 서로 같은 이름이다.
const LINE_WORDS_BY_KEY = (() => {
  const m = new Map();
  for (const [word, key] of LINE) { if (!m.has(key)) m.set(key, []); m.get(key).push(word); }
  return m;
})();
const lineKey = t => LINE.get(t) || (NOT_LINE_COMPOUND.test(t) ? '' : /(?:탭|tab)$/.test(t) && t.length > 2 ? 'tab'
  : /(?:북|book)$/.test(t) && t.length > 2 ? 'book' : /(?:워치|watch)$/.test(t) && t.length > 2 ? 'watch'
  : /(?:밴드|band)$/.test(t) && t.length > 2 ? 'band' : '');
// 제품군 이름과 고유 이름의 다른 표기 — 한글 음역 ↔ 영문, 옛 이름 ↔ 새 이름. 상품 예외가 아니라 표기 쌍이다.
const ALIASES = new Map(Object.entries({
  미밴드: ['스마트밴드', 'miband', 'mi band', 'smart band', 'smartband'], 데스애더: ['deathadder', 'death adder'],
  바이퍼: ['viper'], 튠: ['tune'], 모멘텀: ['momentum'], 오즈모: ['osmo'], 포켓: ['pocket'], 퀜처: ['quencher'],
  카본: ['carbon'], 파빌리온: ['pavilion'], 슈퍼라이트: ['superlight'], 마스터: ['master'], 애니웨어: ['anywhere'],
  키즈: ['keys', 'kids'], 디텍트: ['detect'], 앱솔루트: ['absolute'], 오리진: ['origin'], 퓨리케어: ['puricare'],
  울트라기어: ['ultragear'], 오디세이: ['odyssey'], 비스포크: ['bespoke'], 제트: ['jet'], 큐레보: ['qrevo'], 레볼루션: ['revolution', 'qrevo'],
  스튜디오: ['studio'], 에센셜: ['essential'], 하이퍼스피드: ['hyperspeed'], 라이트스피드: ['lightspeed'], 히어로: ['hero'],
  삼바: ['samba'], 척테일러: ['chuck taylor', 'chuck 70'], 스페지알: ['spezial'], 가젤: ['gazelle'], 덩크: ['dunk'],
  에어포스: ['air force', 'airforce'], 에어랩: ['airwrap'], 슈퍼소닉: ['supersonic'], 코랄: ['corrale'], 바리오: ['vario'],
  디스크: ['disc', 'disk', '디스크'], 디지털: ['digital'], 에디션: ['edition'], 카타나: ['katana'], 오멘: ['omen'],
  빅터스: ['victus'], 리전: ['legion'], 젠북: ['zenbook'], 비보북: ['vivobook'], 아이디어패드: ['ideapad'], 씽크패드: ['thinkpad'],
  샤오신: ['xiaoxin'], 스펙터: ['spectre'], 엔비: ['envy'], 크롬북: ['chromebook'], 서피스: ['surface']
}));

// 번호 뒤에 붙으면 «정체» 가 아니라 «속성» 이 되는 단위.
const UNIT_AFTER = new Set(['인치', '형', '인', '인용', '인분', '단', 'l', '리터', 'mm', 'cm', 'm', 'kg', 'g', 'w', 'kw',
  'gb', 'tb', '기가', '테라', '개', '매', '입', '세트', '팩', '구', '종', '년', '월', '일', '만', '천', '원', '시간', '분',
  'hz', 'mah', 'v', 'a', '도어', '평', 'ml', '미터', 'p', 'ea', '켤레', '족', '장', '롤', '겹', '호', '단계', '미리', '포트',
  '등급', '차', '위', '명', '대', '마리', '알', '봉', '캔', '병', '박스', '롤', '미터']);
const GEN_AFTER = new Set(['세대', 'gen', 'th', 'nd', 'rd', 'st']);
// 번호 사이에 끼어도 무시하는 판매 문구 ("그램 프로 AI 17")
const RUN_SKIP = new Set(['ai', 'new', '신형', '정품', '국내정품', '2in1', '플러스']);

// 머리 명사로 쓰지 않는 말 — 수식어·판매 문구·상태·묶음어.
const NOT_HEAD = new Set(['추천', '제품', '상품', '용품', '소품', '선물', '선물세트', '굿즈', '잡화', '아이템', '모음', '및',
  '모델', '에디션', 'edition', '버전', 'version', '최신', '최신형',
  '정품', '새', '신품', '새상품', '새제품', '가성비', '인기', '저렴한', '싼', '최저가', '가격', '중', '것', '거', '걸로', '용',
  '세대', '시리즈', '단품', '본품', '세트', '무선', '유선', '블루투스', '게이밍', '게임용', '휴대용', '남성', '여성', '남자', '여자',
  '아동', '키즈', '유아', '성인', '공용', '남녀공용', '대용량', '소형', '대형', '초경량', '경량', '고급', '프리미엄',
  '노이즈캔슬링', '저소음', '무소음', '가열식', '초음파식', '스탠드형', '접이식', '자동', '미니', '롱', '숏', '오버핏']);
const ADJECTIVE_END = /(?:운|한|은|는|던|된|진|인|할|일|울)$/;
// 대화체 낱말 — 상품 이름이 아니다 (AI 대화의 «맥북 프로 얼마야», «그중에 제일 싼 것», «가격 조금 넘어도»).
const CHAT_STOP = new Set(['얼마', '얼마야', '얼마예요', '얼마에요', '얼마인지', '있으면', '있나요', '있을까', '그중', '그중에', '그중에서',
  '제일', '가장', '싼거', '싼것', '비싼', '좋은', '좋은거', '넘어도', '넘으면', '조금', '좀더', '질문은', '질문', '혹시', '이거', '그거',
  '저거', '이건', '그건', '일반형', '기본형', '기본', '일반', '새거', '알려줘', '보여줘', '찾아줘', '추천', '해줘', '바꿔줘', '말고는',
  '본체', '본체만', '본품만', '단품만', '자체', '정품만', '신품만',
  // 범주의 윗말·수량 단위 — 상품명에 그대로 적히지 않는다 («자외선 차단 의류» ↔ «… 가디건», «퍼즐 100피스»)
  '의류', '식품', '가전', '가구', '생활용품', '주방용품', '욕실용품', '캠핑용품', '차량용품', '사무용품', '피스', '개입', '구성',
  '어때', '어떄', '뭐야', '뭐가', '나아', '괜찮아', '살까', '사도', '돼', '될까', '다시', '그럼', '아니', '네', '응', '음']);
NOT_HEAD.add && CHAT_STOP.forEach(w => NOT_HEAD.add(w));

// 본품 검색에서 «이건 그 부속이다» 로 단정해도 되는 판매 대상 명사 (어느 범주에서나 부속).
const UNIVERSAL_ACCESSORY = /^(?:케이스|커버|필름|보호\s*필름|강화\s*유리|보안기|키\s*스킨|스킨|파우치|슬리브|거치대|받침(?:대)?|지지대|충전기|충전\s*독|충전\s*케이블|케이블|어댑터|젠더|스트랩|(?:워치|시계|watch)\s*(?:밴드|줄|스트랩)|이어\s*팁|이어\s*패드|이어\s*캡|키캡|팜\s*레스트|손목\s*받침|마우스\s*패드|펜촉|리필|교체품|호환품|media|replacement_part|fits_sentence|브라켓|브래킷|마운트|홀더|리모컨|리시버|동글|도킹\s*스테이션|도킹|허브|소모품|부품|수리|액정|lcd|어셈블리|프레임|힌지|하판|상판|정리대|보관대|수납장|장식장|악세(?:서|사)리|액세서리|쿨러|쿨링\s*팬|s\s*펜|펜슬|터치\s*펜|스타일러스)$/i;
// 범주에 따라 본품의 기능 표기일 수도 있는 부속 명사 — 두 번째 근거가 있어야 hard.
const AMBIGUOUS_ACCESSORY = /^(?:필터|배터리|브러시|브러쉬|노즐|롤러|걸레|물걸레\s*패드|먼지\s*봉투|더스트\s*백|헤드|모듈|스크린|튜브|호스|연장관|매트|스탠드|팁|플러그|마이크|렌즈)$/i;
// 범주가 정해지지 않은 검색에서도 «다른 물건을 판다» 고 볼 머리 명사(_ai-v32-listing STRONG_ACCESSORY 와 같은 계열)
const STRONG_OTHER = /^(?:필름|보호\s*필름|강화\s*유리|보안기|키\s*스킨|가방|백팩|파우치|슬리브|크로스\s*백|메신저\s*백|충전기|어댑터|거치대|받침(?:대)?|지지대|스트랩|리시버|세제|세정제|경사대|정리대|화분|수납장|허브|악세(?:서|사)리|액세서리)$/i;
const PART_MARK = /(?:호환|교체|교체용|리필|단품|\d+\s*(?:개|입|매|팩|세트|p|ea)\b|\d+\s*(?:개|입|매|팩|세트)(?=\s|,|$)|\(\s*\d+\s*(?:개|입|매)\s*\))/i;
// 본품에 딸려 오는 구성품 표기. 지우고 나서 부품 규칙을 본다.
const BUNDLE_PHRASE = /(?:\+\s*)?(?:정품\s*)?(?:케이스|커버|필름|보호\s*필름|충전기|어댑터|케이블|파우치|스트랩|이어\s*팁|펜슬|키보드|마우스|거치대|스탠드|리모컨|사은품|자물쇠|빨대|패드|필터|브러시|노즐|헤드)\s*(?:포함|증정|동봉|제공|구성|탑재|내장|장착|무료\s*증정|기본\s*제공)/gi;

// «X 전용 Y» · «X 입을 때 Y» — X 는 대상이고 Y 를 판다. 머리 명사 바로 뒤 낱말로 본다.
const RELATION_NEXT = /^(?:전용|호환|용|위한|입을때|입을|입는|쓸|쓰는|넣는|담는|걸이|꽂이|거치|거치대|받침|받침대|보관|보관함|수납|수납함|정리|정리함|정리대|세척|세척솔|세척기|청소용|청소|건조|건조대|살균|살균기|커버|케이스|파우치|가방|망|디스펜서|리필|교체|교체용|필터|패드|스티커|밴드|스트랩|끈|선반|랙|트레이|덮개|세제|린스|세정제|클리너|네임택|자물쇠|키링|이어후크|이어훅|냉각팬|쿨러|쿨링팬|부품|모터|펌프)$/;
// 머리 명사 «뒤 어디든» 마지막 물건 명사로 오면 그것을 판다고 볼 낱말 (상품명은 머리 명사가 끝에 온다)
const TAIL_OBJECT_WORDS = ['네임택', '자물쇠', '키링', '이어후크', '이어훅', '냉각팬', '쿨링팬', '쿨러', '선반', '덮개', '세척솔',
  '세정제', '클리너', '디스펜서', '정리함', '보관함', '걸이', '꽂이', '거치대', '받침대', '파우치', '케이스', '커버', '필름', '스티커',
  '가방', '드라이백', '망', '부품', '린스', '세제'];
const TAIL_OBJECT = new RegExp(`^(?:${TAIL_OBJECT_WORDS.join('|')})$`);
const endsWithTailObject = t => TAIL_OBJECT.test(t) || TAIL_OBJECT_WORDS.some(w => w.length >= 2 && t.length > w.length && t.endsWith(w));
// 한 낱말 안에 붙은 대상 표시 ("수영복용", "텀블러전용")
const RELATION_SUFFIX = /(?:용|전용|호환)$/;
// 여러 모델·상품을 한 글에서 고르게 하는 판매 글 — 가격이 어느 상품의 것인지 알 수 없다.
const COLLECTION = /(?:총\s*모음|모음전|모음\s*(?:특가|기획)|(?<![가-힣])모음(?=$|\s|[\])])|모아\s*보기|기획전|골라\s*담기|택\s*1(?!\d)|택일|옵션\s*선택|모델\s*선택|색상\s*선택\s*(?:가능)?\s*모델|랜덤\s*(?:발송|모델)|\d+\s*종\s*(?:중\s*)?택|외\s*(?:최대\s*)?(?:혜택가?|특가|할인|\d+\s*종))/;
const COMPATIBLE_PART = /(?:호환\s*(?:제품|상품|부품|소모품)|호환용|호환품|교체용\s*(?:헤드|모|필터|브러시|배터리)|정품\s*아님|비정품)/;
const KIDS = /(?:아동|키즈|유아|주니어|남아|여아|토들러|베이비|아기|어린이|kids?|junior|toddler|baby)/i;
// 노트북 검색에서 노트북이 아닌 PC 부품
const PC_COMPONENT = /(?:그래픽\s*카드|그래픽카드|\bvga\b|메인\s*보드|메인보드|파워\s*서플라이|\bpsu\b|cpu\s*쿨러|데스크\s*탑\s*본체|데스크탑\s*본체|조립\s*pc|미니\s*pc|모니터\s*암|램\s*단품|ram\s*단품)/i;
// 집 안 가전 검색에 차량 전용 제품 (_ai-v31-taxonomy HOME_ONLY 와 같은 규칙)
const CAR_ONLY = /(?:차량용|자동차용|차량\s*전용|차량\s*거치)/;

// 소비재 브랜드(전자기기 브랜드는 _ai-v32-brands.BRANDS). 표기 쌍만 둔다 — 상품 예외가 아니다.
const EXTRA_BRANDS = [
  ['나이키', ['나이키', 'nike']], ['아디다스', ['아디다스', 'adidas']], ['뉴발란스', ['뉴발란스', 'new balance', 'newbalance']],
  ['컨버스', ['컨버스', 'converse']], ['크록스', ['크록스', 'crocs']], ['반스', ['반스', 'vans']], ['퓨마', ['퓨마', 'puma']],
  ['아식스', ['아식스', 'asics']], ['휠라', ['휠라', 'fila']], ['노스페이스', ['노스페이스', 'north face', 'northface']],
  ['아레나', ['아레나', 'arena']], ['배럴', ['배럴', 'barrel']], ['스탠리', ['스탠리', 'stanley']],
  ['락앤락', ['락앤락', 'locknlock', 'lock&lock', 'lock lock']], ['써모스', ['써모스', 'thermos']], ['조지루시', ['조지루시', 'zojirushi']],
  ['쿠첸', ['쿠첸', 'cuchen']], ['테팔', ['테팔', 'tefal']], ['브라운', ['braun']], ['오랄비', ['오랄비', 'oral-b', 'oralb', 'oral b']],
  ['파나소닉', ['파나소닉', 'panasonic']], ['드롱기', ['드롱기', 'delonghi', "de'longhi"]], ['네스프레소', ['네스프레소', 'nespresso']],
  ['캐논', ['캐논', 'canon']], ['니콘', ['니콘', 'nikon']], ['후지필름', ['후지필름', 'fujifilm']], ['고프로', ['고프로', 'gopro']],
  ['DJI', ['dji']], ['닌텐도', ['닌텐도', 'nintendo']], ['레이저', ['레이저', 'razer']], ['에코백스', ['에코백스', 'ecovacs']],
  ['헬리녹스', ['헬리녹스', 'helinox']], ['샥즈', ['샥즈', 'shokz']], ['쿠쿠', ['쿠쿠', 'cuckoo']], ['신일', ['신일', 'shinil']],
  ['한일', ['한일전기', 'hanil']], ['보국', ['보국전자', 'bokuk']], ['위니아', ['위니아', 'winia']], ['에브리봇', ['에브리봇', 'everybot']],
  ['소니', ['소니', 'sony']], ['플레이스테이션', ['플레이스테이션', 'playstation', 'ps5', 'ps4']]
];

const BRAND_TABLE = (() => {
  const out = [];
  for (const [canon, company, lines] of BRANDS) {
    out.push({ canon, company: company.slice(), lines: Object.keys(lines || {}), lineCats: lines || {} });
  }
  for (const [canon, aliases] of EXTRA_BRANDS) {
    const have = out.find(b => b.canon === canon);
    if (have) { aliases.forEach(a => { if (!have.company.includes(a)) have.company.push(a); }); continue; }
    out.push({ canon, company: aliases, lines: [], lineCats: {} });
  }
  return out;
})();
const aliasCache = new Map();
function aliasRe(alias) {
  let re = aliasCache.get(alias);
  if (!re) {
    // 짧은 라틴 별칭(LG, HP)은 낱말 경계로, 한글은 그대로 찾는다 (_ai-v32-brands.aliasRegex 와 같은 규칙).
    try { re = aliasRegex(alias); } catch (_) { re = new RegExp(alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    aliasCache.set(alias, re);
  }
  return re;
}
function brandsIn(text, { includeLines = true } = {}) {
  const t = String(text || '');
  const found = [];
  for (const b of BRAND_TABLE) {
    const company = b.company.some(a => aliasRe(a).test(t));
    const line = includeLines && b.lines.find(a => aliasRe(a).test(t));
    if (company || line) found.push({ canon: b.canon, viaLine: !company && !!line, line: line || '' });
  }
  return found;
}
function brandAliases(canon) {
  const b = BRAND_TABLE.find(x => x.canon === canon);
  return b ? b.company.concat(b.lines) : [canon];
}
const isBrandToken = t => BRAND_TABLE.some(b => b.company.concat(b.lines).some(a => normalize(a).replace(/\s+/g, '') === t));

// 색상 (listing guards 의 표에 애플·삼성 색 이름을 더했다). «블루투스» 의 «블루» 는 색이 아니다.
const COLOR_TABLE = [
  ['black', /(?:블랙|검정|검은색|black|미드나잇\s*블랙|팬텀\s*블랙)/i], ['white', /(?:화이트|흰색|하얀|white)/i],
  ['silver', /(?:실버|은색|silver)/i], ['gray', /(?:그레이|회색|gray|grey|그라파이트|graphite)(?!지)/i],
  ['spacegray', /(?:스페이스\s*그레이|space\s*gr[ae]y)/i], ['midnight', /(?:미드나이트|미드나잇|midnight)(?!\s*블랙)/i],
  ['starlight', /(?:스타라이트|starlight)/i], ['blue', /(?:블루(?!투스|에어)|파란색|파랑|blue(?!tooth|air)|네이비|navy)/i],
  ['pink', /(?:핑크|분홍|pink)/i], ['mint', /(?:민트|mint)/i], ['purple', /(?:퍼플|보라|purple|라벤더|lavender|라일락|lilac)/i],
  ['green', /(?:그린|초록|green)/i], ['red', /(?:레드(?!미)|빨간|red\b)/i], ['gold', /(?:골드|gold)/i], ['beige', /(?:베이지|beige|크림|cream)/i],
  ['orange', /(?:오렌지|orange)/i], ['titanium', /(?:티타늄|titanium)/i]
];
const COLOR_WORDS = new RegExp(COLOR_TABLE.map(([, re]) => re.source).join('|'), 'i');
function colorsIn(text) {
  const s = String(text || '');
  const out = [];
  for (const [name, re] of COLOR_TABLE) {
    const m = re.exec(s);
    if (!m) continue;
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 8);
    if (/^\s*(?:은|는|이|가)?\s*(?:제외|말고|빼고|아닌|싫)/.test(after)) continue;
    out.push(name);
  }
  // 겹치는 이름: «스페이스 그레이» 는 그레이가 아니다
  return out.includes('spacegray') ? out.filter(c => c !== 'gray') : out;
}

// 머리 명사 동의어 (범주 낱말의 표기 차이). _search.SYNONYMS 에 없는 생활·패션 범주만 더한다.
const HEAD_SYNONYMS = [
  ['의상', '코스튬', 'costume', '옷', '코스프레'], ['운동화', '스니커즈', 'sneakers', '러닝화', '신발', '슈즈'],
  ['모자', '캡', '볼캡', '햇', 'hat', 'cap'], ['수건', '타월', 'towel'], ['우산', '양우산', 'umbrella'],
  ['청바지', '데님', 'jeans', 'jean'], ['니트', '스웨터', 'knit', 'sweater'], ['후드티', '후드', '후디', 'hoodie'],
  ['맨투맨', '스웨트셔츠', 'sweatshirt'], ['화장지', '휴지', '두루마리'], ['패딩', '다운', 'puffer'],
  ['수영복', '래쉬가드', '비키니', 'swimsuit', 'swimwear'], ['드라이기', '드라이어', 'dryer'], ['밥솥', '쿠커', 'cooker'],
  ['전기포트', '전기주전자', '주전자', 'kettle'], ['커피머신', '커피메이커', '에스프레소머신'],
  ['백팩', '가방', '배낭', '백', 'backpack', 'bag'], ['방수팩', '방수케이스', '방수파우치']
];
const HEAD_SYN = (() => {
  const m = new Map();
  HEAD_SYNONYMS.forEach(g => g.forEach(w => m.set(w, g)));
  return m;
})();

/* ------------------------------------------------------------------ *
 *  검색어 분석
 * ------------------------------------------------------------------ */

const BUDGET_PHRASE = /(?:\d[\d,.]*\s*(?:억|천|백)?\s*만?\s*원\s*(?:대|이하|이상|미만|초과|까지|안쪽|내외|정도|선|짜리|안팎|내로|이내|넘지\s*않는)?|\d[\d,.]*\s*만\s*(?:원)?\s*(?:대|이하|이상|미만|까지|이내|짜리|정도)?)/g;
const REQUEST_FILLER = /(?:추천\s*해\s*줘|추천해줘|추천|찾아\s*줘|찾아줘|보여\s*줘|보여줘|알려\s*줘|알려줘|골라\s*줘|골라줘|있어\??|없어\??|사고\s*싶어|살래|주세요|해\s*줘|좀|요$)/g;

const specCache = new Map();
const SPEC_CACHE_MAX = 2000;

/**
 * 검색어 → 판정 명세.
 * @param {string} text 사용자가 친 검색어(원문 — 모델 코드의 하이픈을 보존한다)
 * @param {object} opts { titles } 이번 후보 상품명들(목록에 없는 브랜드 머리 판정에만 쓴다)
 */
function parseQuery(text, opts = {}) {
  const key = String(text || '');
  if (!opts.titles && specCache.has(key)) return specCache.get(key);
  const raw = key.normalize('NFKC').replace(/\s+/g, ' ').trim();
  let budget = { max: 0, min: 0 };
  try {
    const c = require('./_shopintent').parseConstraints(raw);
    budget = { max: Number(c.budgetMax) || 0, min: Number(c.budgetMin) || 0 };
  } catch (_) { /* 예산 해석 실패는 예산 없음 */ }
  const condition = S.conditionIntent(raw);

  // 부정된 브랜드 ("로지텍 말고") 는 요구가 아니라 제외다.
  const excludedBrands = [];
  const negated = [...raw.matchAll(/([^\s,]{2,20})\s*(?:은|는|이|가)?\s*(?:말고|빼고|제외(?:하고)?|아닌|아니고)/g)].map(m => m[1]);
  negated.forEach(word => brandsIn(word).forEach(b => excludedBrands.push(b.canon)));

  let idText = raw.replace(BUDGET_PHRASE, ' ').replace(REQUEST_FILLER, ' ');
  // 대화체 조사 — «제품만», «칩으로», «모델로», «걸로». 남는 말이 아는 낱말일 때만 뗀다(«프로» 의 «로» 는 떼지 않는다).
  idText = idText.replace(/([가-힣]{1,8}?)(으로|로|만|은|는|도|이요|요|이야|야|예요|이에요|인데|이면|면)(?=\s|$)/g, (whole, stem, josa) => {
    const known = NOT_HEAD.has(stem) || VARIANT.has(stem) || LINE.has(stem) || isBrandToken(stem) || ['칩', '것', '거', '제품', '모델', '버전'].includes(stem);
    return known || (josa.length >= 2 && stem.length >= 2) ? stem : whole;
  });
  idText = S.stripConditionTerms(idText);
  negated.forEach(word => { if (brandsIn(word).length) idText = idText.replace(word, ' '); });
  idText = idText.replace(/\s*(?:말고|빼고|제외(?:하고)?|아닌|아니고)\s*/g, ' ').replace(/\s+/g, ' ').trim();

  const normalized = normalize(idText);
  const tokens = S.splitTokens(normalized);
  const accessoryWords = S.accessoryTerms(normalized, tokens);
  const principal = LST.principalItem(idText);
  // 기기 종류는 상품명 규칙(principalItem — 머리 명사)이 먼저다. «에어팟 맥스» 는 이어폰이 아니라 헤드폰이다.
  const type0 = principal.kind === 'device' && principal.type && principal.type !== '기타기기'
    ? principal.type : TAX.explicitType(idText);
  // «백팩»·«방수팩»·«모자» 처럼 부속 사전에 있어도 그 자체가 찾는 물건인 말은 본품 검색이다.
  // 어느 범주에서나 부속인 명사(케이스·필름·거치대…)나 범주별 부품 규칙에 걸릴 때만 부속 검색으로 본다.
  // 기기 이름과 함께 부속 명사를 말했으면(«로봇청소기 물걸레 패드», «휴대폰 방수팩») 그 부속을 찾는 것이다.
  // (#236 이후 explicitType 은 «노트북 거치대» 같은 부속 구절에 종류를 돌려주지 않는다 — 언급 자체를 본다)
  const typeMentioned = !!TAX.explicitType(idText) || TAX.typeMentions(idText).length > 0;
  const wantsAccessory = accessoryWords.length > 0
    || (principal.kind === 'accessory' && (UNIVERSAL_ACCESSORY.test(String(principal.noun || '')) || typeMentioned))
    || (!!type0 && TAX.isPart(idText, type0));
  // 찾는 물건이 부속 사전의 명사(방수팩·쿨링패드)면 앞의 기기(휴대폰·노트북)는 «무엇에 쓰는가» 다.
  const type = wantsAccessory || principal.kind === 'accessory' ? '' : type0;
  // «할로윈 의상 및 소품» 처럼 범주를 나열한 키워드는 머리 명사 하나로 판정하지 않는다.
  const coordinated = /(?:\s및\s|[,/·]|\s(?:와|과|랑)\s)/.test(idText);
  const head = coordinated ? '' : headNoun(tokens);
  const models = modelCodesOf(tokens, idText);
  const brands = brandsIn(idText).filter(b => !excludedBrands.includes(b.canon));
  // 부속 검색에서 제품군 이름(아이패드·갤럭시)은 «무엇에 쓰는가» 다 — 브랜드 요구가 아니다.
  const brandReq = brands.filter(b => !(wantsAccessory && b.viaLine)
    && !(b.viaLine && type && !lineCovers(b, type)));
  const families = familyRuns(tokens);
  const variants = queryVariants(tokens);
  const caps = queryCapacities(idText);
  const sizes = querySizes(tokens);
  const people = (idText.match(/(\d{1,2})\s*인\s*(?:용|분)?/) || [])[1];
  const colors = colorsIn(raw.replace(/블루투스|bluetooth/gi, ' '));
  const wireless = /(?:무선|블루투스|wireless|bluetooth)/i.test(idText) ? true : /(?:유선|wired)/i.test(idText) ? false : null;
  const gender = /(?:여성|여자|우먼|women|레이디)/i.test(raw) ? 'f' : /(?:남성|남자|맨즈|\bmen\b)/i.test(raw) ? 'm' : '';
  const kids = KIDS.test(raw);
  const year = (idText.match(/(?<!\d)(20[12]\d)(?!\d)/) || [])[1] || '';
  const wantsBook = /(?:책|도서|교재|설명서|가이드\s*북|교본|매뉴얼)/.test(raw);
  const wantsCar = /(?:차량|자동차|차\s*안|차에서|운전)/.test(raw);
  // 목록에 없는 브랜드 머리 — 후보 목록이 있을 때만 판정한다(_search.detectBrandHead 규칙).
  let looseBrand = '';
  if (Array.isArray(opts.titles) && opts.titles.length && tokens.length > 1 && !brands.length) {
    const a = S.analyzeQuery(idText, { titles: opts.titles });
    const first = tokens[0];
    if (a.brandHead && first !== head && !NOT_HEAD.has(first) && !lineKey(first) && !/\d/.test(first)) looseBrand = first;
  }
  const lines = tokens.filter(t => lineKey(t) && t.length >= 2 && !NOT_HEAD.has(t));
  const identityWords = identityWordsOf(tokens, { head, models, type, looseBrand });
  // 한글 이름에 영문 한 글자가 붙은 이름 («제로S», «타워X») 은 한 덩어리다.
  for (const m of idText.matchAll(/([가-힣]{2,})([a-z])(?![a-z0-9])/gi)) {
    const compound = (m[1] + m[2]).toLowerCase();
    // 변형 낱말 + 글자(«맥스V» = MaxV)는 영문 표기도 같은 이름이다
    const v = VARIANT.get(m[1]);
    if (v && !ALIASES.has(compound)) ALIASES.set(compound, [v + m[2].toLowerCase()]);
    if (!identityWords.includes(compound)) identityWords.push(compound);
  }
  const spec = {
    raw, idText, normalized, tokens, type, wantsAccessory, accessoryWords, head, models, brands: brandReq,
    excludedBrands, families, variants, caps, sizes, people: people ? Number(people) : 0, colors, wireless, gender, kids,
    year, budget, condition, wantsBook, wantsCar, looseBrand, lines, identityWords,
    // 관련도 점수에 쓸 검색어 — 예산·요청 말("50만원 이하", "보여줘")이 커버리지를 깎지 않게 뺀다.
    rankText: idText || raw,
    analysis: S.analyzeQuery(idText, { titles: Array.isArray(opts.titles) ? opts.titles : [] })
  };
  if (!opts.titles) {
    if (specCache.size >= SPEC_CACHE_MAX) specCache.clear();
    specCache.set(key, spec);
  }
  return spec;
}

function lineCovers(brand, type) {
  const b = BRAND_TABLE.find(x => x.canon === brand.canon);
  const cats = b && b.lineCats[brand.line];
  return !cats || cats.includes(type);
}

function headNoun(tokens) {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (!t || t.length < 2) continue;
    if (/\d/.test(t)) continue;
    if (NOT_HEAD.has(t) || S.COMMON_WORDS.has(t) || S.TAIL_NOISE.has(t) || VARIANT.has(t) || LINE.has(t)) continue;
    if (UNIT_AFTER.has(t) || GEN_AFTER.has(t)) continue;
    if (COLOR_WORDS.test(t) && t.length <= 6) continue;
    if (/^[a-z]+$/.test(t) && t.length < 3) continue;
    if (/[가-힣]/.test(t) && ADJECTIVE_END.test(t) && t.length <= 4 && !HEAD_SYN.has(t)) continue;
    if (brandsIn(t, { includeLines: true }).length && !HEAD_SYN.has(t)) continue;
    // "여행용", "게임용" 같은 수식어는 머리가 아니다 — 뒤에 다른 말이 없을 때만 남긴다.
    if (/[가-힣]용$/.test(t) && i < tokens.length - 1) continue;
    return t;
  }
  return '';
}

/*
 * 브랜드·모델 코드 바로 뒤에 붙은 고유 이름 — 그 상품의 정체다 ("HP 파빌리온", "X1 카본", "JBL 튠").
 * 머리 명사(범주)·수식어·변형·번호·색상은 따로 다룬다. 이 낱말이 상품명에 없으면 다른 상품이다.
 */
function identityWordsOf(tokens, { head, models, type, looseBrand }) {
  const out = [];
  const typeWords = new Set(type ? (TAX.searchAnchors(type) || []).map(w => normalize(w).replace(/\s+/g, '')) : []);
  let open = false;
  // 기기 종류가 정해진 검색에서 머리 명사가 그 종류의 이름이 아니면(«X1 카본») 고유 이름이다.
  const headIsCategory = !head || typeWords.has(head) || HEAD_SYN.has(head) || !type;
  tokens.forEach((t, i) => {
    const isBrand = isBrandToken(t) || t === looseBrand;
    const isCode = models.includes(t);
    if (isBrand || isCode || lineKey(t)) { open = true; return; }
    if (!open) return;
    if ((t === head && headIsCategory) || typeWords.has(t) || HEAD_SYN.has(t)) { open = false; return; }
    // 한글 한 음절도 이름일 수 있다(«JBL 튠»). 조사·단위 한 글자만 뺀다.
    const tooShort = /^[a-z]$/.test(t) || (t.length < 2 && !/^[가-힣]$/.test(t)) || /^[은는이가을를의에도만용형식대]$/.test(t);
    if (tooShort || /\d/.test(t) || NOT_HEAD.has(t) || VARIANT.has(t) || UNIT_AFTER.has(t) || GEN_AFTER.has(t)
      || S.COMMON_WORDS.has(t) || S.TAIL_NOISE.has(t) || (COLOR_WORDS.test(t) && t.length <= 6)) return;
    if (/[가-힣]/.test(t) && ADJECTIVE_END.test(t) && t.length <= 4) return;
    if (i === tokens.length - 1 && t === head && headIsCategory) return;
    out.push(t);
  });
  return [...new Set(out)];
}

const NOT_MODEL = /^(?:\d+k|[2345]g|lte|usb\d?|[0-9]+(?:gb|tb|mb|mm|cm|kg|ml|w|v|hz|mah|l|g|p|in)|[0-9]+(?:세대)?|ddr\d|wifi\d|wi\d|h1[0-4]|c\d|qi\d?|\d+x|x\d{3,})$/;
function modelCodesOf(tokens, rawText) {
  // _search 의 모델 코드 규칙(영문+숫자, 단위·용량 제외)과 같다.
  const codes = tokens.filter(c => /[a-z]/.test(c) && /\d/.test(c) && !S.UNIT_RE.test(c) && !S.CAPACITY_RE.test(c))
    .filter(c => !NOT_MODEL.test(c) && c.length >= 2);
  // 하이픈으로 붙은 영문 머리(WH-1000XM5, SM-S931N)는 한 코드다 — 머리를 잃으면 WF-1000XM5 도 통과한다.
  for (const m of String(rawText || '').matchAll(/(?<![a-z0-9])([a-z]{1,4})[-\s]?(\d{2,5}[a-z0-9]*)(?![a-z0-9])/gi)) {
    // «plus 512gb», «pro 14» 는 모델 코드가 아니다 — 변형 낱말 + 용량·번호다.
    if (VARIANT.has(m[1].toLowerCase()) || /^\d+(?:gb|tb|mb|mm|인치|hz|w)$/i.test(m[2])) continue;
    const full = (m[1] + m[2]).toLowerCase();
    if (/^(?:rtx|gtx|rx|i[3579]|ps|xm|ddr|usb|gen|ver|no|vol)$/i.test(m[1]) && !/\d[a-z]/i.test(m[2])) {
      // RTX 4060 · i7 13700 같은 계열 번호는 아래 제품군 번호 규칙이 본다
      if (/^(?:rtx|gtx|rx)$/i.test(m[1])) codes.push(full);
      continue;
    }
    if (!codes.includes(full) && !NOT_MODEL.test(full)) {
      const tail = m[2].toLowerCase();
      // 머리를 붙인 코드가 원래 코드를 대신한다 (wh1000xm5 가 1000xm5 를 품는다)
      const idx = codes.indexOf(tail);
      if (idx >= 0) codes.splice(idx, 1);
      codes.push(full);
    }
  }
  return [...new Set(codes)];
}

/** 제품군 이름 뒤의 번호 묶음. «그램 16» → {그램:[16]}, «갤럭시 북5 프로 360» → {북:[5,360]}, «아이패드 10세대» */
function familyRuns(tokens) {
  const runs = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!/^\d{1,4}$/.test(t)) continue;
    const next = tokens[i + 1] || '';
    if (UNIT_AFTER.has(next)) continue;
    if (S.YEAR_RE.test(t) && Number(t) >= 2000 && Number(t) <= 2035) continue;
    let j = i - 1;
    while (j >= 0 && (VARIANT.has(tokens[j]) || /^\d{1,4}$/.test(tokens[j]) || RUN_SKIP.has(tokens[j])
      || (/\d/.test(tokens[j]) && /[a-z]/.test(tokens[j])) || /^[a-z]$/.test(tokens[j]))) j--;
    if (j < 0) continue;
    const anchor = tokens[j];
    if (UNIT_AFTER.has(anchor) || (NOT_HEAD.has(anchor) && !lineKey(anchor))) continue;
    const anchorKey = lineKey(anchor) || anchor;
    let run = runs.find(r => r.anchorKey === anchorKey);
    if (!run) { run = { anchor, anchorKey, nums: [], gen: false }; runs.push(run); }
    run.nums.push(Number(t));
    if (GEN_AFTER.has(next)) run.gen = true;
  }
  return runs;
}

// 기준 낱말 일치 — 같은 제품군 키, 그 낱말로 끝나는 붙은 말, 표기 쌍(ALIASES: «미밴드» ↔ «스마트밴드»)
const anchorMatches = (tok, key, anchor) => (lineKey(tok) || tok) === key
  || (key.length >= 2 && tok.length > key.length && tok.endsWith(key))
  || (!!anchor && (ALIASES.get(anchor) || []).some(a => { const n = normalize(a).replace(/\s+/g, ''); return tok === n || (n.length >= 2 && tok.endsWith(n)); }));

/** 상품명에서 기준 낱말 뒤 번호 묶음 (변형·모델 코드·판매 문구는 건너뛰고, 단위·다른 낱말이 나오면 멈춘다). */
function listingRunsAfter(tokens, anchorKey, { skipYears = true, anchor = '' } = {}) {
  const runs = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!anchorMatches(tokens[i], anchorKey, anchor)) continue;
    const nums = [];
    for (let j = i + 1, steps = 0; j < tokens.length && steps < 6; j++, steps++) {
      const t = tokens[j];
      if (VARIANT.has(t) || RUN_SKIP.has(t) || GEN_AFTER.has(t) || /^[a-z]$/.test(t)) continue;
      if (/^\d{1,4}$/.test(t)) {
        if (UNIT_AFTER.has(tokens[j + 1] || '')) break;
        if (skipYears && S.YEAR_RE.test(t) && Number(t) >= 2000 && Number(t) <= 2035) continue;
        nums.push(Number(t));
        continue;
      }
      if (/\d/.test(t) && /[a-z]/.test(t) && !S.CAPACITY_RE.test(t) && !S.UNIT_RE.test(t)) continue;   // a17 같은 칩 이름
      break;
    }
    runs.push(nums);
  }
  return runs;
}

function queryVariants(tokens) {
  const set = new Set();
  const hasLine = tokens.some(t => lineKey(t));
  tokens.forEach((t, i) => {
    const compound = VARIANT_COMPOUND.get(t);
    if (compound) { compound.forEach(v => set.add(v)); return; }
    const v = VARIANT.get(t);
    if (!v) return;
    const near = [tokens[i - 1], tokens[i + 1]].filter(Boolean);
    if (hasLine || near.some(n => /\d/.test(n) || VARIANT.has(n) || brandsIn(n).length)) set.add(v);
  });
  return set;
}

// 노트북 CPU 이름(코어 울트라 7) · 칩셋 표기를 제품 변형으로 읽지 않게 지운다.
const CPU_PHRASE = /(?:(?:인텔|intel)\s*)?(?:코어|core)\s*(?:울트라|ultra)\s*[3579](?:\s*\d{3}[a-z]{0,2})?|(?:울트라|ultra)\s*[579]\s+\d{3}[a-z]{0,2}|\d{1,2}\s*세대\s*(?:울트라|ultra)\s*[3579](?![0-9a-z])|(?:울트라|ultra)\s*[3579](?=\s*(?:ram|램|\d+\s*gb|프로세서|cpu))|(?:라이젠|ryzen)\s*[3579](?:\s*pro)?|스냅\s*드래곤\s*x\s*(?:엘리트|plus|플러스)?|snapdragon\s*x\s*(?:elite|plus)?|a\d{2}\s*(?:pro|bionic|프로)|\bm[1-4]\s*(?:pro|max|프로|맥스)\s*칩/gi;
function listingVariants(title) {
  const cleaned = String(title || '').replace(CPU_PHRASE, ' ');
  const tokens = S.splitTokens(normalize(cleaned));
  const set = new Set();
  const counted = new Array(tokens.length).fill(false);
  tokens.forEach((t, i) => {
    const compound = VARIANT_COMPOUND.get(t);
    if (compound) { compound.forEach(v => set.add(v)); counted[i] = true; }
    // «MaxV», «ProX» — 변형 낱말에 한 글자가 붙은 표기도 그 변형이다
    const glued = t.match(/^(pro|max|ultra|plus|air|mini|lite|neo)[a-z]$/);
    if (glued) { set.add(VARIANT.get(glued[1])); counted[i] = true; }
  });
  let changed = true;
  while (changed) {
    changed = false;
    tokens.forEach((t, i) => {
      if (counted[i] || !VARIANT.has(t)) return;
      const near = [i - 1, i + 1].filter(k => k >= 0 && k < tokens.length);
      if (near.some(k => lineKey(tokens[k]) || /\d/.test(tokens[k]) || counted[k])) {
        counted[i] = true; set.add(VARIANT.get(t)); changed = true;
      }
    });
  }
  // "S25+" · "Z 플립6 +" 같은 기호 표기
  const compact = String(title || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  if (/[a-z]\d{1,3}\+/.test(compact)) set.add('plus');
  return { set, tokens };
}

function queryCapacities(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/(?<![0-9a-z])(\d{1,4})\s*(tb|gb|기가|테라)(?![a-z0-9])/gi)) {
    out.push(Number(m[1]) * (/tb|테라/i.test(m[2]) ? 1024 : 1));
  }
  return out;
}
function listingCapacities(title) {
  const caps = [];
  const t = String(title || '');
  for (const m of t.matchAll(/(?<![0-9a-z])(\d{1,4})\s*(tb|gb|기가|테라|g)(?![a-z0-9])/gi)) {
    const n = Number(m[1]) * (/tb|테라/i.test(m[2]) ? 1024 : 1);
    const around = t.slice(Math.max(0, m.index - 10), m.index + m[0].length + 6);
    caps.push({ n, ram: /(?:ram|램|메모리)/i.test(around) || (n <= 32 && /\b\d{3,4}\s*(?:gb|tb)\b/i.test(t.slice(m.index + m[0].length))) });
  }
  return caps;
}
function querySizes(tokens) {
  const out = [];
  tokens.forEach((t, i) => {
    if (/^\d{2}(?:\.\d)?$/.test(t) && (tokens[i + 1] === '인치' || tokens[i + 1] === '형')) out.push(Number(t));
  });
  return out;
}
function listingSizes(title) {
  const sizes = new Set();
  for (const m of String(title || '').matchAll(/(?<![\d.])(\d{2}(?:\.\d)?)\s*(?:인치|형|"|″|inch)/gi)) sizes.add(Math.round(Number(m[1])));
  return sizes;
}

/* ------------------------------------------------------------------ *
 *  판정
 * ------------------------------------------------------------------ */

/**
 * 낱말이 상품명에 있는가 (표기 차이 포함).
 * strict — 제품군·고유 이름. 범주 동의어(«맥북» ≡ «노트북», _search.SYNONYMS)로는 인정하지 않는다:
 *          그렇게 하면 «맥북 키스킨» 검색에 아무 «노트북 키스킨» 이 맥북 것으로 통과한다.
 */
function present(word, T, strict = false) {
  if (!word) return true;
  const flat = T.flat;
  if (flat.includes(word)) return true;
  if (!strict) {
    const group = HEAD_SYN.get(word);
    if (group && group.some(w => flat.includes(normalize(w).replace(/\s+/g, '')))) return true;
    const syn = S.SYNONYMS.get(word);
    if (syn && [...syn].some(w => w.length >= 2 && flat.includes(w))) return true;
  }
  const key = LINE.get(word);
  if (key && T.tokens.some(t => lineKey(t) === key)) return true;
  if (key && (LINE_WORDS_BY_KEY.get(key) || []).some(w => w.length >= 2 && flat.includes(w))) return true;
  const aliases = ALIASES.get(word);
  if (aliases && aliases.some(a => flat.includes(normalize(a).replace(/\s+/g, '')))) return true;
  // 합성 명사 «전기밥솥» ↔ «전기압력밥솥»: 두 조각이 모두 있으면 같은 말이다(_search.splitCompound 규칙).
  if (/^[가-힣]{4,8}$/.test(word)) {
    for (let i = 2; i <= word.length - 2; i++) {
      const a = word.slice(0, i), b = word.slice(i);
      if (flat.includes(a) && flat.includes(b)) return true;
    }
  }
  return false;
}

/** 머리 명사가 상품명에서 «대상» 으로만 쓰였는가 ("수영복 건조 망 가방", "텀블러 세척솔", "캐리어 … 네임택"). */
/*
 * 머리 명사가 상품명 주 구절의 «마지막 내용 명사» 인가. 뒤에 오는 것이 꾸밈말·색·코드·같은 끝말뿐이면 그렇다.
 *   «홈플래닛 풋터치 리모컨 서큘레이터»            → 예 (리모컨은 기능)
 *   «쿨슬리브 자외선차단 쿨토시 팔토시»            → 예 (팔토시 = 같은 끝말)
 *   «… 원통비치 수영복 물놀이 +할인쿠폰»           → 아니오 (키워드를 끼워 넣은 가방)
 */
const DESCRIPTOR_END = /(?:형|용|식|성|감|색|디자인|스타일|타입|세트|에디션|버전|모델|컬러|사이즈|무료배송|할인쿠폰|쿠폰|정품|국내|해외|증정|포함)$/;
function headIsLastNoun(head, tokens) {
  let last = -1;
  tokens.forEach((t, i) => { if (t === head || t.endsWith(head) || (HEAD_SYN.get(head) || []).includes(t)) last = i; });
  if (last < 0) return false;
  const suffix = head.slice(-2);
  return tokens.slice(last + 1).every(t => /\d/.test(t) || /^[a-z]+$/.test(t) || t.length <= 1 || S.TAIL_NOISE.has(t)
    || NOT_HEAD.has(t) || COLOR_WORDS.test(t) || DESCRIPTOR_END.test(t) || (suffix.length === 2 && t.endsWith(suffix)));
}

// 활동·용도 낱말 — 머리 명사가 이것이면 «X용 Y» 의 Y 가 바로 찾는 물건이다(«별자리 관측» ↔ «관측용 망원경»).
const ACTIVITY = new Set(['관측', '입문', '수납', '세탁', '청소', '보관', '정리', '운동', '캠핑', '여행', '낚시', '등산', '수영',
  '요리', '공부', '학습', '독서', '촬영', '녹음', '게임', '사무', '육아', '산책', '연습', '훈련', '명상', '취미', '선물', '교육']);
function headIsTarget(spec, T) {
  const head = spec.head;
  if (!head || ACTIVITY.has(head)) return '';
  const tokens = T.mainTokens;
  let last = -1;
  tokens.forEach((t, i) => { if (t === head || (t.startsWith(head) && t.length <= head.length + 4)) last = i; });
  if (last < 0) return '';
  const tok = tokens[last];
  if (tok !== head) {
    const rest = tok.slice(head.length);
    if (RELATION_SUFFIX.test(rest) || RELATION_NEXT.test(rest)) return `${head}→${tok}`;
  }
  const next = tokens[last + 1];
  if (next && RELATION_NEXT.test(next)) return `${head}→${next}`;
  // 세척솔·건조망처럼 관계 낱말로 시작하는 붙은 말
  if (next && /^(?:세척|건조|보관|수납|정리|거치|살균|청소)[가-힣]{1,3}$/.test(next)) return `${head}→${next}`;
  // 머리 명사 뒤의 마지막 «물건» 명사 ("여행용 캐리어 가죽 네임택 2p")
  const after = tokens.slice(last + 1).filter(t => !/\d/.test(t) && !S.TAIL_NOISE.has(t) && !COLOR_WORDS.test(t) && t.length >= 1);
  const lastObj = after.reverse().find(endsWithTailObject);
  if (lastObj && !(HEAD_SYN.get(head) || []).includes(lastObj)) return `${head}…${lastObj}`;
  return '';
}

function titleInfoOf(title) {
  const raw = String(title || '');
  const main = LST.mainPhrase(raw).replace(BUNDLE_PHRASE, ' ');
  const normalized = normalize(raw);
  return {
    raw, main,
    normalized,
    flat: normalized.replace(/\s+/g, ''),
    tokens: S.splitTokens(normalized),
    mainTokens: S.splitTokens(normalize(main))
  };
}

const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 상품 하나 판정.
 * @param {object} spec parseQuery 결과
 * @param {object} item { title, lprice|price, condition? }
 * @param {object} opts { stored: true } 저장된 행 분류(가격·예산은 보지 않는다)
 * @returns {{ok:boolean, hard:string[], soft:string[], principal:object}}
 */
function judge(spec, item, opts = {}) {
  const title = String((item && item.title) || '');
  const T = titleInfoOf(title);
  const hard = [];
  const soft = [];
  const price = Number(item && (item.lprice != null ? item.lprice : item.price)) || 0;
  // 판매 대상은 딸려 오는 구성품(«충전 거치대 포함», «케이스 증정»)을 지운 상품명으로 본다.
  const principal = LST.principalItem(title.replace(BUNDLE_PHRASE, ' '));

  if (!title.trim()) return { ok: false, hard: ['empty_title'], soft, principal };
  const codeInTitle = spec.models.some(c => T.flat.includes(c));

  /* 1. 판매 대상(본품 ↔ 부속·도서·다른 기기) */
  if (!spec.wantsAccessory) {
    const noun = String(principal.noun || '');
    const nounFlat = noun.replace(/\s+/g, '');
    const headGroup = HEAD_SYN.get(spec.head) || [];
    const nounIsHead = !!spec.head && (nounFlat === spec.head || headGroup.includes(nounFlat)
      || spec.head.endsWith(nounFlat) || nounFlat.endsWith(spec.head));
    const unbundled = title.replace(BUNDLE_PHRASE, ' ');
    const deviceNouns = LST.collectNouns(T.main).filter(n => n.kind === 'device' && n.type === spec.type);
    // 범주가 정해지지 않은 검색에서 머리 명사가 부속 명사 «뒤» 에 오면 머리 명사가 판매 대상이다
    // («여권 지갑 … 카드 홀더 동전 지갑», «상판분리 바베큐 전기그릴 … 생선구이기»). 상품명은 머리가 끝에 온다.
    const nounAt = noun ? T.main.search(new RegExp(noun.replace(/\s+/g, '\\s*'), 'i')) : -1;
    const headAfter = !spec.type && !!spec.head && nounAt >= 0
      && normalize(T.main.slice(nounAt + noun.length)).replace(/\s+/g, '').includes(spec.head)
      && headIsLastNoun(spec.head, T.mainTokens);
    const bookWanted = spec.wantsBook && /^(?:media|도서|교본|교재)$/.test(noun);
    if (principal.kind === 'accessory' && !nounIsHead && !headAfter && !bookWanted) {
      if (UNIVERSAL_ACCESSORY.test(noun)) hard.push(`accessory:${noun}`);
      else if (AMBIGUOUS_ACCESSORY.test(noun)) {
        const at = T.main.search(new RegExp(noun.replace(/\s+/g, '\\s*'), 'i'));
        const tail = at >= 0 ? T.main.slice(at, at + noun.length + 14) : '';
        const typedPart = spec.type && TAX.isPart(unbundled, spec.type);
        // 찾는 기기 명사가 «앞» 에 있고 부품 표시(호환·교체·N개…)가 없으면 기능 설명이다
        // ("로봇청소기 물걸레 자동세척", "공기청정기 헤파필터 H13"). 부속이 앞이면 그 부속을 판다.
        const deviceBefore = at >= 0 && deviceNouns.some(n => n.index < at);
        if (typedPart || PART_MARK.test(tail) || !spec.type) hard.push(`accessory:${noun}`);
        else if (!deviceBefore) hard.push(`accessory:${noun}`);
      } else if (spec.type) {
        hard.push(`not_device:${noun}`);
      } else if (STRONG_OTHER.test(noun)) {
        hard.push(`other_object:${noun}`);
      }
    }
    if (spec.type) {
      // «… 노트북 SSD 512GB» · «SSD탑재» 의 SSD 는 사양이다 — 찾는 기기 명사가 함께 있으면 외장하드로 읽지 않는다.
      const storageSpec = principal.type === '외장하드' && spec.type !== '외장하드'
        && /(?:ssd|hdd)\s*(?:\d|탑재|장착|내장|업그레이드)|\d+\s*(?:gb|tb)\s*(?:ssd|hdd)/i.test(title)
        && (deviceNouns.length > 0 || TAX.productTypeMatches(title.replace(/\b(?:ssd|hdd)\b/gi, ' '), spec.type, spec.raw));
      if (principal.kind === 'device' && principal.type && principal.type !== spec.type && principal.type !== '기타기기' && !storageSpec) {
        hard.push(`other_device:${principal.type}`);
      }
      if (principal.kind === 'device' && principal.type === '기타기기') hard.push('other_device:기타기기');
      if (TAX.isPart(unbundled, spec.type)) hard.push('part');
      // 기기 종류를 증명할 낱말이 하나도 없다 (헤어 스프레이·가스 버너가 «맥스» 로 걸린 경우)
      if (principal.kind === null && !codeInTitle && !spec.lines.some(l => present(l, T))
        && !TAX.productTypeMatches(title, spec.type, spec.raw)) hard.push(`not_type:${spec.type}`);
      if (spec.type === '노트북' && PC_COMPONENT.test(title)) hard.push('pc_component');
      if ((spec.type === '공기청정기' || spec.type === '청소기') && CAR_ONLY.test(title) && !spec.wantsCar
        && !/(?:가정용|겸용|실내|원룸|사무실|홈)/.test(title)) hard.push('car_only');
    }
    // 범주 낱말 정렬(_search.productFocus) — 강한 부속(케이스·세척솔·패킹·공병…)은 hard.
    // 상품명 머리가 찾는 종류의 기기라고 이미 확인됐으면(principalItem) 이 어순 규칙은 쓰지 않는다.
    const sameDevice = principal.kind === 'device' && !!spec.type && principal.type === spec.type;
    const focus = sameDevice ? null : S.productFocus(spec.analysis, title);
    if (focus && focus.factor < 1 && focus.accessory) {
      const acc = focus.accessory;
      const accIsHead = spec.head && (acc === spec.head || spec.head.endsWith(acc));
      if (!accIsHead) {
        if (focus.factor <= 0.72) hard.push(`accessory:${acc}`);
        else soft.push(`accessory_possible:${acc}`);
      }
    }
    const target = headIsTarget(spec, T);
    if (target) hard.push(`head_is_target:${target}`);
    if (COMPATIBLE_PART.test(title)) hard.push('compatible_part');
    // 사용자가 말한 모델·제품군이 «무엇에 쓰는가» 로만 나온다 ("PS5 Slim용 냉각팬")
    for (const w of spec.models.concat(spec.lines)) {
      const m = new RegExp(`${escapeRe(w)}[\\s\\S]{0,10}?(?:용|전용|호환)(?![가-힣])`, 'i').exec(T.normalized);
      if (m && !/(?:사용|활용|이용|겸용|다용|업무용|가정용|휴대용|게임용|사무용|학생용|대용량)$/.test(m[0])) { hard.push(`target_of:${w}`); break; }
    }
  } else {
    // 부속을 찾았다 — 그 부속 낱말(또는 같은 뜻)이 상품명에 있어야 한다.
    const words = spec.accessoryWords.length ? spec.accessoryWords : (spec.head ? [spec.head] : []);
    const has = words.some(w => present(w, T)
      || (/케이스|커버|case|cover/.test(w) && /(?:케이스|커버|case|cover|범퍼|bumper|폴리오|folio|파우치)/i.test(title))
      || (/필름|강화유리|보호/.test(w) && /(?:필름|강화\s*유리|보호|film|glass)/i.test(title))
      || (/충전기|어댑터|charger/.test(w) && /(?:충전기|어댑터|charger|adapter|충전\s*케이블)/i.test(title)));
    if (words.length && !has) hard.push('not_requested_accessory');
  }

  /* 2. 한 글에 여러 모델·상품 — 가격이 어느 것의 것인지 알 수 없다 */
  if (COLLECTION.test(title)) hard.push('collection_listing');
  if (spec.type && ['스마트폰', '태블릿', '노트북', '이어폰', '시계', '청소기'].includes(spec.type) && listsManyModels(title)) hard.push('many_models');
  if (spec.wantsAccessory && listsManyModels(title)) hard.push('many_models');
  for (const code of spec.models) {
    const shape = code.match(/^([a-z]+)(\d+)$/);
    if (!shape) continue;
    const re = new RegExp(`(?<![a-z0-9])${shape[1]}\\s*-?\\s*\\d{${shape[2].length}}(?![0-9])`, 'gi');
    const distinct = new Set((T.normalized.match(re) || []).map(x => x.replace(/[\s-]/g, '').toLowerCase()));
    // 본품 검색에서 같은 꼴의 다른 모델 코드가 함께 적힌 글(«V10, V12 …최대혜택가»)은 어느 모델의 가격인지 모른다.
    if (distinct.size >= 3 || (distinct.size >= 2 && !spec.wantsAccessory)) { hard.push('many_models'); break; }
  }

  /* 3. 도서·약정가·묶음·도배·비현실적 기기 가격 */
  const guard = LG.listingGuard({ title, price: opts.stored ? 0 : price }, { category: spec.type, userText: spec.raw, checkColor: false });
  if (guard && !(guard === 'publication_not_device' && spec.wantsBook)) {
    if (guard === 'implausible_device_price' && spec.wantsAccessory) { /* 부속 검색에는 기기 하한이 없다 */ }
    else hard.push(guard);
  }

  /* 4. 범주 낱말·제품군 이름·고유 이름이 있어야 한다 */
  if (spec.head && !spec.type && !spec.wantsAccessory) {
    // 범주 낱말(HEAD_SYN)은 모델 코드가 맞으면 생략될 수 있다. 고유 이름(«데스애더», «디스크»)은 생략될 수 없다.
    if (!present(spec.head, T)) (codeInTitle && HEAD_SYN.has(spec.head) ? soft : hard).push(`category_absent:${spec.head}`);
  } else if (spec.type && !spec.wantsAccessory && opts.stored) {
    const sameType = principal.kind === 'device' && principal.type === spec.type;
    if (!sameType && !(spec.head && present(spec.head, T)) && !TAX.productTypeMatches(title, spec.type, spec.raw)) {
      hard.push(`category_absent:${spec.type}`);
    }
  } else if (spec.type && !spec.wantsAccessory && principal.kind === null) {
    if (!TAX.productTypeMatches(title, spec.type, spec.raw)) soft.push('principal_unverified');
  }
  for (const line of spec.lines) {
    if (!present(line, T, true)) { hard.push(`line_absent:${line}`); break; }
  }
  for (const w of spec.identityWords) {
    if (present(w, T, true)) continue;
    // 한글로 친 고유 이름의 영문 표기는 ALIASES 표로 찾는다(«데스애더» ↔ DeathAdder). 표에도 없으면
    // 그 이름을 상품명이 증명하지 못한다 — 다른 상품을 그 이름으로 보여 주지 않는다.
    hard.push(`identity_word_absent:${w}`);
  }

  /* 5. 모델 코드 — 사용자가 친 코드는 상품명에 그대로 있어야 한다 */
  for (const code of spec.models) {
    // 짧은 코드(M3, S9, G5)는 낱말 그대로여야 한다 — 부품 번호 «MW1M3KH/A» 안의 m3 는 M3 가 아니다.
    const short = code.length <= 3;
    const hit = short ? T.tokens.some(t => t === code || new RegExp(`^${escapeRe(code)}(?:칩|chip)?$`).test(t))
      : T.flat.includes(code);
    if (short && hit) {
      // 같은 꼴의 다른 코드가 함께 있으면(«M3 … M4») 어느 쪽 상품인지 모른다
      const shape = code.match(/^([a-z]+)(\d+)$/);
      if (shape && T.tokens.some(t => new RegExp(`^${shape[1]}\\d{${shape[2].length}}$`).test(t) && t !== code)
        && !spec.wantsAccessory) { hard.push(`model_conflict:${code}`); continue; }
    }
    if (hit) continue;
    if (short) {
      const shape = code.match(/^([a-z]+)(\d+)$/);
      const other = shape && T.tokens.find(t => new RegExp(`^${shape[1]}\\d{${shape[2].length}}(?:칩)?$`).test(t));
      hard.push(other ? `model_conflict:${code}≠${other}` : `model_missing:${code}`);
      continue;
    }
    // 끝의 두 글자 이상 영문은 색상·판매처 옵션 코드인 경우가 많다 (CRP-LHTR0610FW ↔ …0610FGIM)
    const stem = code.match(/^(.*\d)([a-z]{2,})$/);
    if (stem && stem[1].length >= 4 && new RegExp(`${escapeRe(stem[1])}[a-z]`).test(T.flat)) { soft.push(`model_option_suffix:${code}`); continue; }
    hard.push(`model_missing:${code}`);
  }

  /* 6. 제품군 번호·세대 — «그램 16» 에 «그램 15», «아이패드 10세대» 에 «9세대» */
  for (const fam of spec.families) {
    const want = fam.nums;
    const runs = listingRunsAfter(T.tokens, fam.anchorKey, { skipYears: want[0] < 1000, anchor: fam.anchor }).filter(r => r.length);
    if (runs.length) {
      if (runs.some(r => r[0] === want[0])) {
        const best = runs.find(r => r[0] === want[0]);
        const missing = want.slice(1).filter(n => !best.includes(n));
        if (missing.length) hard.push(`line_number_missing:${fam.anchor} ${missing.join('/')}`);
        continue;
      }
      hard.push(`${fam.gen ? 'generation' : 'line_number'}:${fam.anchor} ${want[0]}≠${runs[0][0]}`);
      continue;
    }
    // 기준 낱말 뒤에 번호가 없다. 다른 세대가 적혀 있으면 틀린 상품, 같은 번호가 따로 있으면 받아들인다.
    const gens = [...T.normalized.matchAll(/(?<!\d)(\d{1,2})\s*세대/g)].map(m => Number(m[1]));
    if (fam.gen && gens.length && !gens.includes(want[0])) { hard.push(`generation:${want[0]}≠${gens[0]}`); continue; }
    const rawN = T.raw.normalize('NFKC');
    // 무게·부피 단위(g·kg·l·ml)는 숫자에 붙어 있을 때만 단위다 — «에어 맥스 270 G(…)» 의 G 는 모델 표기다.
    const standalone = new RegExp(`(?<![0-9a-z가-힣.])${want[0]}(?![0-9])(?!\\s*(?:인치|형|gb|tb|mm|cm|개|매|입|세트|팩|종|단|인))(?!(?:w|l|ml|kg|g)\\b)`, 'i').test(rawN);
    // 기준 낱말(또는 그 표기 쌍)에 바로 붙은 번호(«스마트밴드9», «갤럭시북5»)만 같은 번호다 — «월드2» 는 아니다.
    const anchorToks = T.tokens.filter(t => anchorMatches(t, fam.anchorKey, fam.anchor));
    const flatRaw = normalize(rawN);
    const glued = anchorToks.some(t => new RegExp(`${escapeRe(t)}\\s?${want[0]}(?![0-9])`).test(flatRaw));
    const inCode = T.tokens.some(t => /[a-z]/.test(t) && new RegExp(`(?<!\\d)${want[0]}(?!\\d)`).test(t));
    if (standalone || glued || inCode) continue;
    // 같은 자리에 다른 번호가 보이면(«스마트미밴드 11», «8시리즈») 다른 상품이다. 번호가 아예 없으면 확인 못 함.
    const other = T.tokens.filter((t, i) => /^\d{1,2}$/.test(t) && Number(t) !== want[0] && !UNIT_AFTER.has(T.tokens[i + 1] || ''));
    hard.push(other.length ? `line_number:${fam.anchor} ${want[0]}≠${other[0]}` : `line_number_unverified:${fam.anchor} ${want[0]}`);
  }

  /* 7. 변형 — «아이폰 16» 에 «16 프로», «갤럭시 S25 울트라» 에 «S25» */
  const lineInTitle = spec.tokens.some(t => lineKey(t) && T.tokens.some(u => anchorMatches(u, lineKey(t))))
    || codeInTitle;
  if (lineInTitle && (spec.variants.size || spec.families.length || spec.models.length)) {
    // 부속은 맞는 모델이 옵션 꼬리(«…케이스, 아이폰 16프로»)에 적힌다 — 상품명 전체로 본다.
    const LV = listingVariants(title).set;
    const extra = [...LV].filter(v => !spec.variants.has(v));
    const missing = [...spec.variants].filter(v => !LV.has(v));
    // 모델 코드만 친 검색(«SM-S938N»)에서 상품명의 «울트라» 는 그 코드의 이름이다 — 다른 변형이 아니다.
    const codeOnly = spec.models.length > 0 && !spec.lines.length && !spec.families.length && !spec.variants.size;
    if (extra.length && !codeOnly) hard.push(`variant_extra:${extra.join(',')}`);
    if (missing.length) hard.push(`variant_missing:${missing.join(',')}`);
  }

  /* 8. 브랜드 */
  const titleHead = title.slice(0, 48);
  for (const canon of opts.identityOnly ? [] : spec.excludedBrands) {
    if (brandAliases(canon).some(a => aliasRe(a).test(title))) hard.push(`excluded_brand:${canon}`);
  }
  if (spec.brands.length) {
    const hit = spec.brands.some(b => brandAliases(b.canon).some(a => aliasRe(a).test(title)));
    if (!hit) {
      const others = brandsIn(titleHead, { includeLines: false }).filter(b => !spec.brands.some(x => x.canon === b.canon));
      if (others.length) hard.push(`brand_mismatch:${others[0].canon}`);
      else if (!codeInTitle) soft.push('brand_unverified');
    }
  } else if (spec.looseBrand) {
    if (!T.flat.includes(spec.looseBrand)) {
      const hangulQuery = /[가-힣]/.test(spec.looseBrand);
      const latinHead = /^[^가-힣]*[a-z]{3,}/i.test(LST.mainPhrase(title));
      if (hangulQuery && latinHead) soft.push(`brand_unverified:${spec.looseBrand}`);
      else hard.push(`brand_mismatch:${spec.looseBrand}`);
    }
  }

  /*
   * AI 경로(opts.identityOnly)는 여기까지만 본다 — «무엇을 파는가·어느 모델인가» 의 구조 판정.
   * 용량·색상·예산·상태·성별은 AI 가 직접 다룬다: 다른 용량은 «용량 다름» 라벨의 근접 후보(NEAR)로,
   * 예산 밖 후보는 «예산 안에는 없다» 안내와 완화안 계산에 쓴다(api/ai.js 예산 관문·_noresult).
   */
  // 다만 «옵션이 안 적혔다»·«옵션 여러 개를 한 글에» 는 AI 의 근접 후보가 아니라 확인 불가다 — 그것만은 여기서 뺀다.
  const hardBeforeAttributes = hard.length;

  /* 9. 저장 용량·화면 크기·인원·연식 */
  // 저장 용량은 저장 장치가 있는 종류에만 묻는다 — «AirPods 3 256GB» 같은 말에 이어폰을 버리지 않는다.
  const capacityApplies = !spec.type || ['스마트폰', '태블릿', '노트북', '외장하드'].includes(spec.type);
  if (spec.caps.length && capacityApplies) {
    const storageWant = spec.caps.filter(c => c >= 64);
    const caps = listingCapacities(title);
    const storage = [...new Set(caps.filter(c => !c.ram && c.n >= 64).map(c => c.n))];
    for (const want of storageWant) {
      if (!storage.length) { hard.push(`capacity_unverified:${want}`); continue; }
      if (!storage.includes(want)) hard.push(`capacity_mismatch:${want}≠${storage[0]}`);
      else if (storage.length > 1) hard.push(`capacity_ambiguous:${storage.join('/')}`);
    }
    for (const ram of spec.caps.filter(c => c < 64)) {
      if (!caps.some(c => c.n === ram)) hard.push(`memory_unverified:${ram}`);
    }
  }
  if (spec.sizes.length) {
    const sizes = listingSizes(title);
    for (const want of spec.sizes) {
      if (!sizes.size) soft.push(`size_unverified:${want}`);
      else if (!sizes.has(Math.round(want))) hard.push(`size_mismatch:${want}`);
      else if (sizes.size > 2) hard.push('size_ambiguous');
    }
  }
  if (spec.people) {
    const m = title.match(/(\d{1,2})\s*인\s*(?:용|분)/);
    if (m && Number(m[1]) !== spec.people) hard.push(`people_mismatch:${spec.people}≠${m[1]}`);
    else if (!m) soft.push('people_unverified');
  }
  if (spec.year && !opts.stored) {
    const years = [...title.matchAll(/(?<!\d)(20[12]\d)(?!\d)/g)].map(m => m[1]);
    if (years.length && !years.includes(spec.year)) hard.push(`year_mismatch:${spec.year}`);
  }

  /* 10. 색상·무선·성별·연령 */
  if (spec.colors.length) {
    const have = colorsIn(title.replace(/블루투스|bluetooth/gi, ' '));
    if (!spec.colors.some(c => have.includes(c))) hard.push(have.length ? `color_mismatch:${have[0]}` : 'color_unverified');
  }
  if (spec.wireless === true && /(?:유선)/.test(title) && !/(?:무선|블루투스|wireless|bluetooth|유무선|2\.4\s*g)/i.test(title)) hard.push('wired_only');
  if (spec.wireless === false && /(?:무선|블루투스|wireless|bluetooth|tws)/i.test(title) && !/(?:유선|유무선|wired|3\.5|aux)/i.test(title)) hard.push('wireless_only');
  if (spec.gender === 'f' && /(?:남성|남자|맨즈|\bmen'?s?\b)/i.test(title) && !/(?:여성|여자|공용|남녀|unisex|우먼|women)/i.test(title)) hard.push('gender_mismatch');
  if (spec.gender === 'm' && /(?:여성|여자|우먼|women|레이디)/i.test(title) && !/(?:남성|남자|공용|남녀|unisex|맨즈|\bmen\b)/i.test(title)) hard.push('gender_mismatch');
  if (spec.gender && !spec.kids && KIDS.test(title) && !/(?:성인|어른|남녀|공용|패밀리|가족)/.test(title)) hard.push('age_mismatch');

  if (opts.identityOnly) {
    const attribute = hard.splice(hardBeforeAttributes);
    hard.push(...attribute.filter(h => /^(?:capacity_unverified|capacity_ambiguous|size_ambiguous|color_unverified)/.test(h)));
    return { ok: hard.length === 0, hard: [...new Set(hard)], soft: [...new Set(soft)], principal };
  }

  /* 11. 상태(중고·리퍼·렌탈)·예산 */
  const state = S.conditionState(title, item && item.condition);
  if (state && spec.condition.excluded.has(state)) hard.push(`condition_excluded:${state}`);
  else if (spec.condition.wanted && spec.condition.wanted !== 'new' && spec.condition.wanted !== 'sealed') {
    if (!state || state === 'new' || state === 'sealed') hard.push(`condition_not_${spec.condition.wanted}`);
  } else if (spec.condition.wanted === 'new' || spec.condition.wanted === 'sealed') {
    if (state && state !== 'new' && state !== 'sealed') hard.push(`condition_excluded:${state}`);
  } else if (state === 'rental') hard.push('rental_not_purchase');
  else if (state === 'used' || state === 'refurbished' || state === 'display' || state === 'opened') soft.push(`condition:${state}`);
  if (!opts.stored && price > 0) {
    if (spec.budget.max && price > spec.budget.max) hard.push('over_budget');
    if (spec.budget.min && price < spec.budget.min) hard.push('under_budget');
  }

  return { ok: hard.length === 0, hard: [...new Set(hard)], soft: [...new Set(soft)], principal };
}

/* ------------------------------------------------------------------ *
 *  묶음 판정 — 검색 결과·저장·기록 행
 * ------------------------------------------------------------------ */

// 저장(분류)을 막는 soft — «이 키워드의 상품» 이라고 기록할 근거가 모자란 경우.
const IDENTITY_SOFT = /^(?:principal_unverified|brand_unverified|accessory_possible|identity_word_unverified|model_option_suffix|category_absent)/;

/**
 * 검색 결과 판정. relevance 는 _search.rankItems 가 붙인 값을 쓴다(정렬 근거).
 * @param {string|object} query 검색어 또는 parseQuery 결과
 * @returns {{kept:Array, rejected:Array<{item, hard}>, spec}}
 *   kept 의 각 상품에 identity('verified'|'unverified') · identityWhy(soft 사유) 를 붙인다.
 */
function gateItems(query, items, opts = {}) {
  const list = (items || []).filter(Boolean);
  const spec = query && typeof query === 'object' && query.tokens ? query
    : parseQuery(query, { titles: list.map(it => String(it.title || '')) });
  const kept = [];
  const rejected = [];
  for (const it of list) {
    const v = judge(spec, it, opts);
    if (!v.ok) { rejected.push({ item: it, hard: v.hard }); continue; }
    it.identity = v.soft.length ? 'unverified' : 'verified';
    it.identityWhy = v.soft.length ? v.soft.join(',') : undefined;
    kept.push(it);
  }
  return { kept, rejected, spec };
}

/** 저장해도 되는가 — hard 가 없고, 정체 확인에 필요한 근거가 빠지지 않았다. */
function saveFilter(query, items, opts = {}) {
  const r = gateItems(query, items, opts);
  const save = r.kept.filter(it => !String(it.identityWhy || '').split(',').some(w => IDENTITY_SOFT.test(w)));
  return { save, rejected: r.rejected, held: r.kept.filter(it => !save.includes(it)), spec: r.spec };
}

const rowCache = new Map();
/*
 * 기록 행 분류에서 «다른 상품» 으로 단정할 사유 — 표본 수작업 검토로 정밀도가 높은 것만 (2026-11-15).
 *
 * 저장된 keyword 는 그 상품을 처음 찾은 «검색 문장» 이라 느슨하다(«자외선 차단 의류», «여행 지갑»).
 * 검색 화면에서는 느슨한 근거로도 뒤로 미루면 되지만, 기록 행을 «오염» 으로 세거나 정정 후보로
 * 올리려면 틀렸다는 근거가 분명해야 한다. 그 밖의 사유는 unknown(정정하지 않음)이다.
 */
// category_absent 는 표본에서 정밀도 ≈60% 였다(«혈관 건강 영양제» ↔ 오메가3, «CJ 햇반 즉석밥» ↔ 햇반 12곡밥 — 같은 물건의 다른 이름) → 단정하지 않는다.
const STORED_MISMATCH = /^(?:keyword_absent|keyword_coverage|other_device|not_type|accessory|part|line_number(?!_unverified)|generation|model_conflict|variant_extra|variant_missing|capacity_mismatch|publication_not_device|rental_not_purchase|head_is_target|compatible_part|target_of|line_absent|pc_component)/;
// 기기 키워드일 때만 단정하는 사유 — 범주가 정해지지 않은 키워드(«카약 패들», «여행 지갑»)에서는 부속 사전이 틀리기 쉽다.
const DEVICE_ONLY = /^(?:accessory|part|head_is_target|target_of)/;

/**
 * 저장된 (keyword, title) 의 분류 판정. 가격·예산은 보지 않는다.
 * @returns {{verdict:'match'|'mismatch'|'unknown', reasons:string[]}}
 */
function classifyStoredRow(keyword, title) {
  const kw = String(keyword || '').trim();
  if (!kw || kw.startsWith('__')) return { verdict: 'unknown', reasons: ['no_keyword'] };
  const key = `${kw}\u0001${title}`;
  const cached = rowCache.get(key);
  if (cached) return cached;
  const spec = parseQuery(kw);
  let out;
  if (!spec.tokens.length) out = { verdict: 'unknown', reasons: ['no_tokens'] };
  else {
    const v = judge(spec, { title }, { stored: true });
    // 키워드의 «낱말» 이 하나도 상품명에 없으면 그 자체로 다른 상품이다 (옛 matchesKeyword 의 하한 — 콜라 ↔ 수영복).
    // 한 글자 키워드(«귤»)는 점수기가 한 글자 토큰을 보지 않으므로 글자 포함으로 본다.
    const flatTitle = normalize(title).replace(/\s+/g, '');
    // 단위 낱말은 숫자 뒤에 올 때만 단위다(«1박스»). «수납 박스» 의 «박스» 는 물건 이름이다.
    const words = spec.tokens.filter((t, i) => !NOT_HEAD.has(t) && !(UNIT_AFTER.has(t) && /\d/.test(spec.tokens[i - 1] || '')));
    const anyWord = !words.length || words.some(t => flatTitle.includes(t) || present(t, titleInfoOf(title)));
    const hard = v.hard.slice();
    if (!anyWord) hard.unshift('keyword_absent');
    else if (words.every(t => t.length >= 2)) {
      const coverage = S.scoreTitle(spec.analysis, title).score;
      if (coverage < 0.2) hard.push(`keyword_coverage:${coverage}`);
    }
    const decisive = hard.filter(h => STORED_MISMATCH.test(h) && (!DEVICE_ONLY.test(h) || !!spec.type));
    if (decisive.length) out = { verdict: 'mismatch', reasons: decisive.concat(hard.filter(h => !decisive.includes(h))) };
    else if (hard.length || v.soft.some(w => IDENTITY_SOFT.test(w))) out = { verdict: 'unknown', reasons: hard.concat(v.soft) };
    else out = { verdict: 'match', reasons: [] };
  }
  if (rowCache.size > 20000) rowCache.clear();
  rowCache.set(key, out);
  return out;
}

/**
 * 확인된 상품 → 확인 못 한 상품 순. 같은 묶음 안에서는 기존 정렬(관련도 → 신뢰도 → 가격) 그대로.
 * 가격순으로 다시 세우는 화면(public/index.html byPrice)도 이 묶음을 먼저 본다.
 */
function orderByIdentity(items) {
  const verified = (items || []).filter(it => it && it.identity !== 'unverified');
  const unverified = (items || []).filter(it => it && it.identity === 'unverified');
  return S.sortByRelevance(verified).concat(S.sortByRelevance(unverified));
}

module.exports = {
  parseQuery, judge, gateItems, saveFilter, classifyStoredRow, orderByIdentity,
  // 진단·테스트용
  _internal: { headNoun, familyRuns, listingRunsAfter, listingVariants, queryVariants, listingCapacities, modelCodesOf, headIsTarget, brandsIn, identityWordsOf, IDENTITY_SOFT }
};
