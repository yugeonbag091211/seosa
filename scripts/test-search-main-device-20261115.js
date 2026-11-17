'use strict';
/* Regression of 2026-11-15 production search issue; zero external API and DB calls. */
const assert = require('node:assert/strict');
const shop = require('../api/_shop');
const trust = require('../api/_trust');
const facets = require('../api/_facets');
const limiter = require('../api/_ratelimit');
const { listingGuard } = require('../api/_ai-v34-listing-guards');
let fixtures = [];
let writes = 0;
let calls = 0;
let savedTitles = [];
shop.searchAll = async () => ({items:fixtures.map((title,i)=>({
  title,productId:'fixture-'+i,mall:'쿠팡',lprice: /충전기 포함/.test(title) ? 499000 : i===0 || /매직키보드|사용설명서/.test(title) ? 599000 : 10000+1000*i,
  link:'https://example.com/offer/'+i,_source:'api'
})),from:'api',failed:false,blocked:false,errors:[]});
shop.saveProducts = async (_keyword, items) => {writes++; savedTitles.push(...items.map(x=>x.title)); return {saved:0};};
trust.attachTrust = async () => {};
facets.attachPriceChange = async () => {};
limiter.guard = () => true;
const handler = require('../api/search');
async function query(keyword, titles) {
  fixtures = titles;calls++;
  const response = {statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;}, status(n){this.statusCode=n;return this;},json(x){this.body=x;return this;}};
  await handler({method:'GET',headers:{},query:{keyword}},response);
  assert.equal(response.statusCode,200,keyword);
  assert.ok(Array.isArray(response.body),keyword);
  return response.body.map(x=>x.title);
}
(async()=>{
let count=0;
const body='Apple 정품 2022 아이패드 10세대';
const magic='Apple 아이패드 10세대 전용 매직키보드 폴리오 한국어';
const book='엄마아빠를 위한 아이패드 사용설명서';
const film='아이패드 10세대 액정보호필름';
const caseTitle='아이패드 10세대 전용 케이스';
const cached='아이패드 10세대 충전기 포함 와이파이 64GB 태블릿';
const ipad=await query('아이패드 10세대',[body,magic,book,film,caseTitle,cached]);
assert.ok(ipad.includes(body),'iPad body must survive');
assert.ok(ipad.includes(cached),'iPad body bundled with charger must survive');
assert.ok(!ipad.includes(magic),'keyboard not iPad');
assert.ok(!ipad.includes(book),'book not iPad');
assert.ok(!ipad.includes(film),'film not iPad');
assert.ok(!ipad.includes(caseTitle),'case not iPad');
assert.ok(savedTitles.includes(body) && savedTitles.includes(cached), 'legitimate iPads must be recorded');
assert.ok(!savedTitles.some(x => [magic,book,film,caseTitle].includes(x)), 'irrelevant products must not pollute the product DB');
console.log('PASS: iPad main results reject keyboard/book/film/case');count++;
assert.equal(listingGuard({title:book,price:599000},{category:'태블릿',userText:'아이패드 10세대'}),'publication_not_device');
assert.equal(listingGuard({title:'Apple 아이패드 10세대 64GB 태블릿 사용설명서 포함',price:499000},{category:'태블릿',userText:'아이패드 10세대'}),'');
console.log('PASS: usage manual for sale rejected, included manual preserved');count++;
const accessories=await query('아이패드 10세대 케이스',[body,caseTitle,film]);
assert.ok(accessories.includes(caseTitle),'explicit case query must find case');
console.log('PASS: explicit accessory query retains requested accessory');count++;
const laptop=await query('삼성 갤럭시북4 노트북',[
  '삼성전자 갤럭시북4 15.6인치 노트북',
  '삼성전자 갤럭시북4 키스킨',
  '삼성전자 갤럭시북4 노트북 파우치',
  '삼성전자 갤럭시북4 노트북 화면 보호 필름'
]);
assert.ok(laptop.includes('삼성전자 갤럭시북4 15.6인치 노트북'),'laptop body');
assert.ok(!laptop.some(x=>/키스킨|파우치|보호 필름/.test(x)),'laptop accessories');
console.log('PASS: laptop body vs accessories');count++;
const ears=await query('무선 이어폰',[
  '소니 블루투스 무선 이어폰',
  '무선 이어폰 실리콘 케이스',
  '무선 이어폰 충전용 파우치'
]);
assert.ok(ears.includes('소니 블루투스 무선 이어폰'));
assert.ok(!ears.some(x=>/케이스|파우치/.test(x)));
console.log('PASS: earbud body vs accessories');count++;
const swim=await query('수영복',['나이키 여성 원피스 수영복','코카콜라 오리지널']);
assert.deepEqual(swim,['나이키 여성 원피스 수영복']);
console.log('PASS: unrelated food excluded');count++;
console.log('SEARCH_MAIN_DEVICE_PASS '+count+' checks, remote provider=0, DB=0, mocked saveProducts calls='+writes);
})().catch(e=>{console.error('SEARCH_MAIN_DEVICE_FAIL',e.stack);process.exitCode=1;});
