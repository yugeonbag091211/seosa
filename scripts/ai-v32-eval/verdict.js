'use strict';
// AI v3.2 evaluator (v2) — INDEPENDENT of the system under test.
//
// It deliberately does NOT import anything from api/*: the v3.1 evaluator
// reused the server's own taxonomy/identity modules, so both shared the same
// blind spots (e.g. '기타' rejected every guitar in both, and N193 was judged
// with the server's wireless rule). Everything here is authored separately and
// is stricter in three ways:
//   1. a request whose product EXISTS in the catalog (label FIND) and gets no
//      card is a FAIL (search failure), not UNVERIFIED;
//   2. "N만원대" is checked as a band, "미만" as exclusive;
//   3. every card records which evidence passed/failed (auditable).
// Correct "no result" (label NO_RESULT) is recorded as UNVERIFIED with
// outcome CORRECT_NO_RESULT — never as PASS.
const norm = s => String(s == null ? '' : s).normalize('NFKC');
const flat = s => norm(s).toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
const won = (n, u) => Math.round(Number(n) * (/만/.test(u) ? 10000 : /천/.test(u) ? 1000 : 1));

function budgetOf(q) {
  const s = norm(q).replace(/(\d),(?=\d{3})/g, '$1');
  let m;
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*(만\s*원|만원|만)?\s*(?:~|-|에서|부터)\s*(\d+(?:\.\d+)?)\s*(만\s*원|만원|만)/)))
    return { min: won(m[1], m[2] || m[4]), max: won(m[3], m[4]) };
  const out = { min: null, max: null, exclusive: false };
  if ((m = s.match(/(\d{1,4})\s*만\s*원?\s*대(?!\s*(?:이하|미만|이상))/))) { out.min = Number(m[1]) * 1e4; out.max = (Number(m[1]) + 1) * 1e4 - 1; }
  const c = [...s.matchAll(/(\d+(?:\.\d+)?)\s*(만\s*원|만원|만|천원|원)\s*(이하|미만|이내|아래|까지|안쪽|안에서|안으로|내로|밖에|이하로)/g)].pop();
  if (c) { out.max = won(c[1], c[2]); out.exclusive = c[3] === '미만'; }
  const f = [...s.matchAll(/(\d+(?:\.\d+)?)\s*(만\s*원|만원|만|천원|원)\s*(?:이상|부터|초과)/g)].pop();
  if (f) out.min = won(f[1], f[2]);
  return out;
}
const REFERS = /(그\s*중|이\s*중|위에서|위의\s*|위\s*(?:상품|제품)|앞서|방금|아까\s*(?:보여|추천))/;
const ONE = /(하나만|하나\s*(?:추천|골라|선택|남겨)|하나를|한\s*개만|딱\s*하나|한\s*제품|최종\s*추천)/;
const USED_REQ = /(중고|리퍼)/;
const USED_NEG = /(중고|리퍼).{0,8}(제외|말고|빼고|아닌|아니|싫)/;
const USED_TITLE = /(중고|리퍼|전시\s*(?:품|상품)|(?:특\s*S|S|A\+?|B)\s*급|모든\s*등급|개봉\s*(?:된\s*)?(?:제품|상품)|반품|단순\s*변심)/i;
// Category nouns (authored separately from the server taxonomy).
const CAT_WORDS = {
  헤드폰: /(헤드폰|헤드셋|headphone|headset)/i,
  이어폰: /(이어폰|이어버드|earbud|에어팟|airpods|버즈|buds|tws|골전도|이어커프|넥밴드)/i,
  태블릿: /(태블릿|아이패드|ipad|갤럭시\s*탭|galaxy\s*tab|패드\s*\d|pad\s*\d|레드미\s*패드|뮤패드|idea\s*tab|아이디어탭|tab\s*[a-z]?\d)/i,
  스마트폰: /(아이폰\s*\d|iphone\s*\d|갤럭시\s*[sazm]\s*\d|galaxy\s*[sazm]\d|폴드|플립|픽셀\s*\d|pixel\s*\d|자급제|공기계|스마트폰|휴대폰|sm-[saf]\d{3})/i,
  노트북: /(노트북|laptop|맥북|macbook|그램|갤럭시\s*북|비보북|vivobook|젠북|아이디어\s*패드|ideapad|씽크\s*패드|thinkpad|인스피론|inspiron|크롬북|chromebook)/i,
  외장하드: /(외장\s*(하드|ssd|hdd)|외장하드|포터블\s*ssd|portable\s*ssd|my\s*passport|\bhdd\b|\bssd\b)/i,
  모니터: /(모니터(?!링)|monitor)/i,
  키보드: /(키보드|keyboard)/i,
  마우스: /(마우스|mouse)/i,
  공기청정기: /(공기\s*청정기|청정기|purifier)/i,
  청소기: /(청소기|vacuum|다이슨\s*v\d|로보락)/i,
  스피커: /(스피커|speaker|사운드바)/i,
  시계: /(워치|watch|시계|스마트\s*밴드)/i,
  기타: /((일렉|어쿠스틱|클래식|통|전자|베이스)\s*기타|통기타|guitar)/i
};
// Words that make a listing an accessory/part/non-device, unless they appear
// in an inclusion or spec context. Independent list.
const PART = /(케이스|커버|필름|강화\s*유리|보호대|거치대|스탠드|받침|지지대|파우치|가방|백팩|스트랩|충전기|충전\s*독|어댑터|케이블|젠더|이어\s*팁|이어\s*패드|키캡|키\s*스킨|팜\s*레스트|필터|먼지\s*봉투|브러시|브러쉬|노즐|걸레|리필|부품|교체용|호환용|교체품|호환품|소모품|액세서리|악세사리|카포|(?<![가-힣])피크(?![가-힣])|교본|페달|이펙터|앰프|리모컨|리시버|동글|유심|(?<![가-힣])렌즈(?![가-힣])|펜슬|s\s*펜|정리대|경사대|세제|매트|마우스\s*패드|헤드\s*(?:교체|단품))/i;
// inclusion within 20 chars ("+ 보관가방 포함"), or a spec/feature right after
const PART_OK_AFTER = /^.{0,20}?(포함|증정|사은품|동봉|세트\s*구성)|^\s*(?:\S{0,6}\s*)?(내장|탑재|장착|별매|지원|h1[0-4]|일체형|겸용|기능|물\s*세척|세척|교체\s*가능)|^\s*(?:로봇|청소기)/i;
const PART_OK_BEFORE = /(mah|대용량|헤파|hepa|h1[0-4]|카본|\d\s*m|\+|2\.4g?)\s*$/i;
function partWord(title, cat) {
  const t = norm(title).split(/\/디지털기기|\/생활\/가전|\/pc\/주변기기/i)[0];
  const re = new RegExp(PART.source, 'gi');
  let m;
  while ((m = re.exec(t)) !== null) {
    const w = m[0].replace(/\s/g, '');
    if (cat === '키보드' && /^(케이스|커버)$/.test(w) && /키보드\s*(케이스|커버)/.test(t)) continue; // keyboard case is a keyboard
    if (cat === '헤드폰' && /^(앰프)$/.test(w) && /앰프\s*내장/.test(t)) continue;
    if (/^동글$/.test(w) && ['이어폰', '헤드폰', '마우스', '키보드'].includes(cat)) continue;   // 2.4G receiver ships with it
    if (/^s펜$/i.test(w) && ['노트북', '태블릿'].includes(cat)) continue;                        // S Pen bundled with device
    if (/^걸레$/.test(w) && cat === '청소기' && /물$/.test(t.slice(0, m.index)) && /청소기/.test(t)) continue; // mopping robot (물걸레)
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 24);
    const before = t.slice(Math.max(0, m.index - 10), m.index);
    if (PART_OK_AFTER.test(after) || PART_OK_BEFORE.test(before)) continue;
    // "<device> … 케이스 세트": a device sold as a set with accessories
    if (/^\s*세트/.test(after) && CAT_WORDS[cat] && CAT_WORDS[cat].test(t.slice(0, m.index))) continue;
    if (/^케이블$/.test(w) && /(usb|c타입|유선)/i.test(t) && CAT_WORDS[cat] && CAT_WORDS[cat].test(t.slice(0, m.index))) continue;
    return m[0];
  }
  return null;
}
// Brands named in the question (independent bilingual list; line names only
// count when they are the product, e.g. "아이패드 키보드 케이스" names a host).
const BRAND_LIST = [['삼성', 'samsung'], ['애플', 'apple'], ['lg', '엘지'], ['소니', 'sony'], ['로지텍', 'logitech'],
  ['씨게이트', 'seagate'], ['wd', '웨스턴디지털', 'western digital'], ['샌디스크', 'sandisk'], ['jbl', '제이비엘'],
  ['샤오미', 'xiaomi'], ['레노버', 'lenovo'], ['로보락', 'roborock'], ['보스', 'bose'], ['다이슨', 'dyson'],
  ['블루에어', 'blueair'], ['asus', '에이수스', '아수스'], ['hp'], ['마샬', 'marshall'], ['쿠쿠', 'cuckoo'], ['위닉스', 'winix'],
  ['브리츠', 'britz'], ['아리아', 'aria'], ['구글', 'google']];
