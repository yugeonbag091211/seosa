'use strict';
// Captured live production responses, DEVELOPMENT ONLY. Does not issue any API calls,
// does not re-label or re-open a sealed holdout.
const fs=require('node:fs');
const path=require('node:path');
const {rerank}=require('../api/_search21');
const {relation}=require('../api/_search2-object-relation');
const fixture=path.join(__dirname,'search21/fixtures/captured-20261123-public-search-top10.json');
const rows=JSON.parse(fs.readFileSync(fixture,'utf8')).rows;
const report=[];
for(const row of rows){
 const before=row.old.top10.map(x=>({...x,id:x.productId,relevance:Number.isFinite(Number(x.relevance))?Number(x.relevance):0}));
 const after=rerank(row.query,before);
 const top5=after.items.slice(0,5).map((x,i)=>({
  rank:i+1,title:x.title,grade:relation(row.query,x.title).grade,
  previousRank:before.indexOf(x)+1
 }));
 const before5=before.slice(0,5).map((x,i)=>({
  rank:i+1,title:x.title,grade:relation(row.query,x.title).grade
 }));
 const gradeCounts=(items)=>items.reduce((a,x)=>{
  const g=relation(row.query,x.title).grade;
  a[g]=(a[g]||0)+1;return a;
 },{});
 const bad=items=>items.filter(x=>['other_object','non_product'].includes(
   relation(row.query,x.title).grade)).length;
 const entry={
  query:row.query,source:row.old.source,candidateCount:row.old.top10.length,
  applied:after.applied,reason:after.reason,
  oldBadTop5:bad(before.slice(0,5)),
  newBadTop5:bad(after.items.slice(0,5)),
  oldBadTop3:bad(before.slice(0,3)),
  newBadTop3:bad(after.items.slice(0,3)),
  oldFirst:before[0]?.title,newFirst:after.items[0]?.title,
  preserved:before.length===after.items.length&&before.every(x=>after.items.includes(x)),
  oldGrades:gradeCounts(before.slice(0,5)),newGrades:gradeCounts(after.items.slice(0,5)),
  before5,top5
 };
 report.push(entry);
 console.log(row.query+': oldBadTop5='+entry.oldBadTop5+
  ' newBadTop5='+entry.newBadTop5+
  ' oldTop1='+entry.before5[0]?.grade+
  ' newTop1='+entry.top5[0]?.grade+
  ' newTitle='+String(entry.newFirst).slice(0,80));
}
const summary={
 total:report.length,
 candidatePreservation:report.filter(r=>r.preserved).length,
 noMainAvailable:report.filter(r=>!r.applied).length,
 proxyBadTop3Old:report.reduce((a,x)=>a+x.oldBadTop3,0),
 proxyBadTop3New:report.reduce((a,x)=>a+x.newBadTop3,0),
 proxyBadTop5Old:report.reduce((a,x)=>a+x.oldBadTop5,0),
 proxyBadTop5New:report.reduce((a,x)=>a+x.newBadTop5,0),
 note:'SELF-REFERENTIAL (same classifier defines bad label and new ranking). NOT accuracy, NOT sealed evaluation, top 10 only, same-input counterfactual, not live end-to-end.'
};
const out=path.join(require('node:os').tmpdir(),'seosa-search21-captured-dev-audit-20261123.json');
fs.writeFileSync(out,JSON.stringify({summary,rows:report},null,2));
console.log('SUMMARY '+JSON.stringify(summary));
console.log('DEV_AUDIT '+out);
