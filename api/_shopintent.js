/*
 * 쇼핑 조건 해석 + 상품 랭킹.
 *
 * ── 왜 필요한가 ─────────────────────────────────────────────────
 *
 * 분류기는 검색어에서 조건을 일부러 뺀다("20만원 이하 노트북" → "노트북").
 * 값·용도를 검색어에 섞으면 쇼핑몰 결과가 0건이 되기 때문이다. 그 주석에는
 * "조건은 검색한 뒤에 따로 거른다"라고 적혀 있었는데, 거르는 코드가 없었다.
 *
 * 그래서 실제로 이런 일이 벌어졌다.
 *   사용자: "20만원 이하 노트북 추천해줘"
 *   → 검색어 "노트북" → 결과 6건(대부분 100만원대) → 모델에게 그대로 전달
 *   → 모델은 예산에 맞는 게 없다고 사과하거나, 억지로 하나를 고른다.
 *
 * 예산은 쇼핑에서 가장 강한 조건인데 그것을 아무도 쓰지 않았다.
 * 여기서 조건을 뽑고(parseConstraints), 그 조건으로 검색 결과를
 * 다시 줄 세운다(rankItems).
 *
 * ★ 상품을 지우지 않는다.
 *   예산을 넘는 상품도 목록에 남기고 "예산 초과"라고 표시만 한다. 조건에
 *   맞는 게 하나도 없을 때 빈 목록을 주면 모델은 할 말이 없어지고, 사용자는
 *   "왜 아무것도 안 나오지"만 남는다. 사실대로 보여주고 그 사실을 말하게 한다.
 *
 * ★ 점수를 사용자에게 말하지 않는다.
 *   점수는 순서를 정하는 내부 값이다. 프롬프트에는 순서와 "왜 그 순서인지"의
 *   근거가 되는 사실(예산 적합·30일 평균 대비·신뢰도)만 문장으로 들어간다.
 */

/*
 * _shop 은 지연 require 한다.
 *
 * 그 모듈은 쿠팡·ADPICK·Supabase 를 끌고 온다. 최상단에서 불러오면 그중
 * 하나가 환경변수 문제로 로드 중에 터졌을 때 이 파일을 쓰는 쪽(api/ai.js)이
 * 통째로 500 이 된다 — 검색이 필요 없는 잡담까지 같이 죽는다.
 * api/ai.js searchProducts 가 같은 이유로 같은 방식을 쓴다.
 */
// 조사 헬퍼 — _specs 는 순수 정규식 모듈이라 최상단 require 가 안전하다.
const { eunn } = require('./_specs');

let shopMod = null;
function shop() {
  if (shopMod === null) {
    try { shopMod = require('./_shop'); }
    catch (e) {
      console.warn(`[shopintent] _shop 로드 실패(상품명 대조 없이 진행): ${e.message}`);
      shopMod = false;
    }
  }
  return shopMod || null;
}

/* ==================================================================
 *  1) 조건 해석 — 사용자의 말에서 숫자와 취향을 꺼낸다
 * ================================================================== */

/** 만/천/억 단위. "20만원" → 200000 */
const UNIT = { 억: 100000000, 만: 10000, 천: 1000 };

/*
 * 금액 표현을 찾는다.
 *
 *   1) 단위가 붙은 것          20만원 / 20만 / 3천원 / 1억
 *      뒤에 작은 단위가 이어지는 것도 함께 본다 (15만 5천원)
 *   2) 단위 없이 '원'이 붙은 것  200000원 / 89,000원
 *
 * 단위도 '원'도 없는 맨숫자(그냥 "20")는 금액으로 보지 않는다. 수량·개수·
 * 인치·연식과 구분할 방법이 없어서, 잘못 잡으면 없는 예산을 만들어낸다.
 */
const MONEY_RE = /(\d[\d,]*(?:\.\d+)?)\s*(억|만|천)\s*(?:(\d[\d,]*)\s*(만|천))?\s*원?|(\d[\d,]{2,})\s*원/g;

/** 금액 뒤에 붙는 말 → 어떤 조건인가 */
const CAP_RE   = /^\s*(이하|이내|미만|까지|안으로|안쪽|밑|아래|이내로|언더)/;
const FLOOR_RE = /^\s*(이상|넘는|넘게|부터|초과|위로)/;
/*
 * "20만원대" — 뒤에 조사가 붙어도 같은 뜻이다.
 *
 * 처음에는 한글이 이어지면 무조건 제외했는데(?![가-힣]), 그러면
 * "3만원대로", "20만원대에서" 같은 흔한 말이 통째로 빠졌다. 조사로
 * 이어지는 것만 허용하고, "대신"·"대략" 같은 다른 낱말은 계속 막는다.
 */
