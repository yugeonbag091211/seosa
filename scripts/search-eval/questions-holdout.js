'use strict';
/*
 * 독립 검증용 홀드아웃 110문항 (H001–H110).
 *
 * ★ 수정 과정에 쓰지 않는다. 이 파일의 sha256 은 reports/search-eval/preregistration.json 에
 *   «구현을 쓰기 전에» 고정했다. 최종 코드에서 한 번만 채점하고, 그 뒤 이 파일이나 채점기를
 *   고치면 그 결과는 홀드아웃이 아니다 (새 홀드아웃을 써야 한다).
 */
const I = 'i';
const r = (s) => new RegExp(s, I);
const IPHONE = r('아이폰|iphone'), IPAD = r('아이패드|ipad'), GALAXY = r('갤럭시|galaxy');
const TAB = r('탭|tab'), PRO = r('프로|pro'), MAX = r('맥스|max'), ULTRA = r('울트라|ultra'), PLUS = r('플러스|plus|\\+');
const AIR = r('에어(?!팟|컨|프라이어|랩)|air(?!pods|wrap|fryer)'), MINI = r('미니|mini'), FE = r('\\bfe\\b');
const WIRELESS = r('무선|블루투스|wireless|bluetooth|2\\.4\\s*g|라이트스피드|lightspeed|tws');
const LAPTOP = r('노트북|laptop|맥북|macbook|그램|gram|갤럭시\\s*북|galaxy\\s*book|북\\s*\\d|thinkpad|씽크\\s*패드|아이디어\\s*패드|ideapad|비보북|vivobook|젠북|zenbook|크롬북|chromebook|파빌리온|pavilion|인스피론|inspiron|요가|yoga|빅터스|victus|레노버|lenovo|에이수스|asus|msi|카타나|katana|사이보그|cyborg|tuf|로그|rog|레기온|legion|오멘|omen|프레데터|predator|니트로|nitro');
const LAPTOP_SPEC = r('i[3579]|코어|core|울트라\\s*[579]|ultra\\s*[579]|라이젠|ryzen|셀러론|celeron|\\bm[1-4]\\b|\\d+\\s*gb|ssd|램|ram|인치|\\d{2}\\.\\d|rtx|windows|윈도우');
const EAR = r('이어폰|이어버드|earbuds|buds|버즈|에어팟|airpods|tws');
const HEADPHONE = r('헤드폰|헤드셋|headphone|headset');

const main = (id, cat, q, m, x, extra = {}) => ({ id, cat, q, kind: 'main', m, x: x || [], ...extra });
const acc = (id, cat, q, m, x, extra = {}) => ({ id, cat, q, kind: 'acc', m, x: x || [], ...extra });
const fu = (id, seed, q, base) => ({ ...base, id, cat: 'followup', seed, q });
const P = 'phone_tablet', L = 'laptop_pc', A = 'audio', E = 'appliance', V = 'living', F = 'fashion', B = 'brand_model', O = 'price_option';

