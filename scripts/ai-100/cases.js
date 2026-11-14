'use strict';
/*
 * SEOSA AI 100문항 — 범주 · 기대 조건 (2026-11-14).
 *
 * 질문 문장은 기존 scripts/test-100-questions.js 와 한 글자도 같다(이전 실행과 비교 가능).
 * 기대 조건은 «답 문장을 읽지 않고도» 기계가 판정할 수 있는 것만 hard 로 둔다. 판단이 필요한
 * 것(타이밍 조언의 옳고 그름, 스펙 수치의 정확도, 비교 설명의 질)은 soft/review 로 두고
 * UNVERIFIED 로 남긴다 — 사람이 근거를 적어 리뷰 파일로 확정한다(--review-file).
 *
 * cards:  'required' 카드가 없으면 FAIL(no_cards) · 'forbidden' 카드가 있으면 FAIL · 'optional'
 * type:   TYPES 의 열쇠. 모든 카드 제목이 그 유형이어야 한다(액세서리·부품 제외 포함) — hard
 * maxPrice/minPrice: 카드 가격 경계 — hard (질문에 적힌 예산)
 * brand:  모든 카드가 그 브랜드 — hard.  notBrand: 그 브랜드 카드가 하나도 없어야 — hard
 * must:   모든 카드 제목이 맞아야 하는 정규식들(모델·용량) — hard
 * mustNot: 어떤 카드 제목도 맞으면 안 되는 정규식들 — hard
 * soft:   맞지 않으면 UNVERIFIED 로 내리는 정규식들(전부 카드 제목 기준)
 * sides:  비교 — 각 카드는 어느 한쪽이어야 hard, 양쪽이 다 보이면 좋다(soft)
 * allowUsed: 중고·리퍼 카드 허용
 * review: 자동 검사를 다 통과해도 사람이 봐야 PASS 를 줄 수 있는 문항 (UNVERIFIED)
 * seed:   후속 질문 — 같은 세션에서 먼저 보내는 질문(채점하지 않음). followup: 이전 턴과의 관계 검사
 */

