/*
 * 사용자 피드백 해석 — "이거 별로야"를 실제 재계산으로 잇는다.
 *
 * ── 왜 필요한가 ─────────────────────────────────────────────────
 *
 * 지금까지 사용자가 추천을 거부하면 할 수 있는 것이 없었다.
 *
 *   "이거 너무 무거운데"  → 같은 목록을 다시 보여 준다
 *   "삼성은 빼줘"         → 삼성이 계속 1위로 나온다
 *
 * 사용자는 방금 가장 값진 정보를 준 것이다. 무엇이 문제인지 직접 말했다.
 * 그것을 버리면 대화가 앞으로 나아가지 않는다.
 *
 * 이 모듈은 거부의 "이유"를 읽어서
 *   ① 성향 가중치를 움직이거나 (무겁다 → 휴대성 중시)
 *   ② 특정 후보를 빼거나       (이거 말고 다른 거)
 *   ③ 제외 조건을 세운다        (삼성은 빼줘)
 * 로 잇는다.
 *
 * ── 지켜야 할 선 ────────────────────────────────────────────────
 *
 * ★ 사용자가 말한 것만 반영한다. "무겁다"는 말에서 "이 사람은 늘 가벼운
 *   것을 좋아한다"를 추론하지 않는다. 이번 대화의 조건일 뿐이다.
 * ★ 모든 신호에 근거(사용자가 실제로 쓴 문자열)를 남긴다.
 * ★ 추론(inferred)은 명시(explicit)와 같은 무게를 갖지 않는다.
 * ★ 제외는 하드 조건이 아니라 강한 감점이다 — 사용자가 "절대"라고 하지
 *   않았는데 후보를 지우면, 다른 조건을 다 만족하는 상품이 사라진다.
 * ★ 결정적이다.
 */

const { iga, eunn, eulr } = require('./_specs');

/*
 * 거부 신호.
 *
 * "별로"만으로는 무엇이 별로인지 알 수 없다. 이유가 붙은 표현을 우선
 * 잡고, 이유 없는 거부는 따로 다룬다(후보 제외).
 */
const REJECT_RE = /별로|싫|아니|말고|다른\s*(거|걸|것|상품)|맘에\s*안|마음에\s*안|안\s*(좋|맞|끌)|그닥|글쎄/;

/*
 * 무엇이 불만인가 — 차원별 신호.
 *
 * [불만 종류, 성향 차원, 방향, 정규식]
 *   방향 +1 = 그 차원을 더 중요하게 본다는 뜻
 *
 * ★ "너무 비싸" 는 가격을 더 중요하게 본다는 뜻이지 "가격이 나쁘다"가
 *   아니다. 불만의 방향을 성향으로 옮길 때 부호를 틀리면 정반대로 간다.
 */
const REASONS = [
  ['PRICE',       'price',       +1, /너무\s*비싸|비싸(다|네|요|서|고)|가격이?\s*(너무|좀)?\s*(높|세|부담)|돈이?\s*아까|가성비\s*(안|별로)/],
  ['PRICE',       'price',       -1, /너무\s*싸|싸구려|싼\s*티|저렴한\s*게\s*(불안|걱정)/],
  ['WEIGHT',      'portability', +1, /무거[운웠워울요]|무겁|무게가?\s*(좀|너무)?\s*(나가|있)|들고\s*다니기\s*(힘|불편)/],
  ['PERFORMANCE', 'performance', +1, /성능이?\s*(좀|너무)?\s*(약|낮|부족|아쉬)|느리|버벅|사양이?\s*(낮|부족)|스펙이?\s*(낮|부족|아쉬)/],
  ['QUALITY',     'quality',     +1, /품질이?\s*(안|별로|나쁘|떨어)|금방\s*(고장|망가)|내구성?이?\s*(약|부족)|오래\s*못\s*(쓸|써)/],
  ['DESIGN',      'design',      +1, /디자인이?\s*(별로|안|구리|촌스)|생김새|못생|예쁘지\s*않/],
  ['SIZE',        'portability', +1, /너무\s*크|커서\s*(불편|부담)|사이즈가?\s*(안|너무)/],
  ['FEATURE',     '',            +1, /기능이?\s*(부족|없|아쉬)|이\s*기능은?\s*(없|안)/],
  ['BRAND',       'brand',       +1, /브랜드가?\s*(별로|싫|안)|이\s*브랜드는?\s*(싫|별로)/],
  /*
   * 배송 — 사람은 "배송이 느려"라고 붙여 말하지 않는다. "배송이 너무 느려"
   * 처럼 부사가 끼고, 어미도 활용된다(느리/느려/늦어). 둘 다 넘긴다.
   */
  ['DELIVERY',    '',            +1, /배송이?\s*(너무|좀|많이|엄청|진짜)?\s*(느리|느려|오래|늦)|배송비가?\s*(너무|좀)?\s*(비싸|부담)/]
];

