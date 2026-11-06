'use strict';
// AI v3.2 — what is a seller listing actually selling?
//
// Seller titles are the only product evidence we have. Korean (and most
// marketplace) titles are head-final: the sold item is the LAST item noun of
// the title's main phrase, e.g.
//   "LG전자 노트북 바닥 지지대"            → 지지대 (a part, not a laptop)
//   "위닉스 타워XQ500 공기청정기 W5필터 2개" → 필터 (a filter, not a purifier)
//   "아이패드 에어 11 M4 호환 키보드 케이스" → 키보드 케이스 (a keyboard)
// One rule replaces many per-category accessory regexes. Before choosing the
// head we remove material that is not the sold item:
//   * shop tags and parentheses: "[이마트몰]", "(사은품 : ...)"
//   * option / sentence tails after the first ", " / ". " / " | "
//   * merchant taxonomy tails: "/디지털기기 ..." "/생활/가전 ..."
//   * accessories INCLUDED with a device: "청소기 전용 노즐 + 보관가방 포함"
//   * feature/spec mentions: "헤파필터 H13", "마이크 내장", "케이블 별매"
//   * compatibility targets: "아이폰 호환 이어폰" → the 아이폰 is not sold
// No network, DB, model, or QA-question dependency.

const DEVICE_NOUNS = [
  // Specific compounds first: a "키보드 케이스" is a keyboard product.
  ['키보드', /(?:키보드\s*케이스|매직\s*키보드|스마트\s*키보드|키보드\s*폴리오|keyboard\s*(?:case|folio))/gi],
  // ("공기계" = an unactivated device of ANY kind — tablets too — so it is not a phone noun)
  ['스마트폰', /(?:스마트폰|휴대폰|핸드폰|자급제폰|(?:아이폰|iphone)\s*(?:\d{1,2}|se)(?:\s*(?:프로\s*맥스|pro\s*max|프로|pro|플러스|plus|미니|mini|e))?|갤럭시\s*(?:s|a|m|z|퀀텀|와이드|점프|버디)\s*\d{1,2}|갤럭시\s*(?:z\s*)?(?:폴드|플립)\s*\d|(?:픽셀|pixel)\s*\d{1,2}a?|sm-[saf]\d{3}[a-z]?)/gi],
  ['태블릿', /(?:태블릿(?:\s*pc)?|아이패드|ipad|갤럭시\s*탭|galaxy\s*tab|아이디어\s*탭|idea\s*tab|리전\s*탭|(?:레노버|샤오미|레드미|아이뮤즈|엠피지오)\s*(?:패드|탭|tab|pad)|redmi\s*pad|xiaomi\s*pad|뮤패드|엠탭)/gi],
  ['노트북', /(?:노트북|랩탑|laptop|맥북|macbook|(?<!\d\s?)그램(?!\s*(?:당|수))|갤럭시\s*북\s*\d?|galaxy\s*book|비보북|vivobook|젠북|zenbook|아이디어\s*패드|ideapad|씽크\s*패드|thinkpad|크롬북|chromebook|인스피론|inspiron|파빌리온|pavilion|엘리트북|elitebook|프로북|probook|울트라\s*pc)/gi],
  ['헤드폰', /(?:헤드폰|헤드셋|headphones?|headset)/gi],
  ['이어폰', /(?:이어폰|이어버드|earbuds?|에어팟|airpods|버즈(?=\s*\d|\s*(?:프로|pro|fe|라이브|live|플러스|\+|$|\s))|buds(?=\s*\d|\s*(?:pro|fe|live|\+)|\b)|\btws\b|넥밴드|골전도|이어\s*커프|이어\s*클립)/gi],
  ['모니터', /(?:모니터(?!링)|monitor(?!ing))/gi],
  ['키보드', /(?:키보드|keyboard)/gi],
  ['마우스', /(?:마우스|mouse)/gi],
  ['공기청정기', /(?:공기\s*청정기|청정기|air\s*purifier|purifier)/gi],
  // Product-line knowledge: Dyson V-series / Gen5 / Digital Slim are stick vacuums.
  ['청소기', /(?:청소기|vacuum|cleaner|(?:다이슨|dyson)\s*(?:v\d{1,2}|gen\s*5|젠\s*5|디지털\s*슬림|옴니\s*글라이드|omni-?glide)(?![0-9]))/gi],
  ['스피커', /(?:스피커|speaker|사운드바|soundbar|사운드\s*링크|soundlink)/gi],
  ['시계', /(?:스마트\s*워치|smart\s*watch|갤럭시\s*워치|galaxy\s*watch|애플\s*워치|apple\s*watch|워치\s*\d|(?<![a-z])watch\s*\d|스마트\s*밴드|smart\s*band|미밴드|(?:전자|손목|운동|학생|진동\s*알람)?\s*시계|워치(?=\s|,|$))/gi],
  ['기타', /(?:(?:일렉(?:트릭)?|어쿠스틱|클래식|통|전자|베이스|입문용?|연습용|미니|여행용|\d{2}\s*인치)\s*기타|통기타|guitar)/gi],
  ['외장하드', /(?:외장\s*(?:하드|ssd|hdd|디스크|드라이브)|포터블\s*(?:ssd|hdd)|portable\s*(?:ssd|hdd|drive)|external\s*(?:ssd|hdd|drive)|하드\s*디스크|my\s*passport|\bhdd\b|\bssd\b|\bpssd\b)/gi]
];

