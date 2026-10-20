#!/usr/bin/env node
'use strict';
// Private R2 uploader: no network unless BOTH --execute and --confirm-bucket=seosapricehistory.
// Credentials only from process environment; never logs keys or user data.
const fs=require('node:fs');
const path=require('node:path');
const {verify}=require('./verify-r2-history');
const {S3Client,HeadObjectCommand,PutObjectCommand}=require('@aws-sdk/client-s3');
const opts=process.argv.slice(2);
const rootFlag=opts.find(x=>x.startsWith('--dir='));
const execute=opts.includes('--execute');
const confirm=opts.includes('--confirm-bucket=seosapricehistory');
if(!rootFlag){console.error('Usage: node scripts/migration/upload-r2-history.js --dir=DIR [--execute --confirm-bucket=seosapricehistory]');process.exit(2);}
const folder=path.resolve(rootFlag.slice('--dir='.length));
async function run(){
  const good=await verify(folder);
  console.log('R2_PREUPLOAD_CHECKSUMS_OK rows='+good.rows+' shards='+good.shards+' bytes='+good.bytes);
  if(!execute){console.log('R2_DRY_RUN_COMPLETE: no network calls or writes.');return;}
  if(!confirm)throw Error('Explicit --confirm-bucket=seosapricehistory required');
  const bucket=process.env.R2_BUCKET;
  const account=process.env.R2_ACCOUNT_ID;
  const accessKeyId=process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey=process.env.R2_SECRET_ACCESS_KEY;
  if(bucket!=='seosapricehistory'||!account||!accessKeyId||!secretAccessKey)throw Error('Missing restricted R2 env credentials or bucket mismatch');
  if(!/^[a-f0-9]{32}$/i.test(account))throw Error('Invalid R2 account id');
  const manifest=JSON.parse(fs.readFileSync(path.join(folder,'manifest.json'),'utf8'));
  const client=new S3Client({
    region:'auto',endpoint:'https://'+account+'.r2.cloudflarestorage.com',
    credentials:{accessKeyId,secretAccessKey},
    forcePathStyle:true,maxAttempts:3,requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'
  });
  let uploaded=0,matching=0;let totalBytes=0;
  for(const item of manifest.items){
    const input={Bucket:bucket,Key:item.key};
    let found;
    try{found=await client.send(new HeadObjectCommand(input));}
    catch(e){if(e.$metadata?.httpStatusCode!==404 && e.name!=='NotFound' && e.name!=='NoSuchKey')throw Error('Cannot safely determine whether R2 object exists: '+item.key);}
    if(found){
      if(Number(found.ContentLength)!==item.bytes||found.Metadata?.sha256!==item.sha256)throw Error('Conflicting R2 object exists; refusing overwrite: '+item.key);
      matching++;continue;
    }
    const file=path.join(folder,item.file);
    await client.send(new PutObjectCommand({...input,Body:fs.createReadStream(file),ContentLength:item.bytes,
      ContentType:'application/x-ndjson',ContentEncoding:'gzip',
      CacheControl:'private,max-age=600',Metadata:{sha256:item.sha256,source:'seosa-migration-verified'}}));
    const remote=await client.send(new HeadObjectCommand(input));
    if(Number(remote.ContentLength)!==item.bytes||remote.Metadata?.sha256!==item.sha256)throw Error('R2 post-upload object verification failed: '+item.key);
    uploaded++;totalBytes+=item.bytes;
    if(uploaded%32===0)console.log('R2_UPLOAD_PROGRESS objects_uploaded='+uploaded+' objects_already_verified='+matching);
  }
  // Publish the signed inventory last, only after all 256 verified objects exist.
  const manifestBytes=fs.readFileSync(path.join(folder,'manifest.json'));
  const manifestSha=require('node:crypto').createHash('sha256').update(manifestBytes).digest('hex');
  const manifestKey='history/v1/manifest.json';
  let existing;
  try{existing=await client.send(new HeadObjectCommand({Bucket:bucket,Key:manifestKey}));}
  catch(e){if(e.$metadata?.httpStatusCode!==404 && e.name!=='NotFound' && e.name!=='NoSuchKey')throw e;}
  if(existing){
    if(Number(existing.ContentLength)!==manifestBytes.length||existing.Metadata?.sha256!==manifestSha)throw Error('Conflicting R2 manifest exists; refusing overwrite');
  }else{
    await client.send(new PutObjectCommand({Bucket:bucket,Key:manifestKey,Body:manifestBytes,ContentLength:manifestBytes.length,
      ContentType:'application/json',CacheControl:'private,max-age=600',Metadata:{sha256:manifestSha}}));
  }
  const verifiedManifest=await client.send(new HeadObjectCommand({Bucket:bucket,Key:manifestKey}));
  if(Number(verifiedManifest.ContentLength)!==manifestBytes.length||verifiedManifest.Metadata?.sha256!==manifestSha)throw Error('Uploaded manifest failed HEAD verification');
  client.destroy();
  console.log('R2_HISTORY_UPLOAD_VERIFIED newly_uploaded='+uploaded+' matching_existing='+matching+' bytes_uploaded='+totalBytes+' shard_objects='+manifest.items.length+' manifest=verified');
}
run().catch(e=>{console.error('R2_HISTORY_UPLOADER_FAILED '+e.message);process.exitCode=1;});
