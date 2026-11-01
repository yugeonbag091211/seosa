'use strict';
if(process.env.VERCEL_ENV==='production')throw Error('Forbidden in production build');
(async()=>{
const question='아이패드 vs 갤럭시탭 비교해줘';
let res,body;
try{
 res=await fetch('https://seosa.ai.kr/api/ai',{method:'POST',
  headers:{'Content-Type':'application/json','Accept':'application/json','User-Agent':'SEOSA-QA/1.0'},
  body:JSON.stringify({question,contextProducts:[],view:{source:'none'},
  chatHistory:[{role:'user',content:question}]}),signal:AbortSignal.timeout(65000)});
 body=await res.json();
}catch(e){console.log('PROD_SEMANTIC_SUMMARY '+JSON.stringify({pass:0,fail:1,networkError:e.name}));process.exitCode=1;return;}
const txt=String(body.text||''),cards=Array.isArray(body.items)?body.items:[];
const ipad=/아이패드|ipad/i,tab=/갤럭시\s*탭|갤탭|galaxy\s*tab/i;
const checks={
  http200:res.status===200&&!body.error,
  bothInAnswer:ipad.test(txt)&&tab.test(txt),
  twoCards:cards.length>=2&&cards.every(c=>Number(c.lprice)>0&&/^https:\/\//.test(String(c.link||''))),
  bothProductFamilies:cards.some(c=>ipad.test(String(c.title||'')))&&cards.some(c=>tab.test(String(c.title||'')))
};
for(const [k,v] of Object.entries(checks))console.log((v?'PASS ':'FAIL ')+k);
console.log('PROD_SEMANTIC_SUMMARY '+JSON.stringify({
  pass:Object.values(checks).filter(Boolean).length,
  fail:Object.values(checks).filter(v=>!v).length,
  intent:body.intent,cardCount:cards.length,cardTypes:cards.map(c=>ipad.test(c.title)?'ipad':tab.test(c.title)?'galaxy-tab':'other'),
  partial:!!body.partialSearch,answerChars:txt.length,answerExcerpt:txt.replace(/\s+/g,' ').slice(0,190)
}));
if(Object.values(checks).some(x=>!x))process.exitCode=1;
})().catch(e=>{console.error('PROD_SEMANTIC_ERROR '+String(e.message||e));process.exitCode=1});