/*
 * 제외 지시 — "X는 빼줘".
 *
 * 브랜드 이름은 목록으로 알아보지 않는다(목록에 없는 브랜드를 영원히 못
 * 알아보게 되므로). "빼줘/제외/말고" 앞에 오는 낱말을 이름으로 본다.
 */
const EXCLUDE_RE = /([가-힣A-Za-z0-9]{2,20})\s*(?:절대|무조건|아예|전부|다|좀|이제)?\s*(?:빼|제외|말고|싫어|안\s*볼래|보지\s*마)/;

/*
 * 잡아낸 이름에서 조사를 떼고, 이름이 아닌 말을 걸러낸다.
 *
 * ── 실측으로 잡은 두 가지 오류 ─────────────────────────────────
 *
 *   "삼성은 빼줘"      → "삼성은"  (조사가 붙어 상품명 대조가 어긋난다)
 *   "삼성 절대 빼줘"    → "절대"    (부사를 브랜드로 잡았다)
 *
 * 조사는 뒤에서 떼고, 부사·지시어는 이름으로 인정하지 않는다.
 * 브랜드 사전을 만들지는 않는다 — 목록에 없는 브랜드를 영영 못 알아보게 된다.
 */
const JOSA_RE = /(은|는|이|가|을|를|도|만|의)$/;
const NOT_A_NAME = new Set([
  '절대', '무조건', '아예', '전부', '이제', '그냥', '너무', '조금', '진짜', '정말',
  '이거', '그거', '저거', '이것', '그것', '저것', '이건', '그건', '다른', '거는'
]);

function cleanExcludeName(raw) {
  let s = String(raw || '').trim();
  // 조사는 한 번만 뗀다 — "삼성은" → "삼성". 두 번 떼면 "가방" 이 "가" 가 된다.
  if (s.length > 2 && JOSA_RE.test(s)) s = s.replace(JOSA_RE, '');
  if (s.length < 2) return '';
  if (NOT_A_NAME.has(s)) return '';
  return s;
}

/** 제외를 강한 감점으로 다룰지, 아예 지울지 가르는 말 */
const HARD_EXCLUDE_RE = /절대|무조건|아예|전부\s*빼/;

/*
 * ── 부정·제외 구문 (2026-10-08 운영 soak) ──────────────────────
 *
 * EXCLUDE_RE 는 «빼/제외/말고» 바로 앞의 낱말 하나만 본다. 그래서 두 가지가
 * 샜다. 둘 다 실측으로 재현했다.
 *
 *   1) «G304 X 말고 일반 G304»
 *      «X» 는 한 글자라 EXCLUDE_RE 의 {2,20} 에 걸리지 않는다 → 제외 없음.
 *      여러 토큰으로 된 모델 표기(«G304 X SUPERLIGHT 말고») 도 못 잡는다.
 *
 *   2) «에어팟 프로 3 본체만. 케이스 제외.»
 *      검색어 추출(_intent.extractQuery)이 «케이스» 를 그대로 남겨
 *      «에어팟 프로 3 본체만 케이스» 가 됐다. 그 검색어는 _search.analyzeQuery
 *      에서 ACCESSORY 의도로 읽혀 본품/액세서리 필터가 통째로 꺼졌고,
 *      4,900원짜리 보호 케이스가 후보 최상위로 올라왔다 — 사용자가 빼 달라고
 *      말한 바로 그것이다.
 *
 * 그래서 «무엇을 빼 달라고 했는가» 를 한 곳에서 읽고 두 곳이 함께 쓴다.
 *   · 검색어에서 그 말을 지운다 (_intent.extractQuery, api/ai.js cleanQuery)
 *   · 랭킹 제외로 넘긴다 (readFeedback → applyExcludes)
 *
 * 사전을 만들지 않는다. 부정 표지 «앞/뒤» 라는 자리로만 판정한다.
 */
