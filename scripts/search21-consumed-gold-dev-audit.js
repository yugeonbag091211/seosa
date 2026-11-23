'use strict';
// Consumed Stage-2 labels A-F: DEVELOPMENT-only safety diagnostics;
// cannot count toward sealed Stage-2 acceptance!
const path=require('node:path');
const {relation}=require('../api/_search2-object-relation');
const root=process.env.SEOSA_STAGE2_LABEL_DIR;
if(!root||!require('node:fs').existsSync(root)){
 console.error('Set SEOSA_STAGE2_LABEL_DIR to the consumed A-F labels directory');
 process.exit(2);
}
const catalog=[
 ['laptop','노트북'],['earphone','이어폰'],['mouse','마우스'],
 ['keyboard','키보드'],['speaker','스피커'],['robot_vacuum','로봇청소기'],
 ['monitor','모니터'],['smartwatch','스마트워치'],['tablet','태블릿'],
 ['air_fryer','에어프라이어'],['coffee_machine','커피머신'],['laundry_detergent','세탁세제']
];
const selected=new Map(catalog);
const cases=[];
for(const f of 'abcdef'){
 const doc=require(path.join(root,'holdout-'+f+'-labels.json'));
 for(const row of doc.cases||[])if(row.gold?.clear)cases.push(row);
}
let main=0,mainPromoted=0,mainUnknown=0,mainDemoted=0;
let nonmain=0,nonmainPromoted=0,nonmainDemoted=0;
const suspiciousMain=[],suspiciousNonmain=[];
for(const x of cases){
 const q=selected.get(x.gold.sold_type);
 if(!q)continue;
 const r=relation(q,x.title);
 if(x.gold.relation==='MAIN'){
  main++;if(r.score>=3)mainPromoted++;else if(r.score===0){mainDemoted++;suspiciousMain.push({type:x.gold.sold_type,q,title:x.title,evidence:r})}else mainUnknown++;
 }else{
  // This gold relationship is relative to its annotated sold type, so cannot
  // independently adjudicate the main-device query, but print risky outcomes.
  nonmain++;if(r.score>=3){nonmainPromoted++;suspiciousNonmain.push({type:x.gold.sold_type,q,title:x.title,evidence:r})}else if(r.score===0)nonmainDemoted++;
 }
}
console.log(JSON.stringify({
 caveat:'Consumed A-F, development-only; query derived from gold sold_type; cannot measure full ranking accuracy',
 totalLabeled:cases.length,relevantTargetExamples:main+nonmain,
 goldMain:{total:main,promoted:mainPromoted,unknown:mainUnknown,demoted:mainDemoted},
 goldNonmain:{total:nonmain,promoted:nonmainPromoted,demoted:nonmainDemoted},
 suspiciousMain:suspiciousMain.slice(0,40),suspiciousNonmain:suspiciousNonmain.slice(0,12)
},null,2));
if(mainDemoted)process.exitCode=2;
