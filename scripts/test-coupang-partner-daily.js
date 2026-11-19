#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict');
const S=require('./sync-coupang-partner-daily');
let pass=0;
function ok(x,name){assert.ok(x,name);pass++;console.log('[PASS] '+name)}
const date='20261118',subId='SEOSA2026';
const C={rCode:'0',data:[{date,subId,trackingCode:'masked',click:3,addtag:'400'},
  {date,subId,trackingCode:'masked',click:2,addtag:'404'}]};
const M={rCode:'0',data:[{date,subId,trackingCode:'masked',click:5,commission:210,gmv:7000,order:1,cancel:0}]};
const E={rCode:'0',data:[]};
const r=S.consolidate(C,M,date);
ok(r.canWrite&&r.daily.clicks===5,'partner click rows correctly aggregated');
ok(r.daily.orders===1&&r.daily.commission===210&&r.daily.gmv===7000,'partner commission row preserves reported values');
ok(r.daily.report_date==='2026-11-18'&&r.daily.sub_id===subId,'day and channel preserved');
ok(r.evidence==='official_partner_aggregated_preliminary','earnings explicitly preliminary');
ok(!S.consolidate(E,E,date).canWrite,'no partner rows never become fabricated zero revenue');
ok(S.consolidate(E,M,date).daily.clicks===null,'missing click report is unknown, not zero');
ok(S.consolidate(C,E,date).daily.commission===null,'missing commission report is unknown, not zero');
assert.throws(()=>S.parseRows({rCode:'401',data:[]},'clicks',date));ok(true,'partner nonzero rCode rejected');
assert.throws(()=>S.parseRows({rCode:'0',data:{}},'clicks',date));ok(true,'non-array report rejected');
assert.throws(()=>S.parseRows({rCode:'0',data:[{date,subId:'OTHERS2026',click:1}]},'clicks',date));ok(true,'foreign SUBID rejected');
assert.throws(()=>S.parseRows({rCode:'0',data:[{date:'20261117',subId,click:1}]},'clicks',date));ok(true,'other date rejected');
assert.throws(()=>S.parseRows({rCode:'0',data:[{date,subId,click:-1}]},'clicks',date));ok(true,'negative click rejected');
assert.throws(()=>S.parseRows({rCode:'0',data:[{date,subId,click:'infinite'}]},'clicks',date));ok(true,'non-numeric click rejected');
assert.throws(()=>S.parseRows({rCode:'0',data:Array(1000).fill({date,subId,click:0})},'clicks',date));ok(true,'page cap prevents incomplete total');
ok(S.argsOf(['--date=20261118']).write===false,'CLI defaults dry-run');
ok(S.argsOf(['--date=20261118','--write','--dry-run']).write===false,'--dry-run overrides --write');
ok(S.argsOf(['--date=20261118','--write']).write===true,'explicit --write recognized');
ok(S.publishedDate('21000101')===false,'future partner dates rejected');
ok(S.publishedDate('bad')===false,'non-date input rejected');
console.log('PASS '+pass+' / FAIL 0 (offline; provider API 0; DB writes 0)');
