const assert=require('node:assert/strict');
(async()=>{
const db=require('../../api/_supabase');
const AI=require('../../api/_aicontext');
const query=await db.from('products').select('product_id,mall,vendor_item_id').limit(3);
assert.equal(query.error,null,query.error?.message);
const ids=[...new Set(query.data.map(x=>String(x.product_id)))];
const rows=await AI.loadCatalogRows(ids);
assert.ok(rows.length>0,'AI catalog lookup returned no rows');
assert.ok(rows.every(x=>ids.includes(String(x.product_id))),'Unrelated catalog row');
console.log('NEON_AI_CATALOG_LOOKUP_PASS records='+rows.length);
const invalid=AI.matchCatalog({productId:'__never_existing__',mall:'쿠팡',vendorItemId:'0'},rows);
assert.equal(invalid.status,'not-found');
console.log('AI_NONEXISTENT_PRODUCT_REJECTED');
await require('../../api/_neonpg').client.close();
})().catch(e=>{console.error('AI_NEON_LOOKUP_FAILED '+e.message);process.exitCode=1});
