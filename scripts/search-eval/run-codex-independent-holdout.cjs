'use strict';
// Frozen-code-only holdout evaluation. No provider or database network requests.
// Usage: node scripts/search-eval/run-codex-independent-holdout.cjs --commit <40-char-sha> --out <new-output-json>
// Output is created exclusively: an existing report is never overwritten.
const fs=require('fs'),path=require('path'),Module=require('module'),crypto=require('crypto'),{performance}=require('perf_hooks');
const root=path.resolve(__dirname,'../..');
const cp=require('child_process');
const args=process.argv.slice(2);
function argument(name){const i=args.indexOf(name);return i>=0 ? args[i+1] : null;}
const frozenCommit=argument('--commit'),outfile=argument('--out');
if(!frozenCommit||!/^[a-f0-9]{40}$/i.test(frozenCommit)||!outfile)throw Error('Provide --commit <full fixed commit SHA> and --out <new output file>.');
const outputPath=path.resolve(outfile);
if(fs.existsSync(outputPath))throw Error('Output exists; refusing to overwrite.');
function git(argv){return cp.execFileSync('git',argv,{cwd:root,encoding:'utf8'}).trim();}
function checkFrozen(){
  const current=git(['rev-parse','HEAD']);
  if(current.toLowerCase()!==frozenCommit.toLowerCase())throw Error('HEAD does not match the preregistered fixed commit.');
  try { cp.execFileSync('git',['diff','--quiet','HEAD','--'],{cwd:root,stdio:'ignore'}); } catch (_) { throw Error('Tracked files differ from the fixed commit.'); }
  const required=['scripts/search-eval/run-codex-independent-holdout.cjs','reports/codex-independent-20261116/preregistration.json','reports/codex-independent-20261116/holdout-questions.json','reports/codex-independent-20261116/holdout-answers.json'];
  const dirty=git(['status','--porcelain','--untracked-files=all','--','api','package.json','package-lock.json',...required]);
  if(dirty)throw Error('API, dependency manifests, or evaluator have tracked or untracked changes; commit the frozen code before evaluation.');
  for(const file of required)git(['ls-files','--error-unmatch',file]);
}
checkFrozen();
const dataDir=path.join(root,'reports','codex-independent-20261116');
const qPath=path.join(dataDir,'holdout-questions.json'), aPath=path.join(dataDir,'holdout-answers.json');
const prereg=JSON.parse(fs.readFileSync(path.join(dataDir,'preregistration.json'),'utf8'));
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
for(const p of [qPath,aPath]) if(sha(p)!==prereg.files[path.basename(p)].sha256) throw Error('preregistered holdout file hash mismatch: '+p);
const questions=JSON.parse(fs.readFileSync(qPath,'utf8')),answers=JSON.parse(fs.readFileSync(aPath,'utf8'));
if(questions.length!==120||answers.length!==120) throw Error('unexpected holdout corpus size');
const byQuestion=new Map(answers.map(a=>[a.id,new Map(a.judgments.map(j=>[j.candidate_id,j]))]));
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
 const wrong=top.filter(x=>x.verdict==='FAIL'),unknown=top.filter(x=>x.verdict==='UNVERIFIED');let verdict,reason;
 if(res.statusCode!==200||!Array.isArray(res.body)){verdict='UNVERIFIED';reason='handler_error';}
 else if(wrong.length){verdict='FAIL';reason='contradictory_candidate_shown';}
 else if(correct.length&&!validCorrect.length){verdict='FAIL';reason='all_fixture_targets_missed';}
 else if(unknown.length){verdict='UNVERIFIED';reason='candidate_evidence_incomplete';}
 else if(!correct.length||!top.length){verdict='UNVERIFIED';reason='no_verified_target_or_cards';}
 else{verdict='PASS';reason='';}
 const productWrites=writes.slice(startWrites).filter(w=>w.table==='products'&&w.kind==='upsert').flatMap(w=>w.rows).map(row=>({id:String(row.product_id||row.productId||''),verdict:map.get(String(row.product_id||row.productId||''))?.verdict||'UNVERIFIED'}));
 const missing=correct.filter(id=>!seen.has(id)).map(id=>{let where='unknown';if(!(stage.providerReturned||[]).includes(id))where='provider_relevance_filter';else if(!stage.gate||!stage.gate.input.includes(id))where='ranking_or_score_floor';else if((stage.gate.rejected||[]).some(x=>x.id===id))where='product_gate';else if(stage.gate.kept.includes(id))where='post_gate_or_result_cutoff';return{id,where};});
 return{id:q.id,verdict,reason,status:res.statusCode,handlerError:errorText||undefined,ms:Number(ms.toFixed(3)),fixtureCount:q.candidates.length,shownCount:shown.length,top,fixtureTargets:correct.length,targetsShownTop10:validCorrect.length,missedTargets:missing,providerReturned:(stage.providerReturned||[]).length,gate:stage.gate||null,productWrites};}
