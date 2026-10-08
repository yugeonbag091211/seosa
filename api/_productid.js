'use strict';
/*
 * 상품 «정체성» 서명 — 질의와 상품명이 같은 모델을 가리키는가 (순수 함수).
 *
 * ── 왜 다시 만들었나 (2026-10-08 Codex 독립 레드팀) ─────────────
 *
 * PR #128 1차는 «모델코드 바로 뒤의 1~2글자 영문 = 모델 꼬리말» 이라는 자리
 * 규칙이었다. 독립 레드팀이 양쪽으로 깼다.
 *
 *   거짓 양성  G304 BK · G304 WH · G304 K/DA  ← 색상·한정판 표기를 다른 모델로 봤다
 *   거짓 음성  Buds3 ↔ Buds3 Pro · AirPods Pro 2 ↔ 3 · iPhone 17 ↔ 17 Pro Max ·
 *             V15 ↔ V15 Detect · MX Master 3 ↔ 3S  (80건 중 70건을 같은 모델로 봤다)
 *
 * 글자 수는 의미가 아니다. «BK» 는 두 글자지만 색이고, «Detect» 는 여섯 글자지만
 * 모델이다. 그래서 상품명의 토큰을 «역할» 로 나눈다.
 *
 *   base       모델코드(G304·V15·S25·5070)와 제품군 낱말(에어팟·버즈·아이폰)
 *   generation 세대 숫자(Pro «3» · 버즈«3» · 아이폰 «17» · 3«세대»)
 *   variant    의미 있는 등급·판형(Pro·Max·Plus·Ultra·Mini·Air·SE·FE·Ti·X·
 *              Detect·Slim·OLED·Fold·Flip …, 그리고 «3S»·«16e» 의 붙은 꼬리)
 *   (무시)     색상·옵션 코드·SKU·용량·수량·마케팅 문구
 *
 * ★ 상품·브랜드 사전이 아니다. variant 목록은 업계가 공통으로 쓰는 등급어의
 *   닫힌 집합이고, 색상 목록도 마찬가지다. 특정 상품명을 통과시키는 예외는 없다.
 *
 * ── 언제 판정하는가 ─────────────────────────────────────────────
 *
 *   specific  질의에 모델코드나 세대 숫자가 있다("G304", "에어팟 프로 3", "아이폰 17").
 *             등급어·세대를 양방향으로 맞춘다.
 *   family    모델코드·세대는 없고 제품군 낱말만 있다("닌텐도 스위치").
 *             그 제품군 낱말 «바로 뒤» 에 등급어가 붙은 상품만 다르다고 본다
 *             ("스위치 OLED"). 범주 질의("미니 선풍기")에는 켜지 않는다 —
 *             거기서 «미니» 는 모델이 아니라 크기 형용사다.
 *
 * 어느 쪽이든 «증거» 가 있어야 랭킹에 쓴다(호출부가 본다): 이번 결과 안에
 * 질의와 같은 정체성을 가진 후보가 실제로 있어야 다른 것을 내린다.
 */

/* ── 정규화 ──────────────────────────────────────────────────── */

