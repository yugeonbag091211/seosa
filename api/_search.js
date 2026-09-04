'use strict';
/*
 * 검색 품질 — 검색어 정규화 / 관련도 점수 / 중복 제거 / 오타 보정.
 *
 * ★ 이 파일은 Vercel 함수가 아니다 (api/_ 로 시작하는 파일은 배포되지 않는다).
 *   함수 12/12 를 쓰고 있으므로 검색 품질 로직은 전부 여기 모으고,
 *   기존 엔드포인트(api/search.js, api/init.js)가 가져다 쓴다.
 *
 * 왜 만들었나 — 2026-08-10 감사 결과 (coupang_search_cache 47키워드 466건 실측)
 *
 *   [정밀도] 기존 matchesKeyword 는 "토큰 하나라도 걸리면 통과" 였다.
 *     · "아이패드 11프로 케이스 검정" → "레노버 탭 P11 프로 ... 태블릿 케이스"
 *       ("11프로" 가 "P11 프로" 에 부분 일치. 브랜드가 아예 다르다)
 *     · "LG전자 LG그램 14ZD95U" → "LG전자 2026 그램 AI 16 코어 Ultra5"
 *       (모델명이 하나도 안 맞는데 "LG전자" 하나로 통과)
 *     · "LG 그램 프로 16" → "LG전자 2024 그램 15 ... 16GB ..."
 *       (16인치를 찾는데 램 용량 16GB 에 숫자가 걸렸다)
 *     466건 중 104건이 이런 "일부 토큰만" 통과였다.
 *
 *   [재현율] 반대로 멀쩡한 상품을 통째로 버리고 있었다.
 *     · "전기포트" → "필립스 3000 시리즈 무선 전기 주전자" 등 8/10건 탈락
 *       (붙여쓴 합성어라 부분 문자열이 안 맞는다)
 *     · "향수"    → "오드뚜왈렛"/"오 드 퍼퓸" 11건 탈락
 *     · "무선이어폰" → "필립스 무선 ENC노이즈캔슬링 블루투스 이어폰" 등 6건 탈락
 *     466건 중 104건을 버렸고, 그중 상당수가 정답이었다.
 *
 * 해결 방향: 통과/탈락 이분법 대신 0~1 점수를 매기고,
 *   - 낮은 점수만 버린다(정밀도)
 *   - 붙여쓰기·동의어·표기 차이는 부분 점수로 살린다(재현율)
 *   - 남은 것은 점수 순으로 정렬한다(순서)
 *
 * 브랜드/모델명 가중치는 어휘 목록이 아니라 "구조"로 판단한다.
 * 브랜드 목록을 손으로 적으면 실측 상위 60개 첫 토큰이 이미 롱테일이라
 * (태블릿나라·벤트론스·신지모루·OMIIYA…) 목록에 없는 브랜드가 곧바로 생긴다.
 *   - 모델명 = 영문+숫자가 섞인 토큰 (14ZD95U, 16Z90S, X1607CA)
 *   - 브랜드 = 질의의 머리 토큰. 쿠팡 상품명은 브랜드가 맨 앞에 온다.
 */

/* ------------------------------------------------------------------ *
 *  1. 정규화
 * ------------------------------------------------------------------ */

/**
 * 검색어/상품명 공통 정규화.
 *
 *   - NFKC: 전각(ＬＧ) → 반각(LG), 한글 호환자모 정리
 *   - 소문자화: 영문 대소문자 차이를 없앤다 ("LG 그램" = "lg 그램")
 *   - 특수문자 → 공백: 하이픈·슬래시·괄호가 붙은 모델명을 토큰으로 끊는다
 *     ("14ZD95U-GX56K" → "14zd95u gx56k")
 *   - 공백 정리: 연속/앞뒤 공백 제거
 *
 * 한글 자모는 남긴다. 오타 보정에서 자모 단위로 거리를 재기 때문이다.
 */
