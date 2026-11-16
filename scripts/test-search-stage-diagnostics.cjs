'use strict';
/* Fully offline pipeline trace test; verifies attribution, not search accuracy. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { analyzeSearchFailures } = require('./search-eval/explain-search-failures.cjs');

const fixture = {
  summary: { scope:'synthetic-only', api_js_fingerprint:'fixture-hash' },
  results: [
    { id:'a',verdict:'FAIL',shownCount:0,
      missedTargets:[
        { id:'a-1',where:'product_gate' },
        { id:'a-2',where:'ranking_or_score_floor' }
      ],
      gate:{rejected:[{id:'a-1',hard:['category_absent:사양','identity_word_absent:쓸']}]}
    },
    { id:'b',verdict:'UNVERIFIED',shownCount:1,
      missedTargets:[{id:'b-1',where:'provider_relevance_filter'}],
      gate:{rejected:[]}
    },
    { id:'c',verdict:'PASS',shownCount:2,missedTargets:[] }
  ]
};
const summary = analyzeSearchFailures(fixture,[
  {id:'a',query:'카시오 시계에 쓸 스트랩'},
  {id:'b',query:'노트북 추천'},
  {id:'c',query:'아이패드 본품'}
]);
assert.equal(summary.missedTargets,3);
assert.deepEqual(summary.outcomes,{pass:1,fail:1,unverified:1});
assert.deepEqual(summary.missingTargetsByStage,{
  provider_relevance_filter:1,ranking_or_score_floor:1,
  product_gate:1,post_gate_or_result_cutoff:0,unknown:0
});
assert.equal(summary.topGateReasons.find(x=>x.reason==='identity_word_absent').hits,1);
assert.equal(summary.topGateReasons.find(x=>x.reason==='category_absent').missingTargetsAffected,1);
assert.equal(summary.topGateReasons[0].examples[0].id,'a');
assert.equal(summary.gateMissesWithoutReason,0);

const root=path.resolve(__dirname,'..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'seosa-stage-attribution-'));
try {
  const outfile=path.join(tmp,'dev-eval.json');
  const runner=path.join(root,'scripts/search-eval/run-codex-independent-dev.cjs');
  const run=cp.spawnSync(process.execPath,[runner,outfile],{
    cwd:root,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,
    env:{...process.env,SEOSA_DB_READONLY:'1'}
  });
  assert.equal(run.status,0,((run.stderr||'')+' '+(run.stdout||'')).slice(-2500));
  const report=JSON.parse(fs.readFileSync(outfile,'utf8'));
  assert.equal(report.summary.question_count,200);
  assert.equal(report.summary.external_fetch_attempts,0);
  const actual=analyzeSearchFailures(report);
  assert.equal(actual.questions,200);
  assert.equal(actual.missedTargets,Object.values(actual.missingTargetsByStage).reduce((a,b)=>a+b,0));
  assert.ok(actual.missedTargets>0,'existing synthetic failures must remain visible, not hidden');
  assert.ok(actual.topGateReasons.length>0,'gate reasons must be available for diagnosis');
  assert.equal(actual.gateMissesWithoutReason,0,'every rejected target needs attributable reasons');
  const leading=actual.topGateReasons.slice(0,5).map(r=>r.reason+':'+r.missingTargetsAffected).join(', ');
  console.log('STAGE_TRACE_PASS: 200 offline synthetic queries, '+actual.missedTargets+
    ' missing targets; stage='+JSON.stringify(actual.missingTargetsByStage)+
    '; leading gate reasons: '+leading+'; external calls=0');
} finally {
  fs.rmSync(tmp,{recursive:true,force:true});
}
