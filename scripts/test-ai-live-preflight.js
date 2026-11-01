'use strict';
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const cmd=path.join(__dirname,'verify-ai-live.js');
const base={...process.env,OPENAI_API_KEY:'',OPENROUTER_API_KEY:'',
  COUPANG_ACCESS_KEY:'',COUPANG_SECRET_KEY:'',ADPICK_API_KEY:'',
  SUPABASE_URL:'',SUPABASE_SECRET_KEY:'',NEON_DATABASE_URL:'',
  VERCEL_ENV:'preview',SEOSA_LIVE_MAX_USD:''};
let ok=0,fail=0;
function check(name,env,args,fragment){
  const p=spawnSync(process.execPath,[cmd,...args],{env:{...base,...env},encoding:'utf8',timeout:10000});
  const result=(p.stderr||'')+'\n'+(p.stdout||'');
  if(p.status===2&&result.includes(fragment)){
    ok++;console.log('PASS',name);
  }else{
    fail++;console.error('FAIL',name,'status=',p.status,'reason=',result.slice(0,240));
  }
}
check('Production not allowed even with keys',{VERCEL_ENV:'production'},['--ask','이어폰','--max-usd','1'],'production_environment');
check('No cost limit not allowed',{},['--ask','이어폰'],'max_usd');
check('Negative spend limit not allowed',{},['--ask','이어폰','--max-usd','-2'],'max_usd');
check('Over 5-dollar spend limit not allowed',{},['--ask','이어폰','--max-usd','6'],'max_usd');
check('No paid provider is not a live test',{},['--ask','이어폰','--max-usd','0.5'],'llm_credentials');
check('No marketplace provider is not a real search test',{OPENAI_API_KEY:'redacted-test-nonworking-key'},['--ask','이어폰','--max-usd','0.5'],'marketplace_credentials');
check('No database connection is not a real-evidence test',
 {OPENAI_API_KEY:'redacted-test-nonworking-key',ADPICK_API_KEY:'test-value'},
 ['--ask','이어폰','--max-usd','0.5'],'database_credentials');
console.log('LIVE_PREFLIGHT_SUMMARY',JSON.stringify({asked:ok+fail,pass:ok,fail,realCalls:0,dbWrites:0}));
if(fail)process.exitCode=1;
