'use strict';
// Exactly two real public Production AI POST calls, spaced at 25 seconds.
// One-off Preview build only: no direct DB connection or privileged auth.
if(process.env.VERCEL_ENV==='production')throw new Error('Cannot execute charged QA during Production build');
const qs=[
 ['named-foreign-condition','아이패드 A16 vs 갤럭시탭 S10 FE 가격 비교해줘',false],
 ['broad-condition','아이패드 vs 갤럭시탭 비교해줘',true]
];
const ipad=/아이패드|ipad/i,tab=/갤럭시\s*탭|갤럭시탭|galaxy\s*tab/i;
const importTag=/(?:해외판|해외직구|해외\s*구매|아랍어\s*버전|글로벌\s*버전|일본판|병행수입)/i;
const preorderTag=/(?:예약\s*판매|사전\s*예약|pre[- ]?order)/i;
const usedTag=/(?:중고|리퍼|재생\s*제품)/i;
const accessory=/(?:굿노트|pdf|클래스|투어|보호필름|액정보호|터치\s*스크린.{0,80}유리|키보드|케이스|가계부|플래너|스타일러스|교체용|예약금|월\s*\d[\d,]*\s*원)/i;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const results=[];
 for(let i=0;i<qs.length;i++){
  const [name,question,broad]=qs[i];let response,body;
  try{
   response=await fetch('https://seosa.ai.kr/api/ai',{
     method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json','User-Agent':'SEOSA-Final-Conditions-QA/1.0'},
     body:JSON.stringify({question,chatHistory:[{role:'user',content:question}],view:{source:'none'},contextProducts:[]}),
     signal:AbortSignal.timeout(65000)});
   body=await response.json();
  }catch(e){
   const bad={name,pass:false,reason:e.name};results.push(bad);console.log('CONDITIONS_PROD_CASE '+JSON.stringify(bad));
   if(i+1<qs.length)await sleep(25000);continue;
  }
  const text=String(body.text||''),items=Array.isArray(body.items)?body.items:[],titles=items.map(x=>String(x.title||''));
  const tagged={import:titles.some(t=>importTag.test(t)),preorder:titles.some(t=>preorderTag.test(t)),used:titles.some(t=>usedTag.test(t))};
  const checks={
   http200:response.status===200&&!body.error,
   complete:body.comparison?.complete===true,
   bothRealDevices:items.length===2&&titles.some(t=>ipad.test(t))&&titles.some(t=>tab.test(t))&&titles.every(t=>!accessory.test(t)),
   exactDisplayPrices:items.length===2&&items.every(x=>Number(x.lprice)>0&&/^https:\/\//.test(String(x.link||''))),
   warnsIfImported:!tagged.import||text.includes('국내 제품과 구성·보증·언어 설정'),
   warnsIfPreorder:!tagged.preorder||text.includes('수령 일정이 다를 수 있어요'),
   warnsIfUsed:!tagged.used||text.includes('중고·리퍼 표시'),
   broadTruth:!broad||(/동급 모델/.test(text)&&/가성비가 높다고 단정할 수 없어요/.test(text)),
   checkoutDisclaimer:text.includes('최종 결제가가 아니며')
  };
  const record={name,pass:Object.values(checks).every(Boolean),checks,prices:items.map(x=>x.lprice),titles:titles.map(t=>t.slice(0,105)),flags:tagged};
  console.log('CONDITIONS_PROD_CASE '+JSON.stringify(record));results.push(record);
  if(i+1<qs.length)await sleep(25000);
 }
 const pass=results.filter(x=>x.pass).length;
 console.log('CONDITIONS_PROD_SUMMARY '+JSON.stringify({asked:qs.length,pass,fail:qs.length-pass,productionCommit:'cd51077bb30045849b0be3f3855cbc8957a408a9'}));
 if(pass!==qs.length)process.exitCode=1;
})().catch(e=>{console.error('CONDITIONS_PROD_ERROR '+String(e.message||e));process.exitCode=1;});