/** 한국어: 제외 대상 + (조사) + 부정 표지. 이어지는 영문·숫자 토큰까지 한 덩어리로 본다. */
const NEGATION_MARKER = '(?:빼고|빼줘|빼라|빼|제외하고|제외한|제외해|제외|말고|아니고|아니라|아닌|아님|아니야|싫어|싫은|싫고|필요\\s*없|없는\\s*거)';
const NEGATED_TERM = '[가-힣A-Za-z0-9]+(?:\\s+(?:[A-Za-z0-9]+|모델|버전|버젼|타입|에디션|계열|사양)){0,2}';
const NEGATED_KO_RE = new RegExp(`(${NEGATED_TERM})\\s*(?:은|는|이|가|을|를|도|만)?\\s*(?:절대|무조건|아예|전부|다|좀|이제)?\\s*${NEGATION_MARKER}`, 'g');
/* Coordinated list immediately before one negation marker: X랑 Y랑 Z는 빼고. */
const NEGATED_COORD_KO_RE = new RegExp(
  `(${NEGATED_TERM}(?:\\s*(?:이랑|랑|하고|와|과|및|또는|나|,|/|&)\\s*${NEGATED_TERM})+)`
  + `\\s*(?:은|는|이|가|을|를|도|만)?\\s*(?:절대|무조건|아예|전부|다|좀|이제)?\\s*${NEGATION_MARKER}`, 'g');
const NEGATED_INCLUSION_RE = /([가-힣A-Za-z0-9]+)\s*(?:포함|들어간|들어있는|있는)\s*(?:은|는|이|가|을|를)?\s*(?:제외하고|제외|빼고|말고)/g;
const NEGATED_TRAILING_LIST_RE = /(?:빼줘|빼라|제외하고|제외해|빼고)\s*([가-힣A-Za-z0-9]+(?:\s*(?:이랑|랑|하고|와|과|및|또는|나|,|\/|&)\s*[가-힣A-Za-z0-9]+)+)/g;
/** 영어: 부정 표지 + (관사) + 제외 대상. */
const NEGATED_EN_RE = /\b(?:no|not|without|except|excluding|minus)\s+(?:the|a|an)?\s*([A-Za-z0-9]+(?:\s+[A-Za-z0-9]+){0,2})\b/gi;
/*
 * 영문 표기 + 일반 명사 꼴. "X 버전 아니고", "Ti 모델 말고".
 *
 * ★ 왜 따로 두는가 — 한국어는 낱말 경계가 없어서 부정 범위를 한글 토큰
 *   여러 개로 넓히면 상품 이름을 삼킨다("에어팟 프로 3 케이스 제외" 에서
 *   «프로 3 케이스» 를 지우게 된다). 그래서 넓히는 자리를 «영문·숫자 토큰
 *   하나 + 표기를 받는 일반 명사» 로만 열어 둔다. 그 일반 명사는 상품 이름이
 *   될 수 없는 말들이다.
 */
const QUALIFIER_NOUN = '(?:버전|버젼|타입|에디션|모델명?|라인업?|계열|사양)';
const NEGATED_QUALIFIED_RE = new RegExp(
  `([A-Za-z0-9]+)\\s*${QUALIFIER_NOUN}\\s*(?:은|는|이|가|을|를)?\\s*`
  + '(?:아니고|아닌|아님|아니야|말고|제외하고|제외한|제외해|제외|빼고|빼줘|빼)', 'g');

/*
 * ★ 부정 표지 앞의 말이 «지시어» 면 제외 대상이 아니다.
 *   "이거 말고 다른 거" 는 브랜드 «이거» 를 빼 달라는 말이 아니라 후보 거부다.
 *   cleanExcludeName 의 NOT_A_NAME 이 그 판단을 이미 갖고 있다.
 */
