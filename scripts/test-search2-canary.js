'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {rerank,tokens}=require('../api/_search2-mini');
let n=0;
function test(label,fn){fn();n++;console.log('PASS',label);}
test('Korean compound tokens',()=>assert(tokens('삼성노트북').includes('노트북')));
test('Model generation separated',()=>{
 const x=rerank('M4',[
  {title:'맥북 에어 M4 256GB',relevance:0.9,id:'m4'},
  {title:'맥북 에어 M3 256GB',relevance:0.9,id:'m3'}]);
 assert.equal(x.items[0].id,'m4');
});
test('Accessory cannot overtake higher relevance main tier',()=>{
 const a={title:'맥북 에어 M4',id:'main',relevance:0.9};
 const b={title:'맥북 에어 M4 보호필름',id:'film',relevance:0.45};
 const x=rerank('맥북 에어 M4',[b,a]);
 assert.equal(x.items[0],a);
});
test('Stable fallback on unknown query',()=>{
 const rows=[{title:'맥북 에어 M4',id:'a',relevance:1},{title:'아이패드',id:'b',relevance:.9}];
 const x=rerank('아로니아식초',rows);
 assert.deepEqual(x.items,rows);assert.equal(x.applied,false);
});
test('No product is dropped for partial text match',()=>{
 const rows=[{title:'무선 이어폰',id:'a',link:'https://example.org/a',relevance:.8},
  {title:'이어폰 케이스',id:'b',relevance:.45},
  {title:'초콜릿',id:'c',relevance:.2}];
 const x=rerank('무선 이어폰',rows);
 assert.equal(x.items.length,3);
 assert.deepEqual(new Set(x.items),new Set(rows));
 assert.equal(x.items.find(p=>p.id==='a').link,'https://example.org/a');
});
test('Retain duplicate rows and exact reference equality',()=>{
 const a={title:'태블릿',id:'1',relevance:.8},b={title:'태블릿',id:'2',relevance:.8};
 const x=rerank('태블릿',[b,a]);assert.equal(x.items.length,2);assert(x.items.includes(a)&&x.items.includes(b));
});
test('Do not mutate original product objects or array',()=>{
 const items=[{title:'노트북',relevance:.4,lprice:350000},{title:'태블릿',relevance:.8,lprice:200000}];
 const before=JSON.stringify(items);
 rerank('노트북',items);
 assert.equal(JSON.stringify(items),before);
});
test('No external network calls',()=>{
 const original=global.fetch;
 global.fetch=()=>{throw Error('external call forbidden')};
 try{assert.equal(rerank('노트북',[{title:'노트북',relevance:1},{title:'파우치',relevance:.2}]).items.length,2);}
 finally{global.fetch=original}
});
test('Empty array and blanks safe',()=>{
 assert.deepEqual(rerank('노트북',[]).items,[]);
 assert.equal(rerank('  ',[{title:'노트북'},{title:'키보드'}]).applied,false);
});
test('Refuse unexpectedly huge merchant result list',()=>{
 assert.throws(()=>rerank('노트북',Array.from({length:76},(_,i)=>({title:'노트북 '+i}))),/cap/);
});
test('Reject non-array inputs',()=>assert.throws(()=>rerank('노트북',{}),/array/));
test('Public canary is opt-in, default remains unchanged',()=>{
 const js=fs.readFileSync(path.join(__dirname,'../api/search.js'),'utf8');
 assert(js.includes("req.query.engine === 'mini'"));
 assert(js.includes("require('./_search2-mini')"));
 assert(js.includes("X-Seosa-Search-Engine"));
 assert(js.includes('noStore(res)'));
});
test('Beta page fetches only existing API with opt-in flag',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../public/search2.html'),'utf8');
 assert(html.includes("'/api/search?keyword='"));
 assert(html.includes("'&engine=mini'"));
 assert(html.includes('noindex,nofollow'));
 assert(html.includes('rel=')===false || html.includes('a.rel='));
});
console.log('Search2 production-canary contracts:',n+'/'+n,'passed (offline)');
