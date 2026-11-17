'use strict';
// This program never edits its fixed inputs or production DB. A failure must
// not be interpreted as a deployment failure: evaluate fixability separately.

// First-run one-time NEW 100 synthetic holdout questions.
// The real /api/search handler, relevantItems, ranker, gate and save pipeline
// execute against injected synthetic provider candidates and a mock database.
// This is NOT a live supplier or production evaluation.
const fs=require('fs'),path=require('path'),Module=require('module'),crypto=require('crypto'),{performance}=require('perf_hooks');
const root=path.resolve(__dirname,'../..');
const dataDir=path.join(root,'reports','search-eval');
const qPath=path.join(dataDir,'fresh-holdout-100-20261117.json');
const preregPath=path.join(dataDir,'fresh-holdout-100-preregistration.json');
const prereg=JSON.parse(fs.readFileSync(preregPath,'utf8'));
const qbytes=fs.readFileSync(qPath);
const gitBlob=crypto.createHash('sha1')
  .update('blob '+qbytes.length+String.fromCharCode(0))
  .update(qbytes).digest('hex');
if(gitBlob!==prereg.dataset_git_blob_sha1)
  throw Error('Frozen challenge data blob hash mismatch: '+gitBlob);
const dataset=JSON.parse(qbytes.toString('utf8'));
if(!Array.isArray(dataset.questions)||dataset.questions.length!==100)
  throw Error('Expected exactly 100 freshly frozen holdout questions');