// Accessory / part / non-merchandise nouns. They name what is sold only when
// they are the head of the main phrase and not in an included/spec context.
const ACCESSORY_NOUN = new RegExp([
  '케이스', '커버', '파우치', '슬리브', '필름', '강화\\s*유리', '키\\s*스킨', '스킨', '스티커', '보안기',
  '거치대', '스탠드', '브라켓', '브래킷', '마운트', '홀더', '받침(?:대)?', '지지대', '수납장', '수납\\s*선반', '장식장',
  '쿨러', '선풍기', '쿨링\\s*팬', '가방', '백팩', '크로스\\s*백', '메신저\\s*백', '(?:워치|시계|watch)\\s*(?:밴드|줄|스트랩)', '스트랩',
  '충전기', '충전\\s*독', '충전\\s*케이블', '케이블', '어댑터', '젠더', '허브', '도킹\\s*스테이션', '도킹',
  '배터리', '필터', '노즐', '브러시', '브러쉬', '롤러', '물걸레\\s*패드', '걸레', '먼지\\s*봉투', '더스트\\s*백',
  '이어\\s*팁', '이어\\s*패드', '이어\\s*캡', '키캡', '팜\\s*레스트', '손목\\s*받침', '마우스\\s*패드', '리모컨',
  '액정', 'lcd', '스크린', '어셈블리', '부품', '모듈', '메인\\s*보드', '프레임', '힌지', '하판', '상판',
  '카포', '피크', '스트링', '기타\\s*줄', '교본', '도서', 'ebook', 'e북', '페달', '이펙터', '이펙트', '앰프',
  '튜너', '새들', '너트', '브리지', '픽업', '마이크', '방수\\s*팩', '유심', 'usim', '삼각대', '짐벌', '렌즈',
  '펜슬', '펜촉', 's\\s*펜', '리필', '소모품', '헤드(?=\\s*(?:,|$|\\d|단품|1개))', '수리', '전화\\s*박스', '모형', '장난감',
  '모자', '장갑', '스웨터', '스카프', '티셔츠', '반팔', '타이머', '콘센트',
  '팁(?=\\s|,|$)', '이어\\s*젤', '이어\\s*플러그', '정리대', '보관대', '벽걸이', '걸이(?=\\s|,|$)',
  '터치\\s*펜', '스타일러스', '튜브', '호스', '연장관', '교체품', '호환품', '플러그', '도어벨', '홈캠',
  'usb\\s*메모리', '유에스비\\s*메모리', '메모리\\s*스틱', '플래시\\s*드라이브', '메모리\\s*카드', 'micro\\s*sd', '마이크로\\s*sd', 'sd\\s*카드',
  '리시버', '수신기', '동글', '매트', '세제', '세정제', '(?:pc|노트북|태블릿|토트|숄더|슬링)\\s*백(?![a-z가-힣])',
  '경사대', '문턱\\s*(?:경사대?|매트|턱)', '화분', '악세(?:서|사)리', '액세서리', '키트(?=\\s|,|$|\\[)', '\\d+\\s*매(?![a-z가-힣])',
  '블루라이트\\s*차단', '기록\\s*보드', '전자\\s*(?:메모|노트)', '메모\\s*(?:패드|보드)', '부기\\s*보드',
  '\\d{1,2}(?:\\.\\d)?\\s*v\\s+(?:[^\\s]+\\s+){0,2}\\d(?:\\.\\d{1,2})?\\s*a(?![a-z])'
].join('|'), 'gi');
// Accessories that never describe a device feature: if one is in the main
// phrase outside an inclusion/spec context, the listing sells it — even when
// a device noun follows ("3M 보안 필름 노트북 15형", "노트북 가방 ... LG그램").
const STRONG_ACCESSORY = /^(?:필름|보호\s*필름|강화\s*유리|보안기|키\s*스킨|스킨|가방|백팩|파우치|슬리브|크로스\s*백|메신저\s*백|충전기|어댑터|거치대|받침(?:대)?|지지대|스트랩|리시버|세제|세정제|경사대|문턱.*|정리대|화분|수납장|허브|악세(?:서|사)리|액세서리|\d+\s*매|블루라이트\s*차단|기록\s*보드|.*\d\s*a)$/i;
// Sentences that only accessory listings use ("…에 적합합니다", "…와 호환됩니다").
const FITS_SENTENCE = /(?:에\s*적합합니다|에\s*적합한\s*(?:케이스|커버|필름)|호환\s*됩니다|에\s*맞습니다)/;
// Other (non-category) devices: a TV, a car navigation display, a
// conference speakerphone are not monitors / speakers.
const OTHER_DEVICE = /(?:스마트\s*tv|(?<![a-z])tv(?![a-z])|티비|텔레비전|프로젝터|냉장고|세탁기|에어컨|블랙박스|네비게이션|내비게이션|카플레이|스피커폰)/gi;
// Books, lessons and media players are never the device even when they name
// it ("통기타 교본", "[eBook] iPhone 16", "효도라디오 클래식 기타"), unless
// bundled ("교본 증정"). Replacement/compatible parts likewise
// ("다이슨 v10 튜브 호환 교체품 ... 청소기").
const MEDIA = /(?:교본|악보|도서|\[?e-?book\]?|e북|레슨\s*북|강습\s*책|수록곡|라디오|mp3)(?!\s*(?:증정|포함|제공|동봉))/i;
const REPLACEMENT_PART = /(?:교체품|호환품|교체용|호환용|리필용|대체품)(?!\s*(?:증정|포함|제공|동봉))/;

