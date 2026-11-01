'use strict';
const assert=require('node:assert/strict');
const {applyFactGate}=require('../api/_ai-fact-gate');
let pass=0,fail=0;
const a={productId:'P1',vendorItemId:'V1',mall:'쿠팡',title:'삼성 이어폰',lprice:95000};
const b={productId:'P2',vendorItemId:'V2',mall:'쿠팡',title:'소니 헤드셋',lprice:110000};
const base={trustedCards:[a,b],eligibleItems:[a,b],enforceBudget:true,maxPrice:120000};
function check(name,body,opts,expect){
 const r=applyFactGate(body,{...base,...opts});
 const ok=expect==='PASS'?r.failures.length===0:r.failures.includes(expect);
 if(ok){pass++;console.log('PASS',name)}else{fail++;console.error('FAIL',name,r.failures)}
}
check('valid',{text:'추천',items:[a]},null,'PASS');
check('unknown product',{text:'추천',items:[{...a,productId:'fake'}]},null,'UNKNOWN_PRODUCT_ID');
check('different option',{text:'추천',items:[{...a,vendorItemId:'bad'}]},null,'UNKNOWN_PRODUCT_ID');
check('different merchant',{text:'추천',items:[{...a,mall:'ADPICK'}]},null,'UNKNOWN_PRODUCT_ID');
check('wrong price',{text:'추천',items:[{...a,lprice:1}]},null,'PRICE_MISMATCH');
check('over budget',{text:'추천',items:[b]},{maxPrice:100000},'BUDGET_VIOLATION');
check('price lookup bypass',{text:'가격',items:[b]},{enforceBudget:false},'PASS');
check('excluded brand',{text:'추천',items:[a]},{excludedBrands:['삼성']},'EXCLUDED_BRAND_VIOLATION');
check('cross product',{text:'추천',items:[{...a,evidence:[{product_id:'P2',field:'price',value:'110000'}]}]},null,'CROSS_PRODUCT_EVIDENCE');
check('false price evidence',{text:'추천',items:[{...a,evidence:[{product_id:'P1',field:'price',value:'50000'}]}]},null,'PRICE_MISMATCH');
check('unsupported history',{text:'지난달 최저가 기록했습니다',items:[a]},{historyQuestion:true,historyVerified:false},'UNSOURCED_PRICE_HISTORY');
check('honest unknown history',{text:'지난달 최저가 자료가 부족해 확인할 수 없어요',items:[a]},{historyQuestion:true,historyVerified:false},'PASS');
check('verified history',{text:'지난달 최저가 95000원',items:[a]},{historyQuestion:true,historyVerified:true},'PASS');
check('wrong highlighted card',{text:'추천',items:[a],topRecommendation:{...b}},null,'CROSS_PRODUCT_EVIDENCE');
const adpickCard={productId:'AD1',mall:'ADPICK',title:'일상용 무선 헤드셋',lprice:99000};
const adpickInternal={...adpickCard,vendorItemId:'INTERNAL-OPTION'};
check('non-Coupang private option ID is not required on public card',
 {text:'추천',items:[adpickCard]}, {trustedCards:[adpickCard],eligibleItems:[adpickInternal]}, 'PASS');
check('ambiguous non-Coupang option match must be rejected',
 {text:'추천',items:[adpickCard]}, {trustedCards:[adpickCard],
 eligibleItems:[adpickInternal,{...adpickInternal,vendorItemId:'OTHER'}]}, 'UNKNOWN_PRODUCT_ID');
check('non-Coupang price mismatch must be rejected',
 {text:'추천',items:[adpickCard]}, {trustedCards:[adpickCard],
 eligibleItems:[{...adpickInternal,lprice:100000}]}, 'UNKNOWN_PRODUCT_ID');

const group={productId:'GROUP',mall:'대표판매처',title:'소니 헤드셋 묶음',lprice:199000,
 isCanonicalGroup:true,displayPrice:189000,canonicalLowestMerchant:'최저판매처'};
const groupRanked={productId:'GROUP',mall:'최저판매처',price:189000,isCanonicalGroup:true};
check('canonical bundle price uses verified cheapest offer',
 {text:'최저가 추천',items:[group]}, {trustedCards:[group],eligibleItems:[groupRanked],
 maxPrice:190000},'PASS');
check('canonical bundle must still respect budget at shown price',
 {text:'최저가 추천',items:[group]}, {trustedCards:[group],eligibleItems:[groupRanked],
 maxPrice:180000},'BUDGET_VIOLATION');
check('canonical display price cannot be tampered',
 {text:'최저가 추천',items:[{...group,displayPrice:100000}]},
 {trustedCards:[group],eligibleItems:[groupRanked]},'PRICE_MISMATCH');

console.log('FACT_GATE_SUMMARY',JSON.stringify({asked:pass+fail,pass,fail,external:0,dbWrites:0}));
if(fail)process.exitCode=1;