module.exports = [
  // ── 스마트폰·태블릿 (18) ──
  main('H001', P, '아이폰 16 플러스', [IPHONE, r('16'), PLUS], [r('프로|pro|16e')]),
  main('H002', P, '아이폰 15 프로 맥스 512GB', [IPHONE, r('15'), r('프로\\s*맥스|pro\\s*max|프로맥스|promax')], [], { cap: 512 }),
  main('H003', P, '갤럭시 S25 플러스 256GB', [GALAXY, r('s25'), PLUS], [r('울트라|ultra|엣지|edge')], { cap: 256 }),
  main('H004', P, '갤럭시 Z 폴드6 512GB', [GALAXY, r('폴드\\s*6|fold\\s*6')], [r('폴드\\s*[57]|fold\\s*[57]|플립|flip')], { cap: 512 }),
  main('H005', P, '갤럭시 A16', [GALAXY, r('a16')], [r('a15|a25|a35|a55')]),
  main('H006', P, '아이패드 A16 11세대', [IPAD, r('a16|11\\s*세대|11th')], [r('에어|air|프로|pro|미니|mini|10\\s*세대')]),
  main('H007', P, '아이패드 미니 6세대', [IPAD, MINI, r('6\\s*세대|미니\\s*6|mini\\s*6|a15')], [r('7\\s*세대|미니\\s*7|mini\\s*7|a17')]),
  main('H008', P, '아이패드 프로 13 M4', [IPAD, PRO, r('13'), r('m4')], [r('m2|m1|11\\s*(?:인치|형)|에어|air')]),
  main('H009', P, '갤럭시 탭 S10 FE', [GALAXY, TAB, r('s10'), FE], [r('울트라|ultra|s9')]),
  main('H010', P, '갤럭시 탭 S9 울트라', [GALAXY, TAB, r('s9'), ULTRA], [r('\\bfe\\b|s10')]),
  acc('H011', P, '아이폰 15 케이스', [IPHONE, r('15'), r('케이스|case|범퍼')], [r('15\\s*(?:프로|pro|플러스|plus)|아이폰\\s*1[346]\\b')]),
  acc('H012', P, '갤럭시 S24 울트라 필름', [r('s24'), ULTRA, r('필름|강화\\s*유리|보호')], []),
  acc('H013', P, '아이패드 에어 11 케이스', [IPAD, AIR, r('11'), r('케이스|커버|case|폴리오')], [r('13\\s*(?:인치|형)')]),
  main('H014', P, '아이폰 14 중고 말고 새제품', [IPHONE, r('(?:아이폰|iphone)\\s*14')], [r('프로|pro|플러스|plus')], { used: 'x' }),
  main('H015', P, '갤럭시 S23 FE', [GALAXY, r('s23'), FE], [r('울트라|ultra|플러스|plus')]),
  main('H016', P, '아이폰 13 미니', [IPHONE, r('13'), MINI], [r('프로|pro|12\\s*미니')]),
  main('H017', P, '레노버 리전 Y700', [r('레노버|lenovo|리전|legion'), r('y700')], []),
  main('H018', P, '갤럭시 Z 플립5', [GALAXY, r('플립\\s*5|flip\\s*5')], [r('플립\\s*[46]|flip\\s*[46]|폴드|fold')]),

  // ── 노트북·컴퓨터 (14) ──
  main('H019', L, 'LG 그램 17', [r('그램|gram'), r('17')], [r('그램\\s*(?:14|15|16)(?!\\d)|gram\\s*(?:14|15|16)(?!\\d)|(?<!\\d)(?:14|15|16)z\\d')]),
  main('H020', L, '맥북 프로 16 M4 프로', [r('맥북|macbook'), PRO, r('16'), r('m4')], [r('14\\s*(?:인치|형)|에어|air|m3')]),
  main('H021', L, '갤럭시 북4 엣지', [r('북\\s*4|book\\s*4'), r('엣지|edge')], [r('북\\s*[35]|book\\s*[35]')]),
  main('H022', L, '레노버 요가 슬림7', [r('레노버|lenovo'), r('요가|yoga'), r('슬림\\s*7|slim\\s*7')], [r('슬림\\s*[56]|slim\\s*[56]')]),
  main('H023', L, '에이수스 젠북 14 OLED', [r('에이수스|asus|젠북|zenbook'), r('14'), r('oled')], [r('젠북\\s*(?:13|15|16)(?!\\d)|zenbook\\s*(?:13|15|16)(?!\\d)')]),
  main('H024', L, 'MSI 게이밍 노트북', [r('msi'), LAPTOP_SPEC], [r('모니터|monitor|메인보드|그래픽\\s*카드|그래픽카드|본체')]),
  acc('H025', L, '노트북 쿨링패드', [r('쿨링\\s*패드|쿨러|쿨링\\s*스탠드|cooling')], []),
  main('H026', L, '아이패드용 블루투스 키보드', [r('키보드|keyboard'), r('블루투스|bluetooth|무선|wireless')], [r('키\\s*스킨|키캡')]),
  main('H027', L, '로지텍 K380', [r('로지텍|logitech'), r('k380')], [r('k375|k480|k780')]),
  main('H028', L, '24인치 FHD 모니터', [r('모니터|monitor'), r('24|23\\.8'), r('fhd|풀\\s*hd|1920|1080')], [r('27\\s*(?:인치|형)|32\\s*(?:인치|형)|암|받침')]),
  main('H029', L, '델 울트라샤프 27', [r('델|dell'), r('울트라\\s*샤프|ultrasharp|u27')], []),
  main('H030', L, '샌디스크 익스트림 포터블 SSD 1TB', [r('샌디스크|sandisk'), r('익스트림|extreme'), r('ssd')], [r('프로(?!.*1tb)|케이스')], { cap: 1024 }),
  main('H031', L, '맥북 에어 M2 중고', [r('맥북|macbook'), AIR, r('m2')], [], { used: 'want' }),
  main('H032', L, '120만원 이하 노트북', [LAPTOP, LAPTOP_SPEC], [], { max: 1200000 }),

  // ── 이어폰·헤드폰 (10) ──
  main('H033', A, '갤럭시 버즈3', [r('버즈\\s*3|buds\\s*3')], [r('프로|pro|\\bfe\\b|버즈\\s*2')], { accOk: r('충전\\s*케이스') }),
  main('H034', A, '소니 WH-CH720N', [r('ch\\s*-?\\s*720\\s*n|ch720')], [r('ch520|ch730|1000xm')]),
  main('H035', A, '에어팟 프로 3', [r('에어팟|airpods'), r('(?:프로|pro)\\s*3|3\\s*세대')], [r('(?:프로|pro)\\s*2|맥스|max')], { accOk: r('충전\\s*케이스|magsafe|맥세이프') }),
  main('H036', A, '보스 QC 울트라 이어버드', [r('보스|bose'), r('울트라|ultra'), r('이어버드|earbuds|이어폰')], [r('헤드폰|headphone')], { accOk: r('충전\\s*케이스') }),
  main('H037', A, '비츠 스튜디오 버즈', [r('비츠|beats'), r('스튜디오|studio'), r('버즈|buds')], [r('솔로|solo|파워비츠|powerbeats')], { accOk: r('충전\\s*케이스') }),
  main('H038', A, '오픈형 무선 이어폰', [EAR, r('오픈형|오픈\\s*이어|open|클립|골전도|귀걸이|이어\\s*커프|ows')], [], { accOk: r('충전\\s*케이스') }),
  main('H039', A, '블루투스 넥밴드 이어폰', [r('넥밴드|neckband')], []),
  acc('H040', A, '헤드폰 거치대', [r('거치대|스탠드|홀더|hanger|걸이')], []),
  main('H041', A, '20만원 이하 노이즈캔슬링 헤드폰', [HEADPHONE, r('노이즈\\s*캔슬링|노캔|anc')], [r('이어폰|이어버드|earbuds')], { max: 200000, accOk: r('케이스\\s*(?:포함|제공)|보관\\s*케이스|휴대\\s*케이스') }),
  main('H042', A, '낫싱 이어 2', [r('낫싱|nothing'), r('ear'), r('2')], [r('ear\\s*\\(?a\\)?|ear\\s*1|ear\\s*3')], { accOk: r('충전\\s*케이스') }),

  // ── 가전제품 (14) ──
  main('H043', E, '로보락 Q 레볼루션', [r('로보락|roborock'), r('레볼루션|revolution|qrevo')], [r('s8|s7|q5|q7|q8')], { accOk: r('스테이션|물걸레|먼지|브러시') }),
  main('H044', E, '다이슨 V8', [r('다이슨|dyson'), r('v8')], [r('v10|v11|v12|v15|호환')], { accOk: r('헤드|브러시|노즐|툴') }),
  main('H045', E, '삼성 비스포크 제트 청소기', [r('비스포크|bespoke'), r('제트|jet'), r('청소기|vacuum')], [r('봇|bot|ai\\s*스팀')], { accOk: r('헤드|브러시|노즐|툴|청정\\s*스테이션|스테이션') }),
  main('H046', E, '블루에어 공기청정기', [r('블루에어|blueair'), r('청정기|purifier')], [], { accOk: r('필터|hepa|헤파') }),
  main('H047', E, '미니 가습기', [r('가습기|humidifier'), r('미니|mini|소형|usb|탁상|휴대용')], [r('필터\\s*(?:단품|교체)|심지\\s*(?:단품|교체)')]),
  main('H048', E, '6인용 전기압력밥솥', [r('밥솥|cooker'), r('6\\s*인'), r('압력|ih')], [r('내솥\\s*단품|패킹|3\\s*인|10\\s*인')]),
  main('H049', E, '에어프라이어 5L', [r('에어\\s*프라이어|airfryer|air\\s*fryer|에어프라이기'), r('5\\s*l|5\\s*리터|5\\.\\d\\s*l')], [r('종이\\s*호일|용기\\s*단품|실리콘')]),
  main('H050', E, '무선 전기주전자', [r('전기\\s*주전자|전기\\s*포트|커피\\s*포트|kettle|주전자')], [r('필터\\s*단품|뚜껑\\s*단품')]),
  main('H051', E, '네스프레소 캡슐 커피머신', [r('네스프레소|nespresso'), r('머신|machine|버츄오|vertuo|에센자|essenza|시티즈|citiz|이니시아|inissia|픽시|pixie')], [r('캡슐\\s*(?:\\d+|세트)|홀더|거치대|디스케일')]),
  main('H052', E, '필립스 전기면도기', [r('필립스|philips'), r('면도기|shaver')], [r('면도날|헤드\\s*(?:교체|단품)|교체\\s*날|날\\s*(?:교체|단품)')], { accOk: r('트리머\\s*포함|충전\\s*(?:스탠드|거치대)\\s*포함|세척\\s*스테이션') }),
  main('H053', E, '오랄비 전동칫솔', [r('오랄비|oral\\s*-?\\s*b'), r('전동|칫솔|toothbrush|io|프로|pro|vitality|바이탈리티')], [r('칫솔\\s*모\\s*(?:\\d|교체|리필)|리필\\s*모|교체\\s*모|브러시\\s*헤드\\s*(?:\\d|교체)')], { accOk: r('칫솔\\s*모\\s*\\d+\\s*개\\s*포함|충전기\\s*포함|여행용\\s*케이스') }),
  acc('H054', E, '다이슨 청소기 필터', [r('필터|filter')], []),
  main('H055', E, '스탠드형 에어컨', [r('에어컨|air\\s*conditioner'), r('스탠드|standing|타워')], [r('벽걸이(?!.*스탠드)|에어컨\\s*(?:커버|청소|필터|실외기\\s*커버)')], { accOk: r('스탠드\\s*형?|스탠드형|2in1|멀티') }),
  main('H056', E, '미니 냉장고', [r('냉장고|fridge|refrigerator'), r('미니|소형|mini|원룸|1도어|화장품|음료')], [r('냉장고\\s*(?:정리|수납|트레이|용기|탈취|자석)')]),

  // ── 생활용품 (10) ──
  main('H057', V, '3단 접이식 우산', [r('우산|umbrella'), r('3단|접이식|폴딩|folding|자동')], [r('우산\\s*(?:꽂이|케이스|커버|비닐)')]),
  main('H058', V, '기내용 캐리어 20인치', [r('캐리어|suitcase|여행\\s*가방|트렁크'), r('20')], [r('24\\s*인치(?!.*20)|28\\s*인치|커버|네임\\s*택')]),
  main('H059', V, '락앤락 밀폐용기', [r('락앤락|lock\\s*&?\\s*lock|locknlock'), r('밀폐\\s*용기|용기|container')], [r('뚜껑\\s*단품|패킹\\s*단품')], { accAllow: r('용기') }),
  main('H060', V, '극세사 이불', [r('이불|blanket|차렵'), r('극세사|마이크로\\s*화이버|microfiber')], [r('이불\\s*(?:압축팩|정리함|커버\\s*단품)')]),
  main('H061', V, '헤어 드라이 타월', [r('타월|수건|towel|헤어\\s*캡'), r('헤어|머리|드라이|hair')], [r('수건\\s*걸이')]),
  main('H062', V, '주방세제', [r('세제|detergent|퐁퐁|트리오|자연퐁'), r('주방|설거지|식기|dish')], [r('식기\\s*세척기\\s*(?:세제|전용)|세제\\s*(?:디스펜서|펌프|용기)')]),
  main('H063', V, '섬유유연제', [r('섬유\\s*유연제|유연제|softener|다우니|피죤|샤프란')], [r('디스펜서|볼\\s*단품')]),
  main('H064', V, '핸드크림', [r('핸드\\s*크림|hand\\s*cream')], [r('공병|케이스|파우치')]),
  acc('H065', V, '텀블러 빨대', [r('빨대|straw')], []),
  main('H066', V, '캠핑 의자', [r('의자|체어|chair'), r('캠핑|접이식|릴렉스|폴딩|camping|헬리녹스|helinox')], [r('의자\\s*(?:커버|발\\s*커버|덮개)|의자\\s*다리\\s*커버')]),

  // ── 패션·의류 (10) ──
  main('H067', F, '경량패딩', [r('경량|라이트|light'), r('패딩|다운|padding|puffer')], [r('세탁|패딩\\s*세제')]),
  main('H068', F, '여성 가디건', [r('가디건|cardigan'), r('여성|여자|우먼|women')], [r('남성(?!.*여성)|아동|키즈')]),
  main('H069', F, '남성 슬랙스', [r('슬랙스|slacks|정장\\s*바지'), r('남성|남자|맨즈|men')], [r('여성(?!.*남성)|여자(?!.*남자)|벨트\\s*단품')]),
  main('H070', F, '아레나 수영복', [r('아레나|arena'), r('수영복|swim')], [r('수영모|수경|가방|나이키|배럴|레노마')]),
  main('H071', F, '컨버스 척테일러', [r('컨버스|converse'), r('척\\s*테일러|chuck\\s*taylor|척\\s*70|chuck\\s*70|올스타|all\\s*star')], [r('신발\\s*끈|깔창')]),
  main('H072', F, '버킷햇', [r('버킷\\s*햇|벙거지|bucket\\s*hat')], []),
  main('H073', F, '기모 레깅스', [r('레깅스|leggings'), r('기모|fleece|융털|보온')], [r('아동|키즈(?!.*성인)')]),
  main('H074', F, '털 슬리퍼', [r('슬리퍼|slipper'), r('털|퍼|fur|양털|뽀글|기모')], [r('슬리퍼\\s*(?:걸이|정리대)')]),
  main('H075', F, '실리콘 수영모', [r('수영모|수모|swim\\s*cap'), r('실리콘|silicone')], [r('수영복(?!.*수영모)')]),
  main('H076', F, '뉴발란스 993', [r('뉴발란스|new\\s*balance|\\bnb\\b'), r('993')], [r('(?<!\\d)(?:530|327|574|990|2002|1906)(?!\\d)')]),

  // ── 브랜드·모델명 정확성 (10) ──
  main('H077', B, '로지텍 G502 X', [r('로지텍|logitech'), r('g502\\s*x')], [r('g502\\s*hero|g502\\s*lightspeed(?!.*x)|g304|g102|피트|그립')]),
  main('H078', B, '레이저 바이퍼 V3 프로', [r('레이저|razer'), r('바이퍼|viper'), r('v3'), PRO], [r('v2|mini|미니|하이퍼스피드|hyperspeed')]),
  main('H079', B, '소니 WF-1000XM4', [r('wf\\s*-?\\s*1000\\s*xm4')], [r('xm5|xm3|wh-')], { accOk: r('충전\\s*케이스') }),
  main('H080', B, '삼성 오디세이 G7', [r('오디세이|odyssey'), r('g7')], [r('g5|g6|g8|g9|g3|네오\\s*g|neo\\s*g')]),
  main('H081', B, '다이슨 에어랩 멀티스타일러', [r('다이슨|dyson'), r('에어랩|airwrap')], [r('호환|거치대|보관함|케이스\\s*단품|배럴\\s*단품')], { accOk: r('배럴\\s*(?:포함|세트)|노즐|브러시|코안다') }),
  main('H082', B, '갤럭시 워치 울트라', [r('워치|watch'), ULTRA, r('갤럭시|galaxy|삼성|samsung')], [r('애플|apple|스트랩|밴드\\s*(?:교체|단품)|필름|케이스')]),
  main('H083', B, '애플워치 울트라 2', [r('애플\\s*워치|apple\\s*watch'), ULTRA, r('2')], [r('갤럭시|galaxy|스트랩|밴드\\s*(?:교체|단품)|필름|케이스')]),
  main('H084', B, '로지텍 MX Anywhere 3S', [r('로지텍|logitech'), r('anywhere\\s*3s|애니웨어\\s*3s')], [r('anywhere\\s*3(?!s)|anywhere\\s*2|master')]),
  main('H085', B, '닌텐도 스위치 OLED', [r('닌텐도|nintendo'), r('oled')], [r('스위치\\s*2|switch\\s*2|라이트|lite|케이스|필름|파우치|게임\\s*칩|타이틀')]),
  main('H086', B, 'DJI 오즈모 포켓 3', [r('dji'), r('오즈모\\s*포켓|osmo\\s*pocket|포켓\\s*3|pocket\\s*3'), r('3')], [r('포켓\\s*2|pocket\\s*2|액션|action|케이스|필름|마운트')]),

  // ── 가격·옵션 제약 (9) ──
  main('H087', O, '100만원 이하 게이밍 노트북', [LAPTOP, LAPTOP_SPEC, r('게이밍|gaming|rtx|gtx|게임')], [], { max: 1000000 }),
  main('H088', O, '5만원 이하 블루투스 스피커', [r('스피커|speaker'), r('블루투스|bluetooth|무선|wireless')], [r('스피커\\s*(?:거치대|스탠드|케이블)')], { max: 50000 }),
  main('H089', O, '아이폰 15 256GB', [IPHONE, r('(?:아이폰|iphone)\\s*15')], [r('프로|pro|플러스|plus')], { cap: 256 }),
  main('H090', O, '갤럭시 Z 플립6 512GB', [GALAXY, r('플립\\s*6|flip\\s*6')], [r('플립\\s*[57]|flip\\s*[57]')], { cap: 512 }),
  main('H091', O, '15만원 이하 가습기', [r('가습기|humidifier')], [], { max: 150000 }),
  main('H092', O, '리퍼 말고 새 맥북 에어', [r('맥북|macbook'), AIR], [], { used: 'x' }),
  main('H093', O, '아이패드 미니 7 128GB', [IPAD, MINI, r('미니\\s*7|mini\\s*7|a17|7\\s*세대')], [r('a15|6\\s*세대')], { cap: 128 }),
  main('H094', O, '10만원 이하 기계식 키보드', [r('키보드|keyboard'), r('기계식|mechanical|축')], [r('키캡\\s*(?:세트|단품)')], { max: 100000 }),
  main('H095', O, '화이트 갤럭시 버즈3', [r('버즈\\s*3|buds\\s*3'), r('화이트|white')], [r('프로|pro|실버(?!.*화이트)')], { accOk: r('충전\\s*케이스') }),

  // ── 대화형 후속 질문 (10) ──
  fu('H096', '갤럭시 S25 울트라', '512GB는?', { kind: 'main', m: [GALAXY, r('s25'), ULTRA], x: [], cap: 512 }),
  fu('H097', '블루투스 스피커', '마샬 제품으로 보여줘', { kind: 'main', m: [r('마샬|marshall')], x: [r('jbl|보스|bose|소니|sony')] }),
  fu('H098', '무선청소기', '다이슨은 빼고', { kind: 'main', m: [r('청소기|vacuum')], x: [r('다이슨|dyson|로봇')], accOk: r('헤드|브러시|노즐|툴|필터') }),
  fu('H099', '아이폰 15', '프로 맥스로', { kind: 'main', m: [IPHONE, r('15'), r('프로\\s*맥스|pro\\s*max|프로맥스|promax')], x: [] }),
  fu('H100', '노트북', '100만원 이하만', { kind: 'main', m: [LAPTOP, LAPTOP_SPEC], x: [], max: 1000000 }),
  fu('H101', '에어팟', '프로 2세대로', { kind: 'main', m: [r('에어팟|airpods'), r('(?:프로|pro)\\s*\\(?\\s*2|2\\s*세대')], x: [r('(?:프로|pro)\\s*3|맥스|max')], accOk: r('충전\\s*케이스|magsafe|맥세이프') }),
  fu('H102', '가습기', '초음파식으로', { kind: 'main', m: [r('가습기|humidifier'), r('초음파|ultrasonic')], x: [r('가열식(?!.*초음파)')] }),
  fu('H103', '패딩', '여성용 숏패딩으로', { kind: 'main', m: [r('패딩|다운|padding|puffer'), r('숏|short|크롭'), r('여성|여자|우먼|women')], x: [r('롱\\s*패딩|남성(?!.*여성)')] }),
  fu('H104', '무선 마우스', '저소음 제품만', { kind: 'main', m: [r('마우스|mouse'), r('저소음|무소음|silent|사일런트|조용')], x: [r('마우스\\s*패드')] }),
  fu('H105', '갤럭시 워치7', '40mm로', { kind: 'main', m: [r('워치\\s*7|watch\\s*7'), r('40\\s*mm')], x: [r('44\\s*mm(?!.*40)|스트랩|밴드\\s*(?:교체|단품)|필름|케이스')] }),

  // ── 추가 (5): 범주 균형 보강 ──
  main('H106', E, '삼성 비스포크 냉장고 4도어', [r('비스포크|bespoke'), r('냉장고|refrigerator'), r('4\\s*도어|4door|4도어')], [r('패널\\s*단품|정리|수납')]),
  main('H107', V, '규조토 발매트', [r('규조토|diatom'), r('매트|mat|발판')], [], { accAllow: r('매트|mat') }),
  main('H108', F, '패딩 조끼', [r('패딩|다운|padding|puffer'), r('조끼|베스트|vest')], [r('세탁')]),
  main('H109', A, 'JBL 플립 6', [r('jbl'), r('플립\\s*6|flip\\s*6')], [r('플립\\s*[45]|flip\\s*[45]|플립\\s*7|flip\\s*7|케이스|파우치')]),
  main('H110', P, '갤럭시 S25 엣지', [GALAXY, r('s25'), r('엣지|edge')], [r('울트라|ultra|플러스|plus')])
];