const splitName='holdout';
const full=dataset.questions;
const norm=x=>String(x||'').toLowerCase().replace(/\s+/g,'');
const allIds=new Set(),allTexts=new Set(),families=new Set();
for (const q of full) {
 if(!q || !q.id || !q.family_id || q.split!=='holdout')
   throw Error('Invalid question record');
 if(allIds.has(q.id)||allTexts.has(norm(q.query)))throw Error('Duplicate benchmark id or query: '+q.id);
 allIds.add(q.id);allTexts.add(norm(q.query));
 families.add(q.family_id);
 if(q.items.length!==5)throw Error('Expected five candidates '+q.id);
 const targets=q.items.filter(x=>x.verdict==='PASS');
 const zeroTargets=q.scenario==='no_eligible_new_product';
 if(targets.length!==(zeroTargets?0:2))throw Error('Incorrect positive count '+q.id);
 for(const it of q.items){
   if(!['PASS','FAIL','UNVERIFIED'].includes(it.verdict)||!Number.isFinite(it.price_krw)||it.price_krw<=0)
     throw Error('Invalid judgment/price '+it.id);
   if(q.price_cap_krw!=null && it.reason==='above hard budget' && it.price_krw<=q.price_cap_krw)
     throw Error('Pre-registered over-budget mislabel '+it.id);
   if(q.price_cap_krw!=null && it.verdict==='PASS' && it.price_krw>q.price_cap_krw)
     throw Error('Pre-registered PASS over budget '+it.id);
 }
}
if(families.size!==20)throw Error('Expected 20 new product families');
const subset=full;
if(subset.length!==100)throw Error('Fresh holdout count mismatch');
const questions=subset.map(q=>({
 ...q,candidates:q.items.map(it=>({
   id:it.id,title:it.title,price_krw:it.price_krw,condition:it.condition
 }))
}));
const byQuestion=new Map(subset.map(q=>[
 q.id,new Map(q.items.map(c=>[c.id,{verdict:c.verdict,reason:c.reason}]))
]));
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const codeFiles=['api/search.js','api/_shop.js','api/_search.js','api/_product-gate.js'];
const codeHashes=Object.fromEntries(codeFiles.map(p=>[p,sha(path.join(root,p))]));
const apiFiles=fs.readdirSync(path.join(root,'api')).filter(p=>p.endsWith('.js')).sort().map(p=>'api/'+p);
const apiFingerprint=()=>crypto.createHash('sha256').update(apiFiles.map(p=>p+':'+sha(path.join(root,p))).join('\n')).digest('hex');
const initialApiFingerprint=apiFingerprint();
for(const k of ['SUPABASE_URL','SUPABASE_SERVICE_KEY','SUPABASE_SERVICE_ROLE_KEY','NEON_DATABASE_URL','DATABASE_URL','IDENTITY_CANONICAL_CONSUMER_ENABLED','SEOSA_DB_READONLY']) delete process.env[k];
process.env.SEOSA_DB_BACKEND='supabase';let externalCalls=0,dbReads=0,writes=[];
global.fetch=async()=>{externalCalls++;throw Error('external network disabled by synthetic evaluator');};
function fakeQuery(table){const o={};for(const m of ['select','eq','in','gte','lte','lt','gt','order','limit','range','is','not','or','filter','match','neq','ilike','like','contains'])o[m]=()=>o;o.maybeSingle=()=>Promise.resolve({data:null,error:null});o.single=()=>Promise.resolve({data:null,error:null});for(const kind of ['upsert','insert'])o[kind]=rows=>{writes.push({table,kind,rows:Array.isArray(rows)?rows:[rows]});return Promise.resolve({data:null,error:null});};o.update=()=>{writes.push({table,kind:'update',rows:[]});return o;};o.delete=()=>{writes.push({table,kind:'delete',rows:[]});return o;};o.then=(resolve,reject)=>{dbReads++;return Promise.resolve({data:[],error:null}).then(resolve,reject);};return o;}
const db={from:t=>fakeQuery(t),rpc:()=>{dbReads++;return Promise.resolve({data:[],error:null});}};
const realLoad=Module._load;Module._load=function(req,parent,isMain){if(parent&&/[\\/]api[\\/]/.test(parent.filename)&&(req==='./_supabase'||req==='./_supabase.js'))return db;return realLoad.apply(this,arguments);};
const shop=require(path.join(root,'api/_shop')),trust=require(path.join(root,'api/_trust')),facets=require(path.join(root,'api/_facets'));
require(path.join(root,'api/_ratelimit')).guard=()=>true;
let currentPool=[],stage={};
shop.searchAll=async keyword=>{const kept=shop.relevantItems(keyword,currentPool.map(x=>({...x}))).kept;stage.providerReturned=kept.map(it=>it.productId);return{items:kept,from:'api',failed:false,blocked:false,errors:[],providerSources:{coupang:'api',adpick:'api'},providerBlocked:{coupang:false,adpick:false},freshAnswered:true};};
trust.attachTrust=async()=>{};facets.attachPriceChange=async()=>{};
const search=require(path.join(root,'api/_search')),origRank=search.rankItems;search.rankItems=(...args)=>{const ret=origRank(...args);stage.rankOutput=(ret.items||[]).map(it=>({id:it.productId,score:it.relevance}));return ret;};
const gate=require(path.join(root,'api/_product-gate')),origGate=gate.gateItems;gate.gateItems=(...args)=>{const ret=origGate(...args);if(!stage.gate){stage.gate={input:(args[1]||[]).map(it=>it.productId),kept:(ret.kept||[]).map(it=>it.productId),rejected:(ret.rejected||[]).map(it=>({id:it.item&&it.item.productId,hard:it.hard,soft:it.soft}))};}return ret;};
const handler=require(path.join(root,'api/search'));
const pct=(n,d)=>d?Number((100*n/d).toFixed(2)):null;
async function run(q){stage={};currentPool=q.candidates.map(c=>({title:c.title,productId:c.id,mall:'쿠팡',lprice:c.price_krw,condition:c.condition,link:'https://example.com/'+c.id,isCoupang:true,_source:'api'}));const startWrites=writes.length;
 const res={statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.statusCode=n;return this;},json(x){this.body=x;return this;},end(){return this;}};
 const log=console.log,warn=console.warn,error=console.error;let errorText='';console.log=()=>{};console.warn=()=>{};console.error=(...x)=>{errorText+=x.join(' ').slice(0,500);};const start=performance.now();try{await handler({method:'GET',headers:{},query:{keyword:q.query}},res);}finally{console.log=log;console.warn=warn;console.error=error;}
 const ms=performance.now()-start,body=Array.isArray(res.body)?res.body:[], map=byQuestion.get(q.id);if(!map)throw Error('missing answers '+q.id);
 const shown=body.map(it=>({id:String(it.productId||''),verdict:map.get(String(it.productId||''))?.verdict||'UNVERIFIED',identity:it.identity||null}));const top=shown.slice(0,5),correct=[...map].filter(([,v])=>v.verdict==='PASS').map(([id])=>id),seen=new Set(shown.slice(0,10).map(x=>x.id));const validCorrect=correct.filter(id=>seen.has(id));
 const wrong=top.filter(x=>x.verdict==='FAIL'),unknown=top.filter(x=>x.verdict==='UNVERIFIED');
 const productWrites=writes.slice(startWrites).filter(w=>w.table==='products'&&w.kind==='upsert').flatMap(w=>w.rows)
   .map(row=>({id:String(row.product_id||row.productId||''),verdict:map.get(String(row.product_id||row.productId||''))?.verdict||'UNVERIFIED'}));
 const savedWrong=productWrites.filter(x=>x.verdict==='FAIL'),savedUnknown=productWrites.filter(x=>x.verdict==='UNVERIFIED');
 let verdict,reason;
 if(res.statusCode!==200||!Array.isArray(res.body)){verdict='UNVERIFIED';reason='handler_error';}
 else if(wrong.length){verdict='FAIL';reason='contradictory_candidate_shown';}
 else if(savedWrong.length){verdict='FAIL';reason='contradictory_candidate_saved';}
 else if(!correct.length && !top.length && !productWrites.length){verdict='PASS';reason='correctly_no_results';}
 else if(!correct.length && (top.length||productWrites.length)){verdict='FAIL';reason='no_eligible_product_but_results';}
 else if(correct.length && !validCorrect.length){verdict='FAIL';reason='all_fixture_targets_missed';}
 else if(unknown.length||savedUnknown.length){verdict='UNVERIFIED';reason='candidate_evidence_incomplete';}
 else if(!top.length){verdict='FAIL';reason='no_results_when_target_exists';}
 else{verdict='PASS';reason='';}
 const missing=correct.filter(id=>!seen.has(id)).map(id=>{let where='unknown';if(!(stage.providerReturned||[]).includes(id))where='provider_relevance_filter';else if(!stage.gate||!stage.gate.input.includes(id))where='ranking_or_score_floor';else if((stage.gate.rejected||[]).some(x=>x.id===id))where='product_gate';else if(stage.gate.kept.includes(id))where='post_gate_or_result_cutoff';return{id,where};});
 return{id:q.id,verdict,reason,status:res.statusCode,handlerError:errorText||undefined,ms:Number(ms.toFixed(3)),fixtureCount:q.candidates.length,shownCount:shown.length,top,fixtureTargets:correct.length,targetsShownTop10:validCorrect.length,missedTargets:missing,providerReturned:(stage.providerReturned||[]).length,gate:stage.gate||null,productWrites};}
