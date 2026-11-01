'use strict';
const assert=require('node:assert/strict');
const C=require('../api/_ai-comparison');
const AIID=require('../api/_aiidentity');
const bad=[
  '[해외] 삼성 갤럭시 탭 A 8.0 T380 T385 터치 스크린 SM T380 SM-T385용 8인치 유리',
  '갤럭시탭 S9 FE 보호 필름 2매',
  '갤럭시 탭 S10 터치 패널 교체용 부품',
  'Galaxy Tab S9 replacement screen glass',
  '아이패드 에어 11 액정 교체 부품',
  'iPad mini LCD screen replacement',
  // Titles seen in the actual 2026-11-01 Production /api/search payload:
  '삼성 정품 갤럭시 탭S11 울트라 프로 키보드 터치패드 DeX키 EF-DX935',
  '라이노핏/(갤럭시탭 S11) 클리어쉴드 북커버 케이스/모바일 액세서리 태블릿케이스',
  '갤럭시탭 액티브5 프로 10.1 슈페리어 저반사 액정보호필름',
  '미국구매 노트북 케이스 아이패드, 갤럭시탭 등',
  '[보리보리] 아트박스 POOM 아트박스/삼성전자 삼성 갤럭시탭S10+ S9+ AI 키보드 북커버 케이스 EF-DX825',
  '굿노트 깍두기 색칠 가계부 아이패드 가로형 PDF',
  '왕초보 아이패드 수채화를 기초부터 탄탄하게 배우기',
  '뉴욕: 아이패드와 크리스마스 영화와 함께하는 크리스마스 투어 | 미국',
  '굿노트 데일리 플래너 5컬러 세트 _아이패드 굿노트 속지',
  '[서울/서초] 아이패드 드로잉 원데이 클래스',
  'JAMJAKE 아이패드 호환 무선충전 스타일러스 펜슬 P11pro',
  '갤럭시탭 아이패드 태블릿 파우치 가방 11인치 방수',
  'iPad Pro 11 M4 digital planner PDF template',
  '아이패드 기초 입문 교재 2026',
  'iPad mini 2026용 충전 케이블',
  '아이패드 전용 애플펜슬 수납 홀더'
];
const good=[
  '삼성전자 갤럭시탭 S9 FE 128GB Wi-Fi 태블릿',
  '삼성 갤럭시 탭 A 8.0 32GB WiFi 태블릿 본체',
  'Apple 2025 아이패드 (A16 모델) 128GB Wi-Fi',
  'Apple iPad Air 11 M3 256GB Wi-Fi 태블릿',
  '삼성 갤럭시탭 S10 FE 128GB 터치스크린 지원 태블릿',
  '삼성 갤럭시탭A6 10.1 With s-pen 태블릿PC SM-P580 화이트 32GB Wi-Fi',
  '삼성전자 갤럭시탭 A9 플러스 태블릿PC',
  '갤럭시 탭 A11+_WIFI_128GB_그레이 - [SM-X230NZALKOO]',
  'Apple 2026 아이패드 에어 11(M4 모델)',
  'Apple 2025 아이패드 프로 11(M5 모델) 스탠다드 글래스',
  '아이패드 에어 11 M4 Wi-Fi 128GB 스타라이트',
  '[APPLE] 애플 아이패드 7세대 공기계 [A2197]',
  '삼성전자 갤럭시탭 S10 FE',
  '삼성전자 갤럭시 탭 A8 WiFi전용 64GB SM-X200'
];
for(const title of bad)assert.equal(C.isComparableOffer(/아이패드|ipad/i.test(title)?'아이패드':'갤럭시탭',title),false,title);
for(const title of good)assert.equal(C.isComparableOffer(/아이패드|ipad/i.test(title)?'아이패드':'갤럭시탭',title),true,title);
const mk=(title,price,id)=>({title,lprice:price,productId:id,mall:'ADPICK',isCoupang:false,link:'https://merchant.example/'+id});
const normalize=x=>({...x,price:x.lprice,mallId:x.mall});
const polluted=[
 mk(bad[0],15700,'GLASS'),mk(good[0],429000,'TABLET'),
 mk('갤럭시탭 S9 케이스',9900,'CASE')
];
const ipadPolluted=[
 mk('굿노트 깍두기 색칠 가계부 아이패드 가로형 PDF',13000,'PDF'),
 mk('왕초보 아이패드 수채화를 기초부터 탄탄하게 배우기',75900,'CLASS'),
 mk('뉴욕: 아이패드와 크리스마스 영화와 함께하는 크리스마스 투어 | 미국',50669,'TOUR'),
 mk('Apple 2025 아이패드 (A16 모델)',621300,'IPAD-DEVICE')
];
const ipadSelected=C.pickExact(ipadPolluted,'아이패드',AIID,normalize);
assert.equal(ipadSelected?.productId,'IPAD-DEVICE','real iPad must beat lower-priced digital content');
assert.equal(C.pickExact(ipadPolluted.slice(0,3),'아이패드',AIID,normalize),null,'no genuine device means no comparable iPad');

