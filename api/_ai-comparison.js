'use strict';
/*
 * Explicit two-product comparisons. Only the user's own two named products
 * are split into independent server searches; do not treat a joint phrase as
 * one model identity. No client-supplied price or product is an input.
 */
/*
 * 비교 문형 앞뒤의 사람 말을 걷고, 표준 꼴 "A와 B 비교" 로 맞춘다 (2026-11-02 Production 실측).
 *   "주변에서 다들 좋다길래 아이폰 17이랑 아이폰 17 프로 중에 가성비 좋은 쪽은?" → 왼쪽에 상황 설명이 붙었다
 *   "갤럭시 버즈 FE 살까 에어팟 4 살까" · "A vs B 뭐가 더 나아?" · "B 대신 A 사도 후회 안 할까" → 문형을 몰라 한 검색어가 됐다
 */
function normalizeComparisonForm(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  const P = '(.{2,60}?)';
  const forms = [
    new RegExp(`^${P}\\s*살까\\s*,?\\s*${P}\\s*살까`),
    new RegExp(`^${P}\\s+대신\\s+${P}\\s*(?:사도|살까|사면|골라|고르|어때)`),
    new RegExp(`^${P}\\s*에서\\s+${P}\\s*로\\s*(?:넘어|바꿀|갈아)`),
    new RegExp(`^${P}\\s*(?:vs\\.?|versus)\\s*${P}\\s*(?:뭐|어느|어떤|나아|좋|비교|$)`, 'i'),
    new RegExp(`^${P}\\s*,\\s*${P}\\s+(?:둘\\s*다|어느|중\\s|뭐가)`),
    new RegExp(`^${P}(?:이랑|랑|와|과|하고)\\s+${P}\\s*(?:뭐가|어느|어떤|나란히|판매가|가격\\s*차이)`),
    new RegExp(`^${P}\\s*,\\s*${P}\\s*(?:얼마\\s*차이|가격\\s*차이|판매가)`),
    new RegExp(`^${P}(?:와|과|랑|이랑)\\s+${P}\\s*(?:의|이|가)?\\s*가격\\s*차이`)
  ];
  for (const re of forms) {
    const m = re.exec(s);
    if (m) return `${m[1].trim()} 와 ${m[2].replace(/\s*(?:의|중|중에|중에서)$/, '').trim()} 비교해줘`;
  }
  return s;
}
const COMPARE_LEAD_RE = /^(?:[^.!?,]{0,40}?(?:길래요?|는데요?|인데요?)[.,!]?\s+|[^.!?,]{0,40}?[요다][.,!]\s+|(?:가격만\s*놓고\s*보면|대학생\s*입장에서|선물용이면|솔직히|둘\s*다\s*\S+\s*맞췄을\s*때|\S+\s*기준으로)\s+)+/;

