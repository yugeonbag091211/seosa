#!/usr/bin/env node
'use strict';
/**
 * Read-only Coupang Partners reporting diagnostic.
 * Never stores partner orders, keys, raw URLs, or customer information.
 * No requests to sales tracking links; only signed GET report endpoints.
 *
 * Usage:
 *   COUPANG_ENV_FILE=/secure/path/.env.local node scripts/diag-coupang-partner-report.js --date=20261119 --kind=clicks
 *   node scripts/diag-coupang-partner-report.js --date=20261118 --kind=orders
 *
 * This output is NOT evidence of an account payout or finalized revenue.
 */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const querystring = require('querystring');
const base = path.resolve(__dirname, '..');
const envPath = process.env.COUPANG_ENV_FILE || path.join(base, '.env.local');
if (fs.existsSync(envPath)) require('dotenv').config({path:envPath, quiet:true});

const apiHost = 'https://api-gateway.coupang.com';
const KINDS = new Set(['clicks','orders','commission','cancels']);
const args = Object.fromEntries(process.argv.slice(2).filter(a=>a.startsWith('--')&&a.includes('=')).map(a=>{
  const i=a.indexOf('=');
  return [a.slice(2,i), a.slice(i+1)];
}));
const date = String(args.date || '');
const kind = String(args.kind || '');
const subId = String(args.subId || 'SEOSA2026');
if (!/^20\d{6}$/.test(date)||!KINDS.has(kind)||!(subId==='ALL'||/^\w{8,20}$/.test(subId))) {
  console.error('Usage: --date=yyyyMMdd --kind=clicks|orders|commission|cancels [--subId=SEOSA2026]');
  process.exit(2);
}
if (!process.env.COUPANG_ACCESS_KEY || !process.env.COUPANG_SECRET_KEY) {
  console.error('CREDENTIALS_UNAVAILABLE'); process.exit(2);
}
const iso = new Date();
const ts = String(iso.getUTCFullYear()).slice(-2)
+String(iso.getUTCMonth()+1).padStart(2,'0')
+String(iso.getUTCDate()).padStart(2,'0')+'T'
+String(iso.getUTCHours()).padStart(2,'0')
+String(iso.getUTCMinutes()).padStart(2,'0')
+String(iso.getUTCSeconds()).padStart(2,'0')+'Z';
const apiPath='/v2/providers/affiliate_open_api/apis/openapi/v1/reports/'+kind;
const query=querystring.stringify({startDate:date,endDate:date,...(subId==='ALL'?{}:{subId}),page:0});
const hmac=crypto.createHmac('sha256',process.env.COUPANG_SECRET_KEY).update(ts+'GET'+apiPath+query).digest('hex');
const authorization='CEA algorithm=HmacSHA256, access-key='+process.env.COUPANG_ACCESS_KEY+', signed-date='+ts+', signature='+hmac;
const ctl=new AbortController();const timeout=setTimeout(()=>ctl.abort(),12000);
(async()=>{
  try {
    const res=await fetch(apiHost+apiPath+'?'+query,{
      method:'GET',signal:ctl.signal,
      headers:{Authorization:authorization,Accept:'application/json',
        'User-Agent':'SEOSA/1.0 (+https://seosa.ai.kr)'}
    });
    const responseText=await res.text();
    let body;
    try {body=JSON.parse(responseText)}catch{body=null}
    const rows=Array.isArray(body&&body.data)?body.data:[];
    const channelRows=subId==='ALL'?[]:rows.filter(r=>String(r&&r.subId||'')===subId);
    const n=(key)=>channelRows.reduce((s,r)=>s+(Number(r&&r[key])||0),0);
    console.log(JSON.stringify({
      report:'COUPANG_PARTNERS_OFFICIAL_API_READ_ONLY',
      date,kind,channel:subId,http:res.status,
      rCode:body&&body.rCode==null?null:String(body&&body.rCode),
      dataArray:Array.isArray(body&&body.data),totalReturnedRows:rows.length,
      channelReturnedRows:channelRows.length,
      targetChannelClicks:(kind==='clicks'||kind==='commission')?n('click'):null,
      targetChannelOrders:(kind==='commission')?n('order'):null,
      targetChannelCommission:(kind==='commission')?n('commission'):null,
      fields:rows[0]?Object.keys(rows[0]).filter(k=>!/(name|id|token|secret|key)/i.test(k)).slice(0,22):[],
      schemaOnly:subId==='ALL',
      // Shape only; NO order details/values outside the selected channel.
      completeForDate:false,
      note: 'Current-day partner reports are ordinarily published the following afternoon.'
    }));
    if(!res.ok || String(body&&body.rCode)!=='0')process.exitCode=1;
  }catch(e){
    console.error(JSON.stringify({date,kind,code:'REQUEST_FAILED',name:e.name||'Error'}));
    process.exitCode=1;
  }finally{clearTimeout(timeout)}
})().catch(()=>{process.exitCode=1;clearTimeout(timeout)});
