#!/usr/bin/env node
'use strict';
// Offline COPY(text) -> sharded JSONL.gz dataset for private Cloudflare R2.
// No network requests, no DB writes, and source data is never removed.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const readline=require('node:readline');
const zlib=require('node:zlib');
const {pipeline}=require('node:stream/promises');
const {once}=require('node:events');

const COPY_HEADER=/^COPY public\.price_history \(([^)]+)\) FROM stdin;$/;
const COLS=['product_id','mall','vendor_item_id','recorded_at','recorded_date','price','source'];
const KEY_PREFIX='history/v1/shards/';
const expectedRowsArg=process.argv.find(a=>a.startsWith('--expected-rows='));
const source=process.argv.find(a=>a.startsWith('--source='));
const dest=process.argv.find(a=>a.startsWith('--dest='));
const expectedRows=expectedRowsArg?Number(expectedRowsArg.split('=')[1]):null;
if(!source||!dest||!Number.isSafeInteger(expectedRows)||expectedRows<1){
  console.error('Usage: node scripts/migration/export-r2-history.js --source=PATH.sql --dest=EMPTY_DIRECTORY --expected-rows=320413');
  process.exit(2);
}
const sourcePath=path.resolve(source.slice('--source='.length));
const destPath=path.resolve(dest.slice('--dest='.length));
if(!fs.statSync(sourcePath).isFile())throw Error('Source COPY file does not exist');
if(fs.existsSync(destPath)&&fs.readdirSync(destPath).length)throw Error('R2 output directory must be empty');
fs.mkdirSync(destPath,{recursive:true});
const tmp=path.join(destPath,'_work');
fs.mkdirSync(tmp,{recursive:false});
function hashFile(filename){return new Promise((resolve,reject)=>{
  const sha=crypto.createHash('sha256');
  const r=fs.createReadStream(filename);
  r.on('data',d=>sha.update(d));r.on('end',()=>resolve(sha.digest('hex')));r.on('error',reject);
});}
function unescapeCopy(input){
  if(input==='\\N')return null;
  let out='';
  for(let i=0;i<input.length;i++){
    const ch=input[i];
    if(ch!=='\\'){out+=ch;continue;}
    i++;
    if(i>=input.length)throw Error('COPY malformed trailing backslash');
    const b=input[i];
    const replacements={t:'\t',n:'\n',r:'\r',b:'\b',f:'\f',v:'\v','\\':'\\'};
    if(Object.prototype.hasOwnProperty.call(replacements,b)){out+=replacements[b];continue;}
    if(b==='x'){
      const m=/^[0-9a-fA-F]{1,2}/.exec(input.slice(i+1));
      if(!m)throw Error('Bad COPY hex escape');out+=String.fromCharCode(parseInt(m[0],16));i+=m[0].length;continue;
    }
    if(/[0-7]/.test(b)){
      const m=/^[0-7]{0,2}/.exec(input.slice(i+1));out+=String.fromCharCode(parseInt(b+m[0],8));i+=m[0].length;continue;
    }
    throw Error('Unknown COPY escape');
  }
  return out;
}
async function exportData(){
  const rows=Array.from({length:256},()=>0);
  const writers=Array.from({length:256},(_,i)=>fs.createWriteStream(path.join(tmp,i.toString(16).padStart(2,'0')+'.jsonl'),{flags:'wx',encoding:'utf8',highWaterMark:65536}));
  for(const w of writers)w.on('error',e=>{console.error('R2 shard write error: '+e.message);process.exitCode=1;});
  let cols=null;let parsed=0;let active=false;let finished=false;
  const input=readline.createInterface({input:fs.createReadStream(sourcePath,{encoding:'utf8',highWaterMark:1024*1024}),crlfDelay:Infinity});
  try{
    for await(const line of input){
      if(!active){const head=COPY_HEADER.exec(line);if(head){cols=head[1].split(',').map(c=>c.trim());for(const name of COLS)if(!cols.includes(name))throw Error('Missing COPY column '+name);active=true;}continue;}
      if(line==='\\.'){finished=true;break;}
      const parts=line.split('\t');
      if(parts.length!==cols.length)throw Error('COPY field count mismatch at row '+(parsed+1));
      const val=Object.fromEntries(COLS.map(name=>[name,unescapeCopy(parts[cols.indexOf(name)])]));
      if(!val.product_id||!val.mall||val.price==null||!/^[0-9]+$/.test(val.price))throw Error('Invalid required price history row '+(parsed+1));
      const shard=crypto.createHash('sha256').update(val.product_id).digest()[0];
      const compact=[val.product_id,val.mall,val.vendor_item_id,val.recorded_at,val.recorded_date,Number(val.price),val.source];
      if(!writers[shard].write(JSON.stringify(compact)+'\n'))await once(writers[shard],'drain');
      rows[shard]++;parsed++;
    }
  } finally{
    await Promise.all(writers.map(w=>new Promise((resolve,reject)=>{w.end(e=>e?reject(e):resolve());})));
  }
  if(!active||!finished)throw Error('No complete public.price_history COPY segment found');
  if(parsed!==expectedRows)throw Error('Row count mismatch: expected '+expectedRows+' observed '+parsed);
  console.log('COPY_ROWS_VERIFIED='+parsed);
  const objects=[];
  for(let i=0;i<256;i++){
    const name=i.toString(16).padStart(2,'0');
    const raw=path.join(tmp,name+'.jsonl');
    const gz=path.join(destPath,name+'.jsonl.gz');
    await pipeline(fs.createReadStream(raw),zlib.createGzip({level:9}),fs.createWriteStream(gz,{flags:'wx'}));
    const bytes=fs.statSync(gz).size;
    if(bytes<1)throw Error('Empty shard archive '+name);
    objects.push({key:KEY_PREFIX+name+'.jsonl.gz',file:name+'.jsonl.gz',rows:rows[i],bytes,sha256:await hashFile(gz)});
    fs.unlinkSync(raw);
  }
  fs.rmdirSync(tmp);
  const manifest={
    version:1,createdAt:new Date().toISOString(),source:'Supabase public.price_history via verified PostgreSQL backup',
    sourceSHA256:await hashFile(sourcePath),count:parsed,shards:256,
    shardAlgorithm:'sha256(UTF8 product_id) first byte',
    columns:['product_id','mall','vendor_item_id','recorded_at','recorded_date','price','source'],
    uploadBucket:'seosapricehistory',uploadPrefix:KEY_PREFIX,
    rowsIndexedBy:'product_id',privateObjectsRequired:true,
    items:objects
  };
  const file=path.join(destPath,'manifest.json');
  fs.writeFileSync(file,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log('R2_OFFLINE_EXPORT_OK rows='+parsed+' shards='+objects.length+' bytes='+objects.reduce((sum,o)=>sum+o.bytes,0)+' manifest='+file);
}
exportData().catch(err=>{console.error('R2_OFFLINE_EXPORT_FAILED '+err.message);process.exitCode=1;});