const BAND_RE  = /^\s*대(?=[\s로에서만는은이의,.!?]|$)/;
// '선'은 "15만원 선"의 선이다. "10만원 선물"의 선물이 걸리면 안 되므로 (?!물).
const ABOUT_RE = /^\s*(정도|쯤|안팎|내외|근처|가량|남짓|짜리|선(?!물))/;

/*
 * "10~20만원" 처럼 앞 숫자가 단위를 생략한 구간 표현.
 *
 * MONEY_RE 는 단위도 '원'도 없는 맨숫자를 금액으로 보지 않는다(수량과
 * 구분할 수 없어서). 그 규칙 때문에 "10~20만원" 은 뒤의 20만원만 잡히고
 * 앞의 10 이 통째로 사라져, 구간이 아니라 상한 하나로 읽혔다.
 * 물결·하이픈·"에서" 로 이어진 두 숫자는 뒤에 붙은 단위를 앞에도 적용한다.
 */
const RANGE_RE = /(\d[\d,]*)\s*(?:[~\-–]|에서)\s*(\d[\d,]*)\s*(억|만|천)\s*원?/;

/** 금액 앞에 붙는 말 */
const PRE_ABOUT_RE = /(약|대략|한)\s*$/;

function toWon(numText, unit, subText, subUnit) {
  const base = Number(String(numText).replace(/,/g, ''));
  if (!Number.isFinite(base)) return 0;
  let won = unit ? base * UNIT[unit] : base;
  if (subText && subUnit) {
    const sub = Number(String(subText).replace(/,/g, ''));
    if (Number.isFinite(sub)) won += sub * UNIT[subUnit];
  }
  return Math.round(won);
}

/** 사람이 예산으로 말할 만한 범위인가. 1,000원 미만·10억 초과는 예산이 아니다. */
function plausibleBudget(won) {
  return won >= 1000 && won <= 1000000000;
}

const RECIPIENT_RE = [
  [/아버지|아빠|부친/, '아버지'],
  [/어머니|엄마|모친/, '어머니'],
  [/부모님|양친/, '부모님'],
  [/여자친구|여친|아내|와이프|여자 ?친구/, '여자친구·아내'],
  [/남자친구|남친|남편|신랑/, '남자친구·남편'],
  [/할머니|할아버지|조부모/, '조부모'],
  // '아이' 는 단독으로 넣지 않는다 — "아이폰 케이스" 가 통째로 걸린다.
  [/조카|아들|딸|자녀|초등학생|중학생|고등학생|우리 ?아이|아이(에게|한테|,| 선물)/, '아이'],
  [/직장 ?상사|상사|사장님|팀장/, '직장 상사'],
  [/동료|직장 ?동료|회사 ?사람/, '직장 동료'],
  [/친구/, '친구'],
  [/선생님|은사/, '선생님']
];

const GIFT_RE = /선물|생신|생일|기념일|답례|집들이|승진|졸업|입학|기념/;

/*
 * 예산 완화 신호 — 금액 없이 "조금 넘어도 괜찮다"고 말하는 경우.
 *
 * ── 왜 따로 다루는가 ────────────────────────────────────────────
 *
 *   [1] "100만원 이하 노트북"            → 상한 100만 (hard)
 *   [2] "가격 좀 넘어도 제일 좋은 걸로"   → ?
 *
 * [2] 에는 숫자가 없다. 그래서 예전에는 아무 일도 일어나지 않았고, 100만원
 * 상한이 그대로 남아 사용자가 방금 풀어 준 조건을 계속 지켰다. 반대로 예산을
 * 통째로 지우면 200만원짜리를 권하게 된다 — 그것도 사용자 뜻이 아니다.
 *
 * 옳은 처리는 삭제가 아니라 강도 낮추기다. 상한을 유지하되 hard → soft 로
 * 바꾸고 여유를 준다. 사용자가 말한 금액(budgetSaid)은 그대로 보존한다.
 */
/*
 * "-어도" 라는 양보형 어미 자체가 허락의 신호다.
 *
 * 처음에는 "넘어도 괜찮" 처럼 뒤에 오는 허락 표현까지 요구했는데, 실제
 * 어법을 못 잡았다 — "가격 조금 넘어도 제일 좋은 거 보여줘" 에는 "괜찮"이
 * 없다. 그래도 예산을 풀어 준 말인 것은 분명하다. 어미로 잡고, 뒤따르는
 * 부정("넘으면 안 돼")만 따로 걸러낸다.
 */
const RELAX_RE = /(넘어도|넘어서도|초과해도|비싸도|비싸져도|올려도|더\s*써도)|예산\s*(을|은)?\s*(조금|좀)?\s*(넘|올려|늘려)/;
/** "넘어도 안 돼" 처럼 허락이 아닌 경우. 신호 뒤 짧은 구간만 본다. */
const RELAX_NEG_RE = /(안\s*(돼|되|됩|될)|말아|말고|곤란|싫|부담)/;

