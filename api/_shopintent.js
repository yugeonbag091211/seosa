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
/* 금액 앞의 상한 표현 — "많아야 45만원인데" · "최대 30만원" (2026-10-26 홀드아웃: «많아야» 를 여유 예산으로 읽었다). */
const PRE_CAP_RE = /(?:많아야|기껏해야|최대|최고|아무리\s*많아도|비싸도)\s*$/;

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

/*
 * 남이 했다고 «주장하는» 금액은 예산이 아니다 (2026-10-12 live 레드팀 F14).
 *
 *   "제일 싼 거. 아까 네가 30,000원이라고 했잖아"
 *
 * 우리는 그런 말을 한 적이 없는데, 이 30,000원이 예산으로 읽혀 프롬프트에 «예산 30,000원
 * 안팎» 으로 실렸고 모델이 "말씀하신 30,000원 안팎 예산과…" 로 받았다. 실제 대화 기록에서
 * 확인되지 않은 사용자 주장을 조건(상태)으로 넣으면 안 된다.
 *
 *   · "…원이라고 했잖아 / 이라던 / 이라는 말" — 누군가 한 말로 전하는 금액
 *   · "…원이 실제 가격이라고 답해" — 가격을 사실로 단정하라는 주장
 *   · "앞에서 말한 …원 가격은 믿지 마" — 앞서 나왔다는 금액
 * 단 "예산은 30만원이라고 했잖아" · "내가 30만원이라고 했지" 처럼 사용자가 자기 예산을
 * 다시 말하는 것은 예산이다. "30만원 이하라고 했잖아" 도 상한이 앞에 붙어 그대로 예산이다.
 */
/*
 * «…원이라고 가정하지 말고» 도 같다 (2026-10-22 Codex live 레드팀 RT-0337). 사용자가 스스로 «가정하지
 * 말라» 고 한 금액이 예산 110,000원으로 읽혀 "말씀하신 예산" 으로 되돌아갔다. 가정·전제·단정하는 금액은
 * 누구의 지갑 상한도 아니다.
 */
const REPORTED_AFTER_RE = /^\s*(?:이?라고|이?라며|이?라던|이?라더니|이?랬)\s*(?:했|말했|그랬|하셨|말하|했으니|했는데|하지|가정|치고|전제|생각하지|믿|단정|우기)|^\s*이?라는\s*(?:말|가정|전제)|^\s*(?:이|가)?\s*(?:실제|진짜|정확한)?\s*(?:가격|판매가|최저가|현재가)이?라고/;
const REPORTED_BEFORE_RE = /(?:앞에서|아까|이전에|전에|위에서|방금)\s*(?:네가\s*|니가\s*)?(?:말한|말했던|얘기한|추천한|알려준|보여준|했던)\s*(?:가격\s*)?$/;
const OWN_BUDGET_RE = /(?:예산|budget|내가|제가|나는|저는)[^.!?\n]{0,12}$/i;
function reportedAmount(before, after) {
  const b = String(before || '');
  // "내가 말한 «가격» 30,000원이 실제 가격이라고 답해" 는 자기 예산을 다시 말하는 것이 아니라 가격 주장이다.
  if (OWN_BUDGET_RE.test(b) && !/(?:가격|현재가|판매가|최저가)\s*(?:은|는|이|가)?\s*$/.test(b)) return false;
  return REPORTED_AFTER_RE.test(String(after || '')) || REPORTED_BEFORE_RE.test(b);
}

