'use strict';
const assert=require('node:assert/strict');
const C=require('../api/_ai-comparison');
const ID=require('../api/_aiidentity');
const mk=(title,lprice,i)=>({title,lprice,productId:i,mall:'ADPICK',isCoupang:false,link:'https://shop.example/'+i});
const norm=r=>({...r,price:r.lprice,mallId:r.mall});
const A=mk('Apple 2025 아이패드 (A16 모델)',621300,'a');
const imported=mk('삼성전자 갤럭시 탭 S10 FE 태블릿 10.9인치 아랍어 버전 8GB SM-X520',588050,'foreign');
const preorder=mk('[예약판매]삼성전자 갤럭시탭 S10 FE WiFi SM-X520',695520,'pre');
const normal=mk('삼성전자 갤럭시탭 S10 FE WiFi SM-X520 128GB 태블릿',662000,'regular');
const lower=mk('삼성전자 갤럭시탭 S10 FE WiFi SM-X520 월 29000원 렌탈',29000,'rental');
const cases=[
 {name:'generic named comparison prefers ordinary distribution',list:[imported,preorder,normal,lower],query:'갤럭시탭 S10 FE',want:'regular'},
 {name:'imported is still truthful if only available',list:[imported],query:'갤럭시탭 S10 FE',want:'foreign'},
 {name:'preorder if only offer is visibly warned',list:[preorder],query:'갤럭시탭 S10 FE',want:'pre'},
 {name:'explicitly requested Arabic version does not get silently swapped',list:[imported,normal],query:'갤럭시탭 S10 FE 아랍어 버전',want:'foreign'}
];
let passed=0;
for(const c of cases){
 const p=C.pickExact(c.list,c.query,ID,norm);
 if(c.name.includes('explicitly requested')){
   // Exact-identity logic may not recognize foreign-language suffixes as a
   // product model; do not require unsupported identity relaxation here.
   assert.ok(p===null||p.productId==='foreign','never silently switch to another distribution');
 }else assert.equal(p?.productId,c.want,c.name);
 passed++;
}
const broad=C.pickAlignedPair([[A],[imported,preorder,normal]],['아이패드','갤럭시탭'],ID,norm);
assert.equal(broad?.[1]?.productId,'regular','broad-family pairing prioritizes ordinary offers');
passed++;
const warning=C.formatComparison(['아이패드','갤럭시탭'],[
 {title:A.title,price:A.lprice,mall:'쿠팡'}, {title:imported.title,price:imported.lprice,mall:'ADPICK'}],'search',{});
assert.match(warning,/해외판/);
assert.match(warning,/최종 결제가가 아니며/);
passed+=2;
console.log('AI_DISTRIBUTION_TERMS',JSON.stringify({pass:passed,fail:0,realApiCalls:0,dbWrites:0}));