function brandsInQuestion(q) {
  const s = norm(q).toLowerCase();
  return BRAND_LIST.filter(names => names.some(n => new RegExp('(?<![a-z가-힣])' + n.replace(/\s/g, '\\s*') + '(?![a-z])').test(s) &&
    !new RegExp(n + '\\s*(?:은|는)?\\s*(?:제외|말고|빼고|아닌)').test(s)));
}
function hasBrand(title, names) {
  const t = norm(title).toLowerCase();
  return names.some(n => {
    const re = new RegExp('(?<![a-z가-힣])' + n.replace(/\s/g, '\\s*') + '(?![a-z])', 'g');
    let m;
    while ((m = re.exec(t)) !== null) if (!/^\s*(?:\S{0,8}\s*)?(호환|전용|용(?![a-z가-힣])|지원)/.test(t.slice(m.index + m[0].length, m.index + m[0].length + 12))) return true;
    return false;
  });
}
// Model codes typed by the user (Latin + digit), e.g. WF-C700N, T7, V12, G304.
function modelCodes(q) {
  return (norm(q).match(/\b[a-z]{1,5}-?[a-z]?\d{1,4}[a-z]{0,3}\b/gi) || [])
    .map(x => x.toLowerCase().replace(/[^0-9a-z]/g, ''))
    .filter(x => !/^\d+(gb|tb|mm|hz|w|g|k|cm)$/.test(x) && !/^(m\d|s\d{1,2}|a\d{1,2}|z\d|usb\d.*|ps\d)$/.test(x) && x.length >= 2);
}
// Phone/tablet/watch/earbud identities stated by the user (independent).
function identityTerms(q) {
  const s = norm(q).toLowerCase();
  const out = [];
  let m;
  if ((m = s.match(/(아이폰|iphone)\s*(\d{1,2})\s*(e|프로\s*맥스|pro\s*max|프로|pro|플러스|plus|미니|mini)?/))) out.push({ fam: '아이폰|iphone', num: m[2], variant: m[3] || '' });
  if ((m = s.match(/(?:갤럭시|galaxy)\s*s\s*(\d{2})\s*(울트라|ultra|플러스|plus|\+|엣지|edge|fe)?/))) out.push({ fam: '(?:갤럭시|galaxy)\\s*s', num: m[1], variant: m[2] || '' });
  if ((m = s.match(/(?:갤럭시\s*탭|galaxy\s*tab)\s*s\s*(\d{1,2})\s*(fe\s*(?:플러스|plus|\+)|fe|울트라|ultra|플러스|plus)?/))) out.push({ fam: '(?:갤럭시\\s*탭|galaxy\\s*tab|갤탭)\\s*s', num: m[1], variant: m[2] || '' });
  // (a price such as "스마트워치 10만원" is not a watch series)
  if ((m = s.match(/(?:갤럭시|galaxy|레드미|redmi)\s*(?:워치|watch)\s*(\d{1,2})(?!\s*만|\d)\s*(클래식|classic|울트라|ultra|fe|액티브|active)?/))) out.push({ fam: '(?:워치|watch)', num: m[1], variant: m[2] || '' });
  if ((m = s.match(/버즈\s*(\d)\s*(프로|pro|fe)?/))) out.push({ fam: '(?:버즈|buds)', num: m[1], variant: m[2] || '' });
  if ((m = s.match(/(?:갤럭시\s*북|galaxy\s*book)\s*(\d)\s*(프로\s*360|pro\s*360|프로|pro|360|엣지|edge|울트라|ultra)?/))) out.push({ fam: '(?:갤럭시\\s*북|galaxy\\s*book)', num: m[1], variant: m[2] || '' });
  return out;
}
const VARIANT_SYN = { '프로': '(?:프로|pro)', 'pro': '(?:프로|pro)', '플러스': '(?:플러스|plus|\\+)', 'plus': '(?:플러스|plus|\\+)', '+': '(?:플러스|plus|\\+)',
  '울트라': '(?:울트라|ultra)', 'ultra': '(?:울트라|ultra)', '엣지': '(?:엣지|edge)', 'edge': '(?:엣지|edge)', 'fe': 'fe', 'e': 'e',
  '미니': '(?:미니|mini)', 'mini': '(?:미니|mini)', '클래식': '(?:클래식|classic)', 'classic': '(?:클래식|classic)' };
