'use strict';
// AI v3.2 brand + product-line lexicon (dependency-free so intent, taxonomy
// and retrieval can all use it without circular requires).
//
// [canonical name, company aliases, { product-line alias: [categories] }]
// A COMPANY alias is always brand evidence. A product-LINE alias ("아이패드",
// "갤럭시", "그램") is brand evidence only inside its own categories: in a
// keyboard request "아이패드" names the host device, not the keyboard maker.
const ALL = ['스마트폰', '태블릿', '이어폰', '시계', '노트북'];
const BRANDS = [
  ['삼성', ['삼성', 'Samsung'], { '갤럭시': ALL, 'Galaxy': ALL }],
  ['애플', ['애플', 'Apple'], { '아이폰': ['스마트폰'], 'iPhone': ['스마트폰'], '아이패드': ['태블릿'], 'iPad': ['태블릿'],
    '맥북': ['노트북'], 'MacBook': ['노트북'], '에어팟': ['이어폰'], 'AirPods': ['이어폰'], '애플워치': ['시계'] }],
  ['LG', ['LG', '엘지'], { '그램': ['노트북'], '퓨리케어': ['공기청정기'], '울트라기어': ['모니터'], '울트라와이드': ['모니터'] }],
  ['소니', ['소니', 'SONY'], {}], ['로지텍', ['로지텍', 'Logitech'], {}],
  ['씨게이트', ['씨게이트', 'Seagate'], {}],
  ['WD', ['WD', 'Western Digital', '웨스턴디지털', '웨스턴 디지털'], { 'My Passport': ['외장하드'], '마이패스포트': ['외장하드'] }],
  ['샌디스크', ['샌디스크', 'SanDisk'], {}], ['젠하이저', ['젠하이저', 'Sennheiser'], {}], ['브리츠', ['브리츠', 'Britz'], {}],
  ['JBL', ['JBL', '제이비엘'], {}],
  ['샤오미', ['샤오미', 'Xiaomi'], { '레드미': ['스마트폰', '태블릿', '시계', '이어폰'], 'Redmi': ['스마트폰', '태블릿', '시계', '이어폰'],
    '미지아': ['공기청정기', '청소기'], 'Mijia': ['공기청정기', '청소기'], '포코': ['스마트폰'], 'POCO': ['스마트폰'] }],
  ['레노버', ['레노버', 'Lenovo'], {}], ['로보락', ['로보락', 'Roborock'], {}], ['보스', ['보스', 'BOSE'], {}], ['다이슨', ['다이슨', 'Dyson'], {}],
  ['블루에어', ['블루에어', 'Blueair'], {}], ['ASUS', ['ASUS', '에이수스', '아수스'], {}], ['HP', ['HP', '에이치피'], {}],
  ['델', ['델', 'Dell'], {}], ['에이서', ['에이서', 'Acer'], {}], ['MSI', ['MSI'], {}], ['마샬', ['마샬', 'Marshall'], {}],
  ['쿠쿠', ['쿠쿠', 'Cuckoo'], {}], ['위닉스', ['위닉스', 'Winix'], {}], ['필립스', ['필립스', 'Philips'], {}],
  ['구글', ['구글', 'Google'], { '픽셀': ['스마트폰'], 'Pixel': ['스마트폰'] }], ['도시바', ['도시바', 'Toshiba'], {}],
  ['트랜센드', ['트랜센드', 'Transcend'], {}], ['앤커', ['앤커', 'Anker'], { '사운드코어': ['스피커', '이어폰'], 'Soundcore': ['스피커', '이어폰'] }],
  ['마이크로소프트', ['마이크로소프트', 'Microsoft'], { '서피스': ['노트북', '태블릿'], 'Surface': ['노트북', '태블릿'] }],
  ['커세어', ['커세어', 'Corsair'], {}], ['스틸시리즈', ['스틸시리즈', 'SteelSeries'], {}], ['에디파이어', ['에디파이어', 'Edifier'], {}],
  ['캔스톤', ['캔스톤', 'Canston'], {}], ['앱코', ['앱코', 'ABKO'], {}], ['한성', ['한성', 'Hansung'], {}], ['아이리버', ['아이리버', 'iriver'], {}],
  ['오디오테크니카', ['오디오테크니카', 'Audio-Technica'], {}], ['AKG', ['AKG'], {}], ['슈어', ['슈어', 'Shure'], {}],
  ['펜더', ['펜더', 'Fender'], {}], ['깁슨', ['깁슨', 'Gibson'], {}], ['야마하', ['야마하', 'Yamaha'], {}], ['콜트', ['콜트', 'Cort'], {}],
  ['아이바네즈', ['아이바네즈', 'Ibanez'], {}], ['에피폰', ['에피폰', 'Epiphone'], {}], ['아리아', ['아리아', 'Aria'], {}],
  ['가민', ['가민', 'Garmin'], {}], ['어메이즈핏', ['어메이즈핏', 'Amazfit'], {}], ['화웨이', ['화웨이', 'Huawei'], {}], ['핏빗', ['핏빗', 'Fitbit'], {}],
  ['에브리봇', ['에브리봇', 'Everybot'], {}], ['드리미', ['드리미', 'Dreame'], {}], ['에코백스', ['에코백스', 'Ecovacs'], {}],
  ['코웨이', ['코웨이', 'Coway'], {}], ['벤큐', ['벤큐', 'BenQ'], {}], ['QCY', ['QCY'], {}], ['비츠', ['비츠', 'Beats'], {}],
  ['뱅앤올룹슨', ['뱅앤올룹슨', 'B&O', 'Bang & Olufsen'], {}], ['낫싱', ['낫싱', 'Nothing'], {}]
];
// Model LINES whose name the listing must carry when the user names them
// ("ASUS 비보북" ≠ any ASUS laptop, "삼성 오디세이" ≠ any Samsung monitor).
const LINES = [
  ['비보북', 'vivobook'], ['젠북', 'zenbook'], ['아이디어패드', 'ideapad'], ['씽크패드', 'thinkpad'], ['요가', 'yoga'],
  ['오디세이', 'odyssey'], ['울트라기어', 'ultragear'], ['뷰피니티', 'viewfinity'], ['블루스카이', 'bluesky'],
  ['퓨리케어', 'puricare'], ['비스포크', 'bespoke'], ['제트', 'jet'], ['큐레보', 'qrevo'], ['사운드링크', 'soundlink'],
  ['인스퓨어', 'inspure'], ['에어로미니', 'aeromini'], ['에어로타워', 'aerotower'], ['캔비오', 'canvio'], ['익스팬션', 'expansion'],
  ['엘리먼츠', 'elements'], ['마이패스포트', 'mypassport'], ['원터치', 'onetouch'], ['갤럭시북', 'galaxybook'],
  ['그램', 'gram'], ['인스피론', 'inspiron'], ['파빌리온', 'pavilion'], ['크롬북', 'chromebook'], ['엑스페리아', 'xperia']
];
// Boundary-aware: "보스" must not match "보노보스", "HP" must not match
// "SHP9500", a one-syllable "델" must not match "모델".
function aliasRegex(alias) {
  const a = String(alias).normalize('NFKC');
  const esc = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
  if (/^[a-z0-9&\s-]+$/i.test(a)) return new RegExp('(?<![a-z0-9])' + esc + '(?![a-z])', 'i');
  return new RegExp('(?<![가-힣0-9])' + esc + (a.length <= 1 ? '(?![가-힣])' : ''), 'i');
}
function aliasesFor(entry, category) {
  const [, company, lines] = entry;
  const lineAliases = Object.entries(lines || {})
    .filter(([, cats]) => !category || cats.includes(category)).map(([alias]) => alias);
  return [...company, ...(category ? lineAliases : [])];
}
const BRAND_RE = BRANDS.map(entry => [entry[0], entry, null]);
function brandOfWord(word) {
  const w = String(word || '').normalize('NFKC').trim().toLowerCase();
  for (const entry of BRANDS)
    if ([...entry[1], ...Object.keys(entry[2] || {})].some(a => a.toLowerCase() === w)) return entry[0];
  return null;
}
module.exports = { BRANDS, BRAND_RE, LINES, aliasRegex, aliasesFor, brandOfWord };