function negatedSpans(text) {
  const s = String(text == null ? '' : text);
  const out = [];
  const push = (term, start, whole) => {
    const clean = String(term || '').trim().replace(/(?:은|는|이|가|을|를|도|만)$/, '');
    if (clean) out.push({ term: clean, start, length: clean.length, whole });
  };
  [NEGATED_KO_RE, NEGATED_EN_RE, NEGATED_QUALIFIED_RE, NEGATED_INCLUSION_RE].forEach(re => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      const term = String(m[1] || '').trim();
      if (!term) continue;
      const rawStart = s.indexOf(term, m.index);
      push(term, rawStart, m[0]);
      if (re.lastIndex === m.index) re.lastIndex++;   // 빈 일치 보호
    }
  });
  NEGATED_COORD_KO_RE.lastIndex = 0;
  let list;
  while ((list = NEGATED_COORD_KO_RE.exec(s)) !== null) {
    const raw = String(list[1] || '');
    const rawStart = s.indexOf(raw, list.index);
    const splitRe = /\s*(?:이랑|랑|하고|와|과|및|또는|나|,|\/|&)\s*/g;
    let cursor = 0;
    let part;
    const pieces = [];
    while ((part = splitRe.exec(raw)) !== null) {
      pieces.push({ text: raw.slice(cursor, part.index), offset: cursor });
      cursor = part.index + part[0].length;
    }
    pieces.push({ text: raw.slice(cursor), offset: cursor });
    pieces.forEach((piece, index) => {
      let term = piece.text.trim().replace(/(?:은|는|이|가|을|를|도|만)$/, '').trim();
      const words = term.split(/\s+/).filter(Boolean);
      if (index === 0 && pieces.length > 1 && words.length > 1) {
        const last = words[words.length - 1];
        const before = words[words.length - 2];
        term = /^(?:모델|버전|버젼|타입|에디션|계열|사양)$/i.test(last)
          && /^[A-Za-z0-9]$/.test(before) ? `${before} ${last}` : last;
      }
      if (!term) return;
      const offset = piece.text.indexOf(term);
      push(term, rawStart + piece.offset + Math.max(0, offset), list[0]);
    });
    if (NEGATED_COORD_KO_RE.lastIndex === list.index) NEGATED_COORD_KO_RE.lastIndex++;
  }
  NEGATED_TRAILING_LIST_RE.lastIndex = 0;
  while ((list = NEGATED_TRAILING_LIST_RE.exec(s)) !== null) {
    const raw = String(list[1] || '');
    const rawStart = s.indexOf(raw, list.index);
    const splitRe = /\s*(?:이랑|랑|하고|와|과|및|또는|나|,|\/|&)\s*/g;
    let cursor = 0;
    let part;
    while ((part = splitRe.exec(raw)) !== null) {
      push(raw.slice(cursor, part.index).trim(), rawStart + cursor, list[0]);
      cursor = part.index + part[0].length;
    }
    push(raw.slice(cursor).trim(), rawStart + cursor, list[0]);
    if (NEGATED_TRAILING_LIST_RE.lastIndex === list.index) NEGATED_TRAILING_LIST_RE.lastIndex++;
  }
  return out;
}

/**
 * 사용자가 빼 달라고 한 말들.
 *
 * @returns {Array<{name:string, hard:boolean, evidence:string}>}
 */
function negatedTerms(text) {
  const s = String(text == null ? '' : text);
  const hard = HARD_EXCLUDE_RE.test(s);
  const seen = new Set();
  const out = [];
  negatedSpans(s).forEach(span => {
    const name = cleanExcludeName(span.term);
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, hard, evidence: span.whole.trim().slice(0, 30), source: 'explicit' });
  });
  return out;
}

/*
 * 검색어에서 지울 수 있는 제외 대상인가.
 *
 * ★ 랭킹 제외(negatedTerms)보다 느슨하다. 이유가 다르다.
 *   랭킹 제외는 «이 이름이 상품명에 들어 있으면 내린다» 이므로 한 글자
 *   이름을 받으면 아무 상품이나 걸린다(cleanExcludeName 이 2자 미만을 버리는
 *   이유다). 검색어에서 지우는 일은 그런 위험이 없고, 오히려 한 글자 모델
 *   표기를 반드시 지워야 한다 — «not the X» 의 «X» 가 검색어에 남으면
 *   _search 가 «사용자가 X 를 함께 말했다» 로 읽어 G304 X 를 정답으로 본다.
 */
