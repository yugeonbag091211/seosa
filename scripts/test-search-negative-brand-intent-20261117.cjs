'use strict';
// Offline regression: negated brands must never become positive model constraints.
// This exercises product identity and the same save filter used by /api/search.
const assert = require('node:assert/strict');
const Gate = require('../api/_product-gate');
let passed=0;
const check=(name,fn)=>{try{fn();console.log('PASS '+name);passed++;}catch(e){console.error('FAIL '+name+': '+e.message);process.exitCode=1;}};
const info=(query,titles)=>Gate.parseQuery(query,{titles});
const verdict=(spec,title,price=65000)=>Gate.judge(spec,{title,price});
const exclusions=[
  {query:'마우스 중 로지텍 브랜드는 절대 제외하고 추천해줘',type:'마우스',rejected:'로지텍 마우스 정품',accepted:'삼성전자 마우스 정품'},
  {query:'로지텍 마우스 말고 다른 마우스 보여줘',type:'마우스',rejected:'로지텍 마우스 정품',accepted:'삼성전자 마우스 정품'},
  {query:'이어폰 중 QCY 브랜드는 절대 제외하고 추천해줘',type:'이어폰',rejected:'QCY 이어폰 정품',accepted:'삼성전자 이어폰 정품'},
  {query:'노트북 중 삼성 브랜드는 절대 제외하고 추천해줘',type:'노트북',rejected:'삼성 노트북 정품',accepted:'LG전자 노트북 정품'},
  {query:'식탁 의자 추천하되 한샘 브랜드는 제외해줘',type:'의자',rejected:'한샘 식탁 의자',accepted:'일룸 식탁 의자'},
  {query:'로봇 청소기 추천하되 로보락 브랜드는 제외해줘',type:'청소기',rejected:'로보락 로봇 청소기',accepted:'삼성 로봇 청소기'},
  {query:'밀폐용기 중 락앤락 브랜드는 절대 제외하고 추천해줘',type:'밀폐용기',rejected:'락앤락 밀폐용기 정품',accepted:'삼성전자 밀폐용기 정품'},
  {query:'전기면도기 중 필립스 브랜드는 절대 제외하고 추천해줘',type:'전기면도기',rejected:'필립스 전기면도기 정품',accepted:'브라운 전기면도기 정품'},
  {query:'로지텍은 절대 제외하고 마우스 추천해줘',type:'마우스',rejected:'로지텍 마우스 정품',accepted:'삼성전자 마우스 정품'}
];
for(const x of exclusions){
  check('negation spec: '+x.query,()=>{
    const spec=info(x.query,[x.rejected,x.accepted]);
    assert.ok(spec.excludedBrands.length>0,'no excluded brand: '+JSON.stringify(spec));
    assert.ok(!/절대|브랜드|제외/.test(spec.idText),'instruction residue '+spec.idText);
    assert.ok(spec.idText.includes(x.type),'type lost '+spec.idText);
    assert.ok(!spec.brands.some(b=>spec.excludedBrands.includes(b.canon)),'excluded brand also required');
  });
  check('excluded product blocked: '+x.query,()=>{
    const spec=info(x.query,[x.rejected,x.accepted]);
    const result=verdict(spec,x.rejected);
    assert.ok(!result.ok&&result.hard.some(s=>s.startsWith('excluded_brand:')),
      JSON.stringify({query:x.query,idText:spec.idText,hard:result.hard}));
  });
  check('other brand eligible: '+x.query,()=>{
    const spec=info(x.query,[x.rejected,x.accepted]);
    const result=verdict(spec,x.accepted,/노트북/.test(x.type)?700000:65000);
    assert.equal(result.ok,true,
      JSON.stringify({query:x.query,idText:spec.idText,hard:result.hard,soft:result.soft}));
  });
}
const identityQueries=[
  {q:'로지텍 G304 무선 마우스 구매하려는데 본품 가격순으로 보여줘',ok:'로지텍 G304 무선 마우스',wrong:'로지텍 G305 무선 마우스'},
  {q:'캐논 EOS R50 미러리스 카메라 구매하려는데 본품 가격순으로 보여줘',ok:'캐논 EOS R50 미러리스 카메라',wrong:'캐논 EOS R100 미러리스 카메라'},
  {q:'테팔 프라이팬 본품 사고 싶어. 사은품은 받아도 괜찮아',ok:'테팔 프라이팬 본품 + 손잡이 증정',wrong:'테팔 프라이팬 손잡이 단품'},
  {q:'나이키 운동화 본품 사고 싶어. 사은품은 받아도 괜찮아',ok:'나이키 운동화 본품 + 깔창 증정',wrong:'나이키 운동화 깔창 단품'},
  {q:'캐논 EOS R50 미러리스 카메라 구매하려는데 본품 가격순으로 보여줘',ok:'캐논 EOS R50 미러리스 카메라 새제품 정품',wrong:'캐논 EOS R100 미러리스 카메라 새제품 정품'}
];
for(const x of identityQueries){
  check('buyer instructions stripped: '+x.q,()=>{
    const spec=info(x.q,[x.ok,x.wrong]);
    assert.ok(!/(?:구매하려는데|가격순|사은품|받아도|괜찮아)/.test(spec.idText),
      'instruction residue '+spec.idText);
    assert.equal(verdict(spec,x.ok,700000).ok,true,
      JSON.stringify({q:x.q,idText:spec.idText,hard:verdict(spec,x.ok,700000).hard}));
    assert.equal(verdict(spec,x.wrong,700000).ok,false,
      JSON.stringify({q:x.q,idText:spec.idText,hard:verdict(spec,x.wrong,700000).hard}));
  });
}
// Intent negation must not disable the budget/price or allow irrelevant accessories.
check('explicit budget still mandatory',()=>{
  const query='삼성 노트북 50만원 이하 구매하려는데 가격순으로 보여줘';
  const spec=info(query,['삼성 노트북','삼성 노트북 케이스']);
  assert.ok(spec.budget.max>0,'budget erased');
  const bad=verdict(spec,'삼성 노트북',900000);
  assert.ok(!bad.ok&&bad.hard.some(x=>x.includes('budget')),'price constraint lost: '+JSON.stringify(bad.hard));
});
check('device accessories still blocked',()=>{
  const spec=info('아이패드 10세대 구매하려는데 본품 가격순으로 보여줘',
    ['아이패드 10세대 256GB 본품','아이패드 10세대 케이스']);
  const bad=verdict(spec,'아이패드 10세대 케이스',30000);
  assert.ok(!bad.ok,'accessory allowed in body search');
});
check('nonbrand negation stays separate from brand filters',()=>{
  const spec=info('노트북 중고 제외하고 신품만 보여줘',['삼성 노트북 신품','삼성 노트북 중고']);
  assert.equal(spec.excludedBrands.length,0,'condition phrase mistakenly parsed as a manufacturer');
  assert.ok(!verdict(spec,'삼성 노트북 중고').ok);
});
console.log('NEGATIVE_BRAND_INTENT_REGRESSION '+passed+' passed');