function identityCheck(title, terms) {
  const t = norm(title).toLowerCase();
  for (const it of terms) {
    const re = new RegExp('(?:' + it.fam + ')\\s*' + it.num + '(?!\\d)\\s*(.{0,12})', 'i');
    const m = t.match(re);
    if (!m) return 'identity_missing_' + it.num;
    const after = m[1];
    const v = it.variant.replace(/\s/g, '');
    if (v) {
      const vre = new RegExp('^\\s*' + (VARIANT_SYN[v] || v), 'i');
      if (!vre.test(after) && !(v.startsWith('fe') && /fe/.test(after))) return 'identity_variant_missing_' + v;
      // "프로" requested but the listing is "프로360" (a different 2-in-1 model)
      if (/^(?:프로|pro)$/.test(v) && /^\s*(?:프로|pro)\s*360/i.test(after)) return 'identity_variant_mismatch_pro360';
    } else if (/^\s*(?:프로|pro|플러스|plus|\+|울트라|ultra|엣지|edge|fe|e(?![a-z])|미니|mini|맥스|max|클래식|classic|라이트|lite|액티브|active)/i.test(after)) {
      return 'identity_unexpected_variant';
    }
  }
  return null;
}
function storageOf(text) {
  // "256G" counts; "5G" (network) is below the 32GB floor
  const vals = [...norm(text).toLowerCase().matchAll(/(?<![0-9a-z])(\d{1,4})\s*(tb|테라|gb|기가|g)(?![a-z0-9])/g)]
    .map(m => Number(m[1]) * (/tb|테라/.test(m[2]) ? 1024 : 1)).filter(v => v >= 32);
  return [...new Set(vals)];
}

