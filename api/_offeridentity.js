'use strict';
/*
 * Cross-merchant Product Identity — 판매처 오퍼끼리 «같은 상품 · 같은 옵션 · 같은 판매 형태» 인가.
 *
 *     merchant offer → normalized identity → canonical product group → price comparison
 *
 * ── 이 파일이 지키는 단 하나의 원칙 ────────────────────────────────
 *
 *     false merge (다른 상품을 한 가격비교 그룹에)  ≫  missed merge (같은 상품을 못 묶음)
 *
 *   "이 몰이 더 싸다" 는 문장은 두 값이 같은 물건일 때만 참이다. 확신이 없으면
 *   MATCH 가 아니라 REVIEW 다. 판정은 셋이다.
 *
 *     MATCH     강한 증거(Tier A/B)가 있고, 충돌도 «모르는 값» 도 없다
 *     REVIEW    같은 상품일 수 있지만 한쪽만 아는 값(용량·색·수량·상태…)이 있다
 *     NO_MATCH  명확한 충돌이 있거나, 같은 상품이라는 근거가 없다
 *
 * ── 증거 위계 ──────────────────────────────────────────────────────
 *
 *   Tier A  같은 GTIN/EAN/UPC · 같은 제조사 모델번호(SM-R630 = SMR630 = SM R630)
 *   Tier B  브랜드 · 계열 낱말 · 모델 번호(17·S26·3S·V15) · 등급(Pro·Max·Ultra·+) 이 모두 같다
 *   Tier C  제목 유사도 — 여기서는 쓰지 않는다. Tier C 만으로는 절대 MATCH 가 아니다.
 *
 *   ★ 충돌 관문(hard conflict gate)이 점수보다 먼저다. 모델·등급·용량·수량·상태·
 *     부속·대체품·렌탈·번들 중 하나라도 «둘 다 알고 값이 다르면» 즉시 NO_MATCH 다.
 *   ★ 모르는 값은 와일드카드가 아니다. 한쪽만 256GB 라고 적었으면 REVIEW 다.
 *     한쪽 생략을 허용하는 것은 판매 관행상 «안 적으면 기본값» 인 표기뿐이다:
 *       연식 · «1개»(수량 표기 없음) · «새상품»(상태 표기 없음) · «국내정품»(지역 표기 없음)
 *       · 브랜드(계열 낱말이 남을 때) · 제조사 모델번호(같은 계열에 다른 모델번호가 관측되지 않을 때)
 *     용량·색은 그 계열에서 옵션으로 관측되면 «둘 다 안 적음» 도 REVIEW 다(lineDimensionsOf).
 *
 * ── 묶기 (clusterOffers) ───────────────────────────────────────────
 *
 *   union-find 로 이어 붙이지 않는다. A~B, B~C 만으로 A~C 가 되면, 용량을 안 적은
 *   B 가 256GB(A) 와 512GB(C) 를 잇는 다리가 된다(bridge poisoning). 새 오퍼는
 *   군집의 **모든** 구성원과 MATCH 여야 들어간다(all-pairs). MATCH 는 한쪽만 아는
 *   값을 허용하지 않으므로, 옵션을 모르는 오퍼는 애초에 어느 군집의 다리도 못 된다.
 *
 * ── 이 파일이 하지 않는 것 ─────────────────────────────────────────
 *
 *   DB 를 읽거나 쓰지 않는다. products · price_history 를 바꾸지 않는다. LLM 을 부르지
 *   않는다 — 모델번호·GTIN·용량·등급·수량·상태·부속 충돌은 결정론 규칙만 판정한다.
 *
 * ── 공유하는 것 (PR #133 과 중복 금지) ─────────────────────────────
 *
 *   _search      토큰화(붙여 쓴 모델명 분해 포함) · 등급 표기(variantMarkers) · 상태 패턴 ·
 *                부속 낱말(accessoryTerms) · 판매 대상 판정(productFocus) · 대체품 표기
 *   _identitycore 색 · 용량 단위 · 판매자 지시문 걷어내기 (_aiidentity 와 같은 함수)
 *   _aiidentity 는 «질의 ↔ 후보» 계약이라 쓰지 않는다. 이쪽은 «오퍼 ↔ 오퍼» 다.
 */

const S = require('./_search');
const Core = require('./_identitycore');

const DECISION = Object.freeze({ MATCH: 'MATCH', REVIEW: 'REVIEW', NO_MATCH: 'NO_MATCH' });

/* ==================================================================
 *  0) 사전 — 특정 상품이 아니라 «표기 체계» 다
 * ================================================================== */

/*
 * 브랜드. 둘 다 적혀 있고 다르면 다른 상품이다. 표기가 여럿인 것만 둔다 —
 * 여기 없는 브랜드는 그냥 «낱말» 로 남아 양쪽 제목에 똑같이 있어야 한다(더 엄격하다).
 */
const BRANDS = [
  ['samsung', ['samsung', '삼성', '삼성전자']],
  ['apple', ['apple', '애플']],
  ['logitech', ['logitech', '로지텍', '로지텍코리아']],
  ['dyson', ['dyson', '다이슨']],
  ['sony', ['sony', '소니']],
  ['lg', ['lg', '엘지', 'lg전자']],
  ['bose', ['bose', '보스']],
  ['xiaomi', ['xiaomi', '샤오미']],
  ['lenovo', ['lenovo', '레노버']],
  ['asus', ['asus', '에이수스', '아수스']],
  ['microsoft', ['microsoft', '마이크로소프트']],
  ['nintendo', ['nintendo', '닌텐도']],
  ['jbl', ['jbl', '제이비엘']],
  ['beats', ['beats', '비츠']],
  ['philips', ['philips', '필립스']],
  ['canon', ['canon', '캐논']],
  ['nikon', ['nikon', '니콘']],
  ['gopro', ['gopro', '고프로']],
  ['anker', ['anker', '앤커']],
  ['garmin', ['garmin', '가민']],
  ['google', ['google', '구글']]
];
const BRAND_OF = new Map();
BRANDS.forEach(([canon, aliases]) => aliases.forEach(a => BRAND_OF.set(a, canon)));

/*
 * 제조사가 하나뿐인 상표 계열 — 브랜드를 생략해도 브랜드가 정해진다.
 * galaxy 는 계열 낱말로 남기지 않는다(«삼성 버즈 프로3» 와 «Galaxy Buds3 Pro» 는 같다).
 * iphone 등은 브랜드를 정하면서 계열 낱말로도 남는다(아이폰 ≠ 아이패드).
 */
const SUB_BRANDS = new Map([['galaxy', 'samsung'], ['갤럭시', 'samsung']]);
const IMPLIED_BRAND = new Map([
  ['iphone', 'apple'], ['ipad', 'apple'], ['airpods', 'apple'], ['macbook', 'apple'], ['imac', 'apple']
]);

/*
 * 한글 ↔ 영문 표기. 값은 비교에 쓰는 정규형. _search 의 동의어 체계와 어긋나지 않는지
 * scripts/test-offer-identity.js 가 지킨다(같은 두 낱말이 _search 에서 다른 묶음이면 실패).
 */
const ALIASES = new Map([
  ['아이폰', ['iphone']], ['에어팟', ['airpods']], ['아이패드', ['ipad']], ['맥북', ['macbook']],
  ['아이맥', ['imac']], ['버즈', ['buds']], ['워치', ['watch']], ['마스터', ['master']],
  ['mxmaster', ['mx', 'master']], ['탭', ['tab']],
  ['오리진', ['origin']], ['플러피', ['fluffy']], ['서브마린', ['submarine']], ['슬림', ['slim']],
  ['티타늄', ['titanium']], ['내추럴', ['natural']], ['미드나잇', ['midnight']],
  ['스타라이트', ['starlight']], ['그래파이트', ['graphite']], ['스페이스', ['space']]
]);

/* 기기 종류 — 같은 상품의 서로 다른 판매 글이 종류를 다르게 적을 수는 없다. */
const CATEGORY_CLASSES = [
  ['earphone', ['이어폰', '이어버드', 'earbuds', 'earbud', 'earphone', 'earphones']],
  ['headphone', ['헤드폰', '헤드셋', 'headphone', 'headphones', 'headset']],
  ['phone', ['스마트폰', '휴대폰', '핸드폰', 'smartphone']],
  ['mouse', ['마우스', 'mouse']],
  ['keyboard', ['키보드', 'keyboard']],
  ['vacuum', ['청소기', 'vacuum']],
  ['laptop', ['노트북', '랩탑', 'laptop', 'notebook']],
  ['tablet', ['태블릿', 'tablet']],
  ['smartwatch', ['스마트워치', 'smartwatch']],
  ['speaker', ['스피커', 'speaker']],
  ['monitor', ['모니터', 'monitor']]
];
const CATEGORY_OF = new Map();
CATEGORY_CLASSES.forEach(([cls, words]) => words.forEach(w => CATEGORY_OF.set(w, cls)));
/* 종류명 앞에 붙어도 종류를 바꾸지 않는 말 ("블루투스이어폰"). 그 밖의 앞말("스틱청소기"의 스틱)은 낱말로 남는다. */
const CATEGORY_PREFIX_NOISE = new Set(['블루투스', '무선', '완전무선']);

/*
 * 식별에 쓰지 않는 말 — 판매 경로 · 정품 표기 · 배송 · 일반 종류어 · 세대 표기.
 * ★ 기능·구성 표기(노이즈캔슬링·USB-C·유선충전·for Mac)는 여기 넣지 않는다.
 *   그 말이 한쪽에만 있으면 다른 모델일 수 있다(에어팟 4 ↔ 에어팟 4 ANC).
 */
const NOISE_WORDS = new Set([
  '정품', '국내정품', '정발', '공식', '공식판매', '공식판매처', '공식인증', '공식수입', '인증점', '정품인증',
  '국내', '국내판', '국내as', 'as', '가능', '국내유통', '공식대리점', '대리점', '수입', '본사',
  '상품', '제품', '모델', '신형', '신제품', '최신', '최신형', '출시', '정식', '신상', '신상품',
  '단품', '단일상품', '단일', '본품', '본체', '기본', '일반', '선택', '옵션',
  '새상품', '새제품', '신품', '미개봉', '미사용', '새것', '박스', '풀박스',
  '자급제', '공기계', '언락', 'unlocked', '요금제자유', '번호그대로', '통신사유심변경',
  '무료배송', '당일발송', '당일출고', '빠른배송', '로켓배송', '국내배송', '국내발송', '무배', '택배', '배송',
  '이마트몰', '셀러허브', '관부가세', '포함', '별도',
  '결제가', '판매가', '할인가', '특가', '최저가', '최종가', '정가', '정상가', '택가', '소비자가', '할인', '쿠폰', '적립', '행사', '이벤트',
  // 판매 채널·입점 꼬리표 (운영 ADPICK 제목에서 관측). 상품이 아니라 «어디서 파는가» 다.
  '보리보리', '하프클럽', '문구도매', '아트박스', 'poom', '상품상세', '참조', '상세페이지', '현대백화점', '롯데백화점',
  '신세계백화점', '본사직영', '직영', '물류배송', '공식몰', '공식판매점', '판매점', '정품판매점', '셀러에이드',
  '알티피아', '베이스캠프', '오너클랜', '마트인코리아', '코스트코', '본사인증점', '공식파트너', '파트너',
  '블루투스', 'bluetooth', '무선', 'wireless', '완전무선', '트루', 'true',
  '디지털기기', '디지털', '기기', '가전', '전자', '전자기기',
  'gen', 'generation', '세대', '시리즈', 'series', '버전', 'version', 'ver',
  '용량', '색상', '컬러', 'color', 'colour', '사이즈', 'size',
  'new', 'the', 'and', 'with', 'of', 'by'
]);