function parseComparison(question) {
  let s = String(question || '').trim().slice(0, 240);
  // 비교 요구가 앞 문장에 있으면 그 문장이 본론이다 ("A하고 B 비교해주세요. 장단점도 알려줘.").
  const lead = COMPARE_LEAD_RE.exec(s);
  if (lead && !/비교|vs|살까|차이|대신/i.test(lead[0])) s = s.slice(lead[0].length);
  s = normalizeComparisonForm(s);
  // A short conversational lead-in may precede a fully named comparison.
  // Keep the whitelist narrow so arbitrary prose is not converted into a pair.
  s = s.replace(/^둘\s*중\s*고르기\s*어렵네[.!?。]\s*/i, '');
  s = s.replace(/^(?:(?:혹시|한번|이번에는|이번엔|그럼|그러면)\s+)+/, '');
  // Question marks inside a two-clause comparison are punctuation, not part of
  // the product name: "A / B 중 어느 쪽? 두 제품만 비교해 줘".
  s = s.replace(/[?!。;]/g, ' ').replace(/\s+/g, ' ').trim();
  // Negated alternatives such as a gaming exclusion plus a budget comma are
  // one recommendation, not two named products. Require an explicit compare
  // cue before interpreting a negated phrase as a pair.
  if (/(?:말고|빼고|제외하고)/.test(s)
      && !/(?:비교|차이|둘\s*중|두\s*(?:제품|모델|상품))/.test(s)) return null;
  // Keep this intentionally narrow. Ordinary recommendations and comparisons
  // between attributes must continue to use the regular concierge route.
  // Natural shopping comparison forms. The right-hand description ends
  // before the comparison instruction; never search for the entire sentence.
  // "A 아니면 B?" · "A 대 B" · "A, B 중에 하나만" · "A하고 B 차이가 뭐야" 도 두 상품 비교다 (2026-10-26 홀드아웃).
  const m = /^(.{2,75}?)(?:\s*(?:와|과|랑|하고)\s+|\s+vs\.?\s+|\s+versus\s+|\s+아니면\s+|\s+대\s+|\s+또는\s+|\s+혹은\s+|\s*\/\s*|\s*,\s+)(.{2,75}?)\??\s+(?:비교(?:해\s*(?:줘|주세요|줄래|볼래|봐|보자)|해|해볼래|해주세요|해줘)?|중(?:에서|에)?\s*(?:뭐|뭘|무엇|어떤|어느|가성비|가격|더|살|고를|좋|낫|추천|하나)(?:\s*쪽)?|(?:가격|성능|가성비|장단점|기능)\s*(?:차이|비교)|차이(?:가|는|점|를)?\s*(?:알려|설명|정리|있|뭐|어때|궁금)|(?:함께\s*)?(?:골라|선택)(?:\s*(?:줘|주세요|줄래|봐))?).*$/i.exec(s);
  if (!m) return null;
  let left = m[1].trim(), right = m[2].trim().replace(/\?+$/, '').replace(/\s+중$/, '').replace(/(?<=[0-9A-Za-z가-힣]{2})의$/, '');
  // Sony WH-1000XM is an over-ear headphone family. A bare WH model anchor is
  // sufficient to identify that type; it must not be treated as an unknown
  // generic token (or conflated with the similarly named WF earbuds).
  const expandSonyHeadphone = term => /^wh\s*[- ]?\s*1000xm\d+[a-z0-9-]*$/i.test(term)
    ? `소니 헤드폰 ${term}` : term;
  left = expandSonyHeadphone(left);
  right = expandSonyHeadphone(right);
  // The user can put the operation description before "비교":
  // "A와 B를 가격 포함해서 나란히 비교해 줘". It is not part of the product.
  right = right.replace(/(?:을|를)\s*(?:(?:확인된\s*)?가격(?:을|과)?\s*(?:포함(?:해서|하여)?|함께)?\s*)?(?:나란히\s*)?$/i, '').trim();
  right = right.replace(/\s+중\s*(?:에서|에)?\s*(?:뭐|뭘|무엇|어떤|어느|가성비|가격|더|살|고를|좋|낫|추천|하나)(?:\s*쪽)?(?:\s+[\s\S]*)?$/i, '').trim();
  right = right.replace(/,?\s*(?:확인된\s*)?(?:가격|성능|사양)(?:을|를|과)?\s*(?:포함(?:해서|하여)?|함께)?\s*$/i, '').trim();
  right = right.replace(/\s+두\s*(?:모델|제품|상품)(?:의)?\s*(?:장단점|차이|가격|성능)?\s*$/i, '').trim();
  // "그램16이랑" · "갤럭시탭이랑" — '이랑' 의 '이' 는 받침 있는 말 뒤에만 붙는다. 받침 없는 말 뒤의 '이' 는
  // 이름의 일부다("스페이스그레이랑" · "와이파이랑"). 그대로 두면 "그램16이" 로 검색됐다 (2026-10-26).
  if (/이$/.test(left) && left.length > 2 && hasBatchim(left[left.length - 2])) left = left.slice(0, -1);
  // 앞에 붙은 예산·용도는 검색어가 아니다 — "50만원 이하로 아이패드" · "학생용으로 그램". 예산은 핸들러가
  // 질문 전체에서 읽어 두 쪽 모두에 건다(api/ai.js 비교 경로).
  left = left
    .replace(/^(?:예산\s*(?:은|는)?\s*)?\d[\d,]*(?:\.\d+)?\s*(?:만|천|억)?\s*원?\s*(?:대|이하|이내|미만|까지|정도|안팎|선)?\s*(?:로|으로|에서|의|에|인|짜리)?\s+/, '')
    .replace(/^[가-힣]{1,8}용(?:으로|으로는|이면|인|에)?\s+/, '')
    .trim();
  // Korean object particles before "비교해줘" are grammar, not part of
  // the product family: "아이패드랑 갤럭시탭을 비교해줘".
  // Restrict to a final particle on Hangul words to preserve model codes.
  right = right.replace(/([가-힣]{2,})(?:을|를)$/, '$1');
  // "A랑 B 둘 중 가성비" 의 «둘» 은 비교 대상을 세는 말이다 — «아디다스 삼바 둘» 로 검색됐다 (2026-10-26).
  right = right.replace(/\s+(?:둘|두\s*(?:개|제품|상품|모델))(?:\s*다)?$/, '').trim();
  // Broad family aliases: the marketplace title may be Korean even when
  // the user asks for the family in English.
  if (/^ipad$/i.test(left)) left = '아이패드';
  if (/^ipad$/i.test(right)) right = '아이패드';
  if (/^galaxy\s*tab$/i.test(left)) left = '갤럭시탭';
  if (/^galaxy\s*tab$/i.test(right)) right = '갤럭시탭';
  // Common family names may be written without a numeric model anchor.
  const knownFamily = /^(?:아이패드|갤럭시\s*탭|갤럭시탭|ipad|galaxy\s*tab)$/i;
  // "버즈3 프로 블랙과 화이트" · "에어팟 맥스 실버랑 스페이스그레이" explicitly name two color
  // options of the same series, not the generic product "화이트".
  const COLOR_WORD = /(스페이스\s*그레이|블랙|검정|화이트|흰색|실버|그레이|네이비|블루|레드|핑크|그린|골드|퍼플|베이지|아이보리|브라운|오렌지|옐로우|민트|미드나이트|스타라이트)/;
  const onlyColor = new RegExp('^' + COLOR_WORD.source + '(?:\\s*(?:색|색상|컬러))?$');
  if (onlyColor.test(right) && COLOR_WORD.test(left)) {
    right = left.replace(COLOR_WORD, right.replace(/\s*(?:색|색상|컬러)$/, ''));
  }
  if (!left || !right || left === right || left.length > 75 || right.length > 75) return null;
  // Reject sentence fragments and meta-instructions: a particle in "검색 결과"
  // must never split an unrelated prompt into two shop searches.
  if (/[.!?。;:<>]/.test(left + right)) return null;
  const AIID = require('./_aiidentity');
  // 브랜드·계열 이름도 상품 지목이다 — "다이슨 V15랑 비스포크 제트" · "에어포스1이랑 아디다스 삼바" (2026-10-26).
  const named = term => AIID.productEvidence(term) > 0 || /[0-9]/.test(term) || /[A-Za-z]{2,}/.test(term) || knownFamily.test(term) || AIID.namesBrand(term);
  // 한쪽이 분명한 상품이면 다른 쪽은 사전에 없는 이름이어도 된다("다이슨 슈퍼소닉이랑 에어랩") — 서술어가 섞인 조각만 거른다.
  const plainName = term => /^[가-힣A-Za-z0-9\s+-]{2,30}$/.test(term) && term.trim().split(/\s+/).length <= 4
    && !/(?:하고|해서|있는|없는|좋은|가격|결과|추천|검색|조건|상품|제품|옵션|성능|사양|기능|장단점|디자인|용량|색상|품질)/.test(term);
  const compareCue = /비교|\bvs\b|versus|살까|중(?:에|에서)?\s|차이|나아|대신|넘어갈|판매가/i.test(String(question));
  const accepted = (named(left) && named(right))
    || (compareCue && ((named(left) && plainName(right)) || (named(right) && plainName(left))));
  if (!accepted) return null;
  // "노트북과 태블릿 차이 알려줘" · "무선 이어폰이랑 유선 이어폰 비교" 는 종류를 묻는 지식 질문이다 —
  // 각 종류의 가장 싼 판매 글 두 개의 가격 차이로 답하면 질문에 답하지 않은 것이다. 일반 경로로 보낸다.
  if (bareCategory(left, AIID) || bareCategory(right, AIID)) return null;
  return [left, right];
}