/** 예산 완화 시 상한을 얼마나 늘릴 것인가. "조금"의 상식적인 폭. */
const RELAX_FACTOR = 1.3;

/** 무엇을 더 중히 보는가. 여러 개면 먼저 걸린 것 하나만. */
/*
 * 취향 판정.
 *
 * ── 활용형을 놓치지 않는다 ──────────────────────────────────────
 *
 * 실사용 문장 평가에서 아래가 전부 새어 나갔다(2026-08-28 실측).
 *
 *   "난 그냥 싼 게 최고야"        ← '싼 거'만 보고 '싼 게'를 못 봤다
 *   "가격보다 오래 쓰는 게 중요해" ← '오래 쓸'만 보고 '오래 쓰는'을 못 봤다
 *   "너무 무거운 건 싫어"         ← 부정으로 표현한 휴대성을 못 봤다
 *   "가벼웠으면 좋겠어"           ← '가벼운'만 보고 '가벼웠'을 못 봤다
 *
 * 사람은 원형으로 말하지 않는다. 어간에 활용 어미가 붙는 형태를 함께 본다.
 */
const PRIORITY_RE = [
  // "가격 상관없다"는 가격 중시의 반대다 — 품질 쪽으로 먼저 건진다.
  // (아래 price 패턴에 '저렴' 같은 낱말이 있어 순서가 중요하다)
  [/가격 ?(은|이)? ?상관없|비싸도 (괜찮|돼|된)|돈 ?(좀 ?)?더 (써도|들어도)|예산 ?(은)? ?상관없/, 'quality'],
  // 무거운 것이 싫다 = 휴대성 중시. 부정 표현이 price 보다 먼저 걸려야 한다.
  [/무거운 ?(건|거|게|것)? ?(싫|별로|안 ?좋)|무겁지 ?않|안 ?무거/, 'portable'],
  [/가성비|가심비|저렴|싼 ?(거|게|걸|것)|싼거|최저가|알뜰|경제적|싸게/, 'price'],
  [/품질|성능|튼튼|내구|오래 ?쓰|오래 ?쓸|오래 ?사용|고급|프리미엄|좋은 ?(거|게|걸|것)|퀄리티|스펙/, 'quality'],
  [/디자인|예쁜|예쁘|이쁜|이쁘|감성|색감|외관|미니멀/, 'design'],
  [/휴대|가벼[운웠워울요]|가볍|경량|작은|컴팩트/, 'portable']
];

const PRIORITY_LABEL = {
  price: '가격 중시', quality: '품질·성능 중시', design: '디자인 중시', portable: '휴대성 중시'
};

/*
 * 브랜드는 목록으로 알아보지 않는다.
 *
 * 브랜드 사전을 코드에 박으면 목록에 없는 브랜드는 영원히 못 알아보고,
 * 목록을 늘리는 일이 끝나지 않는다. 브랜드는 LLM 추출(api/ai.js)에 맡기고,
 * 여기서는 뽑힌 값을 상품명과 대조하는 일만 한다.
 */

/**
 * 사용자의 말 한 덩어리에서 조건을 뽑는다.
 *
 * 정규식으로만 판단한다 — LLM 호출을 늘리지 않기 위해서다. 놓치는 표현은
 * api/ai.js 의 추출 호출이 보완한다(그쪽은 앞 대화까지 본다).
 *
 * @param {string} text
 * @returns {object} 조건. 못 찾은 항목은 0 또는 ''.
 */
