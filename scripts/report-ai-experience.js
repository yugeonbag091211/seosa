'use strict';
/**
 * Privacy-minimal field-quality dashboard from consented real-user ratings.
 * No network, AI or DB calls; does NOT infer satisfaction from mock tests.
 * Event schema (one JSON object per line):
 * { source:"real_user", rating:1..5, helpful:true|false,
 *   correctProduct:true|false, eligibleCandidates:0..N,
 *   recommendedCandidates:0..N, latencyMs:0..N }
 *
 * Raw chat text, session IDs, email and product titles are not needed.
 */
const fs=require('node:fs');
const path=require('node:path');
const {parseJsonl}=require('./report-ai-eval-clusters');
function safeInt(n){return Number.isSafeInteger(n)&&n>=0?n:null;}
function tally(events) {
  const rows=(events||[]).filter(e=>e&&e.source==='real_user');
  let rated=0,positive=0,sum=0,helpfulYes=0,helpfulN=0,correctYes=0,correctN=0;
  let covered=0,coverageSum=0,latencySum=0,latencyN=0,invalid=0;
  for(const e of rows){
    const rating=Number(e.rating);
    if(Number.isInteger(rating)&&rating>=1&&rating<=5){rated++;sum+=rating;if(rating>=4)positive++}
    if(typeof e.helpful==='boolean'){helpfulN++;if(e.helpful)helpfulYes++}
    if(typeof e.correctProduct==='boolean'){correctN++;if(e.correctProduct)correctYes++}
    const eligible=safeInt(e.eligibleCandidates),recommended=safeInt(e.recommendedCandidates);
    if(eligible!==null&&recommended!==null){
      if(recommended>eligible){invalid++;continue}
      if(eligible>0){covered++;coverageSum+=recommended/eligible}
    }
    const latency=safeInt(e.latencyMs);
    if(latency!==null){latencyN++;latencySum+=latency}
  }
  const round=n=>Math.round(n*1000)/10;
  return {
    kind:'SEOSA_CONSENTED_REAL_USER_QUALITY',
    realUserEvents:rows.length,
    ratingResponses:rated,
    status:rated===0?'NOT_VERIFIED':rated<30?'INSUFFICIENT_SAMPLE':'OBSERVED_SAMPLE_ONLY',
    averageRating:rated?Math.round(sum/rated*100)/100:null,
    satisfiedPct:rated?round(positive/rated):null,
    helpfulPct:helpfulN?round(helpfulYes/helpfulN):null,
    productCorrectPct:correctN?round(correctYes/correctN):null,
    candidateToRecommendationPct:covered?round(coverageSum/covered):null,
    avgLatencyMs:latencyN?Math.round(latencySum/latencyN):null,
    invalidCount:invalid,
    note:'Ratings are self-selected; do not claim model correctness or population-wide user satisfaction from this summary.',
    privacy:'No user identity, raw chat transcripts or products in summary.'
  };
}
function main(args=process.argv.slice(2)){
  const arg=k=>{const i=args.indexOf(k);return i>=0?args[i+1]:null};
  const input=arg('--input'),out=arg('--out');
  if(!input){console.error('Usage: node scripts/report-ai-experience.js --input consented-events.jsonl [--out report.json]');process.exitCode=2;return}
  const result=tally(parseJsonl(fs.readFileSync(path.resolve(input),'utf8')));
  if(out){fs.mkdirSync(path.dirname(path.resolve(out)),{recursive:true});fs.writeFileSync(path.resolve(out),JSON.stringify(result,null,2)+'\n')}
  console.log(JSON.stringify(result));
  if(result.invalidCount)process.exitCode=1;
}
if(require.main===module)main();
module.exports={tally};
