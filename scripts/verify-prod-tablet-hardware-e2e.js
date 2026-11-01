'use strict';
/* Postdeploy read + API real HTTP test. Runs only from disposable Preview build. */
if(process.env.VERCEL_ENV === 'production')throw Error('Refuse Production build QA');
const rows=[
 ['broad-family','아이패드 vs 갤럭시탭 비교해줘',true],
 ['explicit-model','아이패드 A16 vs 갤럭시탭 S10 FE 가격 비교해줘',false]
];
const familyI=/(?:아이패드|ipad)/i,familyG=/(?:갤럭시\s*탭|갤럭시탭|galaxy\s*tab)/i;
const bad=/(?:굿노트|goodnotes|\bpdf\b|템플릿|플래너|가계부|전자책|수채화.{0,40}배우기|원데이\s*클래스|투어|교재|스타일러스|pencil|펜슬|파우치|키보드|keyboard|케이스|북커버|액정보호|보호필름|screen\s*protector|교체용|터치\s*스크린.{0,95}유리)/i;
const evidence=/(?:apple|애플|삼성|samsung|태블릿|tablet|sm[-_ ]?[a-z]\d{3,4}|\b(?:m[1-9]|a\d{2,4})\b|(?:\d{2,4}\s*(?:gb|tb))|\d{1,2}\s*세대)/i;
const all=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 for(const [label,question,broad] of rows){
  let response,body;
  try{
   response=await fetch('https://seosa.ai.kr/api/ai',{method:'POST',
    headers:{'Content-Type':'application/json','Accept':'application/json','User-Agent':'SEOSA-Postdeploy-Tablet-E2E/1.0'},
    body:JSON.stringify({question,chatHistory:[{role:'user',content:question}],view:{source:'none'},contextProducts:[]}),
    signal:AbortSignal.timeout(65000)});
   body=await response.json();
  }catch(e){
   all.push({name:label,pass:false,reason:e.name,requestAttempted:true});
   console.log('TABLET_QA_CASE '+JSON.stringify(all[all.length-1]));
   if(label==='broad-family')await sleep(20000);
   continue;
  }
  const txt=String(body.text||''),cards=Array.isArray(body.items)?body.items:[];
  const titles=cards.map(x=>String(x.title||''));
  const passList={
    httpOk:response.status===200&&!body.error,
    complete:body.comparison?.complete===true,
    bothFamilies:cards.length===2&&titles.some(x=>familyI.test(x))&&titles.some(x=>familyG.test(x)),
    physicalDevices:titles.every(t=>!bad.test(t)&&evidence.test(t)),
    positivePrices:cards.length===2&&cards.every(x=>Number(x.lprice)>0),
    noPriceHallucination:!/전체\s*최저가/.test(txt),
    familyDisclosure:!broad||(/동급/.test(txt)&&/단정할 수 없어요/.test(txt))
  };
  const passed=Object.values(passList).every(Boolean);
  const details={name:label,pass:passed,status:response.status,
    checks:passList,cardTitles:titles.map(x=>x.slice(0,125)),prices:cards.map(x=>x.lprice),
    comparisonComplete:body.comparison?.complete,
    answerExcerpt:txt.replace(/\s+/g,' ').slice(0,215)};
  all.push(details);console.log('TABLET_QA_CASE '+JSON.stringify(details));
  if(label==='broad-family')await sleep(20000);
 }
 const count=all.filter(x=>x.pass).length;
 console.log('TABLET_QA_SUMMARY '+JSON.stringify({asked:rows.length,pass:count,fail:rows.length-count,
  target:'https://seosa.ai.kr',postfixSha:'10c7b5f5cc3299513aab7f061c8e2de7fc9a9cf8'}));
 if(count!==rows.length)process.exitCode=1;
})().catch(e=>{console.error('TABLET_QA_EXCEPTION '+String(e.message||e));process.exitCode=1});