const NEGATION_FUNCTION_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'is', 'are', 'it', 'this', 'that',
  'any', 'all', 'one', 'more', 'less', 'other', 'others', 'thanks', 'please'
]);

function strippableTerm(term) {
  const s = String(term || '').trim();
  if (!s || !/[0-9A-Za-z가-힣]/.test(s)) return false;
  if (NOT_A_NAME.has(s)) return false;
  const first = s.split(/\s+/)[0].toLowerCase();
  if (NEGATION_FUNCTION_WORDS.has(first)) return false;
  // 한 글자는 영문·숫자(모델 표기)일 때만 지운다. 한 글자 한글은 조사·어미일 수 있다.
  if (s.length === 1 && !/^[0-9A-Za-z]$/.test(s)) return false;
  return true;
}

/**
 * 검색어에서 제외 대상을 지운다.
 *
 * 부정 표지 자체는 남겨 둔다 — 호출부(_intent.extractQuery)의 STRIP_SET 이
 * 걷어내거나, 남아도 쿠팡 검색어에서 의미를 바꾸지 않는 말이다. 여기서
 * 반드시 지워야 하는 것은 «빼 달라고 한 그 물건 이름» 하나다.
 */
function stripNegatedTerms(text) {
  const s = String(text == null ? '' : text);
  if (!s) return s;
  let source = s;
  try { source = require('./_productid').stripNegatedAccessoryTerms(source); } catch (e) { /* optional shared identity parser */ }
  if (!source) return source;
  /*
   * ★ 문자열 치환이 아니라 «그 자리» 만 지운다.
   *   한국어에는 낱말 경계가 없어서 같은 글자를 전부 지우면 다른 낱말이 깨진다
   *   ("에어 제외하고 에어팟" 에서 "에어" 를 모두 지우면 "팟" 이 남는다).
   */
  const cuts = negatedSpans(source)
    .filter(span => span.start >= 0 && strippableTerm(span.term))
    .sort((a, b) => b.start - a.start);
  let out = source;
  let lastStart = out.length + 1;
  cuts.forEach(span => {
    const end = span.start + span.length;
    if (end > lastStart) return;                 // 앞서 지운 자리와 겹친다
    out = `${out.slice(0, span.start)} ${out.slice(end)}`;
    lastStart = span.start;
  });
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * 이번 발화가 거부인가, 그렇다면 무엇에 대한 거부인가.
 *
 * @param {string} text 사용자 발화
 * @returns {{isReject:boolean, reasons:Array, excludes:Array, evidence:string}}
 */
function readFeedback(text) {
  const s = String(text || '');
  const out = { isReject: false, reasons: [], excludes: [], evidence: '' };
  if (!s.trim()) return out;

  /* ── 이유가 붙은 불만 ── */
  REASONS.forEach(([kind, dim, dir, re]) => {
    const m = s.match(re);
    if (!m) return;
    out.reasons.push({
      kind, dim, dir,
      evidence: m[0].trim().slice(0, 24),
      source: 'explicit'          // 사용자가 직접 말한 불만이다
    });
  });

  /* ── 제외 지시 ── */
  {
    const m = s.match(EXCLUDE_RE);
    if (m) {
      /*
       * 조사를 떼고 부사·지시어를 걸러낸다 (cleanExcludeName 주석 참고).
       * "이거 말고" 처럼 지시대명사는 브랜드가 아니라 후보 거부다 —
       * 이름으로 잡으면 "이거"라는 브랜드를 상품명에서 찾게 된다.
       */
      const name = cleanExcludeName(m[1]);
      if (name) {
        out.excludes.push({
          name,
          hard: HARD_EXCLUDE_RE.test(s),
          evidence: m[0].trim().slice(0, 30),
          source: 'explicit'
        });
      }
    }
  }

  /*
   * 여러 토큰·한 글자 모델 표기까지 (negatedTerms 머리 주석).
   *
   * ★ EXCLUDE_RE 가 찾은 것을 먼저 넣고, 여기서 «빠진 것만» 덧붙인다.
   *   excludes[0] 이 바뀌면 기존 검사(eval-feedback.js [B])의 계약이 깨진다.
   */
  negatedTerms(s).forEach(e => {
    if (out.excludes.some(x => String(x.name).toLowerCase() === String(e.name).toLowerCase())) return;
    out.excludes.push(e);
  });

  /* ── 이유 없는 거부 ── */
  const rejected = REJECT_RE.test(s);
  out.isReject = rejected || out.reasons.length > 0 || out.excludes.length > 0;
  if (out.isReject) {
    const m = s.match(REJECT_RE);
    out.evidence = (m ? m[0] : (out.reasons[0] && out.reasons[0].evidence) || '').trim();
  }
  return out;
}

/*
 * 불만 한 번이 성향을 얼마나 움직이는가.
 *
 * 일반 선호 표현(_profile.STEP)보다 세게 잡는다 — 사용자가 추천을 보고
 * "이건 아니다"라고 말한 것은 그냥 취향을 말한 것보다 강한 신호다.
 * 다만 한 번에 뒤집히지는 않게 한다.
 */
const FEEDBACK_DELTA = 1.5;

/**
 * 피드백을 성향 신호로 바꾼다 (_profile.applySignals 가 먹는 형식).
 */
function toProfileSignals(fb) {
  const out = [];
  ((fb && fb.reasons) || []).forEach(r => {
    if (!r.dim) return;                 // 성향 축이 없는 불만(배송·기능)은 여기서 다루지 않는다
    out.push({
      dim: r.dim,
      delta: FEEDBACK_DELTA * r.dir,
      source: 'explicit',
      evidence: r.evidence
    });
  });
  return out;
}

/*
 * 제외 감점.
 *
 * ★ 후보를 목록에서 지우지 않는다.
 *   사용자가 "절대"라고 하지 않았는데 지우면, 다른 조건을 전부 만족하는
 *   상품이 통째로 사라진다. 강하게 내리되 남겨서, 필요하면 "제외하신
 *   브랜드지만 조건에는 이게 가장 맞는다"고 말할 수 있게 한다.
 *   "절대/무조건"이라고 말한 경우에만 하드 제외로 다룬다.
 */
const EXCLUDE_PENALTY = 60;

/**
 * 제외 조건을 상품에 적용한다 (랭킹 전에 부른다).
 *
 * @returns {Array} 하드 제외로 걸러낸 목록 (소프트는 감점 표시만 붙는다)
 */
function applyExcludes(items, excludes) {
  const list = (items || []).filter(Boolean);
  const ex = (excludes || []).filter(e => e && e.name);
  if (!ex.length) return list;

  const out = [];
  list.forEach(it => {
    const title = String(it.title || '').toLowerCase();
    const hit = ex.filter(e => title.includes(String(e.name).toLowerCase()));
    if (!hit.length) { out.push(it); return; }

    if (hit.some(e => e.hard)) return;          // "절대 빼" 는 목록에서 제거

    /*
     * 소프트 제외 — 강한 감점 + 사실 표시.
     *
     * ★ notes 에 직접 쓰지 않는다. rankItems 가 채점 뒤 it.notes 를
     *   통째로 갈아끼우기 때문에 여기서 넣으면 지워진다(실측으로 확인).
     *   이름만 남겨 두고, 랭킹이 notes 를 만든 뒤에 붙인다.
     */
    it._excludePenalty = EXCLUDE_PENALTY;
    it._excludeNames = hit.map(e => e.name);
    out.push(it);
  });
  return out;
}

/**
 * 프롬프트 블록. 피드백이 없으면 빈 문자열.
 *
 * ★ 무엇을 어떻게 반영했는지 밝힌다. 조용히 바꾸면 사용자는 자기 말이
 *   반영됐는지 알 수 없고, 같은 불만을 다시 말하게 된다.
 */
/*
 * 제외 지시는 말한 그 턴에만 살아 있으면 안 된다.
 *
 * 성향(무게·가격 같은 가중치)은 buildProfile 이 앞 대화를 통째로 읽어서 이어지는데,
 * 제외만 readFeedback(q) 로 이번 턴 문장에서만 뽑고 있었다. 그래서 3턴 전에
 * "삼성은 빼줘" 라고 해도 다음 턴이면 삼성이 다시 1위로 올라왔다. 사용자가 보기에는
 * 말을 안 들은 것이다.
 *
 * 이번 턴에서 뽑은 것은 explicit, 앞 대화에서 뽑은 것은 conversation 으로 남긴다.
 * 출처를 남겨야 나중에 "왜 뺐냐"는 물음에 근거를 댈 수 있고, 사용자가 말하지 않은
 * 것을 우리가 지어내지 않았음을 확인할 수 있다.
 *
 * 취소는 여기서 다루지 않는다 — "다시 보여줘" 같은 되돌리기 표현은 형태가 너무
 * 넓어서 잘못 잡으면 사용자가 뺐다고 한 것을 우리가 마음대로 되살리게 된다.
 * 확실히 지지 않는 쪽(제외를 유지)이 안전하다.
 *
 * @param {string} q       이번 턴 사용자 발화
 * @param {Array}  hist    [{role, text}] 앞 대화
 * @param {number} maxTurn 거슬러 볼 사용자 발화 수 (기본 6)
 * @returns {Array} [{name, hard, evidence, source, turnsAgo}]  최근 것이 앞
 */
function collectExcludes(q, hist, maxTurn) {
  const out = [];
  const seen = new Set();
  const push = (e, source, turnsAgo) => {
    const key = String(e.name).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: e.name, hard: e.hard, evidence: e.evidence, source, turnsAgo });
  };

  readFeedback(q).excludes.forEach(e => push(e, 'explicit', 0));

  const users = (hist || []).filter(h => h && h.role !== 'assistant' && h.text);
  const limit = Math.max(0, maxTurn == null ? 6 : maxTurn);
  /* slice(-0) 은 배열 전체다 — 0 이면 아무것도 보지 않는다는 뜻으로 명시해 자른다 */
  const recent = limit === 0 ? [] : users.slice(-limit);
  for (let i = recent.length - 1; i >= 0; i--) {
    readFeedback(recent[i].text).excludes.forEach(e => push(e, 'conversation', recent.length - i));
  }
  return out;
}

