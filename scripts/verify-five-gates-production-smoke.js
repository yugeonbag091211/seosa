'use strict';
if(process.env.VERCEL_ENV==='production')throw Error('Read-only QA cannot run during production build');
const q=[
 ['broad-fair-tablets','아이패드 vs 갤럭시탭 비교해줘'],
 ['named-model-tablets','아이패드 A16 vs 갤럭시탭 S10 FE 가격 비교해줘']
];
const ipad=/아이패드|ipad/i,tab=/갤럭시\s*탭|갤럭시탭|galaxy\s*tab/i;
const isAccessory=/(?:굿노트|pdf|클래스|투어|보호필름|액정보호|터치\s*스크린.{0,80}유리|키보드|케이스|가계부|플래너|스타일러스|교체용|예약금|월\s*\d[\d,]*\s*원)/i;
const result=[];
(async()=>{
 for(const [name,question] of q){
  let res,body;
  try{
   res=await fetch('https://seosa.ai.kr/api/ai',{method:'POST',
    headers:{'Content-Type':'application/json','Accept':'application/json','User-Agent':'SEOSA-FiveGates-LiveQA/1.0'},
    body:JSON.stringify({question,chatHistory:[{role:'user',content:question}],view:{source:'none'},contextProducts:[]}),
    signal:AbortSignal.timeout(65000)});
   body=await res.json();
  }catch(e){const failed={name,pass:false,error:e.name};result.push(failed);console.log('FIVE_GATES_PROD_CASE '+JSON.stringify(failed));await new Promise(r=>setTimeout(r,26000));continue;}
  const items=Array.isArray(body.items)?body.items:[],title=items.map(x=>String(x.title||'')),txt=String(body.text||'');
  const prices=items.map(x=>Number(x.lprice));
  const checks={
   http200:res.status===200&&!body.error,
   complete:body.comparison?.complete===true,
   pairItems:items.length===2&&title.some(t=>ipad.test(t))&&title.some(t=>tab.test(t)),
   paidPrices:prices.every(p=>Number.isSafeInteger(p)&&p>0)&&items.every(i=>/^https:\/\//.test(String(i.link||''))),
   notAccessory:title.every(t=>!isAccessory.test(t)),
   noFalseSameSpecs:!/두 제품은 동급 성능|성능이 동일/.test(txt),
   checkoutWarning:txt.includes('최종 결제가가 아니며'),
   truthfulBroad:name!=='broad-fair-tablets'||(txt.includes('동급 모델')&&txt.includes('가성비가 높다고 단정할 수 없어요')),
   modelNamed:name!=='named-model-tablets'||(title.some(t=>/A16/i.test(t))&&title.some(t=>/S10\s*FE/i.test(t))),
   comparablePrice:name!=='broad-fair-tablets'||(prices.length===2&&Math.max(...prices)/Math.min(...prices)<=1.6)
  };
  const item={name,pass:Object.values(checks).every(Boolean),status:res.status,checks,prices,title:title.map(x=>x.slice(0,100)),textSample:txt.replace(/\s+/g,' ').slice(0,180)};
  result.push(item);console.log('FIVE_GATES_PROD_CASE '+JSON.stringify(item));
  await new Promise(r=>setTimeout(r,26000));
 }
 const pass=result.filter(x=>x.pass).length;
 console.log('FIVE_GATES_PROD_SUMMARY '+JSON.stringify({asked:result.length,pass,fail:result.length-pass,productionSha:'cac20e5e0f00170119d52e7084dacbbd7f106e76'}));
 if(pass!==q.length)process.exitCode=1;
})().catch(e=>{console.error('FIVE_GATES_PROD_UNHANDLED '+String(e.message||e));process.exitCode=1});
