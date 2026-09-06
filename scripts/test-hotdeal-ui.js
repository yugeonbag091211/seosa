'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

/*
 * ★ 이 파일은 네트워크를 한 번도 타지 않는다.
 *
 * hotdeals.js 는 vm.runInNewContext 안에서 돌고 그 context 가 가짜 fetch 를
 * 들고 있어서 실제 호출이 나갈 길은 원래 없다. 그런데도 여기서 global.fetch 를
 * 막는 이유는 둘이다.
 *
 *   1) 샌드박스 «밖» 의 실수를 잡는다. 이 파일에 나중에 무언가를 덧붙이다
 *      context 를 거치지 않고 fetch 를 부르면 그 순간 터진다.
 *   2) scripts/test-release.js 의 SAFE 검사(★ 유료 API 방지)가 파일마다
 *      `global.fetch =` 를 찾는다. 그 검사는 정규식으로 볼 수밖에 없어서
 *      vm 샌드박스를 알아보지 못하고, 이 파일을 «mock 없이 fetch 를 부르는
 *      테스트» 로 신고했다(실측: e876d8c 단독에서도 FAIL 1).
 *      검사를 느슨하게 푸는 대신 이 파일이 관례를 따른다 — 그 검사는
 *      유료 API 로 나가는 것을 막는 마지막 그물이라 약하게 만들면 안 된다.
 *      (같은 관례: scripts/test-product-page.js)
 */
global.fetch=async url=>{throw new Error(`오프라인 테스트에서 외부 호출: ${url}`)};

const V=require('../public/hot-view');
const d={id:7,title:'<img src=x onerror=alert(1)>',price:89000,status:'POTENTIAL_DEAL',mall:'쿠팡',reason:'<script>bad</script>',image:'javascript:alert(1)',score:87.392,url:'https://example.com/buy'};
const html=V.card(d);
assert(!html.includes('<script>'));assert(!html.includes('<img'));assert(!html.includes('87.392'));assert(html.includes('추가 확인 중'));assert(html.includes('/hotdeals.html?id=7'));assert(!html.includes(d.url));assert(html.includes('89,000원'));
for(const value of [null,undefined,0,-1,Infinity,NaN,'89000'])assert.equal(V.price(value),'가격 확인 중');
assert.equal(V.time('invalid'),'');assert.equal(V.time('2999-01-01'),'');assert.equal(V.url('data:text/html,bad'),'');assert.equal(V.card(null),'');assert.equal(V.card({title:'no id'}),'');

