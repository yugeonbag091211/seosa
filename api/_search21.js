'use strict';
/**
 * Search 2.1: query-relative sold-object gate, followed by lexical reordering.
 * Safe SHADOW algorithm; not wired into Production or default Search2.
 * Invariants: no network or database IO, no writes, no deletion, identical product references.
 */
const MiniSearch=require('minisearch');
const {tokens}=require('./_search2-mini');
const {getIntent,relation}=require('./_search2-object-relation');
function rerank(keyword,items){
  if(!Array.isArray(items))throw new TypeError('products must be an array');
  if(items.length>75)throw new RangeError('candidate safety cap');
  if(items.length<2||!tokens(keyword).length)return {items:items.slice(),applied:false,reason:'no_candidates'};
  const intent=getIntent(keyword);
  // For unclear query intent retain the existing Search2 behavior.
  if(!intent.type){
    const fallback=require('./_search2-mini').rerank(keyword,items);
    return {...fallback,reason:'unknown_intent_'+fallback.reason};
  }
  const assessments=items.map((p,i)=>{
    const valid=p&&typeof p.title==='string'&&p.title.trim();
    return {p,i,assessment:valid?relation(intent,p.title):
      {grade:'unknown',score:1,reason:'title_absent'}};
  });
  const highConfidence=assessments.some(x=>x.assessment.score===3);
  // Keep uncertainty conservative: only impose categorical priority when
  // the corpus actually has a same-type product to show before other things.
  if(!highConfidence){
    return {items:items.slice(),applied:false,reason:'no_verified_target',
      diagnosis:assessments.map(x=>x.assessment)};
  }
  const docs=assessments.filter(x=>x.p&&typeof x.p.title==='string'&&x.p.title.trim())
    .map(x=>({id:'c'+x.i,title:x.p.title,category:String(
      x.p.categoryName||x.p.category||'').slice(0,100)}));
  let matches=[];
  if(docs.length>=2){
    const idx=new MiniSearch({
      fields:['title','category'],
      tokenize:tokens,
      processTerm:s=>s.toLowerCase(),
      searchOptions:{combineWith:'AND',boost:{title:5,category:1.5},prefix:false,fuzzy:false}
    });
    idx.addAll(docs);
    matches=idx.search(keyword,{combineWith:'AND'});
  }
  const matchPosition=new Map(matches.map((m,i)=>[Number(m.id.slice(1)),i]));
  const legacyTier=x=>Math.floor(Math.max(0,Math.min(1,Number(x.p?.relevance)||0))*10);
  assessments.sort((a,b)=>{
    // One high-confidence incompatible sold object must not outrank a real
    // requested main product merely because its title repeats the model name.
    const gradeDelta=b.assessment.score-a.assessment.score;
    if(gradeDelta)return gradeDelta;
    const tierDelta=legacyTier(b)-legacyTier(a);
    if(tierDelta)return tierDelta;
    return (matchPosition.get(a.i)??Number.POSITIVE_INFINITY)
      -(matchPosition.get(b.i)??Number.POSITIVE_INFINITY) || a.i-b.i;
  });
  return {
    items:assessments.map(x=>x.p),
    applied:true,reason:'sold_object_then_minisearch',
    matched:matches.length,
    intent,
    // Research diagnostics only. Do not attach to product objects.
    diagnosis:assessments.map(x=>({id:x.i,grade:x.assessment.grade,
      reason:x.assessment.reason}))
  };
}
module.exports={rerank};
