#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {verify} = require('./verify-backup');
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seosa-migration-test-'));
  let passed = 0;
  const run = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
  try {
    const name='snapshot.dump', file=path.join(tmp,name), manifestFile=path.join(tmp,'manifest.json');
    const contents=Buffer.from('SEOSA OFFLINE FIXTURE - NOT REAL DATA');
    fs.writeFileSync(file, contents);
    const item={name,bytes:contents.length,sha256:crypto.createHash('sha256').update(contents).digest('hex')};
    const manifest={version:1,createdAt:new Date().toISOString(),files:[item]};
    const save = m => fs.writeFileSync(manifestFile, JSON.stringify(m));
    await run('valid artifact SHA256 and size', async () => {save(manifest); const result=await verify(tmp,manifestFile);assert.equal(result.verifiedFiles,1); assert.equal(result.rowCountsVerified,false);});
    await run('reject modified content', async () => {fs.writeFileSync(file,Buffer.from('altered')); await assert.rejects(()=>verify(tmp,manifestFile));fs.writeFileSync(file,contents);});
    await run('reject wrong checksum', async () => {save({...manifest,files:[{...item,sha256:'0'.repeat(64)}]});await assert.rejects(()=>verify(tmp,manifestFile));});
    await run('reject path traversal', async () => {save({...manifest,files:[{...item,name:'../escape.dump'}]});await assert.rejects(()=>verify(tmp,manifestFile));});
    await run('reject absolute path', async () => {save({...manifest,files:[{...item,name:path.resolve(file)}]});await assert.rejects(()=>verify(tmp,manifestFile));});
    await run('reject duplicate filename', async () => {save({...manifest,files:[item,item]});await assert.rejects(()=>verify(tmp,manifestFile));});
    await run('reject missing file', async () => {save({...manifest,files:[{...item,name:'missing.dump'}]});await assert.rejects(()=>verify(tmp,manifestFile));});
    await run('reject zero-byte metadata', async () => {save({...manifest,files:[{...item,bytes:0}]});await assert.rejects(()=>verify(tmp,manifestFile));});
    await run('reject invalid date', async () => {save({...manifest,createdAt:'not-date'});await assert.rejects(()=>verify(tmp,manifestFile));});
    await run('preflight has no remote connectivity', async () => {
      const r=spawnSync(process.execPath,[path.join(__dirname,'preflight.js')],{encoding:'utf8',env:{PATH:process.env.PATH||'',SystemRoot:process.env.SystemRoot||'',WINDIR:process.env.WINDIR||''}});
      assert.equal(r.status,0,r.stderr); const p=JSON.parse(r.stdout.slice(0,r.stdout.indexOf('\nNEXT:')));assert.equal(p.mode,'DRY_RUN_ONLY');assert.equal(p.noRemoteCalls,true);assert.equal(p.productionSwitched,false);
    });
  } finally {fs.rmSync(tmp,{recursive:true,force:true});}
  console.log('MIGRATION_OFFLINE_TESTS ' + passed + '/' + passed + ' PASS');
})().catch(e=>{console.error('FAIL '+e.stack);process.exitCode=1;});
