'use strict';
// SEOSA AI v3.4 — NEW independent 100-question set (V001–V100).
//
// Written 2026-11-12 BEFORE any v3.4 engine run on these questions. None of
// them comes from the v3.1 online-200, v3.2 holdout/fresh50 or v3.3 online-50
// corpora. The answer criteria (spec) and judge code are frozen by hash in
// reports/ai-v34-evaluation/preregistration.json before the first run; after
// that this file must not change (a changed hash invalidates the run).
//
// spec (judged by scripts/ai-v34/eval/oracle.js, which imports nothing from api/):
//   all      : [[alternatives…], …]  every group must appear in the card title
//              (NFKC, lower-case, only [0-9a-z가-힣] kept)
//   allRe    : [regex source, …]    each must match the normalized title
//   not      : [word, …]            none may appear (flattened substring)
//   notRe    : [regex source, …]    none may match
//   min/max  : card price bounds (KRW); maxExclusive for «미만»
//   floor    : plausible DEVICE price floor (KRW). Below it a listing is a
//              part/accessory or a mislabelled item, never the device.
//   used     : 'exclude' (default) | 'only' | 'any'
//   single   : exactly one card expected («하나만»)
//   sides    : comparison — [specA, specB]; exactly one card per side
// expect:
//   AUTO        FIND if the frozen corpus has ≥1 eligible FRESH item, else NO_RESULT
//   COMPARE     both sides must have eligible items to be FIND
//   NON_SHOPPING no search, no card
//   OUTAGE      fault injected; honest unavailability, never a fabricated «absence»
//   STALE_ONLY  fault injected; no stale price may be shown as current
// plan: what a competent planner (GPT stand-in for the OFFLINE replay) emits.
// fault: { db: 'error'|'timeout'|'stale', vector: 'error'|'timeout', live: … }
//        live faults only matter where a (simulated) live provider is enabled.
const P = (query, category, extra = {}) => ({ mode: 'recommend', query, compareQuery: '', category, maxPrice: null,
  exclusions: [], mallOnly: '', exactModel: '', ...extra });
const C = (query, compareQuery, category) => ({ mode: 'compare', query, compareQuery, category, maxPrice: null,
  exclusions: [], mallOnly: '', exactModel: '' });
const LAPTOP = ['노트북', 'laptop', 'lg그램', '엘지그램', '그램14', '그램15', '그램16', '그램17', '그램프로', '그램360', '그램스타일', '그램북', '맥북', 'macbook', '갤럭시북', 'galaxybook', '비보북', 'vivobook', '아이디어패드', 'ideapad', '씽크패드', 'thinkpad', '젠북', 'zenbook', '크롬북', 'chromebook', '레노버'];
const LG = ['lg', '엘지', 'lg그램', '엘지그램'];
const EARBUD = ['이어폰', '이어버드', '버즈', 'buds', '에어팟', 'airpods', 'earbud', 'tws'];
const WIRELESS = ['무선', '블루투스', 'wireless', 'bluetooth', 'tws', '24ghz', '24g'];
const TABLET = ['태블릿', '아이패드', 'ipad', '갤럭시탭', 'galaxytab', '아이디어탭', 'ideatab', '레드미패드', 'redmipad', '샤오미패드', 'xiaomipad', '메이트패드', 'matepad', '갤탭'];
const PHONE = ['갤럭시s2', 'galaxys2', '갤럭시a', 'galaxya', '갤럭시z', 'galaxyz', 'z플립', 'z폴드', '아이폰1', 'iphone1', '갤럭시퀀텀', '갤럭시점프'];
const ANC = ['노이즈캔슬링', '노캔', 'anc', '액티브노이즈'];
// Oracle calibration (2026-11-12, before any engine run): exclusions found by
// inspecting the cheapest gold titles — bags/monitors are not laptops, ear
// pads are not tablets, carrier contracts are not a purchase price, a single
// left/right earbud is not the product, a seller store page is not one SKU.
const CARRIER = '(?<![a-z])(?:kt|skt|lgu\\+?)(?![a-z])|요금제|번호이동|기기변경|공통지원|선택약정';
const SINGLE_UNIT = '(?:왼쪽|오른쪽|한쪽|좌측|우측)\\s*(?:유닛|이어폰|단품)|낱개|유닛\\s*단품';
// Another model code of the same letter series («G102/G304/G502» store pages).
const otherCode = (letter, keep) => '(?<![a-z0-9])' + letter + '(?!' + keep + '(?![0-9]))\\d{' + (keep.length === 3 ? '3' : '1,2') + '}(?![0-9])';
const X = (spec, ...extras) => {
  const out = { ...spec, not: [...(spec.not || [])], notRe: [...(spec.notRe || [])] };
  for (const e of extras) { out.not.push(...(e.not || [])); out.notRe.push(...(e.notRe || [])); }
  if (!out.not.length) delete out.not;
  if (!out.notRe.length) delete out.notRe;
  return out;
};
const LAPTOP_X = { not: ['가방', '백팩', '파우치', '모니터', '쿨러', '쿨링', '받침', '거치대', '스탠드', '키스킨', '보호필름', '어댑터', '충전기', '도킹', '허브', '태블릿', '아이디어탭', 'ideatab', '테이블', '책상', '마우스', '키보드', '클러치', '이어폰', '헤드셋', '이어버드', '스피커', 'nvme', '솔리드스테이트'], notRe: ['랜덤', '노트북\\s*(?:용|전용)'] };
const TABLET_X = { not: ['이어패드', '키보드', '케이스', '커버', '필름', '펜슬', '거치대', '드럼', '게임패드', '마우스패드', '스탠드', '받침', '테이블', '삼각대', '스탠딩', '이어폰', '헤드셋', '이어버드', '스피커', '마우스'], notRe: [CARRIER] };
const EARBUD_X = { notRe: [SINGLE_UNIT] };
const HEADPHONE_X = { not: ['이어폰', '이어버드'] };
const MONITOR_X = { not: ['룸미러', '후방카메라', '블랙박스', '모니터암', '모니터받침', '받침대', '베이비', '오디오인터페이스'], notRe: ['모니터링'] };
const PURIFIER_X = { not: ['의류청정기', '렌탈', '렌털', '정수기', '차량용'] };
const PHONE_X = { notRe: [CARRIER] };
const WATCH = ['스마트워치', 'smartwatch', '애플워치', 'applewatch', '갤럭시워치', 'galaxywatch', '가민', 'garmin', '어메이즈핏', 'amazfit', '핏빗', 'fitbit', '샤오미워치', '레드미워치', '화웨이워치', 'watchgt'];
const SSD_X = { not: ['sd카드', '메모리카드', 'microsd', '마이크로sd'] };
const IPHONE17_VARIANT = '(?:아이폰|iphone)\\s*17\\s*(?:프로|pro|에어|air|플러스|plus|맥스|max|e(?![a-z]))';

