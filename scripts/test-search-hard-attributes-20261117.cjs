'use strict';
// Offline attribute contract: contradictions and sold replacement components are
// excluded from both displayed search cards and saveProducts' product catalog.
const assert=require('node:assert/strict');
const Gate=require('../api/_product-gate');
let total=0;
const cases=[
  ['쿠쿠 6인용 전기밥솥','쿠쿠 6인용 전기밥솥',true,270000],
  ['쿠쿠 6인용 전기밥솥','쿠쿠 6인용 전기밥솥 내솥',false,40000],
  ['키친아트 28cm 프라이팬','키친아트 28cm 프라이팬',true,35000],
  ['키친아트 28cm 프라이팬','키친아트 24cm 프라이팬',false,25000],
  ['키친아트 28cm 프라이팬','키친아트 프라이팬 뚜껑',false,10000],
  ['락앤락 1.7L 밀폐용기','락앤락 1.7L 밀폐용기',true,23000],
  ['락앤락 1.7L 밀폐용기','락앤락 1.0L 밀폐용기',false,20000],
  ['락앤락 1.7L 밀폐용기','락앤락 밀폐용기 뚜껑 단품',false,8000],
  ['락앤락 1.7L 밀폐용기','락앤락 밀폐용기 뚜껑 호환 제품',false,8000],
  ['샤오미 20000mAh 보조배터리','샤오미 20000mAh 보조배터리',true,34000],
  ['샤오미 20000mAh 보조배터리','샤오미 10000mAh 보조배터리',false,28000],
  ['샤오미 20000mAh 보조배터리','샤오미 보조배터리 충전 케이블',false,6500],
  ['나이키 기모 후드티 XL','나이키 기모 후드티 XL',true,99000],
  ['나이키 기모 후드티 XL','나이키 기모 후드티 L',false,80000],
  ['아디다스 러닝화 270mm','아디다스 러닝화 270mm',true,110000],
  ['아디다스 러닝화 270mm','아디다스 러닝화 260mm',false,100000],
  ['이케아 퀸 침대 프레임','이케아 퀸 침대 프레임',true,420000],
  ['이케아 퀸 침대 프레임','이케아 싱글 침대 프레임',false,340000],
  ['테팔 프라이팬 본품을 사고 싶어. 사은품이 같이 와도 돼','테팔 프라이팬 본품 + 손잡이 증정',true,80000],
  ['테팔 프라이팬 본품을 사고 싶어. 사은품이 같이 와도 돼','테팔 프라이팬 손잡이 단품',false,12000]
];
for(const [q,title,expected,price] of cases){
  const spec=Gate.parseQuery(q,{titles:[title]});
  const r=Gate.judge(spec,{title,lprice:price});
  assert.equal(r.ok,expected,JSON.stringify({q,title,hard:r.hard,soft:r.soft,spec:{wantsAccessory:spec.wantsAccessory,head:spec.head,measures:spec.measures,apparelSize:spec.apparelSize,beddingSize:spec.beddingSize}}));
  if(!expected){
    const save=Gate.saveFilter(q,[{title,lprice:price,productId:'offline-fixture'}]);
    assert.equal(save.save.length,0,'mismatched product must never be saved: '+title);
  }
  total++;
}
const accessoryIntent=Gate.parseQuery('쿠쿠 6인용 전기밥솥 내솥');
assert.equal(accessoryIntent.wantsAccessory,true,'explicit inner pot accessory search must remain possible');total++;
for(const name of ['락앤락 1.7L 밀폐용기','샤오미 20000mAh 보조배터리']){
  const parsed=Gate.parseQuery(name);
  assert.equal(parsed.wantsAccessory,false, 'compound main category incorrectly treated as accessory: '+name);
  total++;
}
for(const [query,requested,unwanted] of [
 ['락앤락 밀폐용기 뚜껑만 구매할래','락앤락 밀폐용기 뚜껑 정품','락앤락 1.7L 밀폐용기 본품'],
 ['샤오미 보조배터리 충전 케이블만 구매할래','샤오미 보조배터리 충전 케이블 정품','샤오미 20000mAh 보조배터리 본품'],
 ['이케아 침대 매트리스 커버만 구매할래','이케아 침대 매트리스 커버 정품','삼성전자 침대 프레임 케이스']
]){
 const parsed=Gate.parseQuery(query,{titles:[requested,unwanted]});
 assert.equal(parsed.wantsAccessory,true,'requested accessory not identified: '+query);
 const good=Gate.judge(parsed,{title:requested,lprice:20000});
 const bad=Gate.judge(parsed,{title:unwanted,lprice:20000});
 assert.equal(good.ok,true,JSON.stringify({query,hard:good.hard}));
 assert.equal(bad.ok,false,JSON.stringify({query,bad:bad.hard}));
 const saved=Gate.saveFilter(query,[{title:unwanted,lprice:20000}]);
 assert.equal(saved.save.length,0,'unrelated accessory saved: '+unwanted);
 total+=3;
}
console.log('SEARCH_HARD_ATTRIBUTE_GUARDS '+total+' PASS');