/* 상품 유형 — 엔진(_ai-v31-taxonomy)과 독립된 단순 사전. include 중 하나 + exclude 없음 */
const ACCESSORY = /케이스|커버|파우치|필름|강화\s*유리|스킨|스트랩|거치대|스탠드|받침|홀더|브라켓|충전기|충전\s*독|케이블|어댑터|젠더|이어팁|폼팁|이어\s*패드|키링|부품|소모품|교체용|리필|필터|브러시|걸레|더스트\s*백|칼날|노즐|리모컨|전용\s*가방/;
const TYPES = {
  이어폰: { include: /이어폰|이어버드|버즈|에어팟|airpods|earbuds?|earphones?|\btws\b|오픈형|골전도/i, exclude: ACCESSORY },
  헤드폰: { include: /헤드폰|헤드셋|headphones?|headset|WH-?1000|오버이어|온이어|QC\s*\d|quietcomfort/i, exclude: ACCESSORY },
  // 악기 건반(전자키보드·디지털피아노)은 컴퓨터 키보드가 아니다 (Q051).
  키보드: { include: /키보드|keyboard/i, exclude: /키캡|키\s*스킨|팜\s*레스트|손목\s*받침|커버|케이블|스위치\s*(?:세트|교체)|키보드\s*케이스|전자\s*키보드|디지털\s*피아노|전자\s*피아노|신디사이저|건반|\bPSR-?[A-Z]?\d/i },
  // «+ 장패드» 동봉 마우스는 마우스다(Q089). 패드·번지가 «주 상품» 일 때만 제외. 지명·티켓은 마우스가 아니다(Q020 «그레이마우스 열차 티켓»).
  마우스: { include: /마우스|mouse/i, exclude: /마우스\s*패드|마우스패드|번지|그립\s*테이프|마우스\s*피트|스케이트|손목\s*받침|티켓|열차|여행|투어|입장권/ },
  노트북거치대: { include: /(?:노트북|맥북|랩탑|laptop).{0,12}(?:거치대|스탠드|받침)|(?:거치대|스탠드|받침).{0,12}(?:노트북|맥북|랩탑)/i, exclude: /가방|파우치/ },
  외장SSD: { include: /(?:외장|포터블|portable|휴대용).{0,20}ssd|ssd.{0,20}(?:외장|포터블|portable)|\bT7\b|\bT9\b|\bP9\b|익스트림\s*포터블|extreme\s*portable/i, exclude: /케이스|파우치|인클로저|커버/ },
  아이패드케이스: { include: /(?:아이패드|ipad).{0,40}(?:케이스|커버|폴리오)|(?:케이스|커버|폴리오).{0,40}(?:아이패드|ipad)/i, exclude: /필름|강화\s*유리/ },
  USB허브: { include: /허브|hub|멀티\s*포트|도킹/i, exclude: /케이블만/ },
  모니터암: { include: /모니터\s*암|모니터암|monitor\s*arm|모니터\s*(?:거치대|스탠드)/i, exclude: /필름|케이블/ },
  킥보드: { include: /킥보드|스쿠터|scooter/i, exclude: /부품|타이어|튜브|배터리만|충전기|거치대|커버/ },
  캠핑의자: { include: /(?:캠핑|접이식|릴렉스|로우|하이).{0,12}(?:의자|체어|chair)|(?:의자|체어|chair)/i, exclude: /커버|부품|테이블만/ },
  공기청정기: { include: /공기\s*청정기|air\s*purifier/i, exclude: /필터|교체용|소모품/ },
  // 「자동 물걸레 세척」 은 로봇청소기의 기능이다(Q014) — 교체·호환 소모품만 제외한다.
  로봇청소기: { include: /로봇\s*청소기|robot\s*vacuum|로보락|roborock|룸바|roomba|에코백스|deebot/i, exclude: /교체용|호환|소모품|필터\s*(?:세트|교체)|브러시\s*(?:세트|교체)|더스트\s*백|(?:물걸레|걸레)\s*(?:패드|포)\s*(?:세트|교체|리필|\d+\s*매)/ },
  전자책리더기: { include: /전자책|이북|e-?book|킨들|kindle|리더기|크레마|오닉스|boox|포켓북|코보|kobo/i, exclude: ACCESSORY },
  태블릿: { include: /태블릿|아이패드|ipad|갤럭시\s*탭|galaxy\s*tab|미패드|레노버\s*탭|tab\s*[sap]?\d/i, exclude: /케이스|커버|필름|강화\s*유리|(?:^|[^가-힣])펜(?![가-힣])|펜슬|키보드|거치대|충전기|파우치|스킨/ },
  노트북: { include: /노트북|laptop|그램|gram|맥북|macbook|갤럭시\s*북|galaxy\s*book|thinkpad|씽크패드|ideapad|아이디어패드|vivobook|비보북|젠북|zenbook|레노버|에이수스|asus|\bhp\b|dell|msi/i, exclude: /가방|파우치|거치대|스탠드|쿨러|필름|키\s*스킨|어댑터|충전기|배터리|케이스|받침/ },
  안마의자: { include: /안마\s*의자|마사지\s*체어|massage\s*chair/i, exclude: /커버|부품/ },
  스마트워치: { include: /스마트\s*워치|워치|watch|갤럭시\s*핏|미\s*밴드|smart\s*band/i, exclude: /스트랩|교체\s*밴드|케이스|필름|강화\s*유리|충전기|거치대|보호/ },
  블렌더: { include: /블렌더|믹서기|믹서|blender|착즙기|초퍼/i, exclude: /용기만|칼날|부품|패킹/ },
  세탁기: { include: /세탁기|washer|워시|트롬|그랑데|드럼/i, exclude: /받침대|커버|호스|세제|건조기만|부품/ },
  충전케이블: { include: /케이블|cable/i, exclude: /허브|충전기\s*단품/ },
  모니터: { include: /모니터|monitor|오디세이|odyssey|울트라기어|ultragear|\d{2}\s*인치.{0,20}(?:qhd|fhd|uhd|4k)/i, exclude: /모니터\s*암|거치대|받침대|필름|케이블|스탠드|조명|라이트바/ },
  무선청소기: { include: /청소기|vacuum|다이슨|dyson|코드\s*제로|cordzero|제트|jet/i, exclude: ACCESSORY },
  TV: { include: /\btv\b|티비|텔레비전|oled|qled|올레드|큐엘이디/i, exclude: /거치대|브라켓|리모컨|벽걸이\s*브라켓|케이블|필름/ },
  저장장치: { include: /ssd|hdd|하드\s*디스크|외장\s*하드|nvme|sata/i, exclude: /케이스|인클로저|파우치/ },
  닌텐도스위치: { include: /스위치|switch/i, exclude: /케이스|파우치|필름|강화\s*유리|그립|거치대|충전|(?:^|\s)독(?:\s|$)|도크|dock|칩|타이틀|게임\s*팩|아미보/i },
  에어랩: { include: /에어랩|airwrap/i, exclude: /거치대|케이스|노즐|부품|파우치/ }
};
const BRANDS = {
  애플: /애플|apple|아이폰|iphone|아이패드|ipad|맥북|macbook|에어팟|airpods|애플\s*워치|apple\s*watch|imac|아이맥/i,
  삼성: /삼성|samsung|갤럭시|galaxy|오디세이|odyssey|비스포크|bespoke/i,
  소니: /소니|sony/i,
  로지텍: /로지텍|logitech|\blogi\b/i,
  다이슨: /다이슨|dyson/i,
  샤오미: /샤오미|xiaomi|미지아|mijia|레드미|redmi|\bmi\b|미\s*밴드|미패드/i,
  LG: /\blg\b|엘지|그램|gram|울트라기어|ultragear|코드\s*제로|트롬|올레드\s*evo/i,
  보스: /보스|bose/i
};

