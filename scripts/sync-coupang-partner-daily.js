#!/usr/bin/env node
'use strict';
/**
 * Official daily Coupang Partners aggregates.
 *
 * Channel-only, provider-reported, server-side fetch. Never copies browser
 * clicks or synthesizes order IDs into the conversions ledger. CLI defaults
 * to DRY RUN; --write requires a completed reporting window after 16:00 KST
 * on the day AFTER the events.
 *
 * node scripts/sync-coupang-partner-daily.js --date=20261119
 * node scripts/sync-coupang-partner-daily.js --date=20261119 --write
 */
const crypto=require('node:crypto');
const path=require('node:path');
const fs=require('node:fs');

const CHANNEL='SEOSA2026';
const REPORT_PREFIX='/v2/providers/affiliate_open_api/apis/openapi/v1/reports/';
const EXTERNAL_HOST='https://api-gateway.coupang.com';
function assertNumeric(value, name, {allowNegative=false}={}) {
  const n=Number(value);
  if (!Number.isFinite(n)||Math.abs(n)>1e12||(!allowNegative&&n<0))
    throw Error('invalid numeric field: '+name);
  return n;
}
function parseRows(body, type, date, channel=CHANNEL) {
  if (!body||String(body.rCode)!=='0'||!Array.isArray(body.data))
    throw Error(type+' report not verified');
  if (body.data.length>=1000)throw Error(type+' may require pagination; refusing partial result');
  return body.data.map(row=>{
    if (!row||typeof row!=='object'||Array.isArray(row))
      throw Error(type+' malformed row');
    if (String(row.subId||'')!==channel)
      throw Error(type+' partner channel mismatch');
    if (String(row.date).replace(/-/g,'')!==date)
      throw Error(type+' report date mismatch');
    if (type==='clicks') assertNumeric(row.click,'click');
    if (type==='commission') {
      for(const k of ['click','commission','order','cancel','gmv'])
        assertNumeric(row[k],k,{allowNegative:k==='commission'||k==='gmv'});
    }
    return row;
  });
}
function sum(rows,k){return rows.reduce((v,r)=>v+Number(r[k]),0)}
function consolidate(clickResponse, commissionResponse, date,channel=CHANNEL){
  const clicks=parseRows(clickResponse,'clicks',date,channel);
  const commission=parseRows(commissionResponse,'commission',date,channel);
  if(!clicks.length&&!commission.length)return {
    evidence:'partner_report_missing_or_zero_rows', canWrite:false, daily:null
  };
  const daily={
    report_date:date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8),
    sub_id:channel, clicks:clicks.length?sum(clicks,'click'):null,
    orders:commission.length?sum(commission,'order'):null,
    cancels:commission.length?sum(commission,'cancel'):null,
    gmv:commission.length?sum(commission,'gmv'):null,
    commission:commission.length?sum(commission,'commission'):null,
    partner_report_source:'coupang_partners_reporting_api',
    fetched_at:new Date().toISOString()
  };
  return {evidence:'official_partner_aggregated_preliminary',canWrite:true,daily,
    rows:{clicks:clicks.length,commission:commission.length}};
}
function kstNow(){
  const x=new Date(Date.now()+9*60*60*1000).toISOString();
  return {date:x.slice(0,10).replace(/-/g,''),hour:Number(x.slice(11,13))};
}
function publishedDate(date) {
  if(!/^20\d{6}$/.test(date))return false;
  const kst=kstNow();
  // Prior day is only safe after the next day's reporting window.
  if(date>=kst.date)return false;
  const yesterday=new Date(Date.UTC(Number(kst.date.slice(0,4)),Number(kst.date.slice(4,6))-1,Number(kst.date.slice(6,8))-1)).toISOString().slice(0,10).replace(/-/g,'');
  if(date===yesterday&&kst.hour<16)return false;
  return true;
}
function authorization(method, path, query){
  const d=new Date(),ts=String(d.getUTCFullYear()).slice(-2)
    +String(d.getUTCMonth()+1).padStart(2,'0')+String(d.getUTCDate()).padStart(2,'0')+'T'
    +String(d.getUTCHours()).padStart(2,'0')+String(d.getUTCMinutes()).padStart(2,'0')
    +String(d.getUTCSeconds()).padStart(2,'0')+'Z';
  const sig=crypto.createHmac('sha256',process.env.COUPANG_SECRET_KEY)
    .update(ts+method+path+query).digest('hex');
  return 'CEA algorithm=HmacSHA256, access-key='+process.env.COUPANG_ACCESS_KEY
    +', signed-date='+ts+', signature='+sig;
}
async function report(type,date,fetcher=fetch) {
  const path=REPORT_PREFIX+type;
  const query=new URLSearchParams({startDate:date,endDate:date,subId:CHANNEL,page:'0'}).toString();
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),13000);
  try{
    const r=await fetcher(EXTERNAL_HOST+path+'?'+query,{
      signal:ctl.signal,
      headers:{
        Authorization:authorization('GET',path,query),
        'User-Agent':'SEOSA/1.0 (+https://seosa.ai.kr)',
        Accept:'application/json'
      }
    });
    if(!r.ok)throw Error(type+' HTTP '+r.status);
    const raw=await r.text();if(raw.length>3*1024*1024)throw Error('oversized report');
    return JSON.parse(raw);
  }finally{clearTimeout(timer)}
}
function argsOf(argv){
  return {date:((argv.find(a=>a.startsWith('--date='))||'').split('=')[1]||''),
    write:argv.includes('--write')&&!argv.includes('--dry-run')};
}
async function main(){
  const args=argsOf(process.argv.slice(2));
  if(!/^20\d{6}$/.test(args.date))throw Error('pass --date=yyyyMMdd');
  if(!publishedDate(args.date))throw Error('partner daily report NOT YET PUBLISHED; retry after next day 16:00 KST');
  const p=process.env.COUPANG_ENV_FILE||path.resolve(__dirname,'..','.env.local');
  if(fs.existsSync(p))require('dotenv').config({path:p,quiet:true});
  if(!process.env.COUPANG_ACCESS_KEY||!process.env.COUPANG_SECRET_KEY)
    throw Error('missing report API credentials');
  // Both succeed or nothing is written.
  const [clickResult,commissionResult]=await Promise.all([
    report('clicks',args.date),report('commission',args.date)
  ]);
  const result=consolidate(clickResult,commissionResult,args.date);
  console.log(JSON.stringify({kind:'PARTNER_DAILY_SYNC',date:args.date,
    evidence:result.evidence,canWrite:result.canWrite,dryRun:!args.write,
    channel:CHANNEL,rows:result.rows||{},
    clicks:result.daily?result.daily.clicks:null,
    orderCount:result.daily?result.daily.orders:null,
    reportedCommission:result.daily?result.daily.commission:null,
    commissionIsFinalPayout:false}));
  if(!args.write||!result.canWrite)return;
  const db=require('../api/_supabase');
  const {error}=await db.from('coupang_partner_channel_daily')
    .upsert(result.daily,{onConflict:'report_date,sub_id'});
  if(error)throw Error('partner daily aggregate DB write failed');
  console.log('PARTNER_AGGREGATE_UPSERT_SUCCESS');
}
if(require.main===module)main().catch(e=>{
  console.error(JSON.stringify({kind:'PARTNER_DAILY_SYNC_FAILED',reason:String(e.message).slice(0,100)}));
  process.exitCode=1;
});
module.exports={parseRows,consolidate,publishedDate,argsOf,report};