function normalize(s) {
  return String(s == null ? '' : s)
    .normalize('NFKC')
    .toLowerCase()
    // "S25+" 의 + 는 등급(Plus)이다. 지우기 전에 낱말로 바꾼다.
    .replace(/([0-9a-z가-힣])\+(?=\s|$|[^0-9a-z])/g, '$1 plus ')
    .replace(/[^0-9a-z가-힣\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 한글 덩어리 / 영문·숫자 덩어리로 끊는다 (_search.splitTokens 와 같은 규칙). */
function tokensOf(s) {
  const out = [];
  normalize(s).split(' ').forEach(chunk => {
    (chunk.match(/[가-힣]+|[0-9a-z]+/g) || []).forEach(p => {
      const compact = compactModelParts(p);
      if (compact) out.push(...compact);
      else out.push(p);
    });
  });
  return out;
}

/* Compact seller titles often omit spaces: iPhone17ProMax, Buds3Pro,
 * V15Detect. Split only when trailing letters form known model variants. */
function compactModelParts(token) {
  if (!isAscii(token)) return null;
  const m = token.match(/^([a-z]+?)(\d{1,2})([a-z]+)$/);
  if (!m) return null;
  const variants = [...VARIANT_EN.keys(), ...VARIANT_SUFFIX]
    .sort((a, b) => b.length - a.length);
  function splitVariants(rest) {
    if (!rest) return [];
    for (const variant of variants) {
      if (!rest.startsWith(variant)) continue;
      const tail = splitVariants(rest.slice(variant.length));
      if (tail) return [variant, ...tail];
    }
    return null;
  }
  const suffix = splitVariants(m[3]);
  return suffix && suffix.length ? [m[1], String(Number(m[2])), ...suffix] : null;
}

/* ── 역할 사전 ───────────────────────────────────────────────── */

/** 의미 있는 등급·판형어. 값은 정규형. */
const VARIANT_EN = new Map([
  ['pro', 'pro'], ['max', 'max'], ['plus', 'plus'], ['ultra', 'ultra'], ['mini', 'mini'],
  ['lite', 'lite'], ['air', 'air'], ['se', 'se'], ['fe', 'fe'], ['ti', 'ti'], ['xt', 'xt'],
  ['detect', 'detect'], ['absolute', 'absolute'], ['slim', 'slim'], ['oled', 'oled'],
  ['fold', 'fold'], ['flip', 'flip'], ['edge', 'edge'], ['neo', 'neo'], ['xl', 'xl']
]);
/** 한 글자 등급어 — 정체성을 가진 말 뒤에서만 등급이다(signature 주석). */
const VARIANT_SINGLE = new Set(['x', 's']);
/** 숫자에 붙은 꼬리 — "3S", "16e". 그 밖의 꼬리(5G 등)는 등급이 아니다. */
const VARIANT_SUFFIX = new Set(['s', 'e', 'x']);
const VARIANT_KO = new Map([
  ['프로', 'pro'], ['맥스', 'max'], ['플러스', 'plus'], ['울트라', 'ultra'], ['미니', 'mini'],
  ['라이트', 'lite'], ['에어', 'air'], ['엑스', 'x'], ['디텍트', 'detect'], ['앱솔루트', 'absolute'],
  ['슬림', 'slim'], ['올레드', 'oled'], ['폴드', 'fold'], ['플립', 'flip'], ['엣지', 'edge'], ['네오', 'neo']
]);

/**
 * 색상·마감 — 같은 상품의 옵션이다. 영문 약어 코드(BK·WH·BLK …)를 포함한다.
 * ★ 이 목록에 없는 짧은 영문 토큰도 등급어가 아니면 무시된다(K/DA 같은 한정판
 *   표기가 그렇다). 이 목록은 «제품군 낱말로 오인하지 않기» 위해 있다.
 */
const COLORS = new Set([
  'black', 'white', 'silver', 'gray', 'grey', 'blue', 'red', 'pink', 'green', 'gold', 'purple',
  'navy', 'beige', 'ivory', 'mint', 'yellow', 'orange', 'brown', 'graphite', 'midnight', 'starlight',
  'lilac', 'lavender', 'bk', 'blk', 'wh', 'wht', 'gy', 'gry', 'bl', 'rd', 'pk', 'gr', 'sv', 'gd', 'nv',
  '블랙', '화이트', '실버', '그레이', '블루', '레드', '핑크', '그린', '골드', '퍼플', '네이비', '베이지',
  '아이보리', '민트', '옐로우', '오렌지', '브라운', '그래파이트', '미드나이트', '스타라이트', '라일락',
  '라벤더', '검정', '검정색', '흰색', '하얀색', '은색', '회색', '파랑', '빨강', '분홍', '네온', '섀도우',
  '아이시블루', '티타늄', '내추럴', '데저트', '코랄', '스카이', '크림', '차콜'
]);

/** 수량·용량·단위 — 세대 숫자로 읽지 않는다(그 앞의 숫자도 함께). */
const UNIT_TOKEN_RE = /^(gb|tb|mb|mm|cm|m|kg|g|ml|l|w|v|mah|hz|원|만원|천원|억원|만|천|억|인치|형|개|팩|매|입|장|세트|구|병|캔|ea|pcs|pc|set|p|in|k|대|개월|일|년|시간|분|미터)$/;
const ATTACHED_UNIT_RE = /^\d+(?:gb|tb|mb|mm|cm|m|kg|g|ml|l|w|v|mah|hz|ea|pcs|pc|set|p|k)$/;
const YEAR_RE = /^(?:19|20)\d{2}$/;

/** 그 자체로는 정체성을 정하지 않는 말 — 범주·수식·판매 문구. */
const GENERIC = new Set([
  '무선', '유선', '블루투스', '게이밍', '정품', '국내정품', '병행', '해외', '공식', '신형', '신품', '새상품',
  '자급제', '공기계', '본체', '본품', '단품', '세트', '에디션', '디지털', '디스크', '케이스', '커버',
  '이어폰', '헤드폰', '헤드셋', '마우스', '키보드', '노트북', '태블릿', '스마트폰', '휴대폰', '청소기',
  '그래픽카드', '모니터', '스피커', '충전기', '스마트워치', '워치', '시계', '게임기', '콘솔',
  '무선청소기', '블루투스이어폰', '무선이어폰', '노이즈캔슬링', '노캔', '고속충전', '세대',
  'usb', 'c', 'type', 'wireless', 'bluetooth', 'gaming', 'mouse', 'earbuds', 'earphones',
  'headphones', 'headset', 'vacuum', 'laptop', 'tablet', 'smartphone', 'phone', 'edition',
  'digital', 'disc', 'case', 'cover', 'genuine', 'official', 'new', 'for', 'with', 'the', 'and',
  'lightspeed', 'superlight', '슈퍼라이트', 'hero', 'oc', 'version', '버전', '모델', '제품', '상품', '가격', '최저가',
  '기본', '기본형', '일반', '일반형', '스탠다드', 'standard', 'only', '만', '국내', '정식', '발매',
  '추천', '구매', '판매', '특가', '할인', '쿠팡', '로켓배송', '무료배송', '당일발송'
]);

/* ── 토큰 → 역할 ─────────────────────────────────────────────── */

/**
 * 한글 토큰의 끝이 등급어면 앞을 제품군으로 나눈다 ("에어팟프로" → 에어팟 + pro).
 * 앞부분이 두 글자 이상 남을 때만 — "아프로" 같은 우연을 막는다.
 */
function splitKoreanVariantSuffix(tok) {
  for (const [ko] of VARIANT_KO) {
    if (tok.length > ko.length + 1 && tok.endsWith(ko)) {
      const family = tok.slice(0, tok.length - ko.length);
      const more = koreanVariants(tok.slice(family.length));
      if (more.length) return { family, variants: more };
    }
  }
  return null;
}

/** 한글 토큰을 등급어만으로 끝까지 나눌 수 있으면 그 등급들("프로맥스" → pro,max). */
function koreanVariants(tok) {
  const out = [];
  let rest = tok;
  outer:
  while (rest) {
    for (const [ko, norm] of VARIANT_KO) {
      if (rest.startsWith(ko)) { out.push(norm); rest = rest.slice(ko.length); continue outer; }
    }
    return [];
  }
  return out;
}

const isAscii = t => /^[0-9a-z]+$/.test(t);
const isNumber = t => /^\d+$/.test(t);
/** 모델코드 — 영문과 숫자가 섞인 3자 이상, 또는 연도가 아닌 3~4자리 숫자(5070·4060). */
function isModelCode(t) {
  if (!isAscii(t) || ATTACHED_UNIT_RE.test(t)) return false;
  if (/[a-z]/.test(t) && /\d/.test(t)) return t.length >= 3 && !/^\d{1,2}[a-z]{1,2}$/.test(t);
  return /^\d{3,4}$/.test(t) && !YEAR_RE.test(t);
}

/**
 * 문자열 하나의 정체성 서명.
 *
 * @returns {{tokens:string[], roles:Array<{tok,role,value}>, codes:Set, family:string[]}}
 *   role ∈ code | family | variant | gen | color | unit | generic | other
 */
function signature(text) {
  const tokens = tokensOf(text);
  const roles = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const prev = tokens[i - 1] || '';
    const next = tokens[i + 1] || '';
    let role = 'other', value = t;
    if (COLORS.has(t)) role = 'color';
    else if (ATTACHED_UNIT_RE.test(t) || UNIT_TOKEN_RE.test(t)) role = 'unit';
    else if (YEAR_RE.test(t)) role = 'unit';
    else if (/^(\d{1,2})([a-z]{1,2})$/.test(t)) {
      // "3s" · "16e" → 세대 + 붙은 꼬리. "5g" 같은 다른 꼬리는 세대만 남긴다.
      const m = t.match(/^(\d{1,2})([a-z]{1,2})$/);
      roles.push({ tok: t, at: i, role: 'gen', value: String(Number(m[1])) });
      /* A bare “2X/3X” is commonly a quantity/feature descriptor (e.g. GPU fans),
       * while identity-bearing “X” variants are written separately after the model code. */
      if (VARIANT_SUFFIX.has(m[2]) && m[2] !== 'x') roles.push({ tok: t, at: i, role: 'variant', value: m[2] });
      continue;
    } else if (isModelCode(t)) role = 'code';
    else if (isNumber(t) && t.length <= 2) {
      // 뒤에 단위가 붙으면 크기·수량이다("13 인치", "2 개").
      role = UNIT_TOKEN_RE.test(next) ? 'unit' : 'gen';
      value = String(Number(t));
    } else if (isNumber(t)) role = 'unit';                    // 5자리 이상 숫자 = SKU
    else if (VARIANT_EN.has(t)) { role = 'variant'; value = VARIANT_EN.get(t); }
    else if (VARIANT_SINGLE.has(t) && (/^[a-z]$/.test(next) || /^[a-z]$/.test(prev))) {
      // "S M L" · "M/L" — 사이즈 나열이다. 등급이 아니다.
      role = 'other';
    } else if (VARIANT_SINGLE.has(t)) {
      /*
       * 한 글자 등급어는 «정체성을 가진 말» 뒤에서만 등급이다 — "G304 X",
       * "Series S", "G304 슈퍼라이트 X". 첫 토큰이거나 범용어·색상·단위 뒤면
       * 그냥 글자다.
       */
      const last = roles[roles.length - 1];
      role = (prev && last && (['code', 'family', 'variant', 'gen', 'other'].includes(last.role)
        || (last.role === 'generic' && /^(?:superlight|슈퍼라이트)$/.test(last.tok)))
        && !(last.role === 'other' && !isAscii(prev))) ? 'variant' : 'other';
    } else if (GENERIC.has(t)) role = 'generic';
    else if (/^[가-힣]+$/.test(t) && koreanVariants(t).length) {
      koreanVariants(t).forEach(v => roles.push({ tok: t, at: i, role: 'variant', value: v }));
      continue;
    } else if (/^[가-힣]+$/.test(t) && splitKoreanVariantSuffix(t)) {
      /*
       * 붙여 쓴 «제품군 + 등급» — "에어팟프로3" 의 «에어팟프로». 나누지 않으면
       * 질의의 제품군 낱말이 «에어팟프로» 가 되어 어느 상품명과도 맞지 않고,
       * 제품군 판정이 통째로 꺼진다(실측: 이 꼴에서만 다른 제품군이 상위 3 에 남았다).
       */
      const sp = splitKoreanVariantSuffix(t);
      roles.push({ tok: t, at: i, role: 'family', value: sp.family });
      sp.variants.forEach(v => roles.push({ tok: t, at: i, role: 'variant', value: v }));
      continue;
    } else if (accessoryRoles(t).size) role = 'accessory';     // 이어팁·키링… 은 제품군이 아니다
    else if (t.length === 1) role = 'other';                  // 한 글자 조각(K/DA 의 k 등)
    else if (/^[a-z]{1,2}$/.test(t)) role = 'other';          // 짧은 옵션 코드
    else role = 'family';
    roles.push({ tok: t, at: i, role, value });
  }
  const codes = new Set(roles.filter(r => r.role === 'code').map(r => r.value));
  const family = roles.filter(r => r.role === 'family').map(r => r.value);
  return { tokens, roles, codes, family };
}

/* ── 동의어(한/영 표기) ─────────────────────────────────────── */

/*
 * 제품군 낱말의 한/영 표기. _search.SYNONYM_GROUPS 와 같은 성격의 표기 차이
 * 목록이다(그 표에 이미 맥북/macbook · 그램/gram 이 있다).
 */
const FAMILY_SYNONYMS = [
  ['에어팟', 'airpods'], ['버즈', 'buds'], ['갤럭시', 'galaxy'], ['아이폰', 'iphone'],
  ['아이패드', 'ipad'], ['맥북', 'macbook'], ['애플워치', 'applewatch'], ['다이슨', 'dyson'],
  ['로지텍', 'logitech'], ['마스터', 'master'], ['스위치', 'switch'], ['닌텐도', 'nintendo'],
  ['애플', 'apple'], ['삼성', 'samsung'], ['소니', 'sony'], ['픽셀', 'pixel'], ['구글', 'google'],
  ['플레이스테이션', 'playstation'], ['엑스박스', 'xbox'], ['지포스', 'geforce'], ['북', 'book'],
  ['탭', 'tab'], ['워치', 'watch']
];
const SYN = new Map();
FAMILY_SYNONYMS.forEach(g => g.forEach(w => SYN.set(w, new Set(g))));
const forms = w => SYN.get(w) || new Set([w]);

function tokenIndex(tokens, word) {
  const want = forms(word);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    for (const f of want) {
      if (t === f) return i;
      // 붙여 쓴 꼴("에어팟프로") — 앞부분이 그 낱말로 시작한다.
      if (f.length >= 2 && t.length > f.length && t.startsWith(f)) return i;
      // 질의 쪽이 붙여 쓴 꼴("갤럭시버즈") — 상품명 토큰이 그 앞부분이다.
      if (/^[가-힣]+$/.test(f) && t.length >= 3 && f.length > t.length && f.startsWith(t)) return i;
    }
  }
  return -1;
}

/* ── 질의 정체성 ─────────────────────────────────────────────── */

/**
 * 질의의 정체성.
 *
 * @returns {{mode:'specific'|'family'|'none', codes:Set, family:string[],
 *            variants:Set, gens:Set, head:string}}
 */
function queryIdentity(query) {
  const sig = signature(query);
  const variants = new Set(sig.roles.filter(r => r.role === 'variant').map(r => r.value));
  const gens = new Set(sig.roles.filter(r => r.role === 'gen').map(r => r.value));
  /*
   * 대표 제품군 낱말 — 세대·등급 바로 앞의 제품군 낱말이 가장 구체적이다
   * ("갤럭시 버즈3" 의 «버즈», "애플 에어팟 프로 3" 의 «에어팟»). 없으면 마지막 것.
   */
  let head = '';
  for (let i = 0; i < sig.roles.length; i++) {
    const r = sig.roles[i];
    if (r.role === 'family') head = r.value;
    if ((r.role === 'gen' || r.role === 'variant') && head) break;
  }
  const mode = (sig.codes.size || gens.size) ? 'specific'
    : (sig.family.length ? 'family' : 'none');
  return { mode, codes: sig.codes, family: sig.family, variants, gens, head };
}

/* ── 상품명 ↔ 질의 ───────────────────────────────────────────── */

/**
 * 상품명에서 질의의 정체성이 놓인 구간을 찾아 그 안의 등급·세대를 읽는다.
 *
 * 구간 = 질의의 모델코드·제품군 낱말이 처음 닿은 자리 ~ 마지막으로 닿은 자리 + 3.
 * 그 밖의 숫자·낱말(용량·인치·판매 문구)은 이 상품의 정체성이 아니다.
 */
function titleWindow(qid, title) {
  const sig = signature(title);
  const hits = [];
  qid.codes.forEach(c => { const i = sig.tokens.indexOf(c); if (i > -1) hits.push(i); });
  qid.family.forEach(f => { const i = tokenIndex(sig.tokens, f); if (i > -1) hits.push(i); });
  if (!hits.length) return null;
  const lo = Math.min(...hits), hi = Math.max(...hits) + 3;
  const inWindow = sig.roles.filter(r => r.at >= lo && r.at <= hi);
  return {
    sig,
    variants: new Set(inWindow.filter(r => r.role === 'variant').map(r => r.value)),
    gens: new Set(inWindow.filter(r => r.role === 'gen').map(r => r.value)),
    lo, hi
  };
}

const setEq = (a, b) => a.size === b.size && [...a].every(x => b.has(x));

/**
 * 이 상품명이 질의가 가리킨 그 모델인가.
 *
 * @returns {{relation:'same'|'different'|'unknown', reason:string}}
 */
function relation(qid, title) {
  if (!qid || qid.mode === 'none') return { relation: 'unknown', reason: '' };
  const w = titleWindow(qid, title);
  if (!w) return { relation: 'unknown', reason: 'no-anchor' };

  // 질의의 모델코드는 전부 있어야 한다(없으면 다른 모델 — 제품군 판정이 따로 본다).
  for (const c of qid.codes) {
    if (!w.sig.codes.has(c)) return { relation: 'different', reason: `code:${c}` };
  }

  if (qid.mode === 'specific') {
    if (!setEq(qid.variants, w.variants)) {
      return { relation: 'different', reason: `variant:[${[...w.variants]}]≠[${[...qid.variants]}]` };
    }
    if (qid.gens.size) {
      if (!w.gens.size) return { relation: 'different', reason: 'gen-missing' };
      if (![...qid.gens].some(g => w.gens.has(g))) {
        return { relation: 'different', reason: `gen:[${[...w.gens]}]≠[${[...qid.gens]}]` };
      }
    }
    return { relation: 'same', reason: '' };
  }

  /*
   * family — 제품군 낱말 바로 뒤에 붙은 등급어만 «더 붙은 것» 으로 본다(머리 주석).
   * 반대로 질의가 등급을 말했는데("버즈 FE", "스위치 OLED") 상품명 구간에 그
   * 등급이 없으면 다른 모델이다.
   */
  const at = qid.head ? tokenIndex(w.sig.tokens, qid.head) : -1;
  if (at < 0) return { relation: 'unknown', reason: 'no-head' };
  const missing = [...qid.variants].filter(v => !w.variants.has(v));
  if (missing.length) return { relation: 'different', reason: `variant-missing:${missing[0]}` };
  const after = w.sig.roles.filter(r => r.at === at + 1);
  const extra = after.filter(r => r.role === 'variant' && !qid.variants.has(r.value));
  if (extra.length) return { relation: 'different', reason: `variant-after-head:${extra[0].value}` };
  return { relation: 'same', reason: '' };
}

/**
 * 제품군이 아예 다른 상품인가 — «AirPods Pro 3» 질의의 «Galaxy Buds3 Pro».
 *
 * specific/family 질의에서만 판정한다. 질의에 모델코드가 있으면 그 코드가,
 * 없으면 대표 제품군 낱말(head)이 상품명에 있어야 같은 제품군이다.
 */
function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

function familyMismatch(qid, title) {
  if (!qid || qid.mode === 'none') return false;
  const sig = signature(title);
  if (qid.codes.size) {
    if ([...qid.codes].some(c => sig.codes.has(c))) return false;
    const familyMatch = qid.family.some(wanted => {
      const accepted = forms(wanted);
      if (sig.family.some(candidate => [...accepted].some(form => form === candidate
          || (form.length >= 3 && candidate.length >= 3 && levenshtein(form, candidate) <= 1)))) return true;
      return sig.tokens.some(candidate => [...accepted].some(form => form.length >= 3 && candidate.includes(form)));
    });
    if (familyMatch) return false;
    /* Preserve nearby model identifiers for boundary ranking (ABC-120 vs
     * ABC-1200, SL-X4300LX vs SL-X4300LXX); exact model matching still ranks
     * them separately. Completely unrelated model families remain excluded. */
    const nearbyCode = [...qid.codes].some(wanted => [...sig.codes].some(candidate =>
      Math.min(wanted.length, candidate.length) >= 5 && levenshtein(wanted, candidate) <= 1));
    return !nearbyCode;
  }
  if (!qid.head) return false;
  if (tokenIndex(sig.tokens, qid.head) >= 0) return false;
  /* A near-spelling in a seller title is weak evidence, not a proven new family. */
  const familyDistance = (a, b) => {
    if (Math.abs(a.length - b.length) > 1) return 2;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      for (let j = 1; j <= b.length; j++) {
        row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = row;
    }
    return prev[b.length];
  };
  const wanted = [...forms(qid.head)];
  if (sig.family.some(candidate => wanted.some(form => form.length >= 3
      && candidate.length >= 3 && familyDistance(form, candidate) <= 1))) return false;
  return true;
}

/* ── 비교 요청 ───────────────────────────────────────────────── */

/**
 * 두 상품을 견주어 달라는 말인가. 그때는 다른 제품군 후보가 «필요하다».
 */
const COMPARISON_RE = /비교|(?:^|\s)vs\.?(?:\s|$)|versus|차이(?:점)?|어느\s*(?:게|쪽|것|거)|뭐가\s*(?:더\s*)?(?:나아|좋아|낫)|중에\s*(?:뭐|어떤|어느)|중\s*(?:뭐|어떤|어느)|compare/i;
function isComparisonRequest(text) {
  return COMPARISON_RE.test(String(text || ''));
}

/* ── 액세서리 유형 ───────────────────────────────────────────── */

/*
 * 부속의 «종류». 부속이냐 아니냐만 보면 «충전 케이스» 요구에 보호 커버가,
 * «이어팁» 요구에 키링이 1위로 왔다(레드팀 50건 중 23건).
 *
 * 순서가 뜻이다 — 위에서 먼저 잡힌 구절은 지우고 아래를 본다. 그래야
 * «충전 케이스» 가 일반 «케이스»(보호 케이스)로 한 번 더 잡히지 않는다.
 */
const ROLE_RULES = [
  ['charging_case', /충전\s*케이스|무선\s*충전\s*케이스|charging\s*case|충전\s*크래들/g],
  ['ear_tips', /이어\s*팁|폼\s*팁|실리콘\s*팁|ear\s*tips?|eartips?/g],
  ['strap', /넥\s*스트랩|스트랩|랜야드|목걸이\s*줄|분실\s*방지\s*(?:끈|줄)|\bstrap\b|\blanyard\b/g],
  ['keyring', /키링|카라비너|열쇠\s*고리|\bkeyring\b|\bcarabiner\b/g],
  ['stand', /충전\s*거치대|거치대|스탠드|받침대|\bstand\b|\bholder\b/g],
  ['adapter', /충전\s*어댑터|어댑터|충전기|\badapter\b|\bcharger\b|젠더/g],
  ['cable', /충전\s*케이블|케이블|\bcable\b/g],
  ['film', /보호\s*필름|강화\s*유리|필름|\bfilm\b/g],
  ['pad', /마우스\s*패드|이어\s*패드|(?<![가-힣])패드(?![가-힣])|(?<![a-z0-9가-힣])pad(?![a-z0-9가-힣])/g],
  ['cover', /커버|스킨|\bcover\b|\bskin\b/g],
  ['protective_case', /(?:보호|실리콘|하드|가죽|투명|젤리|범퍼|소프트)?\s*케이스|protective\s*case|silicone\s*case|\bcase\b/g]
];

/** @returns {Set<string>} 이 문자열이 가리키는 부속 종류 */
function accessoryRoles(text) {
  let s = String(text == null ? '' : text).normalize('NFKC').toLowerCase();
  const out = new Set();
  ROLE_RULES.forEach(([role, re]) => {
    re.lastIndex = 0;
    if (re.test(s)) {
      out.add(role);
      re.lastIndex = 0;
      s = s.replace(re, ' ');
    }
  });
  return out;
}

/** Remove a named accessory when the same phrase is explicitly negated. */
function stripNegatedAccessoryTerms(text) {
  const s = String(text == null ? '' : text);
  if (!s) return s;
  const suffixRe = /^\s*(?:(?:은|는|이|가|을|를|도|만)\s*)?(?:(?:단품|상품|제품|모델)\s*)?(?:아니고|아니라|아닌|아님|아니야|말고|제외하고|제외한|제외해|제외|빼고|빼줘|빼라|not\b|without\b|except\b|excluding\b)/i;
  const cuts = [];
  ROLE_RULES.forEach(([, sourceRe]) => {
    const re = new RegExp(sourceRe.source, sourceRe.flags.includes('i') ? sourceRe.flags : `${sourceRe.flags}i`);
    let m;
    while ((m = re.exec(s)) !== null) {
      const end = m.index + m[0].length;
      const suffix = suffixRe.exec(s.slice(end));
      if (suffix) cuts.push({ start: m.index, end: end + suffix[0].length });
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  });
  if (!cuts.length) return s;
  cuts.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  cuts.forEach(cut => {
    const last = merged[merged.length - 1];
    if (last && cut.start <= last.end) last.end = Math.max(last.end, cut.end);
    else merged.push({ start: cut.start, end: cut.end });
  });
  let out = s;
  merged.reverse().forEach(cut => { out = `${out.slice(0, cut.start)} ${out.slice(cut.end)}`; });
  return out.replace(/\s+/g, ' ').trim();
}

module.exports = {
  normalize, tokensOf, signature, queryIdentity, relation, familyMismatch,
  isComparisonRequest, accessoryRoles, stripNegatedAccessoryTerms, koreanVariants
};