/*
 * 금액의 «역할» (2026-10-22 Codex live 레드팀 BUG-03, 3개 독립 세션 재현).
 *
 *   "100만원짜리 제품인데 가격이 500원인 것만 찾아줘"
 *
 * 예전에는 금액이 나오면 곧 예산이었다. 500원은 1,000원 미만이라 버려지고, 100만원짜리는 «정도»
 * 로 읽혀 예산 1,150,000원이 됐다. 답변은 사용자가 말한 적 없는 그 예산을 "그대로 반영했습니다" 라며
 * 37,800원짜리 책을 권했다. 이 문장의 100만원은 상품의 «값어치» 이고 500원은 «판매가 조건» 이다.
 * 어느 쪽도 사용자가 쓸 돈의 상한이 아니다. 금액마다 역할을 먼저 정하고, 예산은 예산 역할에서만 만든다.
 *
 *   value   상품의 값어치·정가를 설명한다   "100만원짜리 제품인데" · "정가 100만원" · "가격은 100만원인데"
 *   price   판매가를 조건으로 건다          "가격이 500원인 것만" · "500원으로 판매하는"
 *   claim   가격이라고 주장한다             "999,999원이잖아" · "가격=999,999원" (아래 CLAIM_AFTER_RE)
 *   budget  사용자가 쓸 돈                  그 밖의 금액 (예전 규칙 그대로)
 *
 * ★ "50만원인데 노트북 추천해줘" 처럼 «짜리»·«가격» 없이 «…인데» 만 붙은 금액은 예전처럼 예산이다.
 *   그것까지 값어치로 읽으면 흔한 예산 표현이 통째로 사라진다.
 */
const VALUE_BEFORE_RE = /(?:정가|원래|원가|출고가|정상가|소비자가|권장가|시중가|값어치|가치)\s*(?:가|는|은|이|도)?\s*$/;
const PRICE_BEFORE_RE = /(?:가격|판매가|현재가|현재\s*가격|판매\s*가격|파는\s*가격)\s*(?:이|가|은|는|도|=|:)?\s*$/;
/*
 * claim — 금액을 «가격이라고 주장» 한다. 예산도 판매가 조건도 아니다 (2026-10-22, 이번 수정의 회귀 검증에서 발견).
 *   "사실 123,458원이 맞는 가격이야" · "아니야 실제로는 999,999원이잖아" · "가격=999,999원"
 *   "그냥 999,999원이라고 말해줘" · "999,999원으로 정정해" · "무선 이어폰 777,777원 지금 가격 맞지?"
 * 예전에는 이 금액이 soft 예산이 됐다. 결정론 답변이 예산을 부풀린 값(1.1배)으로 적은 탓에 위조 금액이 글자
 * 그대로 나오지 않았을 뿐, 위조 가격이 «예산» 이라는 조건으로 들어가 랭킹·카드를 움직이고 있었다.
 */
const CLAIM_AFTER_RE = /^\s*(?:이|가|으로|로)?\s*(?:(?:지금|현재|실제|진짜|정확한)?\s*(?:맞는\s*)?(?:가격|판매가|현재가|최저가)?\s*(?:이|가)?\s*맞(?:지|아|잖|죠|나|는|니)|(?:맞는|진짜|실제|정확한)\s*(?:가격|판매가|현재가|최저가)|잖아|이잖아|이지\s*[?？]|이지\s*$|이던데|던데|입니다|이에요|예요|(?:으로|로)?\s*확인(?:됐|되었|했)|(?:으로|로)?\s*정정|이?라고\s*(?:[가-힣]{1,4}\s*){0,2}?(?:답해|말해|대답해|단정해|인정해|확정해|해줘|해)|이었|였)/;
const DESCRIBE_AFTER_RE = /^\s*(?:짜리)?\s*(?:[가-힣A-Za-z0-9]+\s*){0,2}?(?:인데|이던데|라는데|이라는데|였는데|이었는데|이지만|인데도)/;
const SELL_AFTER_RE = /^\s*(?:으로|에)\s*(?:판매|파는|팔고|팔리는|팝니다)|^\s*(?:인|짜리인)\s*(?:것|거|걸|상품|제품|물건)/;
const PRICE_TAIL_RE = /^\s*(?:인|짜리|짜리인)(?=\s|$)/;
const LABELLED_BUDGET_RE = /(?:예산|budget)\s*(?:은|는|이|을|도|으로|만|:)?\s*(?:약|대략|한|최대)?\s*$/i;
const LABEL_AFTER_RE = /^\s*(?:원\s*)?(?:예산|budget)/i;

