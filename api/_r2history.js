'use strict';
// Read-only private historical price shard loader for Cloudflare R2.
// Never make R2 public; never include R2 credentials in client-side JS.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {createGunzip}=require('node:zlib');
const readline=require('node:readline');
const {Readable}=require('node:stream');
const {S3Client,GetObjectCommand}=require('@aws-sdk/client-s3');
// Legacy imported product identifiers can contain Hangul, spaces and commas.
// Only hashes become object keys, so accept valid Unicode identifiers without path interpolation.
const PID=/^[^\x00-\x1f\x7f]{1,300}$/u;
const cache=new Map();
const MAX_CACHE=16;
let s3;
function bucketHash(pid){return crypto.createHash('sha256').update(String(pid),'utf8').digest()[0].toString(16).padStart(2,'0');}
function keyOf(pid){if(!PID.test(String(pid)))throw Error('Invalid product ID');return 'history/v1/shards/'+bucketHash(pid)+'.jsonl.gz';}
function r2Client(){
  if(s3)return s3;
  const account=process.env.R2_ACCOUNT_ID,accessKeyId=process.env.R2_ACCESS_KEY_ID,secretAccessKey=process.env.R2_SECRET_ACCESS_KEY;
  if(!account||!/^[0-9a-f]{32}$/i.test(account)||!accessKeyId||!secretAccessKey||process.env.R2_BUCKET!=='seosa-price-history')throw Error('Private R2 credentials missing');
  s3=new S3Client({region:'auto',endpoint:'https://'+account+'.r2.cloudflarestorage.com',credentials:{accessKeyId,secretAccessKey},forcePathStyle:true,maxAttempts:2,requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
  return s3;
}
async function readShard(name){
  const local=process.env.SEOSA_R2_HISTORY_LOCAL_DIR;
  let compressed;
  if(local){
    if(process.env.VERCEL_ENV==='production')throw Error('Local archive path is never allowed in Production');
    compressed=fs.createReadStream(path.join(local,name+'.jsonl.gz'));
  }else{
    if(process.env.SEOSA_R2_HISTORY_ENABLED!=='1')throw Error('R2 price history not enabled');
    const r=await r2Client().send(new GetObjectCommand({Bucket:'seosa-price-history',Key:'history/v1/shards/'+name+'.jsonl.gz'}));
    if(Number(r.ContentLength)>4*1024*1024)throw Error('Unexpectedly large R2 history shard');
    compressed=r.Body;
  }
  const gunzip=compressed.pipe(createGunzip());
  const reader=readline.createInterface({input:gunzip,crlfDelay:Infinity});
  const result=[];
  for await(const line of reader){
    if(!line)continue;
    const v=JSON.parse(line);
    if(!Array.isArray(v)||v.length!==7||!PID.test(v[0])||!Number.isSafeInteger(v[5])||v[5]<0)throw Error('Invalid archive row');
    if(bucketHash(v[0])!==name)throw Error('Invalid archive shard position');
    result.push({product_id:v[0],mall:v[1],vendor_item_id:v[2],recorded_at:v[3],recorded_date:v[4],price:v[5],source:v[6]});
    if(result.length>15000)throw Error('Archive shard exceeds safety limit');
  }
  return result;
}
async function getHistory(pid,mall=''){
  const name=bucketHash(pid);
  const key=keyOf(pid);
  if(!key.startsWith('history/v1/shards/'))throw Error('Unsafe archive key');
  const cached=cache.get(name);
  let rows;
  if(cached&&cached.expires>Date.now()){rows=cached.rows;}
  else{
    rows=await readShard(name);
    if(cache.size>=MAX_CACHE)cache.delete(cache.keys().next().value);
    cache.set(name,{rows,expires:Date.now()+120000});
  }
  const product=String(pid);
  return rows.filter(r=>r.product_id===product&&(!mall||r.mall===mall));
}
// Combine online new observations with historical shards without double counting older rows.
function mergeHistory(online=[],archived=[],context={}){
  const values=new Map();
  for(const r of [...online,...archived]){
    if(!r)continue;
    const pid=r.product_id||context.productId;
    const mall=r.mall||context.mall||'';
    if(!pid)continue;
    // pg returns timestamp as Date; Date.parse(Date) truncates milliseconds.
    const ms=r.recorded_at instanceof Date ? r.recorded_at.getTime() :
      (r.recorded_at ? Date.parse(r.recorded_at) : NaN);
    const date=Number.isFinite(ms)?new Date(ms).toISOString():String(r.recorded_at||r.recorded_date||'');
    const k=[pid,mall,r.vendor_item_id||'',date,r.price].join('\u001f');
    if(!values.has(k))values.set(k,r);
  }
  return [...values.values()];
}
module.exports={getHistory,keyOf,bucketHash,mergeHistory};
