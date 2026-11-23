'use strict';
// SEOSA Search Engine 2.0 public canary: in-process MiniSearch reranker.
// Exposes ONLY an explicit ?engine=mini opt-in; existing live search untouched.
// Consumes already-fetched products, NEVER fetches, saves, drops or edits items.
// Maintains the legacy relevance safety tiers; MiniSearch ranks within a tier.
const MiniSearch=require('minisearch');
function tokens(value){
  const s=String(value||'').normalize('NFKC').toLowerCase();
  const words=s.match(/[가-힣]+|[a-z0-9]+/g)||[];
  const terms=new Set();
  for(const w of words){
    if(w.length<2){if(/^[0-9]$/.test(w))terms.add(w);continue;}
    terms.add(w);
    if(/[가-힣]/.test(w))for(const n of [2,3]){
      if(w.length<n)continue;
      for(let i=0;i<=w.length-n;i++)terms.add(w.slice(i,i+n));
    }
  }
  return [...terms];
}
function rerank(keyword,products){
  if(!Array.isArray(products))throw new TypeError('products must be an array');
  if(products.length>75)throw new RangeError('search2 candidate safety cap');
  if(products.length<2 || !tokens(keyword).length)return {items:products.slice(),applied:false,reason:'no_candidates'};
  const rows=products.map((p,i)=>p && typeof p.title==='string' && p.title.trim()
    ?{id:'i'+i,title:p.title,category:String(p.categoryName||p.category||'').slice(0,100)}:null).filter(Boolean);
  if(rows.length<2)return {items:products.slice(),applied:false,reason:'insufficient_titles'};
  const idx=new MiniSearch({
    fields:['title','category'],storeFields:[],
    tokenize:tokens,processTerm:s=>s.toLowerCase(),
    searchOptions:{combineWith:'AND',boost:{title:5,category:1.5},prefix:false,fuzzy:false}
  });
  idx.addAll(rows);
  const hits=idx.search(keyword,{combineWith:'AND'});
  if(!hits.length)return {items:products.slice(),applied:false,reason:'no_strict_matches'};
  const hitsRank=new Map(hits.map((h,i)=>[Number(h.id.slice(1)),i]));
  // The base engine already has product/type/condition safety penalties.
  // Never invert a meaningful relevance delta; only rerank equal deciles.
  const refs=products.map((item,i)=>({item,i,tier:Math.floor(
    Math.max(0,Math.min(1,Number(item?.relevance)||0))*10)}));
  refs.sort((a,b)=>{
    if(a.tier!==b.tier)return b.tier-a.tier;
    const ai=hitsRank.get(a.i)??Number.POSITIVE_INFINITY;
    const bi=hitsRank.get(b.i)??Number.POSITIVE_INFINITY;
    return ai-bi||a.i-b.i;
  });
  return {items:refs.map(x=>x.item),applied:true,reason:'minisearch_tier_rerank',
    matched:hitsRank.size};
}
module.exports={rerank,tokens};