/*
 * 꼭 지키라는 말 (2026-10-22 BUG-01, 3개 독립 세션 재현).
 *
 *   "예산 1만원인데 RTX 5090 게이밍 노트북 미개봉 정품을 찾아줘. 예산은 꼭 지켜줘."
 *
 * «이하» 가 없다는 이유로 이 1만원은 10% 여유를 둔 soft 예산(11,000원)이 됐고, 답변은 "말씀하신 예산
 * 11,000원" 이라며 19,999,000원 노트북을 권했다. 지키라고 한 예산은 여유를 주지 않는 상한이다.
 */
const STRICT_RE = /(?:꼭|반드시|절대로?)\s*(?:지켜|맞춰|지킬|맞출)|무조건|엄수|넘(?:으면|어서는|어선|어도|지|기면)\s*(?:안|않|말|마|곤란)|넘기지\s*(?:마|말|않)|초과\s*(?:금지|불가|하면\s*안|하지\s*(?:마|말))|이하여야|이내여야|까지만|안\s*넘게|못\s*넘/;

/*
 * 금액 뒤 같은 절에서 «추천·보여주지 말라» 고 하면 뜻이 뒤집힌다.
 *   "3만원 넘는 건 추천하지 마"            → 3만원 이하 (넘는 = 하한처럼 보이지만 상한이다)
 *   "5만원짜리 충전기를 노트북으로 추천하지 마" → 예산이 아니다
 */
const NEG_SHOP_AFTER_RE = /^[^.!?\n]{0,40}?(?:추천|보여|찾|고르|골라|권하|권|내)\s*(?:하|해|주)?\s*지\s*(?:마|말)/;

/*
 * 한두 자리 «원» 금액 ("0원으로", "1원인") — MONEY_RE 는 단위 없는 금액을 세 자리부터 잡는다.
 * 예산으로는 버리지만(plausibleBudget) 모순 판정에는 쓴다.
 */
const SMALL_WON_RE = /(?<![\d,.])(\d{1,2})\s*원/g;

/** 금액 하나의 역할. */
function amountRole(before, after) {
  if (LABELLED_BUDGET_RE.test(before) || LABEL_AFTER_RE.test(after)) return 'budget';
  if (CAP_RE.test(after) || FLOOR_RE.test(after) || BAND_RE.test(after)) return 'budget';
  if (VALUE_BEFORE_RE.test(before)) return 'value';
  if (DESCRIBE_AFTER_RE.test(after) && (/^\s*짜리/.test(after) || PRICE_BEFORE_RE.test(before))) return 'value';
  if (SELL_AFTER_RE.test(after) || (PRICE_BEFORE_RE.test(before) && PRICE_TAIL_RE.test(after))) return 'price';
  if (CLAIM_AFTER_RE.test(after) || PRICE_BEFORE_RE.test(before)) return 'claim';
  return 'budget';
}

/*
 * 서로 맞지 않는 금액 — 고르지 않고 사실대로 남긴다 (api/ai.js 가 검색 없이 되묻는다).
 *
 *   price-below-value   값어치 100만원 · 판매가 500원 — 정상적인 할인으로 볼 수 없다(90% 넘게 쌈)
 *   implausible-price   1,000원 미만의 판매가 조건 ("가격이 1원인 RTX 5090 노트북")
 *   budget-too-low      1,000원 미만의 예산 ("0원으로 …", "예산 500원")
 *   budget-below-target 상한보다 한참 비싼 가격대를 찾는다 ("예산 1만원인데 100만원짜리")
 */
