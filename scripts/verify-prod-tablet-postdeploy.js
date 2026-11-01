'use strict';
/* One-off Preview build: at most 2 real POSTs to the actual Production domain. */
if(process.env.VERCEL_ENV==='production')throw Error('Forbidden on production build');
const BASE='https://seosa.ai.kr';
const asleep=ms=>new Promise(r=>setTimeout(r,ms));
const cases=[
 {name:'broad-ipad-galaxy-tab',question:'아이패드 vs 갤럭시탭 비교해줘',broad:true},
 {name:'specific-ipad-a16-galaxy-tab-s10-fe',question:'아이패드 A16 vs 갤럭시탭 S10 FE 가격 비교해줘',broad:false}
];
const ipad=/아이패드|ipad/i,tab=/갤럭시\s*탭|갤럭시탭|galaxy\s*tab/i;
const accessory=/(?:터치\s*스크린.{0,100}유리|touch\s*screen.{0,100}glass|replacement\s*(?:screen|glass)|교체용|수리용|보호\s*(?:필름|유리)|액정보호|액정\s*보호|키보드|keyboard|북\s*커버|케이스|case\b|cover\b|스크린\s*프로텍터|screen\s*protector)/i;
const result=[];
(async()=>{
 for(let i=0;i<cases.length;i++){
  const q=cases[i]; let response,body;
  try{
   response=await fetch(BASE+'/api/ai',{method:'POST',headers:{
      'Content-Type':'application/json','Accept':'application/json','User-Agent':'SEOSA-Prod-Tablet-Regression/1.0'
    },body:JSON.stringify({question:q.question,chatHistory:[{role:'user',content:q.question}],contextProducts:[],view:{source:'none'}}),
    signal:AbortSignal.timeout(65000)});
   body=await response.json();
  }catch(e){result.push({name:q.name,status:0,pass:false,reason:e.name});console.log('PROD_TABLET_CASE '+JSON.stringify(result[result.length-1]));continue;}
  const list=Array.isArray(body.items)?body.items:[],txt=String(body.text||'');
  const titles=list.map(x=>String(x.title||''));
  const flags={
   http200:response.status===200&&!body.error,
   complete:body.comparison?.complete===true,
   twoCards:list.length===2,
   bothFamilies:titles.some(t=>ipad.test(t))&&titles.some(t=>tab.test(t)),
   positivePrices:list.every(x=>Number(x.lprice)>0),
   noAccessories:titles.every(t=>!accessory.test(t)),
   noFalseLowest:/전체\s*최저가/.test(txt)===false,
   broadFamilyQualified:!q.broad||(/동급/.test(txt)&&/단정할 수 없어요/.test(txt))
  };
  const pass=Object.values(flags).every(Boolean);
  const r={name:q.name,status:response.status,pass,checks:flags,cardCount:list.length,
   cardTypes:titles.map(t=>ipad.test(t)?'ipad':tab.test(t)?'galaxy-tab':'other'),
   prices:list.map(x=>x.lprice),titleSnippets:titles.map(t=>t.slice(0,115)),
   excerpt:txt.replace(/\s+/g,' ').slice(0,250)};
  result.push(r);console.log('PROD_TABLET_CASE '+JSON.stringify(r));
  if(i+1<cases.length)await asleep(20000);
 }
 const pass=result.filter(x=>x.pass).length;
 console.log('PROD_TABLET_SUMMARY '+JSON.stringify({requests:result.length,pass,fail:result.length-pass,
  releaseSha:'039854fe1b07946babd1dfe0d6db89f152984653'}));
 if(pass!==cases.length)process.exitCode=1;
})().catch(e=>{console.error('PROD_TABLET_UNHANDLED '+String(e.message||e));process.exitCode=1});