/* 숫자 뒤에 오는 한국어 단위어 — 그 숫자는 규격·수량이다 ("60초" · "3단" · "6인용" · "30구" · "4종" · "9피트"). */
const KOREAN_COUNTERS = new Set(['초', '분', '시간', '개월', '개월분', '일', '일분', '주', '주년', '회', '배', '단', '구', '종',
  '인', '인용', '인분', '평', '평형', '미', '과', '수', '색', '겹', '층', '권', '호', '번', '차', '도', '피트', '핀', '홀',
  '포', '정', '캡슐', '알', '티백', '매', '장', '롤', '줄', '칸', '면', '단계', '방향', '구용', '와트', '볼트', '키', '현',
  '컬러', '색상', '가지', '피스', '조각', '마리', '송이', '봉지', '대']);
/* 한 글자 한글 중 식별에 쓰지 않는 것(조사·접속·수량 꼬리). 그 밖의 한 글자(중·소·대·킹)는 낱말로 비교한다. */
const SINGLE_CHAR_STOP = new Set(['및', '등', '외', '의', '와', '과', '형', '용', '개', '팩', '입', '이', '가', '을', '를', '은', '는',
  '도', '로', '만', '에', '총', '약', '각', '택', '것', '내', '추', '새']);
/*
 * 팔레트(_identitycore.COLOR_GROUPS)에 없지만 의류·가방에서 흔한 색 이름. 오퍼 식별에서만,
 * 낱말 전체가 그 색일 때만 읽는다 — "수분크림"·"올리브오일" 같은 낱말은 건드리지 않는다.
 */
const EXTRA_COLORS = new Map([
  ['카키', 'khaki'], ['khaki', 'khaki'], ['차콜', 'charcoal'], ['charcoal', 'charcoal'], ['버건디', 'burgundy'],
  ['burgundy', 'burgundy'], ['라벤더', 'lavender'], ['코랄', 'coral'], ['카멜', 'camel'], ['camel', 'camel'],
  ['테라코타', 'terracotta'], ['보르도', 'bordeaux'], ['멜란지', 'melange'], ['옐로', 'yellow']
]);
/* 의류·신발 — 색이 반드시 SKU 를 가른다(같은 스타일 번호라도 색마다 다른 상품이다). 낱말 끝말로 본다. */
const APPAREL_NOUNS = ['운동화', '스니커즈', '러닝화', '런닝화', '조깅화', '축구화', '야구화', '등산화', '부츠', '샌들', '슬리퍼',
  '구두', '로퍼', '펌프스', '자켓', '재킷', '점퍼', '패딩', '코트', '티셔츠', '셔츠', '바지', '팬츠', '청바지', '원피스', '스커트',
  '니트', '후드', '집업', '양말', '수영복', '레깅스', '모자', '비니', '드레스', '블라우스', '조끼', '베스트', 'sneakers', 'shoes', 'jacket', 'tshirt', 'pants', 'jeans',
  'dress', 'hoodie', 'socks', 'boots'];

/* 상표·계열 낱말 (for/호환 뒤에 오면 «그 상품용» 이라는 뜻) */
function isFamilyWord(tok) {
  return BRAND_OF.has(tok) || SUB_BRANDS.has(tok) || IMPLIED_BRAND.has(tok)
    || (ALIASES.has(tok) && IMPLIED_BRAND.has(ALIASES.get(tok)[0]));
}

/* ==================================================================
 *  1) 판매 형태 · 상태 · 지역 · 구성 표기
 * ================================================================== */

/* 판매 형태. 표기가 없으면 구매다 — 렌탈·구독·약정은 판매 글이 반드시 밝힌다. */
const TRANSACTION_PATTERNS = [
  ['subscription', /구독|subscription|정기\s*배송|정기\s*결제/i],
  ['rental', /렌탈|렌털|대여|\brental\b|\blease\b|\bleasing\b/i],
  ['contract', /\d+\s*개월\s*약정|약정\s*(?:가입|필수|조건)|번호\s*이동|기기\s*변경|신규\s*가입|통신사\s*개통|(?:skt|kt|lg\s*u\+?)\s*(?:개통|약정)/i]
];

/*
 * 상품 상태. _search.CONDITION_PATTERNS 를 그대로 쓰고, 중고 거래에서 흔한 등급 표기만 더한다.
 * 표기가 없으면 'unstated' — 새상품이라고 추측하지 않는다.
 */
const EXTRA_CONDITION = [
  // English listings commonly state "new" without "brand new"; keep this
  // token-bound and exempt the New Balance brand so new/used is a hard conflict.
  ['new', /\bnew\b(?!\s+balance\b)/i],
  ['used', /(?:^|[^a-z0-9가-힣])[sabc]\s*급|(?:^|[^a-z])(?:pre-?owned|second-?hand)(?:[^a-z]|$)/i],
  ['opened', /반품\s*(?:상품|제품|재판매)|리퍼브|\bopen\s*box\b/i]
];
const CONDITION_CANON = { new: 'new', sealed: 'new', opened: 'open_box', used: 'used', refurbished: 'refurbished', display: 'display' };
const CONDITION_RANK = ['refurbished', 'used', 'display', 'open_box'];

const REGION_OVERSEAS_RE = /\[\s*해외\s*\]|해외\s*(?:판|직구|구매|배송|버전|정품|모델)|직구|글로벌\s*(?:판|버전|모델)|중국\s*(?:판|내수)|병행\s*수입|\b(?:global|international|china|us|eu|hk)\s*(?:version|ver)\b/i;
const REGION_DOMESTIC_RE = /국내\s*(?:정품|정발|판|as|유통|공식|모델)|정발|\bkr\s*(?:version|ver)\b/i;

/* 구성 — 번들·세트·패키지, "+ 구성품", 사은품. "1+1" 은 수량이다. */
const BUNDLE_WORD_RE = /번들|패키지|\bbundle\b|\bpackage\b|\bkit\b|기획\s*세트|선물\s*세트|구성\s*세트/i;
/* "+ 케이스" · "30구+30구" — 덧붙인 구성. ("1+1" 은 이보다 먼저 수량으로 읽혀 지워진다) */
const BUNDLE_PLUS_RE = /\+\s*(?=[a-z가-힣]|\d+(?:\.\d+)?\s*[a-z가-힣])/i;
const GIFT_RE = /사은품|증정|\bgift\b|\bfree\s+\w+\s+included\b|덤\s*(?:증정|포함)/i;
const BODY_ONLY_RE = /본체\s*만|본품\s*만|기기\s*만|\bbody\s*only\b/i;

/*
 * «본품이 아니라 그 일부만 판다» 는 표기 — 한쪽 유닛, 충전 케이스만, 본품 미포함.
 * 그 자체로 부속 판매다. 본품과 같은 그룹이 되면 안 된다.
 */
const PART_RE = /유닛|한\s*쪽|한\s*짝|왼쪽|오른쪽|좌측|우측|낱개|분실\s*(?:대체|교체)|부품용|본(?:품|체)\s*(?:미포함|제외|별도|없음|불포함)|(?:charging\s*)?case\s*only|케이스\s*만|충전\s*케이스\s*(?:단품|만)|\b(?:unit|parts?)\s*only\b|\b(?:left|right)\s*(?:side\s*)?(?:ear(?:bud)?|bud|unit|only)\b|\((?:l|r)\)/i;

/* 대체품·호환품 — 정품 모델과 같은 그룹이 될 수 없다 (_search.substituteRelation 에 더해). */
const COMPAT_RE = /호환|compatible|대체품|대체용|\breplacement\b|\bfits\s+(?:for\s+)?[a-z]|(?:정품\s*)?(?:동일|같은)\s*디자인|스타일\s*(?:블루투스|무선|이어폰)|짝퉁|레플리카|레플|이미테이션|가품|유사품|\breplica\b|\blookalike\b|\bimitation\b|\bclone\b|\bdupe\b/i;

/* _search 의 부속 낱말에 없는 영문 부속명 (오퍼 판정 전용). 정확히 그 낱말일 때만. */
const EXTRA_ACCESSORY = ['film', 'films', 'tips', 'eartips', 'eartip', 'sleeve', 'holder', 'mount', 'stand',
  'lanyard', 'keychain', 'keyring', 'sticker', 'stickers', 'skin', 'skins', 'decal', 'glass', 'grip',
  '키링', '이어캡', '이어후크', '그립톡', '키캡', '스킨'];
/* "Mouse Pad" 처럼 앞 낱말과 함께여야 부속인 것 */
const PAIRED_ACCESSORY = [[/^(mouse|마우스)$/, /^pads?$/], [/^(screen|액정)$/, /^(guard|protector|보호)$/]];
/* 부속 낱말 바로 뒤에서 «본품에 딸려 온다» 를 밝히는 말 (_search.COMPONENT_MARK_RE 와 같은 뜻). */
const COMPONENT_MARK_RE = /^(포함|증정|동봉|내장|사은품|included|탑재|장착|부착|함께|구성|제공)$/;
const COMPONENT_SUFFIX_RE = /(포함|증정|동봉|내장|탑재|장착)$/;
/* 부속 판정 정규형 — 표기만 다른 같은 부속 */
const ACCESSORY_CANON = new Map([
  ['케이스', 'case'], ['커버', 'case'], ['cover', 'case'], ['shell', 'case'], ['bumper', 'case'], ['pouch', 'pouch'], ['파우치', 'pouch'],
  ['필름', 'film'], ['films', 'film'], ['보호필름', 'film'], ['액정보호', 'film'], ['강화유리', 'film'], ['glass', 'film'], ['protector', 'film'],
  ['이어팁', 'tips'], ['eartips', 'tips'], ['eartip', 'tips'], ['ear', 'tips'], ['tips', 'tips'], ['이어캡', 'tips'],
  ['충전기', 'charger'], ['charger', 'charger'], ['어댑터', 'adapter'], ['adapter', 'adapter'], ['케이블', 'cable'], ['cable', 'cable'],
  ['스트랩', 'strap'], ['strap', 'strap'], ['lanyard', 'strap'], ['거치대', 'stand'], ['받침대', 'stand'], ['stand', 'stand'], ['holder', 'stand'], ['mount', 'stand'],
  ['스킨', 'skin'], ['skin', 'skin'], ['skins', 'skin'], ['키스킨', 'skin'], ['decal', 'skin'], ['스티커', 'sticker'], ['sticker', 'sticker'], ['stickers', 'sticker']
]);

/* ==================================================================
 *  2) 값 뽑기 — 뽑은 표기는 문자열에서 지워서, 숫자가 모델 번호로 다시 읽히지 않게 한다
 * ================================================================== */

/* 금액은 식별이 아니다 ("[결제가 160만]"). _aiidentity 의 금액 표기와 같은 꼴. */
const MONEY_RE = /(\d[\d,]*(?:\.\d+)?\s*(?:[~\-–]|에서)\s*)?\d[\d,]*(?:\.\d+)?\s*(?:(?:억|만|천)\s*원?|원)/g;

const COUNT_UNITS = '개입|개|팩|입|병|캔|세트|묶음|박스|봉|매|장|롤|켤레|족|ea|pcs|pc|packs|pack|pk|sets|set|count|ct';
const COUNT_RE = new RegExp(`(?<![a-z0-9.])(\\d{1,3})\\s*(?:${COUNT_UNITS})(?:\\s*(?:세트|묶음))?(?![a-z가-힣])`, 'gi');
const TOTAL_COUNT_RE = new RegExp(`총\\s*(\\d{1,3})\\s*(?:${COUNT_UNITS})(?![a-z가-힣])`, 'gi');
const PLUS_PROMO_RE = /(?<![a-z0-9.])([1-9])\s*\+\s*([1-9])(?![0-9])/g;
/* "200ml x2" · "×3" · "x 2개" — x 가 낱말 머리일 때만. "AirPods Max 2" 의 x 는 수량이 아니다. */
const MULT_RE = new RegExp(`(?<=^|[\\s)\\]])[x×*]\\s*(\\d{1,3})(?:\\s*(?:${COUNT_UNITS}))?(?![\\d가-힣a-z.])`, 'gi');

