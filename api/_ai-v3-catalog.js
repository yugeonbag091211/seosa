'use strict';

// Read-only DB-first catalog lookup. Preview must never bypass DB-write safety
// merely to acquire a remote seller-provider rate-limit lease.
const { extractTitleEvidence, checkListingIdentity } = require('./_ai-v3-identity');
const { productTypeMatches } = require('./_ai-v31-taxonomy');
const { buildProbes,brandMatches } = require('./_ai-v31-retrieval');
const safeTerm = value => String(value || '').normalize('NFKC')
  .replace(/[^0-9a-zA-Z가-힣+\s-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0,70);
const flat = x => String(x || '').normalize('NFKC').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
function primaryAnchor(term) {
  const words = safeTerm(term).split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  return words[0].replace(/\d+$/,'').trim() || words[0];
}
function evidenceScore(row, query, identity) {
  const requested=identity && identity.family ? identity : extractTitleEvidence(query);
  const evidence=extractTitleEvidence(row.title || '');
  const fields=['family','series','variant','generation','storageGb','ramGb','chip','screenInches','network'];
  let score=0;
  for(const field of fields) {
    if (requested[field] == null) continue;
    if(evidence[field] == null) continue;
    score += String(requested[field])===String(evidence[field]) ? 10 : -12;
  }
  for(const part of safeTerm(query).split(/\s+/)) {
    if(part.length>=2 && flat(row.title).includes(flat(part))) score += 2;
  }
  const updated=Date.parse(row.collected_at||'');
  if(Number.isFinite(updated)) score += Math.min(2,Math.max(0,updated/1e13));
  return score;
}
// Targeted, read-only probes bypass the first 40 broad/irrelevant results.
// Only evidence explicitly present in the request is used as a DB filter.
const NON_DEVICE = /중고|리퍼|리퍼비시|전시품|케이스|보호필름|커버|파우치|충전기|거치대|\b(?:used|refurbished)\b/i;
function preciseIdentityProbes(target) {
  if (!target.family || !target.storageGb || !target.series) return [];
  const capacity=String(target.storageGb);
  if (target.family==='galaxytab' && target.variant) {
    const model='s'+target.series;
    const suffix=target.variant==='fe-plus' ? 'fe+' : target.variant;
    return [
      [['title',model+suffix],['title',capacity]],
      [['title',model+' '+suffix],['title',capacity]],
      [['keyword',model+' '+suffix],['title',capacity]]
    ];
  }
  if (target.family==='iphone') {
    return [
      [['title','아이폰'+target.series],['title',capacity]],
      [['title','iphone '+target.series],['title',capacity]],
      [['title','iphone'+target.series],['title',capacity]]
    ];
  }
  return [];
}
async function searchCatalog(query, { db, liveSearch, mapRow, identity, minPrice, maxPrice, category, userText } = {}) {
  const term=safeTerm(query);
  if(!term) return [];
  const source=db || require('./_supabase');
  const boundedMin=Number.isSafeInteger(Number(minPrice)) && Number(minPrice)>0 ? Number(minPrice) : null;
  const boundedMax=Number.isSafeInteger(Number(maxPrice)) && Number(maxPrice)>0 ? Number(maxPrice) : null;
  const lookup=async(column,method,fragment)=>{
    const builder=source.from('products').select('*');
    const condition=method==='eq'
      ? builder.eq(column,fragment) : builder.ilike(column,'%'+fragment+'%');
    const response=await condition.limit(40);
    if(response.error) throw new Error('Catalog read failed');
    return Array.isArray(response.data) ? response.data : [];
  };
  const lookupConjunction=async filters=>{
    let builder=source.from('products').select('*');
    for(const [column,fragment] of filters) builder=builder.ilike(column,'%'+fragment+'%');
    const response=await builder.limit(40);
    if(response.error) throw new Error('Catalog constrained read failed');
    return Array.isArray(response.data) ? response.data : [];
  };
  const lookupPriced=async fragment=>{
    let builder=source.from('products').select('*').ilike('title','%'+fragment+'%');
    builder=builder.gte('lprice',boundedMin);
    if(boundedMax != null) builder=builder.lte('lprice',boundedMax);
    const response=await builder.limit(40);
    if(response.error) throw new Error('Catalog bounded-price read failed');
    return Array.isArray(response.data) ? response.data : [];
  };
  const rows=[], seen=new Set();
  const add=group=>{
    for(const row of group) {
      if(!row || !row.product_id || !row.title) continue;
      const key=String(row.mall||'')+':'+String(row.product_id)+':'+String(row.vendor_item_id||'');
      if(seen.has(key))continue;
      seen.add(key);rows.push(row);
    }
  };
  add(await lookup('title','ilike',term));
  if(!rows.length) {
    add(await lookup('keyword','eq',term));
  }
  if(!rows.length) {
    const anchor=primaryAnchor(term);
    if(anchor.length>=2) {
      // A multi-word exact LIKE rarely matches seller-title word order.
      // Search the keyword index and the title with a bounded anchor.
      add(await lookup('keyword','ilike',anchor));
      add(await lookup('title','ilike',anchor));
    }
  }
  // Exact intent comes from user conversation, never from a shortened GPT keyword.
  // The caller supplies user-grounded identity (even when empty).
  // GPT's search keyword cannot create new required product identity.
  const target=identity&&typeof identity==='object' ? identity : extractTitleEvidence(term);
  // A used listing or an accessory is not a suitable reason to stop searching
  // for a new device that matches the requested exact variant.
  const hasVerifiedNew=()=>rows.some(r=>!NON_DEVICE.test(r.title) && checkListingIdentity(r.title,target).ok);
  const detail=target.storageGb || target.chip || target.series || target.generation;
  if(target.family && detail && !hasVerifiedNew()) {
    const anchor=primaryAnchor(term);
    const primary=target.storageGb ? String(target.storageGb) : String(detail);
    // A conjunctive DB filter searches known identity details BEFORE the
    // 40-row cap, instead of letting 40 accessories crowd out exact devices.
    if(anchor.length>=2) {
      add(await lookupConjunction([['keyword',anchor],['title',primary]]));
    }
    const secondary=target.chip || target.series || '';
    if(secondary && secondary!==primary)
      add(await lookupConjunction([['title',primary],['title',String(secondary)]]));
  }
  // Prefer exact model/variant + capacity fragments over broad category hits.
  // At most three extra read-only queries, stopping on a verified new listing.
  if(target.family && target.storageGb && !hasVerifiedNew()) {
    for(const filters of preciseIdentityProbes(target)) {
      add(await lookupConjunction(filters));
      if(hasVerifiedNew()) break;
    }
  }
  // A follow-up like "12-15만원" must search the price band before a 40-row
  // generic lookup can crowd out valid products. Two read-only probes maximum.
  if(boundedMin != null && (boundedMax == null || boundedMin <= boundedMax)) {
    const anchors=(flat(category)==='헤드셋'||flat(category)==='헤드폰')
      ? ['헤드셋','헤드폰'] : [primaryAnchor(category||term)];
    for(const anchor of [...new Set(anchors)].slice(0,2)) {
      if(anchor.length>=2) add(await lookupPriced(anchor));
    }
  }
  // v3.1: query distinct, bounded category/model facets rather than treating
  // the first 40 broad keyword matches as complete inventory. Every query is
  // read-only; never acquire a merchant quota or modify product records.
  if(category){
    const probes=buildProbes({query:term,category,userText,identity:target,
      minPrice:boundedMin,maxPrice:boundedMax});
    const viable=()=>rows.filter(row=>
      productTypeMatches(row.title,category,userText||term) &&
      brandMatches(row.title,userText||term) &&
      (!target.family || checkListingIdentity(row.title,target).ok) &&
      (boundedMin==null || Number(row.lprice)>=boundedMin) &&
      (boundedMax==null || Number(row.lprice)<=boundedMax)).length;
    for(const spec of probes){
      // A small verified candidate pool is sufficient for a four-card answer.
      if(viable()>=5)break;
      let builder=source.from('products').select('*');
      for(const [column,fragment] of spec)builder=builder.ilike(column,'%'+fragment+'%');
      if(boundedMin!=null)builder=builder.gte('lprice',boundedMin);
      if(boundedMax!=null)builder=builder.lte('lprice',boundedMax);
      const found=await builder.limit(40);
      if(found.error)throw new Error('Catalog facet lookup failed');
      add(Array.isArray(found.data)?found.data:[]);
    }
  }
  if(rows.length) {
    const mapper=mapRow || require('./_shop').toClientProduct;
    const budgetPriority=r=>boundedMin != null &&
      Number(r.lprice)>=boundedMin && (boundedMax==null || Number(r.lprice)<=boundedMax) ? 100 : 0;
    const eligible=category?rows.filter(row=>
      productTypeMatches(row.title,category,userText||term) && brandMatches(row.title,userText||term)):rows;
    return eligible.sort((a,b)=>(budgetPriority(b)-budgetPriority(a))
      || evidenceScore(b,userText||term,target)-evidenceScore(a,userText||term,target)
      || evidenceScore(b,term,target)-evidenceScore(a,term,target))
      .slice(0,80).map(row=>({
        ...mapper(row), category: row.keyword||'', _source:'db', shippingFee:null
      }));
  }
  // The Preview safety flag forbids remote quota-acquire RPCs. Never disable
  // it just to get a product result; return an honest empty shortlist instead.
  if(process.env.SEOSA_DB_READONLY === '1' || typeof liveSearch !== 'function') return [];
  const result=await liveSearch(term);
  if(!result || result.failed) throw new Error('Product search provider unavailable');
  return Array.isArray(result.items) ? result.items : [];
}
module.exports={searchCatalog,safeTerm,primaryAnchor,evidenceScore};
