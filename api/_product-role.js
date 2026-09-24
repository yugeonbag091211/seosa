'use strict';
/*
 * 상품 역할 판별 — 이 상품은 «본품» 인가, «부속품» 인가, 관련 없는 상품인가.
 *
 * ── 왜 필요한가 (2026-09-24 실사용 신고) ────────────────────────
 *
 *   "100만 원 이하의 가볍고 배터리가 오래가는 노트북 3개"
 *     → 노트북 본체 0개, 교체용 배터리·건전지·키보드 8개
 *
 * 원인은 하나가 아니었다.
 *   1) 부속품 판정을 «검색어에 부속 낱말이 들어 있는가» 로 껐다 (부분 문자열).
 *      "배터리가 오래가는" 은 노트북을 꾸미는 말인데 "배터리를 찾는다" 로 읽혔다.
 *   2) 부속 낱말 목록(_search.ACCESSORY_TIER)은 검색 순위 감점용이라 키보드·건전지가 없다.
 *   3) 수집 키워드가 «노트북» 을 포함하면 제목과 무관하게 후보가 됐다
 *      — "노트북 배터리" 로 수집된 행이 전부 들어왔다.
 *
 * ── 어떻게 가르나 ───────────────────────────────────────────────
 *
 * 한국어 명사구는 머리가 뒤에 온다. "배터리가 오래가는 노트북" 의 머리는 노트북,
 * "노트북 배터리" 의 머리는 배터리다. 질문(targetOf)은 이 규칙으로 «무엇을 찾는지»
 * 를 정하고, 상품명(classify)은 판매자 제목의 관례로 가른다.
 *   - 기기 이름에 «~용 · ~전용 · ~호환» 이 붙어 있으면 그 기기에 쓰는 물건이다
 *   - 부속 낱말이 있으면 부속품이다. 단, 본체 설명 속 낱말(«대용량 배터리» ·
 *     «백라이트 키보드» · «충전 케이스»)과 사은품 절(«마우스 증정» · «+ 파우치»)은 먼저 걷어 낸다
 *   - 본체 사양(CPU·램·저장장치·OS …)이 둘 이상 적혀 있으면 본체다
 *
 * 카테고리마다 낱말만 다르고 규칙은 같다(PROFILES). 목록에 없는 카테고리는 질문의
 * 머리 명사와 _search.ACCESSORY_TIER(읽기만 한다 — 핫딜·검색이 같이 쓰는 목록)로
 * 같은 규칙을 돈다.
 *
 * ★ 모르면 «본품» 이라고 하지 않는다 (UNKNOWN). 부속품을 본품으로 추천하는 것이
 *   본품 하나를 놓치는 것보다 나쁘다.
 * ★ 순수 함수 — DB·네트워크 없음. 같은 입력이면 같은 답.
 */

const MAIN = 'MAIN';
const ACCESSORY = 'ACCESSORY';
const OTHER = 'OTHER';
const UNKNOWN = 'UNKNOWN';

/** 본체 사양이 이만큼 적혀 있으면 부속 낱말이 남아 있어도 본체다. */
const MAIN_OVERRIDE = 2;

/* ------------------------------------------------------------------ *
 *  낱말 도구
 * ------------------------------------------------------------------ */

function lower(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 부속 낱말 → 정규식. 영문·숫자 낱말은 낱말 경계를 요구한다 ('aa' 가 'aaa' 안에서 맞지 않게). */
function termRe(term) {
  const t = lower(term);
  const body = escapeRe(t).replace(/ /g, '\\s?');
  return /^[a-z0-9 .\-]+$/.test(t) ? new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, 'i') : new RegExp(body, 'i');
}

/** 받침에 따라 조사를 고른다 (노트북이 · 카메라가). 한글이 아니면 받침 없는 쪽. */
function josa(word, withBatchim, withoutBatchim) {
  const s = String(word || '');
  const c = s.charCodeAt(s.length - 1);
  if (c >= 0xAC00 && c <= 0xD7A3) return (c - 0xAC00) % 28 ? withBatchim : withoutBatchim;
  return withoutBatchim;
}

/** '(으)로' — 받침이 없거나 ㄹ 받침이면 '로', 그 밖의 받침이면 '으로'. */
function ro(word) {
  const s = String(word || '');
  const c = s.charCodeAt(s.length - 1);
  if (c >= 0xAC00 && c <= 0xD7A3) { const jong = (c - 0xAC00) % 28; return jong && jong !== 8 ? '으로' : '로'; }
  return '로';
}

/*
 * 앞말을 꾸미는 서술 — "배터리가 오래가는", "카메라 좋은", "화면이 큰".
 * 부속 낱말·기기 이름 뒤에 이것이 오면 그 낱말은 찾는 물건이 아니라 조건이다.
 */
const PRED = /^\s*(?:이|가|은|는|도|을|를|의)?\s*(?:오래|길|긴|좋|편하|편한|큰|크|많|넉넉|장시간|빵빵|튼튼|잘\s|가벼|가볍|밝|선명|빠르|빠른|조용|넓|높|괜찮|훌륭|우수|뛰어|짱|최고|\d+\s*(?:시간|wh|mah|gb|인치))/i;

/** 머리 명사가 될 수 없는 말 — 요청 말투·수량·범위. */
const STOP = /^(?:추천\S*|알아봐\S*|비교\S*|조사\S*|찾아\S*|골라\S*|정리\S*|분석\S*|보여\S*|사고\s?싶\S*|좀|거|것|걸로|제품|상품|이하|이상|미만|초과|정도|쯤|내외|최대|최소|가성비|저렴한|싼|좋은)$/;

/** 사은품·묶음을 알리는 말. */
const FREEBIE = /(증정|사은품|포함|동봉|무료\s?제공|덤)/;

/* 부속 낱말 묶음 — 같은 묶음 안의 낱말은 같은 물건으로 본다 ("노트북 파우치" ↔ 슬리브). */
const G = {
  필름: ['보호필름', '액정보호', '강화유리', '종이질감', '필름'],
  케이스: ['케이스', '커버', '범퍼', '북커버', '폴리오'],
  파우치: ['파우치', '슬리브'],
  가방: ['가방', '백팩', '크로스백', '캐리어'],
  거치대: ['거치대', '받침대', '스탠드', '홀더', '마운트', '선반'],
  충전기: ['충전기', '어댑터', '아답터', '충전독', '충전 거치대'],
  케이블: ['케이블', '젠더', '허브', '도킹', '독'],
  배터리: ['배터리팩', '보조배터리', '배터리', '충전지'],
  키보드: ['키스킨', '키캡', '키보드'],
  마우스: ['마우스'],
  쿨러: ['쿨링패드', '쿨러'],
  부품: ['교체용', '호환용', '부품', '소모품', '리필'],
  스티커: ['스티커', '스킨'],
  청소: ['클리너', '청소키트', '청소솔', '블로워'],
  잠금: ['자물쇠', '잠금장치', '도난방지']
};
function groups(keys, extra) {
  const out = {};
  keys.forEach(k => { out[k] = G[k].slice(); });
  Object.keys(extra || {}).forEach(k => { out[k] = (out[k] || []).concat(extra[k]); });
  return out;
}