(async()=>{const rows=[];for(const q of questions)rows.push(await run(q));for(const p of codeFiles)if(sha(path.join(root,p))!==codeHashes[p])throw Error('code changed while evaluation was running: '+p);if(apiFingerprint()!==initialApiFingerprint)throw Error('API files changed while evaluation was running');const counts=Object.fromEntries(['PASS','FAIL','UNVERIFIED'].map(v=>[v,rows.filter(r=>r.verdict===v).length]));const top=rows.flatMap(r=>r.top),stored=rows.flatMap(r=>r.productWrites),targets=rows.reduce((a,r)=>a+r.fixtureTargets,0),returned=rows.reduce((a,r)=>a+r.targetsShownTop10,0),lat=rows.map(r=>r.ms).sort((a,b)=>a-b);const misses={};rows.flatMap(r=>r.missedTargets).forEach(x=>misses[x.where]=(misses[x.where]||0)+1);const summary={generated_at_utc:new Date().toISOString(),scope:'frozen-code holdout; synthetic supplied fixtures; mocked provider and DB',question_count:rows.length,...counts,verifiable_accuracy_percent:pct(counts.PASS,counts.PASS+counts.FAIL),top5_candidates:top.length,top5_verified_correct:top.filter(x=>x.verdict==='PASS').length,top5_confirmed_wrong:top.filter(x=>x.verdict==='FAIL').length,top5_unverified:top.filter(x=>x.verdict==='UNVERIFIED').length,precision_at_5_lower_bound_percent:pct(top.filter(x=>x.verdict==='PASS').length,top.length),fixture_target_recall_at_10_percent:pct(returned,targets),zero_result_questions:rows.filter(x=>x.shownCount===0).length,missing_targets_by_stage:misses,saved_rows:stored.length,saved_confirmed_wrong:stored.filter(x=>x.verdict==='FAIL').length,saved_unverified:stored.filter(x=>x.verdict==='UNVERIFIED').length,latency_ms_mean:Number((lat.reduce((a,b)=>a+b,0)/lat.length).toFixed(3)),latency_ms_p95:lat[Math.ceil(lat.length*.95)-1],external_fetch_attempts:externalCalls,mocked_db_reads:dbReads,fixed_commit:frozenCommit,node_version:process.version,lockfile_sha256:sha(path.join(root,'package-lock.json')),evaluator_sha256:sha(__filename),independence_notice:'This score is independent only for the fixed commit and preregistered rules; after holdout-informed code or grader changes, a fresh holdout is required.',source_hashes:codeHashes,api_js_count:apiFiles.length,api_js_fingerprint:initialApiFingerprint,input_hashes:{questions:sha(qPath),answers:sha(aPath)},limitations:['The provider is stubbed with five supplied synthetic candidates, then the real relevantItems filter runs; no Coupang or ADPICK HTTP or production rate limiter is exercised.','Search handler, relevance ranking, product gate, and real saveProducts logic run against a mocked DB.','Fixture target recall is limited to known synthetic candidates, not catalog or service recall.','Synthetic titles and prices are artificial; latency excludes real providers and databases.','Questions reuse eight templates across 15 holdout categories; scores are not population estimates.','Missing evidence is UNVERIFIED; a displayed unknown never counts as correct.']};checkFrozen();fs.mkdirSync(path.dirname(outputPath),{recursive:true});fs.writeFileSync(outputPath,JSON.stringify({summary,results:rows},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(summary,null,2));})().catch(e=>{console.error(e.stack);process.exitCode=1;});
