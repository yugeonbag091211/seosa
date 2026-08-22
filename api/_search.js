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
function sortByRelevance(items) {
  return (items || []).slice().sort((a, b) => {
    const ra = (a && a.relevance) || 0;
    const rb = (b && b.relevance) || 0;
    if (ra !== rb) return rb - ra;

    const ta = (a && a.trust && Number(a.trust.score)) || 0;
    const tb = (b && b.trust && Number(b.trust.score)) || 0;
    if (ta !== tb) return tb - ta;

    const pa = Number(a && a.lprice) || Infinity;
    const pb = Number(b && b.lprice) || Infinity;
    return pa - pb;
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
    if (it) { it.relevance = r.score; }
    return { it, r };
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

  /* 1) 자판 오타 — "dkdlvhs" 처럼 아예 영문으로 친 경우 */
  const layout = fromKeyboardLayout(keyword);
  if (layout) {
    const hit = entries.find(e => e.key === canonicalKey(layout));
    return {
      corrected: hit ? hit.text : layout,
      reason: 'layout',
      alternatives: nearest(entries, canonicalKey(layout), limit).map(e => e.text)
    };
  }

  /* 2) 띄어쓰기만 다른 경우 — 오타가 아니라 표기 차이다 */
  const spacing = entries.find(e => e.key === qKey && e.norm !== q);
  if (spacing) {
    return { corrected: spacing.text, reason: 'spacing', alternatives: [] };
  }

  /*
   * 3) 사전에 그대로 있으면 보정할 것이 없다.
   *    단 대체 검색어는 계속 준다 — 결과가 0건이라 여기까지 왔다면
   *    "그 말이 사전에 있다"는 사실만으로 사용자를 빈손으로 보낼 이유가 없다.
   */
  if (entries.some(e => e.key === qKey)) {
    return { corrected: null, reason: '', alternatives: nearest(entries, qKey, limit).map(e => e.text) };
  }

  /* 4) 자모 편집거리 */
  const qJamo = toJamo(qKey);
  let best = null;
  entries.forEach(e => {
    // 길이가 크게 다르면 오타가 아니라 다른 말이다
    if (Math.abs(e.jamo.length - qJamo.length) > 3) return;
    const d = editDistance(qJamo, e.jamo);
    if (d === 0 || d > allowedDistance(Math.max(qJamo.length, e.jamo.length))) return;
    if (!best || d < best.d) best = { d, e };
  });

  return {
    corrected: best ? best.e.text : null,
    reason: best ? 'typo' : '',
    alternatives: nearest(entries, qKey, limit).map(e => e.text)
  };
}

/**
 * 결과가 0건일 때 권할 검색어.
 * 한 글자라도 겹치는 것만 고른다 — 아무 관계 없는 인기검색어를 들이미는 것은
 * 도움이 아니라 소음이다. 겹치는 게 없으면 빈 배열을 돌려주고, 호출부가
 * 인기 검색어로 대신 채운다.
 */
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
      if (sim >= 0.5) s = Math.round(sim * 50);
    }
    if (s > 0) scored.push({ e, s });
  });

  return scored.sort((a, b) => b.s - a.s).slice(0, limit).map(x => x.e);
}

module.exports = {
  normalizeText, canonicalKey, splitTokens, analyzeQuery, analyzeTitle,
  scoreTitle, rankItems, dedupeItems, sortByRelevance, isRelevant,
  toJamo, editDistance, fromKeyboardLayout, suggestKeywords,
  MIN_SCORE, KIND, COMMON_WORDS
};