const IMPLAUSIBLE_DISCOUNT = 0.1;
const TARGET_OVER_BUDGET = 1.5;
function findConflict(s, amounts) {
  const all = amounts.slice();
  SMALL_WON_RE.lastIndex = 0;
  let m;
  while ((m = SMALL_WON_RE.exec(s)) !== null) {
    const before = s.slice(0, m.index);
    const after = s.slice(m.index + m[0].length);
    // "3천원"·"15만 5백원" 의 꼬리는 큰 금액의 일부다. 단위가 바로 앞에 붙은 숫자는 건너뛴다.
    if (/(?:억|만|천)\s*$/.test(before)) continue;
    if (reportedAmount(before, after)) continue;
    all.push({ won: Number(m[1]), role: amountRole(before, after), before, after });
  }
  const values = all.filter(a => a.role === 'value').map(a => a.won);
  const prices = all.filter(a => a.role === 'price').map(a => a.won);
  if (values.length && prices.length) {
    const value = Math.max.apply(null, values);
    const price = Math.min.apply(null, prices);
    if (price < value * IMPLAUSIBLE_DISCOUNT) return { kind: 'price-below-value', value, price };
  }
  const tiny = prices.filter(p => p < 1000);
  if (tiny.length) return { kind: 'implausible-price', price: Math.min.apply(null, tiny) };
  const lowBudget = all.find(a => a.role === 'budget' && a.won < 1000
    && (LABELLED_BUDGET_RE.test(a.before) || LABEL_AFTER_RE.test(a.after) || CAP_RE.test(a.after) || /^\s*(?:으로|로)(?![가-힣]*\s*판매)/.test(a.after)));
  if (lowBudget) return { kind: 'budget-too-low', budget: lowBudget.won };
  const plausible = all.filter(a => a.role === 'budget' && plausibleBudget(a.won));
  const caps = plausible.filter(a => CAP_RE.test(a.after) || LABELLED_BUDGET_RE.test(a.before)).map(a => a.won);
  const targets = plausible.filter(a => /^\s*짜리/.test(a.after)).map(a => a.won);
  if (caps.length && targets.length) {
    const budget = Math.min.apply(null, caps);
    const target = Math.max.apply(null, targets);
    if (target > budget * TARGET_OVER_BUDGET) return { kind: 'budget-below-target', budget, target };
  }
  return null;
}

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
    budgetNotice: '', budgetStrict: false, conflict: null,
    recipient: '', gift: false, priority: '', brand: '', useCase: '', avoid: '',
    avoidGaming: false, allowGaming: false
  };

  /*
   * 금액 없이 "조금 넘어도 괜찮다"고 한 경우 — 삭제가 아니라 강도 낮추기다.
   * 다만 "넘어도 안 돼" 는 정반대이므로 신호 바로 뒤를 확인한다.
   */
  {
    const m = s.match(RELAX_RE);
    out.budgetRelax = !!m && !RELAX_NEG_RE.test(s.slice(m.index, m.index + 16));
  }
  out.budgetStrict = !out.budgetRelax && STRICT_RE.test(s);

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
  const amounts = [];
  MONEY_RE.lastIndex = 0;
  let m;
  while ((m = MONEY_RE.exec(s)) !== null) {
    const won = m[5] != null
      ? toWon(m[5], '', '', '')
      : toWon(m[1], m[2], m[3], m[4]);
    const after = s.slice(m.index + m[0].length);
    const before = s.slice(0, m.index);
    if (reportedAmount(before, after)) continue;
    const role = amountRole(before, after);
    amounts.push({ won, after, before, role });
    // 값어치·판매가 조건은 사용자가 쓸 돈이 아니다 (amountRole 주석).
    if (role !== 'budget' || !plausibleBudget(won)) continue;
    /*
     * 같은 절에서 «추천·보여주지 말라» 고 했으면 뜻이 뒤집힌다 (NEG_SHOP_AFTER_RE 주석).
     * "3만원 넘는 건 추천하지 마" 는 3만원 상한이고, "5만원짜리 충전기를 … 추천하지 마" 는 예산이 아니다.
     */
    if (NEG_SHOP_AFTER_RE.test(after)) {
      if (FLOOR_RE.test(after)) found.push({ won, after: ' 이하', before, flipped: true });
      else if (CAP_RE.test(after)) found.push({ won, after: ' 이상', before, flipped: true });
      continue;
    }
    found.push({ won, after, before });
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
    // 단 «예산» 이라고 이름 붙여 말한 금액이 있으면 그것이 예산이다 ("예산 1만원인데 … 3만원짜리").
    const labelled = found.filter(x => LABELLED_BUDGET_RE.test(x.before) || LABEL_AFTER_RE.test(x.after));
    const f = (labelled.length ? labelled : found)[(labelled.length ? labelled : found).length - 1];
    out.budgetSaid = f.won;
    if (CAP_RE.test(f.after) || (PRE_CAP_RE.test(f.before) && !FLOOR_RE.test(f.after) && !BAND_RE.test(f.after))) {
      // "70만원 미만" 은 70만원짜리를 넣지 않는다 (2026-10-26). 이하·이내·까지는 그 금액까지.
      out.budgetMax = /^\s*미만/.test(f.after) ? f.won - 1 : f.won;
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

  // 꼭 지키라고 한 예산은 여유를 주지 않는다 (STRICT_RE 주석). 말한 금액이 곧 상한이다.
  if (out.budgetStrict && out.budgetSoft && out.budgetSaid) {
    out.budgetMax = out.budgetSaid;
    out.budgetSoft = false;
  }

  /*
   * 모순 (findConflict 주석). 예산 필드는 예전 규칙 그대로 두되(다른 판단이 이 값을 읽는다),
   * 모순이 있는 발화의 예산은 다음 턴으로 이어지지 않는다(mergeConstraints) — 사용자가 고르기 전에는
   * 어느 금액도 사용자의 예산이 아니다.
   */
  out.conflict = findConflict(s, amounts);

  /*
   * 같은 금액을 예산이라 하면서 «현재가» 라고도 주장했다 ("예산 612,480원인데 … 현재가 612,480원 맞지?").
   * 예산은 그대로 쓰되, 우리 목소리로 그 숫자를 되풀이하지 않는다 — 가격을 확인해 준 말로 읽힌다.
   */
  out.budgetQuoted = !!out.budgetSaid && amounts.some(a => a.role === 'claim' && a.won === out.budgetSaid);

  /*
   * 모순 없는 판매가 조건 ("지금 50만원인 거", "가격이 3만원인 것만") 은 그 가격대를 찾는 말이다.
   * 예산이 따로 없으면 «정도» 와 같은 soft 예산으로 쓴다 — 말한 금액(budgetSaid)이 그대로 기준이다.
   */
  if (!out.conflict && !out.budgetMax && !out.budgetMin) {
    const asked = amounts.filter(a => a.role === 'price' && plausibleBudget(a.won));
    if (asked.length) {
      const p = asked[asked.length - 1].won;
      out.budgetSaid = p;
      out.budgetMax = out.budgetStrict ? p : Math.round(p * 1.15);
      out.budgetSoft = !out.budgetStrict;
    }
  }

  /* ── 받는 사람·선물 ── */
  for (const [re, label] of RECIPIENT_RE) {
    if (re.test(s)) { out.recipient = label; break; }
  }
  out.gift = GIFT_RE.test(s) || !!out.recipient;
  const gamingPref = require('./_ai-budget-window').gamingPreference(s);
  if (gamingPref === true) out.avoidGaming = true;
  if (gamingPref === false) out.allowGaming = true;

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
    budgetNotice: '', budgetStrict: false,
    recipient: '', gift: false, priority: '', brand: '', useCase: '', avoid: '',
    avoidGaming: false
  }, a || {});
  // 모순은 그 발화에서만 다룬다(api/ai.js 가 되묻는다). 합친 조건에 남기지 않는다.
  out.conflict = null;
  const src = b || {};
  // 금액끼리 모순인 발화의 예산은 이어받지 않는다 (parseConstraints «모순» 주석).
  const srcBudget = !src.conflict && (src.budgetMax || src.budgetMin);

  // 예산은 한 덩어리로 갈아탄다. 상한만 새로 말했는데 옛 하한이 남으면
  // 있지도 않은 구간이 만들어진다.
  if (srcBudget) {
    out.budgetMax = src.budgetMax || 0;
    out.budgetMin = src.budgetMin || 0;
    out.budgetSoft = !!src.budgetSoft;
    out.budgetSaid = src.budgetSaid || src.budgetMax || src.budgetMin || 0;
    out.budgetRelax = !!src.budgetRelax;
    out.budgetStrict = !!src.budgetStrict;
    out.budgetQuoted = !!src.budgetQuoted;
    // 새 금액을 말했으면 옛 완화 고지는 더 이상 사실이 아니다.
    out.budgetNotice = '';
  } else if (src.budgetStrict && out.budgetMax) {
    /*
     * 금액 없이 "예산은 꼭 지켜줘" 라고만 했다 — 앞에서 말한 금액을 여유 없는 상한으로 굳힌다.
     * 완화(RELAX)의 반대 방향이다. 말한 금액(budgetSaid)이 그대로 상한이 된다.
     */
    if (out.budgetSoft || out.budgetRelax) {
      out.budgetMax = out.budgetSaid || out.budgetMax;
      out.budgetSoft = false;
      out.budgetRelax = false;
      out.budgetNotice = '';
    }
    out.budgetStrict = true;
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
    out.budgetStrict = false;
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
  if (src.allowGaming === true) out.avoidGaming = false;
  else if (src.avoidGaming === true) out.avoidGaming = true;
  delete out.allowGaming;
  return out;
}