/** 어느 기기의 부속도 아닌 소모품 — "노트북" 을 찾는데 나오면 관련 없는 상품이다. */
const UNRELATED = ['건전지', '알카라인', '망간전지', '코인전지', '수은전지', '단3', '단4', 'cr2032', 'cr2025', 'lr44', 'aaa', 'aa'];

/* ------------------------------------------------------------------ *
 *  카테고리 프로필
 *
 *  anchors   기기 이름. kind 'noun' 은 종류 이름(노트북), 'series' 는 제품군(맥북).
 *            db 는 DB 에서 찾을 때 쓸 글자 (정규식이 아니라 ilike 용 평문)
 *  acc       부속 낱말 묶음
 *  parts     부품 표기 (정규식)
 *  strong    본체 사양 — 이것이 MAIN_OVERRIDE 개 이상이면 본체
 *  weak      본체일 때 흔한 표기 (단독으로는 판단하지 않는다)
 *  descriptors  본체 설명 속 부속 낱말 — 부속 판정 전에 걷어 낸다
 *  others    같은 이름을 쓰는 다른 기기 (카메라 ↔ CCTV)
 *  noAnchor  기기 이름이 없을 때 사양만으로 본체라고 할 조건
 *  light     «가벼운» 의 기준(g). 사용자가 숫자를 말하지 않았을 때만 쓴다
 * ------------------------------------------------------------------ */