function parseConstraints(text) {
  const s = String(text || '');
  const out = {
    budgetMax: 0, budgetMin: 0, budgetSoft: false, budgetSaid: 0, budgetRelax: false,
    budgetNotice: '',
    recipient: '', gift: false, priority: '', brand: '', useCase: '', avoid: ''
  };

  /*
   * 금액 없이 "조금 넘어도 괜찮다"고 한 경우 — 삭제가 아니라 강도 낮추기다.
   * 다만 "넘어도 안 돼" 는 정반대이므로 신호 바로 뒤를 확인한다.
   */
  {
    const m = s.match(RELAX_RE);
    out.budgetRelax = !!m && !RELAX_NEG_RE.test(s.slice(m.index, m.index + 16));
  }

  /* ── 금액 ── */
  // 구간 표현이 먼저다. "10~20만원" 을 상한 하나로 읽지 않기 위해서.
  const range = s.match(RANGE_RE);
  if (range) {
    const unit = range[3];
    const lo = toWon(range[1], unit, '', '');
    const hi = toWon(range[2], unit, '', '');
    if (plausibleBudget(lo) && plausibleBudget(hi)) {
      out.budgetMin = Math.min(lo, hi);
      out.budgetMax = Math.max(lo, hi);
      out.budgetSaid = out.budgetMax;
    }
  }

  const found = [];
  MONEY_RE.lastIndex = 0;
  let m;
  while ((m = MONEY_RE.exec(s)) !== null) {
    const won = m[5] != null
      ? toWon(m[5], '', '', '')
      : toWon(m[1], m[2], m[3], m[4]);
    if (!plausibleBudget(won)) continue;
    found.push({ won, after: s.slice(m.index + m[0].length), before: s.slice(0, m.index) });
  }

  if (out.budgetMax) {
    // 구간에서 이미 정해졌다.
  } else if (found.length >= 2 && /[~\-–]|에서|부터/.test(s.slice(0, 200))) {
    // "10만원에서 20만원" — 낮은 쪽이 하한, 높은 쪽이 상한.
    const sorted = found.map(f => f.won).sort((a, b) => a - b);
    out.budgetMin = sorted[0];
    out.budgetMax = sorted[sorted.length - 1];
    out.budgetSaid = out.budgetMax;
  } else if (found.length) {
    // 여러 금액이 있으면 마지막에 말한 것을 쓴다 (사람은 고쳐 말할 때 뒤에 말한다).
    const f = found[found.length - 1];
    out.budgetSaid = f.won;
    if (CAP_RE.test(f.after)) {
      out.budgetMax = f.won;
    } else if (FLOOR_RE.test(f.after)) {
      out.budgetMin = f.won;
    } else if (BAND_RE.test(f.after)) {
      /*
       * "20만원대" = 20만 이상 30만 미만.
       *
       * 폭은 맨 앞자리의 자릿값이다(20만 → 10만, 3만 → 1만). 단위(만/천)로
       * 폭을 잡으면 "20만원대" 가 20만~20만9천이 되어 사실상 정찰가가 된다.
       */
      const step = Math.pow(10, Math.floor(Math.log10(f.won)));
      out.budgetMin = f.won;
      out.budgetMax = f.won + step - 1;
    } else if (ABOUT_RE.test(f.after) || PRE_ABOUT_RE.test(f.before)) {
      // "20만원 정도" — 딱 자르는 상한이 아니다. 조금 넘어도 후보로 둔다.
      out.budgetMax = Math.round(f.won * 1.15);
      out.budgetSoft = true;
    } else {
      /*
       * 단서 없는 금액("10만원 무선 이어폰", "50만원으로 선물").
       *
       * 쇼핑 문장에서 맨 금액은 거의 예산이다. 다만 "이하"라고 말한 것은
       * 아니므로 딱 자르지 않는다 — 10% 여유를 두고 soft 로 표시한다.
       *
       * ★ budgetSaid 는 사용자가 실제로 말한 금액이다. 프롬프트에는 이 값을
       *   적는다. 여유분(1.1배)까지 "예산" 이라고 적어 보내면 모델이 사용자가
       *   말한 적 없는 금액을 예산으로 되받아 말하게 된다.
       */
      out.budgetMax = Math.round(f.won * 1.1);
      out.budgetSoft = true;
    }
  }

  if (out.budgetMin && out.budgetMax && out.budgetMin > out.budgetMax) {
    const t = out.budgetMin; out.budgetMin = out.budgetMax; out.budgetMax = t;
  }

  /* ── 받는 사람·선물 ── */
  for (const [re, label] of RECIPIENT_RE) {
    if (re.test(s)) { out.recipient = label; break; }
  }
  out.gift = GIFT_RE.test(s) || !!out.recipient;

  /* ── 무엇을 중히 보는가 ── */
  for (const [re, key] of PRIORITY_RE) {
    if (re.test(s)) { out.priority = key; break; }
  }

  return out;
}

