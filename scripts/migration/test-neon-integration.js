#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict');
const {client}=require('../../api/_neonpg');
const sample='__seosa_neon_migration_probe_20261020';
async function main(){
  if(process.env.SEOSA_NEON_EXPERIMENTAL!=='1'||process.env.SEOSA_DB_BACKEND!=='neon'||process.env.VERCEL_ENV!=='preview')throw Error('Preview mode required');
  const u=new URL(process.env.NEON_DATABASE_URL||'');
  if(u.hostname!=='ep-gentle-art-aoaa97v4.c-2.ap-southeast-1.aws.neon.tech')throw Error('Staging-only integration test refused on any other DB');
  let made=false;
  try{
    const before=await client.from('search_stats').select('keyword').eq('keyword',sample).maybeSingle();
    assert.equal(before.error,null);assert.equal(before.data,null,'Refuse existing marker row');
    const added=await client.from('search_stats').insert({keyword:sample,count:1});
    assert.equal(added.error,null,added.error&&added.error.message);
    made=true;
    console.log('STAGING_INSERT_OK');
    let got=await client.from('search_stats').select('keyword,count').eq('keyword',sample).single();
    assert.equal(got.error,null,got.error&&got.error.message);
    assert.equal(got.data.count,1);
    console.log('STAGING_READ_AFTER_WRITE_OK');
    const up=await client.from('search_stats').upsert({keyword:sample,count:2},{onConflict:'keyword'});
    assert.equal(up.error,null,up.error&&up.error.message);
    console.log('STAGING_UPSERT_OK');
    const updated=await client.from('search_stats').update({count:3}).eq('keyword',sample);
    assert.equal(updated.error,null,updated.error&&updated.error.message);
    got=await client.from('search_stats').select('count').eq('keyword',sample).single();
    assert.equal(got.data.count,3);
    console.log('STAGING_UPDATE_OK');
  }finally{
    if(made){
      const rm=await client.from('search_stats').delete().eq('keyword',sample);
      if(rm.error)throw Error('Test-row cleanup failed: '+rm.error.message);
      const after=await client.from('search_stats').select('keyword').eq('keyword',sample).maybeSingle();
      assert.equal(after.data,null,'Probe row remains after cleanup');
      console.log('STAGING_TEST_ROW_CLEANED_UP');
    }
    await client.close();
  }
  console.log('STAGING_NEON_WRITE_INTEGRATION_PASS');
}
main().catch(e=>{console.error('STAGING_NEON_WRITE_INTEGRATION_FAILED '+e.message);process.exitCode=1});