// A fitted keyboard case can list several *compatible* tablet models with
// the manufacturer name appearing only once: "Galaxy Tab S10 FE / S9 FE / S9".
// Match the requested model token as a distinct compatibility member rather
// than requiring "Galaxy Tab" to repeat before every member.
function compatibleTabletSet(question, title, category) {
  if (category !== '키보드' || !/(?:키보드|keyboard)/i.test(title)) return false;
  const m = norm(question).match(/(?:갤럭시\s*탭|galaxy\s*tab)\s*(s\d{1,2})\s*(fe\s*(?:\+|플러스|plus)?|프로|pro|울트라|ultra)?/i);
  if (!m) return false;
  const model = m[1];
  const variant = (m[2] || '').toLowerCase().replace(/\s/g, '');
  const root = '(?<![a-z0-9])' + model + '\\s*';
  const variants = variant.startsWith('fe')
    ? (/(?:\+|플러스|plus)/.test(variant) ? 'fe\\s*(?:\\+|플러스|plus)' : 'fe(?!\\s*(?:\\+|플러스|plus))')
    : (variant ? '(?:' + variant + ')' : '(?!fe|\\+|플러스|plus|pro|ultra)');
  return new RegExp(root + variants, 'i').test(title);
}
function judgeCards(test, data, previous) {
  const q = test.p, cat = test.cat;
  const cards = Array.isArray(data.cards) ? data.cards : [];
  const b = budgetOf(q);
  const max = test.max != null ? test.max : (b.max != null ? b.max : (test.from ? previous?.state?.maxPrice : null));
  const min = test.min != null ? test.min : (b.min != null ? b.min : (test.from ? previous?.state?.minPrice : null));
  const usedOk = USED_REQ.test(q) && !USED_NEG.test(q) || (test.from && previous?.usedOk);
  const brands = test.from ? [] : brandsInQuestion(q).filter(names => !(/(아이패드|아이폰|맥북|갤럭시)/.test(names.join(' '))));
  const codes = test.from ? [] : modelCodes(q);
  const terms = test.from ? [] : identityTerms(q);
  const reqStorage = test.from ? [] : storageOf(q);
  const wantWireless = /(무선|블루투스|wireless)/.test(q) && !/유선/.test(q.replace(/유무선/g, '')) && ['헤드폰', '이어폰', '마우스', '키보드', '스피커'].includes(cat);
  const wantAnc = /(\banc\b|노이즈\s*캔슬링|노이즈캔슬링)/i.test(q) && !/(anc|노이즈\s*캔슬링).{0,6}(제외|없어도|말고)/i.test(q);
  const compatHost = /(용|호환|연결|맞는|쓸)/.test(q) && /(아이패드|아이폰|맥북|노트북|갤럭시|스마트폰|tv|pc)/i.test(q);
  const checks = [];
  for (const c of cards) {
    const t = String(c.title || ''), errs = [], ok = [];
    if (!t || !(Number(c.price) > 0) || !/^https?:\/\//.test(String(c.link || 'https://x'))) errs.push('invalid_fields');
    if (max != null && (b.exclusive ? Number(c.price) >= max : Number(c.price) > max)) errs.push('over_budget'); else if (max != null) ok.push('budget');
    if (min != null && Number(c.price) < min) errs.push('below_min_budget');
    if (CAT_WORDS[cat] && !CAT_WORDS[cat].test(t) && !codes.some(x => flat(t).includes(x))) errs.push('category_noun_missing'); else ok.push('category');
    // Fresh 2026-11-10 catalog-grounded diagnostic includes literal facet
    // evidence groups preregistered BEFORE the live run. This independent
    // checker does not infer eligibility from the model's selected category.
    if(test.spec?.strict===true || /^[FD]\d{2}$/.test(test.id||'')){
      for(const group of test.spec.all||[]){
        if(!Array.isArray(group)||!group.some(word=>flat(t).includes(flat(word))))
          errs.push('oracle_required_missing:'+String(group?.[0]||'?').slice(0,30));
      }
      for(const prohibited of test.spec.not||[]){
        if(flat(prohibited).length>=3&&flat(t).includes(flat(prohibited)))
          errs.push('oracle_prohibited:'+String(prohibited).slice(0,30));
      }
    }
    const part = partWord(t, cat);
    // 'PC 액세서리' in the descriptive tail of a clearly sold keyboard+
    // mouse combo does not turn the bundle into a replacement accessory.
    const combo=(cat==='키보드'||cat==='마우스') &&
      /(?:키보드\s*(?:및|와|\+|&)?\s*마우스|마우스\s*(?:및|와|\+|&)?\s*키보드)\s*(?:세트|콤보|combo|set)/i.test(t);
    if (part && !(compatHost && cat === '키보드') && !(combo && part==='액세서리'))
      errs.push('accessory_or_part:' + part);
    // Independent, user-grounded attributes absent from generic category
    // checks. Never count an unrelated product line or adult model as a hit.
    if(cat==='공기청정기' && /(?:퓨어\s*쿨|pure\s*cool)/i.test(q) &&
      !/(?:퓨어\s*쿨|pure\s*cool)/i.test(t)) errs.push('named_product_line_missing');
    if(cat==='시계' && /(?:어린이|키즈|아동|유아|초등|주니어|kids?)/i.test(q) &&
      !/(?:어린이|키즈|아동|유아|초등|주니어|kids?|child(?:ren)?)/i.test(t))
      errs.push('kids_watch_evidence_missing');
    if(cat==='마우스' && /(?:왼손(?:잡이|용)?|left[ -]?hand(?:ed)?)/i.test(q) &&
      !/(?:왼손(?:잡이|용)?|양손(?:잡이|용|형)?|좌우\s*대칭|left[ -]?hand(?:ed)?|ambidextrous)/i.test(t))
      errs.push('left_handed_evidence_missing');
    if(cat==='마우스' && /유선\s*[/,·]?\s*무선(?:\s*블루투스)?/i.test(t) &&
      !/(?:유무선|겸용|듀얼\s*모드|dual[ -]?mode)/i.test(t))
      errs.push('connection_variant_price_unverified');
    if ((c.condition === 'used_or_refurbished' || USED_TITLE.test(t)) && !usedOk) errs.push('used_not_requested');
    for (const names of brands) if (!hasBrand(t, names)) errs.push('brand_missing:' + names[0]);
    for (const code of codes) if (!flat(t).includes(code)) errs.push('model_missing:' + code);
    const id = identityCheck(t, terms);
    if (id && !compatibleTabletSet(q,t,cat)) errs.push(id);
    if (reqStorage.length && cat !== '키보드') {
      const s = storageOf(t);
      if (!s.length) errs.push('storage_unverified'); else if (!reqStorage.some(v => s.includes(v)) || s.length > 1) errs.push('storage_mismatch_or_options');
    }
    // wireless evidence is a hard requirement for audio; for mouse/keyboard it is recorded as a warning
    if (wantWireless && !/(무선|블루투스|wireless|bluetooth|\bbt\b|tws|2\.4g|lightspeed)/i.test(t))
      (['헤드폰', '이어폰', '스피커'].includes(cat) ? errs : ok).push(['헤드폰', '이어폰', '스피커'].includes(cat) ? 'wireless_evidence_missing' : 'warn_wireless_evidence_missing');
    // "10평 거실용": a car/mini purifier cannot serve the stated room
    if (cat === '공기청정기' && /(\d{1,2})\s*평/.test(q) && Number(q.match(/(\d{1,2})\s*평/)[1]) >= 8 &&
      /(차량용|자동차용|미니|초소형|휴대용|탁상|데스크탑)/.test(t)) errs.push('coverage_mismatch');
    if (wantAnc && !/(\banc\b|노이즈\s*캔슬링|노이즈캔슬링|액티브\s*노이즈)/i.test(t.replace(/(?:\benc\b|통화)\s*(?:노이즈\s*캔슬링|노이즈캔슬링)/gi, ''))) errs.push('anc_evidence_missing');
    if (/랜덤/.test(t) && !/(색상|컬러)\s*랜덤/.test(t)) errs.push('random_assortment');
    checks.push({ title: t.slice(0, 160), price: c.price, errors: errs, passed: ok });
  }
  return checks;
}
// Expected availability for a follow-up, computed from the previous cards.
function dynamicExpectation(test, previous) {
  const shown = Array.isArray(previous?.cards) ? previous.cards : [];
  if (!shown.length) return 'NO_RESULT';
  const q = test.p, b = budgetOf(q);
  const keep = shown.filter(c => {
    const t = String(c.title || '');
    if (b.min != null && Number(c.price) < b.min) return false;
    if (b.max != null && Number(c.price) > b.max) return false;
    if (/ssd/i.test(q) && !/ssd/i.test(t)) return false;
    if (/(anc|노이즈\s*캔슬링)/i.test(q) && !/(\banc\b|노이즈\s*캔슬링|노이즈캔슬링|액티브\s*노이즈)/i.test(t.replace(/(?:\benc\b)\s*(?:노이즈\s*캔슬링|노이즈캔슬링)/gi, ''))) return false;
    if (/로봇\s*청소기.{0,4}(빼|제외)/.test(q) && /로봇/.test(t)) return false;
    if (/(게이밍|게임용).{0,8}(빼|제외|말고)/.test(q) && /(게이밍|게임용|gaming)/i.test(t)) return false;
    return true;
  });
  return keep.length ? 'FIND' : 'NO_RESULT';
}
function verdict(test, data, previous, label = {}) {
  const causes = [];
  if (!data || data.http !== 200 || !Array.isArray(data.cards))
    return { verdict: 'FAIL', outcome: 'HTTP_OR_JSON_FAILURE', causes: ['HTTP_or_JSON_failure'], cardChecks: [] };
  const cards = data.cards;
  const expect = label.expect === 'DYNAMIC' ? dynamicExpectation(test, previous) : (label.expect || 'FIND');
  if (expect === 'NON_SHOPPING') {
    if (data.stats?.searched || cards.length) return { verdict: 'FAIL', outcome: 'INTENT_ERROR', causes: ['nonshopping_triggered_search'], expect, cardChecks: [] };
    return { verdict: 'PASS', outcome: 'CORRECT_NON_SHOPPING', causes: [], expect, cardChecks: [] };
  }
  if (data.stats?.searched === false && !(test.from && expect === 'NO_RESULT')) causes.push('shopping_request_not_searched');
  if (REFERS.test(test.p) && previous && Array.isArray(previous.state?.presentedProductIds)) {
    const shown = new Set(previous.state.presentedProductIds);
    if (cards.some(c => !shown.has(c.productId))) causes.push('not_among_previously_shown');
  }
  if (ONE.test(test.p) && cards.length > 1) causes.push('more_than_one_for_single_pick');
  if (cards.length > 4) causes.push('too_many_cards');
  const b = budgetOf(test.p);
  if (!test.from && b.max != null && data.state && data.state.maxPrice !== b.max) causes.push('max_budget_state_wrong');
  if (!test.from && b.min != null && data.state && data.state.minPrice !== b.min) causes.push('min_budget_state_wrong');
  const compare = /(비교|vs)/i.test(test.p) && /(와|과|랑|vs)\s/.test(test.p) && !/가격\s*비교/.test(test.p);
  const cardChecks = compare ? [] : judgeCards(test, data, previous);
  if (compare && cards.length && cards.length !== 2) causes.push('comparison_not_two_sides');
  for (const [i, c] of cardChecks.entries()) for (const e of c.errors) causes.push('card' + (i + 1) + ':' + e);
  if (!cards.length) {
    if (expect === 'FIND') { causes.push('MISSED_AVAILABLE'); return { verdict: 'FAIL', outcome: 'MISSED_AVAILABLE', causes, expect, cardChecks }; }
    if (causes.length) return { verdict: 'FAIL', outcome: 'INTENT_ERROR', causes, expect, cardChecks };
    if (expect === 'NO_RESULT') return { verdict: 'UNVERIFIED', outcome: 'CORRECT_NO_RESULT', causes, expect, cardChecks };
    return { verdict: 'UNVERIFIED', outcome: expect === 'NEEDS_VERIFICATION' ? 'INSUFFICIENT_EVIDENCE' : 'UNKNOWN_NO_RESULT', causes, expect, cardChecks };
  }
  if (causes.length) return { verdict: 'FAIL', outcome: cardChecks.some(c => c.errors.length) ? 'WRONG_CARDS' : 'CONSTRAINT_OR_STATE_ERROR', causes, expect, cardChecks };
  if (expect === 'NO_RESULT') return { verdict: 'UNVERIFIED', outcome: 'CARDS_CONTRADICT_ORACLE', causes: ['oracle_expected_no_result'], expect, cardChecks };
  return { verdict: 'PASS', outcome: 'CORRECT_CARDS', causes, expect, cardChecks };
}
module.exports = { verdict, budgetOf, partWord, identityCheck, dynamicExpectation, brandsInQuestion, modelCodes };