/* 종류명과 꾸밈말만으로 된 말인가 ("노트북" · "무선 이어폰" · "로봇청소기"). 모델·계열·브랜드가 있으면 아니다. */
const CATEGORY_MODIFIER = /^(?:무선|유선|블루투스|게이밍|게임용|노이즈캔슬링|일반|휴대용|소형|대형|미니|전기|로봇|스마트|가정용|업소용|접이식|오픈형|커널형|넥밴드|저가|고가|싼|비싼|좋은)$/;
function bareCategory(term, AIID) {
  const words = String(term || '').trim().split(/\s+/).filter(Boolean)
    .map(w => w.replace(/(?:은|는|이|가|을|를|와|과|랑|이랑)$/, m => (w.length - m.length >= 2 ? '' : m)));
  // 아이패드·갤럭시탭은 종류명 목록(_aiidentity CATEGORY_NOUNS)에도 있지만 상품 계열 이름이다.
  const kind = w => AIID.categoryNounOf(w) && !/^(?:아이패드|갤럭시탭)$/.test(w);
  return words.length > 0 && !/[0-9a-z]/i.test(term)
    && words.some(kind)
    && words.every(w => kind(w) || CATEGORY_MODIFIER.test(w));
}

/* 한글 음절·숫자의 받침 유무 — '이랑/랑' 같은 조사 꼴을 가린다. 숫자는 한국어로 읽은 소리로 본다(6=육). */
function hasBatchim(ch) {
  const c = String(ch || '');
  if (/^[0136780]$/.test(c)) return true;     // 영·일·삼·육·칠·팔 (0 은 «영»)
  if (/^[2459]$/.test(c)) return false;       // 이·사·오·구
  const code = c.charCodeAt(0) - 0xAC00;
  return code >= 0 && code <= 11171 && code % 28 !== 0;
}


