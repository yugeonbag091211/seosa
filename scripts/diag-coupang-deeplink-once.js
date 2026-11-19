#!/usr/bin/env node
'use strict';
/**
 * One authorized test of the Coupang Partners deeplink issuer.
 * Does not click any affiliate link; does not modify the SEOSA DB or catalog.
 * Product, item and vendorItem are supplied explicitly and validated.
 * Deliberately requires --execute to consume the partner quota.
 */
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const args=Object.fromEntries(process.argv.slice(2).filter(a=>a.startsWith('--')&&a.includes('='))
  .map(a=>{const i=a.indexOf('=');return[a.slice(2,i),a.slice(i+1)];}));
const execute=process.argv.includes('--execute');
const productId=String(args.productId||'');
const itemId=String(args.itemId||'');
const vendorItemId=String(args.vendorItemId||'');
const subId='SEOSA2026';
if(!/^\d{7,13}$/.test(productId)||!/^\d{7,14}$/.test(itemId)||!/^\d{7,14}$/.test(vendorItemId)){
  console.error('Required: --productId=... --itemId=... --vendorItemId=...');
  process.exit(2);
}
if(!execute){console.log('DRY_RUN_NO_PROVIDER_CALL');process.exit(0)}
const envPath=process.env.COUPANG_ENV_FILE||path.join(__dirname,'..','.env.local');
if(fs.existsSync(envPath))require('dotenv').config({path:envPath,quiet:true});
if(!process.env.COUPANG_ACCESS_KEY||!process.env.COUPANG_SECRET_KEY){console.error('CREDENTIALS_UNAVAILABLE');process.exit(2)}
const apiPath='/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink';
const rawUrl='https://www.coupang.com/vp/products/'+productId+'?itemId='+itemId+'&vendorItemId='+vendorItemId;
const d=new Date(),ts=String(d.getUTCFullYear()).slice(-2)
  +String(d.getUTCMonth()+1).padStart(2,'0')+String(d.getUTCDate()).padStart(2,'0')+'T'
  +String(d.getUTCHours()).padStart(2,'0')+String(d.getUTCMinutes()).padStart(2,'0')
  +String(d.getUTCSeconds()).padStart(2,'0')+'Z';
const sig=crypto.createHmac('sha256',process.env.COUPANG_SECRET_KEY)
  .update(ts+'POST'+apiPath).digest('hex');
const auth='CEA algorithm=HmacSHA256, access-key='+process.env.COUPANG_ACCESS_KEY
  +', signed-date='+ts+', signature='+sig;
const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),12000);
(async()=>{
  try{
    const res=await fetch('https://api-gateway.coupang.com'+apiPath,{
      method:'POST',signal:ctl.signal,
      headers:{Authorization:auth,'Content-Type':'application/json',
        'User-Agent':'SEOSA/1.0 (+https://seosa.ai.kr)'},
      body:JSON.stringify({coupangUrls:[rawUrl],subId})
    });
    const raw=await res.text();let json=null;try{json=JSON.parse(raw)}catch{}
    const data=Array.isArray(json&&json.data)?json.data:[];
    const rows=data.map(r=>{
      const result={};
      for(const name of ['originalUrl','shortenUrl','shortUrl','landingUrl']){
        try{
          const u=new URL(String(r[name]||''));result[name+'Host']=u.hostname;
          result[name+'PathKind']=u.pathname.startsWith('/re/AFF')?'affiliate':
            u.pathname.startsWith('/a/')?'short':u.pathname.startsWith('/vp/products/')?'product':'other';
          result[name+'SameProduct']=u.pathname.includes('/'+productId)||
            u.searchParams.get('productId')===productId;
          result[name+'SameVendor']=u.searchParams.get('vendorItemId')===vendorItemId;
          result[name+'Tagged']=Array.from(u.searchParams.entries()).some(([k,v])=>
            k.toLowerCase()==='subid'&&v===subId);
        }catch{result[name+'Host']=''}
      }
      return result;
    });
    console.log(JSON.stringify({kind:'DEEP_LINK_ISSUE_PROBE',http:res.status,
      rCode:json&&json.rCode==null?null:String(json&&json.rCode),
      count:data.length,rows,dbWrites:0,couponClicks:0}));
    if(!res.ok||String(json&&json.rCode)!=='0'||data.length!==1)process.exitCode=1;
  }catch(e){console.error(JSON.stringify({kind:'DEEP_LINK_ISSUE_PROBE',errorName:e.name||'Error'}));process.exitCode=1}
  finally{clearTimeout(timer)}
})().catch(()=>{clearTimeout(timer);process.exitCode=1});
