'use strict';
// SEOSA AI v3.4 — SEALED holdout (H001–H040), written 2026-11-12 after the
// v3.3 baseline run on V001–V100 but BEFORE any per-question failure of that
// run was inspected and before any fix was guided by it. It is run only once,
// after the fixes, as the independent re-evaluation. Same spec format and
// judges as questions-v34.js (see that file's header).
const P = (query, category, extra = {}) => ({ mode: 'recommend', query, compareQuery: '', category, maxPrice: null,
  exclusions: [], mallOnly: '', exactModel: '', ...extra });
const C = (query, compareQuery, category) => ({ mode: 'compare', query, compareQuery, category, maxPrice: null,
  exclusions: [], mallOnly: '', exactModel: '' });
const CARRIER = '(?<![a-z])(?:kt|skt|lgu\\+?)(?![a-z])|요금제|번호이동|기기변경|공통지원|선택약정';
const SINGLE_UNIT = '(?:왼쪽|오른쪽|한쪽|좌측|우측)\\s*(?:유닛|이어폰|단품)|낱개|유닛\\s*단품';
const otherCode = (letter, keep) => '(?<![a-z0-9])' + letter + '(?!' + keep + '(?![0-9]))\\d{' + (keep.length === 3 ? '3' : '1,2') + '}(?![0-9])';
const IPHONE17_VARIANT = '(?:아이폰|iphone)\\s*17\\s*(?:프로|pro|에어|air|플러스|plus|맥스|max|e(?![a-z]))';
const X = (spec, ...extras) => {
  const out = { ...spec, not: [...(spec.not || [])], notRe: [...(spec.notRe || [])] };
  for (const e of extras) { out.not.push(...(e.not || [])); out.notRe.push(...(e.notRe || [])); }
  if (!out.not.length) delete out.not;
  if (!out.notRe.length) delete out.notRe;
  return out;
};
const LAPTOP = ['노트북', 'laptop', 'lg그램', '엘지그램', '그램14', '그램15', '그램16', '그램17', '그램프로', '그램360', '맥북', 'macbook', '갤럭시북', 'galaxybook', '비보북', 'vivobook', '아이디어패드', 'ideapad', '씽크패드', 'thinkpad', '젠북', 'zenbook', '레노버'];
const LG = ['lg', '엘지', 'lg그램', '엘지그램'];
const EARBUD = ['이어폰', '이어버드', '버즈', 'buds', '에어팟', 'airpods', 'earbud', 'tws'];
const WIRELESS = ['무선', '블루투스', 'wireless', 'bluetooth', 'tws', '24ghz', '24g'];
const TABLET = ['태블릿', '아이패드', 'ipad', '갤럭시탭', 'galaxytab', '아이디어탭', 'ideatab', '레드미패드', 'redmipad', '샤오미패드', 'xiaomipad', '갤탭'];
const ANC = ['노이즈캔슬링', '노캔', 'anc', '액티브노이즈'];
const LAPTOP_X = { not: ['가방', '백팩', '파우치', '모니터', '쿨러', '쿨링', '받침', '거치대', '스탠드', '키스킨', '보호필름', '어댑터', '충전기', '도킹', '허브', '태블릿', '테이블', '책상', '마우스', '키보드', '이어폰', '헤드셋', '스피커', 'nvme'], notRe: ['랜덤', '노트북\\s*(?:용|전용)'] };
const TABLET_X = { not: ['이어패드', '키보드', '케이스', '커버', '필름', '펜슬', '거치대', '받침', '테이블', '이어폰', '헤드셋', '스피커', '마우스', '클러치', '가방', '파우치'], notRe: [CARRIER] };
const EARBUD_X = { not: ['충전스테이션', '무선충전'], notRe: [SINGLE_UNIT] };
const HEADPHONE_X = { not: ['이어폰', '이어버드', '호환', '교체', '인터콤', '헬멧'] };
const MONITOR_X = { not: ['룸미러', '후방카메라', '블랙박스', '모니터암', '모니터받침', '받침대', '베이비', '오디오인터페이스', '호환'], notRe: ['모니터링', 'lg\\s*(?:ips|패널)'] };
const PURIFIER_X = { not: ['의류청정기', '렌탈', '렌털', '정수기', '차량용', '호환', '제습기'] };
const PHONE_X = { notRe: [CARRIER] };
const SSD_X = { not: ['sd카드', '메모리카드', 'microsd', '마이크로sd'] };

