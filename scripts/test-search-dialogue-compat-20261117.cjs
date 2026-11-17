'use strict';
// Preserve true merchandise/model constraints while removing buyer instructions.
// Fully offline: no supplier/AI calls and no production DB writes.
const assert = require('node:assert/strict');
const Gate = require('../api/_product-gate');
let count=0;
const queryCases=[
  {q:'HP 오피스젯 프로 9010e 복합기 430500원 이하만 검색해줘',
   actual:'HP 오피스젯 프로 9010e 복합기',other:'HP 오피스젯 프로 8025e 복합기',price:350000,
   removed:['검색','해줘']},
  {q:'브라더 HL-L2370DN 레이저 프린터 그대로, 모델 바뀐 건 빼줘',
   actual:'브라더 HL-L2370DN 레이저 프린터',other:'브라더 HL-L2350DW 레이저 프린터',price:190000,
   removed:['그대로','바뀐','건']},
  {q:'후지필름 X-S20 미러리스 카메라 그대로, 모델 바뀐 건 빼줘',
   actual:'후지필름 X-S20 미러리스 카메라',other:'후지필름 X-S10 미러리스 카메라',price:1900000,
   removed:['그대로','바뀐','건']},
  {q:'한샘 샘키즈 1305 수납장 본품에 구성품이 따라오는 건 상관 없어',
   actual:'한샘 샘키즈 1305 수납장 본품',other:'한샘 샘키즈 1303 수납장 본품',price:230000,
   removed:['구성품','상관','따라오는','건']},
  {q:'로지텍 마우스 살 건데 삼성 브랜드는 절대 제외하고 보여줘',
   actual:'로지텍 게이밍 마우스',other:'삼성 게이밍 마우스',price:45000,
   removed:['건데','절대','제외']},
  {q:'테팔 BL1B1 믹서기 63900원 이하만 검색해줘',
   actual:'테팔 BL1B1 믹서기',other:'테팔 BL435 믹서기',price:52000,
   removed:['검색','해줘']}
];
for (const e of queryCases){
 const p=Gate.parseQuery(e.q,{titles:[e.actual,e.other]});
 const residue=e.removed.filter(w=>p.idText.includes(w));
 assert.equal(residue.length,0,JSON.stringify({q:e.q,idText:p.idText,residue,head:p.head}));
 count++;
 const okay=Gate.judge(p,{title:e.actual,lprice:e.price});
 assert.equal(okay.ok,true,JSON.stringify({q:e.q,idText:p.idText,hard:okay.hard,soft:okay.soft}));
 count++;
 const no=Gate.judge(p,{title:e.other,lprice:e.price});
 assert.equal(no.ok,false,JSON.stringify({q:e.q,idText:p.idText,hard:no.hard}));
 count++;
}
const accessoryCases=[
 ['HP 오피스젯 프로 9010e 복합기에 쓸 잉크 카트리지만 구매하고 싶어',
  'HP 오피스젯 프로 9010e용 잉크 카트리지 정품','HP 오피스젯 프로 9010e 복합기'],
 ['엡손 EB-X49 빔프로젝터에 쓸 리모컨만 구매하고 싶어',
  '엡손 EB-X49용 리모컨 정품','엡손 EB-X49 빔프로젝터'],
 ['시놀로지 DS224+용 하드디스크 트레이 찾는 중이야. 본품은 말고',
  '시놀로지 DS224+용 하드디스크 트레이 정품','시놀로지 DS224+ NAS 본품'],
 ['테팔 BL1B1용 믹서컵 찾는 중이야. 본품은 말고',
  '테팔 BL1B1용 믹서컵 정품','테팔 BL1B1 믹서기 본품']
];
for(const [query,part,body] of accessoryCases){
 const spec=Gate.parseQuery(query,{titles:[part,body]});
 assert.equal(spec.wantsAccessory,true,JSON.stringify({query,idText:spec.idText,wantsAccessory:spec.wantsAccessory,accessoryWords:spec.accessoryWords,identityWords:spec.identityWords}));
 count++;
 assert.ok(!spec.identityWords.some(w=>/^(?:복합기|빔프로젝터|믹서기)$/.test(w)),
   JSON.stringify({query,identityWords:spec.identityWords}));
 count++;
 const correct=Gate.judge(spec,{title:part,lprice:15000});
 assert.equal(correct.ok,true,JSON.stringify({query,idText:spec.idText,hard:correct.hard,soft:correct.soft}));
 count++;
 const wrong=Gate.judge(spec,{title:body,lprice:100000});
 assert.equal(wrong.ok,false,JSON.stringify({query,hard:wrong.hard}));
 count++;
 const stored=Gate.saveFilter(query,[{title:body,lprice:100000,productId:'fixture'}]);
 assert.equal(stored.save.length,0,'wrong principal must not be stored for accessory query');
 count++;
}

