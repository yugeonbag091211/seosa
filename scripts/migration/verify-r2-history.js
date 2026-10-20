#!/usr/bin/env node
'use strict';
// Verify R2 shards entirely offline before any Cloudflare API upload.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const zlib=require('node:zlib');
const readline=require('node:readline');
const {pipeline}=require('node:stream/promises');
const {Writable}=require('node:stream');
async function hashFile(filename){
  const hash=crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filename),new Writable({write(chunk,_enc,cb){hash.update(chunk);cb();}}));
  return hash.digest('hex');
}
async function verify(folder){
  const root=fs.realpathSync(folder);
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  if(manifest.version!==1||manifest.shards!==256||manifest.uploadBucket!=='seosapricehistory'||!Array.isArray(manifest.items)||manifest.items.length!==256)throw Error('Invalid R2 manifest');
  const seen=new Set();let total=0,compressedBytes=0;
  for(const item of manifest.items){
    if(!/^[0-9a-f]{2}\.jsonl\.gz$/.test(item.file)||item.key!=='history/v1/shards/'+item.file||seen.has(item.file))throw Error('Invalid shard name or key');
    seen.add(item.file);
    const file=path.join(root,item.file);
    if(fs.realpathSync(file)!==file)throw Error('Symlink shard rejected');
    const st=fs.statSync(file);
    if(st.size!==item.bytes||st.size<1||!Number.isInteger(item.rows)||item.rows<0)throw Error('Shard metadata invalid');
    const sha=await hashFile(file);if(sha!==item.sha256)throw Error('Shard checksum mismatch: '+item.file);
    const stream=fs.createReadStream(file).pipe(zlib.createGunzip());
    const lines=readline.createInterface({input:stream,crlfDelay:Infinity});
    let counted=0;
    for await(const line of lines){
      if(!line)continue;
      const v=JSON.parse(line);
      if(!Array.isArray(v)||v.length!==7||!v[0]||!v[1]||!Number.isSafeInteger(v[5]))throw Error('Invalid history row');
      const bucket=crypto.createHash('sha256').update(v[0]).digest()[0].toString(16).padStart(2,'0');
      if(item.file.slice(0,2)!==bucket)throw Error('Wrong product_id shard');
      counted++;
    }
    if(counted!==item.rows)throw Error('Shard row count mismatch');
    total+=counted;compressedBytes+=st.size;
  }
  if(total!==manifest.count)throw Error('Total history row count mismatch');
  return {rows:total,shards:seen.size,bytes:compressedBytes,manifestCreatedAt:manifest.createdAt};
}
if(require.main===module){
  const folder=process.argv[2];
  if(!folder){console.error('Usage: node scripts/migration/verify-r2-history.js DIR');process.exit(2);}
  verify(folder).then(result=>console.log('R2_ARCHIVE_OFFLINE_VERIFIED '+JSON.stringify(result))).catch(e=>{console.error('R2_ARCHIVE_VERIFICATION_FAILED '+e.message);process.exitCode=1;});
}
module.exports={verify};