/**
 * Contextual references to a pair are resolved ONLY with a valid signed
 * conversation state. A bare "그거" is singular/ambiguous and must not
 * silently pick one side.
 */
function isPairFollowup(question) {
  const q = String(question || '').trim().slice(0, 240);
  if (!q || q.length > 180) return false;
  // A new explicitly named product is not a reference to the signed pair.
  if (require('./_aiidentity').productEvidence(q) > 0) return false;
  return /(?:둘\s*중|두\s*(?:개|제품|상품|모델)|이\s*둘|그\s*둘|둘\s*다|둘\s*의|둘\s*을|둘\s*이|각각|앞(?:에서)?\s*비교한|아까\s*비교한|방금\s*비교한|비교했던|그\s*중|어느\s*쪽(?:이|은)?\s*(?:더\s*)?(?:저렴|싸|싼|비싸|가격))/.test(q);
}

/*
 * A matching family name in a third-party listing does not establish that the
 * merchant sells the device itself. Live Production regression (2026-11-01):
 * "[해외] 삼성 갤럭시 탭 A 8.0 T380 T385 터치 스크린 ...용 8인치 유리"
 * at 15,700 KRW passed exact-family identity and was compared against an
 * actual 621,300 KRW iPad. The cheap listing sold replacement glass.
 *
 * Apply this after the independent family query and before exact-price
 * selection, including signed-pair rechecks. Only reject unambiguous sale-of-
 * replacement-part wording: "touchscreen tablet" alone is a device feature,
 * not a reason to reject an otherwise genuine tablet.
 */