const INCLUDED = /(?:포함|증정|사은품|동봉|구성품|무료\s*제공|제공|증정품|덤)/i;
// Devices that other products are made FOR (compatibility hosts).
const HOST_TYPES = new Set(['스마트폰', '태블릿', '노트북', '기타기기']);
const SPEC_AFTER = /^[\s:]{0,2}(?:h1[0-4]\b|등급|내장|탑재|장착|지원|겸용|일체형|투인원|2in1|별매|미포함|불포함|별도|교체\s*가능|교체형|기능|방식|타입\s*c|탈부착|분리형)/i;
const SPEC_BEFORE = /(?:\d+\s*mah|대용량|초대용량|고용량|h1[0-4]|내장|탑재|\d+\s*(?:m|미터)|고속|분리형|교체형|교체\s*가능한?)\s*$/i;
// Compatibility-target markers after a device noun. "용" counts only when it
// is glued to the device or to model tokens right after it ("맥북용",
// "에어 11용", "S25 용") — not a purpose adjective ("휴대용", "대용량").
const TARGET_MARKER = /^[\s0-9a-z가-힣.+/]{0,22}?(?:전용|호환|에\s*(?:쓸|쓰는|맞는|연결)|연결용|for\b|사용\s*가능|지원\s*가능|대응)/i;
// (no nested regex quantifiers: seller titles are untrusted input — ReDoS)
const MODEL_TOKEN = /^(?:[0-9a-z.+/()-]{1,14}|에어|프로|미니|플러스|울트라|엣지|맥스|라이트|시리즈)$/i;
function targetYong(tail) {
  const at = tail.indexOf('용');
  if (at < 0 || at > 30) return false;
  if (/[a-z가-힣]/i.test(tail.charAt(at + 1))) return false;      // "용량", "용도"
  const before = tail.slice(0, at);
  if (/\s$/.test(before) && !/[0-9a-z)]\s$/i.test(before)) return false;
  const tokens = before.trim() ? before.trim().split(/\s+/) : [];
  return tokens.length <= 4 && tokens.every(x => MODEL_TOKEN.test(x));
}
const TARGET_AFTER = { test: tail => targetYong(tail) || TARGET_MARKER.test(tail) };