const questions = [
  // budget
  { id: 'H001', type: 'budget', cat: '헤드폰', turns: [{ p: '20만원 이하 블루투스 헤드폰 추천해줘', plan: P('블루투스 헤드폰', '헤드폰', { maxPrice: 200000 }),
    spec: X({ all: [['헤드폰', '헤드셋', 'headphone'], WIRELESS], max: 200000, floor: 20000 }, HEADPHONE_X), expect: 'AUTO' }] },
  { id: 'H002', type: 'budget', cat: '태블릿', turns: [{ p: '60만원 이하 갤럭시 태블릿 보여줘', plan: P('갤럭시 태블릿', '태블릿', { maxPrice: 600000 }),
    spec: X({ all: [['갤럭시', 'galaxy'], TABLET], max: 600000, floor: 150000 }, TABLET_X), expect: 'AUTO' }] },
  { id: 'H003', type: 'budget', cat: '청소기', turns: [{ p: '10만원대 로봇청소기 추천', plan: P('로봇청소기', '청소기', { maxPrice: 199999 }),
    spec: { all: [['로봇'], ['청소기']], min: 100000, max: 199999, floor: 100000 }, expect: 'AUTO' }] },
  { id: 'H004', type: 'budget', cat: '키보드', turns: [{ p: '5만원 이하 게이밍 키보드 추천해줘', plan: P('게이밍 키보드', '키보드', { maxPrice: 50000 }),
    spec: { all: [['키보드', 'keyboard'], ['게이밍', 'gaming']], max: 50000, floor: 10000 }, expect: 'AUTO' }] },
  // model
  { id: 'H005', type: 'model', cat: '스마트폰', turns: [{ p: '갤럭시 Z 폴드7 가격 알려줘', plan: P('갤럭시 Z 폴드7', '스마트폰', { exactModel: 'Z 폴드7' }),
    spec: X({ all: [['폴드7', 'fold7']], floor: 1500000 }, PHONE_X), expect: 'AUTO' }] },
  { id: 'H006', type: 'model', cat: '키보드', turns: [{ p: '로지텍 MX Keys S 키보드 찾아줘', plan: P('로지텍 MX Keys S', '키보드', { exactModel: 'MX Keys S' }),
    spec: { all: [['로지텍', 'logitech'], ['mxkeyss']], floor: 80000 }, expect: 'AUTO' }] },
  { id: 'H007', type: 'model', cat: '이어폰', turns: [{ p: '에어팟 4 액티브 노이즈 캔슬링 모델 가격', plan: P('에어팟 4 액티브 노이즈 캔슬링', '이어폰', { exactModel: '에어팟 4' }),
    spec: X({ all: [['에어팟4', 'airpods4'], ANC], not: ['프로', 'pro'], floor: 150000 }, EARBUD_X), expect: 'AUTO' }] },
  { id: 'H008', type: 'model', cat: '외장하드', turns: [{ p: '삼성 T7 쉴드 1TB 가격', plan: P('삼성 T7 쉴드 1TB', '외장하드', { exactModel: 'T7 Shield' }),
    spec: X({ all: [['t7쉴드', 't7shield'], ['1tb', '1테라']], not: ['2tb', '4tb', '2테라', '4테라'], floor: 100000 }, SSD_X), expect: 'AUTO' }] },
  // brand
  { id: 'H009', type: 'brand', cat: '모니터', turns: [{ p: 'LG 모니터 추천해줘', plan: P('LG 모니터', '모니터'),
    spec: X({ all: [LG, ['모니터', 'monitor']], floor: 80000 }, MONITOR_X), expect: 'AUTO' }] },
  { id: 'H010', type: 'brand', cat: '이어폰', turns: [{ p: '앤커 블루투스 이어폰 추천', plan: P('앤커 블루투스 이어폰', '이어폰'),
    spec: X({ all: [['앤커', 'anker', '사운드코어', 'soundcore'], EARBUD], floor: 20000 }, EARBUD_X), expect: 'AUTO' }] },
  { id: 'H011', type: 'brand', cat: '청소기', turns: [{ p: '샤오미 로봇청소기 추천해줘', plan: P('샤오미 로봇청소기', '청소기'),
    spec: { all: [['샤오미', 'xiaomi', '미지아', 'mijia'], ['청소기']], floor: 100000 }, expect: 'AUTO' }] },
  { id: 'H012', type: 'brand', cat: '태블릿', turns: [{ p: '애플 태블릿 추천해 줘', plan: P('애플 아이패드', '태블릿'),
    spec: X({ all: [['아이패드', 'ipad']], floor: 300000 }, TABLET_X), expect: 'AUTO' }] },
  // category
  { id: 'H013', type: 'category', cat: '헤드폰', turns: [{ p: '게임용 헤드셋 추천해줘', plan: P('게이밍 헤드셋', '헤드폰'),
    spec: X({ all: [['헤드셋', 'headset', '헤드폰'], ['게이밍', 'gaming', '게임']], floor: 15000 }, HEADPHONE_X), expect: 'AUTO' }] },
  { id: 'H014', type: 'category', cat: '노트북', turns: [{ p: '코딩용 노트북 추천해줘', plan: P('개발용 노트북', '노트북'),
    spec: X({ all: [LAPTOP], floor: 300000 }, LAPTOP_X), expect: 'AUTO' }] },
  { id: 'H015', type: 'category', cat: '공기청정기', turns: [{ p: '아이 방에 둘 공기청정기 추천', plan: P('공기청정기', '공기청정기'),
    spec: X({ all: [['공기청정기', '청정기']], floor: 50000 }, PURIFIER_X), expect: 'AUTO' }] },
  { id: 'H016', type: 'category', cat: '외장하드', turns: [{ p: '출장 갈 때 쓸 휴대용 SSD 추천', plan: P('휴대용 외장 SSD', '외장하드'),
    spec: X({ all: [['ssd'], ['외장', '포터블', 'portable', '휴대용']], floor: 40000 }, SSD_X), expect: 'AUTO' }] },
  // compare
  { id: 'H017', type: 'compare', cat: '이어폰', turns: [{ p: '갤럭시 버즈3랑 버즈3 프로 비교해줘', plan: C('갤럭시 버즈3', '갤럭시 버즈3 프로', '이어폰'),
    spec: { sides: [X({ all: [['버즈3', 'buds3']], notRe: ['(?:버즈|buds)\\s*3\\s*(?:프로|pro|fe)'], floor: 80000 }, EARBUD_X),
      X({ all: [['버즈3프로', 'buds3pro']], floor: 100000 }, EARBUD_X)] }, expect: 'COMPARE' }] },
  { id: 'H018', type: 'compare', cat: '스마트폰', turns: [{ p: '아이폰 17이랑 아이폰 17 프로 비교', plan: C('아이폰 17', '아이폰 17 프로', '스마트폰'),
    spec: { sides: [X({ all: [['아이폰17', 'iphone17']], notRe: [IPHONE17_VARIANT], floor: 900000 }, PHONE_X),
      X({ all: [['아이폰17프로', 'iphone17pro']], notRe: ['(?:프로|pro)\\s*(?:맥스|max)'], floor: 1100000 }, PHONE_X)] }, expect: 'COMPARE' }] },
  { id: 'H019', type: 'compare', cat: '청소기', turns: [{ p: '로보락이랑 드리미 로봇청소기 비교해줘', plan: C('로보락 로봇청소기', '드리미 로봇청소기', '청소기'),
    spec: { sides: [{ all: [['로보락', 'roborock'], ['청소기']], floor: 200000 }, { all: [['드리미', 'dreame'], ['청소기']], floor: 200000 }] }, expect: 'COMPARE' }] },
  { id: 'H020', type: 'compare', cat: '마우스', turns: [{ p: '로지텍 MX Master 3S와 G304 비교해줘', plan: C('로지텍 MX Master 3S', '로지텍 G304', '마우스'),
    spec: { sides: [{ all: [['mxmaster3s']], floor: 60000 }, { all: [['g304']], notRe: [otherCode('g', '304')], floor: 8000 }] }, expect: 'COMPARE' }] },
  // follow-ups
  { id: 'H021', type: 'followup', cat: '헤드폰', turns: [
    { p: '블루투스 헤드폰 추천해줘', plan: P('블루투스 헤드폰', '헤드폰'), spec: X({ all: [['헤드폰', '헤드셋', 'headphone'], WIRELESS], floor: 20000 }, HEADPHONE_X), expect: 'AUTO' },
    { p: '소니로만 보여줘', plan: P('소니 블루투스 헤드폰', '헤드폰'), spec: X({ all: [['헤드폰', '헤드셋', 'headphone'], WIRELESS, ['소니', 'sony']], floor: 20000 }, HEADPHONE_X), expect: 'AUTO' },
    { p: '30만원 이하로', plan: P('소니 블루투스 헤드폰', '헤드폰', { maxPrice: 300000 }), spec: X({ all: [['헤드폰', '헤드셋', 'headphone'], WIRELESS, ['소니', 'sony']], max: 300000, floor: 20000 }, HEADPHONE_X), expect: 'AUTO' }] },
  { id: 'H022', type: 'followup', cat: '태블릿', turns: [
    { p: '갤럭시 태블릿 보여줘', plan: P('갤럭시 태블릿', '태블릿'), spec: X({ all: [['갤럭시', 'galaxy'], TABLET], floor: 150000 }, TABLET_X), expect: 'AUTO' },
    { p: 'S10 FE로 찾아줘', plan: P('갤럭시탭 S10 FE', '태블릿'), spec: X({ all: [['s10fe']], notRe: ['s10\\s*fe\\s*(?:\\+|플러스|plus)'], floor: 300000 }, TABLET_X), expect: 'AUTO' },
    { p: '그중 제일 싼 거 하나만', plan: P('갤럭시탭 S10 FE', '태블릿'), spec: X({ all: [['s10fe']], notRe: ['s10\\s*fe\\s*(?:\\+|플러스|plus)'], floor: 300000, single: true, amongPrevious: true }, TABLET_X), expect: 'DYNAMIC' }] },
  { id: 'H023', type: 'followup', cat: '키보드', turns: [
    { p: '무선 키보드 추천', plan: P('무선 키보드', '키보드'), spec: { all: [['키보드', 'keyboard'], WIRELESS], not: ['키보드패드'], floor: 15000 }, expect: 'AUTO' },
    { p: '기계식으로', plan: P('무선 기계식 키보드', '키보드'), spec: { all: [['키보드', 'keyboard'], WIRELESS, ['기계식', 'mechanical']], floor: 15000 }, expect: 'AUTO' },
    { p: '10만원 이하만', plan: P('무선 기계식 키보드', '키보드', { maxPrice: 100000 }), spec: { all: [['키보드', 'keyboard'], WIRELESS, ['기계식', 'mechanical']], max: 100000, floor: 15000 }, expect: 'AUTO' }] },
  { id: 'H024', type: 'followup', cat: '공기청정기', turns: [
    { p: '공기청정기 추천해줘', plan: P('공기청정기', '공기청정기'), spec: X({ all: [['공기청정기', '청정기']], floor: 50000 }, PURIFIER_X), expect: 'AUTO' },
    { p: '위닉스는 빼줘', plan: P('공기청정기', '공기청정기', { exclusions: ['위닉스'] }), spec: X({ all: [['공기청정기', '청정기']], not: ['위닉스', 'winix'], floor: 50000 }, PURIFIER_X), expect: 'AUTO' },
    { p: '30만원 이하로', plan: P('공기청정기', '공기청정기', { maxPrice: 300000 }), spec: X({ all: [['공기청정기', '청정기']], not: ['위닉스', 'winix'], max: 300000, floor: 50000 }, PURIFIER_X), expect: 'AUTO' }] },
  // exact option
  { id: 'H025', type: 'option', cat: '태블릿', turns: [{ p: '아이패드 에어 13 M3 셀룰러 모델', plan: P('아이패드 에어 13 M3 셀룰러', '태블릿', { exactModel: '아이패드 에어 13 M3' }),
    spec: X({ all: [['아이패드에어', 'ipadair'], ['m3'], ['13인치', '13형', '에어13', 'air13'], ['셀룰러', 'cellular', 'lte', '5g']], floor: 900000 }, TABLET_X), expect: 'AUTO' }] },
  { id: 'H026', type: 'option', cat: '스마트폰', turns: [{ p: '갤럭시 S25 울트라 512GB 찾아줘', plan: P('갤럭시 S25 울트라 512GB', '스마트폰', { exactModel: 'S25 울트라' }),
    spec: X({ all: [['s25울트라', 's25ultra'], ['512gb', '512g']], not: ['256gb', '1tb'], floor: 1300000 }, PHONE_X), expect: 'AUTO' }] },
  { id: 'H027', type: 'option', cat: '이어폰', turns: [{ p: '갤럭시 버즈3 프로 실버 색상', plan: P('갤럭시 버즈3 프로 실버', '이어폰', { exactModel: '버즈3 프로' }),
    spec: X({ all: [['버즈3프로', 'buds3pro'], ['실버', 'silver']], not: ['화이트', 'white'], floor: 100000 }, EARBUD_X), expect: 'AUTO' }] },
  { id: 'H028', type: 'option', cat: '노트북', turns: [{ p: 'LG 그램 16인치 노트북 찾아줘', plan: P('LG 그램 16인치', '노트북'),
    spec: X({ all: [LG, ['16인치', '16형', '그램16', '16z9', '16zd9', '16t9']], floor: 600000 }, LAPTOP_X), expect: 'AUTO' }] },
  // conflict
  { id: 'H029', type: 'conflict', cat: '태블릿', turns: [{ p: '2만원 이하 아이패드 프로 새상품', plan: P('아이패드 프로', '태블릿', { maxPrice: 20000 }),
    spec: { all: [['아이패드프로', 'ipadpro']], max: 20000, floor: 800000 }, expect: 'AUTO' }] },
  { id: 'H030', type: 'conflict', cat: '이어폰', turns: [{ p: '소니에서 나온 갤럭시 버즈3 있어?', plan: P('소니 갤럭시 버즈3', '이어폰'),
    spec: { all: [['소니', 'sony'], ['버즈3', 'buds3']], floor: 80000 }, expect: 'AUTO' }] },
  { id: 'H031', type: 'conflict', cat: '이어폰', turns: [{ p: '100만원 이상인데 5만원 이하인 이어폰', plan: P('이어폰', '이어폰', { maxPrice: 50000 }),
    spec: { all: [EARBUD], min: 1000000, max: 50000 }, expect: 'AUTO' }] },
  { id: 'H032', type: 'conflict', cat: '청소기', turns: [{ p: '다이슨 청소기 추천해줘 다이슨은 빼고', plan: P('다이슨 청소기', '청소기', { exclusions: ['다이슨'] }),
    spec: { all: [['다이슨', 'dyson'], ['청소기']], not: ['다이슨', 'dyson'] }, expect: 'AUTO' }] },
  // absent
  { id: 'H033', type: 'absent', cat: '스마트폰', turns: [{ p: '갤럭시 S99 가격 알려줘', plan: P('갤럭시 S99', '스마트폰', { exactModel: '갤럭시 S99' }),
    spec: { all: [['s99']], floor: 500000 }, expect: 'AUTO' }] },
  { id: 'H034', type: 'absent', cat: '헤드폰', turns: [{ p: '에어팟 맥스 9 가격 알려줘', plan: P('에어팟 맥스 9', '헤드폰', { exactModel: '에어팟 맥스 9' }),
    spec: { all: [['에어팟맥스9', 'airpodsmax9']], floor: 300000 }, expect: 'AUTO' }] },
  { id: 'H035', type: 'absent', cat: '마우스', turns: [{ p: '로지텍 MX Master 9S 마우스', plan: P('로지텍 MX Master 9S', '마우스', { exactModel: 'MX Master 9S' }),
    spec: { all: [['mxmaster9s']], floor: 50000 }, expect: 'AUTO' }] },
  { id: 'H036', type: 'absent', cat: '외장하드', turns: [{ p: '삼성 T50 외장 SSD 찾아줘', plan: P('삼성 T50 외장 SSD', '외장하드', { exactModel: 'T50' }),
    spec: { all: [['t50'], ['ssd']], floor: 50000 }, expect: 'AUTO' }] },
  // outage
  { id: 'H037', type: 'outage', cat: '스피커', fault: { db: 'error' }, turns: [{ p: '블루투스 스피커 추천해줘', plan: P('블루투스 스피커', '스피커'),
    spec: { all: [['스피커', 'speaker'], WIRELESS], floor: 10000 }, expect: 'OUTAGE' }] },
  { id: 'H038', type: 'outage', cat: '노트북', fault: { vector: 'error' }, turns: [{ p: '가성비 노트북 추천해줘', plan: P('가성비 노트북', '노트북'),
    spec: X({ all: [LAPTOP], floor: 200000 }, LAPTOP_X), expect: 'AUTO' }] },
  { id: 'H039', type: 'outage', cat: '이어폰', fault: { db: 'stale' }, turns: [{ p: '갤럭시 버즈3 프로 최저가', plan: P('갤럭시 버즈3 프로', '이어폰', { exactModel: '버즈3 프로' }),
    spec: X({ all: [['버즈3프로', 'buds3pro']], floor: 100000 }, EARBUD_X), expect: 'STALE_ONLY' }] },
  { id: 'H040', type: 'outage', cat: '마우스', fault: { db: 'timeout' }, turns: [{ p: '무선 마우스 하나 추천해줘', plan: P('무선 마우스', '마우스'),
    spec: { all: [['마우스', 'mouse'], WIRELESS], floor: 5000 }, expect: 'OUTAGE' }] }
];
const meta = {
  set: 'ai-v34-sealed-holdout-40', written: '2026-11-12', author: 'Claude Code session (v3.4 integration)',
  asOf: '2026-11-06T05:16:02.218Z', priceAgeLimitDays: 10,
  corpus: 'catalog-snapshot-20261106.jsonl sha256 8868b5ff3c89dd9aba62f9c335edca9f9cd87ca377e6d3a4945457047f10744c'
};
module.exports = { meta, questions };