function isComparableOffer(query, title) {
  const q = String(query || '');
  const s = String(title || '').normalize('NFKC');
  const tablet = /아이패드|ipad|갤럭시\s*탭|갤럭시탭|galaxy\s*tab/i.test(q);
  if (!tablet) return true;
  // These are descriptions of an independently sold part, not the tablet.
  const replacement = /(?:교체용|수리용|교체\s*부품|액정\s*교체|스크린\s*교체|디스플레이\s*교체|호환\s*(?:부품|액정|터치\s*패널)|보호\s*(?:필름|유리)|강화\s*유리\s*(?:필름|보호)|(?:lcd|oled)\s*(?:screen|replacement)|replacement\s*(?:screen|glass|digitizer)|touch\s*screen.{0,95}\bglass\b|터치\s*(?:스크린|패널|액정).{0,95}(?:유리|글라스)|(?:디지타이저|digitizer).{0,95}(?:유리|glass)|(?:유리|glass).{0,30}(?:터치\s*스크린|액정))/i;
  // A marketplace offer may carry the requested family name merely to say
  // that a case, keyboard, charger or screen protector fits that tablet.
  // Such prices are never comparable to a device's sale price. Be deliberately
  // conservative for pair comparisons; a bundled accessory listing is less
  // useful than a verifiable standalone tablet.
  const soldAccessory = /(?:키보드|keyboard|북\s*커버|북커버|\bcover\b|케이스|\bcase\b|보호\s*필름|보호필름|액정\s*보호|액정보호|스크린\s*프로텍터|screen\s*protector|태블릿\s*거치대|태블릿케이스|tablet\s*case|전용\s*스탠드|충전\s*케이블|charging\s*cable|펜촉|터치\s*펜\s*(?:전용|호환)|터치패드\s*DeX키)/i;
  // Real Production QA (2026-11-01): an iPad PDF budget template priced at
  // 13,000 KRW became the "iPad" in a comparison. A product-family name
  // does not prove that the listing actually sells that device. Reject
  // standalone digital goods, instruction, services and carrying accessories.
  const nonDevice = /(?:\bpdf\b|\be-?book\b|전자책|굿노트|goodnotes|디지털\s*(?:파일|상품|다운로드)|다운로드\s*파일|가계부|플래너|속지|템플릿|배경화면|스티커|폰트|글꼴|아이패드\s*(?:드로잉|수채화).{0,45}(?:배우기|클래스|강의)|(?:기초부터|왕초보).{0,50}배우기|원데이\s*클래스|온라인\s*(?:강의|클래스)|강의\s*(?:수강권|영상)|(?:가이드|입문)\s*(?:북|책)|(?:교재|강좌|클래스|수업|투어|여행\s*상품)|스타일러스|펜슬|pencil|펜촉|파우치|수납\s*가방|태블릿\s*가방|태블릿\s*파우치|이북\s*리더기\s*파우치|\b(?:stylus|pouch|sleeve|handbag)\b|\b(?:for\s+ipad|for\s+galaxy\s+tab)\b)/i;
  if (replacement.test(s) || soldAccessory.test(s) || nonDevice.test(s)) return false;

  // Positive evidence as well as negative exclusions: do not equate a title
  // that merely mentions a tablet family with an actual saleable device.
  // A bare family mention without a hardware/model identifier is uncertain.
  const deviceEvidence = /(?:태블릿\s*(?:pc)?|\btablet\s*(?:pc)?\b|(?:공기계|본체)|\b\d{2,4}\s*(?:gb|tb)\b|\bsm[-_\s]?[a-z]\d{3,4}\b|\b(?:m[1-9]|a\d{2,4})\s*(?:모델|칩|프로|pro|\b)|(?:아이패드|ipad)\s*(?:프로|pro|에어|air|미니|mini)?\s*\d{1,2}\b|(?:갤럭시\s*탭|갤럭시탭|galaxy\s*tab)\s*[sa]\d{1,2}\b|\d{1,2}\s*세대\b)/i;
  return deviceEvidence.test(s);
}

/** The cheapest exact offer for one side. `accept` narrows the exact offers (budget gate in api/ai.js). */
function isCashPriceListing(title) {
  const t=String(title||'');
  // A monthly rental installment or deposit is not the full product price.
  // "무이자 할부 가능" without a monthly amount is only a financing feature.
  return !/(?:월\s*\d[\d,]*(?:\.\d+)?\s*(?:만|천)?\s*원|매월\s*\d[\d,]*(?:\.\d+)?\s*(?:만|천)?\s*원|월납\s*\d|월요금\s*\d|월렌탈료|렌탈료\s*\d|예약금\s*\d|계약금\s*\d|보증금\s*\d|선납금\s*\d|월\s*구독료|(?:렌탈|대여|임대|구독\s*상품)|통신사\s*(?:신규\s*가입|개통)|신규\s*가입\s*할부\s*개통|번호\s*이동\s*(?:조건|시|개통)|요금제\s*(?:가입|유지|약정)|공시\s*지원금|약정\s*시\s*\d)/i.test(t);
}
/*
 * Read only conditions literally stated in the offer title. No title proves
 * domestic certification, delivery lead time or the actual checkout amount.
 * Unknown conditions remain unknown; do not describe them as domestic/new.
 */
