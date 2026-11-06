'use strict';
const {appendFileSync,writeFileSync,mkdirSync}=require('node:fs');
const path=require('node:path');
const {requestedIdentity,checkListingIdentity,extractTitleEvidence}=require('../api/_ai-v3-identity');
const {categoryOk}=require('../api/_ai-v3-core');
const {comparisonFromUtterance,ambiguousOptions,productTypeMatches,canonicalCategory,familyCategory}=require('../api/_ai-v31-taxonomy');
const {brandMatches}=require('../api/_ai-v31-retrieval');
const mode=process.argv[2],share=process.argv[3];
if(!['gate','full','focus'].includes(mode)||!/^https:\/\/seosa-[a-z0-9-]+-seosa\.vercel\.app\/\?_vercel_share=[A-Za-z0-9_-]+/.test(share||''))throw Error('Require approved Preview share link and gate/full phase');
const base=new URL(share).origin;
const outdir=path.resolve(__dirname,'../reports/ai-v3-online-20261105');
mkdirSync(outdir,{recursive:true});
const outfile=path.join(outdir,mode+'.jsonl'),summaryfile=path.join(outdir,mode+'-summary.json');
writeFileSync(outfile,'');
const gate=[
{id:'G01',p:'15만원 이하 무선 헤드셋 추천해줘. 게이밍은 제외',cat:'헤드셋',max:150000,exclude:['게이밍']},
{id:'G02',p:'그중에서 12만원 이상 15만원 이하로 골라줘',from:'G01',cat:'헤드셋',min:120000,max:150000,exclude:['게이밍']},
{id:'G03',p:'에어팟 4 ANC 완제품 추천해줘',cat:'이어폰',model:'에어팟 4 ANC'},
{id:'G04',p:'갤럭시탭 S9 FE 128GB 추천해줘',cat:'태블릿',model:'갤럭시탭 S9 FE 128GB'},
{id:'G05',p:'갤럭시탭 S9 FE+ 128GB 추천해줘',cat:'태블릿',model:'갤럭시탭 S9 FE+ 128GB'},
{id:'G06',p:'아이패드 에어 M4 256GB 추천해줘',cat:'태블릿',model:'아이패드 에어 M4 256GB'},
{id:'G07',p:'돈은 80만원밖에 못 써요',from:'G06',cat:'태블릿',max:800000,model:'아이패드 에어 M4 256GB',allowEmpty:true},
{id:'G08',p:'아이패드 에어 M4와 갤럭시탭 S9 FE 비교해줘',cat:'태블릿',compare:['ipad','galaxytab']},
{id:'G09',p:'일반 아이폰 16 128GB 신품 추천해줘',cat:'스마트폰',model:'아이폰 16 128GB',allowEmpty:true},
{id:'G10',p:'1TB 외장하드 하나 추천해줘. 책 말고 저장장치',cat:'외장하드',containsAny:['외장하드','외장 ssd','외장ssd','외장 hdd','외장hdd'],noWords:['도서','책']}
];
const groups=[
['헤드셋',[
'15만원 이하 헤드셋 추천해줘','12만원에서 15만원 사이의 무선 헤드폰 찾아줘','게이밍 제외하고 블루투스 헤드셋 골라줘','10만원 미만 헤드폰 있을까?','15만원 안에서 ANC 헤드폰 추천','20만원 이하 노이즈캔슬링 헤드폰 추천','가성비 무선 헤드셋 추천해줘','게임용 아닌 공부할 때 쓸 헤드폰 추천','12만~15만원 헤드셋 추천','소니 블루투스 헤드폰 15만원 이하로 골라줘'
]],
['이어폰',[
'에어팟 4 ANC 추천해줘','에어팟 프로 2세대 추천해줘','에어팟 4 일반 모델 찾아줘','에어팟 4세대 노이즈 캔슬링 버전 추천','갤럭시 버즈 FE 추천해줘','삼성 갤럭시 버즈3 프로 추천해줘','10만원 이하 무선 이어폰 추천','5만원대 가성비 블루투스 이어폰','운동할 때 쓸 이어버드 추천해줘','이어폰 본체만 추천해줘 케이스 말고'
]],
['태블릿',[
'갤럭시탭 S9 FE 128GB 찾아줘','갤럭시탭 S9 FE+ 128GB 추천','갤럭시탭 S9 FE 256GB 제품 추천','아이패드 에어 M4 256GB 추천해줘','아이패드 에어 M4 128GB 추천해줘','아이패드 10세대 64GB 추천','갤럭시탭 S10 256GB 추천','11인치 아이패드 에어 M4 추천','100만원 이하 태블릿 뭐가 좋아?','아이패드 vs 갤럭시탭 가격 비교해줘'
]],
['스마트폰',[
'아이폰 16 128GB 신품 추천','아이폰 16e 128GB 찾아줘','아이폰 16 프로 128GB 추천','아이폰 15 128GB 추천해줘','아이폰 16 프로 맥스 256GB 추천','갤럭시 S24 256GB 추천해줘','삼성 갤럭시 S25 256GB 신품 추천','100만원 이하 스마트폰 추천해줘','중고 빼고 휴대폰 80만원 이하로 골라줘','아이폰 16과 갤럭시 S25 가격 비교해줘'
]],
['노트북',[
'80만원 이하 가벼운 노트북 추천','100만원 이하 대학생용 노트북','LG 그램 노트북 추천해줘','맥북 에어 M4 256GB 추천','맥북 프로 M4 512GB 추천','게임용 제외하고 사무용 노트북 추천','삼성 갤럭시북 15인치 찾아줘','70만원부터 90만원까지 노트북 추천','휴대성 좋은 윈도우 노트북 추천','노트북 추천 하나만 해줘'
]],
['외장하드',[
'1TB 외장하드 추천해줘','2TB 외장하드 추천해줘','5만원 이하 외장 SSD 추천','삼성 외장 SSD T7 1TB 추천','씨게이트 외장하드 2TB 추천','맥북 연결용 외장 SSD 추천','휴대용 외장 하드디스크 추천','10만원 이하 USB 외장하드','500GB 외장하드 추천해줘','2테라 데이터 백업용 외장하드 찾아줘'
]],
['모니터',[
'20만원 이하 모니터 추천','27인치 모니터 추천','32인치 4K 모니터 찾아줘','사무용 모니터 15만원 이하','게이밍 아닌 눈 편한 모니터 추천','LG 27인치 모니터 추천','삼성 모니터 24인치 찾아줘','30만원 이하 144Hz 모니터','작업용 듀얼 모니터 추천','20만~30만원 모니터 추천'
]],
['주변기기',[
'10만원 이하 무선 키보드 추천','로지텍 기계식 키보드 추천','블루투스 키보드 찾아줘','5만원 이하 마우스 추천','로지텍 MX Master 마우스 추천','사무용 무소음 마우스 추천','15만원 이하 기계식 키보드','아이패드용 블루투스 키보드 추천','게이밍 말고 사무용 키보드 추천','손목 편한 무선 마우스 찾아줘'
]],
['가전',[
'20만원 이하 공기청정기 추천','침실용 소형 공기청정기 추천','산업용 말고 집에서 쓸 공기청정기','30만원 이하 공기청정기 찾아줘','50만원 이하 로봇청소기 추천','무선청소기 20만원 이하 추천','작은 원룸용 청소기 찾아줘','로보락 로봇청소기 추천','부담 없는 가격의 공기청정기 하나','집에서 쓸 청소기와 공기청정기 비교'
]]
];
const full=[];
for(let g=0;g<groups.length;g++)for(let j=0;j<10;j++){
 const group=groups[g][0],p=groups[g][1][j],id='Q'+String(full.length+1).padStart(3,'0');
 const cat=group==='주변기기'?(p.includes('마우스')?'마우스':'키보드'):group==='가전'?(p.includes('공기청정기')?'공기청정기':'청소기'):group;
 const compare=p.includes('비교')?null:undefined;
 full.push({id,p,cat,compare,model:!p.includes('비교')?p:undefined});
}
const follow=[
 {p:'15만원 이하 비게이밍 헤드셋 추천해줘',cat:'헤드셋',max:150000,exclude:['게이밍']},
 {p:'그중 12만원 이상으로만 골라줘',cat:'헤드셋',from:'Q091',min:120000,max:150000,exclude:['게이밍']},
 {p:'그중에서 한 개만 추천해줘',cat:'헤드셋',from:'Q092',min:120000,max:150000,exclude:['게이밍']},
 {p:'아이패드 에어 M4 256GB 보여줘',cat:'태블릿',model:'아이패드 에어 M4 256GB'},
 {p:'예산은 80만원이야',cat:'태블릿',from:'Q094',max:800000,model:'아이패드 에어 M4 256GB',allowEmpty:true},
 {p:'128GB 말고 256GB로 골라줘',cat:'태블릿',from:'Q094',model:'아이패드 에어 M4 256GB'},
 {p:'갤럭시탭 S9 FE와 아이패드 에어 M4 비교해줘',cat:'태블릿',compare:['galaxytab','ipad']},
 {p:'고마워!',expectNoSearch:true},
 {p:'에어팟 4 ANC 중고 말고 신품 추천',cat:'이어폰',model:'에어팟 4 ANC'},
 {p:'15만원 이하 외장하드 중에 SSD 추천',cat:'외장하드',max:150000}
];
for(let i=0;i<10;i++)full.push({id:'Q'+String(i+91).padStart(3,'0'),...follow[i]});
if(full.length!==100||new Set(full.map(x=>x.p)).size!==100)throw Error('100 unique questions required, got '+full.length+' unique '+new Set(full.map(x=>x.p)).size);
const focusIds=new Set(['Q001','Q005','Q010','Q014','Q015','Q028','Q029',
 'Q053','Q054','Q055','Q056','Q078','Q079','Q090','Q091','Q100']);