(async()=>{const rows=[];for(const q of questions)rows.push(await run(q));for(const p of codeFiles)if(sha(path.join(root,p))!==codeHashes[p])throw Error('code changed while evaluation was running: '+p);if(apiFingerprint()!==initialApiFingerprint)throw Error('API files changed while evaluation was running');const counts=Object.fromEntries(['PASS','FAIL','UNVERIFIED'].map(v=>[v,rows.filter(r=>r.verdict===v).length]));const top=rows.flatMap(r=>r.top),stored=rows.flatMap(r=>r.productWrites),targets=rows.reduce((a,r)=>a+r.fixtureTargets,0),returned=rows.reduce((a,r)=>a+r.targetsShownTop10,0),lat=rows.map(r=>r.ms).sort((a,b)=>a-b);const misses={};rows.flatMap(r=>r.missedTargets).forEach(x=>misses[x.where]=(misses[x.where]||0)+1);const summary={generated_at_utc:new Date().toISOString(),scope:'fresh 100 synthetic holdout, real search handler, mocked supplier/DB',split:splitName,question_count:rows.length,total_frozen_questions:full.length,zero_target_question_count:subset.filter(q=>q.items.every(x=>x.verdict==='FAIL')).length,zero_target_correctly_empty:rows.filter(r=>r.reason==='correctly_no_results').length,code_anchor:prereg.base_code_commit,prereg_blob_sha1:gitBlob,...counts,verifiable_accuracy_percent:pct(counts.PASS,counts.PASS+counts.FAIL),top5_candidates:top.length,top5_verified_correct:top.filter(x=>x.verdict==='PASS').length,top5_confirmed_wrong:top.filter(x=>x.verdict==='FAIL').length,top5_unverified:top.filter(x=>x.verdict==='UNVERIFIED').length,precision_among_displayed_at_5_percent:pct(top.filter(x=>x.verdict==='PASS').length,top.length),precision_at_5_strict_percent:pct(top.filter(x=>x.verdict==='PASS').length,rows.length*5),fixture_target_recall_at_10_percent:pct(returned,targets),zero_result_questions:rows.filter(x=>x.shownCount===0).length,missing_targets_by_stage:misses,saved_rows:stored.length,saved_confirmed_wrong:stored.filter(x=>x.verdict==='FAIL').length,saved_unverified:stored.filter(x=>x.verdict==='UNVERIFIED').length,latency_ms_mean:Number((lat.reduce((a,b)=>a+b,0)/lat.length).toFixed(3)),latency_ms_p95:lat[Math.ceil(lat.length*.95)-1],external_fetch_attempts:externalCalls,mocked_db_reads:dbReads,source_hashes:codeHashes,api_js_count:apiFiles.length,api_js_fingerprint:initialApiFingerprint,input_hashes:{questions:sha(qPath),preregistration:sha(preregPath)},limitations:['The provider is stubbed with five supplied synthetic candidates, then the real relevantItems filter runs; no Coupang or ADPICK HTTP or production rate limiter is exercised.','Search handler, relevance ranking, product gate, and real saveProducts logic run against a mocked DB.','Fixture target recall is limited to known synthetic candidates, not catalog or service recall.','Synthetic titles and prices are artificial; latency excludes real providers and databases.','This fresh 100-question synthetic holdout is unseen to the code; not a representative random or real-supplier sample.','Missing evidence is UNVERIFIED; a displayed unknown never counts as correct; per-question precision uses 5 as denominator, not number of cards displayed.']};const outAt=process.argv.indexOf('--out');const outfile=outAt>=0?process.argv[outAt+1]:null;if(outfile){fs.mkdirSync(path.dirname(path.resolve(outfile)),{recursive:true});fs.writeFileSync(path.resolve(outfile),JSON.stringify({summary,results:rows},null,2)+'\n',{flag:'wx'});}console.log('FRESH_HOLDOUT_100_'+splitName.toUpperCase()+'_SUMMARY '+JSON.stringify(summary));
const failExamples=rows.filter(r=>r.verdict!=='PASS').slice(0,20)
  .map(r=>({id:r.id,verdict:r.verdict,reason:r.reason,shown:r.shownCount,
    missed:r.missedTargets.slice(0,3),wrongTop:r.top.filter(t=>t.verdict==='FAIL').map(t=>t.id)}));
console.log('FRESH_HOLDOUT_100_'+splitName.toUpperCase()+'_FAILURES '+JSON.stringify(failExamples));
const enforce=process.argv.includes('--enforce');
const accuracy=counts.PASS/(counts.PASS+counts.FAIL||1);
const unknownRate=counts.UNVERIFIED/rows.length;
const confirmedWrong=summary.top5_confirmed_wrong+summary.saved_confirmed_wrong;
if(enforce&&(accuracy<0.95||unknownRate>0.1||confirmedWrong>0||
 summary.fixture_target_recall_at_10_percent<95)){
  console.error('FRESH_HOLDOUT_100_'+splitName.toUpperCase()+'_NOT_READY: quality gate failed (synthetic only).');
  process.exitCode=1;
}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