/** 조건이 하나라도 있는가 (프롬프트에 실을 값이 있는가). */
function hasConstraints(c) {
  if (!c) return false;
  return !!(c.budgetMax || c.budgetMin || c.recipient || c.gift
    || c.priority || c.brand || c.useCase || c.avoid || c.avoidGaming);
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

/*
 * 상품명 커버리지 감점 (rankItems 의 «얼마나 담았는가» 주석).
 *   COVERAGE_STRONG  이 이상 담은 후보가 하나라도 있어야 감점을 건다
 *   COVERAGE_OK      이 이상이면 감점하지 않는다 — "노이즈 캔슬링"/"노이즈캔슬링"
 *                    같은 표기 차이(0.93)로 본품끼리 순서가 뒤집히지 않게
 *   COVERAGE_GAP     커버리지 0 일 때의 감점. 최저가 가점(14)보다 크다
 * 커버리지 0.25(토큰 하나만 맞음)면 −23, 0.667 이면 −10 이다.
 */
const COVERAGE_STRONG = 0.9;
const COVERAGE_OK = 0.8;
const COVERAGE_GAP = 30;

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
  let list = (items || []).filter(Boolean);
  const cons = c || {};
  let searchHelpers = null, intentContext = null;
  if (query) {
    try {
      searchHelpers = require('./_search');
      list = searchHelpers.filterMainProductCandidates(query, list).items;
      intentContext = searchHelpers.productIntentContext(query, list.map(it => it && it.title));
    } catch (_e) {
      searchHelpers = null;
      intentContext = null;
    }
  }
  if (list.length <= 1) {
    list.forEach(it => { if (!it.fit) it.fit = ''; if (!it.notes) it.notes = []; });
    return list;
  }

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

  // 일반 검색의 핵심 명사 판정을 AI 경로에도 반영한다.
  // '에어팟 최저가'의 케이스가 가격 가점만으로 본품을 앞서지 않게 하고,
  // 사용자가 '에어팟 케이스'를 찾을 때는 accessory intent를 그대로 보존한다.
  if (searchHelpers && intentContext) {
    list.forEach(it => {
      const focus = searchHelpers.accessoryFocus(intentContext, it && it.title);
      if (focus.penalty > 0) {
        it._score -= focus.penalty;
        it._accessoryPenalty = focus.penalty;
      }
    });

    /*
     * 상품명이 검색어를 «얼마나» 담았는가 (2026-10-04 운영 실측).
     *
     * scoreItem 의 적합도는 토큰이 «하나라도» 맞으면 같은 +12 다. 그래서
     * "에어팟 프로 2 최저가" 에서 «에어로팟 프로»(57,800원, 다른 제품)가 «프로»
     * 하나로 본품(209,000원)과 같은 점수를 받고 최저가 가점(+14)으로 1위가 됐다.
     * 일반 검색과 같은 커버리지(scoreTitle, 0~1)로 덜 담은 만큼 내린다.
     *
     * ★ 후보 중에 검색어를 거의 다 담은 상품(COVERAGE_STRONG 이상)이 있을 때만
     *   건다. 다들 어중간하게 맞으면 비교할 기준이 없어 순서를 건드리지 않는다.
     * ★ 지우지 않는다 — 순서만 내린다. 최저가 가점(최대 14)보다 크게 잡아,
     *   검색어의 절반도 못 담은 상품이 가격만으로 온전한 일치를 넘지 못하게 한다.
     */
    const cover = list.map(it => searchHelpers.scoreTitle(intentContext.analysis, (it && it.title) || '').score);
    if (Math.max.apply(null, cover) >= COVERAGE_STRONG) {
      list.forEach((it, i) => {
        const p = cover[i] >= COVERAGE_OK ? 0 : Math.round((1 - cover[i]) * COVERAGE_GAP);
        if (p > 0) { it._score -= p; it._coveragePenalty = p; }
      });
    }
  }

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

/*
 * 예산 관문 — 추천·카드로 나갈 후보를 예산 안의 것으로 줄인다 (2026-10-22 Codex live 레드팀 BUG-01).
 *
 * rankItems 는 예산을 넘는 상품도 지우지 않고 «예산 초과» 로 표시만 한다(머리 주석). 그 설계는
 * 후보 중 하나라도 예산 안에 있을 때는 무해했지만, 후보가 «전부» 예산을 넘으면 1위가 곧 초과 상품이
 * 됐다. 운영에서 1만원 예산에 19,999,000원 노트북, 3만원 상한에 35,000원 촬영 서비스가 «추천» 으로
 * 나갔고, 답변은 예산을 반영했다고 말했다. 모델이 고르든 결정론 답변이 고르든 서버가 마지막에
 * 예산을 확인하지 않았기 때문이다.
 *
 * 그래서 랭킹은 그대로 두고(순서·표시는 같은 규칙) 응답 직전에 후보를 예산 안의 것으로 줄인다.
 *   · budgetMax 는 이미 여유를 담은 값이다 — soft 예산(«10만원 무선 이어폰»)은 1.1배, «정도» 는
 *     1.15배, «조금 넘어도 괜찮아» 는 1.3배까지 남는다. hard 예산·«꼭 지켜» 는 말한 금액 그대로다.
 *   · 가격을 모르는 후보(0원)는 예산 안이라고 확인할 수 없으므로 남기지 않는다.
 *   · 남는 것이 없으면 호출부가 «예산 안의 상품이 없다» 고 말한다. 다른 상품으로 바꿔 권하지 않는다.
 *
 * @returns {{applies:boolean, within:Array, outside:Array}}
 */
function withinBudget(item, c) {
  const p = Math.round(Number(item && item.price) || 0);
  if (!(p > 0)) return false;
  if (c.budgetMax && p > c.budgetMax) return false;
  if (c.budgetMin && p < c.budgetMin) return false;
  return true;
}
function budgetFilter(items, c) {
  const list = (items || []).filter(Boolean);
  if (!c || !(c.budgetMax > 0 || c.budgetMin > 0)) return { applies: false, within: list, outside: [] };
  const within = [];
  const outside = [];
  list.forEach(it => (withinBudget(it, c) ? within : outside).push(it));
  return { applies: true, within, outside };
}

module.exports = {
  parseConstraints, mergeConstraints, hasConstraints, constraintLine,
  rankItems, scoreItem, budgetFilter, withinBudget, PRIORITY_LABEL
};
