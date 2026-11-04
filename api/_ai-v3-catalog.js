'use strict';

// Read-only DB-first catalog lookup. Preview must never bypass DB-write safety
// merely to acquire a remote seller-provider rate-limit lease.
const { extractTitleEvidence, checkListingIdentity } = require('./_ai-v3-identity');
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
async function searchCatalog(query, { db, liveSearch, mapRow, identity } = {}) {
  const term=safeTerm(query);
  if(!term) return [];
  const source=db || require('./_supabase');
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
  const target=identity && identity.family ? identity : extractTitleEvidence(term);
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
  if(rows.length) {
    const mapper=mapRow || require('./_shop').toClientProduct;
    return rows.sort((a,b)=>evidenceScore(b,term,target)-evidenceScore(a,term,target))
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