/* 규격 — 화면 크기·길이·부피·무게·함량·배터리·출력·해상도·속도. 단위가 다르면 따로 비교한다. */
const SPEC_RE = /(?<![a-z0-9.])(\d+(?:\.\d+)?)\s*(인치|inch|"|형(?![가-힣])|mm|cm|m(?![a-z0-9])|ml|l(?![a-z])|kg|mg|mcg|iu|g(?![a-z])|oz|mah|w(?![a-z])|hz|mp(?![a-z0-9])|nm|mbps|gbps|p(?![a-z0-9])|k(?![a-z0-9])|t(?![a-z0-9]))/gi;
const SPEC_UNIT = { 인치: 'in', inch: 'in', '"': 'in', 형: 'in', mm: 'mm', cm: 'cm', m: 'm', ml: 'ml', l: 'l', kg: 'kg', mg: 'mg', mcg: 'mcg', iu: 'iu', g: 'g', oz: 'oz', mah: 'mah', w: 'w', hz: 'hz', mp: 'mp', nm: 'nm', mbps: 'mbps', gbps: 'gbps', p: 'p', k: 'k', t: 't' };
const UNIT_ONLY_RE = /^\d+(?:\.\d+)?(?:w|mah|mm|cm|m|ml|hz|gb|tb|mb|kg|mg|g|l|mp|nm|mbps|gbps|p|k|t|인치)$/i;

const CAPACITY_TEXT_RE = /(?<![a-z0-9.])(\d+)\s*(gb|tb)(?![a-z])/gi;
const MEMORY_WORD_RE = /(?:ram|램|메모리|memory|lpddr\d*|ddr\d*)/i;

const YEAR_RE = /(?<![0-9a-z])(20[0-3]\d)\s*(?:년형|년식|년|형)?(?![0-9])/g;

/*
 * 제조사 모델번호. 하이픈으로 이은 것(SM-R630·WH-1000XM5), 붙여 쓴 것(SMR630), 애플 부품번호(MTJV3KH/A).
 * 하이픈 뒤의 점도 잇는다 — 뒤가 영문일 때만(16Z95U-G.AS5ZK). 1.5L 같은 소수는 잇지 않는다.
 */
const CODE_HYPHEN_RE = /(?<![a-z0-9])[a-z0-9]+(?:-[a-z0-9]+)+(?:\.(?=[a-z])[a-z0-9]+)*(?:\/[a-z])?(?![a-z0-9])/gi;
const CODE_SINGLE_RE = /(?<![a-z0-9-])(?=[a-z0-9]*[a-z])(?=(?:[a-z]*\d){3})[a-z0-9]{4,}(?:\/[a-z])?(?![a-z0-9-])/gi;
const APPLE_PART_RE = /(?<![a-z0-9])[a-z0-9]{5,}\/[a-z](?![a-z0-9])/gi;
/* "SM R630" — 짧은 영문 접두와 모델번호가 띄어 쓰인 것. 접두가 알려진 낱말이면 잇지 않는다. */
const CODE_SPACED_RE = /(?<![a-z0-9])([a-z]{2,3})\s+([a-z]\d{3,}[a-z0-9]*)(?![a-z0-9])/gi;
/* 모델번호가 못 된 하이픈·영숫자 덩어리 중 7자리 이상 숫자를 품은 것은 판매처 번호다 — 낱말로도 남기지 않는다. */
const LONG_DIGITS_RE = /\d{7,}/;

function erase(s, re, fn) {
  return s.replace(re, (...m) => { if (fn) fn(...m); return ' '; });
}

/** GTIN 체크섬 (8·12·13·14자리). 아무 긴 숫자나 바코드로 보지 않는다. */
function validGtin(d) {
  if (!/^\d{8}$|^\d{12,14}$/.test(d)) return false;
  const digits = d.split('').map(Number);
  const check = digits.pop();
  let sum = 0;
  digits.reverse().forEach((n, i) => { sum += n * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}
function normGtin(v) {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  return validGtin(d) ? d.padStart(14, '0') : '';
}

/**
 * 모델번호를 비교용 조각으로 — 앞 영문(pre) · 숫자부터의 몸통(body) · 블록 키(key: 몸통 끝 영문을 뗀 것).
 *   SMR630 → smr / 630 / 630      SM-S948NZKAKOO → sms / 948nzkakoo / 948      14ZD95U → '' / 14zd95u / 14zd95
 */
function codeParts(code) {
  const c = String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const m = c.match(/^([a-z]*)(\d.*)$/);
  if (!m) return null;
  return { code: c, pre: m[1], body: m[2], key: m[2].replace(/[a-z]+$/, '') || m[2] };
}

/**
 * 두 모델번호가 같은 모델을 가리키는가.
 *   SMR630 = SM-R630 = SM R630                 exact
 *   R630 ≈ SMR630 (제조사 접두 생략)            loose — 브랜드를 양쪽에서 확인해야 쓴다
 *   SMR630NZWAKOO ≈ SMR630 (두 글자 이상의 색·지역 접미) loose
 *   14ZD95U ≠ 14ZD95S · 14ZD95U ≠ 14ZD95 (한 글자 차이는 다른 모델) · R630 ≠ R530 · S630 ≠ SMR630
 * @returns {'exact'|'loose'|''}
 */
function codeRelation(a, b) {
  const A = codeParts(a), B = codeParts(b);
  if (!A || !B) return '';
  const preOk = A.pre === B.pre || A.pre.endsWith(B.pre) || B.pre.endsWith(A.pre);
  if (!preOk) return '';
  if (A.body === B.body) return A.pre === B.pre ? 'exact' : 'loose';
  const [short, long] = A.body.length < B.body.length ? [A.body, B.body] : [B.body, A.body];
  return long.startsWith(short) && /^[a-z]{2,}$/.test(long.slice(short.length)) ? 'loose' : '';
}

function addCode(set, raw) {
  const r = String(raw || '').toLowerCase();
  const c = r.replace(/[^a-z0-9]/g, '');
  // 영문이 섞인 긴 번호(1011C234003 · HF3717068 · 045112404GM)는 스타일·색 코드다 — 모델번호로 비교한다.
  // 숫자만 긴 것은 판매처 상품번호라 여기 오지 않는다(longNumbers).
  if (!c || UNIT_ONLY_RE.test(c) || /^\d+(?:gb|tb)$/.test(c)) return false;
  // 애플 부품번호(MTJV3KH/A)는 숫자가 적다 — "/한 글자" 꼴이면 숫자 하나로도 모델번호다.
  const applePart = /^[a-z0-9]{5,}\/[a-z]$/.test(r) && /\d/.test(c) && /[a-z]/.test(c);
  if (!applePart && (!/[a-z]/.test(c) || (c.match(/\d/g) || []).length < 3 || c.length < 4)) return false;
  /*
   * «숫자 + 단위 글자» 는 모델번호가 아니라 규격·수량이다 (500mg · 1080p · 100T · 3600Mbps · 660nm).
   * 치수(1200x900 · 640x640)도 마찬가지다. 운영 데이터에서 이런 «코드» 가 맛·브랜드가 다른 상품을
   * 같은 모델로 이었다. 모델번호는 영문이 숫자 앞에 있거나(R630·G304) 숫자 사이에 낀다(1000XM5·14ZD95U).
   */
  if (/^\d+[a-z]+$/.test(c) || /^\d+x\d+(?:x\d+)?[a-z]*$/.test(c)) return false;
  set.add(c);
  return true;
}

function knownWord(tok) {
  return BRAND_OF.has(tok) || SUB_BRANDS.has(tok) || IMPLIED_BRAND.has(tok) || ALIASES.has(tok)
    || S.VARIANT_KEYS.has(tok) || NOISE_WORDS.has(tok) || CATEGORY_OF.has(tok);
}

/*
 * 모델 번호(앵커) 꼴 — 17 · S26 · V15 · V15S · 3S · A55. 세 자리 이상 영숫자는 모델번호(code) 쪽이다.
 * 영문 접두는 한 글자만 — IP68 · BT5 같은 규격 표기가 모델 번호로 읽히지 않게.
 */
const ANCHOR_RE = /^(?:\d{1,4}|[a-z]\d{1,2}[a-z]?|\d{1,2}[a-z]{1,2})$/;
const ORDINAL_RE = /(?<![a-z0-9])(\d{1,2})\s*(?:st|nd|rd|th)(?![a-z])/gi;

/** 같은 꼴의 앵커가 둘 이상이면 여러 모델을 나열한 판매 글이다 (S26 S25 S24 · 17 16 15). */
function anchorShape(a) { return a.replace(/\d+/g, '#'); }

/* ==================================================================
 *  3) 오퍼 하나 → 식별 속성
 * ================================================================== */

/**
 * @param {string|object} input  제목 문자열 또는
 *   {title, mall, productId, vendorItemId, condition, gtin|ean|upc|barcode, modelNumber, brand, key, price}
 * @returns {object} identity (아래 필드). 같은 객체를 다시 넣으면 그대로 돌려준다.
 */
function parseOffer(input) {
  if (input && input.__offerIdentity) return input;
  const o = typeof input === 'string' ? { title: input } : Object.assign({}, input || {});
  const title = String(o.title || '');
  const raw = Core.cleanIdentityTitle(title).normalize('NFKC');
  const lower = raw.toLowerCase();

  const id = {
    __offerIdentity: true,
    key: o.key != null ? String(o.key) : `${o.mall || ''}|${o.productId || ''}|${o.vendorItemId || ''}|${title}`,
    title, mall: String(o.mall || ''), productId: String(o.productId || ''),
    vendorItemId: String(o.vendorItemId || ''), price: Number(o.price) || 0,
    brand: '', brands: [], words: [], category: '', categories: [], deviceClass: '',
    anchors: [], primaryAnchor: '', multiModel: false, variants: [],
    modelNumbers: [], gtins: [],
    storage: [], storageOptions: false, memory: [], specs: {}, included: [], longNumbers: [], wordSeq: [], quantity: null, quantityAmbiguous: false,
    colors: [], year: '', condition: 'unstated', conditionStates: [], transactionType: 'purchase',
    region: '', bundle: 'none', accessory: false, accessoryType: '', part: false,
    substitute: false, flags: []
  };

  /* ── 강한 식별자 (판매처 메타데이터 우선) ── */
  const gt = new Set();
  ['gtin', 'ean', 'upc', 'barcode'].forEach(k => { const g = normGtin(o[k]); if (g) gt.add(g); });
  const codes = new Set();
  if (o.modelNumber) String(o.modelNumber).split(/[,;]/).forEach(c => addCode(codes, c));

  /* ── 판매 형태 · 상태 · 지역 (원문 전체에서) ── */
  const tx = TRANSACTION_PATTERNS.find(([, re]) => re.test(lower));
  if (tx) id.transactionType = tx[0];
  const states = new Set();
  // «미개봉 상품» 안의 "개봉 상품" 을 개봉 상품으로 읽지 않는다.
  const condText = raw.replace(/미\s*개봉/g, ' 미개봉품 ').replace(/미개봉품\s*(?:상품|제품)/g, '미개봉품');
  S.CONDITION_PATTERNS.forEach(([state, re]) => {
    if (state === 'rental') return;
    if (re.test(state === 'opened' ? condText.replace(/미개봉품/g, ' ') : raw)) states.add(state);
  });
  EXTRA_CONDITION.forEach(([state, re]) => { if (re.test(raw)) states.add(state); });
  if (o.condition) {
    const meta = S.conditionState(String(o.condition), String(o.condition));
    if (meta && meta !== 'rental') states.add(meta);
  }
  id.conditionStates = [...states].sort();
  const canon = new Set([...states].map(s => CONDITION_CANON[s]).filter(Boolean));
  const nonNew = CONDITION_RANK.filter(c => canon.has(c));
  id.condition = nonNew.length ? nonNew[0] : canon.has('new') ? 'new' : 'unstated';
  if (nonNew.length > 1) id.flags.push('condition_multiple');

  const overseas = REGION_OVERSEAS_RE.test(raw), domestic = REGION_DOMESTIC_RE.test(raw);
  id.region = overseas && domestic ? 'mixed' : overseas ? 'overseas' : domestic ? 'domestic' : '';

  id.part = PART_RE.test(raw);
  id.substitute = COMPAT_RE.test(raw) || S.substituteRelation('', raw).factor < 1;

  /* ── 값 뽑고 지우기: 금액 → 바코드 → 수량 → 모델번호 → 용량 → 규격 → 연식 ── */
  // "[기타]" 는 몰의 분류 꼬리표다("기타" 낱말 자체는 악기 이름일 수 있어 그대로 둔다).
  const path = splitListingPath(lower.replace(/\[\s*기타\s*\]/g, ' '));
  let s = Core.normalizeUnits(path.body).replace(MONEY_RE, ' ')
    // "408gx2개" · "80g*2입" — 단위 바로 뒤의 배수 표기를 떼어 수량으로 읽게 한다.
    .replace(/(\d(?:g|kg|mg|ml|l|t|ea|개|정|포|입))\s*([x×*])\s*(?=\d)/gi, '$1 $2')
    // "3-in-1" · "2 in 1" 은 구성 표기 한 낱말이다. 숫자 둘이 모델 번호 나열로 읽히지 않게 붙인다.
    .replace(/(\d)\s*-?\s*in\s*-?\s*(\d)(?!\d)/g, '$1in$2')
    // "WiFi 7" · "USB 3.2" · "블루투스 5.3" — 규격 세대 숫자는 모델 번호가 아니다. 규격 낱말에 붙여 한 낱말로 둔다.
    // 세대 숫자는 한두 자리이고 뒤에 단위가 오지 않는다 — "WiFi 256GB" 의 256 은 용량이다.
    .replace(/(wi-?fi|usb|bluetooth|블루투스|hdmi|pcie|lpddr|ddr|gen)\s*\.?\s*(\d{1,2})(?:\.(\d+))?(?![0-9]|\s*(?:gb|tb|mb|g\b))/gi,
      (m, w, a, b) => ` ${w.replace('-', '')}${a}${b ? `p${b}` : ''} `)
    // "26FW" · "25SS" — 시즌 표기도 모델 번호가 아니다.
    .replace(/(?<![a-z0-9])(\d{2})\s*(fw|ss|aw|f\/w|s\/s)(?![a-z])/gi, (m, y, s2) => ` season${y}${s2.replace('/', '')} `);
  /* 옵션을 고르는 판매 글 ("색상선택", "사이즈 택1", "골라담기") — 어느 옵션인지 제목만으로는 모른다. */
  if (/색상\s*선택|옵션\s*선택|사이즈\s*선택|택\s*1|골라\s*담기|선택\s*가능/.test(s)) id.flags.push('option_choice');
  s = s.replace(/택\s*1/g, ' ');
  const longNumbers = new Set();
  s = erase(s, /(?<!\d)\d{8,14}(?!\d)/g, m => {
    const g = normGtin(m);
    if (g && m.length >= 12) gt.add(g); else longNumbers.add(m);
  });

  const counts = [];
  let total = null;
  s = erase(s, TOTAL_COUNT_RE, (m, n) => { total = Number(n); });
  const kinds = new Set();
  s = erase(s, PLUS_PROMO_RE, (m, x, y) => { counts.push(Number(x) + Number(y)); kinds.add('promo'); });
  s = erase(s, MULT_RE, (m, n) => { counts.push(Number(n)); kinds.add('mult'); });
  s = erase(s, COUNT_RE, (m, n) => { counts.push(Number(n)); kinds.add('count'); });
  if (total != null) id.quantity = total;
  else {
    /*
     * 수량 표기가 서로 다르거나, 종류가 다른 표기가 겹치면 곱인지 합인지 모른다.
     * 실측: «1 + 1 … 수분크림 120mlx2» 는 2개일 수도 4개일 수도 있다(9,210원 ↔ 12,890원).
     */
    const distinct = [...new Set(counts)];
    if (distinct.length === 1 && kinds.size === 1) id.quantity = distinct[0];
    else if (counts.length) { id.quantityAmbiguous = true; id.flags.push('quantity_multiple'); }
  }

  /*
   * 구성 — 수량 표기("3개 세트", "1+1")를 지운 뒤에 본다. "S26+" 의 '+' 는 normalizeUnits 가
   * 이미 plus 로 바꿨으므로 구성품 표기로 읽히지 않는다.
   */
  const gift = GIFT_RE.test(s);
  if (BUNDLE_WORD_RE.test(s) || BUNDLE_PLUS_RE.test(s) || /(?:^|[^가-힣])세트(?![가-힣])/.test(s)) {
    id.bundle = gift && !BUNDLE_WORD_RE.test(s) && !/(?:^|[^가-힣])세트(?![가-힣])/.test(s) ? 'gift' : 'bundle';
  } else if (gift) id.bundle = 'gift';
  else if (BODY_ONLY_RE.test(s)) id.bundle = 'body_only';

  // 모델번호가 아닌 하이픈 낱말(USB-C · 3-in-1)은 지우지 않는다 — 구성 차이를 가르는 낱말일 수 있다.
  s = s.replace(CODE_HYPHEN_RE, m => (addCode(codes, m) || LONG_DIGITS_RE.test(m) ? ' ' : m));
  s = s.replace(CODE_SPACED_RE, (m, pre, rest) => {
    if (!knownWord(pre) && addCode(codes, pre + rest)) return ' ';
    return addCode(codes, rest) ? `${pre} ` : m;
  });
  s = s.replace(APPLE_PART_RE, m => (addCode(codes, m) ? ' ' : m));
  s = s.replace(CODE_SINGLE_RE, m => (addCode(codes, m) ? ' ' : (LONG_DIGITS_RE.test(m) ? ' ' : m)));

  const storage = new Set(), memory = new Set();
  readCapacities(s, storage, memory);
  s = s.replace(CAPACITY_TEXT_RE, ' ').replace(new RegExp(`(?<![a-z0-9가-힣])${MEMORY_WORD_RE.source}(?![a-z가-힣])`, 'gi'), ' ');

  const specs = {};
  s = s.replace(SPEC_RE, (m, n, u) => {
    const unit = SPEC_UNIT[u.toLowerCase()] || u.toLowerCase();
    if (unit === 'g' && /^[345]$/.test(n)) return m;   // 5G 통신
    (specs[unit] = specs[unit] || new Set()).add(String(Number(n)));
    return ' ';
  });

  const years = new Set();
  s = erase(s, YEAR_RE, (m, y) => years.add(y));
  if (years.size === 1) id.year = [...years][0];
  else if (years.size > 1) id.flags.push('year_multiple');

  s = s.replace(ORDINAL_RE, '$1 ');
  // Tier B promotion must distinguish a product model anchor (AirPods Pro 3) from a
  // generation-only number (G102IC 2세대). This metadata does not change MATCH decisions.
  if (/(?:^|[^a-z0-9])\d{1,2}\s*(?:세대|gen(?:eration)?)(?![a-z가-힣])/i.test(s)) id.flags.push('generation_anchor');
  s = s.replace(/(?<=[0-9])\s*(?:세대|gen(?:eration)?)(?![a-z가-힣])/gi, ' ');
  /*
   * 남은 긴 숫자(5자리 이상)는 판매처 상품번호이거나 스타일·색 번호다. 모델 번호로 쓰지 않지만
   * 버리지도 않는다 — 양쪽에 있고 서로 다르면(나이키 «_125398» ↔ «_120678») 같은 상품이라고 말할 수 없다.
   */
  s = s.replace(/(?<![a-z0-9])\d{5,}(?![a-z0-9])/g, m => { longNumbers.add(m); return ' '; });

  /* ── 토큰 → 브랜드 · 계열 낱말 · 앵커 · 등급 ── */
  const normalized = S.normalizeText(s);
  const tokens = [].concat(...S.splitTokens(normalized).map(t => splitAlphaFused(t) || splitColorCompound(t) || [t]));
  // 진짜 "S26+" 는 normalizeUnits 가 이미 plus 로 바꿨다. 남은 '+' 는 구성품 표기("프로3 +스티커")다.
  const markers = S.variantMarkers(s.replace(/\+/g, ' '), tokens);
  const brands = new Set(), words = [], anchors = [], categories = new Set();
  const accessories = new Set(), included = new Set(), extraColors = new Set();
  let afterFor = 0;
  let skip = -1;
  tokens.forEach((tok, i) => {
    if (i === skip) return;
    const prev = tokens[i - 1] || '';
    const next = tokens[i + 1] || '';
    /* 숫자 + 한국어 단위어 ("60초" · "3단" · "6인용" · "30구" · "4종") — 규격·수량이지 모델 번호가 아니다. */
    if (/^\d+(?:\.\d+)?$/.test(tok) && KOREAN_COUNTERS.has(next)) {
      (specs[next] = specs[next] || new Set()).add(String(Number(tok)));
      skip = i + 1;
      return;
    }
    if (EXTRA_COLORS.has(tok)) { extraColors.add(EXTRA_COLORS.get(tok)); return; }
    /*
     * «X 용 · X 전용 · for X» — 앞(한국어)이나 뒤(영어)의 상표가 «이 상품이 쓰이는 대상» 이다.
     * 그 상품 자체가 아니다. 부속 낱말이 없어도 호환품으로 본다("for AirPods 실리콘…").
     */
    if (tok === '용' || tok === '전용') {
      // "에어팟프로3용" · "아이폰 17 전용" — 바로 앞이 상표·모델 번호면 그 상품«용» 이다.
      if (isFamilyWord(ALIASES.has(prev) ? ALIASES.get(prev)[0] : prev) || ANCHOR_RE.test(prev) || S.VARIANT_KEYS.has(prev)) {
        id.flags.push('targets_other');
      }
      return;
    }
    const stem = /^[가-힣]{2,}(?:전용|용)$/.test(tok) ? tok.replace(/(?:전용|용)$/, '') : '';
    if (stem && isFamilyWord(ALIASES.has(stem) ? ALIASES.get(stem)[0] : stem)) {
      // "아이폰용" — 상표 자체는 이 상품의 브랜드가 아니다. ("여성용"·"차량용" 같은 말은 낱말로 남긴다)
      id.flags.push('targets_other');
      return;
    }
    if (tok === 'for') { afterFor = 3; return; }
    if (afterFor > 0) afterFor--;

    if (BRAND_OF.has(tok)) { brands.add(BRAND_OF.get(tok)); if (afterFor) id.flags.push('targets_other'); return; }
    if (SUB_BRANDS.has(tok)) { brands.add(SUB_BRANDS.get(tok)); return; }

    const acc = accessoryOf(tok, prev, next);
    if (acc) {
      // «케이스 포함» · «with … Case» 는 본품 구성품이다 — 판매 대상이 아니지만 구성 차이로는 남긴다.
      if (COMPONENT_MARK_RE.test(next) || COMPONENT_SUFFIX_RE.test(tok) || withBefore(tokens, i)) included.add(acc);
      else accessories.add(acc);
      return;
    }
    if (COMPONENT_MARK_RE.test(tok)) return;
    if (COMPONENT_SUFFIX_RE.test(tok)) {
      // "거치대포함" · "설치비포함" · "출장장착" — 붙어 쓴 구성 표기. 부속이면 구성품, 아니면 그 낱말 그대로 비교한다.
      const base = tok.replace(COMPONENT_SUFFIX_RE, '');
      const inner = base ? accessoryOf(base, prev, next) : '';
      if (inner) included.add(inner);
      else if (base) words.push(tok);
      return;
    }

    if (S.VARIANT_KEYS.has(tok)) {
      const v = S.VARIANT_KEYS.get(tok);
      if (!markers.has(v)) words.push(`v:${v}`);   // 앵커 곁이 아닌 등급 낱말 — 계열 낱말로 비교
      return;
    }
    if (ANCHOR_RE.test(tok) && /\d/.test(tok)) { anchors.push(tok); return; }
    if (/^\d+(?:\.\d+)?$/.test(tok)) return;

    const cat = categoryOf(tok);
    if (cat) {
      categories.add(cat.cls);
      if (cat.prefix && !CATEGORY_PREFIX_NOISE.has(cat.prefix)) words.push(cat.prefix);
      return;
    }
    if (NOISE_WORDS.has(tok) || S.TAIL_NOISE.has(tok) || tokenHasColor(tok)) return;
    if (S.conditionState(tok) || /^(중고|리퍼|렌탈|구독|해외|직구|병행|미개봉|개봉|전시)$/.test(tok)) return;
    if (/^(호환|호환용|대체품|대체용|replacement|compatible|style|스타일|디자인)$/.test(tok)) return;
    if (/^(번들|패키지|bundle|package|kit|세트|사은품|증정|gift|기획|구성)$/.test(tok)) return;
    // 한 글자 한글도 상품을 가른다 — 도시락(중)/(소), 이불솜_킹. 조사·접속 낱말만 뺀다.
    if (/^[가-힣]$/.test(tok) && SINGLE_CHAR_STOP.has(tok)) return;

    const alias = ALIASES.get(tok) || [tok];
    alias.forEach(w => {
      if (IMPLIED_BRAND.has(w)) brands.add(IMPLIED_BRAND.get(w));
      if (afterFor && isFamilyWord(w)) id.flags.push('targets_other');
      words.push(w);
    });
  });

  // 붙여 쓴 계열명 «에어팟케이스» 같은 토큰 안의 부속명은 splitTokens 가 못 가른다 — _search 의 판정을 함께 본다.
  const bodyLower = path.body;
  S.accessoryTerms(S.normalizeText(bodyLower)).forEach(w => {
    if (!accessories.has(ACCESSORY_CANON.get(w) || w) && soldAccessory(bodyLower, w)) accessories.add(ACCESSORY_CANON.get(w) || w);
  });

  // 판매처·분류 경로로 걷어낸 조각, 판매처 메타데이터의 브랜드도 브랜드로는 읽는다("소니/… /디지털기기 헤드셋").
  S.splitTokens(S.normalizeText(`${path.removed} ${o.brand || ''}`)).forEach(t => {
    if (BRAND_OF.has(t)) brands.add(BRAND_OF.get(t));
  });
  id.brands = [...brands].sort();
  id.brand = id.brands.length === 1 ? id.brands[0] : '';
  if (id.brands.length > 1) id.flags.push('brand_multiple');
  id.categories = [...categories].sort();
  id.category = id.categories.length === 1 ? id.categories[0] : '';

  // 앵커: 순서를 지킨 고유값. 같은 꼴이 둘 이상이면 나열(여러 모델) 판매 글이다.
  const uniq = [...new Set(anchors)];
  id.deviceClass = deviceClassOf(id, words, uniq, lower);
  if (id.deviceClass === 'phone' || id.deviceClass === 'tablet') {
    // "아이폰17프로 256 검정" 의 256 은 모델 번호가 아니라 용량이다.
    for (let i = uniq.length - 1; i > 0; i--) {
      if (Core.STORAGE_SIZES.has(uniq[i])) { storage.add(`${uniq[i]}gb`); uniq.splice(i, 1); }
    }
    // "256G" 처럼 B 를 뺀 용량 표기는 규격(g)으로 읽혔다 — 휴대폰·태블릿에서는 용량이다.
    if (specs.g && [...specs.g].every(v => Core.STORAGE_SIZES.has(v))) {
      specs.g.forEach(v => storage.add(`${v}gb`));
      delete specs.g;
    }
  }
  id.anchors = uniq;
  id.primaryAnchor = uniq[0] || '';
  const shapes = new Map();
  uniq.forEach(a => { const k = anchorShape(a); shapes.set(k, (shapes.get(k) || 0) + 1); });
  id.multiModel = [...shapes.values()].some(n => n > 1);

  id.variants = [...markers].sort();
  id.words = [...new Set(words)].sort();
  id.wordSeq = words.slice();
  id.modelNumbers = [...codes].sort();
  id.gtins = [...gt].sort();
  id.storage = [...storage].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  // 휴대폰·태블릿 제목에 용량이 여럿이면 «용량 선택형» 판매 글이다 — 어느 용량인지 모른다.
  id.storageOptions = (id.deviceClass === 'phone' || id.deviceClass === 'tablet') && id.storage.length > 1;
  id.memory = [...memory].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  Object.keys(specs).forEach(u => { id.specs[u] = [...specs[u]].sort(); });
  id.colors = [...new Set([...Core.colorsOf(raw), ...extraColors])].sort();
  id.included = [...included].sort();
  id.longNumbers = [...longNumbers].sort();
  if (!id.deviceClass && tokens.some(isApparelToken)) {
    id.deviceClass = 'apparel';
  }

  id.accessoryTypes = [...accessories].sort();
  id.accessory = accessories.size > 0 || id.part;
  id.accessoryType = id.part && !accessories.size ? 'part' : id.accessoryTypes.join('+');
  // 다른 상품«용» 인데 부속 낱말이 없으면(호환 이어폰·호환 배터리) 대체품이다. 부속이면 부속 관문이 막는다.
  if (id.flags.includes('targets_other') && !id.accessory) id.substitute = true;
  id.flags = [...new Set(id.flags)].sort();
  return id;
}

/*
 * "{판매처}/{상품명}/{분류} {하위분류}" 꼴의 제목(운영 ADPICK 의 일부 제휴몰).
 *   «소니/소니 노이즈캔슬링 블루투스 헤드폰 WH-1000XM6/디지털기기 헤드셋/이어폰»
 *   «필립스생활가전/필립스 2000시리즈 … NA220/00 윈도우 타입/주방가전 오븐/에어프라이어»
 * 뒤의 분류 경로와 앞의 판매처 이름은 상품명이 아니다 — 같은 상품의 다른 몰 제목과 낱말이
 * 어긋나게만 한다. 분류 경로로 볼 조각은 «숫자가 없고 짧으며 분류 낱말을 품은» 것뿐이다
 * (그래서 "…/여성용" 같은 상품을 가르는 꼬리는 걷어내지 않는다). 모델번호("NA220/00")를 가르지
 * 않도록 숫자가 든 조각은 경로가 아니다.
 */
const CATEGORY_PATH_RE = /(가전|기기|용품|가구|수납|의류|잡화|소품|침구|패브릭|주변기기|헤드셋|이어폰|마우스|키보드|가방|신발|스니커즈|러닝화|화장품|스킨케어|메이크업|식품|음료|주스|커피|생수|반찬|김치|즉석밥|오븐|에어프라이어|가습기|토스터기|와플메이커|셔츠|티셔츠|아우터|자켓|소파|조명|부속품|외장하드|메모리|냄비|솥|그릴|욕실|발매트|숄더백|노트북|태블릿|청소기|세탁기|냉장고|선풍기|스피커|^\s*pc\s*$)/i;
function splitListingPath(text) {
  const parts = String(text || '').split('/');
  if (parts.length < 3) return { body: text, removed: '' };
  const pathSeg = seg => {
    const t = seg.trim();
    return !!t && !/\d/.test(t) && t.split(/\s+/).length <= 4 && CATEGORY_PATH_RE.test(t);
  };
  let end = parts.length;
  while (end > 2 && pathSeg(parts[end - 1])) end--;
  if (end === parts.length) return { body: text, removed: '' };
  const lead = parts[0].trim();
  const start = lead && !/\d/.test(lead) && lead.split(/\s+/).length <= 2 && !/[\[\]]/.test(lead) ? 1 : 0;
  return { body: parts.slice(start, end).join('/'), removed: parts.slice(0, start).concat(parts.slice(end)).join(' ') };
}

/**
 * 용량 표기를 저장 용량과 메모리로 나눈다. 메모리 낱말(RAM·램)은 바로 붙은 용량 하나에만 걸린다.
 *   "16GB RAM 512GB" → 16GB 는 메모리(뒤에 붙은 RAM), 512GB 는 저장 용량
 *   "램 16GB 512GB"  → 16GB 는 메모리(앞에 붙은 램),  512GB 는 저장 용량
 * 뒤에 붙은 쪽을 먼저 본다 — "16GB RAM 512GB" 의 RAM 이 512GB 의 앞말로 다시 쓰이지 않게.
 */
function readCapacities(s, storage, memory) {
  const caps = [];
  let m;
  CAPACITY_TEXT_RE.lastIndex = 0;
  while ((m = CAPACITY_TEXT_RE.exec(s)) !== null) {
    caps.push({ start: m.index, end: m.index + m[0].length, gb: Number(m[1]) * (m[2].toLowerCase() === 'tb' ? 1024 : 1), mem: false });
  }
  const memRe = new RegExp(`(?<![a-z0-9가-힣])${MEMORY_WORD_RE.source}(?![a-z가-힣])`, 'gi');
  while ((m = memRe.exec(s)) !== null) {
    const at = m.index, end = at + m[0].length;
    const before = caps.find(c => !c.mem && /^\s*$/.test(s.slice(c.end, at)));
    if (before && !before.bound) { before.mem = true; before.bound = true; continue; }
    const after = caps.find(c => !c.mem && c.start >= end && /^\s*$/.test(s.slice(end, c.start)));
    if (after) { after.mem = true; after.bound = true; }
  }
  caps.forEach(c => (c.mem ? memory : storage).add(`${c.gb}gb`));
}

/*
 * 영문만으로 붙여 쓴 계열·등급 ("ProMax", "AirPodsPro"). _search.splitTokens 는 숫자가 없는
 * 영문 낱말을 일부러 쪼개지 않는다(일반 낱말 보호). 여기서는 «알려진 계열·등급 낱말만으로
 * 빈틈없이» 나뉠 때만 나눈다 — "promise" 는 pro+mise 가 아니다.
 */
const FUSED_ASCII = [...new Set([
  ...[...S.VARIANT_KEYS.keys()].filter(w => /^[a-z]+$/.test(w)),
  ...[...IMPLIED_BRAND.keys()], 'galaxy', 'buds', 'mx', 'master', 'watch',
  ...[...BRAND_OF.keys()].filter(w => /^[a-z]+$/.test(w))
])].sort((a, b) => b.length - a.length);
function splitAlphaFused(tok) {
  if (!/^[a-z]{5,24}$/.test(tok) || FUSED_ASCII.includes(tok)) return null;
  const memo = new Map();
  const visit = at => {
    if (at === tok.length) return [];
    if (memo.has(at)) return memo.get(at);
    let best = null;
    for (const w of FUSED_ASCII) {
      if (!tok.startsWith(w, at)) continue;
      const rest = visit(at + w.length);
      if (rest && (!best || rest.length + 1 < best.length)) best = [w, ...rest];
    }
    memo.set(at, best);
    return best;
  };
  const parts = visit(0);
  return parts && parts.length >= 2 ? parts : null;
}

/* "티타늄블랙" · "스타리실버" — 색 이름이 붙은 한글 낱말은 색과 나머지로 나눈다(나머지도 마감 이름이다). */
const COLOR_ALIASES_KO = [].concat(...Core.COLOR_GROUPS.map(g => g[2].filter(a => /^[가-힣]+$/.test(a))))
  .sort((a, b) => b.length - a.length);
function splitColorCompound(tok) {
  if (!/^[가-힣]{3,}$/.test(tok) || /블루투스|블루레이/.test(tok)) return null;
  const color = COLOR_ALIASES_KO.find(c => tok !== c && tok.indexOf(c) > -1);
  if (!color) return null;
  const rest = tok.split(color).filter(x => x.length >= 2);
  return rest.length ? [...rest, color] : null;
}

/** "with … case" — 부속명 앞 세 낱말 안에 with 가 있으면 구성품 설명이다 (AirPods Pro with Charging Case). */
function withBefore(tokens, i) {
  for (let k = Math.max(0, i - 3); k < i; k++) if (tokens[k] === 'with' || tokens[k] === 'w') return true;
  return false;
}

/*
 * 토큰 하나에 대한 판정(부속명·색·의류)은 문맥과 무관하다 — 7만 건 카탈로그에서 같은 토큰을 수십만 번
 * 다시 계산하지 않게 결과를 기억한다. 메모리가 끝없이 늘지 않게 상한에서 비운다.
 */
const TOKEN_CACHE_MAX = 50000;
const ACCESSORY_CACHE = new Map(), COLOR_CACHE = new Map(), APPAREL_CACHE = new Map();
function memo(cache, key, compute) {
  if (cache.has(key)) return cache.get(key);
  if (cache.size >= TOKEN_CACHE_MAX) cache.clear();
  const v = compute();
  cache.set(key, v);
  return v;
}
function tokenHasColor(tok) { return memo(COLOR_CACHE, tok, () => Core.colorsOf(tok).size > 0); }
function isApparelToken(tok) {
  return memo(APPAREL_CACHE, tok, () => APPAREL_NOUNS.some(n => (/^[a-z]+$/.test(n) ? tok === n : tok.endsWith(n))));
}

function accessoryOf(tok, prev, next) {
  // "스탠드형 청소기" 의 스탠드형은 본품의 모양이다.
  if (/^[가-힣]{2,}(?:형|식)$/.test(tok)) return '';
  if (EXTRA_ACCESSORY.includes(tok)) return ACCESSORY_CANON.get(tok) || tok;
  for (const [p, t] of PAIRED_ACCESSORY) if (p.test(prev) && t.test(tok)) return tok.replace(/s$/, '') === 'pad' ? 'pad' : 'film';
  if (tok === 'ear' && /^(tips?|pads?)$/.test(next)) return 'tips';
  return memo(ACCESSORY_CACHE, tok, () => {
    const hit = S.accessoryTerms(tok, [tok]);
    if (!hit.length) return '';
    return ACCESSORY_CANON.get(hit[0]) || hit[0];
  });
}

/** 붙여 쓴 토큰 안의 부속명이 «딸려 온다» 로 적혀 있지 않은가. */
function soldAccessory(lower, word) {
  const at = lower.indexOf(word);
  if (at < 0) return false;
  const after = lower.slice(at + word.length, at + word.length + 6);
  return !/^\s*(?:포함|증정|동봉|내장|탑재|장착|제공|구성)/.test(after) && !/^[형식]/.test(after) && !/with\s+(?:\S+\s+){0,2}$/.test(lower.slice(Math.max(0, at - 30), at));
}

function categoryOf(tok) {
  if (CATEGORY_OF.has(tok)) return { cls: CATEGORY_OF.get(tok), prefix: '' };
  if (/^[가-힣]{3,}$/.test(tok)) {
    for (const [w, cls] of CATEGORY_OF) {
      if (/^[가-힣]{2,}$/.test(w) && tok.endsWith(w) && tok.length > w.length) {
        const prefix = tok.slice(0, tok.length - w.length);
        if (/(용|전용)$/.test(prefix)) return null;
        return { cls, prefix };
      }
    }
  }
  return null;
}

/*
 * 용량·색이 «반드시» 옵션인 기기. 둘 다 용량을 안 적은 아이폰 두 개는 같은 SKU 라고
 * 말할 근거가 없다. 상표 계열(iphone·ipad)과 판매 관행 낱말(자급제·공기계)로만 정한다.
 */
function deviceClassOf(id, words, anchors, lower) {
  const w = new Set(words);
  if (w.has('ipad') || id.categories.includes('tablet') || (w.has('tab') && id.brands.includes('samsung'))) return 'tablet';
  if (w.has('iphone') || id.categories.includes('phone') || /자급제|공기계/.test(lower)) return 'phone';
  if (id.brands.includes('samsung') && /갤럭시|galaxy/.test(lower) && anchors.some(a => /^(?:s|z|a|note)\d/.test(a)) && !w.has('buds') && !w.has('watch')) return 'phone';
  if (w.has('macbook') || id.categories.includes('laptop')) return 'laptop';
  return '';
}
/* 싼 쪽이 비싼 쪽의 이 비율보다 낮으면 REVIEW (값만으로 NO_MATCH 는 하지 않는다). */
const PRICE_GAP_REVIEW_RATIO = 0.5;
const REQUIRED_DIMENSIONS = { phone: ['storage', 'color'], tablet: ['storage'], laptop: ['storage'], apparel: ['color'] };

/* ==================================================================
 *  4) 두 오퍼 비교
 * ================================================================== */

const eqList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const sorted = list => list.slice().sort();
const fmt = list => (list && list.length ? list.join('/') : '∅');

/**
 * 두 오퍼가 같은 가격비교 그룹이 될 수 있는가.
 *
 * @param {string|object} a
 * @param {string|object} b
 * @param {object} [ctx]  {lineDimensions:Set<'storage'|'color'|...>} 같은 계열에서 옵션으로 관측된 차원
 * @returns {{decision:'MATCH'|'REVIEW'|'NO_MATCH', confidence:number, tier:string, evidence:string[], conflicts:string[], unknown:string[]}}
 */
function matchOffers(a, b, ctx) {
  const A = parseOffer(a), B = parseOffer(b);
  const evidence = [], conflicts = [], unknown = [];
  const conflict = (tag, x, y) => conflicts.push(`${tag}:${x}!=${y}`);
  const unk = tag => { if (!unknown.includes(tag)) unknown.push(tag); };

  /* ── 같은 판매처의 같은 상품 페이지 ── */
  const sameListing = A.mall && A.mall === B.mall && A.productId && A.productId === B.productId;
  if (sameListing && A.vendorItemId && B.vendorItemId && A.vendorItemId !== B.vendorItemId) {
    conflict('merchant_option_mismatch', A.vendorItemId, B.vendorItemId);
  }

  /* ── 충돌 관문 (점수보다 먼저) ── */
  if (A.gtins.length && B.gtins.length && !A.gtins.some(g => B.gtins.includes(g))) conflict('gtin_mismatch', fmt(A.gtins), fmt(B.gtins));
  if (A.brand && B.brand && A.brand !== B.brand) conflict('brand_mismatch', A.brand, B.brand);
  if (A.category && B.category && A.category !== B.category) conflict('category_mismatch', A.category, B.category);
  const codeRel = compareCodes(A, B);
  if (codeRel === 'conflict') conflict('model_number_mismatch', fmt(A.modelNumbers), fmt(B.modelNumbers));
  const anchorRel = compareAnchors(A, B);
  if (anchorRel === 'conflict') conflict('model_mismatch', fmt(A.anchors), fmt(B.anchors));
  if (anchorRel !== 'conflict' && A.primaryAnchor && A.primaryAnchor === B.primaryAnchor && !eqList(A.variants, B.variants)) conflict('variant_mismatch', fmt(A.variants), fmt(B.variants));
  if (A.storage.length && B.storage.length && !eqList(A.storage, B.storage)) {
    const overlap = A.storage.some(x => B.storage.includes(x));
    if ((A.storageOptions || B.storageOptions) && overlap) unk('storage');
    else conflict('storage_mismatch', fmt(A.storage), fmt(B.storage));
  }
  if (A.memory.length && B.memory.length && !eqList(A.memory, B.memory)) conflict('memory_mismatch', fmt(A.memory), fmt(B.memory));
  Object.keys(A.specs).forEach(u => { if (B.specs[u] && !eqList(A.specs[u], B.specs[u])) conflict(`size_mismatch_${u}`, fmt(A.specs[u]), fmt(B.specs[u])); });
  if (A.quantity != null && B.quantity != null && A.quantity !== B.quantity) conflict('quantity_mismatch', A.quantity, B.quantity);
  if (A.colors.length === 1 && B.colors.length === 1 && A.colors[0] !== B.colors[0]) conflict('color_mismatch', A.colors[0], B.colors[0]);
  if (A.accessory !== B.accessory) conflict('main_vs_accessory', A.accessory ? A.accessoryType : 'main', B.accessory ? B.accessoryType : 'main');
  if (A.accessory && B.accessory && A.accessoryType !== B.accessoryType) conflict('accessory_type_mismatch', A.accessoryType, B.accessoryType);
  if (A.substitute !== B.substitute) conflict('genuine_vs_substitute', A.substitute ? 'substitute' : 'genuine', B.substitute ? 'substitute' : 'genuine');
  if (A.transactionType !== B.transactionType) conflict('transaction_mismatch', A.transactionType, B.transactionType);
  if (A.condition !== 'unstated' && B.condition !== 'unstated' && A.condition !== B.condition) conflict('condition_mismatch', A.condition, B.condition);
  if (A.region && B.region && A.region !== B.region && A.region !== 'mixed' && B.region !== 'mixed') conflict('region_mismatch', A.region, B.region);
  if ((A.bundle === 'bundle') !== (B.bundle === 'bundle')) conflict('bundle_mismatch', A.bundle, B.bundle);
  if (A.year && B.year && A.year !== B.year) conflict('year_mismatch', A.year, B.year);

  if (conflicts.length) {
    return { decision: DECISION.NO_MATCH, confidence: 1, tier: '', evidence, conflicts, unknown };
  }

  /* ── 한쪽만 아는 값 (와일드카드가 아니다) ── */
  const oneSided = (x, y) => (x.length > 0) !== (y.length > 0);
  if (oneSided(A.storage, B.storage)) unk('storage');
  if (oneSided(A.memory, B.memory)) unk('memory');
  [...new Set([...Object.keys(A.specs), ...Object.keys(B.specs)])].forEach(u => { if (!A.specs[u] || !B.specs[u]) unk(`size_${u}`); });
  if (oneSided(A.colors, B.colors) || A.colors.length > 1 || B.colors.length > 1) unk('color');
  if ((A.quantity == null) !== (B.quantity == null)) {
    // «1개» 와 수량 표기 없음은 같은 판매 단위로 본다. 2개 이상은 반드시 양쪽에 적혀 있어야 한다.
    if ((A.quantity || B.quantity) === 1) evidence.push('quantity_single_default');
    else unk('quantity');
  }
  if (A.quantityAmbiguous || B.quantityAmbiguous) unk('quantity');
  if ((A.condition === 'unstated') !== (B.condition === 'unstated')) {
    const known = A.condition === 'unstated' ? B.condition : A.condition;
    if (known === 'new') evidence.push('condition_new_vs_unstated');
    else unk('condition');
  }
  if (A.flags.includes('condition_multiple') || B.flags.includes('condition_multiple')) unk('condition');
  if (Boolean(A.region) !== Boolean(B.region)) {
    const known = A.region || B.region;
    if (known !== 'domestic') unk('region');
  }
  if (A.region === 'mixed' || B.region === 'mixed') unk('region');
  if (A.bundle !== B.bundle) unk('bundle');
  else if (A.bundle === 'bundle' || A.bundle === 'gift') unk('bundle_composition');
  if (A.multiModel || B.multiModel) unk('multi_model_listing');
  if (anchorRel === 'partial') unk('model_detail');
  if (codeRel === 'partial') unk('model_number_partial');
  if (A.brands.length > 1 || B.brands.length > 1) unk('brand');
  if (!eqList(A.included, B.included)) unk('included_components');
  if (A.longNumbers.length && B.longNumbers.length && !A.longNumbers.some(n => B.longNumbers.includes(n))) unk('listing_number');
  if (A.flags.includes('option_choice') || B.flags.includes('option_choice')) unk('option_choice');
  /*
   * 중고·리퍼·전시·개봉 상품은 개체마다 상태가 다르다. 같은 «상태 표기» 끼리라도 같은 물건의
   * 가격 비교가 아니다. 렌탈·구독·약정은 월 요금·기간이 판매 글마다 다르다. 둘 다 사람이 본다.
   */
  if (A.condition !== 'unstated' && A.condition !== 'new' && A.condition === B.condition) unk('non_new_condition');
  if (A.transactionType !== 'purchase' && A.transactionType === B.transactionType) unk('non_purchase_listing');
  /*
   * 등급 표기(Pro·Max·Ultra·+)는 모델 번호 곁에서만 읽는다(_search.variantMarkers). 첫 앵커가 같으면 위에서
   * 충돌로 끊었고, 그 밖(모델번호만 있는 «Deco XE75» ↔ «Deco XE75 Pro»)은 같다고 말할 근거가 없다.
   */
  if (!eqList(A.variants, B.variants)) unk('variant');
  /*
   * 같은 SKU 의 판매처별 값이 두 배 넘게 벌어지는 일은 드물다. 벌어졌다면 옵션·구성이 다를 가능성이
   * 크다(실측: 같은 제목의 «로보락 S8 Pro Plus» 472,700 ↔ 699,000원). 값은 식별 근거가 아니므로
   * 충돌로 끊지는 않고 사람이 보게 한다.
   */
  if (A.price > 0 && B.price > 0 && Math.min(A.price, B.price) < Math.max(A.price, B.price) * PRICE_GAP_REVIEW_RATIO) unk('price_gap');
  if (A.accessory && B.accessory) unk('accessory_listing');
  if (A.substitute && B.substitute) unk('substitute_listing');
  if ((A.flags.includes('year_multiple')) || B.flags.includes('year_multiple')) unk('year');
  if (A.year && B.year) evidence.push('same_year');
  else if (A.year || B.year) evidence.push('year_one_sided');

  /* 용량·색이 반드시 옵션인 기기에서 둘 다 안 적었으면, 같은 SKU 라는 근거가 없다. */
  const cls = A.deviceClass || B.deviceClass;
  const required = new Set([...(REQUIRED_DIMENSIONS[cls] || []), ...((ctx && ctx.lineDimensions) || [])]);
  required.forEach(dim => {
    if (dim === 'storage' && !A.storage.length && !B.storage.length) unk('storage');
    if (dim === 'color' && !A.colors.length && !B.colors.length) unk('color');
    if (dim === 'memory' && !A.memory.length && !B.memory.length) unk('memory');
    if (dim === 'model_number' && (!A.modelNumbers.length || !B.modelNumbers.length)) unk('model_number');
    if (dim.startsWith('size_') && !A.specs[dim.slice(5)] && !B.specs[dim.slice(5)]) unk(dim);
  });

  /* ── 증거 ── */
  let tier = '';
  const sameGtin = A.gtins.length && A.gtins.some(g => B.gtins.includes(g));
  if (sameGtin) { evidence.push('same_gtin'); tier = 'A'; }
  if (codeRel === 'exact' || codeRel === 'loose') {
    evidence.push(codeRel === 'exact' ? 'same_model_number' : 'same_model_number_loose');
    if (!tier) tier = 'A';
  }
  if (sameListing) evidence.push('same_merchant_listing');

  const brandOk = A.brand && B.brand ? A.brand === B.brand : true;
  if (A.brand && B.brand) evidence.push('same_brand');
  else if (A.brand || B.brand) evidence.push('brand_omitted_one_side');
  const sameWords = eqList(A.words, B.words) || compoundEquivalent(A, B);
  const lineEqual = A.primaryAnchor && A.primaryAnchor === B.primaryAnchor && eqList(sorted(A.anchors), sorted(B.anchors))
    && eqList(A.variants, B.variants) && sameWords;
  if (A.primaryAnchor && A.primaryAnchor === B.primaryAnchor) evidence.push('same_model');
  if (A.variants.length && eqList(A.variants, B.variants)) evidence.push('same_variant');
  if (sameWords && A.words.length) evidence.push('same_family_words');
  if (A.storage.length && eqList(A.storage, B.storage)) evidence.push('same_storage');
  if (A.colors.length === 1 && eqList(A.colors, B.colors)) evidence.push('same_color');
  if (A.quantity != null && A.quantity === B.quantity) evidence.push('same_quantity');
  if (A.condition !== 'unstated' && A.condition === B.condition) evidence.push('same_condition');

  /*
   * Tier B — 브랜드 표기가 한쪽에 없으면 계열 낱말이 남아 있어야 한다("S26 울트라" 만으로는
   * 무엇인지 모른다). 둘 다 브랜드를 알면 계열 낱말이 비어도 된다("삼성 S26" = "갤럭시 S26").
   */
  const brandBasis = (A.brand && B.brand) || (A.words.length > 0 && B.words.length > 0);
  if (!tier && lineEqual && brandOk && brandBasis) tier = 'B';

  /* Tier A(모델번호)라도 제조사 접두를 생략한 비교(R630 ≈ SM-R630)는 브랜드를 양쪽에서 확인해야 한다. */
  if (tier === 'A' && !sameGtin && codeRel === 'loose' && !(A.brand && B.brand)) {
    tier = lineEqual && brandBasis ? 'B' : '';
    if (!tier) unk('brand');
  }
  /*
   * 모델번호가 같아도 나머지 낱말이 다르면 MATCH 가 아니다. 운영 데이터(2026-10-13 read-only)에서
   * 같은 모델번호 아래 «벽걸이형 ↔ 스탠드형», «G304 LIGHTSPEED ↔ G304 X SUPERLIGHT», «[일반] ↔ [무결점]»,
   * 맛·마감 이름이 다른 판매 글이 실제로 있었다. GTIN 만 이 검사를 건너뛴다(GTIN 은 구성까지 가리킨다).
   */
  if (tier === 'A' && !sameGtin && !sameWords) unk(`title_words:${diffWords(A.words, B.words)}`);
  if (tier === 'A' && !sameGtin && !eqList(sorted(A.anchors), sorted(B.anchors))) unk('model_detail');

  if (!tier) {
    /*
     * REVIEW 큐에 올릴 만큼 «관련 있는» 쌍인가. 모델 번호(17)나 모델번호 몸통(600)만 겹치고 브랜드도
     * 낱말도 겹치지 않으면(«T600 CPU 쿨러» ↔ «DLA-HT600 가습기») 사람이 볼 가치가 없다 — NO_MATCH.
     * 이 판단은 MATCH 를 만들지 않는다. REVIEW 와 NO_MATCH 를 가를 뿐이다.
     */
    // 한쪽이 브랜드도 낱말도 없으면(«S26 울트라 256GB») 어긋날 근거도 없다 — 사람이 볼 만하다.
    const bare = x => !x.brand && !x.words.length;
    const shared = (A.brand && A.brand === B.brand) || A.words.some(w => B.words.includes(w)) || bare(A) || bare(B);
    const related = codeRel === 'exact' || ((A.primaryAnchor && A.primaryAnchor === B.primaryAnchor) || codeRel === 'loose') && shared
      || (A.words.length && sameWords);
    if (!related) {
      return { decision: DECISION.NO_MATCH, confidence: 0.9, tier: 'C', evidence, conflicts: [], unknown: ['no_shared_identity'] };
    }
    if (!sameWords) unk(`title_words:${diffWords(A.words, B.words)}`);
    if (!A.primaryAnchor && !B.primaryAnchor && !A.modelNumbers.length) unk('no_model_anchor');
    if (!brandBasis) unk('brand');
    if (!eqList(sorted(A.anchors), sorted(B.anchors)) && anchorRel !== 'partial') unk('model_detail');
    if (!unknown.length) unk('insufficient_evidence');
    return { decision: DECISION.REVIEW, confidence: reviewConfidence(evidence, unknown), tier: 'C', evidence, conflicts: [], unknown };
  }

  if (unknown.length) {
    return { decision: DECISION.REVIEW, confidence: reviewConfidence(evidence, unknown), tier, evidence, conflicts: [], unknown };
  }
  const confidence = sameGtin ? 0.999 : tier === 'A' ? 0.995 : 0.98;
  return { decision: DECISION.MATCH, confidence, tier, evidence, conflicts: [], unknown };
}

/*
 * 붙여 쓰기만 다른 낱말 — «샌드스톤» = «샌드 스톤», «올스텐내솥» = «올스텐 내솥».
 * 한쪽에만 있는 낱말이 상대 제목에서 «연달아 나온 낱말 2~3개» 를 그대로 이어 붙인 것일 때만 같다고 본다.
 * 글자를 하나도 바꾸지 않는 비교라 다른 낱말을 같게 만들지 않는다.
 */
function compoundEquivalent(A, B) {
  const onlyA = A.words.filter(w => !B.words.includes(w));
  const onlyB = B.words.filter(w => !A.words.includes(w));
  if (!onlyA.length && !onlyB.length) return true;
  return coversByJoining(onlyA, B.wordSeq, onlyB) || coversByJoining(onlyB, A.wordSeq, onlyA);
}

/** longs 의 낱말마다 seq 에서 연달아 나온 2~3개(전부 shorts 안의 것)를 이어 붙여 만들 수 있고, shorts 를 다 썼는가. */
function coversByJoining(longs, seq, shorts) {
  if (!longs.length || !shorts.length) return false;
  const used = new Set();
  for (const w of longs) {
    let hit = false;
    for (let i = 0; i < seq.length && !hit; i++) {
      let joined = '';
      for (let k = i; k < Math.min(seq.length, i + 3); k++) {
        if (!shorts.includes(seq[k])) break;
        joined += seq[k];
        if (k > i && joined === w) { seq.slice(i, k + 1).forEach(x => used.add(x)); hit = true; break; }
        if (joined.length >= w.length) break;
      }
    }
    if (!hit) return false;
  }
  return shorts.every(x => used.has(x));
}

function reviewConfidence(evidence, unknown) {
  const c = 0.4 + 0.05 * evidence.length - 0.05 * unknown.length;
  return Math.round(Math.max(0.1, Math.min(0.9, c)) * 1000) / 1000;
}

function diffWords(a, b) {
  const A = new Set(a), B = new Set(b);
  return [...a.filter(x => !B.has(x)), ...b.filter(x => !A.has(x))].slice(0, 6).join(',');
}

/** 모델번호 비교. 'exact'|'loose' 같은 모델, 'conflict' 다른 모델, 'partial' 일부만 겹침, '' 비교 불가. */
function compareCodes(A, B) {
  if (!A.modelNumbers.length || !B.modelNumbers.length) return '';
  const rel = (x, ys) => ys.map(y => codeRelation(x, y)).find(Boolean) || '';
  const aRel = A.modelNumbers.map(x => rel(x, B.modelNumbers));
  const bRel = B.modelNumbers.map(y => rel(y, A.modelNumbers));
  if (aRel.every(r => !r)) return 'conflict';
  if (aRel.some(r => !r) || bRel.some(r => !r)) return 'partial';
  return [...aRel, ...bRel].every(r => r === 'exact') ? 'exact' : 'loose';
}

/**
 * 모델 번호(앵커) 비교. 첫 앵커가 다르면 다른 모델이다(17 ≠ 16, 3 ≠ 3S, V15 ≠ V15S).
 * 나열 판매 글(S26 S25 S24)은 상대의 앵커가 나열에 없을 때만 충돌, 있으면 'partial'.
 */
function compareAnchors(A, B) {
  if (!A.primaryAnchor || !B.primaryAnchor) return A.primaryAnchor || B.primaryAnchor ? 'partial' : '';
  if (A.multiModel || B.multiModel) {
    const shared = A.anchors.some(x => B.anchors.includes(x));
    return shared ? 'partial' : 'conflict';
  }
  if (A.primaryAnchor !== B.primaryAnchor) {
    // 한쪽 앵커가 다른 쪽에 모두 들어 있으면(«아이패드 프로 5세대 M4» ↔ «아이패드 프로 M4») 순서 차이일 수 있다 — 모른다.
    const sub = (x, y) => x.anchors.every(a => y.anchors.includes(a));
    return sub(A, B) || sub(B, A) ? 'partial' : 'conflict';
  }
  return eqList(sorted(A.anchors), sorted(B.anchors)) ? 'equal' : 'partial';
}

/* ==================================================================
 *  5) 후보 좁히기 (blocking) — O(N²) 전수 비교를 하지 않는다
 *
 *  MATCH 가 되려면 (a) GTIN 이 같거나 (b) 모델번호 몸통이 같거나 (c) 계열 낱말·첫 앵커·
 *  등급이 모두 같아야 한다. 그래서 이 세 키로 묶으면 MATCH 쌍을 하나도 놓치지 않는다
 *  (블록 상한을 넘는 버킷만 예외 — 그 수는 stats.oversizedBlocks 로 드러낸다).
 * ================================================================== */
function blockKeys(input) {
  const id = parseOffer(input);
  const keys = [];
  id.gtins.forEach(g => keys.push(`g:${g}`));
  id.modelNumbers.forEach(c => { const p = codeParts(c); if (p) keys.push(`c:${p.key}`); });
  if (id.primaryAnchor) keys.push(`l:${id.words.join(',')}|${id.primaryAnchor}|${id.variants.join(',')}`);
  return [...new Set(keys)];
}

/* ==================================================================
 *  6) 묶기 — 제약을 지키는 군집 (all-pairs)
 * ================================================================== */

const MAX_BLOCK = 2000;
const MAX_GROUP = 50;

/* 군집 안에서 정렬할 때 쓰는 «구체성». 많이 아는 오퍼가 먼저 자리를 잡는다. */
function specificity(id) {
  return id.storage.length + id.colors.length + (id.quantity != null ? 1 : 0) + id.modelNumbers.length
    + id.gtins.length + (id.condition !== 'unstated' ? 1 : 0) + (id.brand ? 1 : 0) + Object.keys(id.specs).length;
}

/*
 * 계열 안에서 실제로 옵션으로 쓰인 차원 — 그 계열에서는 «둘 다 안 적음» 도 모르는 값으로 본다.
 *
 * 계열 키는 블록 키보다 넓다(브랜드 또는 첫 낱말 + 첫 앵커 + 등급). 판매 글마다 덧말이 달라도
 * 같은 계열의 관측을 모으기 위해서다. 실측: «갤럭시 버즈2 프로» 두 판매 글이 색 없이 501,500원 ·
 * 364,400원이었다 — 같은 계열에 색이 셋 관측되므로 이 둘은 같은 SKU 라고 말할 수 없다.
 * 같은 계열에 서로 다른 제조사 모델번호가 관측되면 모델번호도 옵션 차원이다
 * («코드제로 R5» 아래 R585WKA·R585HKA …) — 한쪽만 모델번호를 적은 쌍은 REVIEW 다.
 */
function lineDimensionsOf(ids) {
  const byLine = new Map();
  ids.forEach(id => {
    const k = lineKeyOf(id);
    if (!k) return;
    if (!byLine.has(k)) byLine.set(k, { storage: new Set(), color: new Set(), memory: new Set(), codes: [] });
    const d = byLine.get(k);
    id.storage.forEach(v => d.storage.add(v));
    id.colors.forEach(v => d.color.add(v));
    id.memory.forEach(v => d.memory.add(v));
    id.modelNumbers.forEach(c => { if (!d.codes.some(x => codeRelation(x, c))) d.codes.push(c); });
  });
  const out = new Map();
  byLine.forEach((d, k) => {
    const dims = new Set();
    // 같은 계열에서 값이 둘 이상 관측되면 그 차원은 SKU 를 가른다.
    if (d.storage.size > 1) dims.add('storage');
    if (d.color.size > 1) dims.add('color');
    if (d.memory.size > 1) dims.add('memory');
    if (d.codes.length > 1) dims.add('model_number');
    out.set(k, dims);
  });
  return out;
}

function lineKeyOf(id) {
  if (!id.primaryAnchor) return '';
  const head = id.brand || id.words[0] || '';
  return head ? `${head}|${id.primaryAnchor}|${id.variants.join(',')}` : '';
}

/** 오퍼 목록 전체에서 계열 차원을 구하고, 두 오퍼의 비교 문맥(두 계열의 합집합)을 만든다. */
function contextFactory(ids) {
  const lineDims = lineDimensionsOf(ids);
  return (x, y) => {
    const dims = new Set(lineDims.get(lineKeyOf(x)) || []);
    (lineDims.get(lineKeyOf(y)) || []).forEach(d => dims.add(d));
    return { lineDimensions: dims };
  };
}

/**
 * 오퍼들을 canonical product group 으로 묶는다.
 *
 * @param {Array<string|object>} offers
 * @param {object} [opts] {maxBlock, maxGroup}
 * @returns {{groups:Array, reviews:Array, stats:object}}
 */
function clusterOffers(offers, opts) {
  const maxBlock = (opts && opts.maxBlock) || MAX_BLOCK;
  const maxGroup = (opts && opts.maxGroup) || MAX_GROUP;
  const ids = (offers || []).filter(Boolean).map(parseOffer);
  const pairContext = contextFactory(ids);

  const order = ids.map((id, i) => ({ id, i })).sort((x, y) =>
    specificity(y.id) - specificity(x.id) || (x.id.key < y.id.key ? -1 : x.id.key > y.id.key ? 1 : x.i - y.i));

  const groups = [];
  const index = new Map();
  const reviews = [];
  const stats = { offers: ids.length, comparisons: 0, oversizedBlocks: 0, skippedFullGroups: 0 };
  const memo = new Map();
  const judge = (x, y) => {
    const k = x.key < y.key ? `${x.key}\u0000${y.key}` : `${y.key}\u0000${x.key}`;
    if (!memo.has(k)) {
      stats.comparisons++;
      memo.set(k, matchOffers(x, y, pairContext(x, y)));
    }
    return memo.get(k);
  };

  order.forEach(({ id }) => {
    const keys = blockKeys(id);
    const seen = new Set();
    let target = -1;
    for (const k of keys) {
      const bucket = index.get(k);
      if (!bucket) continue;
      if (bucket.length > maxBlock) { stats.oversizedBlocks++; continue; }
      for (const gi of bucket) {
        if (seen.has(gi)) continue;
        seen.add(gi);
        const g = groups[gi];
        if (g.members.length >= maxGroup) { stats.skippedFullGroups++; continue; }
        // ★ all-pairs: 군집의 모든 구성원과 MATCH 여야 한다. 하나라도 아니면 들어가지 않는다.
        let all = true, review = null, blocked = false;
        for (const m of g.members) {
          const r = judge(id, m);
          if (r.decision === DECISION.NO_MATCH) { all = false; blocked = true; break; }
          if (r.decision === DECISION.REVIEW) { all = false; if (!review) review = { member: m.key, unknown: r.unknown }; }
        }
        if (all) { target = gi; break; }
        if (!blocked && review) reviews.push({ offer: id.key, group: gi, member: review.member, unknown: review.unknown });
      }
      if (target > -1) break;
    }
    if (target < 0) { target = groups.length; groups.push({ members: [] }); }
    groups[target].members.push(id);
    keys.forEach(k => {
      if (!index.has(k)) index.set(k, []);
      const b = index.get(k);
      if (b[b.length - 1] !== target && b.indexOf(target) < 0) b.push(target);
    });
  });

  const out = groups.map((g, gi) => ({
    id: gi,
    size: g.members.length,
    identity: canonicalIdentity(g.members),
    malls: [...new Set(g.members.map(m => m.mall).filter(Boolean))].sort(),
    members: g.members.map(m => m.key),
    lowest: g.members.filter(m => m.price > 0).sort((x, y) => x.price - y.price || (x.key < y.key ? -1 : 1))[0] || null
  })).map(g => Object.assign(g, { lowest: g.lowest ? { key: g.lowest.key, mall: g.lowest.mall, price: g.lowest.price } : null }));
  stats.groups = out.length;
  stats.multiOfferGroups = out.filter(g => g.size > 1).length;
  stats.crossMerchantGroups = out.filter(g => g.malls.length > 1).length;
  return { groups: out, reviews, stats };
}

/** 군집의 정규 식별 — 구성원이 아는 값의 합. all-pairs MATCH 라서 서로 어긋나는 값은 없다. */
function canonicalIdentity(members) {
  const first = members[0];
  const pickOne = f => members.map(f).find(Boolean) || '';
  const union = f => [...new Set([].concat(...members.map(f)))].sort();
  return {
    brand: pickOne(m => m.brand), words: first.words, model: first.primaryAnchor, anchors: first.anchors,
    variants: first.variants, modelNumbers: union(m => m.modelNumbers), gtins: union(m => m.gtins),
    storage: union(m => m.storage), memory: union(m => m.memory), colors: union(m => m.colors),
    quantity: members.map(m => m.quantity).find(q => q != null) ?? null,
    condition: pickOne(m => (m.condition !== 'unstated' ? m.condition : '')) || 'unstated',
    transactionType: first.transactionType, accessory: first.accessory, accessoryType: first.accessoryType,
    region: pickOne(m => m.region), year: pickOne(m => m.year)
  };
}

/**
 * 군집 무결성 검사 — 모든 쌍이 MATCH 인가. 하나라도 아니면 그 쌍을 돌려준다.
 * 테스트와 오프라인 평가가 «만든 군집» 을 다시 확인할 때 쓴다.
 */
function verifyGroups(groups, offersByKey) {
  const bad = [];
  const all = [...offersByKey.values()].map(parseOffer);
  const pairContext = contextFactory(all);
  const byKey = new Map(all.map(id => [id.key, id]));
  (groups || []).forEach(g => {
    const ms = g.members.map(k => byKey.get(k)).filter(Boolean);
    for (let i = 0; i < ms.length; i++) {
      for (let j = i + 1; j < ms.length; j++) {
        const r = matchOffers(ms[i], ms[j], pairContext(ms[i], ms[j]));
        if (r.decision !== DECISION.MATCH) bad.push({ group: g.id, a: ms[i].key || ms[i].title, b: ms[j].key || ms[j].title, result: r });
      }
    }
  });
  return bad;
}

module.exports = {
  DECISION, parseOffer, matchOffers, clusterOffers, blockKeys, verifyGroups, codeRelation,
  /*
   * clusterOffers 가 쓰는 것과 «같은» 쌍 비교 문맥을 밖에서도 만들 수 있게 한다.
   * 이것 없이 matchOffers(a, b) 를 직접 부르면 계열 차원(lineDimensions)이 비어
   * 군집이 내린 판정과 다른 답이 나온다. Phase 2 shadow 워커가 REVIEW 쌍의 근거를
   * 다시 읽을 때 반드시 같은 문맥이어야 한다 (scripts/run-offer-identity-shadow.js).
   */
  contextFactory,
  REQUIRED_DIMENSIONS,
  _internal: { BRANDS, ALIASES, SUB_BRANDS, IMPLIED_BRAND, NOISE_WORDS, CATEGORY_CLASSES, normGtin, validGtin, codeParts, lineDimensionsOf }
};