const selected=C.pickExact(polluted,'갤럭시탭',AIID,normalize);
assert.equal(selected&&selected.productId,'TABLET','real device must be selected ahead of cheap glass');
assert.equal(C.pickExact([polluted[0]],'갤럭시탭',AIID,normalize),null,'glass-only must return no confirmed tablet');
assert.equal(C.pickExact([mk(good[2],621300,'IPAD')],'아이패드',AIID,normalize)?.productId,'IPAD');
const broadText=C.formatComparison(['아이패드','갤럭시탭'],[
  {title:good[2],price:621300,mall:'쿠팡'},
  {title:good[0],price:429000,mall:'쿠팡'}],'search',{});
assert.match(broadText,/동급 모델|동급 사양/);
assert.match(broadText,/가성비가 높다고 단정할 수 없어요/);
assert.doesNotMatch(broadText,/선택 기준: 가격을 우선하면/);
const exactText=C.formatComparison(['아이패드 에어 M3','갤럭시탭 S9 FE'],[
  {title:good[3],price:699000,mall:'쿠팡'},
  {title:good[0],price:429000,mall:'쿠팡'}],'search',{});
assert.match(exactText,/선택 기준: 가격을 우선하면/);
const namesA=[
 mk('Apple 아이패드 7세대 공기계 A2197',114374,'IPAD7'),
 mk('Apple 2025 아이패드 (A16 모델) 128GB',621300,'IPAD16'),
 mk('Apple 2026 아이패드 에어 11(M4 모델)',1071600,'IPAD-M4'),
 mk('아이패드 A16 월 59,000원 24개월 렌탈',59000,'RENT')
];
const namesB=[
 mk('삼성 갤럭시탭 A6 태블릿PC SM-P580',89000,'TAB-A6'),
 mk('삼성 갤럭시 탭 S10 FE 태블릿 8GB SM-X520',588050,'TAB-S10'),
 mk('삼성 갤럭시탭 S11 Wi-Fi 128GB SM-X730',1066030,'TAB-S11'),
 mk('갤럭시탭 S10 계약금 10,000원',10000,'DEPOSIT')
];
const aligned=C.pickAlignedPair([namesA,namesB],['아이패드','갤럭시탭'],AIID,normalize);
assert.ok(aligned,'broad pair present');
assert.equal(aligned[0].productId,'IPAD16','prefer aligned midrange over unrelated old or flagship');
assert.equal(aligned[1].productId,'TAB-S10','choose comparable price/condition candidate');
assert.equal(C.pickAlignedPair([namesA,namesB],['아이패드 A16','갤럭시탭 S10 FE'],AIID,normalize),null,'explicit model selection is unchanged');
assert.equal(C.isCashPriceListing('갤럭시탭 S10 월 59,000원 24개월'),false);
assert.equal(C.isCashPriceListing('갤럭시탭 S10 예약금 19,000원'),false);
assert.equal(C.isCashPriceListing('갤럭시탭 S10 FE 무이자 할부 가능 정품'),true);
const broadSelectionText=C.formatComparison(['아이패드','갤럭시탭'],aligned,'search',{});
assert.match(broadSelectionText,/최종 결제가가 아니며/);
const offers=[
 mk('삼성전자 갤럭시 탭 S10 FE 태블릿 10.9인치 아랍어 버전 8GB SM-X520',588050,'ARABIC'),
 mk('[예약판매]삼성전자 갤럭시탭 S10 FE WiFi SM-X520',695520,'PREORDER'),
 mk('삼성 갤럭시탭 S10 FE 태블릿 SM-X520 128GB Wi-Fi',650000,'ORDINARY')
];
assert.equal(C.pickExact(offers,'갤럭시탭 S10 FE',AIID,normalize)?.productId,'ORDINARY','normal distribution listing preferred over cheaper Arabic-version');
assert.equal(C.pickExact(offers.slice(0,2),'갤럭시탭 S10 FE',AIID,normalize)?.productId,'ARABIC','never invent standard distribution if no normal titles');
const warning=C.formatComparison(['아이패드 A16','갤럭시탭 S10 FE'],[
 {title:'Apple 2025 아이패드 (A16 모델)',price:621300,mall:'쿠팡'},
 {title:offers[0].title,price:588050,mall:'쿠팡'}],'search',{});
assert.match(warning,/아랍어 버전/);
assert.match(warning,/A\/S/);
const preorder=C.formatComparison(['아이패드','갤럭시탭'],[
 {title:'Apple 2025 아이패드 (A16 모델)',price:621300,mall:'쿠팡'},
 {title:offers[1].title,price:695520,mall:'11번가'}],'search',{});
assert.match(preorder,/예약판매 상품/);
assert.equal(C.offerTerms('갤럭시탭 S10 FE WiFi SM-X520').overseas,false);
assert.equal(C.offerTerms('갤럭시탭 S10 FE 아랍어 버전 8GB').overseas,true);
assert.equal(C.offerTerms('예약판매 갤럭시탭 S11').preorder,true);
assert.equal(C.offerTerms('갤럭시탭 S11 중고').used,true);
console.log('AI_TABLET_SALEABLE_COMPARISON '+JSON.stringify({pass:bad.length+good.length+25,fail:0,realGptCalls:0,realMerchantCalls:0,dbWrites:0}));
