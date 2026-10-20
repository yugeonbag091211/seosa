#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict');
const {createClient}=require('../../api/_neonpg');
const seen=[];let response=[];
let meta={proretset:false,rettype:'integer'};
const query=async(sql,args)=>{
  seen.push({sql,args});
  if(sql.includes('pg_proc')) return {rows:[meta]};
  if(sql.includes('COUNT(*)'))return {rows:[{count:'12'}]};
  return {rows:typeof response==='function'?response(sql,args):response};
};
const neon=createClient({query});
let passed=0;
const test=async(name,fn)=>{seen.length=0;response=[];meta={proretset:false,rettype:'integer'};await fn();passed++;console.log('PASS '+name);};
(async()=>{
  await test('select filters with parameterized values',async()=>{
    response=[{product_id:'abc',mall:'쿠팡'}];
    const r=await neon.from('products').select('product_id,mall').eq('mall',"쿠팡' OR 1=1 --").gte('id',4).limit(5);
    assert.equal(r.error,null);assert.equal(r.data.length,1);
    assert.match(seen[0].sql,/WHERE "mall" = \$1 AND "id" >= \$2 LIMIT \$3/);
    assert.deepEqual(seen[0].args,["쿠팡' OR 1=1 --",4,5]);
  });
  await test('default result cap prevents accidental database egress',async()=>{
    await neon.from('price_history').select('*');
    assert.match(seen[0].sql,/LIMIT \$1$/);assert.deepEqual(seen[0].args,[1000]);
  });
  await test('safe IN and empty list',async()=>{
    await neon.from('products').select('*').in('product_id',['a','b']);
    assert.match(seen[0].sql,/IN \(\$1,\$2\)/);
    seen.length=0;await neon.from('products').select('*').in('product_id',[]);
    assert.match(seen[0].sql,/WHERE FALSE/);
  });
  await test('query sort + range',async()=>{
    await neon.from('products').select('id').order('id',{ascending:false}).range(10,20);
    assert.match(seen[0].sql,/ORDER BY "id" DESC LIMIT \$1 OFFSET \$2/);
    assert.deepEqual(seen[0].args,[11,10]);
  });
  await test('single and maybeSingle distinction',async()=>{
    const miss=await neon.from('products').select('*').eq('id',100).single();
    assert.ok(miss.error);
    const maybe=await neon.from('products').select('*').eq('id',100).maybeSingle();
    assert.equal(maybe.data,null);assert.equal(maybe.error,null);
  });
  await test('exact count head does not download rows',async()=>{
    const r=await neon.from('products').select('*',{count:'exact',head:true}).eq('mall','쿠팡');
    assert.equal(r.data,null);assert.equal(r.count,12);
    assert.equal(seen.length,1);assert.match(seen[0].sql,/COUNT\(\*\)/);
  });
  await test('insert null returning follows supabase',async()=>{
    const r=await neon.from('search_stats').insert({keyword:'test',count:1});
    assert.equal(r.error,null);assert.equal(r.data,null);
    assert.match(seen[0].sql,/INSERT INTO public."search_stats"/);
    assert.deepEqual(seen[0].args,['test',1]);
  });
  await test('upsert whitelist onConflict',async()=>{
    await neon.from('products').upsert({product_id:'p',mall:'쿠팡',title:'T'},{onConflict:'product_id,mall'});
    assert.match(seen[0].sql,/ON CONFLICT \("product_id","mall"\) DO UPDATE SET "title"=EXCLUDED."title"/);
  });
  await test('reject unfiltered delete and update',async()=>{
    const d=await neon.from('products').delete();assert.ok(d.error);assert.equal(seen.length,0);
    const u=await neon.from('products').update({title:'oops'});assert.ok(u.error);assert.equal(seen.length,0);
  });
  await test('filtered update does not inline SQL injection',async()=>{
    await neon.from('products').update({title:"a' --"}).eq('product_id','p');
    assert.match(seen[0].sql,/UPDATE public."products" SET "title"=\$2 WHERE "product_id" = \$1/);
    assert.deepEqual(seen[0].args,['p',"a' --"]);
  });
  await test('reject invalid column/table identifiers',async()=>{
    assert.throws(()=>neon.from('products;DROP TABLE products'));
    const res=await neon.from('products').select('*').eq('x); DROP TABLE products','1');
    assert.ok(res.error);assert.equal(seen.length,0);
  });
  await test('complex unsupported projection fails closed',async()=>{
    const r=await neon.from('products').select('other_table(*)');
    assert.ok(r.error);assert.equal(seen.length,0);
  });
  await test('rpc table SETOF returns rows',async()=>{
    meta={proretset:true,rettype:'record'};response=[{allowed:true,call_id:20}];
    const r=await neon.rpc('coupang_acquire_v2',{p_source:'search',p_keyword:'상품'});
    assert.equal(r.error,null);assert.equal(r.data[0].allowed,true);assert.match(seen[1].sql,/"p_source" => \$1,"p_keyword" => \$2/);
  });
  await test('rpc scalar returns single value',async()=>{
    meta={proretset:false,rettype:'integer'};response=[{coupang_prune:4}];
    const r=await neon.rpc('coupang_prune',{keep_days:3});
    assert.equal(r.data,4);
  });
  await test('rpc query pagination happens server-side',async()=>{
    meta={proretset:true,rettype:'record'};response=[{product_id:'1'}];
    const r=await neon.rpc('collector_eligible_products',{}).range(5,9);
    assert.equal(r.data.length,1);assert.match(seen[1].sql,/LIMIT \$1 OFFSET \$2/);
    assert.deepEqual(seen[1].args,[5,5]);
  });
  await test('PostgREST OR validated',async()=>{
    const r=await neon.from('products').select('*').or('mall.eq.쿠팡,mall.eq.ADPICK');
    assert.equal(r.error,null);assert.match(seen[0].sql,/\("mall" = \$1 OR "mall" = \$2\)/);
  });
  console.log('NEON_ADAPTER_UNIT_TESTS '+passed+'/'+passed+' PASS');
})().catch(e=>{console.error('FAIL: '+e.stack);process.exitCode=1;});