const q = (n, category, question, expect) => ({ id: 'Q' + String(n).padStart(3, '0'), n, category, question, expect: expect || {} });

const CASES = [
  // ── 기본 추천 (1-15): 카드 필수 · 유형 일치 ──
  q(1, 'recommend', '에어팟 추천해줘', { cards: 'required', type: '이어폰', brand: '애플', must: [/에어팟|airpods/i] }),
  q(2, 'recommend', '10만원대 블루투스 이어폰 뭐가 좋아?', { cards: 'required', type: '이어폰', minPrice: 100000, maxPrice: 199999, soft: [/블루투스|무선|bluetooth|tws|버즈|에어팟/i] }),
  q(3, 'recommend', '게이밍 키보드 추천', { cards: 'required', type: '키보드', soft: [/게이밍|gaming|기계식|래피드|자석축|마그네틱/i] }),
  q(4, 'recommend', '가성비 좋은 무선 마우스 알려줘', { cards: 'required', type: '마우스', soft: [/무선|wireless|블루투스|bluetooth|lightspeed|2\.4/i] }),
  q(5, 'recommend', '노트북 거치대 하나 찾아줘', { cards: 'required', type: '노트북거치대' }),
  q(6, 'recommend', '외장 SSD 1TB 추천해줘', { cards: 'required', type: '외장SSD', must: [/1\s*TB|1\s*테라|1,?000\s*GB/i] }),
  q(7, 'recommend', '공부할 때 쓸 노이즈캔슬링 헤드폰 추천', { cards: 'required', type: '헤드폰', soft: [/노이즈|캔슬|\banc\b|\bnc\b|1000x|quietcomfort|qc\s*\d/i] }),
  q(8, 'recommend', '아이패드 케이스 추천해줘', { cards: 'required', type: '아이패드케이스' }),
  q(9, 'recommend', 'USB-C 허브 좋은 거 있어?', { cards: 'required', type: 'USB허브', soft: [/usb|c\s*타입|type-?c|썬더볼트|thunderbolt/i] }),
  q(10, 'recommend', '모니터 암 추천', { cards: 'required', type: '모니터암' }),
  q(11, 'recommend', '전동 킥보드 추천해줘', { cards: 'required', type: '킥보드', soft: [/전동|전기|electric|모터/i] }),
  q(12, 'recommend', '캠핑 의자 좋은 거 알려줘', { cards: 'required', type: '캠핑의자', soft: [/캠핑|camping|접이식|릴렉스|체어/i] }),
  q(13, 'recommend', '공기청정기 추천', { cards: 'required', type: '공기청정기' }),
  q(14, 'recommend', '로봇청소기 뭐가 좋아?', { cards: 'required', type: '로봇청소기' }),
  q(15, 'recommend', '전자책 리더기 추천해줘', { cards: 'required', type: '전자책리더기' }),
  // ── 예산 지정 (16-25): 카드 필수 · 유형 · 예산 경계 ──
  q(16, 'budget', '5만원 이하 이어폰 추천', { cards: 'required', type: '이어폰', maxPrice: 50000 }),
  q(17, 'budget', '30만원 이하 태블릿 있어?', { cards: 'required', type: '태블릿', maxPrice: 300000 }),
  q(18, 'budget', '예산 20만원으로 기계식 키보드 찾아줘', { cards: 'required', type: '키보드', maxPrice: 200000, soft: [/기계식|mechanical|축|스위치|핫스왑/i] }),
  q(19, 'budget', '100만원 이하 노트북 추천해줘', { cards: 'required', type: '노트북', maxPrice: 1000000 }),
  q(20, 'budget', '3만원짜리 마우스 추천', { cards: 'required', type: '마우스', maxPrice: 39999 }),
  q(21, 'budget', '50만원대 안마의자 있어?', { cards: 'required', type: '안마의자', minPrice: 500000, maxPrice: 599999 }),
  q(22, 'budget', '15만원 이하 스마트워치', { cards: 'required', type: '스마트워치', maxPrice: 150000 }),
  q(23, 'budget', '10만원 이하 블렌더 추천해줘', { cards: 'required', type: '블렌더', maxPrice: 100000 }),
  q(24, 'budget', '200만원 이하 세탁기', { cards: 'required', type: '세탁기', maxPrice: 2000000 }),
  q(25, 'budget', '2만원 이하 충전 케이블 추천', { cards: 'required', type: '충전케이블', maxPrice: 20000 }),
  // ── 가격 비교 / 최저가 (26-35): 카드 필수 · 정확한 모델 ──
  q(26, 'price_lookup', '삼성 T7 1TB 최저가 알려줘', { cards: 'required', type: '외장SSD', brand: '삼성', must: [/\bT7\b/i, /1\s*TB|1\s*테라/i], soft: [/^(?!.*(?:shield|실드|touch|터치)).*/i] }),
  q(27, 'price_lookup', '에어팟 프로 2 가격 비교해줘', { cards: 'required', type: '이어폰', brand: '애플', must: [/에어팟\s*프로|airpods\s*pro/i], mustNot: [/프로\s*3|pro\s*3|3\s*세대/i], soft: [/2\s*세대|pro\s*2|프로\s*2|usb-?c|c\s*타입/i] }),
  q(28, 'price_lookup', '갤럭시 버즈3 프로 어디가 제일 싸?', { cards: 'required', type: '이어폰', brand: '삼성', must: [/버즈\s*3\s*프로|buds\s*3\s*pro/i] }),
  q(29, 'price_lookup', '다이슨 에어랩 최저가', { cards: 'required', type: '에어랩', brand: '다이슨' }),
  // 판매처 제목은 «맥북 Air» 처럼 한·영을 섞는다(Q030).
  q(30, 'price_lookup', '맥북 에어 M3 가격 비교', { cards: 'required', type: '노트북', brand: '애플', must: [/(?:맥북|macbook)\s*(?:에어|air)/i, /\bm3\b/i] }),
  q(31, 'price_lookup', '닌텐도 스위치 어디서 사는 게 제일 싸?', { cards: 'required', type: '닌텐도스위치', must: [/닌텐도|nintendo/i] }),
  q(32, 'price_lookup', '소니 WH-1000XM5 최저가 찾아줘', { cards: 'required', type: '헤드폰', brand: '소니', must: [/WH-?1000\s*XM5/i] }),
  q(33, 'price_lookup', 'LG 그램 17인치 가격 비교', { cards: 'required', type: '노트북', brand: 'LG', must: [/그램|gram/i, /\b17\b|17\s*인치|17Z/i] }),
  // 미니 7 = A17 Pro(2024). 다른 세대(A18~A20 Pro · 8세대)는 다른 모델이다 — hard (Q034 에서 A20 Pro 가 «같은 모델» 로 나옴).
  q(34, 'price_lookup', '아이패드 미니 7 최저가', { cards: 'required', type: '태블릿', brand: '애플', must: [/(?:아이패드|ipad)\s*(?:미니|mini)/i],
    mustNot: [/A(?:18|19|20)\s*Pro|[89]\s*세대|mini\s*\(?\s*A(?:18|19|20)/i], soft: [/7\s*세대|a17|mini\s*7|미니\s*7/i] }),
  q(35, 'price_lookup', '삼성 오디세이 G5 모니터 가격 비교해줘', { cards: 'required', type: '모니터', brand: '삼성', must: [/오디세이|odyssey/i, /\bG5\b/i] }),
  // ── 비교 (36-45): 카드는 선택, 있으면 어느 한쪽 · 설명의 질은 리뷰 ──
  q(36, 'compare', '에어팟 프로 vs 갤럭시 버즈 뭐가 나아?', { cards: 'optional', type: '이어폰', sides: [/에어팟|airpods/i, /버즈|buds/i], review: true }),
  q(37, 'compare', '맥북이랑 갤럭시북 비교해줘', { cards: 'optional', type: '노트북', sides: [/맥북|macbook/i, /갤럭시\s*북|galaxy\s*book/i], review: true }),
  q(38, 'compare', '다이슨이랑 LG 무선청소기 뭐가 좋아?', { cards: 'optional', type: '무선청소기', sides: [BRANDS.다이슨, BRANDS.LG], review: true }),
  q(39, 'compare', '기계식 키보드랑 멤브레인 차이가 뭐야?', { cards: 'optional', type: '키보드', review: true }),
  q(40, 'compare', '아이패드 에어랑 프로 뭐가 나을까?', { cards: 'optional', type: '태블릿', sides: [/에어|air/i, /프로|pro/i], review: true }),
  q(41, 'compare', 'SSD랑 HDD 뭐 사야 돼?', { cards: 'optional', type: '저장장치', review: true }),
  q(42, 'compare', '로지텍이랑 라울 마우스 비교', { cards: 'optional', type: '마우스', review: true }),
  q(43, 'compare', '샤오미 공기청정기 vs 삼성 비스포크', { cards: 'optional', type: '공기청정기', sides: [BRANDS.샤오미, BRANDS.삼성], review: true }),
  q(44, 'compare', 'OLED TV랑 QLED 뭐가 좋아?', { cards: 'optional', type: 'TV', review: true }),
  q(45, 'compare', '보스 헤드폰이랑 소니 헤드폰 비교해줘', { cards: 'optional', type: '헤드폰', sides: [BRANDS.보스, BRANDS.소니], review: true }),
  // ── 후속 질문 (46-55): 같은 세션에서 seed 다음에 묻는다 ──
  q(46, 'followup', '더 싼 거 없어?', { seed: '5만원 이하 무선 이어폰 추천해줘', cards: 'optional', type: '이어폰', maxPrice: 50000, followup: { cheaperThanSeed: true } }),
  q(47, 'followup', '다른 색상도 있어?', { seed: '아이패드 에어 추천해줘', cards: 'optional', type: '태블릿', must: [/에어|air/i], review: true }),
  q(48, 'followup', '첫 번째 거 좀 더 알려줘', { seed: '100만원 이하 노트북 추천해줘', cards: 'optional', type: '노트북', maxPrice: 1000000, followup: { onlySeedIndex: 0 }, review: true }),
  q(49, 'followup', '두 번째 거 어디서 사?', { seed: '에어팟 프로와 갤럭시 버즈 비교해줘', cards: 'optional', type: '이어폰', followup: { onlySeedIndex: 1 }, review: true }),
  q(50, 'followup', '무선으로 된 건 없어?', { seed: '유선 헤드폰 추천해줘', cards: 'optional', type: '헤드폰', must: [/무선|블루투스|bluetooth|wireless/i] }),
  q(51, 'followup', '좀 더 비싼 거 보여줘', { seed: '20만원 이하 기계식 키보드 추천해줘', cards: 'optional', type: '키보드', followup: { pricierThanSeed: 'soft' }, review: true }),
  q(52, 'followup', '삼성 말고 다른 브랜드로', { seed: '삼성 모니터 추천해줘', cards: 'optional', type: '모니터', notBrand: '삼성' }),
  q(53, 'followup', '이거 말고 다른 거 추천해줘', { seed: '5만원 이하 무선 마우스 추천해줘', cards: 'optional', type: '마우스', maxPrice: 50000, followup: { differentFromSeed: true } }),
  q(54, 'followup', '쿠팡에서 파는 거만 보여줘', { seed: '게이밍 마우스 추천해줘', cards: 'optional', type: '마우스', mall: '쿠팡' }),
  q(55, 'followup', '배송 빠른 거 있어?', { seed: '기계식 키보드 추천해줘', cards: 'optional', type: '키보드', review: true }),
  // ── 구매 시점 (56-62): 맥락 없는 질문이 많다 — 조언의 옳고 그름은 리뷰 ──
  q(56, 'timing', '에어팟 지금 사도 돼?', { cards: 'optional', type: '이어폰', review: true }),
  q(57, 'timing', '블랙프라이데이까지 기다려야 해?', { cards: 'optional', review: true }),
  q(58, 'timing', '이 가격이면 괜찮은 거야?', { cards: 'optional', review: true }),
  q(59, 'timing', '요즘 가격이 많이 올랐어?', { cards: 'optional', review: true }),
  q(60, 'timing', '최근에 가격 변동 있었어?', { cards: 'optional', review: true }),
  q(61, 'timing', '지금이 최저가야?', { cards: 'optional', review: true }),
  q(62, 'timing', '좀 더 기다리면 싸질까?', { cards: 'optional', review: true }),
  // ── 스펙 (63-70): 수치의 정확도는 리뷰 ──
  q(63, 'spec', '에어팟 프로 배터리 얼마나 가?', { cards: 'optional', type: '이어폰', review: true }),
  q(64, 'spec', '이 모니터 주사율이 몇이야?', { cards: 'optional', review: true }),
  q(65, 'spec', '갤럭시 S24 울트라 무게 알려줘', { cards: 'optional', review: true }),
  q(66, 'spec', '이 SSD 읽기 속도 얼마야?', { cards: 'optional', review: true }),
  q(67, 'spec', '아이패드 에어 저장 용량 옵션 뭐 있어?', { cards: 'optional', type: '태블릿', review: true }),
  q(68, 'spec', '이 키보드 스위치 종류가 뭐야?', { cards: 'optional', review: true }),
  q(69, 'spec', '이 이어폰 방수 돼?', { cards: 'optional', review: true }),
  q(70, 'spec', '이 노트북 램 업그레이드 되나?', { cards: 'optional', review: true }),
  // ── 비쇼핑 (71-80): 카드 금지 ──
  q(71, 'knowledge', '너 이름이 뭐야?', { cards: 'forbidden', review: true }),
  q(72, 'knowledge', '오늘 날씨 어때?', { cards: 'forbidden', review: true }),
  q(73, 'knowledge', 'USB-C가 뭐야?', { cards: 'forbidden', review: true }),
  q(74, 'knowledge', '블루투스 5.3이랑 5.0 차이가 뭐야?', { cards: 'forbidden', review: true }),
  q(75, 'knowledge', 'OLED가 뭔지 설명해줘', { cards: 'forbidden', review: true }),
  q(76, 'knowledge', '노이즈캔슬링 원리가 뭐야?', { cards: 'forbidden', review: true }),
  q(77, 'knowledge', '와이파이 6E가 뭐야?', { cards: 'forbidden', review: true }),
  q(78, 'knowledge', 'MagSafe가 뭐야?', { cards: 'forbidden', review: true }),
  q(79, 'knowledge', '환율이 상품 가격에 영향을 미쳐?', { cards: 'forbidden', review: true }),
  q(80, 'knowledge', '쿠팡 로켓배송이 뭐야?', { cards: 'forbidden', review: true }),
  // ── 감사·인사 (81-85): 카드 금지 — 자동 판정으로 충분 ──
  q(81, 'smalltalk', '고마워!', { cards: 'forbidden' }),
  q(82, 'smalltalk', '잘 알겠어 감사해', { cards: 'forbidden' }),
  q(83, 'smalltalk', '도움 많이 됐어', { cards: 'forbidden' }),
  q(84, 'smalltalk', '오 딱 이거야 고마워', { cards: 'forbidden' }),
  q(85, 'smalltalk', '안녕하세요', { cards: 'forbidden' }),
  // ── 브랜드 지정 (86-92): 카드 필수 · 브랜드 일치 ──
  q(86, 'brand', '소니 이어폰 추천해줘', { cards: 'required', type: '이어폰', brand: '소니' }),
  q(87, 'brand', '삼성 모니터 중에 괜찮은 거', { cards: 'required', type: '모니터', brand: '삼성' }),
  q(88, 'brand', '애플 제품만 보여줘', { cards: 'required', brand: '애플', review: true }),
  q(89, 'brand', '로지텍 마우스 추천', { cards: 'required', type: '마우스', brand: '로지텍' }),
  q(90, 'brand', '다이슨 제품 뭐가 있어?', { cards: 'required', brand: '다이슨' }),
  q(91, 'brand', '샤오미 가성비 제품 추천', { cards: 'required', brand: '샤오미', review: true }),
  q(92, 'brand', 'LG 노트북 추천해줘', { cards: 'required', type: '노트북', brand: 'LG' }),
  // ── 복합·엣지 (93-100) ──
  q(93, 'edge', '중고 에어팟도 괜찮아?', { cards: 'optional', type: '이어폰', allowUsed: true, review: true }),
  q(94, 'edge', '남자친구 선물로 10만원대 추천해줘', { cards: 'optional', minPrice: 100000, maxPrice: 199999, review: true }),
  q(95, 'edge', '자취 시작하는데 필요한 가전 추천', { cards: 'optional', review: true }),
  q(96, 'edge', '코딩할 때 쓸 모니터 추천해줘', { cards: 'required', type: '모니터' }),
  q(97, 'edge', '아이 학습용 태블릿 추천', { cards: 'required', type: '태블릿' }),
  q(98, 'edge', '운동할 때 쓸 이어폰 뭐가 좋아?', { cards: 'required', type: '이어폰' }),
  q(99, 'edge', '가격 많이 떨어진 제품 있어?', { cards: 'optional', review: true }),
  q(100, 'edge', 'ㅁㄴㅇㄹ', { cards: 'forbidden' })
];

const CATEGORY_LABELS = {
  recommend: '기본 추천', budget: '예산 지정', price_lookup: '가격 비교·최저가', compare: '비교', followup: '후속 질문',
  timing: '구매 시점', spec: '스펙', knowledge: '비쇼핑', smalltalk: '감사·인사', brand: '브랜드 지정', edge: '복합·엣지'
};

module.exports = { CASES, TYPES, BRANDS, CATEGORY_LABELS, ACCESSORY };