/* ── /api/hotdeals 새 계약 (2026-09-07) ──────────────────────────────
 *
 * ★ 여기서 지키는 것은 하나다 — **null 은 모름이고, 모르면 말하지 않는다.**
 *   서버(api/_hotdeal.signalsOf)가 근거 없는 신호를 0 이 아니라 null 로 주는
 *   이유가 그것이라, 화면이 0 으로 바꾸는 순간 계약이 무의미해진다.
 */
{
  // num(): 숫자가 아닌 것은 전부 null
  for(const v of [null,undefined,'12',NaN,Infinity,-Infinity,{},[]]) assert.equal(V.num(v),null,`num(${JSON.stringify(v)})`);
  assert.equal(V.num(0),0); assert.equal(V.num(-3),-3);
  assert.equal(V.won(null),''); assert.equal(V.won(31000),'31,000원');
  assert.equal(V.pct(null),''); assert.equal(V.pct(11.53),'11.5%');

  // 신호가 통째로 없으면 아무 줄도 그리지 않는다
  assert.equal(V.drop(null),''); assert.equal(V.drop({}),''); assert.equal(V.evidence(null),''); assert.equal(V.evidence({}),'');

  // 값이 «올랐을» 때 없는 할인을 만들지 않는다 (서버는 percent 를 음수로 준다)
  assert.equal(V.drop({priceDropAmount:null,priceDropPercent:-4.2}),'','오른 상품에 하락 표시 금지');
  assert.equal(V.drop({priceDropAmount:0,priceDropPercent:0}),'','0 은 하락이 아니다');

  // 하락이 실제로 있을 때만, 그리고 기준을 밝히면서
  const dropHtml=V.drop({priceDropAmount:31000,priceDropPercent:11.53,referencePrice:270000,referenceKind:'median30'});
  assert(dropHtml.includes('31,000원 ↓'),'하락 금액');
  assert(dropHtml.includes('11.5%'),'하락률');
  assert(dropHtml.includes('최근 30일 중앙값'),'기준을 밝힌다');
  assert(dropHtml.includes('270,000원'),'기준 가격은 title 로');

  // 근거의 두께
  const ev=V.evidence({nearHistoricalLow:true,historyCount:24,historyDays:33,freshness:'fresh'});
  assert(ev.includes('최근 최저가 근처')); assert(ev.includes('가격 기록 24회')); assert(ev.includes('33일'));
  assert(!ev.includes('오래'),'fresh 에 경고를 붙이지 않는다');
  assert(V.evidence({freshness:'stale'}).includes('오래'),'stale 은 경고한다');
  assert(!V.evidence({nearHistoricalLow:false,historyCount:null}).includes('가격 기록'),'모르면 기록 수를 말하지 않는다');
  assert(!V.evidence({historyCount:0}).includes('가격 기록 0'),'0회를 「기록 0회」로 쓰지 않는다');

  // 최저가 판매처 — offerCount ≤ 1 이면 (grouped:false 포함) 아무 말도 하지 않는다
  assert.equal(V.offers({offerCount:1,isLowest:true,mall:'쿠팡'}),'','단독 오퍼는 비교하지 않는다');
  assert.equal(V.offers({offerCount:null,isLowest:true}),'','grouped:false fallback');
  assert(V.offers({offerCount:3,isLowest:true,mall:'쿠팡',otherOfferCount:2}).includes('최저가'));
  assert(V.offers({offerCount:3,isLowest:true,mall:'쿠팡',otherOfferCount:2}).includes('다른 판매처 2곳'));
  const alt=V.offers({offerCount:2,isLowest:false,lowestMall:'ADPICK',lowestPrice:79000});
  assert(alt.includes('ADPICK')&&alt.includes('79,000원')&&alt.includes('더 저렴'),'더 싼 곳을 숨기지 않는다');

  // 카드 통합 — 있는 값은 보이고, 없는 값은 흔적도 없다
  const rich=V.card({...d,id:11,title:'상품',signals:{priceDropAmount:31000,priceDropPercent:11.5,referencePrice:270000,referenceKind:'median30',nearHistoricalLow:true,historyCount:24,historyDays:33,freshness:'fresh'},offerCount:3,otherOfferCount:2,isLowest:true,lowestMall:'쿠팡'});
  assert(rich.includes('31,000원 ↓')&&rich.includes('11.5%')&&rich.includes('가격 기록 24회')&&rich.includes('최근 최저가 근처')&&rich.includes('최저가'));
  const bare=V.card({...d,id:12,title:'상품',signals:{priceDropAmount:null,priceDropPercent:null,historyCount:0,freshness:null},offerCount:1,otherOfferCount:0,isLowest:true});
  assert(!bare.includes('hot-drop'),'하락 근거가 없으면 그 줄이 없다');
  assert(!bare.includes('hot-tags'),'근거가 없으면 태그 줄이 없다');
  assert(!bare.includes('다른 판매처'),'단독 오퍼에 판매처 비교 없음');
  assert(!bare.includes('NaN')&&!bare.includes('null')&&!bare.includes('undefined'),'모름이 문자열로 새지 않는다');
  // signals 자체가 없는 응답(구버전 서버)에서도 카드가 성립한다
  const legacy=V.card({...d,id:13,title:'상품'});
  assert(legacy.includes('89,000원')&&!legacy.includes('hot-drop')&&!legacy.includes('undefined'));
  // XSS — 새 필드도 이스케이프한다
  const evil=V.card({...d,id:14,title:'상품',lowestMall:'<img src=x onerror=alert(1)>',offerCount:2,isLowest:false,lowestPrice:1000});
  assert(!evil.includes('<img src=x'),'lowestMall 이스케이프');
}
function harness(search=''){
 const elements=new Map();function el(id){if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',hidden:false,disabled:false,value:'score',children:[],attrs:{},setAttribute(k,v){this.attrs[k]=v},insertAdjacentHTML(_,v){this.innerHTML+=v}});return elements.get(id)}
 const requests=[];const context={window:{HotView:V},document:{title:'',documentElement:{dataset:{theme:'light'}},getElementById:el},location:{search},URLSearchParams,AbortController,setTimeout,clearTimeout,localStorage:{setItem(){}},fetch(url){return new Promise((resolve,reject)=>requests.push({url,resolve,reject}))}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../public/hotdeals.js'),'utf8'),context);
 return {el,requests};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function answer(r,data,status=200){r.resolve({ok:status===200,status,json:async()=>data})}
(async()=>{
 let h=harness();assert.equal(h.el('deals').attrs['aria-busy'],'true');answer(h.requests[0],{items:[],nextCursor:null});await tick();assert(h.el('status').textContent.includes('찾고 있어요'));assert.equal(h.el('more').hidden,true);
 h.el('sort').onchange();h.requests[1].reject(new Error('private database stack'));await tick();assert.equal(h.el('retry').hidden,false);assert(!h.el('status').textContent.includes('database'));h.el('retry').onclick();answer(h.requests[2],{items:[d],nextCursor:24});await tick();assert(h.el('deals').innerHTML.includes('89,000원'));assert.equal(h.el('more').hidden,false);
 h.el('more').onclick();h.requests[3].reject(new Error('offline'));await tick();assert(h.el('deals').innerHTML.includes('89,000원'));h.el('retry').onclick();assert(h.requests[4].url.includes('cursor=24'));answer(h.requests[4],{items:[d,{...d,id:8}],nextCursor:null});await tick();assert.equal((h.el('deals').innerHTML.match(/class="hot-card"/g)||[]).length,2);
 h=harness();h.el('sort').value='price';h.el('sort').onchange();answer(h.requests[1],{items:[{...d,title:'new sort'}]});await tick();answer(h.requests[0],{items:[{...d,title:'old sort'}]});await tick();assert(h.el('deals').innerHTML.includes('new sort'));assert(!h.el('deals').innerHTML.includes('old sort'));
 h=harness('?id=7');answer(h.requests[0],{deal:{...d,reasons:[{text:'확인 근거'}],observations:null,spanDays:null,median30:null,observedLow:null}});await tick();assert(h.el('detail').innerHTML.includes('확인 근거'));assert(!h.el('detail').innerHTML.includes('<dl'));assert(h.el('detail').innerHTML.includes('sponsored nofollow noopener'));assert(!h.el('detail').innerHTML.includes('/p/'));
 h=harness('?id=8');answer(h.requests[0],{deal:{...d,productId:'123',mall:'쿠팡',observations:24,median30:99000}});await tick();assert(h.el('detail').innerHTML.includes('/p/123?mall='));assert(h.el('detail').innerHTML.includes('24회'));assert(h.el('detail').innerHTML.includes('중앙값'));
 h=harness('?id=9');answer(h.requests[0],{},404);await tick();assert(h.el('status').textContent.includes('확인할 수 없는'));assert(h.el('detail').innerHTML.includes('핫딜 목록'));

 /* ── 상세: 새 계약 (signals · otherOffers · isLowest · grouped) ────── */

 // 판매처 비교 — 자기 자신도 표에 넣되 «지금 보는 곳» 으로 표시하고, 최저가를 표시한다
 h=harness('?id=20');
 answer(h.requests[0],{deal:{...d,id:20,title:'상품',price:89000,mall:'쿠팡',url:'https://example.com/buy',
   signals:{priceDropAmount:11000,priceDropPercent:11,referencePrice:100000,referenceKind:'median30',historyCount:24,historyDays:33,nearHistoricalLow:true,observedLow:88000,previousPrice:95000,freshness:'fresh'},
   offerCount:3,otherOfferCount:2,isLowest:false,lowestMall:'ADPICK',lowestPrice:79000,
   otherOffers:[{mall:'ADPICK',price:79000,url:'https://ad.example/1',status:'GOOD_DEAL'},{mall:'11번가',price:120000,url:'',status:'NORMAL'}]}});
 await tick();
 {
  const h20=h.el('detail').innerHTML;
  assert(h20.includes('판매처 가격 비교'),'비교표를 그린다');
  assert(h20.includes('ADPICK')&&h20.includes('79,000원'),'다른 판매처의 값');
  assert(h20.includes('11번가')&&h20.includes('링크 없음'),'링크 없는 오퍼도 값은 보여 준다');
  assert(h20.includes('지금 보는 곳'),'자기 자신을 표시한다');
  // 표 안에서만 본다 — 상단 대표 가격에도 89,000원 이 있어서 전체 문자열로는 뜻이 없다
  const table=h20.slice(h20.indexOf('<table'),h20.indexOf('</table>'));
  assert(table.indexOf('79,000원')<table.indexOf('89,000원'),'싼 순으로 정렬');
  assert(table.indexOf('89,000원')<table.indexOf('120,000원'),'자기 자신도 값 순서에 낀다');
  assert(table.slice(0,table.indexOf('89,000원')).includes('최저가'),'최저가 표시는 가장 싼 행에');
  assert(h20.includes('hd-cheaper')&&h20.includes('ADPICK 79,000원에서 더 저렴'),'더 싼 곳을 구매 버튼 위에서 말한다');
  assert(h20.indexOf('hd-cheaper')<h20.indexOf('hd-actions'),'경고가 구매 버튼보다 위');
  assert(h20.includes('11,000원 ↓')&&h20.includes('11%'),'하락 근거');
  assert(h20.includes('내린 금액')&&h20.includes('직전 확인 가격')&&h20.includes('95,000원'),'근거를 값으로 늘어놓는다');
  assert(h20.includes('가격 기록')&&h20.includes('24회')&&h20.includes('33일'),'신뢰도');
  assert(h20.includes('88,000원')&&h20.includes('지금 그 수준'),'관측 최저가 + 근접');
  assert(h20.includes('sponsored nofollow noopener'),'제휴 링크 규칙 유지');
 }

 // grouped:false / 단독 오퍼 — 비교 UI 가 통째로 사라지고 나머지는 그대로 뜬다
 h=harness('?id=21');
 answer(h.requests[0],{deal:{...d,id:21,title:'상품',mall:'쿠팡',productId:'p9',
   signals:{priceDropAmount:null,priceDropPercent:null,referencePrice:null,referenceKind:null,historyCount:null,historyDays:null,nearHistoricalLow:false,observedLow:null,previousPrice:null,freshness:null},
   offerCount:1,otherOfferCount:0,isLowest:true,lowestMall:'쿠팡',otherOffers:[]}});
 await tick();
 {
  const h21=h.el('detail').innerHTML;
  assert(!h21.includes('판매처 가격 비교'),'비교할 것이 없으면 표를 그리지 않는다');
  assert(!h21.includes('hd-cheaper'),'isLowest true 면 경고 없음');
  assert(!h21.includes('hot-drop'),'하락 근거가 없으면 그 줄이 없다');
  assert(!h21.includes('<dl'),'근거가 하나도 없으면 목록 자체가 없다');
  assert(!h21.includes('null')&&!h21.includes('undefined')&&!h21.includes('NaN'),'모름이 문자열로 새지 않는다');
  assert(h21.includes('/p/p9?mall='),'상품 상세 경로는 그대로');
 }

 // 구버전 응답(signals 없음)에서도 상세가 성립한다 — 배포 순서 방어
 h=harness('?id=22');
 answer(h.requests[0],{deal:{...d,id:22,title:'상품',observations:12,spanDays:20,median30:99000,observedLow:88000}});
 await tick();
 {
  const h22=h.el('detail').innerHTML;
  assert(h22.includes('12회')&&h22.includes('20일')&&h22.includes('중앙값'),'구 필드로 근거를 채운다');
  assert(!h22.includes('판매처 가격 비교')&&!h22.includes('undefined'));
 }

 console.log('PASS hotdeal UI: escaping, missing data, internal navigation, states, retry, pagination, stale response, detail evidence, signals/offers contract');
})().catch(e=>{console.error(e);process.exitCode=1});