const cases=mode==='gate'?gate:mode==='focus'?
  [...gate.filter(x=>['G01','G02','G03','G10'].includes(x.id)),...full.filter(x=>focusIds.has(x.id))]:full;
const sleep=ms=>new Promise(res=>setTimeout(res,ms));
function amount(text){
 const s=text.replace(/,/g,'');
 const a=s.match(/(\d+(?:\.\d+)?)\s*(?:만원|만\s*원|만)\s*(?:이하|미만|안에서)/);
 return a?Math.round(Number(a[1])*10000):null;
}
function subjectOk(title,cat){
 if(!cat)return true;
 const primary=String(title||'').split(/\/디지털기기/i)[0];
 if(['헤드셋','헤드폰'].includes(cat)&&/(?:이어폰|이어버드|earbuds|에어팟|airpods|갤럭시\s*버즈)/i.test(primary)&&!/(?:헤드셋|헤드폰|headset|headphone)/i.test(primary))return false;
 return categoryOk({title:primary,category:''},cat);
}
const accessory=/충전기|보호필름|케이스|커버|파우치|거치대|어댑터|스트랩|충전케이블|키캡|펜촉|(?:헤드셋|헤드폰)\s*걸이|오른쪽\s*단품|왼쪽\s*단품|우측\s*단품|좌측\s*단품/i;
function verdict(test,data,previous){
 const errors=[];let unverified=[];
 if(!data||data.http!==200||data.apiStatus!==200||!Array.isArray(data.cards)){errors.push('HTTP_or_JSON_failure');return{verdict:'FAIL',errors,unverified};}
 const cards=data.cards;
 const literalCompare=comparisonFromUtterance(test.p);
 const expectedCompare=test.compare||(literalCompare?[literalCompare.category,
   require('../api/_ai-v31-taxonomy').explicitType(literalCompare.compareQuery)]:null);
 const wantWireless=/(?:무선|블루투스|wireless)/i.test(test.p) ||
   (test.from && previous?.state?.features?.wireless===true);
 if(wantWireless && data.state?.features?.wireless!==true)errors.push('wireless_constraint_not_preserved');
 if(test.expectNoSearch){if(cards.length||data.stats?.searched)errors.push('nonshopping_triggered_search');return{verdict:errors.length?'FAIL':'PASS',errors,unverified};}
 if(data.stats?.searched===false)errors.push('shopping_request_not_searched');
 if(cards.length>4)errors.push('too_many_cards');
 const checkIdentity=!test.compare&&test.model?requestedIdentity(test.model):(!test.compare?requestedIdentity(test.p):{});
 const max=test.max??amount(test.p)??(test.from?previous?.state?.maxPrice:null);
 const min=test.min??(test.from?previous?.state?.minPrice:null);
 if(test.min!=null&&data.state?.minPrice!==test.min)errors.push('min_budget_state_wrong');
 if(test.max!=null&&data.state?.maxPrice!==test.max)errors.push('max_budget_state_wrong');
 if(test.exclude?.length&&!test.exclude.every(w=>data.state?.exclusions?.includes(w)))errors.push('exclusion_state_lost');
 for(const [j,c] of cards.entries()){
  const title=String(c.title||''),pre='card'+(j+1)+':';
  if(!title||!Number.isFinite(Number(c.price))||Number(c.price)<=0||!/^https?:\/\//.test(String(c.link||'')))errors.push(pre+'invalid_listing_fields');
  if(c.condition==='used_or_refurbished'&&!/(?:중고|리퍼)\s*(?:상품)?\s*(?:추천|찾아|보여)/.test(test.p))errors.push(pre+'used_or_refurbished');
  if(accessory.test(title))errors.push(pre+'accessory_or_part');
  if(ambiguousOptions(title,test.cat))errors.push(pre+'ambiguous_options');
  if(wantWireless && ['헤드셋','헤드폰'].includes(test.cat) &&
     !/(?:무선|블루투스|wireless|bluetooth|\bBT\d|TWS)/i.test(title))
     errors.push(pre+'wireless_evidence_missing');
  if(max!=null&&Number(c.price)>max)errors.push(pre+'above_max_budget');
  if(min!=null&&Number(c.price)<min)errors.push(pre+'below_min_budget');
  if(test.exclude?.some(w=>title.includes(w)))errors.push(pre+'excluded_term');
  if(!expectedCompare&&test.cat&&!productTypeMatches(title,test.cat,test.p))
    errors.push(pre+'wrong_category');
  if(!expectedCompare&&!brandMatches(title,test.p))errors.push(pre+'wrong_brand');
  const excludedWords=[...test.p.matchAll(/([가-힣a-z0-9+]{2,20})\s*(?:말고|제외|빼고|아닌)/gi)].map(x=>x[1]);
  if(excludedWords.some(word=>title.toLowerCase().includes(word.toLowerCase())))
    errors.push(pre+'explicit_exclusion_violated');
  if(!expectedCompare&&checkIdentity.family &&
    !( /(?:용|호환|연결)/.test(test.p) &&
       familyCategory(checkIdentity.family)!==canonicalCategory({message:test.p,planCategory:test.cat}))){
    const res=checkListingIdentity(title,checkIdentity);
    if(!res.ok)errors.push(pre+'identity_'+res.reason+'_'+res.field);
  }
  if(test.noWords?.some(w=>title.includes(w)))errors.push(pre+'forbidden_subject');
  if(test.containsAny&&!test.containsAny.some(w=>title.toLowerCase().includes(w.toLowerCase())))errors.push(pre+'missing_subject');
 }
 if(expectedCompare?.length){if(cards.length===2){
   const fs=cards.map(c=>extractTitleEvidence(c.title).family);
   if(!expectedCompare.every(f=>fs.includes(f)||(
      (f==='청소기'||f==='공기청정기')&&
      cards.some(c=>require('../api/_ai-v31-taxonomy').productTypeMatches(c.title,f)))))
     errors.push('comparison_sides_mismatch');
 }else if(cards.length>0)errors.push('comparison_one_sided');
 }
 if(!cards.length&&!test.allowEmpty&&!test.expectNoSearch)unverified.push('no_suitable_cards_or_inventory');
 return{verdict:errors.length?'FAIL':unverified.length?'UNVERIFIED':'PASS',errors,unverified};
}
async function main(){
 const cookies={};let at=share,authed=false;
 for(let k=0;k<4;k++){
  const r=await fetch(at,{redirect:'manual',signal:AbortSignal.timeout(18000),
   headers:{cookie:Object.entries(cookies).map(([a,b])=>a+'='+b).join('; ')}});
  for(const v of r.headers.getSetCookie?.()||[]){const m=v.match(/^([^=;]+)=([^;]*)/);if(m)cookies[m[1]]=m[2];}
  if(r.status===200){authed=true;break;}
  const loc=r.headers.get('location');if(!loc||r.status<300||r.status>=400)break;
  at=new URL(loc,at).toString();if(!at.startsWith(base+'/'))throw Error('Auth redirect cross-origin');
 }
 if(!authed)throw Error('Preview authentication unavailable');
 console.log(JSON.stringify({stage:'authenticated',mode,questions:cases.length,deploy:base}));
 const saved={},scores={PASS:0,FAIL:0,UNVERIFIED:0},t0=Date.now(),tokens={calls:0,input:0,output:0},results=[];
 for(let i=0;i<cases.length;i++){
  const test=cases[i],previous=test.from?saved[test.from]:null,fromState=previous?.state||{};
  let data=null,responseTime=0,apiError=null;
  for(let attempt=0;attempt<2;attempt++){
   const started=Date.now();
   try{
    const r=await fetch(base+'/api/ai?v=3',{method:'POST',
      headers:{'content-type':'application/json',cookie:Object.entries(cookies).map(([a,b])=>a+'='+b).join('; ')},
      body:JSON.stringify({message:test.p,history:[],state:fromState}),signal:AbortSignal.timeout(65000)});
    const raw=await r.text();let d;try{d=JSON.parse(raw)}catch{d={error:'non_json_response'}}
    data={...d,http:r.status,apiStatus:d.status??null};
    responseTime=Date.now()-started;
    if([429,503].includes(r.status)&&attempt===0){await sleep(12000);continue}
    break;
   }catch(e){apiError=String(e.name)+':'+String(e.message).slice(0,100);responseTime=Date.now()-started;
    if(attempt===0){await sleep(6000);continue}
   }
  }
  if(!data)data={http:0,apiStatus:0,error:apiError,cards:null};
  saved[test.id]=data;
  const v=verdict(test,data,previous);
  scores[v.verdict]++;
  const u=data.stats?.modelUsage||{};
  tokens.calls+=(u.calls||0);tokens.input+=(u.inputTokens||0);tokens.output+=(u.outputTokens||0);
  const record={id:test.id,question:test.p,from:test.from??null,http:data.http,apiStatus:data.apiStatus,elapsedMs:responseTime,
    verdict:v.verdict,errors:v.errors,unverified:v.unverified,
    cards:(Array.isArray(data.cards)?data.cards:[]).map(c=>({title:c.title,price:c.price,condition:c.condition,link:c.link})),
    answer:String(data.answer||data.error||'').slice(0,650),
    stats:{searched:data.stats?.searched,inspected:data.stats?.inspected,accepted:data.stats?.accepted,rejectedReasons:data.stats?.rejectedReasons||{},modelUsage:data.stats?.modelUsage||null},
    state:{lastQuery:data.state?.lastQuery,category:data.state?.category,maxPrice:data.state?.maxPrice,minPrice:data.state?.minPrice,exclusions:data.state?.exclusions,identity:data.state?.identity,features:data.state?.features}};
  appendFileSync(outfile,JSON.stringify(record)+'\n');
  results.push(record);
  console.log(JSON.stringify({id:test.id,verdict:v.verdict,http:data.http,cards:record.cards.length,errors:v.errors,unverified:v.unverified,
    firstTitle:record.cards[0]?.title?.slice(0,85),firstPrice:record.cards[0]?.price,elapsedMs:responseTime,counts:{...scores}}));
  if(data.http===429){console.log(JSON.stringify({stage:'rate_limited_stop',at:test.id}));break;}
  if(tokens.calls>235||tokens.input+tokens.output>220000){console.log(JSON.stringify({stage:'usage_guard_stop',at:test.id,tokens}));break;}
  if(i+1<cases.length)await sleep(2800);
 }
 const summary={mode,deploy:base,ran:results.length,expected:cases.length,scores,tokens,elapsedSeconds:Math.round((Date.now()-t0)/1000),
    failures:results.filter(x=>x.verdict==='FAIL').map(x=>({id:x.id,question:x.question,reasons:x.errors})),
    unresolved:results.filter(x=>x.verdict==='UNVERIFIED').map(x=>({id:x.id,question:x.question}))};
 writeFileSync(summaryfile,JSON.stringify(summary,null,2));
 console.log(JSON.stringify({stage:'DONE',...summary,failures:summary.failures.slice(0,30),unresolved:summary.unresolved.slice(0,20)}));
}
main().catch(e=>{console.error(JSON.stringify({stage:'FATAL',errorType:e.name,message:String(e.message)}));process.exitCode=1;});