function purchaseConditionFlags(title) {
  const t=String(title || '').normalize('NFKC');
  return {
    imported: /(?:\[해외\]|해외판|해외직구|해외\s*구매|병행수입|글로벌\s*버전|글로벌판|일본판|미국판|아랍어\s*(?:버전|판)|영문\s*버전|international\s*version|global\s*version)/i.test(t),
    preorder: /(?:예약\s*판매|사전\s*예약|프리오더|pre[- ]?order)/i.test(t),
    used: /(?:중고|리퍼|리퍼비시|재생\s*제품|refurbished|refurb\b)/i.test(t)
  };
}

function conditionCaveat(title, position) {
  const flags=purchaseConditionFlags(title);
  const reasons=[];
  if (flags.imported) reasons.push('해외판·언어 버전·병행수입 표기가 있어 국내 제품과 구성·보증·언어 설정이 다를 수 있어요');
  if (flags.preorder) reasons.push('예약판매 상품이라 일반 재고상품과 수령 일정이 다를 수 있어요');
  if (flags.used) reasons.push('중고·리퍼 표시가 있어 새 상품과 상태·보증을 구분해야 해요');
  return reasons.length ? position+'번 상품 확인 사항: '+reasons.join('. ')+'.' : '';
}
function isTabletRequest(q) {
  return /(?:아이패드|ipad|갤럭시\s*탭|갤럭시탭|galaxy\s*tab)/i.test(String(q||''));
}
function specificallyAskedForNonstandard(q) {
  return /(?:해외판|해외직구|병행수입|글로벌\s*버전|일본판|미국판|아랍어\s*(?:버전|판)|예약\s*판매|사전\s*예약|중고|리퍼)/i.test(String(q||''));
}
function titleConditionRisk(title) {
  const f=purchaseConditionFlags(title);
  return (f.imported ? 2 : 0)+(f.preorder ? 1 : 0)+(f.used ? 2 : 0);
}

function listExact(raw, query, AIID, normalize, accept) {
  const candidates = (Array.isArray(raw) ? raw : [])
    .filter(x => x && x.productId && Number.isSafeInteger(Number(x.lprice)) && Number(x.lprice) > 0)
    // Reject non-devices and non-cash offers BEFORE limiting candidates.
    // Otherwise 40 cheap accessories can hide a real tablet further down.
    .filter(x => isComparableOffer(query, x.title) && isCashPriceListing(x.title))
    .map(x => {
      const n = normalize(x);
      Object.defineProperty(n, '_compareRaw', { value: x });
      return n;
    }).filter(n => {
      // A Coupang product page is not a saleable option. Without the exact
      // vendorItemId, neither the price nor the card can represent that option
      // in a comparison. Other providers do not have Coupang option IDs.
      const coupang = n.isCoupang === true || require('./_aicontext').isCoupangMall(n.mallId || n.mall);
      return !!n.productId && (!coupang || !!n.vendorItemId);
    });
  if (!candidates.length) return [];
  const contract = AIID.buildContract({
    query, userText: query, titles: candidates.map(x => x.title)
  });
  const gate = AIID.partition(candidates, contract);
  if (gate.state !== 'EXACT') return [];
  const exact = gate.items.filter(x => x._identity && x._identity.tier === AIID.TIER.EXACT
    && (typeof accept !== 'function' || accept(x)));
  // When the user did not request an overseas, pre-order or used variant,
  // avoid presenting its cheaper displayed amount as the regular device
  // price if an otherwise exact offer without such flags is available.
  // The explicit request is the sole exception, and normal prices are still
  // sorted within each risk tier.
  const ordinaryTablet=isTabletRequest(query)&&!specificallyAskedForNonstandard(query);
  exact.sort((a,b) => (ordinaryTablet ? titleConditionRisk(a.title)-titleConditionRisk(b.title) : 0)
    || a.price-b.price);
  // Apply exact-model verification before the candidate limit. Ranking still
  // bounds the final selection to 40 without hiding a later exact model.
  return exact.slice(0, 40);
}
function pickExact(raw, query, AIID, normalize, accept) {
  return listExact(raw, query, AIID, normalize, accept)[0] || null;
}

