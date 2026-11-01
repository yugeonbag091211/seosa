'use strict';
if(process.env.VERCEL_ENV==='production')throw Error('Production build unsafe for QA');
const Q=[['broad','아이패드 vs 갤럭시탭 비교해줘'],['named','아이패드 A16 vs 갤럭시탭 S10 FE 가격 비교해줘']];
const titleImport=/(?:\[해외\]|해외판|해외직구|해외\s*구매|병행수입|글로벌\s*버전|글로벌판|일본판|미국판|아랍어\s*(?:버전|판)|영문\s*버전|international\s*version|global\s*version)/i;
const titlePre=/(?:예약\s*판매|사전\s*예약|프리오더|pre[- ]?order)/i;
const titleUsed=/(?:중고|리퍼|리퍼비시|재생\s*제품|refurbished|refurb\b)/i;
const bad=/굿노트|pdf|원데이\s*클래스|가계부|케이스|보호필름|키보드|액정보호|터치\s*스크린.{0,85}유리/i;
const ipad=/아이패드|ipad/i,galaxy=/갤럭시\s*탭|갤럭시탭|galaxy\s*tab/i;
const result=[];
(async()=>{
 for(const [name,question] of Q){
  let r,b;
  try{
   r=await fetch('https://seosa.ai.kr/api/ai',{method:'POST',
    headers:{'Content-Type':'application/json','Accept':'application/json','User-Agent':'SEOSA-PurchaseTerms-QA/1.0'},
    body:JSON.stringify({question,view:{source:'none'},contextProducts:[],chatHistory:[{role:'user',content:question}]}),
    signal:AbortSignal.timeout(65000)});
   b=await r.json();
  }catch(e){result.push({name,pass:false,networkError:e.name});console.log('PURCHASE_CONDITION_CASE '+JSON.stringify(result[result.length-1]));await new Promise(z=>setTimeout(z,24000));continue;}
  const cards=Array.isArray(b.items)?b.items:[],names=cards.map(x=>String(x.title||'')),txt=String(b.text||'');
  const special=names.some(s=>titleImport.test(s)||titlePre.test(s)||titleUsed.test(s));
  const checks={
    validHttp:r.status===200&&!b.error,
    twoDevices:cards.length===2&&names.some(s=>ipad.test(s))&&names.some(s=>galaxy.test(s)),
    priceAndLinks:cards.length===2&&cards.every(x=>Number(x.lprice)>0&&/^https:\/\//.test(String(x.link||''))),
    notDigitalAccessory:names.every(x=>!bad.test(x)),
    conditionDisclosure:!special||(/상품 확인 사항/.test(txt)&&(/해외판|예약판매|중고·리퍼/.test(txt))),
    cannotClaimFinalPrice:txt.includes('최종 결제가가 아니며'),
    broadHonesty:name!=='broad'||/동급 모델|성능이나 사양이 비슷한지/.test(txt)
  };
  const pass=Object.values(checks).every(Boolean);
  const obj={name,pass,checks,prices:cards.map(x=>x.lprice),titles:names.map(s=>s.slice(0,110)),
    specialCondition:special,hasWarning:/상품 확인 사항/.test(txt),snippet:txt.replace(/\s+/g,' ').slice(0,240)};
  result.push(obj);console.log('PURCHASE_CONDITION_CASE '+JSON.stringify(obj));
  await new Promise(z=>setTimeout(z,24000));
 }
 const pass=result.filter(x=>x.pass).length;
 console.log('PURCHASE_CONDITION_SUMMARY '+JSON.stringify({requested:result.length,pass,fail:result.length-pass,
 deployedSha:'cd51077bb30045849b0be3f3855cbc8957a408a9',realProductionRequests:result.length}));
 if(pass!==Q.length)process.exitCode=1;
})().catch(e=>{console.error('PURCHASE_CONDITION_FATAL '+String(e.message||e));process.exitCode=1});
