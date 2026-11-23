'use strict';
// Offline snapshots from prior production audit. Never calls vendor or DB.
const http=require('node:http'),fs=require('node:fs');
const {rerank}=require('../api/_search21');
const {relation}=require('../api/_search2-object-relation');
const path=require('node:path');
const fixture=path.join(__dirname,'search21/fixtures/captured-20261123-public-search-top10.json');
const snapshots=JSON.parse(fs.readFileSync(fixture,'utf8')).rows;
const esc=s=>String(s??'').replace(/[&<>"']/g,
 c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const tags={target:'찾는 상품',possible:'가능성 있음',unknown:'불확실',
 other_object:'다른 판매 물건',non_product:'책·서비스'};
function toItems(row){
 return row.old.top10.map(x=>({...x,id:x.productId||'',
  relevance:Number.isFinite(Number(x.relevance))?Number(x.relevance):0}));
}
function cards(q,items){
 return '<ol>'+items.map((x,i)=>{
  const r=relation(q,x.title);
  const flag='<span class="flag '+r.grade+'">'+esc(tags[r.grade]||r.grade)+'</span>';
  return '<li><span class="num">'+(i+1)+'</span><div class="product">'+
    flag+'<div>'+esc(x.title)+'</div><small>'+esc(x.mall)+' · '+
    Number(x.price||0).toLocaleString('ko-KR')+'원'+
    (x.rank?' · 기존 '+x.rank+'위':'')+'</small></div></li>';
 }).join('')+'</ol>';
}
function page(q){
 const row=snapshots.find(x=>x.query===q)||snapshots[0];
 const old=toItems(row),next=rerank(row.query,old).items;
 const opts=snapshots.map(x=>'<option value="'+esc(x.query)+'"'+
   (x.query===row.query?' selected':'')+'>'+esc(x.query)+'</option>').join('');
 const css='*{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#182635;'+
   'font:14px/1.55 system-ui,-apple-system,sans-serif}'+
   'header{background:#132638;color:#fff;padding:28px max(16px,calc((100vw - 1200px)/2))}'+
   'h1{font-size:26px;margin:0}header p{color:#b9c7d3;margin:7px 0 0}'+
   'main{max-width:1200px;margin:auto;padding:22px 16px}select{padding:15px;font:inherit;'+
   'border:1px solid #bbc8d7;border-radius:10px;width:100%;background:#fff;margin-bottom:16px}'+
   '.note{border-radius:10px;padding:14px;background:#fff;color:#657587;'+
   'border:1px solid #dde4ed;margin-bottom:16px}'+
   '.cols{display:grid;grid-template-columns:1fr 1fr;gap:14px}'+
   'article{background:#fff;padding:17px;border-radius:12px;border:1px solid #dce3eb}'+
   'h2{font-size:19px}ol{list-style:none;margin:0;padding:0}li{display:flex;gap:12px;'+
   'border-top:1px solid #eef1f4;padding:11px 0}.num{width:20px;color:#9ca8b5}'+
   '.product{flex:1;min-width:0;overflow-wrap:anywhere}small{display:block;color:#76889a;margin-top:4px}'+
   '.flag{display:inline-block;font-size:11px;border:1px solid #c5cdd6;border-radius:5px;'+
   'padding:1px 6px;margin-bottom:5px}.target{color:#16734e;border-color:#a6d7c1}'+
   '.other_object,.non_product{color:#9e3a28;border-color:#e7bdb0}'+
   '@media(max-width:740px){.cols{grid-template-columns:1fr}}';
 return ['<!doctype html><html lang="ko"><head><meta charset="utf-8">',
 '<meta name="viewport" content="width=device-width,initial-scale=1">',
 '<title>SEOSA Search 2.1 · 로컬 비교</title><style>',css,'</style></head><body>',
 '<header><h1>SEOSA Search 2.1 · 비교 검증</h1>',
 '<p>같은 운영 상품명을 기존 엔진과 새로운 엔진으로 정렬</p></header>',
 '<main><form method="get"><select name="q" onchange="this.form.submit()">',opts,'</select></form>',
 '<div class="note"><strong>개발용 오프라인 미리보기</strong> · ',
 esc(row.query),' · 수집된 상위 10개 상품만 재정렬합니다. ',
 '실시간 검색과 가격 확인이 아니며 독립 정확도 검증도 아닙니다.</div>',
 '<div class="cols"><article><h2>기존 검색</h2>',cards(row.query,old),
 '</article><article><h2>Search 2.1</h2>',cards(row.query,next),
 '</article></div></main></body></html>'].join('');
}
const srv=http.createServer((req,res)=>{
 if(req.method!=='GET'){res.writeHead(405);res.end();return}
 const u=new URL(req.url,'http://127.0.0.1:17823');
 if(u.pathname!=='/'){res.writeHead(404);res.end();return}
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8',
  'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
  'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'"});
 res.end(page(u.searchParams.get('q')));
});
srv.listen(17823,'127.0.0.1',()=>{
 console.log('SEOSA SEARCH21 LOCAL PREVIEW http://127.0.0.1:17823/');
 console.log('CAPTURED_QUERIES',snapshots.length);
});
