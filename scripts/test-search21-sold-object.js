'use strict';
const assert=require('node:assert/strict');
const {getIntent,relation}=require('../api/_search2-object-relation');
const {rerank}=require('../api/_search21');
let count=0;
function test(name,fn){fn();count++;console.log('PASS',name)}
const cases=[
 // Main product requests must not be replaced by accessories/other kinds.
 ['맥북 에어 M4','애플 맥북에어 M4 RAM 16GB SSD 512GB','target'],
 ['맥북 에어 M4','맥북에어15 M4 M5 ARAG 고화질 저반사 1매 외부3종','other_object'],
 ['맥북 에어 M4','맥북 에어 M4 전용 액정보호필름','other_object'],
 ['맥북 에어 M4','맥북 에어 13인치용 케이스 M5 M4 M3 M2','other_object'],
 ['맥북 에어 M4','애플 맥북 에어 M4 RAM 16GB 13.6인치 리퍼 노트북','target'],
 ['커피머신','[국내도서] 커피머신 첫걸음','non_product'],
 ['커피머신','데롱기 ECAM 커피 머신 전 제품에 사용할 수 있는 물탱크 덮개 액세서리','other_object'],
 ['커피머신','필립스 라떼 클래식 1200 전자동 커피 머신 EP1220/19','target'],
 ['타이어','공기돌이 타이어 공기압 주입기 K-110 plus','other_object'],
 ['타이어','금호타이어 솔루스 TA21 195/65R15','target'],
 ['타이어','차오양 H457 미니 샤크 700X25C 로드 타이어','target'],
 ['아이패드','뉴욕: 아이패드와 크리스마스 영화와 함께하는 크리스마스 투어 | 미국','non_product'],
 ['아이패드','굿노트 데일리 플래너 5컬러 세트 _아이패드 굿노트 속지','non_product'],
 ['아이패드','[국내도서] 30일 완성 아이패드 드로잉 with 프로크리에이트','non_product'],
 ['아이패드','Apple 2026 아이패드 에어 11(M4 모델)','target'],
 ['아이패드','애플 아이패드 에어 11 M4 WiFi 128GB 스페이스 그레이 MH304KH/A','target'],
 ['아이패드','아이패드 프로 13인치 Wi-Fi 256GB','target'],
 ['아이패드','[국내도서] 30일 완성 아이패드 드로잉 with 프로크리에이트','non_product'],
 ['모니터','디월스 이지바 모니터 램프 JDA1 노트북 조명','other_object'],
 ['모니터','[LG] 울트라기어 32GS60QC 모니터','target'],
 ['보조배터리','4G LTE 무제한 WiFi 일본 공항 수령 무료 보조배터리 포함','non_product'],
 ['보조배터리','보바 22.5W 휴대용 보조배터리 20000mAh','target'],
 ['노트북','26 FW 조절식 스트랩 노트북 가방 M0014','other_object'],
 ['노트북','HP 2026 노트북 14 코어i5 256GB 16GB','target'],
 ['무선 이어폰','이어폰 실리콘 케이스 호환','other_object'],
 ['무선 이어폰','충전 케이스 탑재 블루투스 무선 이어폰','target'],
 ['아이패드 케이스','아이패드 에어 M4 케이스 증정 본품 128GB WiFi','other_object'],
 ['로봇청소기','로봇청소기 먼지 필터 내장 자동세척','target'],
 ['커피머신','필립스 커피머신 필터 내장 1200','target'],
 ['노트북','[해외] LG GRAM 14T990 냉각 팬 노트북 교체 부품','other_object'],
 ['무선 이어폰','KONLI 노이즈 캔슬링 무선 블루투스 이어폰','target'],
 ['로봇청소기','로보락 로봇청소기 Q8 MAX Pro Plus','target'],
 ['키보드','로지텍 USB 유선 일반형 키보드','target'],
 ['키보드','키보드 키스킨 실리콘 커버','other_object'],
 ['스마트워치','가민 포러너 970 블랙 러닝 GPS 스마트워치','target'],
 ['스마트워치','애플워치 스트랩 밴드','other_object'],
 ['블루투스 스피커','마샬 액톤3 블루투스 스피커','target'],
 ['블루투스 스피커','JBL 뮤직 골드 브릭 GO5 휴대용 스피커, 분위기 있는 조명 효과, 무선 블루투스 미니 스피커','target'],
 ['블루투스 스피커','PLEIGO 우주인 조명 블루투스 스피커, 아이보리, BS71','target'],
 ['모니터','컴퓨터 모니터 전용 조명 램프','other_object'],
 ['에어프라이어','필립스 2000 시리즈 에어프라이어 4.2L','target'],
 ['에어프라이어','에어프라이어 커피머신 선반','other_object'],
 ['샴푸 리필','케라시스 클린노트 샴푸 리필 퓨어 코튼','target'],
 ['샴푸 리필','리필라제 모이스처 샴푸 4.2L','target'],
 ['세탁세제','리큐 세탁세제 드럼 겸용 4.5L','target'],
 // Explicit accessory queries must stay accessories, not all become "bad".
 ['아이패드 케이스','아이드 아이패드 클리어아머 펜슬 수납 케이스','target'],
 ['아이패드 케이스','Apple 2026 아이패드 에어 11(M4 모델)','unknown'],
 ['애플워치 스트랩','투에이비 애플워치 호환 가죽 슬림 스트랩','target'],
 ['노트북 파우치','루미노라 노트북 파우치','target'],
 ['에어프라이어 선반','HK.SELL W36 에어프라이어 커피머신 선반','target']
];
for(const [q,title,expected]of cases)test(q+' → '+title.slice(0,42),()=>{
  assert.equal(relation(q,title).grade,expected,JSON.stringify({q,title,evidence:relation(q,title)}))
});
test('Explicit accessory query is detected',()=>{
 assert.equal(getIntent('아이패드 케이스').desired,'case');
 assert.equal(getIntent('노트북 파우치').desired,'pouch');
 assert.equal(getIntent('애플워치 스트랩').desired,'strap');
});
test('Consumable refills do not get accessory penalty',()=>assert.equal(getIntent('샴푸 리필').category,'main'));
function title(q,title,relevance=1){return {id:q,title,relevance,lprice:5000,link:'https://example.invalid/'+q}};
test('Same-query main beats wrong-accessory even when legacy score lower',()=>{
 const p=[title('film','맥북에어15 M4 M5 저반사 보호필름',1),
 title('main','맥북에어 15 M4 RAM 16GB SSD 512GB',.55)];
 const r=rerank('맥북 에어 M4',p);assert.equal(r.items[0].id,'main');
 assert.equal(r.items[1].id,'film');
});
test('Book and service drop below relevant physical products',()=>{
 const p=[title('book','[국내도서] 커피머신 첫걸음',1),
 title('machine','필립스 라떼 1200 전자동 커피 머신',.45)];
 assert.equal(rerank('커피머신',p).items[0].id,'machine');
});
test('Monitor lamp drops behind actual monitor',()=>{
 const p=[title('lamp','디월스 이지바 모니터 램프',1),
 title('monitor','스카이뷰 120Hz 24인치 게이밍 모니터',.6)];
 assert.equal(rerank('모니터',p).items[0].id,'monitor');
});
test('Wifi rental with included power bank drops behind actual battery',()=>{
 const p=[title('rental','4G LTE 무제한 WiFi 공항 수령 무료 보조배터리 포함',1),
 title('bank','보바 20000mAh 보조배터리',.4)];
 assert.equal(rerank('보조배터리',p).items[0].id,'bank');
});
test('Requesting a case should promote actual case above a bare tablet',()=>{
 const p=[title('tablet','아이패드 에어 M4',1),
 title('case','아이패드 에어 M4 케이스',.3)];
 assert.equal(rerank('아이패드 케이스',p).items[0].id,'case');
});
test('Bundled charging case is not treated as sold case',()=>{
 const p=[title('case','이어폰 실리콘 케이스',1),
 title('earbuds','충전 케이스 탑재 블루투스 무선 이어폰',.3)];
 assert.equal(rerank('무선 이어폰',p).items[0].id,'earbuds');
});
test('Never mutate / delete / rewrite price or link',()=>{
 const p=[title('unrelated','스마트폰 케이스',1),title('main','삼성 노트북',.7),title('other','커피 원두',.3)];
 const before=JSON.stringify(p),r=rerank('노트북',p);
 assert.equal(JSON.stringify(p),before);
 assert.equal(r.items.length,p.length);
 assert.deepEqual(new Set(r.items),new Set(p));
 assert(r.items.every(x=>x.link===p.find(z=>z===x).link));
});
test('If same-type main missing, do not force a new category order',()=>{
 const p=[title('film','모니터 보호필름',.4),title('lamp','모니터 조명 램프',.7)];
 const r=rerank('모니터',p);assert(!r.applied);
 assert.deepEqual(r.items,p);
});
test('Unknown category uses existing Search2 safely',()=>{
 const p=[title('x','차량 와이퍼',.8),title('y','차량용 바닥 매트',.7)];
 const r=rerank('자동차 용품',p);
 assert(r.reason.startsWith('unknown_intent_'));
 assert.deepEqual(new Set(r.items),new Set(p));
});
test('Empty/oversize candidates handled',()=>{
 assert.deepEqual(rerank('노트북',[]).items,[]);
 assert.throws(()=>rerank('노트북',new Array(76).fill(title('a','노트북'))),/cap/);
});
test('No external fetch, DB, or product mutation',()=>{
 const orig=global.fetch;global.fetch=()=>{throw Error('No external IO')};
 try{assert.equal(rerank('타이어',[title('pump','타이어 공기압 주입기'),title('tire','타이어 195/65R15')]).items[0].id,'tire');}
 finally{global.fetch=orig}
});
console.log('SEARCH21_OBJECT:',count+'/'+count,'PASS');
