'use strict';
// Run before first live request. Frozen labels cannot be changed post-run.
const assert=require('node:assert/strict');
const fresh=require('./ai-v32-eval/fresh50-cases-20261110');
const past=require('./ai-v32-eval/holdout-cases').cases;
const old=require('./ai-v31-online-200-cases').cases;
const {parseBudget,analyzeUtterance}=require('../api/_ai-v32-intent');
const {verdict}=require('./ai-v32-eval/verdict');
const cases=fresh.cases;
const labels={};
let errors=0;
const test=(name,fn)=>{try{fn();console.log('PASS '+name)}catch(e){errors++;console.error('FAIL '+name+': '+e.message)}};
test('frozen 50 with 20 FIND, 20 NO_RESULT, 10 NON_SHOPPING',()=>{
  assert.equal(cases.length,50);
  const ids=cases.map(x=>x.id),texts=cases.map(x=>x.p);
  assert.equal(new Set(ids).size,50);assert.equal(new Set(texts).size,50);
  const known=new Set([...past,...old].map(x=>x.p.trim()));
  assert.equal(texts.filter(x=>known.has(x)).length,0,'must not reuse literal questions');
  for(const c of cases){const label=fresh.labelFor(c);labels[label.expect]=(labels[label.expect]||0)+1;
    assert(label.note&&label.note.length>15,'preregistration evidence '+c.id);
  }
  assert.deepEqual(labels,{FIND:20,NO_RESULT:20,NON_SHOPPING:10});
});
test('positive/negative budgets and strict facet evidence preregistered',()=>{
  for(const c of cases.filter(x=>!x.id.startsWith('I'))){
    const b=parseBudget(c.p);
    assert.equal(b.max,c.max,c.id+' cap');
    assert(Array.isArray(c.spec.all)&&c.spec.all.length>=2,c.id+' facet groups');
    assert(Array.isArray(c.spec.not)&&c.spec.not.length>=2,c.id+' exclusions');
  }
});
test('ten pre-registered conceptual questions contain no shopping instruction',()=>{
  // Do NOT require the engine's current intent detector to pass before a blind
  // test; its false negatives are exactly what this set is meant to expose.
  for(const c of cases.filter(x=>x.id.startsWith('I'))){
    assert(/(?:어떻게|원리|차이|뜻|의미|달라|설명)/.test(c.p),c.id+' '+c.p);
    assert(!/(?:추천해|구매해|골라줘|찾아줘|보여줘)/.test(c.p),c.id);
  }
});
test('fresh positive oracle checks detect a wrong similarly named card',()=>{
  const c=cases.find(x=>x.id==='F08');
  const mock={http:200,cards:[{productId:'p1',price:419000,title:'로보락 S8 Pro Plus 로봇청소기',link:'https://example.org/1'}],
    state:{maxPrice:c.max,minPrice:null},stats:{searched:true}};
  const out=verdict(c,mock,null,fresh.labelFor(c));
  assert.equal(out.verdict,'FAIL',JSON.stringify(out));
  assert(out.causes.some(x=>x.includes('oracle_prohibited:proplus')),JSON.stringify(out.causes));
});
console.log(JSON.stringify({labels,errors}));
if(errors)process.exitCode=1;
