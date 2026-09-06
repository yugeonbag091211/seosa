'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const V=require('../public/hot-view');
const d={id:7,title:'<img src=x onerror=alert(1)>',price:89000,status:'POTENTIAL_DEAL',mall:'쿠팡',reason:'<script>bad</script>',image:'javascript:alert(1)',score:87.392,url:'https://example.com/buy'};
const html=V.card(d);
assert(!html.includes('<script>'));assert(!html.includes('<img'));assert(!html.includes('87.392'));assert(html.includes('추가 확인 중'));assert(html.includes('/hotdeals.html?id=7'));assert(!html.includes(d.url));assert(html.includes('89,000원'));
for(const value of [null,undefined,0,-1,Infinity,NaN,'89000'])assert.equal(V.price(value),'가격 확인 중');
assert.equal(V.time('invalid'),'');assert.equal(V.time('2999-01-01'),'');assert.equal(V.url('data:text/html,bad'),'');assert.equal(V.card(null),'');assert.equal(V.card({title:'no id'}),'');
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
 console.log('PASS hotdeal UI: escaping, missing data, internal navigation, states, retry, pagination, stale response, detail evidence');
})().catch(e=>{console.error(e);process.exitCode=1});