// Broad *families* are not a specific model. A cheapest-offer-vs-cheapest-offer
// comparison often pairs an old used entry model against a new flagship.
// Choose offers with similar observed price and listing condition instead.
// Similar *prices* cannot establish equivalent performance or specifications.
function isBroadTabletPair(pair) {
  const aliases = new Set(['아이패드','ipad','갤럭시탭','galaxytab']);
  return Array.isArray(pair) && pair.length === 2
    && pair.every(n => aliases.has(String(n || '').toLowerCase().replace(/\s+/g,'')))
    && String(pair[0]).toLowerCase() !== String(pair[1]).toLowerCase();
}
function pickAlignedPair(raws, queries, AIID, normalize, accept) {
  if (!isBroadTabletPair(queries) || !Array.isArray(raws) || raws.length !== 2) return null;
  const left=listExact(raws[0],queries[0],AIID,normalize,accept).slice(0,16);
  const right=listExact(raws[1],queries[1],AIID,normalize,accept).slice(0,16);
  if (!left.length || !right.length) return null;
  const all=left.concat(right).map(x=>x.price).sort((a,b)=>a-b);
  const median=all[Math.floor((all.length-1)/2)];
  const condition=t=> purchaseConditionFlags(t).used?'used':'unspecified';
  let best=null,bestScore=Infinity;
  for(const a of left)for(const b of right){
    // Compare prices from the same observed purchasing conditions.
    const ratio=Math.abs(Math.log(a.price/b.price));
    const level=Math.abs(Math.log(Math.sqrt(a.price*b.price)/median));
    const mismatch=condition(a.title)===condition(b.title)?0:0.7;
    // A close amount alone is not a fair comparison if it is an import,
    // preorder or used unit. Prefer standard listings when present, but
    // never invent a domestic guarantee for an unmarked listing.
    const risk=titleConditionRisk(a.title)+titleConditionRisk(b.title);
    const score=ratio+0.35*level+mismatch+0.55*risk;
    if(score<bestScore){bestScore=score;best=[a,b];}
  }
  return best;
}

/** 조건 객체의 예산을 사람이 읽는 말로 ("50만원 이하" · "10만~20만원"). */
function budgetLabel(c) {
  const won = n => { const v = Math.round(n); return v % 10000 === 0 ? (v / 10000).toLocaleString('ko-KR') + '만원' : v.toLocaleString('ko-KR') + '원'; };
  const max = Math.round(Number(c && (c.budgetSaid || c.budgetMax)) || 0);
  const min = Math.round(Number(c && c.budgetMin) || 0);
  if (min && max) return won(min) + '~' + won(max);
  if (max) return won(max) + ' 이하';
  if (min) return won(min) + ' 이상';
  return '';
}

// Compare only attributes explicitly printed in both verified listing titles.
// Keep them as listing text; do not infer RAM, performance, quality, or compatibility.
function listedTitleDifferences(first, second) {
  const patterns = [
    /\b\d+(?:\.\d+)?\s?(?:GB|TB|L|인치|형|mAh|W)\b/gi,
    /\b(?:i[3579]|M[1-9](?:\s?Pro)?|A\d{1,2}|S\d{1,2}|[A-Z]{2,}\d{2,}[A-Z0-9]*)\b/g,
    /울트라\s?[3579]|Wi-?Fi|LTE|5G/gi
  ];
  const tokens = title => {
    const source = String(title || '');
    return [...new Set(patterns.flatMap(re => [...source.matchAll(new RegExp(re.source, re.flags))].map(m => m[0].replace(/\s+/g, ' ').trim())))];
  };
  const a = tokens(first), b = tokens(second);
  const differs = (left, right) => left.some(x => !right.some(y => y.toLowerCase() === x.toLowerCase()));
  if (!differs(a, b) && !differs(b, a)) return '';
  const fmt = xs => xs.length ? xs.join(', ') : '상품명에 구분 표기 없음';
  return `검색 결과 상품명에 표기된 차이(사양 우열을 뜻하지 않음): 1번에는 ${fmt(a)}; 2번에는 ${fmt(b)}.`;
}

/**
 * opts.budgetLabel     — 비교에 건 예산 ("50만원 이하")
 * opts.missingByBudget — [bool,bool] 정확한 옵션은 있었지만 이번 말의 예산 안에는 없었다
 * opts.overBudget      — [bool,bool] 앞 대화에서 이어진 예산을 넘는다(고르기는 그대로, 사실만 밝힌다)
 */