const PROFILES = [
  {
    id: 'laptop', label: '노트북', category: '노트북',
    anchors: [
      { kind: 'noun', re: /노트북|랩탑|(?<![a-z])laptop|노트\s?pc|울트라북|크롬북|chromebook/i, db: ['노트북', '랩탑', '노트PC'] },
      { kind: 'series', re: /맥북|macbook/i, db: ['맥북', 'macbook'] },
      { kind: 'series', re: /(?:(?<![\d가-힣]|\d\s)|(?<=20[12]\d\s?))그램(?!\s?(?:당|짜리|씩))|엘지\s?그램|lg\s?gram/i, db: ['그램'] },
      { kind: 'series', re: /갤럭시\s?북|galaxy\s?book/i, db: ['갤럭시북', '갤럭시 북'] },
      { kind: 'series', re: /아이디어\s?패드|ideapad|씽크\s?패드|thinkpad|씽크\s?북|thinkbook|요가\s?(?:슬림|프로|북)/i, db: ['아이디어패드', '씽크패드', 'thinkpad', 'ideapad'] },
      { kind: 'series', re: /젠북|zenbook|비보북|vivobook|(?<![a-z])rog\s?(?:스트릭스|제피러스|플로우|strix|zephyrus|flow)|tuf\s?(?:게이밍|gaming)/i, db: ['젠북', '비보북', 'zenbook', 'vivobook'] },
      { kind: 'series', re: /레기온|(?<![a-z])legion|인스피론|inspiron|래티튜드|latitude|(?<![a-z])xps\s?1[3-7]|에일리언웨어|alienware/i, db: ['레기온', '인스피론', 'inspiron'] },
      { kind: 'series', re: /파빌리온|pavilion|빅터스|victus|(?<![a-z])omen(?![a-z])|오멘\s?(?:트랜센드|1[4-7])|엘리트북|elitebook|프로북|probook|(?<![a-z])envy\s?(?:x360|1[3-7])/i, db: ['파빌리온', 'pavilion', '엘리트북'] },
      { kind: 'series', re: /(?<![a-z])swift\s?(?:go|edge|x|[1-5])|스위프트\s?(?:고|엣지|[1-5])|아스파이어|(?<![a-z])aspire|프레데터\s?헬리오스|predator\s?helios|니트로\s?(?:5|v)|nitro\s?(?:5|v)/i, db: ['아스파이어', 'aspire', '스위프트'] },
      { kind: 'series', re: /매직북|magicbook|레드미북|redmibook|서피스\s?(?:랩탑|laptop)|surface\s?laptop|울트라\s?슬림\s?노트/i, db: ['매직북', '서피스 랩탑'] }
    ],
    acc: groups(['필름', '케이스', '파우치', '가방', '거치대', '충전기', '케이블', '배터리', '키보드', '마우스', '쿨러', '부품', '스티커', '청소', '잠금']),
    parts: [
      [/so-?dimm|(?<![a-z0-9])pc[345]-?\d{4,5}|(?<![a-z0-9])m\.2(?![0-9])|(?<![0-9])2280(?![0-9])|외장\s?(?:ssd|하드|hdd)|내장\s?(?:ssd|hdd)/i, '메모리·저장장치 부품'],
      [/메인보드|힌지|lcd\s?패널|액정\s?교체|교체\s?액정/i, '수리 부품']
    ],
    strong: {
      cpu: /인텔|intel|코어\s?i[3579]|core\s?(?:i[3579]|ultra)|(?<![a-z0-9])i[3579](?:[\s-]?\d{4,5}[a-z]{0,2})?(?![a-z0-9])|울트라\s?[3579](?![0-9])|ultra\s?[3579](?![0-9])|라이젠|ryzen|셀러론|celeron|펜티엄|pentium|(?<![a-z0-9])n[12]\d{2}(?![a-z0-9])|스냅드래곤\s?x|snapdragon\s?x|(?<![a-z0-9])m[1-4](?:\s?(?:pro|max|프로|맥스))?(?![a-z0-9.])|애슬론|athlon/i,
      os: /윈도우|windows|(?<![a-z])win\s?1[01]|윈1[01]|프리\s?도스|free\s?dos|freedos|크롬\s?os|chrome\s?os|macos|맥\s?os|리눅스|linux/i,
      ram: /(?:(?<![가-힣])램|(?<![a-z])ram|메모리)\s*:?\s*\d{1,2}\s*(?:gb|기가|g)(?![a-z])|\d{1,2}\s*gb\s*(?:램|ram)|lpddr\d|(?<![a-z])ddr[45]/i,
      storage: /(?:ssd|nvme|emmc|hdd)\s*:?\s*\d{2,4}\s*(?:gb|tb|기가|테라)|\d{2,4}\s*(?:gb|tb)\s*(?:ssd|nvme|emmc|hdd)|(?<![0-9])(?:128|256|512|1024)\s*gb|(?<![0-9])[12]\s*tb(?![a-z])/i,
      gpu: /rtx\s?\d{4}|gtx\s?\d{3,4}|지포스|geforce|라데온|radeon|내장\s?그래픽|iris\s?xe|아이리스|arc\s?(?:그래픽|graphics)|(?<![a-z])mx\s?[1-5]\d{2}/i
    },
    weak: {
      weight: /\d(?:\.\d{1,2})?\s*kg/i,
      size: /1[0-8](?:\.\d)?\s*(?:인치|형|")/,
      panel: /oled|(?<![a-z])ips(?![a-z])|(?<![a-z])(?:fhd|qhd|wuxga|wqxga)(?![a-z])|레티나|retina|\d{2,3}\s*hz|터치\s?스크린/i
    },
    descriptors: [
      /(?:대용량|고용량|장시간|오래\s?가는|\d+\s*셀)\s*배터리/gi,
      /배터리\s*(?:최대\s*)?\d+(?:\.\d+)?\s*(?:시간|h(?![a-z])|hr)/gi,
      /\d+(?:\.\d+)?\s*wh\s*배터리|배터리\s*\d+(?:\.\d+)?\s*wh/gi,
      /(?:백라이트|풀\s?사이즈|숫자\s?키\s?패드|한글|영문|방수|저소음)\s*키보드|키보드\s*(?:백라이트|라이트)/gi,
      /(?:c\s?타입|usb[-\s]?c|고속|급속|pd)\s*충전(?!기)/gi
    ],
    others: /미니\s?pc|데스크\s?탑|데스크\s?톱|올인원\s?pc|일체형\s?pc|조립\s?pc|사무용\s?pc\s?본체/i,
    noAnchor: s => s.length >= 3 || (s.indexOf('cpu') > -1 && s.length >= 2),
    light: 1500
  },
  {
    id: 'phone', label: '스마트폰', category: '스마트폰',
    anchors: [
      { kind: 'noun', re: /스마트폰|휴대폰|핸드폰|폴더폰|공기계|smartphone/i, db: ['스마트폰', '휴대폰', '핸드폰'] },
      { kind: 'series', re: /아이폰|iphone/i, db: ['아이폰', 'iphone'] },
      { kind: 'series', re: /갤럭시\s?(?:s|a|m|퀀텀|노트)\s?\d{1,2}(?![0-9])|갤럭시\s?z\s?(?:플립|폴드|flip|fold)|갤럭시\s?(?:플립|폴드)\s?\d/i, db: ['갤럭시 S2', '갤럭시 Z 플립', '갤럭시 Z 폴드', '갤럭시 A', '갤럭시 퀀텀'] },
      { kind: 'series', re: /픽셀\s?\d|(?<![a-z])pixel\s?\d|레드미\s?노트|redmi\s?note|낫싱\s?폰|nothing\s?phone/i, db: ['픽셀', '레드미노트'] }
    ],
    acc: groups(['필름', '케이스', '거치대', '충전기', '케이블', '배터리', '부품', '스티커', '청소'], {
      그립: ['그립톡', '스마트톡', '링홀더', '핑거링'],
      스트랩: ['스트랩', '넥스트랩'],
      카메라보호: ['카메라보호', '카메라 보호', '렌즈보호', '렌즈 보호'],
      메모리카드: ['메모리카드', 'sd카드', '마이크로sd', 'microsd'],
      삼각대: ['셀카봉', '삼각대', '짐벌']
    }),
    parts: [[/액정\s?교체|교체\s?액정|후면\s?유리|배터리\s?교체/i, '수리 부품']],
    strong: {
      storage: /(?<![0-9])\d{2,4}\s*(?:gb|기가)(?![a-z])|(?<![0-9])[12]\s*tb(?![a-z])/i,
      unlock: /자급제|공기계|언락|unlocked|통신사|약정|번호\s?이동|기기\s?변경|기변|듀얼\s?심|esim|(?<![a-z0-9])5g(?![a-z0-9])|(?<![a-z0-9])lte(?![a-z0-9])/i,
      chip: /스냅드래곤|snapdragon|엑시노스|exynos|디멘시티|dimensity|텐서|tensor|(?<![a-z0-9])a1[5-9]\s?(?:바이오닉|bionic|pro|프로)?(?![0-9])/i,
      camera: /\d{2,3}\s*(?:mp|만\s?화소)/i
    },
    weak: { size: /\d(?:\.\d)?\s*(?:인치|")/ },
    descriptors: [
      /(?:대용량|고용량|장시간)\s*배터리|(?<!보조\s?)배터리\s*\d{4,5}\s*mah|\d{4,5}\s*mah\s*배터리/gi,
      /(?:무선|고속|급속|초고속)\s*충전(?!기)|충전\s?(?:지원|가능)/gi
    ],
    noAnchor: s => s.length >= 2 && (s.indexOf('unlock') > -1 || s.indexOf('chip') > -1),
    light: 200
  },
  {
    id: 'tablet', label: '태블릿', category: '태블릿',
    anchors: [
      { kind: 'noun', re: /태블릿|(?<![a-z])tablet/i, db: ['태블릿'] },
      { kind: 'series', re: /아이패드|ipad/i, db: ['아이패드', 'ipad'] },
      { kind: 'series', re: /갤럭시\s?탭|galaxy\s?tab|(?<![가-힣])탭\s?[sa]\s?\d{1,2}(?![0-9])/i, db: ['갤럭시탭', '갤럭시 탭'] },
      { kind: 'series', re: /샤오미\s?패드|xiaomi\s?pad|레드미\s?패드|redmi\s?pad|(?<![가-힣])미\s?패드|레노버\s?탭|lenovo\s?tab|서피스\s?프로|surface\s?pro/i, db: ['샤오미 패드', '레노버 탭', '미패드'] }
    ],
    acc: groups(['필름', '케이스', '파우치', '가방', '거치대', '충전기', '케이블', '키보드', '부품', '스티커', '청소'], {
      펜: ['펜슬', '터치펜', '스타일러스', 's펜'],
      그립: ['그립', '핸드스트랩', '스트랩']
    }),
    parts: [[/액정\s?교체|교체\s?액정/i, '수리 부품']],
    strong: {
      storage: /(?<![0-9])\d{2,4}\s*(?:gb|기가)(?![a-z])|(?<![0-9])[12]\s*tb(?![a-z])/i,
      network: /wi-?fi|와이파이|셀룰러|cellular|(?<![a-z0-9])lte(?![a-z0-9])|(?<![a-z0-9])5g(?![a-z0-9])/i,
      chip: /(?<![a-z0-9])m[1-4](?![a-z0-9.])|(?<![a-z0-9])a1[2-8]\s?(?:바이오닉|bionic|pro)?(?![0-9])|스냅드래곤|snapdragon|헬리오|helio|디멘시티|dimensity|엑시노스|exynos/i,
      ram: /(?:(?<![가-힣])램|(?<![a-z])ram|메모리)\s*:?\s*\d{1,2}\s*(?:gb|기가)/i
    },
    weak: {
      size: /\d{1,2}(?:\.\d)?\s*(?:인치|형|")/,
      panel: /oled|(?<![a-z])lcd(?![a-z])|레티나|retina|\d{2,3}\s*hz/i
    },
    descriptors: [
      /s\s?펜\s*(?:포함|내장|동봉|탑재)/gi,
      /(?:대용량|고용량|장시간)\s*배터리|배터리\s*\d{4,5}\s*mah/gi
    ],
    noAnchor: null,
    light: 500
  },
  {
    id: 'camera', label: '카메라', category: '카메라',
    anchors: [
      { kind: 'noun', re: /카메라(?!\s?(?:렌즈\s?)?보호)|미러리스|(?<![a-z])dslr|디카(?![가-힣])|캠코더|액션\s?캠|브이로그\s?캠|필름\s?카메라|즉석\s?카메라|폴라로이드/i, db: ['카메라', '미러리스', 'DSLR', '캠코더', '액션캠'] },
      { kind: 'series', re: /캐논\s?(?:eos|파워샷|r\d)|canon\s?(?:eos|powershot)|(?<![a-z])eos\s?(?:r\d|m\d|\d{2,4}d)/i, db: ['캐논 EOS', 'EOS'] },
      { kind: 'series', re: /소니\s?(?:알파|a[67]|zv|rx\d)|sony\s?(?:alpha|a[67]|zv|rx\d)|(?<![a-z0-9])a7\s?(?:m\d|r|s|c|iv|iii)|(?<![a-z0-9])a6[0-9]{3}(?![0-9])|(?<![a-z0-9])zv-?e?1\d?(?![0-9])/i, db: ['소니 알파', 'ZV-E10', 'A7'] },
      { kind: 'series', re: /니콘\s?[zd]\s?\d|nikon\s?[zd]\s?\d|니콘\s?z\s?(?:f|fc)|후지\s?필름\s?x|fujifilm\s?x|(?<![a-z0-9])x-?t\d{1,2}(?![0-9])|(?<![a-z0-9])x100\w*|루믹스|lumix|올림푸스|리코\s?gr|ricoh\s?gr/i, db: ['니콘 Z', '후지필름 X', '루믹스'] },
      { kind: 'series', re: /고프로|gopro|오즈모\s?(?:액션|포켓)|osmo\s?(?:action|pocket)|인스타\s?360|insta360|인스탁스|instax/i, db: ['고프로', 'gopro', '인스탁스', '오즈모'] }
    ],
    acc: groups(['필름', '케이스', '파우치', '가방', '충전기', '케이블', '배터리', '부품', '청소'], {
      케이스: ['케이지', '하우징'],
      스트랩: ['스트랩', '넥스트랩', '핸드스트랩'],
      삼각대: ['삼각대', '트라이포드', '짐벌', '셀카봉', '모노포드'],
      렌즈: ['렌즈캡', '렌즈후드', '후드', '마운트어댑터', '마운트 어댑터', '컨버터', '렌즈'],
      필터: ['uv필터', 'nd필터', 'cpl필터', '필터'],
      메모리카드: ['메모리카드', 'sd카드', 'sdxc', 'cfexpress', '마이크로sd', 'microsd', '리더기'],
      그립: ['그립', '배터리그립', 'l브라켓'],
      리모컨: ['리모컨', '릴리즈']
    }),
    parts: [[/더미\s?배터리|아이컵|바디\s?캡/i, '카메라 부품']],
    strong: {
      pixels: /\d{2,4}\s*만\s?화소|\d{2,3}(?:\.\d)?\s*mp(?![a-z0-9])/i,
      sensor: /풀\s?프레임|full\s?frame|aps-?c|마이크로\s?포서드|이미지\s?센서|(?<![a-z])cmos/i,
      video: /(?<![a-z0-9])(?:4k|8k|6k|5\.3k)(?![a-z0-9])|\d{2,3}\s*fps/i,
      body: /바디(?!\s?(?:캡|전용))|(?<![a-z])body(?![a-z])|렌즈\s?킷|렌즈킷|(?<![a-z])kit(?![a-z])/i,
      stab: /손떨림\s?(?:보정|방지)|광학\s?\d+\s?배|\d+\s?배\s?줌|하이브리드\s?af|af\s?추적/i
    },
    weak: {},
    descriptors: [
      /렌즈\s?(?:킷|포함|번들|일체형)|(?:번들|교환식?|표준\s?줌)\s?렌즈|\d+(?:-\d+)?\s?mm\s?(?:렌즈\s?)?(?:킷|번들)/gi,
      /(?:대용량|장시간)\s*배터리/gi
    ],
    others: /cctv|홈\s?캠|블랙박스|웹캠|webcam|보안\s?카메라|ip\s?카메라|홈\s?카메라|베이비\s?캠|펫\s?캠/i,
    noAnchor: s => s.length >= 2,
    light: 500
  },
  {
    id: 'audio', label: '헤드셋·이어폰', category: '이어폰',
    anchors: [
      { kind: 'noun', re: /헤드셋|헤드폰|이어폰|이어버드|넥밴드|골전도|이어셋|headset|headphone|earphone|earbud/i, db: ['헤드셋', '헤드폰', '이어폰', '이어버드'] },
      { kind: 'series', re: /에어팟|airpods|갤럭시\s?버즈|galaxy\s?buds|(?<![가-힣])버즈\s?(?:\d|프로|라이브|fe|플러스)|픽셀\s?버즈|pixel\s?buds/i, db: ['에어팟', '갤럭시 버즈', '버즈'] },
      { kind: 'series', re: /wh-?1000xm\d|wf-?1000xm\d|quietcomfort|(?<![a-z])qc\s?(?:울트라|ultra|\d{2})|하이퍼\s?x\s?클라우드|hyperx\s?cloud|아크티스|arctis|블랙샤크|blackshark|크라켄|kraken|샥즈|shokz|(?<![a-z])qcy(?![a-z])|낫싱\s?이어|nothing\s?ear/i, db: ['WH-1000XM', 'QC', '샥즈'] }
    ],
    acc: groups(['케이스', '거치대', '충전기', '케이블', '부품', '스티커', '청소'], {
      이어팁: ['이어팁', '폼팁', '실리콘팁', '이어윙', '이어훅'],
      이어패드: ['이어패드', '이어쿠션', '헤드쿠션', '헤드밴드 커버', '쿠션'],
      케이스: ['키링'],
      거치대: ['행거', '헤드셋 걸이', '걸이'],
      분실방지: ['분실방지', '분실 방지', '스트랩'],
      마이크: ['윈드스크린', '마이크 커버', '팝필터']
    }),
    parts: [[/충전\s?케이스\s?(?:단품|만)|(?:왼쪽|오른쪽|한쪽)\s?(?:유닛|단품|이어폰)|유닛\s?단품/i, '낱개 부품(유닛·충전 케이스)']],
    strong: {
      anc: /노이즈\s?캔슬|노캔|(?<![a-z])anc(?![a-z])/i,
      driver: /드라이버|aptx|ldac|코덱|하이\s?레스|hi-?res|공간\s?음향|돌비\s?애트모스|7\.1\s?(?:채널|ch)?|서라운드/i,
      play: /재생\s?(?:시간)?\s*(?:최대\s*)?\d+|\d+\s*시간\s*재생|블루투스\s?5\.\d|bluetooth\s?5\.\d|주변음\s?(?:허용|모드)|통화\s?품질|(?<![a-z])ipx?\d(?![0-9])/i
    },
    weak: {},
    descriptors: [
      /(?:맥세이프|magsafe|무선|usb-?c|c\s?타입|라이트닝)?\s*충전\s?케이스(?!\s?(?:단품|만|커버|케이스|보호))/gi,
      /(?:마이크|붐\s?마이크)\s*(?:탑재|내장|포함|분리형)/gi
    ],
    noAnchor: s => s.length >= 3,
    light: 300
  },
  {
    id: 'monitor', label: '모니터', category: '모니터',
    anchors: [
      { kind: 'noun', re: /모니터|(?<![a-z])monitor/i, db: ['모니터'] },
      { kind: 'series', re: /오디세이|odyssey|울트라기어|ultragear/i, db: ['오디세이', '울트라기어'] }
    ],
    acc: groups(['필름', '케이블', '부품', '청소'], {
      모니터암: ['모니터암', '모니터 암', '싱글암', '듀얼암', '브라켓', '브래킷', '클램프', '가스스프링'],
      받침대: ['받침대', '거치대', '스탠드', '선반'],
      커버: ['먼지커버', '먼지 커버', '커버', '덮개'],
      조명: ['모니터조명', '모니터 조명', '모니터램프', '스크린바']
    }),
    parts: [[/(?<![가-힣])암(?![가-힣])/i, '모니터암']],
    strong: {
      refresh: /\d{2,3}\s*hz/i,
      resolution: /(?<![a-z])(?:qhd|wqhd|fhd|uhd|4k|5k)(?![a-z])|\d{4}\s?[x×]\s?\d{3,4}/i,
      panel: /(?<![a-z])(?:ips|va|oled|qd-?oled|nano\s?ips)(?![a-z])|평면|커브드|curved/i,
      spec: /응답\s?속도|\d(?:\.\d)?\s*ms(?![a-z])|hdr\s?\d*|(?<![a-z])gtg(?![a-z])|명암비|프리싱크|freesync|g-?sync|지싱크/i
    },
    weak: { size: /\d{2}(?:\.\d)?\s*(?:인치|형|")/ },
    descriptors: [
      /(?:높이|높낮이|피벗|틸트|스위블)\s*(?:조절)?\s*(?:가능)?\s*스탠드|스탠드\s*(?:높이|높낮이|피벗)\s*조절/gi,
      /vesa\s*(?:지원|호환|홀)/gi
    ],
    noAnchor: s => s.length >= 3,
    light: null
  },
  {
    id: 'watch', label: '스마트워치', category: '스마트워치',
    anchors: [
      { kind: 'noun', re: /스마트\s?워치|smart\s?watch|스마트\s?밴드/i, db: ['스마트워치', '스마트밴드'] },
      { kind: 'series', re: /(?:애플|apple)\s?(?:워치|watch)|(?<![가-힣])워치\s?(?:se|울트라|ultra|시리즈|series)|갤럭시\s?워치|galaxy\s?watch|핏빗|fitbit|가민|garmin|(?<![가-힣])미\s?밴드|mi\s?band|어메이즈핏|amazfit/i, db: ['애플워치', '갤럭시워치', '갤럭시 워치', '가민', '미밴드'] }
    ],
    acc: groups(['필름', '케이스', '충전기', '케이블', '부품', '거치대'], {
      스트랩: ['스트랩', '시계줄', '워치줄', '밴드', '루프', '브레이슬릿']
    }),
    parts: [],
    strong: {
      net: /(?<![a-z])gps(?![a-z])|셀룰러|cellular|(?<![a-z0-9])lte(?![a-z0-9])/i,
      health: /심박|혈중\s?산소|spo2|심전도|(?<![a-z])ecg(?![a-z])|수면\s?(?:측정|분석)|체성분/i,
      screen: /(?<![a-z])amoled|올웨이즈\s?온|always\s?on|\d+\s*일\s*(?:사용|배터리)/i
    },
    weak: {},
    descriptors: [
      /(?:알루미늄|스테인리스(?:\s?스틸)?|티타늄)\s*케이스(?:[^,/]*?(?:스포츠\s?(?:밴드|루프)|솔로\s?루프|트레일\s?루프|알파인\s?루프|밀레니즈\s?루프|오션\s?밴드|링크\s?브레이슬릿))?/gi
    ],
    noAnchor: s => s.length >= 3,
    light: 60
  },
  {
    id: 'keyboard', label: '키보드', category: '키보드',
    anchors: [
      { kind: 'noun', re: /키보드|(?<![a-z])keyboard/i, db: ['키보드'] }
    ],
    acc: groups(['파우치', '케이블', '부품', '청소'], {
      키캡: ['키캡'],
      손목받침대: ['손목받침대', '손목 받침대', '팜레스트', '손목쿠션', '손목 쿠션'],
      키스킨: ['키스킨', '먼지커버', '덮개', '커버'],
      튜닝: ['스태빌', '윤활', '흡음폼', '흡음 폼', '키캡리무버', '리무버', '스위치 세트']
    }),
    parts: [],
    strong: {
      type: /기계식|무접점|멤브레인|펜타그래프|(?:적|갈|청|흑|은|황)\s?축|텐키리스|(?<![a-z])tkl(?![a-z])|풀\s?배열|\d{2,3}\s?키(?![가-힣])|\d{2,3}\s?%\s?배열/i,
      conn: /블루투스|bluetooth|무선|유선|2\.4\s?ghz|멀티\s?페어링/i,
      extra: /핫\s?스왑|(?<![a-z])rgb(?![a-z])|한영\s?각인|n\s?키\s?롤오버|백라이트/i
    },
    weak: {},
    // "기계식 키보드 PBT 키캡" 의 키캡은 키보드 설명이다. 키보드라는 말이 없으면 키캡 상품이다.
    descriptors: [/(?<=키보드[^]*)(?:pbt|abs|이중\s?사출)\s*키캡|(?:pbt|abs|이중\s?사출)\s*키캡(?=[^]*키보드)/gi],
    noAnchor: null,
    light: null
  },
  {
    id: 'mouse', label: '마우스', category: '마우스',
    anchors: [
      { kind: 'noun', re: /마우스|(?<![a-z])mouse/i, db: ['마우스'] }
    ],
    acc: groups(['파우치', '케이블', '부품'], {
      마우스패드: ['마우스패드', '장패드', '패드'],
      번지: ['번지'],
      그립: ['그립테이프', '그립 테이프'],
      피트: ['마우스피트', '피트', '스케이트'],
      수신기: ['수신기', '동글', '리시버']
    }),
    parts: [],
    strong: {
      sensor: /(?<![a-z])(?:dpi|cpi)(?![a-z])|(?<![a-z])paw\s?\d{4}|(?<![a-z])hero\s?\d*|폴링\s?레이트|\d{3,4}\s?hz/i,
      conn: /블루투스|bluetooth|무선|유선|2\.4\s?ghz/i,
      form: /버튼|저소음|무소음|버티컬|수직|트랙볼|게이밍/i
    },
    weak: {},
    descriptors: [/수신기\s*(?:포함|내장|수납)/gi],
    noAnchor: null,
    light: 80
  }
];

/*
 * 부속 낱말을 정규식으로. 기기 이름을 품은 낱말(모니터암 · 헤드셋 걸이 · 마우스패드)은
 * 기기 이름을 덮기 «전» 글자에서 찾는다 — 덮은 뒤에는 "###암" 이 되어 못 찾는다.
 */
function compile(P) {
  P.anchors.forEach(a => { a.g = new RegExp(a.re.source, 'gi'); });
  P.accTerms = [];
  Object.keys(P.acc).forEach(g => P.acc[g].forEach(t => P.accTerms.push({
    term: t, group: g, re: termRe(t), whole: P.anchors.some(a => a.re.test(t))
  })));
  // 긴 낱말부터 — "보호필름" 이 "필름" 보다 먼저 잡혀야 근거가 정확하다.
  P.accTerms.sort((a, b) => b.term.length - a.term.length);
  return P;
}
PROFILES.forEach(compile);
const BY_ID = new Map(PROFILES.map(P => [P.id, P]));
const UNRELATED_RE = UNRELATED.map(t => ({ term: t, re: termRe(t) }));

/* 검색 순위용 부속 낱말 목록 — 읽기만 한다 (_hotdeal·_radar 와 같은 지연 로드). */
let searchMod = null;
function accessoryTier() {
  if (searchMod === null) {
    try { searchMod = require('./_search'); } catch (e) { searchMod = false; }
  }
  return (searchMod && Array.isArray(searchMod.ACCESSORY_TIER)) ? searchMod.ACCESSORY_TIER.map(p => p[0]) : [];
}

/** 목록에 없는 카테고리 — 질문의 머리 명사가 기기 이름이다. */
function genericProfile(head) {
  const h = lower(head);
  const tier = accessoryTier();
  // 머리 명사 자체가 부속 낱말이면("보조배터리", "공기청정기 필터") 부속을 찾는 질문이다 — 거르지 않는다.
  const headIsAccessory = tier.some(w => h.indexOf(w) > -1);
  const acc = {};
  if (!headIsAccessory) tier.filter(w => h.indexOf(w) < 0 && w.indexOf(h) < 0).forEach(w => { acc[w] = [w]; });
  return compile({
    id: 'generic', label: head, category: '', generic: true, headIsAccessory,
    anchors: [{ kind: 'noun', re: new RegExp(escapeRe(h).replace(/ /g, '\\s?'), 'i'), db: [head] }],
    acc, parts: [], strong: {}, weak: {}, descriptors: [], noAnchor: null, light: null
  });
}

/* ------------------------------------------------------------------ *
 *  상품명 다듬기
 * ------------------------------------------------------------------ */

function anyAnchor(P, s) { return P.anchors.some(a => a.re.test(s)); }
function strongOf(P, s) { return Object.keys(P.strong).filter(k => P.strong[k].test(s)); }
function weakOf(P, s) { return Object.keys(P.weak).filter(k => P.weak[k].test(s)); }
function firstAcc(P, s) { return P.accTerms.find(x => x.re.test(s)) || null; }

/**
 * 부속 낱말 찾기 — 상품명에 나온 순서대로.
 * @param {string} masked  기기 이름을 덮은 글자
 * @param {string} plain   덮기 전 글자 (기기 이름을 품은 부속 낱말용)
 */
function accHitsOf(P, masked, plain) {
  const hits = [];
  const taken = [];
  P.accTerms.forEach(x => {
    const src = x.whole ? plain : masked;
    const m = src.match(x.re);
    if (!m) return;
    const at = m.index, end = m.index + m[0].length;
    // 이미 잡힌 긴 낱말 안의 짧은 낱말("보호필름" 안의 "필름")은 따로 세지 않는다.
    if (taken.some(r => at >= r[0] && end <= r[1])) return;
    taken.push([at, end]);
    hits.push({ term: x.term, group: x.group, at });
  });
  return hits.sort((a, b) => a.at - b.at);
}
function partOf(P, s) {
  for (const [re, label] of (P.parts || [])) {
    const m = s.match(re);
    if (m) return { text: m[0].trim(), label, at: m.index };
  }
  return null;
}

/**
 * 사은품·묶음 절을 걷어 낸다.
 *   "노트북 … (마우스 증정)"   괄호 속 사은품 절
 *   "노트북 … + 파우치"         '+' 뒤 묶음 — 부속 낱말만 있고 기기 이름이 없을 때
 *   "… 마우스 파우치 키스킨 증정" 증정 앞 낱말들 (기기 이름·사양에서 멈춘다)
 */
function stripBundles(text, P) {
  let t = ` ${lower(text)} `;
  t = t.replace(/[(\[{【]([^)\]}】]*)[)\]}】]/g, (m, inner) => (FREEBIE.test(inner) ? ' ' : ` ${inner} `));
  if (P) {
    t = t.replace(/\+([^,/+|]*)/g, (m, seg) => ((firstAcc(P, seg) || partOf(P, seg)) && !anyAnchor(P, seg) && strongOf(P, seg).length === 0 ? ' ' : ` ${seg}`));
  }
  const segs = t.split(/([,/|])/);
  return segs.map(seg => {
    if (!FREEBIE.test(seg)) return seg;
    const toks = seg.split(' ');
    for (let i = 0; i < toks.length; i++) {
      if (!FREEBIE.test(toks[i])) continue;
      toks[i] = '';
      for (let j = i - 1, n = 0; j >= 0 && n < 4; j--) {
        if (!toks[j]) continue;
        if (P && (anyAnchor(P, toks[j]) || strongOf(P, toks[j]).length)) break;
        toks[j] = ''; n++;
      }
    }
    return toks.join(' ');
  }).join('').replace(/\s+/g, ' ').trim();
}

/** 본체 설명 속 부속 낱말을 걷어 낸다 ("대용량 배터리", "백라이트 키보드"). */
function removeDescriptors(t, P) {
  let s = t;
  (P.descriptors || []).forEach(re => { s = s.replace(new RegExp(re.source, 'gi'), ' '); });
  return s;
}

/** 기기 이름 자리를 같은 길이의 '#' 로 덮는다 — "노트북배터리" 에서 배터리만 남긴다. */
function maskAnchors(t, P) {
  let s = t;
  P.anchors.forEach(a => { s = s.replace(a.g, m => '#'.repeat(m.length)); });
  return s;
}

/** "노트북용", "그램 15Z90N 호환", "갤럭시북 전용", "for macbook" */
function forMarker(t, P) {
  for (const a of P.anchors) {
    a.g.lastIndex = 0;
    let m;
    while ((m = a.g.exec(t)) !== null) {
      if (!m[0].length) { a.g.lastIndex++; continue; }
      const rest = t.slice(m.index + m[0].length);
      if (/^(?:\s?[0-9a-z][0-9a-z\-.]{0,11}){0,2}\s?(?:용|호환용)(?![가-힣])/i.test(rest)
        || /^(?:\s?[0-9a-z가-힣][0-9a-z가-힣\-.]{0,11}){0,2}\s?(?:전용|호환)(?![가-힣])/i.test(rest)) {
        return m[0];
      }
      if (/(?:^|\s)(?:for|호환)\s?$/i.test(t.slice(0, m.index))) return m[0];
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 *  상품명 → 역할
 * ------------------------------------------------------------------ */

/**
 * @param {string} title   판매자 상품명
 * @param {object} target  targetOf() 결과
 * @returns {{role:string, confidence:string, kind:string, term:string|null, group:string|null,
 *            terms:string[], anchor:string|null, strong:string[], weak:string[], why:string}}
 */
function classify(title, target) {
  const P = target && target.P;
  const out = { role: UNKNOWN, confidence: 'low', kind: 'unknown', term: null, group: null, terms: [], anchor: null, strong: [], weak: [], why: '' };
  if (!P || !title) return out;
  const t = stripBundles(title, P);
  const strong = strongOf(P, t);
  const weak = weakOf(P, t);
  out.strong = strong; out.weak = weak;

  const anchorHit = P.anchors.map(a => { const m = t.match(a.re); return m ? m[0] : null; }).find(Boolean) || null;
  out.anchor = anchorHit;
  const plain = removeDescriptors(t, P);
  const masked = maskAnchors(plain, P);

  // 0) 같은 이름을 쓰는 다른 기기 (카메라 ↔ CCTV · 홈캠, 노트북 ↔ 미니PC)
  if (!P.generic && P.others && P.others.test(t) && (!anchorHit || strong.length < MAIN_OVERRIDE)) {
    const m = t.match(P.others);
    return Object.assign(out, { role: OTHER, kind: 'other-device', confidence: 'high', term: m[0], group: m[0], why: `다른 종류의 기기(${m[0]})` });
  }

  // 1) 관련 없는 소모품 (건전지) — 사양이 뚜렷한 본체는 예외
  if (!P.generic && !(target.accessory && UNRELATED.indexOf(lower(target.accessory.term)) > -1)) {
    const u = UNRELATED_RE.find(x => x.re.test(masked));
    if (u && strong.length < MAIN_OVERRIDE) {
      return Object.assign(out, { role: OTHER, kind: 'unrelated', confidence: 'high', term: u.term, group: u.term, terms: [u.term],
        why: `상품명에 «${u.term}» — ${P.label} 부속도 아닌 소모품` });
    }
  }

  // 2) 부속 낱말 · 부품 표기 · «~용/전용/호환»
  let accHits = accHitsOf(P, masked, plain);
  const part = partOf(P, masked);
  const marker = P.generic ? null : forMarker(t, P);
  // 목록 밖 카테고리: 머리 명사 «뒤» 에 오는 부속 낱말만 부속으로 본다 ("뚜껑 있는 텀블러" ≠ "텀블러 뚜껑").
  if (P.generic && accHits.length && anchorHit) {
    const headEnd = plain.lastIndexOf(lower(anchorHit)) + anchorHit.length;
    accHits = accHits.filter(x => x.at >= headEnd);
  }
  out.terms = [...new Set(accHits.map(x => x.term).concat(part ? [part.label] : []))];

  if ((accHits.length || part || marker) && strong.length < MAIN_OVERRIDE) {
    const first = accHits[0];
    const term = first ? first.term : (part ? part.label : '부속');
    return Object.assign(out, {
      role: ACCESSORY, kind: 'accessory', confidence: ((first || part) && (marker || anchorHit)) ? 'high' : 'medium',
      term, group: first ? first.group : (part ? part.label : '부속'),
      why: marker ? `«${marker}» 에 쓰는 물건(${term})` : `상품명에 «${first ? first.term : part.text}» — 본체가 아닌 부속`
    });
  }

  // 3) 기기 이름 — 본체
  if (anchorHit) {
    return Object.assign(out, { role: MAIN, kind: 'main', confidence: (strong.length || weak.length) ? 'high' : 'medium',
      why: strong.length ? `«${anchorHit}» · 본체 사양 표기 ${strong.length}가지` : `«${anchorHit}» 본체` });
  }

  // 4) 다른 기기
  const otherP = PROFILES.find(Q => Q !== P && anyAnchor(Q, t));
  if (!P.generic && otherP) {
    return Object.assign(out, { role: OTHER, kind: 'other-device', confidence: 'medium', term: otherP.label, group: otherP.label, why: `다른 종류의 상품(${otherP.label})` });
  }

  // 5) 이름 없이 사양만 — 사양이 충분하면 본체
  if (P.noAnchor && P.noAnchor(strong, weak)) {
    return Object.assign(out, { role: MAIN, kind: 'main', confidence: 'medium', why: `본체 사양 표기 ${strong.length}가지 (상품명에 «${P.label}» 는 없음)` });
  }
  out.why = `상품명에서 ${P.label} 본체인지 알 수 없음`;
  return out;
}

/* ------------------------------------------------------------------ *
 *  질문 → 찾는 것
 * ------------------------------------------------------------------ */

/**
 * 질문에서 «무엇을» 찾는지 정한다 — 머리 명사 규칙.
 *
 * @param {string} text        사용자 질문 (원문)
 * @param {{tokens?:string[]}} [opts]  목록 밖 카테고리일 때 머리 명사를 고를 낱말들
 * @returns {object|null}  { P, profile, label, role, anchorText, anchorKind, accessory, generic, head }
 */
function targetOf(text, opts) {
  const o = opts || {};
  const t = stripBundles(text, null);
  const hits = [];
  PROFILES.forEach(P => P.anchors.forEach(a => {
    a.g.lastIndex = 0;
    let m;
    while ((m = a.g.exec(t)) !== null) {
      if (!m[0].length) { a.g.lastIndex++; continue; }
      hits.push({ P, a, start: m.index, end: m.index + m[0].length, text: m[0] });
    }
  }));
  // "카메라 좋은 스마트폰" 의 카메라, "키보드가 편한 노트북" 의 키보드 — 조건의 주어는 머리가 아니다.
  const heads = hits.filter(h => !PRED.test(t.slice(h.end)));
  if (heads.length) {
    heads.sort((x, y) => (x.end - y.end) || ((x.end - x.start) - (y.end - y.start)));
    const head = heads[heads.length - 1];
    const P = head.P;
    // 기기 이름을 품은 부속 낱말(모니터암)은 머리 기기 이름부터 본다.
    const plainAfter = removeDescriptors(t.slice(head.start), P);
    const afterHead = plainAfter.slice(head.end - head.start);
    const masked = maskAnchors(afterHead, P);
    let accessory = null;
    for (const x of P.accTerms) {
      const src = x.whole ? plainAfter : masked;
      const m = src.match(x.re);
      if (!m) continue;
      if (PRED.test(src.slice(m.index + m[0].length))) continue;   // "노트북 배터리 오래가는" — 조건
      if (!accessory || m.index < accessory.at) accessory = { term: x.term, group: x.group, at: m.index };
    }
    const part = !accessory && partOf(P, masked);
    if (part && !PRED.test(masked.slice(part.at + part.text.length))) accessory = { term: part.label, group: part.label, at: part.at };
    if (!accessory) {
      // "노트북용 멀티탭" — 목록에 없는 부속도 «~용» 뒤 낱말이면 부속을 찾는 것이다.
      const fm = /^(?:\s?[0-9a-z][0-9a-z\-.]{0,11})?\s?(?:용|전용|호환)\s+([가-힣a-z0-9]{2,12})/i.exec(t.slice(head.end));
      if (fm && !PRED.test(t.slice(head.end + fm.index + fm[0].length))) accessory = { term: fm[1], group: null, at: 0 };
    }
    if (accessory) {
      accessory.synonyms = accessory.group && P.acc[accessory.group] ? P.acc[accessory.group].slice() : [accessory.term];
      delete accessory.at;
    }
    return {
      P, profile: P.id, label: P.label, category: P.category, generic: false,
      role: accessory ? ACCESSORY : MAIN,
      anchorText: head.text.trim(), anchorKind: head.a.kind, anchorDb: head.a.kind === 'series' ? head.a.db.slice() : [head.text.trim()],
      accessory, head: accessory ? accessory.term : head.text.trim()
    };
  }
  // 목록 밖 — 낱말 중 마지막 명사가 머리다.
  const toks = (o.tokens || String(text || '').split(/\s+/))
    .map(s => String(s).trim())
    .filter(s => /[가-힣a-z]/i.test(s) && s.length >= 2 && !PRED.test(` ${s}`) && !STOP.test(s) && !/\d/.test(s));
  const head = toks.length ? toks[toks.length - 1] : '';
  if (!head) return null;
  const P = genericProfile(head);
  return {
    P, profile: 'generic', label: head, category: '', generic: true,
    role: MAIN, anchorText: head, anchorKind: 'noun', anchorDb: [head], accessory: null, head
  };
}

/**
 * 이 역할의 상품이 «찾는 것» 인가.
 * @returns {{ok:boolean, kind:string, reason:string, group:string|null}}
 */
function accepts(target, cls) {
  const label = target.label;
  if (target.role === MAIN) {
    if (cls.role === MAIN) return { ok: true, kind: 'main', reason: '', group: null };
    if (cls.role === ACCESSORY) return { ok: false, kind: 'accessory', group: cls.group || cls.term, reason: `${label} 본체가 아니라 부속품(${cls.term})이에요` };
    if (cls.role === OTHER && cls.kind === 'unrelated') return { ok: false, kind: 'unrelated', group: cls.term, reason: `${label}${josa(label, '과', '와')} 관련 없는 상품(${cls.term})이에요` };
    if (cls.role === OTHER) return { ok: false, kind: 'other-device', group: cls.term, reason: `${label}${josa(label, '이', '가')} 아니라 다른 종류의 상품(${cls.term})이에요` };
    return { ok: false, kind: 'unknown', group: null, reason: `상품명에서 ${label} 본체인지 확인하지 못했어요` };
  }
  const want = target.accessory;
  const hay = (cls.terms || []).map(lower);
  const matches = cls.role === ACCESSORY && (want.synonyms.some(s => hay.indexOf(lower(s)) > -1) || hay.some(h => h.indexOf(lower(want.term)) > -1));
  if (matches) return { ok: true, kind: 'accessory', reason: '', group: null };
  if (cls.role === ACCESSORY) return { ok: false, kind: 'accessory-other', group: cls.group || cls.term, reason: `찾는 ${want.term}${josa(want.term, '이', '가')} 아니라 다른 부속품(${cls.term})이에요` };
  if (cls.role === MAIN) return { ok: false, kind: 'main', group: label, reason: `${label} 본체예요 — 찾는 것은 ${label} ${want.term}` };
  if (cls.role === OTHER) return { ok: false, kind: cls.kind, group: cls.term, reason: `찾는 ${want.term}${josa(want.term, '과', '와')} 관련 없는 상품(${cls.term})이에요` };
  return { ok: false, kind: 'unknown', group: null, reason: `상품명에서 ${label} ${want.term}인지 확인하지 못했어요` };
}

/** 한 줄 설명 — "노트북 본체 (부속품·관련 없는 상품은 제외)" */
function describeTarget(target) {
  if (!target) return '';
  if (target.role === ACCESSORY) return `${target.label}용 ${target.accessory.term}`;
  // 목록 밖 카테고리는 무엇이 «본체» 인지 모른다 — 머리 명사 그대로.
  if (target.generic) return target.label;
  return `${target.label} 본체`;
}

/**
 * 재검색에 쓸 짧은 검색어 — 조건 낱말(배터리·오래가·3개)을 뺀다.
 *   MAIN      [경량] + 기기 이름      "경량 노트북"
 *   ACCESSORY 기기 이름 + 부속       "노트북 배터리"
 */
function searchPhraseOf(target, opts) {
  if (!target) return '';
  const o = opts || {};
  if (target.role === ACCESSORY) return `${target.anchorText} ${target.accessory.term}`.trim();
  const pre = (o.prefix || []).filter(Boolean);
  return pre.concat([target.anchorText]).join(' ').trim();
}

/**
 * 결과 목록을 역할로 가른다 (Concierge 검색 결과처럼 DB 를 거치지 않은 목록에).
 * @returns {{keep:object[], dropped:{title:string, kind:string, reason:string, group:string|null}[]}}
 */
function screen(items, target, titleOf) {
  const keep = [], dropped = [];
  const get = titleOf || (it => it && it.title);
  (items || []).forEach(it => {
    const cls = classify(get(it), target);
    const a = accepts(target, cls);
    if (a.ok) keep.push(it);
    else dropped.push({ title: String(get(it) || ''), kind: a.kind, reason: a.reason, group: a.group });
  });
  return { keep, dropped };
}

/** 제외 사유를 묶어 센다 — 요약·화면용. [{kind, label, count, groups:[{name,count}]}] */
function groupDropped(dropped) {
  const LABEL = { accessory: '부속품', 'accessory-other': '다른 부속품', unrelated: '관련 없는 상품', 'other-device': '다른 종류의 상품', main: '본체', unknown: '확인 불가' };
  const byKind = new Map();
  (dropped || []).forEach(d => {
    if (!LABEL[d.kind]) return;
    if (!byKind.has(d.kind)) byKind.set(d.kind, { kind: d.kind, label: LABEL[d.kind], count: 0, g: new Map() });
    const k = byKind.get(d.kind);
    k.count++;
    if (d.group) k.g.set(d.group, (k.g.get(d.group) || 0) + 1);
  });
  return [...byKind.values()].map(k => ({
    kind: k.kind, label: k.label, count: k.count,
    groups: [...k.g.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1)).map(([name, count]) => ({ name, count }))
  }));
}

module.exports = {
  MAIN, ACCESSORY, OTHER, UNKNOWN, MAIN_OVERRIDE, PROFILES,
  targetOf, classify, accepts, screen, groupDropped, describeTarget, searchPhraseOf,
  profileById: id => BY_ID.get(id) || null,
  _internal: { stripBundles, removeDescriptors, maskAnchors, forMarker, genericProfile, josa, ro, PRED }
};