/** 값이 있는 항목만 b 로 덮어쓴다 (b 가 더 최근 발화). */
function mergeConstraints(a, b) {
  const out = Object.assign({
    budgetMax: 0, budgetMin: 0, budgetSoft: false, budgetSaid: 0, budgetRelax: false,
    budgetNotice: '',
    recipient: '', gift: false, priority: '', brand: '', useCase: '', avoid: ''
  }, a || {});
  const src = b || {};

  // 예산은 한 덩어리로 갈아탄다. 상한만 새로 말했는데 옛 하한이 남으면
  // 있지도 않은 구간이 만들어진다.
  if (src.budgetMax || src.budgetMin) {
    out.budgetMax = src.budgetMax || 0;
    out.budgetMin = src.budgetMin || 0;
    out.budgetSoft = !!src.budgetSoft;
    out.budgetSaid = src.budgetSaid || src.budgetMax || src.budgetMin || 0;
    out.budgetRelax = !!src.budgetRelax;
    // 새 금액을 말했으면 옛 완화 고지는 더 이상 사실이 아니다.
    out.budgetNotice = '';
  } else if (src.budgetRelax && out.budgetMax) {
    /*
     * 새 금액 없이 "조금 넘어도 괜찮다"고만 했다 (RELAX_RE 주석 참고).
     *
     * 지우지도, 그대로 두지도 않는다 — 상한을 유지한 채 강도만 낮춘다.
     * 사용자가 말한 금액(budgetSaid)은 건드리지 않는다. 프롬프트에는
     * 여전히 그 금액이 적혀야 하고("100만원 안팎"), 랭킹에서만 여유를 준다.
     */
    const before = out.budgetMax;
    out.budgetMax = Math.round(out.budgetMax * RELAX_FACTOR);
    out.budgetSoft = true;
    out.budgetRelax = true;
    /*
     * ★ 조건을 조용히 바꾸지 않는다.
     *
     * 사용자가 "조금 넘어도 괜찮다"고 했다고 해서 우리가 상한을 130%로
     * 올린 것을 말없이 넘어가면, 다음 답변에서 갑자기 비싼 상품이 나온 이유를
     * 사용자가 알 수 없다. 무엇을 어떻게 바꿨는지 한 줄로 알린다.
     * (프롬프트에 실려 모델이 답변에 옮긴다 — api/ai.js P.constraints)
     */
    out.budgetNotice = `말한 예산 ${won(out.budgetSaid || before)}원은 그대로 두되, `
      + `이번에는 ${won(out.budgetMax)}원까지 넘는 상품도 함께 비교했다`;
  }
  ['recipient', 'priority', 'brand', 'useCase', 'avoid'].forEach(k => {
    if (src[k]) out[k] = src[k];
  });
  if (src.gift) out.gift = true;
  return out;
}

/** 조건이 하나라도 있는가 (프롬프트에 실을 값이 있는가). */
function hasConstraints(c) {
  if (!c) return false;
  return !!(c.budgetMax || c.budgetMin || c.recipient || c.gift
    || c.priority || c.brand || c.useCase || c.avoid);
}