function stripTaxonomy(title) {
  return String(title || '').split(/\/(?:디지털기기|pc\/주변기기|생활\/가전|가구\/인테리어|스포츠\/레저|출산\/육아)/i)[0];
}
// The main phrase of the title: shop tags, parentheses and option/sentence
// tails removed. Keeps the original order of words.
function mainPhrase(title) {
  let t = stripTaxonomy(String(title || '').normalize('NFKC'));
  t = t.replace(/&amp;/gi, '&');
  t = t.replace(/\[[^\]]{0,40}\]/g, ' ');           // [이마트몰] [해외] [기타]
  t = t.replace(/\([^)]{0,80}\)/g, ' ');            // (사은품 : ...)
  t = t.replace(/\([^)]*$/, ' ');                   // unclosed "( ..." tail
  const cut = t.search(/,\s|，|\.\s|\s\|\s|。|:\s/);
  if (cut > 8) t = t.slice(0, cut);
  return t.replace(/\s+/g, ' ').trim();
}
function collectNouns(phrase) {
  const found = [];
  for (const [type, re] of DEVICE_NOUNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(phrase)) !== null) {
      if (!m[0].trim()) { re.lastIndex++; continue; }
      found.push({ kind: 'device', type, index: m.index, end: m.index + m[0].length, noun: m[0].trim() });
    }
  }
  ACCESSORY_NOUN.lastIndex = 0;
  let a;
  while ((a = ACCESSORY_NOUN.exec(phrase)) !== null) {
    if (!a[0].trim()) { ACCESSORY_NOUN.lastIndex++; continue; }
    found.push({ kind: 'accessory', type: null, index: a.index, end: a.index + a[0].length, noun: a[0].trim() });
  }
  OTHER_DEVICE.lastIndex = 0;
  let o;
  while ((o = OTHER_DEVICE.exec(phrase)) !== null) {
    if (!o[0].trim()) { OTHER_DEVICE.lastIndex++; continue; }
    found.push({ kind: 'device', type: '기타기기', index: o.index, end: o.index + o[0].length, noun: o[0].trim() });
  }
  // A device compound ("키보드 케이스") overrides the accessory noun it
  // contains; an accessory compound ("마우스패드", "모니터암") overrides the
  // device noun inside it.
  const deviceSpans = found.filter(x => x.kind === 'device');
  const accessorySpans = found.filter(x => x.kind === 'accessory');
  const kept = found.filter(x => x.kind === 'device'
    ? !accessorySpans.some(a => a.index <= x.index && a.end >= x.end && (a.end - a.index) > (x.end - x.index))
    : !deviceSpans.some(d => d.index <= x.index && d.end >= x.end));
  // Overlapping device matches of different lengths: keep the longest.
  const result = [];
  for (const x of kept.sort((p, q) => p.index - q.index || (q.end - q.index) - (p.end - p.index))) {
    const overlap = result.find(r => r.kind === x.kind && x.index < r.end && x.end > r.index);
    if (overlap) continue;
    result.push(x);
  }
  return result.sort((p, q) => p.index - q.index);
}
// principalItem(title) → { kind: 'device'|'accessory'|null, type, noun, phrase }
function principalItem(title) {
  const phrase = mainPhrase(title);
  const whole = stripTaxonomy(String(title || '').normalize('NFKC'));
  if (MEDIA.test(whole)) return { kind: 'accessory', type: null, noun: 'media', phrase };
  if (REPLACEMENT_PART.test(whole)) return { kind: 'accessory', type: null, noun: 'replacement_part', phrase };
  if (FITS_SENTENCE.test(whole)) return { kind: 'accessory', type: null, noun: 'fits_sentence', phrase };
  const nouns = collectNouns(phrase);
  const lower = phrase.toLowerCase();
  // 1) Bundled extras. Accessories between a device noun and a later
  //    inclusion word ("청소기 전용 노즐 + 보관가방 포함", "외장HDD 파우치 증정")
  //    or after a "+" add-on ("마우스 + 파우치 세트") are not the sold item, and
  //    the device that owns them is not a compatibility target.
  const extra = new Set(), owner = new Set();
  for (let i = 0; i < nouns.length; i++) {
    if (nouns[i].kind !== 'device') continue;
    const device = nouns[i];
    const nextDevice = nouns.slice(i + 1).find(x => x.kind === 'device');
    const limit = nextDevice ? nextDevice.index : lower.length;
    const tail = lower.slice(device.end, limit);
    const inc = tail.search(INCLUDED);
    const plus = tail.search(/\+/);
    const cut = [inc, plus].filter(x => x >= 0);
    if (!cut.length) continue;
    const from = device.end;
    for (const n of nouns) {
      if (n.kind !== 'accessory' || n.index < from || n.index >= limit) continue;
      const rel = n.index - from;
      if ((inc >= 0 && rel < inc + 6) || (plus >= 0 && rel > plus)) { extra.add(n); owner.add(device); }
    }
  }
  // Coordinated compatibility lists: in "아이패드 태블릿 호환" or
  // "갤럭시/아이폰/아이패드 호환" every listed device is a target.
  const targets = new Set();
  // Device LISTS are compatibility lists: two adjacent devices of different
  // categories ("... 이어폰 폰통화 스마트폰 태블릿") or three device names
  // close together ("맥북프로16 그램 갤럭시북5") never name the sold item
  // when another noun precedes them.
  const devices = nouns.filter(x => x.kind === 'device' && !owner.has(x));
  for (let i = 1; i < devices.length; i++) {
    const p = devices[i - 1], c = devices[i];
    const between = lower.slice(p.end, c.index);
    // only HOST devices form compatibility lists ("스마트폰 태블릿"); a
    // keyboard next to an iPad ("매직 키보드 아이패드 에어 11용") is the product
    if (p.type !== c.type && HOST_TYPES.has(p.type) && HOST_TYPES.has(c.type) &&
      /^[\s,/&+·]*$/.test(between) && nouns.some(x => x.index < p.index && x !== p)) { targets.add(p); targets.add(c); }
  }
  // (generic category nouns do not count; Korean/English names are one line)
  const GENERIC = /^(?:노트북|랩탑|laptop|태블릿(?:pc)?|tablet|스마트폰|휴대폰|핸드폰|이어폰|이어버드|헤드폰|헤드셋|모니터|monitor|키보드|keyboard|마우스|mouse|청소기|스피커|speaker|시계|워치|watch|스마트워치|공기청정기|청정기|외장하드|ssd|hdd)$/i;
  const SAME = { macbook: '맥북', galaxybook: '갤럭시북', gram: '그램', ipad: '아이패드', iphone: '아이폰', airpods: '에어팟', galaxytab: '갤럭시탭' };
  const lineKey = x => { const k = x.noun.toLowerCase().replace(/[\s\d]/g, ''); return SAME[k] || k; };
  // Only named product LINES count (generic or bilingual kind words such as
  // "일렉기타 ... GUITAR", "공기계", "SM-A155" are not different lines).
  const LINE = /^(?:맥북|macbook|그램|갤럭시\s*북\s*\d?|galaxy\s*book|아이패드|ipad|갤럭시\s*탭|galaxy\s*tab|에어팟|airpods|버즈|buds|아이폰.*|iphone.*|갤럭시\s*[sazm]\s*\d.*|픽셀.*|pixel.*|비보북|vivobook|젠북|zenbook|아이디어\s*패드|ideapad|씽크\s*패드|thinkpad|크롬북|chromebook|갤럭시\s*워치.*|galaxy\s*watch.*|애플\s*워치.*|apple\s*watch.*)$/i;
  const lines = devices.filter(x => !GENERIC.test(x.noun.replace(/\s/g, '')) && LINE.test(x.noun));
  for (let i = 2; i < lines.length; i++) {
    const run = lines.slice(i - 2, i + 1);
    if (new Set(run.map(lineKey)).size === 3 && run[2].index - run[0].end <= 30) run.forEach(x => targets.add(x));
  }
  // Two DIFFERENT product lines of the same kind close together ("맥북프로16
  // 그램 갤럭시북5", "에어팟 버즈 호환") name compatible hosts, not one device.
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i - 1], c = lines[i];
    if (p.type === c.type && lineKey(p) !== lineKey(c) && c.index - p.end <= 20 &&
      !/^(?:\s*(?:vs|대비|비교))/i.test(lower.slice(p.end, c.index))) { targets.add(p); targets.add(c); }
  }
  for (let i = nouns.length - 1; i >= 0; i--) {
    const n = nouns[i];
    if (n.kind !== 'device' || owner.has(n)) continue;
    const nextNoun = nouns.slice(i + 1).find(x => x.index >= n.end);
    const ownTail = lower.slice(n.end, nextNoun ? nextNoun.index : lower.length);
    if (TARGET_AFTER.test(ownTail)) { targets.add(n); continue; }
    if (nextNoun && targets.has(nextNoun) && HOST_TYPES.has(n.type) && HOST_TYPES.has(nextNoun.type) &&
      /^[\s,/&+·및와과]*$/.test(lower.slice(n.end, nextNoun.index))) targets.add(n);
  }
  const usable = [];
  for (let i = 0; i < nouns.length; i++) {
    const n = nouns[i];
    if (extra.has(n) || targets.has(n)) continue;
    const before = lower.slice(Math.max(0, n.index - 14), n.index);
    const after = lower.slice(n.end, n.end + 26);
    // 2) Spec / feature mentions: "헤파필터 H13", "마이크 내장", "960mAh 대용량
    //    배터리", "케이블 별매", "이어폰 투인원을 내장".
    if (n.kind === 'accessory' && (SPEC_AFTER.test(after) || SPEC_BEFORE.test(before))) continue;
    if (n.kind === 'device' && /^[\s:]{0,2}(?:투인원|2in1|일체형|내장|탑재|겸용)/i.test(after) &&
      nouns.some(x => x !== n && x.kind === 'device')) continue;
    // 3) Devices named only as compatibility targets were removed above
    //    ("외장 SSD 1TB 맥북 호환"). A part followed by 호환 is still the part
    //    ("헤드폰 케이스 호환").
    usable.push(n);
  }
  const strong = usable.find(x => x.kind === 'accessory' && STRONG_ACCESSORY.test(x.noun));
  if (strong) return { kind: 'accessory', type: null, noun: strong.noun, phrase };
  let head = usable[usable.length - 1] || null;
  // A late device of another kind followed by a purpose/compat word is the
  // host: "휴대용 모니터 … LG 그램 노트북 컴퓨터 확장 화면 용" sells a monitor.
  if (head && head.kind === 'device') {
    const earlier = usable.find(x => x.kind === 'device' && x.type !== head.type && x.index < head.index);
    const tail = lower.slice(head.end, head.end + 25);
    if (earlier && /(?:(?:^|\s)용(?![a-z가-힣])|[가-힣]용(?![a-z가-힣])|호환|전용|연결|확장|겸용)/.test(tail)) head = earlier;
    // A HOST device named after a peripheral is the host it works with:
    // "휴대용 모니터 … 노트북", "블루투스 키보드 … 아이패드".
    else if (HOST_TYPES.has(head.type)) {
      const product = usable.find(x => x.kind === 'device' && !HOST_TYPES.has(x.type) && x.index < head.index);
      if (product) head = product;
    }
  }
  return head ? { kind: head.kind, type: head.type, noun: head.noun, phrase }
    : { kind: null, type: null, noun: null, phrase };
}
// Is this word an accessory/part noun (used by exclusion grounding)?
function isAccessoryWord(word) {
  const w = String(word || '').normalize('NFKC').trim();
  if (!w) return false;
  const re = new RegExp('^(?:' + ACCESSORY_NOUN.source + ')$', 'i');
  return re.test(w);
}
module.exports = { principalItem, mainPhrase, stripTaxonomy, collectNouns, isAccessoryWord };