function feedbackBlock(fb, excludes) {
  const ex = (excludes && excludes.length) ? excludes : ((fb && fb.excludes) || []);
  if (!fb || (!fb.reasons.length && !ex.length && !fb.isReject)) return '';
  /* 이번 턴에 거부한 게 아니라 앞 대화의 제외만 이어지는 경우에는 머리말을 바꾼다 */
  const L = [fb.isReject
    ? '[사용자가 방금 거부했다 — 그 이유를 반영했다]'
    : '[앞 대화에서 사용자가 빼 달라고 한 것을 그대로 지키고 있다]'];

  fb.reasons.forEach(r => {
    L.push(`  · "${r.evidence}" → ${KIND_LABEL[r.kind] || r.kind} 문제로 읽고 순위를 다시 매겼다`);
  });
  ex.forEach(e => {
    L.push(e.hard
      ? `  · "${e.evidence}" → ${eulr(e.name)} 후보에서 완전히 제외했다`
      : `  · "${e.evidence}" → ${eulr(e.name)} 크게 내렸다(완전히 지우지는 않았다)`);
  });
  if (!fb.reasons.length && !ex.length) {
    L.push('  · 이유를 말하지 않은 거부다. 무엇이 마음에 들지 않았는지 한 가지만 짧게 물어라.');
  }

  L.push('- ★ 무엇을 반영했는지 답변에서 한 줄로 밝혀라. 조용히 바꾸면 사용자는 모른다.');
  L.push('- ★ 사용자가 말한 것만 반영했다. 말하지 않은 취향을 덧붙이지 마라.');
  L.push('- 제외한 상품을 다시 1위로 권하지 마라. 조건상 어쩔 수 없으면 그 사실을 밝힌다.');
  return L.join('\n');
}

const KIND_LABEL = {
  PRICE: '가격', WEIGHT: '무게', PERFORMANCE: '성능', QUALITY: '품질',
  DESIGN: '디자인', SIZE: '크기', FEATURE: '기능', BRAND: '브랜드', DELIVERY: '배송'
};

module.exports = {
  readFeedback, collectExcludes, toProfileSignals, applyExcludes, feedbackBlock,
  negatedTerms, stripNegatedTerms,
  REASONS, KIND_LABEL, FEEDBACK_DELTA, EXCLUDE_PENALTY
};