function normalizeText(s) {
  return String(s == null ? '' : s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^0-9a-z가-힣ㄱ-ㅎㅏ-ㅣ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 띄어쓰기 차이까지 무시한 비교용 키.
 * "무선 이어폰" 과 "무선이어폰" 을 같은 것으로 볼 때만 쓴다.
 * ※ 쿠팡에 보내는 검색어로는 쓰지 않는다 — 띄어쓰기를 바꾸면 쿠팡 결과가 달라진다.
 */
function canonicalKey(s) {
  return normalizeText(s).replace(/\s+/g, '');
}

/* ------------------------------------------------------------------ *
 *  2. 토큰화
 * ------------------------------------------------------------------ */

/**
 * 어느 상품에나 붙는 말. 이 단어만 겹치는 상품은 관련 있다고 볼 수 없다.
 * (api/_shop.js 의 GENERIC_TOKEN 은 "제목에서 검색어를 만들 때" 빼는 목록이고,
 *  이쪽은 "검색어 토큰의 가중치를 낮추는" 목록이라 역할이 다르다)
 */
const COMMON_WORDS = new Set([
  '용품', '제품', '상품', '세트', '패키지', '모음', '기획', '한정', '증정', '사은품',
  '정품', '무료', '무료배송', '당일발송', '최신', '최신형', '신상', '신상품', '인기',
  '추천', '베스트', '가성비', '저렴', '할인', '특가', '초특가', '핫딜', '국내산',
  '국내배송', '공식', '인증', '프리미엄', '고급', '대용량', '초경량', '휴대용',
  '남성용', '여성용', '공용', '겸용', '전용', '호환', '기본', '일반'
]);

/** 수량·규격 꼬리표. 12개 / 60g / 1.2l / 20인치 */
const UNIT_RE = /^\d+(\.\d+)?(g|kg|mg|ml|l|cm|mm|m|인치|호|개|매|입|장|팩|병|캔|세트|구|p|ea|w|v|a|mah|hz|khz|ghz)$/;
/** 메모리·저장용량. 숫자 토큰이 여기 걸리면 "16인치" 의 16 과 구분해야 한다. */
const CAPACITY_RE = /^\d+(gb|tb|mb)$/;
/** 연도. 2025 / 2026 */
const YEAR_RE = /^(19|20)\d{2}$/;
/** 모델명 꼴 — 영문과 숫자가 섞여 있다. 14zd95u / 16z90s / x1607ca / rsm-r510 → rsmr510 */
const MODEL_RE = /^(?=[0-9a-z]*[a-z])(?=[0-9a-z]*\d)[0-9a-z]{3,}$/;

/**
 * 상품명·검색어를 토큰으로 끊는다.
 *
 * 공백 외에 문자 종류가 바뀌는 자리에서도 끊는다.
 *   "코어ultra5"  → ["코어", "ultra5"]
 *   "11프로"      → ["11", "프로"]
 *   "그램16"      → ["그램", "16"]
 * 영문+숫자는 붙여 둔다. 모델명이 거기서 갈라지면 안 되기 때문이다("14zd95u").
 */
function splitTokens(normalized) {
  const out = [];
  String(normalized || '').split(' ').forEach(chunk => {
    if (!chunk) return;
    // 한글 덩어리 / 영문·숫자 덩어리를 번갈아 뽑는다.
    const parts = chunk.match(/[가-힣ㄱ-ㅎㅏ-ㅣ]+|[0-9a-z]+/g) || [];
    parts.forEach(p => { if (p) out.push(p); });
  });
  return out;
}

/** 토큰 종류. 가중치가 여기서 갈린다. */
const KIND = {
  MODEL: 'model',     // 모델명 (영문+숫자)
  BRAND: 'brand',     // 질의 머리 토큰
  YEAR: 'year',
  NUMBER: 'number',
  UNIT: 'unit',
  COMMON: 'common',   // 너무 흔한 말
  WORD: 'word'
};

const KIND_WEIGHT = {
  [KIND.MODEL]: 3,
  [KIND.BRAND]: 2,
  [KIND.YEAR]: 1.2,
  [KIND.NUMBER]: 1,
  [KIND.UNIT]: 0.3,
  [KIND.COMMON]: 0.35,
  [KIND.WORD]: 1
};

function classify(tok) {
  if (UNIT_RE.test(tok) || CAPACITY_RE.test(tok)) return KIND.UNIT;
  if (YEAR_RE.test(tok)) return KIND.YEAR;
  if (/^\d+$/.test(tok)) return KIND.NUMBER;
  if (MODEL_RE.test(tok)) return KIND.MODEL;
  if (COMMON_WORDS.has(tok)) return KIND.COMMON;
  return KIND.WORD;
}

/*
 * 동의어 / 표기 변형.
 *
 * 만들어낸 목록이 아니라 실측 캐시 466건에서 "정답인데 탈락한" 사례를
 * 그대로 옮긴 것이다. 각 줄 옆에 근거가 된 상품명을 적어 둔다.
 * 여기 없는 말은 아래 합성어 분해(splitCompound)와 부분 문자열로 처리된다.
 *
 * 한 방향이 아니라 그룹이다 — 그룹 안의 말끼리는 서로 통한다.
 */
const SYNONYM_GROUPS = [
  // "향수" 검색 10건 중 8건이 오드뚜왈렛/오드퍼퓸 표기라 전부 탈락했었다
  ['향수', '퍼퓸', '오드퍼퓸', '오드뚜왈렛', '뚜왈렛', '코롱', '샤워코롱', 'perfume', 'edt', 'edp'],
  // "전기포트" 검색 10건 중 8건이 "전기 주전자"/"전기주전자" 표기
  ['전기포트', '전기주전자', '주전자', '커피포트', '티포트', '전기포터', '케틀', 'kettle'],
  // "무선이어폰" — 제목은 "블루투스 이어폰" 이 압도적이다
  ['이어폰', '이어버드', '버즈', 'earbuds', 'earphone'],
  ['무선', '블루투스', 'bluetooth', 'wireless'],
  ['스마트워치', '워치', 'watch', '스마트밴드'],
  // "노트북 스티커" 검색에 맥북 스티커가 떨어졌다 — 맥북도 노트북이다
  ['노트북', '랩탑', '맥북', 'laptop', 'notebook', 'macbook'],
  ['캐리어', '여행가방', '트렁크', 'suitcase'],
  ['텀블러', '보온병', '보냉병', 'tumbler'],
  // 한/영 표기 차이. "LG 그램 프로 16" 의 "프로" 는 제목에 "Pro" 로 온다
  ['프로', 'pro'], ['플러스', 'plus'], ['에어', 'air'], ['미니', 'mini'],
  ['맥스', 'max'], ['울트라', 'ultra'], ['라이트', 'lite'], ['그램', 'gram'],
  ['케이스', '커버', 'case'], ['충전기', '어댑터', '충전어댑터', 'charger']
];

const SYNONYMS = (() => {
  const m = new Map();
  SYNONYM_GROUPS.forEach(group => {
    group.forEach(w => {
      if (!m.has(w)) m.set(w, new Set());
      group.forEach(other => { if (other !== w) m.get(w).add(other); });
    });
  });
  return m;
})();

/**
 * 질의의 머리 토큰이 정말 브랜드인가?
 *
 * "머리 토큰 = 브랜드" 로 단정하면 안 된다. 실측에서 크게 틀렸다.
 *   "여행용 캐리어", "차량용 햇빛 가리개", "캠핑용 아이스박스", "동남아 여행 상품"
 * 의 머리 토큰은 브랜드가 아니라 용도·범주다. 이걸 브랜드로 보고 불일치
 * 감점을 먹이면 정답 상품이 통째로 떨어져 나간다(실측 30건).
 *
 * 판단은 목록 자체로 한다. 쿠팡 상품명은 브랜드가 맨 앞에 오므로,
 * 받아온 상품 중 하나라도 그 토큰으로 시작하면 그건 브랜드다.
 *   "아이패드 11프로 케이스" → "아이패드 프로11 M4 케이스…" 가 있다 → 브랜드 ○
 *   "여행용 캐리어"          → "여행용…" 으로 시작하는 상품이 없다  → 브랜드 ×
 *
 * 목록이 없으면(저장된 products 를 거를 때) 브랜드로 단정하지 않는다.
 * 근거 없이 감점하느니 가중치만 주는 편이 안전하다.
 */
/** 머리 토큰이 이 비율을 넘는 상품명에 들어 있으면 브랜드가 아니라 범주어로 본다. */
const BRAND_SPREAD_MAX = 0.6;

function detectBrandHead(headToken, titles) {
  if (!headToken || !Array.isArray(titles) || !titles.length) return false;
  /*
   * 신호 두 개를 같이 본다. 하나만 쓰면 둘 다 틀린다.
   *
   *  (1) 어느 상품명이든 그 토큰으로 시작하는가 — 브랜드는 맨 앞에 온다.
   *  (2) 그런데 대부분의 상품명에 들어 있지는 않은가 — 브랜드는 목록을
   *      가르는 말이고, 범주어는 목록 전체에 깔린다.
   *
   * (1)만 쓰면 "차량용 햇빛 가리개" 가 걸린다. 실제 응답 10건 중 하나가
   * 그냥 "차량용 햇빛가리개 우산형" 이라 브랜드로 잡혔고, 그 바람에
   * "자동차 앞유리 햇빛가리개" 3건이 브랜드 불일치로 떨어졌다. 하지만
   * "차량"은 10건 중 8건에 들어 있다 — 브랜드가 아니라 범주어라는 뜻이다.
   */
  const stem = stemOf(headToken) || headToken;
  let leads = 0;
  let contains = 0;

  titles.forEach(t => {
    const norm = normalizeText(t);
    const first = splitTokens(norm)[0];
    if (first && first.indexOf(headToken) === 0) leads++;
    if (norm.replace(/\s+/g, '').indexOf(stem) > -1) contains++;
  });

  return leads > 0 && contains / titles.length <= BRAND_SPREAD_MAX;
}

/**
 * 검색어 분석.
 *
 * @param {string} keyword
 * @param {object} opts
 *   titles — 이번에 받아온 상품명들. 머리 토큰이 브랜드인지 판단하는 데만 쓴다.
 * @returns {{raw, normalized, tokens, totalWeight, brandHead}}
 */
function analyzeQuery(keyword, opts = {}) {
  const normalized = normalizeText(keyword);
  const raw = splitTokens(normalized);

  const head = raw.find(t => classify(t) === KIND.WORD) || '';
  const brandHead = head && raw[0] === head && detectBrandHead(head, opts.titles);

  const tokens = raw.map((text, i) => {
    let kind = classify(text);
    // 머리 토큰은 브랜드든 아니든 검색 의도의 중심이라 가중치를 올린다.
    // 다만 '브랜드로 확인된' 경우에만 불일치 감점(BRAND_MISS_PENALTY)을 먹인다.
    if (i === 0 && kind === KIND.WORD) kind = KIND.BRAND;
    return {
      text, kind, weight: KIND_WEIGHT[kind],
      parts: splitCompound(text),
      stem: stemOf(text)
    };
  });

  const totalWeight = tokens.reduce((a, t) => a + t.weight, 0);
  return { raw: String(keyword || ''), normalized, tokens, totalWeight, brandHead: !!brandHead };
}

/**
 * 붙여 쓴 한글 합성어를 두 조각으로 나눠 본다.
 *
 *   "무선이어폰"   → ["무선", "이어폰"]
 *   "빨대텀블러"   → ["빨대", "텀블러"]
 *   "전기포트"     → ["전기", "포트"]
 *
 * 형태소 분석기를 붙이지 않는다. 사전 없이 두 조각으로 자르고,
 * "두 조각이 모두 상품명에 있으면" 그때만 인정한다. 조각 하나만 맞는 것은
 * 부분 점수다. 각 조각은 2글자 이상이어야 한다 — 한 글자는 아무 데나 걸린다.
 *
 * @returns {Array<Array<string>>} 후보 분해들. 없으면 빈 배열.
 */
function splitCompound(tok) {
  if (!/^[가-힣]{4,8}$/.test(tok)) return [];
  const out = [];
  for (let i = 2; i <= tok.length - 2; i++) {
    out.push([tok.slice(0, i), tok.slice(i)]);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 *  3. 관련도 점수
 * ------------------------------------------------------------------ */

/** 매칭 품질. 어떤 방식으로 맞았는지에 따라 점수가 다르다. */
const Q = {
  EXACT: 1,        // 제목 토큰과 그대로 일치
  SUBSTRING: 0.9,  // 공백 제거 후 부분 문자열 (붙여쓰기 차이)
  COMPOUND: 0.85,  // 합성어를 쪼갠 조각이 모두 제목에 있음
  STEM: 0.8,       // 접미사만 다름 ("여행용" ↔ "여행")
  SYNONYM: 0.75    // 동의어/표기 변형
};

/*
 * 용도를 나타내는 접미사.
 *
 * 검색어는 "여행용 캐리어"인데 상품명은 "여행 캐리어"인 경우가 실측에서
 * 매우 흔했다 ("차량용 햇빛 가리개" → "차량 햇빛가리개",
 * "캠핑용 아이스박스" → "캠핑 아이스박스"). 접미사 하나 때문에 정답을
 * 통째로 버리고 있었다. 어간이 2글자 이상 남을 때만 벗긴다.
 */
const MODIFIER_SUFFIX = /(용|형|식|성|제)$/;

function stemOf(tok) {
  if (!/^[가-힣]{3,}$/.test(tok)) return '';
  const stem = tok.replace(MODIFIER_SUFFIX, '');
  return stem.length >= 2 && stem !== tok ? stem : '';
}

/**
 * 검색어에 액세서리 낱말이 없는데 상품명에만 있으면 살짝 내린다.
 *
 * "LG전자 LG그램 14ZD95U" 로 검색하면 같은 모델명을 단 키스킨·필름이 노트북과
 * 같은 점수를 받는다(실측: "LG전자 2026 그램14 14ZD95U-GX5WK 키보드키커버 키스킨").
 * 버리지는 않는다 — 정말 그 액세서리를 찾는 사람도 있다. 순서만 뒤로 보낸다.
 */
const ACCESSORY_WORDS = [
  '케이스', '커버', '필름', '스킨', '키스킨', '파우치', '거치대', '스트랩',
  '보호', '액정보호', '강화유리', '충전기', '어댑터', '케이블', '받침대'
];

/* ------------------------------------------------------------------ *
 *  3-b. 핵심 명사 정렬 (단일 토큰 포화 해소)
 *
 *  ── 무엇이 잘못돼 있었나 ─────────────────────────────────────────
 *
 *  scoreTitle 은 «질의 커버리지» 만 잰다 — "검색어의 몇 %가 제목에 있는가".
 *  제목에 그 밖에 «무엇이 더 붙어 있는지» 는 보지 않는다. 그래서 검색어가
 *  한 단어면 그 단어를 품은 제목이 전부 1.0 으로 포화되고, 정렬의 첫 비교가
 *  무력화돼 사실상 «가격 오름차순» 이 된다. 실측(2026-09-04):
 *
 *      [향수]  0.75  조말론 런던 오드코롱 100ml    ← 진짜 향수(동의어라 감점)
 *              1.00  향수 공병 리필 용기 10ml      ← 빈 병이 1위
 *      [텀블러] 1.00  스탠리 진공 텀블러 = 텀블러 세척솔 = 텀블러 뚜껑 패킹
 *
 *  ── 무엇으로 가르는가 ────────────────────────────────────────────
 *
 *  제목 «길이» 로 가르면 안 된다. "아이폰 17 프로 맥스 256GB 자급제" 는 길지만
 *  좋은 결과이고 "아이폰 17 프로 케이스" 는 짧아도 액세서리다.
 *
 *  한국어는 핵심 명사가 «뒤» 에 온다. 그래서 처음에는 "검색어가 닿은 자리
 *  뒤에 토큰이 몇 개 더 있는가" 로만 깎아 봤다. 실패했다:
 *
 *      Apple 2025 에어팟 프로 3 USB-C 블루투스 [이어폰]   ← 진짜 본품
 *      [텀블러] 뚜껑 실리콘 패킹                          ← 부속
 *
 *  둘 다 검색어 뒤에 토큰이 여럿 남는다. 한국어 상품명은 끝에 «일반 종류명»
 *  (이어폰·노트북·자급제)이 오는 게 정상이기 때문이다. 꼬리의 «개수» 로는
 *  종류명과 부속명을 못 가른다. 실제로 그렇게 했다가 "갤럭시 S26 울트라"
 *  에서 진짜 휴대폰이 밀리고 가죽케이스가 1위가 되는 회귀가 났다.
 *
 *  가르는 것은 꼬리의 «정체» 다. 그래서 규칙을 이렇게 좁혔다:
 *
 *      검색어가 닿은 자리 «뒤» 에 부속 낱말이 오면, 이 상품은 그 부속이다.
 *
 *      [향수] 공병 리필 용기      뒤에 공병 → 부속
 *      [텀블러] 뚜껑 실리콘 패킹   뒤에 패킹 → 부속
 *      스탠리 진공 [텀블러]       뒤가 비었다 → 본품
 *      에어팟 [프로] 3 블루투스 이어폰  뒤는 종류명뿐 → 본품
 *      [케이스] 포함 에어팟 프로   부속 낱말이 «앞» 이다 → 본품
 *
 *  어순(무엇이 무엇을 수식하는가)과 낱말 목록을 함께 쓴다. 낱말은 특정 상품·
 *  브랜드가 아니라 어느 카테고리에나 걸치는 부속 일반명이고, 각 낱말의 세기는
 *  운영 상품명 2,306건에서 그 낱말이 핵심 자리에 오는 비율로 정했다.
 * ------------------------------------------------------------------ */

/*
 * 꼬리에 붙는 옵션 표기. 핵심 명사를 찾을 때 뒤에서부터 떼어낸다.
 * 색상·설치·증정처럼 «어떤 상품에나 붙는» 말만 넣는다. 특정 상품·브랜드는 없다.
 */
const TAIL_NOISE = new Set([
  '블랙', '화이트', '그레이', '그레이지', '실버', '네이비', '베이지', '아이보리',
  '핑크', '레드', '블루', '그린', '브라운', '골드', '민트', '퍼플', '오렌지',
  'black', 'white', 'gray', 'grey', 'silver', 'navy', 'pink', 'red', 'blue',
  'green', 'gold', 'beige', 'ivory',
  '단품', '본품', '옵션', '선택', '랜덤', '혼합', '추가', '포함', '미포함',
  '방문설치', '무료설치', '설치', '배송', '당일발송', '할인쿠폰', '쿠폰',
  '국내발송', '해외배송', '해외', '정품', '벌크', '박스', '리퍼'
]);

/**
 * 제목의 내용 토큰. 뒤에 붙은 수량·규격·색상 같은 옵션 표기를 떼어낸다.
 *
 * 쉼표로 자르지는 «않는다». 쉼표가 옵션 구분자인 제목이 많지만
 * ("…서큘레이터, PCF-HD15(블랙)"), 모델 변형을 나열하는 제목도 있어서
 * ("갤럭시S26,S26플러스,S26울트라 가죽케이스") 일률적으로 자르면 그런
 * 제목의 «진짜 핵심 명사»(가죽케이스)를 통째로 못 보게 된다. 실제로
 * 그렇게 잘랐다가 갤럭시 검색에서 케이스가 1위로 올라오는 회귀가 났다.
 */
function coreTokens(rawTitle) {
  const toks = splitTokens(normalizeText(rawTitle));
  while (toks.length > 1) {
    const last = toks[toks.length - 1];
    const k = classify(last);
    const droppable = k === KIND.UNIT || k === KIND.NUMBER || k === KIND.YEAR
      || k === KIND.COMMON || TAIL_NOISE.has(last);
    if (!droppable) break;
    toks.pop();
  }
  return toks;
}

/**
 * 질의 토큰이 제목 토큰 목록에서 «처음» 닿는 자리. 없으면 -1.
 *
 * 가장 뒤가 아니라 가장 앞을 쓴다. 뒤를 쓰면 부속 이름 안에 검색어가 다시
 * 들어 있을 때 기준점이 부속 «뒤» 로 밀려 감점이 안 걸린다. 실제 사례:
 *     "에어팟 프로 이어팁 [에어팟폼팁] 데코니"
 *      ↑첫 일치        ↑부속    ↑여기가 마지막 일치가 돼 버린다
 * 한국어는 왼쪽이 오른쪽을 꾸미므로, 검색어가 처음 닿은 뒤에 오는 말들이
 * "그래서 이게 무엇인가" 를 정한다.
 */
function matchIndex(token, toks) {
  for (let i = 0; i < toks.length; i++) {
    const tt = toks[i];
    if (tt === token.text) return i;
    if (token.text.length >= 2 && tt.indexOf(token.text) > -1) return i;
    if (token.stem && tt.indexOf(token.stem) > -1) return i;
    const syn = SYNONYMS.get(token.text);
    if (syn) {
      for (const sy of syn) if (sy.length >= 2 && tt.indexOf(sy) > -1) return i;
    }
  }
  return -1;
}

/*
 * 부속 낱말과 그 «세기».
 *
 * 세기는 지어낸 것이 아니라 운영 상품명 2,306건에서 그 낱말이 핵심 명사
 * 자리에 얼마나 오는지로 갈랐다. 핵심으로 거의 안 오는 말일수록 강하다.
 *
 *   strong  그 자체로 팔리는 일이 드물다        (케이스·이어팁·교체용·패킹)
 *   medium  상품일 수도, 부속일 수도 있다        (충전기·필터·뚜껑·배터리)
 *   weak    수식어에 가깝다                     (보호·수납·호환·충전)
 *
 * '링'·'망'·'줄' 은 등장이 잦은데(각 130·47·7건) 상품명 안에서 다른 뜻으로
 * 쓰이는 경우가 많아 넣지 않았다. 잘못 내리는 쪽이 안 내리는 쪽보다 나쁘다.
 */
const ACCESSORY_TIER = [
  // strong
  ['액정보호', 0.72], ['강화유리', 0.72], ['보호필름', 0.72], ['키스킨', 0.72],
  ['케이스', 0.72], ['커버', 0.72], ['필름', 0.72], ['파우치', 0.72],
  ['거치대', 0.72], ['받침대', 0.72], ['스트랩', 0.72], ['어댑터', 0.72],
  ['케이블', 0.72], ['이어팁', 0.72], ['공병', 0.72], ['리필', 0.72],
  ['세척솔', 0.72], ['스쿱', 0.72], ['포장용기', 0.72], ['패킹', 0.72],
  ['교체용', 0.72], ['소모품', 0.72], ['부품', 0.72], ['리무버', 0.72],
  ['카트리지', 0.72], ['심지', 0.72],
  // medium
  ['충전기', 0.85], ['뚜껑', 0.85], ['필터', 0.85], ['홀더', 0.85],
  ['스탠드', 0.85], ['마개', 0.85], ['브러시', 0.85], ['클리너', 0.85],
  ['보관함', 0.85], ['정리함', 0.85], ['용기', 0.85], ['봉투', 0.85],
  ['배터리', 0.85], ['스티커', 0.85]
];

/*
 * ── 넣었다가 뺀 낱말과 그 이유 ──
 *
 * 이 목록은 «부분 문자열» 로 맞춘다(indexOf). 그래서 짧거나 뜻이 겹치는 말은
 * 멀쩡한 본품을 때린다. 실사용 검색에서 잡은 오탐과, 뺀 근거:
 *
 *   충전  "에어팟 4 블루투스 이어폰 유선충전" ← 기능 설명인데 부속으로 봤다
 *   보호  액정보호·보호필름은 위에 따로 있다. 남기면 "눈 보호" 같은 말까지 맞는다
 *   호환  "OO 호환 배터리" 처럼 수식어로 더 자주 쓰인다
 *   수납·교체·세정  각각 수납장·교체형·세정제 같은 «본품» 을 때린다
 *   스킨  화장품 스킨이 본품이다 (부속인 '키스킨' 은 통째로 남겼다)
 *   토너·잉크  프린터 소모품이자 화장품/프린터 본품 이름이다
 *   캡    캡슐·캡모자·스냅백까지 맞는다
 *
 * 감점이 약해서 순위가 안 바뀌더라도, 근거 없이 깎은 값이 남는 쪽보다
 * 아예 안 거는 쪽이 낫다.
 */

/** 검색어 자체가 부속을 가리키는가 (그렇다면 부속 감점을 걸면 안 된다). */
function queryWantsAccessory(analysis) {
  const n = analysis.normalized || '';
  return ACCESSORY_TIER.some(([w]) => n.indexOf(w) > -1);
}

/**
 * 핵심 명사 정렬 계수 (0~1). rankItems 가 relevance 에 곱한다.
 *
 * ★ scoreTitle 은 건드리지 않는다. 그쪽은 "질의가 제목에 얼마나 반영됐나"
 *   라는 별개의 물음이고, 그 계약에 기대는 검사들이 이미 있다.
 *   여기서 답하는 물음은 "그래서 이게 사용자가 찾던 «그 물건»인가" 다.
 *
 * @param {object} analysis analyzeQuery 결과
 * @param {string} rawTitle 원본 상품명
 * @returns {{factor:number, at:number, accessory:string, reason:string}}
 */
function productFocus(analysis, rawTitle) {
  const none = { factor: 1, at: -1, accessory: '', reason: '' };
  if (!analysis || !analysis.tokens || !analysis.tokens.length) return none;
  // 검색어가 부속을 찾고 있으면(이어팁·충전기 검색) 부속을 내리면 안 된다.
  if (queryWantsAccessory(analysis)) return none;

  const core = coreTokens(rawTitle);
  if (core.length < 2) return none;

  // 검색어가 제목에 «처음» 닿는 자리. 여러 토큰이면 그중 가장 앞.
  let at = -1;
  analysis.tokens.forEach(tok => {
    const i = matchIndex(tok, core);
    if (i > -1 && (at < 0 || i < at)) at = i;
  });
  // 못 찾았으면 판단 근거가 없다 — 건드리지 않는다.
  if (at < 0) return none;

  /*
   * 닿은 자리 «뒤» 에서만 부속 낱말을 찾는다. 앞이나 같은 자리는 보지 않는다.
   * 여러 개면 가장 강한(계수가 낮은) 것을 쓴다 — "뚜껑 실리콘 패킹" 처럼
   * 약한 말과 강한 말이 같이 오면 강한 쪽이 이 상품의 정체에 가깝다.
   */
  let factor = 1, hit = '';
  for (let i = at + 1; i < core.length; i++) {
    for (const [w, weight] of ACCESSORY_TIER) {
      if (core[i].indexOf(w) > -1 && weight < factor) { factor = weight; hit = w; }
    }
  }
  if (!hit) return none;

  return { factor, at, accessory: hit, reason: `tail-acc:${hit}` };
}

/** 상품명을 한 번만 분석해 두고 여러 검색어에 재사용한다. */
function analyzeTitle(title) {
  const normalized = normalizeText(title);
  const tokens = splitTokens(normalized);
  return {
    normalized,
    tokens,
    set: new Set(tokens),
    flat: tokens.join(''),
    /*
     * 숫자 토큰이 용량 표기에만 등장하는지 보기 위한 목록.
     * "16GB" 의 16 은 16인치 노트북을 찾는 사람에게 아무 의미가 없다.
     */
    capacityNums: new Set(tokens.filter(t => CAPACITY_RE.test(t)).map(t => t.replace(/[a-z]+$/, '')))
  };
}

/** 토큰 하나가 상품명에 얼마나 반영돼 있는가. 0~1. */
function tokenQuality(token, T) {
  const t = token.text;

  if (T.set.has(t)) {
    // 숫자가 용량 자리에만 있으면 맞은 것으로 치지 않는다.
    return 1 * Q.EXACT;
  }

  if (token.kind === KIND.NUMBER || token.kind === KIND.YEAR) {
    /*
     * 숫자는 부분 문자열로 보면 안 된다. "16" 은 "16gb"·"512gb"·"2016" 어디에나 있다.
     * 제목 토큰에 그대로 있을 때만(위 EXACT) 인정하고, 용량 표기에만 있으면 0이다.
     */
    if (T.capacityNums.has(t)) return 0;
    // "그램16" 처럼 붙어 있는 경우는 splitTokens 가 이미 끊어서 set 에 들어 있다.
    return 0;
  }

  // 붙여쓰기 차이 — 공백을 지운 제목에서 찾는다 ("무선 이어폰" → "무선이어폰")
  if (t.length >= 2 && T.flat.indexOf(t) > -1) return Q.SUBSTRING;

  // 용도 접미사만 다른 경우 ("여행용" ↔ "여행")
  if (token.stem && T.flat.indexOf(token.stem) > -1) return Q.STEM;

  // 합성어 분해 — 조각이 모두 있으면 거의 일치, 일부만 있으면 그 비율만큼
  let best = 0;
  token.parts.forEach(parts => {
    const hit = parts.filter(p => T.flat.indexOf(p) > -1).length;
    if (!hit) return;
    const q = hit === parts.length ? Q.COMPOUND : Q.COMPOUND * (hit / parts.length);
    if (q > best) best = q;
  });
  if (best) return best;

  // 동의어 / 한영 표기 변형
  const syn = SYNONYMS.get(t);
  if (syn) {
    for (const s of syn) {
      if (T.set.has(s) || (s.length >= 2 && T.flat.indexOf(s) > -1)) return Q.SYNONYM;
    }
  }

  return 0;
}

/** 브랜드(머리) 토큰이 아예 안 맞을 때 곱하는 값. */
const BRAND_MISS_PENALTY = 0.35;
/** 검색어에 모델명이 있는데 하나도 안 맞을 때 곱하는 값. */
const MODEL_MISS_PENALTY = 0.4;
/** 검색어에 없는 액세서리 상품일 때 곱하는 값. */
const ACCESSORY_PENALTY = 0.8;

/**
 * 검색어와 상품명의 관련도. 0~1.
 *
 * @param {object} analysis analyzeQuery() 결과
 * @param {string|object} title 상품명 또는 analyzeTitle() 결과
 * @returns {{score, hits: Array, misses: Array, reason: string}}
 */
function scoreTitle(analysis, title) {
  const T = (title && title.set) ? title : analyzeTitle(title);
  if (!analysis.tokens.length) return { score: 1, hits: [], misses: [], reason: 'no-tokens' };

  const hits = [];
  const misses = [];
  let sum = 0;
  let brandMissed = false;
  let modelTotal = 0;
  let modelHit = 0;

  analysis.tokens.forEach(tok => {
    const q = tokenQuality(tok, T);
    sum += tok.weight * q;
    if (tok.kind === KIND.MODEL) { modelTotal++; if (q > 0) modelHit++; }
    // 브랜드로 확인된 머리 토큰만 감점 대상이다 (detectBrandHead 주석 참고).
    if (tok.kind === KIND.BRAND && q === 0 && analysis.brandHead) brandMissed = true;
    (q > 0 ? hits : misses).push(tok.text);
  });

  let score = analysis.totalWeight ? sum / analysis.totalWeight : 0;
  const reasons = [];

  if (brandMissed) { score *= BRAND_MISS_PENALTY; reasons.push('brand-miss'); }
  if (modelTotal && !modelHit) { score *= MODEL_MISS_PENALTY; reasons.push('model-miss'); }

  const queryHasAccessory = ACCESSORY_WORDS.some(w => analysis.normalized.indexOf(w) > -1);
  if (!queryHasAccessory && ACCESSORY_WORDS.some(w => T.flat.indexOf(w) > -1)) {
    score *= ACCESSORY_PENALTY;
    reasons.push('accessory');
  }

  return { score: Math.round(score * 1000) / 1000, hits, misses, reason: reasons.join(',') };
}

/*
 * 노출 기준선.
 *
 * 실측 466건으로 맞춘 값이다(scripts/test-search.js 가 대표 사례를 고정한다).
 * 더 올리면 "전기포트→전기주전자" 같은 표기 차이 정답이 떨어져 나가고,
 * 더 내리면 "아이패드 → 레노버 탭" 같은 브랜드 불일치가 다시 통과한다.
 *
 * 이 값은 "쿠팡보다 잘 고르겠다"는 뜻이 아니다. 쿠팡 검색 순위 자체가 이미
 * 관련도 신호이므로, 우리가 할 일은 명백히 엉뚱한 것만 걷어내는 것이다.
 */
const MIN_SCORE = 0.3;

/* ------------------------------------------------------------------ *
 *  4. 중복 제거
 * ------------------------------------------------------------------ */

/**
 * 같은 상품이 두 번 나오는 것을 막는다.
 *
 * 기준은 product_id + mall 하나뿐이다. 가격 데이터 연결과 같은 원칙이다.
 *
 * ★ title 로는 절대 합치지 않는다.
 *   실측: products 1379행 중 상품명이 같은데 product_id/mall 이 다른 그룹이 64개 있다.
 *   상품명이 같아도 판매 단위·옵션·몰이 다르면 다른 상품이고, 합치면 한쪽 가격이
 *   다른 쪽 가격을 덮어쓴다. (예전에 product_id 자리에 상품명을 넣었다가
 *   "미스터빈 크라프트 드립백 봉투" 가 기본키가 된 적이 있다 — api/_shop.js 참고)
 *
 * 같은 키가 겹치면 싼 쪽을 남긴다. 순서에 기대지 않는다(_shop.recordPrices 와 같은 규칙).
 *
 * @returns {{items: Array, removed: number}}
 */
function dedupeItems(items) {
  const list = Array.isArray(items) ? items : [];
  const slots = [];              // 등장 순서대로 자리를 잡아 둔다
  const slotOf = new Map();      // key → slots 인덱스

  list.forEach(it => {
    if (!it) return;

    // 식별자가 없으면 합치지 않는다 — 합칠 근거가 없다.
    // (여기서 title 로 합치면 서로 다른 상품이 한 줄로 뭉개진다)
    if (!it.productId) { slots.push(it); return; }

    const key = `${it.productId}|${it.mall || ''}`;
    if (!slotOf.has(key)) {
      slotOf.set(key, slots.length);
      slots.push(it);
      return;
    }

    // 이미 있는 자리에 더 싼 옵션이 왔으면 그것으로 바꾼다.
    const i = slotOf.get(key);
    const a = Number(slots[i].lprice) || 0;
    const b = Number(it.lprice) || 0;
    if (b > 0 && (!a || b < a)) slots[i] = it;
  });

  return { items: slots, removed: list.length - slots.length };
}

/* ------------------------------------------------------------------ *
 *  5. 정렬
 * ------------------------------------------------------------------ */

/**
 * 관련도 → 가격 신뢰도 → 가격 순으로 세운다.
 *
 * ★ 가격만으로 앞으로 올라오는 일은 없다. 관련도가 다르면 가격은 보지 않는다.
 *   최저가 비교 서비스에서 "싸지만 내가 찾던 게 아닌 상품"이 1위인 것은
 *   틀린 가격을 보여주는 것 다음으로 나쁘다.
 *
 * 처음에는 관련도를 0.1 단위 계단으로 묶었다 — "0.82 와 0.80 의 차이는 표기
 * 우연이니 그 안에서는 싼 쪽을 올리자"는 생각이었다. 실제로 돌려 보니 정확히
 * 그 생각 때문에 사고가 났다.
 *
 *   "LG전자 LG그램 14ZD95U" 검색 결과
 *     0.88  LG그램2026 14ZD95U-GX56K …            1,799,000원   ← 본품
 *     0.80  LG전자 … 14ZD95U-GX5WK 키보드키커버 키스킨    7,980원   ← 액세서리
 *   0.88 과 0.80 이 같은 계단(8)에 들어가는 바람에 7,980원짜리 키스킨이
 *   노트북 본품보다 위에 섰다. 계단 경계는 이렇게 아무 데나 그어진다.
 *
 * 그래서 계단을 없앴다. 관련도는 있는 그대로 비교하고, 값이 정확히 같을 때만
 * 신뢰도와 가격이 순서를 정한다. 실제로 같은 점수가 나오는 경우는 흔해서
 * (표기가 같은 방식으로 맞으면 점수도 같다) 싼 것부터 보여주는 성질은 유지된다.
 */
/* ── 쇼핑몰 우선순위 ────────────────────────────────────────────────
 *
 * 같은 상품이 여러 몰에 있을 때 사용자가 더 익숙한 곳을 먼저 보는 편이
 * 낫다. 다만 이것이 "몰 순서대로 줄 세우기"가 되면 안 된다 —
 * 쿠팡 129,000원이 G마켓 89,000원 위에 서는 순간 최저가 서비스가 아니다.
 *
 * 그래서 우선순위를 순서가 아니라 "가격 몇 % 어치"로 환산한다. 상한이
 * 3% 라서 값이 조금이라도 크게 벌어지면 언제나 싼 쪽이 이긴다. 몰 순서는
 * 값이 사실상 같을 때만 눈에 보인다.
 *
 * ★ 실제로 관측된 몰만 앞자리에 둔다. 지금 데이터가 들어오는 곳은 쿠팡
 *   (직접 API)과 ADPICK 제휴몰(알리·SSG·GS SHOP·Hmall·롯데홈쇼핑·
 *   오늘의집·예스이십사·보리보리·더블유컨셉, 2026-08-26 실측)이다.
 *   네이버쇼핑·G마켓은 아직 응답에서 관측된 적이 없지만, 붙었을 때
 *   순서가 정해져 있도록 표에는 남겨 둔다 — 없는 몰의 상품을 만들어내는
 *   것과 표에 자리를 비워 두는 것은 다른 일이다.
 */
const MALL_ORDER = ['쿠팡', '알리', '네이버쇼핑', 'G마켓'];

/** 우선순위로 깎아 줄 수 있는 최대치. 가격 3% 어치. */
const MALL_BONUS_MAX = 0.03;

/**
 * 이 상품이 사용자에게 어느 몰로 보이는가.
 * mallLabel(ADPICK cp_name 기반 표시 이름)이 있으면 그것이 사용자가 보는 이름이다.
 */
function mallNameOf(it) {
  if (!it) return '';
  return String(it.mallLabel || it.mall || '').trim();
}

/**
 * 우선순위 순번. 표에 없으면 null (보너스 없음).
 * @returns {number|null} 0 이 가장 앞
 */
function mallRank(it) {
  const name = mallNameOf(it);
  if (!name) return null;
  const i = MALL_ORDER.indexOf(name);
  return i < 0 ? null : i;
}

/**
 * 우선순위를 반영한 비교용 가격.
 *
 * ★ 화면에 보여주는 가격은 절대 바꾸지 않는다. 정렬 키로만 쓴다.
 *   보여주는 값과 비교하는 값이 다르면 사용자가 속는다 — 그래서 이 값은
 *   반환하지도, 상품에 붙이지도 않는다.
 */
function mallAdjustedPrice(it) {
  const p = Number(it && it.lprice) || 0;
  if (!(p > 0)) return Infinity;   // 가격을 못 읽으면 맨 뒤
  const r = mallRank(it);
  if (r == null) return p;
  // 1순위가 3%, 마지막이 0% 에 가깝게. 표가 하나뿐이어도 나눗셈이 터지지 않는다.
  const span = Math.max(1, MALL_ORDER.length);
  const bonus = MALL_BONUS_MAX * (1 - r / span);
  return p * (1 - bonus);
}

/**
 * 관련도 → 가격 신뢰도 → (몰 우선순위를 반영한) 가격 순으로 세운다.
 *
 * ★ 가격만으로 앞으로 올라오는 일은 없다. 관련도가 다르면 가격은 보지 않는다.
 *   최저가 비교 서비스에서 "싸지만 내가 찾던 게 아닌 상품"이 1위인 것은
 *   틀린 가격을 보여주는 것 다음으로 나쁘다.
 *
 * 처음에는 관련도를 0.1 단위 계단으로 묶었다 — "0.82 와 0.80 의 차이는 표기
 * 우연이니 그 안에서는 싼 쪽을 올리자"는 생각이었다. 실제로 돌려 보니 정확히
 * 그 생각 때문에 사고가 났다.
 *
 *   "LG전자 LG그램 14ZD95U" 검색 결과
 *     0.88  LG그램2026 14ZD95U-GX56K …            1,799,000원   ← 본품
 *     0.80  LG전자 … 14ZD95U-GX5WK 키보드키커버 키스킨    7,980원   ← 액세서리
 *   0.88 과 0.80 이 같은 계단(8)에 들어가는 바람에 7,980원짜리 키스킨이
 *   노트북 본품보다 위에 섰다. 계단 경계는 이렇게 아무 데나 그어진다.
 *
 * 그래서 계단을 없앴다. 관련도는 있는 그대로 비교하고, 값이 정확히 같을 때만
 * 신뢰도와 가격이 순서를 정한다. 실제로 같은 점수가 나오는 경우는 흔해서
 * (표기가 같은 방식으로 맞으면 점수도 같다) 싼 것부터 보여주는 성질은 유지된다.
 *
 * 몰 우선순위는 마지막 단계에서만, 그것도 가격 3% 안에서만 작동한다
 * (mallAdjustedPrice 주석 참고). 값이 같으면 실제 가격으로 한 번 더 갈라서
 * 정렬이 흔들리지 않게 한다.
 */
function sortByRelevance(items) {
  return (items || []).slice().sort((a, b) => {
    const ra = (a && a.relevance) || 0;
    const rb = (b && b.relevance) || 0;
    if (ra !== rb) return rb - ra;

    const ta = (a && a.trust && Number(a.trust.score)) || 0;
    const tb = (b && b.trust && Number(b.trust.score)) || 0;
    if (ta !== tb) return tb - ta;

    const ma = mallAdjustedPrice(a);
    const mb = mallAdjustedPrice(b);
    if (ma !== mb) return ma - mb;

    // 보정값까지 같으면 실제 가격 → 결정론을 위해 마지막에 상품 식별자.
    const pa = Number(a && a.lprice) || Infinity;
    const pb = Number(b && b.lprice) || Infinity;
    if (pa !== pb) return pa - pb;

    const ia = String((a && a.productId) || '');
    const ib = String((b && b.productId) || '');
    return ia < ib ? -1 : (ia > ib ? 1 : 0);
  });
}

/**
 * 검색 결과에 관련도를 붙이고, 기준선 미만은 걸러내고, 중복을 없앤다.
 * 정렬은 하지 않는다 — 신뢰도가 붙은 뒤에 sortByRelevance() 로 따로 세운다.
 *
 * @returns {{items, dropped, removed, allBelow}}
 *   allBelow — 받아온 건 있는데 전부 기준선 아래였다 ("결과 없음"과 구분해야 한다)
 */
function rankItems(keyword, items, opts = {}) {
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : MIN_SCORE;
  const { items: uniq, removed } = dedupeItems(items);
  // 브랜드 판정에 이번 목록을 쓴다 (detectBrandHead 주석 참고).
  const analysis = analyzeQuery(keyword, { titles: uniq.map(it => (it && it.title) || '') });

  if (!analysis.tokens.length || !uniq.length) {
    uniq.forEach(it => { if (it) it.relevance = 1; });
    return { items: uniq, dropped: 0, removed, allBelow: false };
  }

  const scored = uniq.map(it => {
    const r = scoreTitle(analysis, it && it.title);
    /*
     * 질의 커버리지(r.score) 에 «핵심 명사 정렬»(productFocus) 을 곱한다.
     *
     * 커버리지만으로는 단일 토큰 검색이 전부 1.0 으로 포화된다(productFocus
     * 머리 주석의 실측 참고). 곱하는 값은 어순에서 나오므로 특정 상품·브랜드·
     * 검색어에 대한 예외가 없다.
     *
     * scoreTitle 의 반환값 자체는 바꾸지 않는다 — 그 계약(정확히 맞으면 1.0)에
     * 기대는 검사가 이미 있고, "질의가 얼마나 반영됐나" 와 "이게 그 물건인가" 는
     * 서로 다른 물음이라 한 숫자에 섞지 않는 편이 낫다.
     */
    const f = productFocus(analysis, it && it.title);
    if (it) {
      it.relevance = Math.round(r.score * f.factor * 1000) / 1000;
      // 왜 내려갔는지 남긴다. 진단용이고 응답 형태를 바꾸지 않는다(undefined 면 직렬화에서 빠진다).
      it.relevanceWhy = [r.reason, f.reason].filter(Boolean).join(',') || undefined;
    }
    return { it, r, f };
  });

  const kept = scored.filter(s => s.r.score >= minScore);
  if (!kept.length) {
    return { items: [], dropped: scored.length, removed, allBelow: true };
  }

  return {
    items: kept.map(s => s.it),
    dropped: scored.length - kept.length,
    removed,
    allBelow: false
  };
}

/**
 * 이 상품명이 검색어와 관련 있다고 볼 수 있는가 (단건 판정).
 *
 * 저장된 products 행을 거를 때처럼 "이번 응답 목록"이 없는 자리에서 쓴다.
 * 목록이 없으면 브랜드 판정을 할 수 없으므로 브랜드 불일치 감점도 걸리지
 * 않는다 — 근거 없이 버리지 않는다는 뜻이다.
 */
function isRelevant(keyword, title, opts = {}) {
  const analysis = opts.analysis || analyzeQuery(keyword);
  if (!analysis.tokens.length) return true;
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : MIN_SCORE;
  return scoreTitle(analysis, title).score >= minScore;
}

/* ------------------------------------------------------------------ *
 *  6. 오타 / 검색어 보정
 *
 *  외부 맞춤법 API 를 붙이지 않는다. 우리가 이미 가진 것만 쓴다.
 *    - search_stats 의 실제 검색어
 *    - products.keyword
 *    - TODAY_PICKS
 *  그리고 결과를 마음대로 바꾸지 않는다. "혹시 이거였나요"를 제안만 한다.
 * ------------------------------------------------------------------ */

const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const JUNG = ['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ'];
const JONG = ['','ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];

/**
 * 한글을 자모로 편다.
 *
 * 왜 필요한가: 글자 단위로 편집거리를 재면 "텀블러"와 "텀블르"의 거리가 1,
 * "텀블러"와 "탐블러"도 1 이라 구분이 안 되고, 반대로 "이어폰"과 "이어푼"처럼
 * 모음 하나만 틀린 것도 글자 하나 통째로 틀린 것과 같은 거리로 잡힌다.
 * 자모로 펴면 실제로 몇 획이 틀렸는지에 가깝게 잰다.
 */
function toJamo(s) {
  let out = '';
  for (const ch of String(s || '')) {
    const c = ch.charCodeAt(0) - 0xac00;
    if (c >= 0 && c < 11172) {
      out += CHO[Math.floor(c / 588)] + JUNG[Math.floor((c % 588) / 28)] + JONG[c % 28];
    } else {
      out += ch;
    }
  }
  return out;
}

/** Damerau-Levenshtein (인접 전치 포함). "이어폰"→"이언폰" 같은 순서 바뀜도 1로 잡는다. */
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array(n + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= n; j++) d[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
      }
    }
  }
  return d[m][n];
}

/*
 * 한/영 자판 오타. 한글 입력 상태를 안 바꾸고 그대로 친 경우다.
 *   "dkdlvhs" → "아이폰",  "shxmqhr" → "노트북"
 * 두벌식 배열 그대로다. 없는 조합이면 변환하지 않는다(무리해서 만들지 않는다).
 */
const QWERTY_TO_JAMO = {
  q:'ㅂ', w:'ㅈ', e:'ㄷ', r:'ㄱ', t:'ㅅ', y:'ㅛ', u:'ㅕ', i:'ㅑ', o:'ㅐ', p:'ㅔ',
  a:'ㅁ', s:'ㄴ', d:'ㅇ', f:'ㄹ', g:'ㅎ', h:'ㅗ', j:'ㅓ', k:'ㅏ', l:'ㅣ',
  z:'ㅋ', x:'ㅌ', c:'ㅊ', v:'ㅍ', b:'ㅠ', n:'ㅜ', m:'ㅡ',
  Q:'ㅃ', W:'ㅉ', E:'ㄸ', R:'ㄲ', T:'ㅆ', O:'ㅒ', P:'ㅖ'
};

const DOUBLE_JUNG = {
  'ㅗㅏ':'ㅘ', 'ㅗㅐ':'ㅙ', 'ㅗㅣ':'ㅚ', 'ㅜㅓ':'ㅝ', 'ㅜㅔ':'ㅞ', 'ㅜㅣ':'ㅟ', 'ㅡㅣ':'ㅢ'
};
const DOUBLE_JONG = {
  'ㄱㅅ':'ㄳ', 'ㄴㅈ':'ㄵ', 'ㄴㅎ':'ㄶ', 'ㄹㄱ':'ㄺ', 'ㄹㅁ':'ㄻ', 'ㄹㅂ':'ㄼ',
  'ㄹㅅ':'ㄽ', 'ㄹㅌ':'ㄾ', 'ㄹㅍ':'ㄿ', 'ㄹㅎ':'ㅀ', 'ㅂㅅ':'ㅄ'
};

/**
 * 영문 자판으로 친 한글을 되돌린다. 되돌릴 수 없으면 빈 문자열.
 * 알파벳이 하나도 없거나 한글이 이미 섞여 있으면 손대지 않는다.
 */
function fromKeyboardLayout(s) {
  const src = String(s || '').trim();
  if (!src || /[가-힣]/.test(src)) return '';
  if (!/^[a-zA-Z\s]+$/.test(src)) return '';

  let out = '';
  for (const word of src.split(/\s+/)) {
    const jamo = [];
    for (const ch of word) {
      const j = QWERTY_TO_JAMO[ch];
      if (!j) return '';           // 배열에 없는 글자 — 변환 포기
      jamo.push(j);
    }
    const assembled = assembleJamo(jamo);
    if (!assembled) return '';
    out += (out ? ' ' : '') + assembled;
  }
  return /[가-힣]/.test(out) ? out : '';
}

/** 자모 배열 → 완성형 한글. 조합이 안 되면 빈 문자열. */
function assembleJamo(jamo) {
  let out = '';
  let i = 0;
  const isCho = j => CHO.indexOf(j) > -1;
  const isJung = j => JUNG.indexOf(j) > -1;

  while (i < jamo.length) {
    if (!isCho(jamo[i])) return '';
    let cho = jamo[i++];

    // 다음 초성이 이어지면 앞 글자는 종성 없이 끝나야 하는데, 중성이 없으면 조합 불가
    if (i >= jamo.length || !isJung(jamo[i])) return '';
    let jung = jamo[i++];
    if (i < jamo.length && isJung(jamo[i]) && DOUBLE_JUNG[jung + jamo[i]]) {
      jung = DOUBLE_JUNG[jung + jamo[i]];
      i++;
    }

    let jong = '';
    if (i < jamo.length && JONG.indexOf(jamo[i]) > 0) {
      // 다음다음이 중성이면 이 자모는 다음 글자의 초성이다 ("가나" 의 ㄴ)
      const twoAhead = jamo[i + 1];
      const composed = i + 1 < jamo.length && DOUBLE_JONG[jamo[i] + twoAhead];
      if (composed && !(i + 2 < jamo.length && isJung(jamo[i + 2]))) {
        jong = composed; i += 2;
      } else if (!(twoAhead && isJung(twoAhead))) {
        jong = jamo[i]; i++;
      }
    }

    const ci = CHO.indexOf(cho), ji = JUNG.indexOf(jung), ki = JONG.indexOf(jong);
    if (ci < 0 || ji < 0 || ki < 0) return '';
    out += String.fromCharCode(0xac00 + ci * 588 + ji * 28 + ki);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 *  6-b. 추천 후보 품질
 *
 *  "이런 검색어는 어떠세요" 에 올라가는 말은 사용자가 친 말이 아니라
 *  우리가 고른 말이다. 그러니 우리가 책임져야 한다.
 *
 *  ── 무엇이 문제였나 ────────────────────────────────────────────
 *  사전(dictionary)은 api/search.js 의 loadKeywordDictionary 가
 *  search_stats + products.keyword + TODAY_PICKS 를 합쳐 만든다.
 *  이 중 search_stats 는 "사람이 친 말" 이지 "쓸 만한 검색어" 가 아니다.
 *
 *  2026-08-22 운영 실측: search_stats 48종 중 11종이 products 에 대응
 *  상품이 하나도 없다 —
 *    "텀블르" "액정태블릿" "액정테블릿"  (오타)
 *    "__schema_check__" "테스트"          (내부·시험)
 *    "dkdlvhs" "dldjvhs"                  (영문 자판 오타)
 *    "양희훈" "컵 실린더" "물통" "앙 기모찌"
 *  그런데 사전에는 전부 들어갔고, "dkdlvhs" 를 검색하면 자판 보정으로
 *  "아이폰" 을 찾은 뒤 그 주변어를 고르는 과정에서 "앙 기모찌" 가
 *  대체 검색어로 나갔다. 실제로 사용자 화면에 노출됐다.
 *
 *  ── 어떻게 막는가 (겹겹으로) ──────────────────────────────────
 *   1) 구조 규칙   — 아래 isValidSuggestion. 형태만 보고 거른다.
 *   2) 관련성 하한 — nearest() 의 MIN_SUGGEST_SIMILARITY.
 *                    "앙 기모찌" 는 "아이폰" 과 자모 유사도 0.556 이라
 *                    0.5 문턱을 아슬아슬하게 넘고 있었다.
 *   3) 표현 목록   — 욕설·성적 표현. 마지막 layer 다. 여기에만 기대지
 *                    않는다 (목록은 늘 뒤처진다).
 *
 *  ── 규칙을 고를 때 지킨 것 ────────────────────────────────────
 *  운영 products.keyword 262종 전수로 오탐 0 을 확인하고 넣은 규칙만
 *  남겼다. 한국어 종결어미로 문장을 판별하는 규칙은 넣지 않았다 —
 *  실제 상품 키워드에 "온더바디 코튼풋 발을씻자"(자로 끝남),
 *  "아픔이 길이 되려면"(문장), "안녕"(인사말) 이 멀쩡히 들어 있어서
 *  그런 규칙은 진짜 상품을 지운다.
 * ------------------------------------------------------------------ */

/** 상품 검색어 길이 상한. 운영 262종의 최댓값이 25자다. */
const SUGGEST_MAX_LEN = 40;
/** 한 글자짜리는 무엇에나 걸린다. 운영 최소 길이도 2자다. */
const SUGGEST_MIN_LEN = 2;

const URL_RE        = /(https?:\/\/|www\.|\.(com|net|org|io|shop|kr)(\/|$))/i;
const EMAIL_RE      = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE_RE      = /^[\d\s\-+().]{7,}$/;
const DIGITS_ONLY_RE= /^[\d\s.,+\-]+$/;
/** ㅋㅋㅋㅋ · ㅇㅇ · ㄱㄱ — 자모만으로는 상품을 가리키지 못한다. */
const JAMO_ONLY_RE  = /^[\u3131-\u318E\s]+$/;
/** zzz · !!!! · ㅋㅋㅋ — 같은 글자 3연속. 운영 262종에 0건이다. */
const REPEAT_CHAR_RE= /(.)\1{2,}/;
/** testtesttest · abcabcabc — 짧은 토막의 3회 이상 반복. */
const REPEAT_UNIT_RE= /^(.{1,4})\1{2,}$/;
/** 글자도 숫자도 없는 문자열. */
const NO_WORD_RE    = /^[^0-9a-zA-Z\uAC00-\uD7A3]+$/;
/** 집계용 내부 키워드(__schema_check__). */
const INTERNAL_RE   = /^__/;
/**
 * 존댓말 종결어미로 끝나는 말 — 상품명이 아니라 문장이다.
 * ("안녕하세요" "감사합니다" "반갑습니다")
 *
 * 여기까지만 넣는다. 종결어미 전반으로 넓히면 진짜 상품이 지워진다 —
 * 운영 262종 실측 오탐:
 *   /자$/  8건  "HOMEY NEST 사무용의자" "드립백 손잡이 투명상자" "…안마의자"
 *   /면$/  4건  "농심 안성탕면 봉지라면" "신라면" "바운티풀 코마사 사틴면"
 *   /지$/  2건  "고스트 불빛 반지"
 *   위 존댓말 어미  0건  ← 그래서 이것만 쓴다
 *
 * 나머지 대화체("뭐 먹지" "살려줘" 같은 말)는 문법으로 잡지 않는다.
 * 검색어와의 관련성 하한(MIN_SUGGEST_SIMILARITY)이 이미 막는다 —
 * "아이폰" 과 "안녕하세요" 의 자모 유사도는 0.25 다.
 */
const POLITE_ENDING_RE = /(하세요|합니다|습니다|십시오|해요|이에요|예요|였어요|겠어요|입니다|할게요|드려요)$/;

/** 시험 삼아 친 말. 운영 search_stats 에 "테스트" 가 실제로 있다. */
const TEST_WORD_RE  = /^(테스트|테스트용|샘플|test|testing|sample|dummy|asdf|qwer)$/i;

/**
 * 자판을 한 줄로 훑은 문자열인가 (asdfgh, qwer, 123456).
 * 문자열 전체가 한 행의 연속 구간이면 사람이 고른 말이 아니다.
 */
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890'];
function isKeyboardRun(s) {
  const t = String(s || '').toLowerCase().replace(/\s+/g, '');
  if (t.length < 4) return false;
  const rev = t.split('').reverse().join('');
  return KEYBOARD_ROWS.some(row => row.indexOf(t) > -1 || row.indexOf(rev) > -1);
}

/*
 * 욕설 · 성적 표현 — 마지막 layer.
 *
 * 사용자가 직접 친 검색어를 막는 목록이 아니다. 그건 그대로 검색해 준다.
 * 여기서 막는 것은 오직 "우리가 골라서 권하는 말" 이다.
 *
 * 목록에 기대지 않는 것이 원칙이라 짧게 유지한다. 실제로 이번에 문제가 된
 * "앙 기모찌" 는 이 목록이 없어도 관련성 하한(2번 layer)에서 걸린다 —
 * 목록은 보조일 뿐이다.
 */
const BLOCKED_TERMS = [
  '씨발', '시발', '좆', '존나', '병신', '지랄', '개새', '미친놈', '미친년',
  '섹스', '야동', '포르노', '자위', '기모찌', '야애니', '19금',
  'fuck', 'shit', 'porn', 'sex', 'xxx'
];

/**
 * 이 말을 "이런 검색어는 어떠세요" 에 올려도 되는가.
 *
 * ★ 사용자가 친 검색어를 검사하는 함수가 아니다. 사용자가 무엇을 치든
 *   그대로 검색해 주고 그대로 보여준다. 이 함수는 우리가 자동으로 권하는
 *   후보에만 쓴다.
 *
 * @param {string} keyword 후보 검색어
 * @returns {boolean} 추천해도 되면 true
 */
function isValidSuggestion(keyword) {
  const raw = String(keyword == null ? '' : keyword).trim();
  if (!raw) return false;
  if (raw.length < SUGGEST_MIN_LEN || raw.length > SUGGEST_MAX_LEN) return false;

  if (INTERNAL_RE.test(raw)) return false;
  if (URL_RE.test(raw) || EMAIL_RE.test(raw)) return false;
  if (PHONE_RE.test(raw) || DIGITS_ONLY_RE.test(raw)) return false;
  if (NO_WORD_RE.test(raw) || JAMO_ONLY_RE.test(raw)) return false;
  if (REPEAT_CHAR_RE.test(raw) || REPEAT_UNIT_RE.test(raw)) return false;
  if (TEST_WORD_RE.test(raw) || isKeyboardRun(raw)) return false;
  if (POLITE_ENDING_RE.test(raw)) return false;

  /*
   * 영문 자판으로 친 한글 (dkdlvhs → 아이폰).
   * 이건 오타의 흔적이지 검색어가 아니다. 보정 결과는 corrected 로 따로
   * 나가므로 여기서 후보로 또 권할 이유가 없다.
   */
  if (/^[a-zA-Z\s]+$/.test(raw) && fromKeyboardLayout(raw)) return false;

  const low = raw.toLowerCase();
  if (BLOCKED_TERMS.some(t => low.indexOf(t) > -1)) return false;

  return true;
}

/** 자모 길이에 맞춘 허용 오차. 짧은 말일수록 엄격해야 엉뚱한 제안이 안 나간다. */
function allowedDistance(jamoLen) {
  if (jamoLen <= 6) return 1;    // "이어폰"(9자모)보다 짧은 말
  if (jamoLen <= 12) return 2;
  return 3;
}

/**
 * 검색어 보정 제안.
 *
 * ★ 검색을 대신 바꾸지 않는다. 사용자가 친 말로 검색하고, 제안만 곁들인다.
 *   자동 치환은 "제트스트림"을 "제트스트림 리필심"으로 바꿔 버리는 식으로
 *   검색 의도를 조용히 왜곡한다.
 *
 * @param {string} keyword 사용자가 친 검색어
 * @param {Array<string>} dictionary 우리가 실제로 가진 검색어들
 * @param {object} opts
 *   excludeSelf — 사전에서 검색어 자신을 빼고 본다.
 *
 *     왜 필요한가: 프론트는 검색할 때마다 /api/stats 로 그 검색어를 집계한다.
 *     그래서 "텀블르" 를 한 번 검색하는 순간 "텀블르" 가 search_stats 에 들어가고,
 *     다음부터는 "사전에 있는 말이니 멀쩡하다" 고 판단해 보정을 멈춘다.
 *     실제로 브라우저 검증에서 그렇게 됐다. 결과가 0건이라면 그 말이
 *     우리 검색 로그에 있다는 사실은 그 말이 맞다는 근거가 되지 못한다.
 *
 * @returns {{corrected: string|null, reason: string, alternatives: Array<string>}}
 *   corrected    — "혹시 이걸 찾으셨나요" 로 보여줄 하나
 *   alternatives — 결과가 0건일 때 권할 다른 검색어들
 */
function suggestKeywords(keyword, dictionary, opts = {}) {
  const limit = opts.limit || 5;
  const q = normalizeText(keyword);
  const qKey = canonicalKey(keyword);
  if (!q) return { corrected: null, reason: '', alternatives: [] };

  // 사전 정리 — 정규화가 같은 것끼리 접는다("무선 이어폰" / "무선이어폰")
  const entries = [];
  const seen = new Set();
  (dictionary || []).forEach(d => {
    const text = String(d == null ? '' : d).trim();
    if (!text) return;
    const key = canonicalKey(text);
    if (!key || seen.has(key)) return;
    if (opts.excludeSelf && key === qKey) return;
    seen.add(key);
    entries.push({ text, key, norm: normalizeText(text), jamo: toJamo(canonicalKey(text)) });
  });

  /*
   * 후보 품질 필터.
   *
   * entries 는 그대로 둔다 — "이 말이 사전에 있는가"(=보정할 필요가 없는가)
   * 를 판단하려면 오염된 것까지 포함한 원래 사전이 필요하기 때문이다.
   * 우리가 골라서 내보내는 자리(corrected · alternatives)에만 pickable 을 쓴다.
   * (_search.js 6-b 절 주석 참고)
   */
  const pickable = entries.filter(e => isValidSuggestion(e.text));
  const clean = list => list.filter(isValidSuggestion);

  /* 1) 자판 오타 — "dkdlvhs" 처럼 아예 영문으로 친 경우 */
  const layout = fromKeyboardLayout(keyword);
  if (layout) {
    const hit = pickable.find(e => e.key === canonicalKey(layout));
    const suggestion = hit ? hit.text : layout;
    return {
      corrected: isValidSuggestion(suggestion) ? suggestion : null,
      reason: 'layout',
      alternatives: clean(nearest(pickable, canonicalKey(layout), limit).map(e => e.text))
    };
  }

  /* 2) 띄어쓰기만 다른 경우 — 오타가 아니라 표기 차이다 */
  const spacing = pickable.find(e => e.key === qKey && e.norm !== q);
  if (spacing) {
    return { corrected: spacing.text, reason: 'spacing', alternatives: [] };
  }

  /*
   * 3) 사전에 그대로 있으면 보정할 것이 없다.
   *    단 대체 검색어는 계속 준다 — 결과가 0건이라 여기까지 왔다면
   *    "그 말이 사전에 있다"는 사실만으로 사용자를 빈손으로 보낼 이유가 없다.
   */
  if (entries.some(e => e.key === qKey)) {
    return { corrected: null, reason: '', alternatives: clean(nearest(pickable, qKey, limit).map(e => e.text)) };
  }

  /* 4) 자모 편집거리 */
  const qJamo = toJamo(qKey);
  let best = null;
  pickable.forEach(e => {
    // 길이가 크게 다르면 오타가 아니라 다른 말이다
    if (Math.abs(e.jamo.length - qJamo.length) > 3) return;
    const d = editDistance(qJamo, e.jamo);
    if (d === 0 || d > allowedDistance(Math.max(qJamo.length, e.jamo.length))) return;
    if (!best || d < best.d) best = { d, e };
  });

  return {
    corrected: best ? best.e.text : null,
    reason: best ? 'typo' : '',
    alternatives: clean(nearest(pickable, qKey, limit).map(e => e.text))
  };
}

/**
 * 결과가 0건일 때 권할 검색어.
 * 한 글자라도 겹치는 것만 고른다 — 아무 관계 없는 인기검색어를 들이미는 것은
 * 도움이 아니라 소음이다. 겹치는 게 없으면 빈 배열을 돌려주고, 호출부가
 * 인기 검색어로 대신 채운다.
 */
/*
 * 포함 관계가 아닌데 "닮았다" 고 인정할 자모 유사도 하한.
 *
 * 0.5 였다. 그 문턱은 너무 낮아서 관계없는 말이 통과했다 —
 * 2026-08-22 운영 실측:
 *   "아이폰" vs "텀블러"     0.000  (당연히 탈락)
 *   "아이폰" vs "안녕하세요"  0.250  (탈락)
 *   "아이폰" vs "앙 기모찌"   0.556  ← 0.5 를 넘어 통과했다
 *   "텀블르" vs "텀블러"     0.875  ← 반드시 살려야 하는 진짜 오타
 *
 * 0.7 은 그 사이를 넉넉히 가른다. 진짜 오타(0.875)와 남남(0.556) 사이에
 * 양쪽으로 여유가 있다. 부분 포함("무선 이어폰 케이스" → "무선 이어폰")은
 * 이 경로를 타지 않으므로 영향을 받지 않는다.
 */
const MIN_SUGGEST_SIMILARITY = 0.7;

function nearest(entries, qKey, limit) {
  const qJamo = toJamo(qKey);
  const scored = [];

  entries.forEach(e => {
    if (e.key === qKey) return;
    // 부분 포함이 가장 강한 신호다 ("아이패드 11프로 케이스 검정" → "아이패드 11프로 케이스")
    let s = 0;
    if (e.key.indexOf(qKey) > -1 || qKey.indexOf(e.key) > -1) s = 100 - Math.abs(e.key.length - qKey.length);
    else {
      const d = editDistance(qJamo, e.jamo);
      const max = Math.max(qJamo.length, e.jamo.length) || 1;
      const sim = 1 - d / max;
      if (sim >= MIN_SUGGEST_SIMILARITY) s = Math.round(sim * 50);
    }
    if (s > 0) scored.push({ e, s });
  });

  return scored.sort((a, b) => b.s - a.s).slice(0, limit).map(x => x.e);
}

module.exports = {
  normalizeText, canonicalKey, splitTokens, analyzeQuery, analyzeTitle,
  scoreTitle, rankItems, dedupeItems, sortByRelevance, isRelevant,
  // 핵심 명사 정렬 — test-search.js 가 단일 토큰 회귀를 여기로 고정한다.
  productFocus, coreTokens, ACCESSORY_TIER,
  toJamo, editDistance, fromKeyboardLayout, suggestKeywords, isValidSuggestion,
  mallNameOf, mallRank, MALL_ORDER, MALL_BONUS_MAX,
  MIN_SCORE, KIND, COMMON_WORDS, MIN_SUGGEST_SIMILARITY
};