const questions = [
  // ── 1. budget ───────────────────────────────────────────────────────────
  { id: 'V001', type: 'budget', cat: '노트북', turns: [{ p: '50만원 이하 노트북 추천해줘', plan: P('노트북', '노트북', { maxPrice: 500000 }),
    spec: X({ all: [LAPTOP], max: 500000, floor: 150000 }, LAPTOP_X), expect: 'AUTO' }] },
  { id: 'V002', type: 'budget', cat: '이어폰', turns: [{ p: '10만원 이하 무선 이어폰 찾아줘', plan: P('무선 이어폰', '이어폰', { maxPrice: 100000 }),
    spec: X({ all: [EARBUD, WIRELESS], max: 100000, floor: 10000 }, EARBUD_X), expect: 'AUTO' }] },
  { id: 'V003', type: 'budget', cat: '태블릿', turns: [{ p: '30만원대 태블릿 추천해 주세요', plan: P('태블릿', '태블릿', { maxPrice: 399999 }),
    spec: X({ all: [TABLET], min: 300000, max: 399999, floor: 100000 }, TABLET_X), expect: 'AUTO' }] },
  { id: 'V004', type: 'budget', cat: '스피커', turns: [{ p: '5만원 이하 블루투스 스피커 있어?', plan: P('블루투스 스피커', '스피커', { maxPrice: 50000 }),
    spec: { all: [['스피커', 'speaker'], WIRELESS], max: 50000, floor: 10000 }, expect: 'AUTO' }] },
  { id: 'V005', type: 'budget', cat: '공기청정기', turns: [{ p: '20만원 미만 공기청정기 추천해 줘', plan: P('공기청정기', '공기청정기', { maxPrice: 200000 }),
    spec: X({ all: [['공기청정기', '청정기']], max: 200000, maxExclusive: true, floor: 30000 }, PURIFIER_X), expect: 'AUTO' }] },
  { id: 'V006', type: 'budget', cat: '마우스', turns: [{ p: '3만원 이하 무선 마우스 추천', plan: P('무선 마우스', '마우스', { maxPrice: 30000 }),
    spec: { all: [['마우스', 'mouse'], WIRELESS], max: 30000, floor: 5000 }, expect: 'AUTO' }] },
  { id: 'V007', type: 'budget', cat: '모니터', turns: [{ p: '100만원 이하 게이밍 모니터 골라줘', plan: P('게이밍 모니터', '모니터', { maxPrice: 1000000 }),
    spec: X({ all: [['모니터', 'monitor'], ['게이밍', 'gaming']], max: 1000000, floor: 80000 }, MONITOR_X), expect: 'AUTO' }] },
  { id: 'V008', type: 'budget', cat: '청소기', turns: [{ p: '15만원 이하 무선 청소기 추천해줘', plan: P('무선 청소기', '청소기', { maxPrice: 150000 }),
    spec: { all: [['청소기'], ['무선', '코드리스', 'cordless']], max: 150000, floor: 30000, not: ['로봇', '차량용'] }, expect: 'AUTO' }] },
  { id: 'V009', type: 'budget', cat: '시계', turns: [{ p: '40만원 이하 스마트워치 추천', plan: P('스마트워치', '스마트워치', { maxPrice: 400000 }),
    spec: { all: [WATCH], max: 400000, floor: 30000, not: ['키즈', '어린이', '스톱워치', '가이드', 'guide', '타이머', '밴드', '버클', '스트랩'] }, expect: 'AUTO' }] },
  { id: 'V010', type: 'budget', cat: '키보드', turns: [{ p: '7만원 이하 기계식 키보드 추천해줘', plan: P('기계식 키보드', '키보드', { maxPrice: 70000 }),
    spec: { all: [['키보드', 'keyboard'], ['기계식', 'mechanical']], max: 70000, floor: 15000 }, expect: 'AUTO' }] },

  // ── 2. specific model ───────────────────────────────────────────────────
  { id: 'V011', type: 'model', cat: '스마트폰', turns: [{ p: '갤럭시 S25 울트라 가격 알려줘', plan: P('갤럭시 S25 울트라', '스마트폰', { exactModel: '갤럭시 S25 울트라' }),
    spec: X({ all: [['갤럭시', 'galaxy'], ['s25울트라', 's25ultra']], floor: 700000 }, PHONE_X), expect: 'AUTO' }] },
  { id: 'V012', type: 'model', cat: '마우스', turns: [{ p: '로지텍 G304 무선 마우스 찾아줘', plan: P('로지텍 G304 무선 마우스', '마우스', { exactModel: 'G304' }),
    spec: { all: [['로지텍', 'logitech'], ['g304']], notRe: [otherCode('g', '304')], floor: 8000 }, expect: 'AUTO' }] },
  { id: 'V013', type: 'model', cat: '헤드폰', turns: [{ p: '소니 WH-1000XM5 헤드폰 최저가', plan: P('소니 WH-1000XM5', '헤드폰', { exactModel: 'WH-1000XM5' }),
    spec: X({ all: [['소니', 'sony'], ['wh1000xm5']], floor: 150000 }, HEADPHONE_X), expect: 'AUTO' }] },
  { id: 'V014', type: 'model', cat: '이어폰', turns: [{ p: '에어팟 프로 2 찾아줘', plan: P('에어팟 프로 2', '이어폰', { exactModel: '에어팟 프로 2' }),
    spec: X({ all: [['에어팟프로2', 'airpodspro2']], floor: 150000 }, EARBUD_X), expect: 'AUTO' }] },
  { id: 'V015', type: 'model', cat: '외장하드', turns: [{ p: '삼성 T9 1TB 외장 SSD 보여줘', plan: P('삼성 T9 1TB 외장 SSD', '외장하드', { exactModel: 'T9' }),
    spec: X({ all: [['삼성', 'samsung'], ['t9'], ['1tb', '1테라']], not: ['2tb', '4tb', '2테라', '4테라'], floor: 80000 }, SSD_X), expect: 'AUTO' }] },
  { id: 'V016', type: 'model', cat: '이어폰', turns: [{ p: '갤럭시 버즈3 프로 최저가 알려줘', plan: P('갤럭시 버즈3 프로', '이어폰', { exactModel: '버즈3 프로' }),
    spec: X({ all: [['버즈3프로', 'buds3pro']], floor: 100000 }, EARBUD_X), expect: 'AUTO' }] },
  { id: 'V017', type: 'model', cat: '태블릿', turns: [{ p: '아이패드 에어 11 M3 와이파이 128GB 찾아줘', plan: P('아이패드 에어 11 M3 와이파이 128GB', '태블릿', { exactModel: '아이패드 에어 11 M3' }),
    spec: { all: [['아이패드에어', 'ipadair'], ['m3'], ['128gb', '128g'], ['와이파이', 'wifi']], not: ['셀룰러', 'cellular', '256gb', '512gb', '1tb', '13인치', '13형'], floor: 500000 }, expect: 'AUTO' }] },
  { id: 'V018', type: 'model', cat: '마우스', turns: [{ p: '로지텍 MX Master 3S 마우스 추천', plan: P('로지텍 MX Master 3S', '마우스', { exactModel: 'MX Master 3S' }),
    spec: { all: [['로지텍', 'logitech'], ['mxmaster3s']], floor: 60000 }, expect: 'AUTO' }] },
  { id: 'V019', type: 'model', cat: '청소기', turns: [{ p: '다이슨 V12 무선청소기 가격', plan: P('다이슨 V12 무선청소기', '청소기', { exactModel: 'V12' }),
    spec: { all: [['다이슨', 'dyson'], ['v12']], notRe: [otherCode('v', '12')], floor: 300000 }, expect: 'AUTO' }] },
  { id: 'V020', type: 'model', cat: '시계', turns: [{ p: '갤럭시 워치7 가격 알려줘', plan: P('갤럭시 워치7', '스마트워치', { exactModel: '갤럭시 워치7' }),
    spec: { all: [['갤럭시', 'galaxy'], ['워치7', 'watch7']], notRe: ['(?:워치|watch)7\\s*(?:울트라|ultra|클래식|classic)'], floor: 150000 }, expect: 'AUTO' }] },

  // ── 3. brand ────────────────────────────────────────────────────────────
  { id: 'V021', type: 'brand', cat: '노트북', turns: [{ p: 'LG 노트북 100만원 이하로 추천해줘', plan: P('LG 노트북', '노트북', { maxPrice: 1000000 }),
    spec: X({ all: [LG, LAPTOP], max: 1000000, floor: 300000 }, LAPTOP_X), expect: 'AUTO' }] },
  { id: 'V022', type: 'brand', cat: '태블릿', turns: [{ p: '삼성 태블릿 추천해 줘', plan: P('삼성 태블릿', '태블릿'),
    spec: X({ all: [['삼성', 'samsung', '갤럭시', 'galaxy'], TABLET], floor: 150000 }, TABLET_X), expect: 'AUTO' }] },
  { id: 'V023', type: 'brand', cat: '헤드폰', turns: [{ p: '소니 무선 헤드폰 추천해줘', plan: P('소니 무선 헤드폰', '헤드폰'),
    spec: X({ all: [['소니', 'sony'], ['헤드폰', '헤드셋', 'headphone', 'wh1000', 'whch', 'ult']], floor: 60000 }, HEADPHONE_X), expect: 'AUTO' }] },
  { id: 'V024', type: 'brand', cat: '청소기', turns: [{ p: '로보락 로봇청소기 추천', plan: P('로보락 로봇청소기', '청소기'),
    spec: { all: [['로보락', 'roborock'], ['청소기', '로봇']], floor: 200000 }, expect: 'AUTO' }] },
  { id: 'V025', type: 'brand', cat: '이어폰', turns: [{ p: '애플 이어폰 30만원 이하로 보여줘', plan: P('애플 에어팟', '이어폰', { maxPrice: 300000 }),
    spec: X({ all: [['에어팟', 'airpods']], not: ['맥스', 'max'], max: 300000, floor: 100000 }, EARBUD_X), expect: 'AUTO' }] },
  { id: 'V026', type: 'brand', cat: '공기청정기', turns: [{ p: '위닉스 공기청정기 추천해줘', plan: P('위닉스 공기청정기', '공기청정기'),
    spec: X({ all: [['위닉스', 'winix'], ['공기청정기', '청정기']], notRe: ['청정기\\s*/\\s*(?:가습기|제습기|건조기)'], floor: 80000 }, PURIFIER_X), expect: 'AUTO' }] },
  { id: 'V027', type: 'brand', cat: '외장하드', turns: [{ p: '샌디스크 외장 SSD 추천', plan: P('샌디스크 외장 SSD', '외장하드'),
    spec: { all: [['샌디스크', 'sandisk'], ['ssd'], ['외장', '포터블', 'portable', 'extreme', '익스트림']], floor: 40000 }, expect: 'AUTO' }] },
  { id: 'V028', type: 'brand', cat: '스피커', turns: [{ p: 'JBL 블루투스 스피커 보여줘', plan: P('JBL 블루투스 스피커', '스피커'),
    spec: { all: [['jbl'], ['스피커', 'speaker'], WIRELESS], floor: 30000 }, expect: 'AUTO' }] },
  { id: 'V029', type: 'brand', cat: '노트북', turns: [{ p: '레노버 노트북 80만원 이하', plan: P('레노버 노트북', '노트북', { maxPrice: 800000 }),
    spec: X({ all: [['레노버', 'lenovo', '아이디어패드', 'ideapad', '씽크패드', 'thinkpad', '리전', 'legion'], LAPTOP], max: 800000, floor: 250000 }, LAPTOP_X), expect: 'AUTO' }] },
  { id: 'V030', type: 'brand', cat: '스피커', turns: [{ p: '마샬 스피커 추천해줘', plan: P('마샬 스피커', '스피커'),
    spec: { all: [['마샬', 'marshall'], ['스피커', 'speaker', '엠버튼', 'emberton', '액톤', 'acton', '스탠모어', 'stanmore', '윌렌', 'willen', '미들턴', 'middleton', '킬번', 'kilburn']], floor: 100000 }, expect: 'AUTO' }] },

  // ── 4. category / use case ──────────────────────────────────────────────
  { id: 'V031', type: 'category', cat: '노트북', turns: [{ p: '대학생용 가벼운 노트북 추천해줘', plan: P('가벼운 노트북', '노트북'),
    spec: X({ all: [LAPTOP], floor: 200000 }, LAPTOP_X), expect: 'AUTO' }] },
  { id: 'V032', type: 'category', cat: '태블릿', turns: [{ p: '아이 인강용 태블릿 뭐가 좋아?', plan: P('인강용 태블릿', '태블릿'),
    spec: X({ all: [TABLET], floor: 100000 }, TABLET_X), expect: 'AUTO' }] },
  { id: 'V033', type: 'category', cat: '이어폰', turns: [{ p: '운동할 때 쓸 무선 이어폰 추천', plan: P('운동용 무선 이어폰', '이어폰'),
    spec: X({ all: [EARBUD, WIRELESS], floor: 10000 }, EARBUD_X), expect: 'AUTO' }] },
  { id: 'V034', type: 'category', cat: '공기청정기', turns: [{ p: '원룸에서 쓸 공기청정기 추천해줘', plan: P('원룸 공기청정기', '공기청정기'),
    spec: X({ all: [['공기청정기', '청정기']], floor: 30000 }, PURIFIER_X), expect: 'AUTO' }] },
  { id: 'V035', type: 'category', cat: '모니터', turns: [{ p: '재택근무용 27인치 모니터 추천', plan: P('27인치 모니터', '모니터'),
    spec: X({ all: [['모니터', 'monitor'], ['27인치', '27형', '686cm', '685cm', '68cm']], floor: 100000 }, MONITOR_X), expect: 'AUTO' }] },
  { id: 'V036', type: 'category', cat: '마우스', turns: [{ p: '사무실에서 쓸 조용한 무선 마우스', plan: P('저소음 무선 마우스', '마우스'),
    spec: { all: [['마우스', 'mouse'], WIRELESS, ['저소음', '무소음', 'silent', '조용']], floor: 5000 }, expect: 'AUTO' }] },
  { id: 'V037', type: 'category', cat: '스피커', turns: [{ p: '캠핑 갈 때 쓸 블루투스 스피커 추천해줘', plan: P('캠핑용 블루투스 스피커', '스피커'),
    spec: { all: [['스피커', 'speaker'], WIRELESS], floor: 10000 }, expect: 'AUTO' }] },
  { id: 'V038', type: 'category', cat: '스마트폰', turns: [{ p: '부모님 드릴 스마트폰 추천해줘', plan: P('부모님 스마트폰', '스마트폰'),
    spec: X({ all: [PHONE], not: ['케이스', '필름', '거치대', '프린터', '렌즈', '짐벌', '셀카봉', '충전', 'custodia', '보드', '이어폰', '헤드셋'], notRe: ['(?:아이폰|iphone|갤럭시|galaxy)[^,/]{0,24}용(?![가-힣])'], floor: 150000 }, PHONE_X), expect: 'AUTO' }] },
  { id: 'V039', type: 'category', cat: '청소기', turns: [{ p: '자취방 로봇청소기 추천해줘', plan: P('로봇청소기', '청소기'),
    spec: { all: [['로봇'], ['청소기']], floor: 100000 }, expect: 'AUTO' }] },
  { id: 'V040', type: 'category', cat: '헤드폰', turns: [{ p: '출퇴근용 노이즈캔슬링 헤드폰 추천해줘', plan: P('노이즈캔슬링 헤드폰', '헤드폰'),
    spec: X({ all: [['헤드폰', '헤드셋', 'headphone'], ANC], floor: 50000 }, HEADPHONE_X), expect: 'AUTO' }] },

  // ── 5. comparison (exactly one card per side) ───────────────────────────
  { id: 'V041', type: 'compare', cat: '이어폰', turns: [{ p: '갤럭시 버즈3 프로랑 에어팟 프로 2 비교해줘', plan: C('갤럭시 버즈3 프로', '에어팟 프로 2', '이어폰'),
    spec: { sides: [X({ all: [['버즈3프로', 'buds3pro']], floor: 100000 }, EARBUD_X), X({ all: [['에어팟프로2', 'airpodspro2']], floor: 150000 }, EARBUD_X)] }, expect: 'COMPARE' }] },
  { id: 'V042', type: 'compare', cat: '마우스', turns: [{ p: '로지텍 G304랑 G502 비교해줘', plan: C('로지텍 G304', '로지텍 G502', '마우스'),
    spec: { sides: [{ all: [['g304']], notRe: [otherCode('g', '304')], floor: 8000 }, { all: [['g502']], not: ['슈퍼라이트', 'superlight', '애니웨어', 'anywhere'], notRe: [otherCode('g', '502')], floor: 30000 }] }, expect: 'COMPARE' }] },
  { id: 'V043', type: 'compare', cat: '태블릿', turns: [{ p: '아이패드 에어랑 갤럭시탭 S10 FE 비교해줘', plan: C('아이패드 에어', '갤럭시탭 S10 FE', '태블릿'),
    spec: { sides: [X({ all: [['아이패드에어', 'ipadair']], floor: 500000 }, TABLET_X),
      X({ all: [['s10fe']], notRe: ['s10\\s*fe\\s*(?:\\+|플러스|plus)'], floor: 300000 }, TABLET_X)] }, expect: 'COMPARE' }] },
  { id: 'V044', type: 'compare', cat: '헤드폰', turns: [{ p: '소니 WH-1000XM5와 XM6 차이 비교해줘', plan: C('소니 WH-1000XM5', '소니 WH-1000XM6', '헤드폰'),
    spec: { sides: [X({ all: [['wh1000xm5']], floor: 150000 }, HEADPHONE_X), X({ all: [['wh1000xm6']], floor: 200000 }, HEADPHONE_X)] }, expect: 'COMPARE' }] },
  { id: 'V045', type: 'compare', cat: '외장하드', turns: [{ p: '삼성 T7이랑 T9 외장 SSD 비교', plan: C('삼성 T7 외장 SSD', '삼성 T9 외장 SSD', '외장하드'),
    spec: { sides: [X({ all: [['t7'], ['ssd', '외장']], not: ['쉴드', 'shield'], floor: 60000 }, SSD_X), X({ all: [['t9'], ['ssd', '외장']], floor: 80000 }, SSD_X)] }, expect: 'COMPARE' }] },
  { id: 'V046', type: 'compare', cat: '노트북', turns: [{ p: '그램 15랑 맥북 에어 비교해줘', plan: C('LG 그램 15', '맥북 에어', '노트북'),
    spec: { sides: [X({ all: [['그램15', '15z9', '15zd9', '15t9', '그램 15']], floor: 500000 }, LAPTOP_X), X({ all: [['맥북에어', 'macbookair']], floor: 800000 }, LAPTOP_X)] }, expect: 'COMPARE' }] },
  { id: 'V047', type: 'compare', cat: '청소기', turns: [{ p: '다이슨 V12랑 V15 비교해줘', plan: C('다이슨 V12', '다이슨 V15', '청소기'),
    spec: { sides: [{ all: [['다이슨', 'dyson'], ['v12']], notRe: [otherCode('v', '12')], floor: 300000 }, { all: [['다이슨', 'dyson'], ['v15']], notRe: [otherCode('v', '15')], floor: 400000 }] }, expect: 'COMPARE' }] },
  { id: 'V048', type: 'compare', cat: '이어폰', turns: [{ p: '에어팟 4랑 에어팟 프로 3 뭐가 나아?', plan: C('에어팟 4', '에어팟 프로 3', '이어폰'),
    spec: { sides: [X({ all: [['에어팟4', 'airpods4']], not: ['프로', 'pro'], floor: 100000 }, EARBUD_X), X({ all: [['에어팟프로3', 'airpodspro3']], floor: 200000 }, EARBUD_X)] }, expect: 'COMPARE' }] },
  { id: 'V049', type: 'compare', cat: '스마트폰', turns: [{ p: '갤럭시 S25 울트라 vs 아이폰 17 프로 비교', plan: C('갤럭시 S25 울트라', '아이폰 17 프로', '스마트폰'),
    spec: { sides: [X({ all: [['s25울트라', 's25ultra']], floor: 700000 }, PHONE_X),
      X({ all: [['아이폰17프로', 'iphone17pro']], notRe: ['(?:프로|pro)\\s*(?:맥스|max)'], floor: 900000 }, PHONE_X)] }, expect: 'COMPARE' }] },
  { id: 'V050', type: 'compare', cat: '공기청정기', turns: [{ p: '위닉스랑 코웨이 공기청정기 비교해줘', plan: C('위닉스 공기청정기', '코웨이 공기청정기', '공기청정기'),
    spec: { sides: [X({ all: [['위닉스', 'winix'], ['청정기']], floor: 80000 }, PURIFIER_X), X({ all: [['코웨이', 'coway'], ['청정기']], floor: 80000 }, PURIFIER_X)] }, expect: 'COMPARE' }] },

  // ── 6. follow-ups (state must survive turns) ────────────────────────────
  { id: 'V051', type: 'followup', cat: '이어폰', turns: [
    { p: '무선 이어폰 추천해줘', plan: P('무선 이어폰', '이어폰'), spec: X({ all: [EARBUD, WIRELESS], floor: 10000 }, EARBUD_X), expect: 'AUTO' },
    { p: '10만원 이하로', plan: P('무선 이어폰', '이어폰', { maxPrice: 100000 }), spec: X({ all: [EARBUD, WIRELESS], max: 100000, floor: 10000 }, EARBUD_X), expect: 'AUTO' },
    { p: '그중에 노이즈캔슬링 되는 걸로', plan: P('무선 이어폰', '이어폰'), spec: X({ all: [EARBUD, WIRELESS, ANC], max: 100000, floor: 10000, amongPrevious: true }, EARBUD_X), expect: 'DYNAMIC' }] },
  { id: 'V052', type: 'followup', cat: '노트북', turns: [
    { p: '노트북 추천해줘', plan: P('노트북', '노트북'), spec: X({ all: [LAPTOP], floor: 200000 }, LAPTOP_X), expect: 'AUTO' },
    { p: 'LG 걸로 보여줘', plan: P('LG 노트북', '노트북'), spec: X({ all: [LG, LAPTOP], floor: 300000 }, LAPTOP_X), expect: 'AUTO' },
    { p: '80만원 이하만', plan: P('LG 노트북', '노트북', { maxPrice: 800000 }), spec: X({ all: [LG, LAPTOP], max: 800000, floor: 300000 }, LAPTOP_X), expect: 'AUTO' }] },
  { id: 'V053', type: 'followup', cat: '태블릿', turns: [
    { p: '삼성 태블릿 보여줘', plan: P('삼성 태블릿', '태블릿'), spec: X({ all: [['삼성', 'samsung', '갤럭시', 'galaxy'], TABLET], floor: 150000 }, TABLET_X), expect: 'AUTO' },
    { p: '와이파이 모델만', plan: P('삼성 태블릿 와이파이', '태블릿'), spec: X({ all: [['삼성', 'samsung', '갤럭시', 'galaxy'], TABLET, ['와이파이', 'wifi']], not: ['셀룰러', 'lte', '5g'], floor: 150000 }, TABLET_X), expect: 'AUTO' },
    { p: '50만원 이하로 다시 찾아줘', plan: P('삼성 태블릿 와이파이', '태블릿', { maxPrice: 500000 }), spec: X({ all: [['삼성', 'samsung', '갤럭시', 'galaxy'], TABLET, ['와이파이', 'wifi']], not: ['셀룰러', 'lte', '5g'], max: 500000, floor: 150000 }, TABLET_X), expect: 'AUTO' }] },
  { id: 'V054', type: 'followup', cat: '스피커', turns: [
    { p: '블루투스 스피커 추천해줘', plan: P('블루투스 스피커', '스피커'), spec: { all: [['스피커', 'speaker'], WIRELESS], floor: 10000 }, expect: 'AUTO' },
    { p: 'JBL은 빼고', plan: P('블루투스 스피커', '스피커', { exclusions: ['JBL'] }), spec: { all: [['스피커', 'speaker'], WIRELESS], not: ['jbl'], floor: 10000 }, expect: 'AUTO' },
    { p: '5만원 이하로', plan: P('블루투스 스피커', '스피커', { maxPrice: 50000 }), spec: { all: [['스피커', 'speaker'], WIRELESS], not: ['jbl'], max: 50000, floor: 10000 }, expect: 'AUTO' }] },
  { id: 'V055', type: 'followup', cat: '청소기', turns: [
    { p: '로봇청소기 추천해줘', plan: P('로봇청소기', '청소기'), spec: { all: [['로봇'], ['청소기']], floor: 100000 }, expect: 'AUTO' },
    { p: '물걸레 되는 걸로', plan: P('물걸레 로봇청소기', '청소기'), spec: { all: [['로봇'], ['청소기'], ['물걸레']], floor: 100000 }, expect: 'AUTO' },
    { p: '50만원 이하만 보여줘', plan: P('물걸레 로봇청소기', '청소기', { maxPrice: 500000 }), spec: { all: [['로봇'], ['청소기'], ['물걸레']], max: 500000, floor: 100000 }, expect: 'AUTO' }] },
  { id: 'V056', type: 'followup', cat: '스마트폰', turns: [
    { p: '아이폰 17 가격 알려줘', plan: P('아이폰 17', '스마트폰'), spec: { all: [['아이폰17', 'iphone17']], notRe: [IPHONE17_VARIANT, CARRIER], floor: 900000 }, expect: 'AUTO' },
    { p: '프로 말고 기본 모델로', plan: P('아이폰 17 기본', '스마트폰'), spec: { all: [['아이폰17', 'iphone17']], notRe: [IPHONE17_VARIANT, CARRIER], floor: 900000 }, expect: 'AUTO' },
    { p: '256GB로 찾아줘', plan: P('아이폰 17 256GB', '스마트폰'), spec: { all: [['아이폰17', 'iphone17'], ['256gb', '256g']], not: ['128gb', '512gb', '1tb'], notRe: [IPHONE17_VARIANT, CARRIER], floor: 900000 }, expect: 'AUTO' }] },
  { id: 'V057', type: 'followup', cat: '마우스', turns: [
    { p: '게이밍 마우스 추천해줘', plan: P('게이밍 마우스', '마우스'), spec: { all: [['마우스', 'mouse'], ['게이밍', 'gaming']], floor: 8000 }, expect: 'AUTO' },
    { p: '무선으로', plan: P('무선 게이밍 마우스', '마우스'), spec: { all: [['마우스', 'mouse'], ['게이밍', 'gaming'], WIRELESS], floor: 8000 }, expect: 'AUTO' },
    { p: '로지텍 제품만 보여줘', plan: P('로지텍 무선 게이밍 마우스', '마우스'), spec: { all: [['마우스', 'mouse'], ['게이밍', 'gaming'], WIRELESS, ['로지텍', 'logitech']], floor: 8000 }, expect: 'AUTO' }] },
  { id: 'V058', type: 'followup', cat: '모니터', turns: [
    { p: '모니터 추천해줘', plan: P('모니터', '모니터'), spec: X({ all: [['모니터', 'monitor']], floor: 60000 }, MONITOR_X), expect: 'AUTO' },
    { p: '27인치로', plan: P('27인치 모니터', '모니터'), spec: X({ all: [['모니터', 'monitor'], ['27인치', '27형', '686cm', '685cm', '68cm']], floor: 60000 }, MONITOR_X), expect: 'AUTO' },
    { p: '30만원 이하로 다시', plan: P('27인치 모니터', '모니터', { maxPrice: 300000 }), spec: X({ all: [['모니터', 'monitor'], ['27인치', '27형', '686cm', '685cm', '68cm']], max: 300000, floor: 60000 }, MONITOR_X), expect: 'AUTO' }] },
  { id: 'V059', type: 'followup', cat: '이어폰', turns: [
    { p: '에어팟 프로 3 얼마야?', plan: P('에어팟 프로 3', '이어폰', { exactModel: '에어팟 프로 3' }), spec: X({ all: [['에어팟프로3', 'airpodspro3']], floor: 200000 }, EARBUD_X), expect: 'AUTO' },
    { p: '중고는 빼줘', plan: P('에어팟 프로 3', '이어폰', { exclusions: ['중고'] }), spec: X({ all: [['에어팟프로3', 'airpodspro3']], floor: 200000 }, EARBUD_X), expect: 'AUTO' },
    { p: '가장 싼 거 하나만', plan: P('에어팟 프로 3', '이어폰'), spec: X({ all: [['에어팟프로3', 'airpodspro3']], floor: 200000, single: true }, EARBUD_X), expect: 'AUTO' }] },
  { id: 'V060', type: 'followup', cat: '외장하드', turns: [
    { p: '외장 SSD 추천해줘', plan: P('외장 SSD', '외장하드'), spec: { all: [['ssd'], ['외장', '포터블', 'portable']], floor: 40000 }, expect: 'AUTO' },
    { p: '1TB로', plan: P('외장 SSD 1TB', '외장하드'), spec: { all: [['ssd'], ['외장', '포터블', 'portable'], ['1tb', '1테라']], not: ['2tb', '4tb'], floor: 40000 }, expect: 'AUTO' },
    { p: '삼성 제품은 제외해줘', plan: P('외장 SSD 1TB', '외장하드', { exclusions: ['삼성'] }), spec: { all: [['ssd'], ['외장', '포터블', 'portable'], ['1tb', '1테라']], not: ['2tb', '4tb', '삼성', 'samsung'], floor: 40000 }, expect: 'AUTO' }] },

  // ── 7. exact option ─────────────────────────────────────────────────────
  { id: 'V061', type: 'option', cat: '스마트폰', turns: [{ p: '아이폰 17 256GB 자급제 찾아줘', plan: P('아이폰 17 256GB 자급제', '스마트폰', { exactModel: '아이폰 17' }),
    spec: { all: [['아이폰17', 'iphone17'], ['256gb', '256g']], not: ['128gb', '512gb', '1tb'], notRe: [IPHONE17_VARIANT, CARRIER], floor: 900000 }, expect: 'AUTO' }] },
  { id: 'V062', type: 'option', cat: '태블릿', turns: [{ p: '갤럭시탭 S10 FE 플러스 256GB 보여줘', plan: P('갤럭시탭 S10 FE 플러스 256GB', '태블릿', { exactModel: 'S10 FE+' }),
    spec: X({ allRe: ['s10\\s*fe\\s*(?:\\+|플러스|plus)'], all: [['256gb', '256g']], not: ['128gb', '512gb'], floor: 500000 }, TABLET_X), expect: 'AUTO' }] },
  { id: 'V063', type: 'option', cat: '스마트폰', turns: [{ p: '갤럭시 S25 엣지 512GB 가격', plan: P('갤럭시 S25 엣지 512GB', '스마트폰', { exactModel: 'S25 엣지' }),
    spec: X({ all: [['s25엣지', 's25edge'], ['512gb', '512g']], not: ['256gb', '1tb'], floor: 1000000 }, PHONE_X), expect: 'AUTO' }] },
  { id: 'V064', type: 'option', cat: '노트북', turns: [{ p: '맥북 에어 13 M4 16GB 256GB 찾아줘', plan: P('맥북 에어 13 M4 16GB 256GB', '노트북', { exactModel: '맥북 에어 13 M4' }),
    spec: { all: [['맥북에어', 'macbookair'], ['m4'], ['13인치', '13형', '에어13', 'air13'], ['256gb', '256g'], ['16gb', '16g']], not: ['512gb', '1tb', '15인치', '15형', '24gb', '32gb'], floor: 1000000 }, expect: 'AUTO' }] },
  { id: 'V065', type: 'option', cat: '이어폰', turns: [{ p: '버즈3 프로 화이트 색상으로 찾아줘', plan: P('갤럭시 버즈3 프로 화이트', '이어폰', { exactModel: '버즈3 프로' }),
    spec: X({ all: [['버즈3프로', 'buds3pro'], ['화이트', 'white']], not: ['실버', 'silver'], floor: 100000 }, EARBUD_X), expect: 'AUTO' }] },
  { id: 'V066', type: 'option', cat: '마우스', turns: [{ p: '로지텍 G304 화이트로 보여줘', plan: P('로지텍 G304 화이트', '마우스', { exactModel: 'G304' }),
    spec: { all: [['g304'], ['화이트', 'white']], not: ['블랙', 'black', '라일락', 'lilac', '블루', 'blue', '민트', 'mint'], notRe: [otherCode('g', '304')], floor: 8000 }, expect: 'AUTO' }] },
  { id: 'V067', type: 'option', cat: '태블릿', turns: [{ p: '아이패드 미니 7세대 셀룰러 모델', plan: P('아이패드 미니 7세대 셀룰러', '태블릿', { exactModel: '아이패드 미니 7' }),
    spec: X({ all: [['아이패드미니', 'ipadmini'], ['7세대', 'a17pro', 'a17'], ['셀룰러', 'cellular', 'lte', '5g']], not: ['와이파이전용'], floor: 600000 }, TABLET_X), expect: 'AUTO' }] },
  { id: 'V068', type: 'option', cat: '시계', turns: [{ p: '애플워치 SE 40mm GPS 모델', plan: P('애플워치 SE 40mm GPS', '스마트워치', { exactModel: '애플워치 SE' }),
    spec: { all: [['애플워치se', 'applewatchse'], ['40mm'], ['gps']], not: ['44mm', '셀룰러', 'cellular'], floor: 200000 }, expect: 'AUTO' }] },
  { id: 'V069', type: 'option', cat: '외장하드', turns: [{ p: '삼성 T7 쉴드 2TB 찾아줘', plan: P('삼성 T7 쉴드 2TB', '외장하드', { exactModel: 'T7 Shield' }),
    spec: { all: [['t7쉴드', 't7shield'], ['2tb', '2테라']], not: ['1tb', '4tb', '1테라', '4테라'], floor: 150000 }, expect: 'AUTO' }] },
  { id: 'V070', type: 'option', cat: '스마트폰', turns: [{ p: '갤럭시 Z 플립7 512GB 가격 알려줘', plan: P('갤럭시 Z 플립7 512GB', '스마트폰', { exactModel: 'Z 플립7' }),
    spec: X({ all: [['플립7', 'flip7'], ['512gb', '512g']], not: ['256gb', '1tb'], notRe: ['(?:플립|flip)\\s*7\\s*fe'], floor: 1000000 }, PHONE_X), expect: 'AUTO' }] },

  // ── 8. conflicting conditions (no card may violate the stated terms) ────
  { id: 'V071', type: 'conflict', cat: '스마트폰', turns: [{ p: '10만원 이하 아이폰 17 프로 새 제품', plan: P('아이폰 17 프로', '스마트폰', { maxPrice: 100000 }),
    spec: { all: [['아이폰17프로', 'iphone17pro']], max: 100000, floor: 800000 }, expect: 'AUTO' }] },
  { id: 'V072', type: 'conflict', cat: '노트북', turns: [{ p: '5만원 이하 맥북 에어 M4', plan: P('맥북 에어 M4', '노트북', { maxPrice: 50000 }),
    spec: { all: [['맥북에어', 'macbookair'], ['m4']], max: 50000, floor: 900000 }, expect: 'AUTO' }] },
  { id: 'V073', type: 'conflict', cat: '헤드폰', turns: [{ p: '3만원 이하 소니 WH-1000XM6', plan: P('소니 WH-1000XM6', '헤드폰', { maxPrice: 30000, exactModel: 'WH-1000XM6' }),
    spec: { all: [['wh1000xm6']], max: 30000, floor: 200000 }, expect: 'AUTO' }] },
  { id: 'V074', type: 'conflict', cat: '스마트폰', turns: [{ p: '삼성에서 나온 아이폰 17 추천해줘', plan: P('삼성 아이폰 17', '스마트폰'),
    spec: { all: [['삼성', 'samsung'], ['아이폰17', 'iphone17']], floor: 900000 }, expect: 'AUTO' }] },
  { id: 'V075', type: 'conflict', cat: '이어폰', turns: [{ p: '애플이 만든 갤럭시 버즈3 프로 있어?', plan: P('애플 갤럭시 버즈3 프로', '이어폰'),
    spec: { all: [['애플', 'apple'], ['버즈3프로', 'buds3pro']], floor: 100000 }, expect: 'AUTO' }] },
  { id: 'V076', type: 'conflict', cat: '스마트폰', turns: [{ p: '20만원 이하 갤럭시 Z 폴드7 새상품', plan: P('갤럭시 Z 폴드7', '스마트폰', { maxPrice: 200000 }),
    spec: { all: [['폴드7', 'fold7']], max: 200000, floor: 1500000 }, expect: 'AUTO' }] },
  { id: 'V077', type: 'conflict', cat: '헤드폰', turns: [{ p: '1만원 이하 노이즈캔슬링 무선 헤드폰', plan: P('노이즈캔슬링 무선 헤드폰', '헤드폰', { maxPrice: 10000 }),
    spec: { all: [['헤드폰', '헤드셋', 'headphone'], ANC], max: 10000, floor: 20000 }, expect: 'AUTO' }] },
  { id: 'V078', type: 'conflict', cat: '마우스', turns: [{ p: '50만원 이상이면서 3만원 이하인 마우스', plan: P('마우스', '마우스', { maxPrice: 30000 }),
    spec: { all: [['마우스', 'mouse']], min: 500000, max: 30000 }, expect: 'AUTO' }] },
  { id: 'V079', type: 'conflict', cat: '마우스', turns: [{ p: '로지텍 무선 마우스 추천해줘 근데 로지텍은 빼고', plan: P('로지텍 무선 마우스', '마우스', { exclusions: ['로지텍'] }),
    spec: { all: [['로지텍', 'logitech'], ['마우스', 'mouse']], not: ['로지텍', 'logitech'] }, expect: 'AUTO' }] },
  { id: 'V080', type: 'conflict', cat: '청소기', turns: [{ p: '30만원 이하 다이슨 V15 새제품', plan: P('다이슨 V15', '청소기', { maxPrice: 300000, exactModel: 'V15' }),
    spec: { all: [['다이슨', 'dyson'], ['v15']], max: 300000, floor: 600000 }, expect: 'AUTO' }] },

  // ── 9. products that do not exist / cannot be confirmed ─────────────────
  { id: 'V081', type: 'absent', cat: '스마트폰', turns: [{ p: '갤럭시 S30 울트라 가격 알려줘', plan: P('갤럭시 S30 울트라', '스마트폰', { exactModel: '갤럭시 S30 울트라' }),
    spec: { all: [['s30울트라', 's30ultra']], floor: 700000 }, expect: 'AUTO' }] },
  { id: 'V082', type: 'absent', cat: '스마트폰', turns: [{ p: '아이폰 20 프로 최저가', plan: P('아이폰 20 프로', '스마트폰', { exactModel: '아이폰 20 프로' }),
    spec: { all: [['아이폰20프로', 'iphone20pro']], floor: 800000 }, expect: 'AUTO' }] },
  { id: 'V083', type: 'absent', cat: '이어폰', turns: [{ p: '에어팟 프로 5 가격', plan: P('에어팟 프로 5', '이어폰', { exactModel: '에어팟 프로 5' }),
    spec: { all: [['에어팟프로5', 'airpodspro5']], floor: 150000 }, expect: 'AUTO' }] },
  { id: 'V084', type: 'absent', cat: '헤드폰', turns: [{ p: '소니 WH-1000XM9 헤드폰 찾아줘', plan: P('소니 WH-1000XM9', '헤드폰', { exactModel: 'WH-1000XM9' }),
    spec: { all: [['wh1000xm9']], floor: 150000 }, expect: 'AUTO' }] },
  { id: 'V085', type: 'absent', cat: '마우스', turns: [{ p: '로지텍 G999 무선 마우스', plan: P('로지텍 G999 무선 마우스', '마우스', { exactModel: 'G999' }),
    spec: { all: [['g999']], floor: 10000 }, expect: 'AUTO' }] },
  { id: 'V086', type: 'absent', cat: '청소기', turns: [{ p: '다이슨 V30 무선청소기 가격', plan: P('다이슨 V30', '청소기', { exactModel: 'V30' }),
    spec: { all: [['다이슨', 'dyson'], ['v30']], floor: 300000 }, expect: 'AUTO' }] },
  { id: 'V087', type: 'absent', cat: '이어폰', turns: [{ p: '갤럭시 버즈7 프로 출시됐어? 가격 알려줘', plan: P('갤럭시 버즈7 프로', '이어폰', { exactModel: '버즈7 프로' }),
    spec: { all: [['버즈7프로', 'buds7pro']], floor: 100000 }, expect: 'AUTO' }] },
  { id: 'V088', type: 'absent', cat: '노트북', turns: [{ p: '맥북 에어 M9 찾아줘', plan: P('맥북 에어 M9', '노트북', { exactModel: '맥북 에어 M9' }),
    spec: { all: [['맥북에어', 'macbookair'], ['m9']], floor: 900000 }, expect: 'AUTO' }] },
  { id: 'V089', type: 'absent', cat: '노트북', turns: [{ p: 'LG 그램 30인치 노트북 있어?', plan: P('LG 그램 30인치', '노트북'),
    spec: { all: [['그램'], ['30인치', '30형']], floor: 300000 }, expect: 'AUTO' }] },
  { id: 'V090', type: 'absent', cat: '외장하드', turns: [{ p: '삼성 T15 외장 SSD 8TB 가격', plan: P('삼성 T15 외장 SSD 8TB', '외장하드', { exactModel: 'T15' }),
    spec: { all: [['t15'], ['8tb', '8테라']], floor: 100000 }, expect: 'AUTO' }] },

  // ── 10. seller / data outages (fault injection) ─────────────────────────
  { id: 'V091', type: 'outage', cat: '마우스', fault: { db: 'error' }, turns: [{ p: '무선 마우스 추천해줘', plan: P('무선 마우스', '마우스'),
    spec: { all: [['마우스', 'mouse'], WIRELESS], floor: 5000 }, expect: 'OUTAGE' }] },
  { id: 'V092', type: 'outage', cat: '이어폰', fault: { db: 'timeout' }, turns: [{ p: '5만원 이하 블루투스 이어폰', plan: P('블루투스 이어폰', '이어폰', { maxPrice: 50000 }),
    spec: X({ all: [EARBUD, WIRELESS], max: 50000, floor: 10000 }, EARBUD_X), expect: 'OUTAGE' }] },
  { id: 'V093', type: 'outage', cat: '노트북', fault: { vector: 'error' }, turns: [{ p: '사무용 노트북 추천해줘', plan: P('사무용 노트북', '노트북'),
    spec: X({ all: [LAPTOP], floor: 200000 }, LAPTOP_X), expect: 'AUTO' }] },
  { id: 'V094', type: 'outage', cat: '태블릿', fault: { vector: 'timeout' }, turns: [{ p: '그림 그리기 좋은 태블릿 추천', plan: P('드로잉 태블릿', '태블릿'),
    spec: X({ all: [TABLET], floor: 100000 }, TABLET_X), expect: 'AUTO' }] },
  { id: 'V095', type: 'outage', cat: '이어폰', fault: { live: 'timeout' }, turns: [{ p: '갤럭시 버즈3 프로 가격 알려줘', plan: P('갤럭시 버즈3 프로', '이어폰', { exactModel: '버즈3 프로' }),
    spec: X({ all: [['버즈3프로', 'buds3pro']], floor: 100000 }, EARBUD_X), expect: 'AUTO' }] },
  { id: 'V096', type: 'outage', cat: '마우스', fault: { live: 'quota' }, turns: [{ p: '로지텍 G304 가격 알려줘', plan: P('로지텍 G304', '마우스', { exactModel: 'G304' }),
    spec: { all: [['g304']], notRe: [otherCode('g', '304')], floor: 8000 }, expect: 'AUTO' }] },
  { id: 'V097', type: 'outage', cat: '공기청정기', fault: { live: 'empty' }, turns: [{ p: '거실용 공기청정기 추천해줘', plan: P('거실용 공기청정기', '공기청정기'),
    spec: X({ all: [['공기청정기', '청정기']], not: ['미니', '휴대용', '탁상'], floor: 80000 }, PURIFIER_X), expect: 'AUTO' }] },
  { id: 'V098', type: 'outage', cat: '이어폰', fault: { live: 'stale-cache' }, turns: [{ p: '에어팟 4 가격 알려줘', plan: P('에어팟 4', '이어폰', { exactModel: '에어팟 4' }),
    spec: X({ all: [['에어팟4', 'airpods4']], not: ['프로', 'pro'], floor: 100000 }, EARBUD_X), expect: 'AUTO' }] },
  { id: 'V099', type: 'outage', cat: '시계', fault: { db: 'stale' }, turns: [{ p: '갤럭시 워치7 최저가 알려줘', plan: P('갤럭시 워치7', '스마트워치', { exactModel: '갤럭시 워치7' }),
    spec: { all: [['갤럭시', 'galaxy'], ['워치7', 'watch7']], floor: 150000 }, expect: 'STALE_ONLY' }] },
  { id: 'V100', type: 'outage', cat: '외장하드', fault: { db: 'stale', live: 'error' }, turns: [{ p: '삼성 T7 1TB 가격 알려줘', plan: P('삼성 T7 1TB', '외장하드', { exactModel: 'T7' }),
    spec: X({ all: [['t7'], ['ssd', '외장'], ['1tb', '1테라']], floor: 60000 }, SSD_X), expect: 'STALE_ONLY' }] }
];

const meta = {
  set: 'ai-v34-independent-100', written: '2026-11-12', author: 'Claude Code session (v3.4 integration)',
  asOf: '2026-11-06T05:16:02.218Z', // the frozen catalog snapshot's newest collected_at
  priceAgeLimitDays: 10,            // the site's PRICE_MAX_DISPLAY_AGE_DAYS default
  corpus: 'catalog-snapshot-20261106.jsonl sha256 8868b5ff3c89dd9aba62f9c335edca9f9cd87ca377e6d3a4945457047f10744c (77,737 rows; kept outside the repo)'
};
module.exports = { meta, questions };
