'use strict';
// Independent DB oracle specs for the 75 non-PASS questions of the
// 2026-11-06 online-200 run (68 UNVERIFIED + 7 FAIL).
//
// Written from the QUESTION TEXT ONLY. These specs deliberately do not import
// or reuse any server classifier (_ai-v31-taxonomy, _ai-v3-identity, ...), so a
// shared blind spot cannot make the oracle agree with the system under test.
//
// all:  conjunction of groups; each group is a list of alternative title
//       fragments. Matching is case-insensitive and ignores spaces/punctuation
//       (title is normalized to [0-9a-z가-힣] in SQL, fragments in JS).
// not:  title fragments that disqualify a listing (accessory, wrong variant...).
// min/max: inclusive listing-price bounds stated by the user (KRW).
// used: 'any' | 'only' | 'exclude' (default exclude = new merchandise only).
// review: what a human must still check in the returned titles.
// followup: the turn depends on the cards displayed by an earlier turn.
const ACC = ['케이스', '커버', '필름', '강화유리', '거치대', '파우치', '스트랩', '충전기', '케이블', '어댑터', '젠더', '스탠드', '키스킨', '보호'];
const PHONE_ACC = [...ACC, '범퍼', '그립톡', '링', '렌즈'];
const specs = [
  // ── headphones / earphones ─────────────────────────────────────────
  { id: 'N007', all: [['jbl'], ['헤드폰', '헤드셋', 'headphone']], not: ['이어폰', '이어버드', 'earbuds', '스피커'], max: 120000, review: 'wireless/bluetooth over-ear' },
  { id: 'N011', all: [['헤드폰', 'headphone']], not: ['앰프', 'amp', '이어폰'], min: 50000, max: 59999, review: '"5만원대" = 50,000-59,999; ordinary listening headphone, not a guitar headphone amp' },
  { id: 'N022', all: [['wfc700n']], not: ACC, review: 'Sony WF-C700N complete set, not a single unit' },
  // ── tablets ────────────────────────────────────────────────────────
  { id: 'N026', all: [['아이패드', 'ipad'], ['에어', 'air'], ['m4'], ['256']], not: ACC, review: '11-inch, Wi-Fi, new' },
  { id: 'N028', all: [['아이패드', 'ipad'], ['10세대', '10th', '10gen', 'ipad10', '아이패드10'], ['64']], not: ACC, review: 'iPad 10th gen 64GB device' },
  { id: 'N031', all: [['아이패드', 'ipad'], ['프로', 'pro'], ['m4'], ['256']], not: ACC, review: '11-inch' },
  { id: 'N032', all: [['아이패드', 'ipad'], ['미니', 'mini'], ['128']], not: ACC, review: '7th gen / A17 Pro, Wi-Fi, new' },
  { id: 'N033', all: [['레노버', 'lenovo'], ['태블릿', 'tab', '탭', 'pad', '패드']], not: [...ACC, '노트북', 'thinkpad', '씽크패드', 'ideapad'], max: 200000, review: 'Lenovo tablet device' },
  { id: 'N035', all: [['갤럭시탭', 'galaxytab', '갤탭'], ['s9fe', 'smx510', 'smx516', 'smx518'], ['256']], not: [...ACC, 's9fe+', 's9fe플러스', 'smx610', 'smx616'], review: 'base FE (not FE+), 256GB' },
  // ── phones ─────────────────────────────────────────────────────────
  { id: 'N037', all: [['아이폰16', 'iphone16'], ['256']], not: [...PHONE_ACC, '16프로', '16pro', '16플러스', '16plus', '16e', '프로맥스'], review: 'base iPhone 16 256GB, unlocked/new' },
  { id: 'N038', all: [['s25플러스', 's25+', 's25plus', 'sms936'], ['256']], not: PHONE_ACC, review: 'unlocked new' },
  { id: 'N039', all: [['갤럭시', 'galaxy', '스마트폰', '휴대폰', '자급제', '공기계', '안드로이드']], not: [...PHONE_ACC, '워치', 'watch', '버즈', 'buds', '탭', 'tab', '북'], max: 300000, review: 'new Android phone handset' },
  { id: 'N040', all: [['아이폰16e', 'iphone16e'], ['128']], not: PHONE_ACC, review: 'unlocked new' },
  { id: 'N041', all: [['s24울트라', 's24ultra', 'sms928'], ['512']], not: PHONE_ACC, review: 'unlocked new' },
  { id: 'N044', all: [['스마트폰', '휴대폰', '자급제', '공기계', '갤럭시', '아이폰', 'iphone', 'galaxy']], not: [...PHONE_ACC, '워치', '버즈', '탭', '북', '할부원금', '번호이동', '기기변경', '약정'], max: 700000, review: 'phone handset without installment/contract condition' },
  { id: 'N045', all: [['픽셀', 'pixel'], ['9a']], not: PHONE_ACC, review: 'Pixel 9a 128GB' },
  { id: 'N046', all: [['아이폰16프로', 'iphone16pro'], ['256']], not: [...PHONE_ACC, '프로맥스', 'promax'], review: 'unlocked new' },
  { id: 'N047', all: [['s23', 'sms911'], ['128']], not: [...PHONE_ACC, 's23fe', 's23울트라', 's23ultra', 's23플러스', 's23+'], review: 'base S23 128GB unlocked new' },
  { id: 'N048', all: [['s25엣지', 's25edge', 'sms937']], not: PHONE_ACC, review: 'compare side A: S25 Edge handset (side B base S25 handset)' },
  // ── laptops ────────────────────────────────────────────────────────
  { id: 'N049', all: [['갤럭시북4', 'galaxybook4'], ['16']], not: [...ACC, '키스킨', '프로', 'pro', '360', '엣지', 'edge', '울트라'], review: 'Galaxy Book4 16-inch (base) device' },
  { id: 'N051', all: [['맥북에어', 'macbookair'], ['m4'], ['256']], not: ACC, review: '13-inch, 16GB RAM' },
  { id: 'N052', all: [['비보북', 'vivobook']], not: ACC, max: 600000, review: 'new ASUS Vivobook laptop' },
  { id: 'N055', all: [['아이디어패드', 'ideapad']], not: ACC, max: 900000, review: '16GB RAM stated' },
  { id: 'N056', all: [['맥북프로', 'macbookpro'], ['m4pro'], ['512']], not: ACC, review: 'MacBook Pro M4 Pro 512GB' },
  { id: 'N057', all: [['노트북', 'laptop']], not: [...ACC, '쿨러', '받침', '가방', '백팩', '키보드', '마우스', '도킹', '허브', '배터리', '어댑터'], max: 499999, review: 'a laptop device under 500k' },
  { id: 'N058', all: [['노트북', 'laptop', '그램', '맥북', 'macbook', '갤럭시북'], ['13']], not: [...ACC, '쿨러', '가방', '키보드', '마우스'], max: 1000000, review: '13-inch thin laptop' },
  { id: 'N060', all: [['노트북', 'laptop']], not: [...ACC, '태블릿', '쿨러', '가방', '키보드', '마우스', '거치'], max: 600000, review: 'clamshell laptop with keyboard (not tablet)' },
  // ── external storage ───────────────────────────────────────────────
  { id: 'N061', all: [['t7'], ['shield', '쉴드', '실드'], ['2tb', '2테라']], not: ACC, review: 'Samsung T7 Shield 2TB' },
  { id: 'N062', all: [['wd', '웨스턴디지털', 'westerndigital', 'mypassport', '마이패스포트', 'elements', '엘리먼츠'], ['1tb', '1테라']], not: [...ACC, 'ssd'], max: 120000, review: 'WD external HDD 1TB' },
  { id: 'N063', all: [['샌디스크', 'sandisk'], ['1tb', '1테라'], ['ssd']], not: ACC, review: 'SanDisk portable SSD 1TB' },
  { id: 'N065', all: [['ssd'], ['500gb', '500기가']], not: [...ACC, 'nvme', 'm2', 'sata', '내장'], max: 80000, review: 'external SSD 500GB (512GB is a different capacity)' },
  { id: 'N067', all: [['씨게이트', 'seagate'], ['onetouch', '원터치'], ['1tb', '1테라']], not: ACC, max: 100000, review: 'Seagate One Touch HDD 1TB' },
  { id: 'N070', all: [['t9'], ['1tb', '1테라'], ['ssd']], not: ACC, review: 'Samsung T9 1TB (price comparison of one product)' },
  { id: 'N071', all: [['ssd'], ['256']], not: [...ACC, 'nvme', 'm2', 'sata', '내장', 'msata'], max: 50000, review: 'external SSD 256GB new' },
  { id: 'N072', all: [['외장', 'portable', '포터블', 'usb'], ['512']], not: [...ACC, '메모리', 'sd카드', 'microsd', 'usb메모리'], max: 120000, review: 'single-capacity 512GB external drive' },
  // ── monitors ───────────────────────────────────────────────────────
  { id: 'N073', all: [['삼성', 'samsung'], ['모니터', 'monitor', '오디세이', 'odyssey', 'viewfinity'], ['27']], not: [...ACC, '암', 'arm'], max: 200000, review: '27-inch FHD Samsung' },
  { id: 'N079', all: [['lg', '엘지'], ['울트라와이드', 'ultrawide', '34wp', '34wq', '34wr', '34gp', '34gs', '34wn', '34bp'], ['34']], not: [...ACC, '암', 'arm'], review: 'LG UltraWide 34-inch' },
  // ── keyboards ──────────────────────────────────────────────────────
  { id: 'N092', all: [['아이패드', 'ipad'], ['에어', 'air'], ['키보드', 'keyboard']], not: ['필름', '스킨'], review: 'keyboard case that fits iPad Air 11 (M4 / same form factor M2-M3)' },
  { id: 'N096', all: [['키보드', 'keyboard'], ['무선', '블루투스', 'wireless', 'bluetooth']], not: ['마우스', 'mouse', '세트', '콤보', 'combo', '키스킨', '키캡', '케이스', '팜레스트'], max: 90000, review: 'standalone wireless keyboard' },
  // ── air purifier / vacuum / speaker ────────────────────────────────
  { id: 'N116', all: [['공기청정기', 'airpurifier'], ['앱', 'app', 'iot', 'wifi', '와이파이', 'thinq', '씽큐', '스마트싱스', 'smartthings', '스마트폰', '미홈', 'mihome']], not: ['필터', '렌탈'], max: 300000, review: 'app-connected air purifier' },
  { id: 'N118', all: [['블루에어', 'blueair'], ['공기청정기', 'purifier', '청정기']], not: ['필터', 'filter'], max: 250000, review: 'Blueair purifier unit' },
  { id: 'N124', all: [['다이슨', 'dyson'], ['v12']], not: ['배터리', '필터', '브러시', '헤드', '호환', '거치대', '충전기'], max: 700000, review: 'Dyson V12 cordless unit' },
  { id: 'N134', all: [['jbl'], ['flip6', '플립6']], not: ACC, review: 'JBL Flip 6 genuine' },
  { id: 'N136', all: [['보스', 'bose'], ['스피커', 'speaker', 'soundlink', '사운드링크']], not: ACC, max: 250000, review: 'Bose bluetooth speaker' },
  // ── watches ────────────────────────────────────────────────────────
  { id: 'N145', all: [['워치7', 'watch7'], ['44']], not: [...ACC, '밴드', 'band', '줄'], review: 'Galaxy Watch7 44mm Bluetooth' },
  { id: 'N148', all: [['레드미워치5', 'redmiwatch5']], not: [...ACC, '밴드', '줄'], review: 'Redmi Watch 5' },
  { id: 'N151', all: [['워치6', 'watch6'], ['클래식', 'classic'], ['47']], not: [...ACC, '밴드', 'band', '줄'], review: 'Galaxy Watch6 Classic 47mm' },
  { id: 'N152', all: [['애플워치', 'applewatch'], ['10', 's10', '시리즈10', 'series10'], ['42']], not: [...ACC, '밴드', 'band', '줄'], review: 'Apple Watch Series 10 42mm GPS' },
  { id: 'N154', all: [['워치4', 'watch4']], not: [...ACC, '밴드', 'band', '줄'], min: 30000, max: 39999, used: 'any', review: '"3만원대" used Galaxy Watch4' },
  // ── guitars ────────────────────────────────────────────────────────
  { id: 'N157', all: [['일렉기타', '일렉트릭기타', 'electricguitar']], not: ['앰프', '피크', '스트링', '줄', '케이스', '가방', '스탠드', '픽업', '튜너', '케이블'], max: 200000, review: 'new electric guitar' },
  { id: 'N158', all: [['어쿠스틱기타', '통기타', 'acousticguitar']], not: ['피크', '스트링', '줄', '케이스', '가방', '스탠드', '픽업', '튜너', '카포'], max: 100000, review: 'acoustic guitar' },
  { id: 'N159', all: [['stg004']], used: 'any', max: 150000, review: 'Aria STG-004 (used ok)' },
  { id: 'N160', all: [['일렉기타', '일렉트릭기타', 'electricguitar']], not: ['앰프', '피크', '스트링', '줄', '케이스', '가방', '스탠드', '픽업', '튜너', '케이블'], review: 'electric guitar body, not a headphone amp' },
  { id: 'N161', all: [['일렉기타', '일렉트릭기타', 'electricguitar']], not: ['앰프', '피크', '스트링', '줄', '케이스', '가방', '스탠드', '픽업', '튜너', '케이블', '부품'], max: 250000, review: 'complete electric guitar' },
  { id: 'N162', all: [['클래식기타', 'classicalguitar', '클래식통기타', '나일론기타']], not: ['피크', '스트링', '줄', '케이스', '가방', '스탠드', '튜너', '카포'], max: 150000, review: 'classical guitar' },
  { id: 'N163', all: [['일렉기타', '일렉트릭기타', 'electricguitar']], not: ['앰프', '피크', '스트링', '줄', '케이스', '가방', '스탠드', '픽업', '튜너', '케이블'], max: 300000, review: 'beginner electric guitar' },
  { id: 'N164', all: [['어쿠스틱기타', '통기타', 'acousticguitar']], not: ['피크', '스트링', '줄', '케이스', '가방', '스탠드', '픽업', '튜너', '카포', '미니'], max: 120000, review: 'full-size acoustic guitar' },
  { id: 'N165', all: [['스트랫', 'strat', 'st타입', 'sst'], ['기타', 'guitar']], not: ['앰프', '피크', '스트링', '케이스', '픽업', '부품', '넥', '바디'], max: 180000, review: 'Strat-style electric guitar' },
  { id: 'N166', all: [['일렉기타', '일렉트릭기타', 'electricguitar']], not: ['앰프', '피크', '스트링', '줄', '케이스', '가방', '스탠드', '픽업', '튜너', '케이블'], used: 'any', max: 100000, review: 'used electric guitar (DB has no used-condition field; title evidence only)' },
  { id: 'N167', all: [['기타', 'guitar']], not: ['앰프', '피크', '스트링', '줄', '케이스', '가방', '스탠드', '픽업', '튜너', '케이블', '기타등등'], max: 140000, review: 'guitar body (type ambiguous)' },
  { id: 'N168', all: [['기타', 'guitar'], ['미니', '어린이', '아동', '키즈', '34인치', '36인치', '3/4']], not: ['앰프', '피크', '스트링', '케이스', '가방', '스탠드', '장난감'], max: 80000, review: 'mini acoustic guitar for kids' },
  // ── non-shopping controls ──────────────────────────────────────────
  { id: 'N193', informational: true, review: 'explanation of aptX; must not search' },
  { id: 'N194', informational: true, review: 'OLED vs LCD explanation; must not search' },
  // ── follow-up turns (depend on earlier displayed cards) ─────────────
  { id: 'N174', followup: 'N173', rule: 'pick one of the displayed card(s)' },
  { id: 'N176', followup: 'N175', rule: 'keep only SSD products among displayed cards' },
  { id: 'N177', followup: 'N176', rule: 'pick one among the previous (empty) result' },
  { id: 'N179', followup: 'N178', rule: 'drop robot vacuums among displayed cards' },
  { id: 'N180', followup: 'N179', rule: 'pick one among previous result' },
  { id: 'N182', followup: 'N181', rule: 'keep price >= 100,000 among displayed cards', min: 100000, max: 200000 },
  { id: 'N183', followup: 'N182', rule: 'pick one among previous result' },
  { id: 'N185', followup: 'N184', rule: 'keep ANC products among displayed cards' },
  { id: 'N188', followup: 'N187', rule: 'drop gaming products among displayed cards' },
  { id: 'N189', followup: 'N188', rule: 'pick one among previous result' },
  { id: 'N191', followup: 'N190', rule: 'drop gaming laptops among displayed cards' },
  { id: 'N192', followup: 'N191', rule: 'pick one among previous result' }
];
const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
module.exports = { specs, norm };