function won(v) {
  return String(Math.round(Number(v) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 조건을 사람이 읽는 한 줄로. 프롬프트에 넣어 "우리가 이렇게 알아들었다"를
 * 모델과 맞춘다 — 이미 들은 조건을 다시 묻는 일을 줄인다.
 */
function constraintLine(c) {
  if (!hasConstraints(c)) return '';
  const parts = [];
  /*
   * ★ 사용자가 말한 금액(budgetSaid)을 적는다.
   *   budgetMax 는 여유분이 섞인 내부 값이다. "50만원으로" 라고 말한 사람에게
   *   모델이 "예산 55만원이시군요" 라고 되받으면, 하지 않은 말을 들은 것이 된다.
   */
  const said = c.budgetSaid || c.budgetMax || c.budgetMin;
  if (c.budgetMin && c.budgetMax && c.budgetMin !== c.budgetMax) {
    parts.push(`예산 ${won(c.budgetMin)}~${won(c.budgetMax)}원`);
  } else if (c.budgetMax) {
    parts.push(`예산 ${won(said)}원 ${c.budgetSoft ? '안팎' : '이하'}`);
  } else if (c.budgetMin) {
    parts.push(`예산 ${won(c.budgetMin)}원 이상`);
  }
  if (c.recipient) parts.push(`받는 사람: ${c.recipient}`);
  else if (c.gift) parts.push('선물용');
  if (c.useCase) parts.push(`용도: ${c.useCase}`);
  if (c.brand) parts.push(`브랜드: ${c.brand}`);
  if (PRIORITY_LABEL[c.priority]) parts.push(PRIORITY_LABEL[c.priority]);
  if (c.avoid) parts.push(`피하고 싶은 것: ${c.avoid}`);
  return parts.join(' · ');
}

/* ==================================================================
 *  2) 랭킹 — 검색 순서가 아니라 "이 사람에게 맞는 순서"로
 * ================================================================== */

/*
 * 성향 가중치가 점수를 움직이는 폭.
 *
 * 예산 적합(+40)·요구 기능(+24) 같은 하드 신호보다 작게 잡는다. 취향은
 * 조건을 뒤집는 것이 아니라 비슷한 후보들 사이의 순서를 정하는 것이다.
 */
const PREF_GAIN = 12;

const TRUST_SCORE = { high: 8, medium: 4, unknown: 0, low: -8, stale: -10 };

/**
 * 상품 한 건의 적합도.
 *
 * ★ 여기서 만드는 것은 순서와 "사실 문장"뿐이다. 점수 자체는 밖으로 나가지
 *   않는다. 근거로 적히는 값은 전부 상품 데이터에 실제로 있는 숫자다.
 *
 * @returns {{score:number, fit:string, notes:string[]}}
 */
function scoreItem(it, c, tokens) {
  const price = Math.round(Number(it && it.price) || 0);
  const notes = [];
  let score = 0;
  let fit = '';
  /*
   * 예산이 점수에 기여한 몫을 따로 센다.
   *
   * "예산을 더 쓸 수 있다면 무엇이 1위인가"(_decision.alternatives)를 답하려면
   * 예산 성분만 정확히 걷어낸 점수가 필요하다. 그 값을 바깥에서 다시
   * 어림하면 규칙이 바뀔 때마다 어긋나므로, 계산한 자리에서 함께 돌려준다.
   */
  let budgetScore = 0;

  /*
   * 다목적 분해 (지시 6항).
   *
   * 합계(score)는 지금까지와 똑같이 쌓되, 어느 축에서 온 점수인지 따로 센다.
   * 이 분해가 있어야 "가격은 좋은데 성능이 아쉽다" 같은 판단과, 사용자
   * 성향에 따른 재가중(_profile)이 가능해진다.
   *
   * ★ 합계를 바꾸지 않는다. 기존 순위·테스트가 그대로여야 한다 —
   *   분해는 관측을 늘리는 것이지 판단을 바꾸는 것이 아니다.
   */
  const sub = {
    budget: 0,       // 예산 적합 (하드 조건 — 취향으로 흔들지 않는다)
    relevance: 0,    // 검색어 일치
    feature: 0,      // 요구 기능 충족
    brand: 0,        // 브랜드 일치
    timing: 0,       // 가격 기록상 지금이 좋은 때인가
    value: 0,        // 30일 평균 대비 싼가
    trust: 0,        // 가격 신뢰도
    deal: 0          // 정가 대비 할인
  };

  /* ── 예산 ── */
  if (price > 0 && (c.budgetMax || c.budgetMin)) {
    const overMax = c.budgetMax && price > c.budgetMax;
    const underMin = c.budgetMin && price < c.budgetMin;

    if (!overMax && !underMin) {
      score += 40; budgetScore += 40; sub.budget += 40;
      fit = '예산 적합';
      // 예산 안에서는 낮을수록 좋되, 바닥까지 내려가는 것이 항상 좋진 않다.
      // 상한의 40~100% 구간을 가장 좋게 본다(너무 싼 것만 밀지 않기 위해).
      if (c.budgetMax) {
        const ratio = price / c.budgetMax;
        const bonus = ratio >= 0.4 ? 10 : 4;
        score += bonus; budgetScore += bonus; sub.budget += bonus;
      }
    } else if (overMax) {
      const over = price / c.budgetMax;
      if (over <= 1.15) {
        score -= 10; budgetScore -= 10; sub.budget -= 10;
        fit = `예산 ${won(price - c.budgetMax)}원 초과`;
      } else {
        /*
         * 크게 넘은 것도 넘은 정도에 따라 줄을 세운다.
         *
         * 예전에 고정 감점(-45)을 주었더니 90만원과 150만원이 동점이 되어,
         * 20만원 예산에서 150만원짜리가 90만원짜리보다 위에 오는 일이 있었다
         * (동점이면 검색 순서를 지키므로). 조건에 못 맞출 때도 "그나마 가까운
         * 것" 이 먼저 보여야 사용자가 판단할 수 있다.
         */
        const penalty = 35 + Math.min(45, Math.round((over - 1) * 8));
        score -= penalty; budgetScore -= penalty; sub.budget -= penalty;
        fit = `예산 초과(${Math.round((over - 1) * 100)}% 높음)`;
      }
    } else {
      // 하한 미달은 "싸서 문제"라기보다 조건 밖이다. 크게 깎지 않는다.
      score -= 12; budgetScore -= 12; sub.budget -= 12;
      fit = '예산 하한 미만';
    }
  }

  /* ── 검색어 적합도 ── */
  if (tokens && tokens.length) {
    const sh = shop();
    // 대조할 수단이 없으면(모듈 로드 실패) 가점도 감점도 하지 않는다.
    if (sh) {
      if (sh.matchesKeyword(tokens, it.title || '')) { score += 12; sub.relevance += 12; }
      else { score -= 18; sub.relevance -= 18; notes.push('검색어와 상품명이 일치하지 않음'); }
    }
  }

  /*
   * ── 요구 기능 적합도 (spec fit) ──
   *
   * attachSpecs 가 상품명에서 확인한 기능과 사용자의 요구를 대조해 둔 결과다
   * (api/ai.js). "통화 중요"라고 한 사람에게 마이크가 확인된 상품이 위로
   * 와야 한다 — 그것이 검색 순서보다 중요한 정보다.
   *
   * ★ miss 는 "그 기능이 없다"가 아니라 "상품명에서 확인 안 됨"이다.
   *   그래서 감점을 작게 준다. 판매자가 제목에 안 썼을 뿐일 수 있다.
   *   확인된 쪽을 올리는 것이지, 확인 안 된 쪽을 벌하는 것이 아니다.
   */
  if (Array.isArray(it.featureHit) && it.featureHit.length) {
    const fp = Math.min(24, it.featureHit.length * 12);
    score += fp; sub.feature += fp;
    notes.push(`요구 기능 확인: ${it.featureHit.join('·')}`);
  }
  if (Array.isArray(it.featureMiss) && it.featureMiss.length) {
    const fm = Math.min(8, it.featureMiss.length * 4);
    score -= fm; sub.feature -= fm;
    notes.push(`${eunn(it.featureMiss.join('·'))} 상품명에서 확인 안 됨(없다는 뜻은 아님)`);
  }

  /* ── 브랜드 ── */
  if (c.brand) {
    const t = String(it.title || '').toLowerCase();
    if (t.includes(String(c.brand).toLowerCase())) { score += 18; sub.brand += 18; notes.push(`${c.brand} 제품`); }
  }

  /* ── 가격 기록(우리만 가진 근거) ── */
  const h = it.hist;
  if (h && h.count > 0) {
    score += 4; sub.trust += 4;   // 기록이 있다는 것 자체가 근거의 신뢰를 올린다

    if (h.avg30 > 0 && price > 0) {
      const diff = Math.round((1 - price / h.avg30) * 1000) / 10;   // +면 평균보다 쌈
      if (diff >= 3) {
        const vp = Math.min(20, diff);
        score += vp; sub.value += vp;
        notes.push(`30일 평균보다 ${diff}% 저렴`);
      } else if (diff <= -5) {
        const vm = Math.min(15, -diff);
        score -= vm; sub.value -= vm;
        notes.push(`30일 평균보다 ${-diff}% 비쌈`);
      }
    }

    if (h.low > 0 && price > 0) {
      if (price <= h.low) notes.push('기록상 최저가 수준');
      else if (price <= Math.round(h.low * 1.03)) { score += 8; sub.timing += 8; notes.push('기록상 최저가에 근접'); }
    }

    if (h.trendPct != null && h.trendDays >= 1) {
      if (h.trendPct <= -3) { score += 6; sub.timing += 6; notes.push(`최근 ${h.trendDays}일 ${Math.abs(h.trendPct)}% 하락`); }
      else if (h.trendPct >= 5) { score -= 4; sub.timing -= 4; notes.push(`최근 ${h.trendDays}일 ${h.trendPct}% 상승`); }
    }
  }

  /* ── 가격 신뢰도 ── */
  const lvl = it.trust && it.trust.level;
  if (lvl && TRUST_SCORE[lvl] !== undefined) { score += TRUST_SCORE[lvl]; sub.trust += TRUST_SCORE[lvl]; }

  /* ── 정가 대비 할인(쿠팡만 진짜 정가) ── */
  if (it.discountPct > 0) {
    const dp = Math.min(8, Math.round(it.discountPct / 5));
    score += dp; sub.deal += dp;
  }

  /*
   * 취향(가격 중시·품질 중시)은 여기서 다루지 않는다.
   *
   * 절대 금액으로는 점수를 매길 수 없다 — 3만원이 싼지 비싼지는 카테고리마다
   * 다르다. 이번 후보들 안에서의 상대 위치로만 판단해야 하므로 rankItems 가
   * 목록 전체를 본 뒤에 얹는다.
   */
  return { score, fit, notes, budgetScore, sub };
}

/**
 * 검색 결과를 사용자 조건에 맞는 순서로 다시 세운다.
 *
 * @param {Array} items  normItem 을 거친 상품들 (hist·trust 가 붙어 있을 수 있다)
 * @param {object} c     parseConstraints/mergeConstraints 결과
 * @param {string} query 검색어 (상품명 적합도 판정용)
 * @returns {Array} 같은 객체들. fit/notes 가 붙고 순서가 바뀐다.
 */
function rankItems(items, c, query, opts) {
  const list = (items || []).filter(Boolean);
  if (list.length <= 1) {
    list.forEach(it => { if (!it.fit) it.fit = ''; if (!it.notes) it.notes = []; });
    return list;
  }

  const cons = c || {};
  const sh = shop();
  const tokens = (query && sh) ? sh.keywordTokens(query) : [];

  const prices = list.map(it => Math.round(Number(it.price) || 0)).filter(p => p > 0);
  const min = prices.length ? Math.min.apply(null, prices) : 0;
  const max = prices.length ? Math.max.apply(null, prices) : 0;

  list.forEach(it => {
    const s = scoreItem(it, cons, tokens);
    it.fit = s.fit;
    it.notes = s.notes;
    it._score = s.score;
    it._budgetScore = s.budgetScore;
    it._sub = s.sub;

    /*
     * 취향에 따른 상대 가점.
     *
     * 절대 금액으로 주면 카테고리마다 기준이 달라 말이 안 된다. 이번 후보들
     * 안에서의 위치(0~1)로만 준다. 후보가 전부 같은 값이면 아무 영향이 없다.
     */
    const price = Math.round(Number(it.price) || 0);
    if (price > 0 && max > min) {
      const pos = (price - min) / (max - min);     // 0=가장 쌈, 1=가장 비쌈
      if (cons.priority === 'price') it._score += Math.round((1 - pos) * 14);
      else if (cons.priority === 'quality') it._score += Math.round(pos * 8);
    }

    /*
     * ── 성향 가중치 적용 (api/_profile.js) ──────────────────────
     *
     * 지금까지 성향은 계산만 되고 프롬프트에만 실렸다. 순위를 바꾸지
     * 못했으니 "개인화"가 말뿐이었다.
     *
     * ★ 가장 중요한 성질: 취향을 말하지 않은 사용자에게는 배수가 전부
     *   1.0 이라 점수가 한 톨도 바뀌지 않는다. 기존 랭킹이 그대로다.
     *   (opts.weights 가 없으면 이 블록 자체가 돌지 않는다)
     *
     * 축 하나를 통째로 곱하지 않고 "1 을 넘는 만큼"만 반영한다.
     * 그래야 예산 적합 같은 하드 조건이 취향으로 뒤집히지 않는다.
     */
    const w = opts && opts.weights;
    if (w && it._sub) {
      let adj = 0;
      // 가격 중시 — 이번 후보 안에서 싼 쪽에 가점
      if (w.price && price > 0 && max > min) {
        const pos = (price - min) / (max - min);
        adj += (w.price - 1) * (1 - pos) * PREF_GAIN;
      }
      // 성능·품질 중시 — 확인된 사양이 많은 쪽에 가점
      if (w.performance || w.quality) {
        const specCount = (it.spec && it.spec.specs) ? Object.keys(it.spec.specs).length : 0;
        const featCount = (it.spec && it.spec.features) ? it.spec.features.length : 0;
        const richness = Math.min(1, (specCount + featCount) / 6);
        adj += (((w.performance || 1) + (w.quality || 1)) / 2 - 1) * richness * PREF_GAIN;
      }
      // 휴대성 중시 — 가벼움·휴대 관련 기능이 확인된 쪽에 가점
      if (w.portability) {
        const feats = (it.spec && it.spec.features) || [];
        const portable = feats.includes('경량') || feats.includes('휴대용') ? 1 : 0;
        adj += (w.portability - 1) * portable * PREF_GAIN;
      }
      // 브랜드 중시 — 브랜드 조건이 맞은 쪽에 가점(sub.brand 가 이미 그것을 잰다)
      if (w.brand && it._sub.brand > 0) {
        adj += (w.brand - 1) * PREF_GAIN;
      }
      it._prefAdj = Math.round(adj * 10) / 10;
      it._score += it._prefAdj;
    }

    /*
     * 제외 감점 (api/_feedback.js).
     *
     * "삼성은 빼줘" 를 목록에서 지우지 않고 크게 내린다. 지우면 다른
     * 조건을 전부 만족하는 상품이 통째로 사라진다("절대"라고 한 경우에만
     * 호출부가 미리 지운다).
     */
    if (it._excludePenalty > 0) {
      it._score -= it._excludePenalty;
      /*
       * 사유는 notes 를 갈아끼운 "뒤에" 붙인다 — 위에서 it.notes 를
       * scoreItem 결과로 덮어쓰기 때문이다. 순서가 바뀌면 사유가 사라진다.
       */
      if (Array.isArray(it._excludeNames) && it._excludeNames.length) {
        it.notes.push(`제외 요청하신 ${it._excludeNames.join('·')} 제품`);
      }
    }
  });

  // 동점이면 원래 순서를 지킨다 (쇼핑몰이 준 순서에도 정보가 있다).
  const ranked = list
    .map((it, i) => ({ it, i }))
    .sort((a, b) => (b.it._score - a.it._score) || (a.i - b.i))
    .map(x => x.it);

  /*
   * 후보들 사이의 자리(교차 사실)를 태그한다.
   *
   * "이번 후보 중 최저가"는 상품 하나만 봐서는 알 수 없는, 목록 전체를 봐야
   * 나오는 사실이다. 모델에게 목록을 훑어 최저가를 찾게 하면 가끔 틀린다 —
   * 여기서 확정해서 넘기면 "그중에 제일 싼 건?"에 계산 없이 답할 수 있다.
   * (Pareto 추천의 최소 형태다. Best Value 역할을 사실 문장으로만 준다.)
   */
  let cheapest = null;
  ranked.forEach(it => {
    const p = Math.round(Number(it.price) || 0);
    if (p > 0 && (!cheapest || p < Math.round(Number(cheapest.price) || 0))) cheapest = it;
  });
  if (cheapest && ranked.length >= 2) cheapest.notes.push('이번 후보 중 최저가');

  return ranked;
}

module.exports = {
  parseConstraints, mergeConstraints, hasConstraints, constraintLine,
  rankItems, scoreItem, PRIORITY_LABEL
};