// Negative purchase restrictions cannot turn refurbished/used listings into
// requested goods just because we stripped the dialogue from idText.
const noUsed='고프로 HERO12 액션캠 새제품만. 중고나 리퍼는 절대 안 돼';
const noUsedSpec=Gate.parseQuery(noUsed,{titles:[
  '고프로 HERO12 액션캠 새제품','고프로 HERO12 액션캠 중고','고프로 HERO12 액션캠 리퍼'
]});
assert.equal(noUsedSpec.condition.wanted,'new',JSON.stringify({wanted:noUsedSpec.condition.wanted,excluded:[...noUsedSpec.condition.excluded]}));count++;
assert.equal(noUsedSpec.condition.excluded.has('used'),true,'used exclusion lost');count++;
assert.equal(noUsedSpec.condition.excluded.has('refurbished'),true,'refurbished exclusion lost');count++;
assert.equal(Gate.judge(noUsedSpec,{title:'고프로 HERO12 액션캠 중고',lprice:200000}).ok,false);count++;
assert.equal(Gate.judge(noUsedSpec,{title:'고프로 HERO12 액션캠 리퍼',lprice:200000}).ok,false);count++;
assert.equal(Gate.saveFilter(noUsed,[{title:'고프로 HERO12 액션캠 리퍼',lprice:200000}]).save.length,0);count++;

// A named manufacturer that is not in the closed brand table must still be
// excluded when "other company" is explicit. Never require the rejected name.
for(const [query,excluded,allowed] of [
 ['브라더 말고 다른 회사의 레이저 프린터 추천해줘','브라더 레이저 프린터','삼성전자 레이저 프린터'],
 ['키크론 말고 다른 회사의 기계식 키보드 추천해줘','키크론 기계식 키보드','삼성전자 기계식 키보드']
]){
 const spec=Gate.parseQuery(query,{titles:[excluded,allowed]});
 assert.ok(!spec.idText.includes(excluded.split(' ')[0]),JSON.stringify({query,idText:spec.idText})); count++;
 assert.ok(spec.excludedBrands.length>0,'missing rejected brand: '+query);count++;
 assert.ok(!Gate.judge(spec,{title:excluded,lprice:110000}).ok,'rejected brand shown');count++;
 const ok=Gate.judge(spec,{title:allowed,lprice:110000});
 assert.equal(ok.ok,true,JSON.stringify({query,hard:ok.hard,idText:spec.idText}));count++;
}
// Preexisting part regression: a Roborock brush is the requested item,
// even when the query specifies which host device it will fit.
{
 const q='로보락 로봇 청소기에 쓸 전용 브러시만 보여줘';
 const title='로보락 로봇 청소기용 전용 브러시';
 const p=Gate.parseQuery(q);
 const judged=Gate.judge(p,{title,lprice:16000});
 assert.equal(judged.ok,true,JSON.stringify({
   q,idText:p.idText,head:p.head,wantsAccessory:p.wantsAccessory,
   accessoryWords:p.accessoryWords,identityWords:p.identityWords,hard:judged.hard,soft:judged.soft
 }));
 count++;
}
console.log('SEARCH_DIALOGUE_AND_COMPAT '+count+' PASS');