function formatComparison(requested, offers, source, opts) {
  const o = opts || {};
  const broadTabletFamilies = isBroadTabletPair(requested);
  const won = n => Math.round(n).toLocaleString('ko-KR') + '원';
  const lines = [source === 'catalog'
    ? '앞에서 비교한 두 상품을 다시 확인했어요. 아래는 마지막 수집 시점의 표시 가격이에요.'
    : '두 상품을 각각 검색해 확인했어요. 아래는 검색 결과의 표시 가격이에요.'];
  if (o.partialResults) lines.push('일부 판매처의 응답을 받지 못했어요. 아래 가격은 확인 가능한 판매글에 한정되며 전체 판매처의 최저가나 최종 결제금액이라고 볼 수 없어요.');
  offers.forEach((p,i) => {
    const name = requested[i];
    if (!p) {
      lines.push(o.missingByBudget && o.missingByBudget[i] && o.budgetLabel
        ? `${i+1}. 「${name}」: 예산(${o.budgetLabel}) 안에서 정확히 일치하는 판매 상품을 확인하지 못했어요.`
        : `${i+1}. 「${name}」: 정확히 일치하는 판매 상품과 가격을 확인하지 못했어요.`);
      return;
    }
    const over = o.overBudget && o.overBudget[i] && o.budgetLabel ? ` — 앞에서 말씀하신 예산(${o.budgetLabel})을 넘어요` : '';
    lines.push(`${i+1}. ${p.title} — ${won(p.price)} (${p.mall || '판매처 미확인'})${over}`);
    const note=conditionCaveat(p.title,i+1);
    if (note) lines.push(note);
  });
  if (offers[0] && offers[1]) {
    if (broadTabletFamilies) lines.push('아이패드와 갤럭시탭은 각각 여러 세대·가격대가 있는 제품군이에요. 두 판매처에서 가격과 판매 조건이 비교적 가까운 상품을 골랐지만, 동급 모델인지, 성능이나 사양이 비슷한지 검증한 것은 아니에요. 브랜드 전체의 가격·성능 차이를 뜻하지 않아요.');
    const difference = Math.abs(offers[0].price - offers[1].price);
    if (difference === 0) lines.push('두 상품의 확인된 표시 가격은 같아요.');
    else lines.push(`표시 가격 차이는 ${won(difference)}이고, ${offers[0].price < offers[1].price ? '첫 번째' : '두 번째'} 상품이 더 저렴해요.`);
    const titleDifferences = listedTitleDifferences(offers[0].title, offers[1].title);
    if (titleDifferences) lines.push(titleDifferences);
    if (broadTabletFamilies) {
      lines.push('정확한 구매 비교를 하려면 사용할 용도와 예산을 정한 뒤 비슷한 연식·사양의 모델끼리 비교해야 해요. 현재 확인한 두 판매글만으로 어느 브랜드가 더 저렴하거나 가성비가 높다고 단정할 수 없어요.');
    } else if (difference > 0) {
      lines.push(`선택 기준: 가격을 우선하면 ${offers[0].price < offers[1].price ? '첫 번째' : '두 번째'} 상품이 유리해요. 사양은 위 상품명에 적힌 차이가 용도에 맞는지 확인해 고르고, 실제 성능 우열은 이 정보만으로 판단하기 어려워요.`);
    } else {
      lines.push('선택 기준: 표시 가격이 같으므로 상품명에 적힌 차이가 용도에 맞는지 확인해 고르세요. 실제 성능 우열은 이 정보만으로 판단하기 어려워요.');
    }
  } else {
    lines.push('비교 대상 중 하나 이상을 확인하지 못해서 가격 차이나 가성비 우열을 단정할 수 없어요.');
  }
  lines.push('표시 가격은 최종 결제가가 아니며 실제 결제 금액과 다를 수 있어요. 쿠폰·카드 혜택, 옵션과 배송비, 해외판 여부 및 판매 조건을 결제 화면에서 확인해 주세요.');
  return lines.join('\n\n');
}
module.exports = { parseComparison, isPairFollowup, pickExact, pickAlignedPair, isBroadTabletPair, isComparableOffer, isCashPriceListing, purchaseConditionFlags, conditionCaveat, formatComparison, budgetLabel, listedTitleDifferences };
