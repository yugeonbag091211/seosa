'use strict';
const assert = require('node:assert/strict');
const { extractTitleEvidence, mergeRequested, checkListingIdentity } = require('../api/_ai-v3-identity');
const { listingGuard, mixedListing, promotionalKeywordStuffing } = require('../api/_ai-v34-listing-guards');
const cases = [
  ['Gram 16 bare size', () => {
    assert.equal(extractTitleEvidence('LG 그램 16').screenInches, 16);
    assert.equal(extractTitleEvidence('LG전자 그램16 16Z90RU 노트북').screenInches, 16);
    assert.equal(extractTitleEvidence('LG 그램 16Z90RU 노트북').screenInches, undefined);
    assert.equal(checkListingIdentity('LG 그램16 16Z90RU 노트북', {screenInches:16},{category:'노트북'}).ok,true);
  }],
  ['Galaxy Tab FE vs FE+ follow-up', () => {
    const before={family:'galaxytab',series:'10',variant:'fe-plus',storageGb:256};
    const after=mergeRequested(before,'S10 FE로',false);
    assert.equal(after.family,'galaxytab');
    assert.equal(after.series,'10');
    assert.equal(after.variant,'fe');
    assert.equal(checkListingIdentity('삼성 갤럭시 탭 S10 FE+ 256GB',after,{category:'태블릿'}).ok,false);
    assert.equal(checkListingIdentity('삼성 갤럭시 탭 S10 FE 256GB',after,{category:'태블릿'}).ok,true);
  }],
  ['Different maker slash listing is a promotion', () => {
    assert.equal(mixedListing('삼성핏3/마샬 블루투스 스피커 최저가','스피커'),true);
    assert.equal(mixedListing('삼성 갤럭시 버즈3 프로 / 화이트 256GB','이어폰'),false);
    assert.equal(mixedListing('소니 헤드폰 / 삼성 스마트폰 호환 연결','헤드폰'),false);
  }],
  ['Requested maker stuffed after advertising claims', () => {
    const title='스마트헤드셋 V1000 블루투스 1위 헤드셋 소니 블루투스 헤드셋';
    assert.equal(promotionalKeywordStuffing(title,'헤드폰','소니 무선 헤드폰'),true);
    assert.equal(listingGuard({title,price:45410},{category:'헤드폰',userText:'소니 무선 헤드폰'}),'promotional_keyword_stuffing');
    assert.equal(promotionalKeywordStuffing('소니 WH-1000XM5 헤드폰 인기 검색어 소니 헤드폰','헤드폰','소니 헤드폰'),false);
  }],
  ['Legitimate seller titles remain eligible', () => {
    assert.equal(listingGuard({title:'소니 WH-1000XM5 블루투스 헤드폰',price:350000},{category:'헤드폰',userText:'소니 헤드폰'}),'');
    assert.equal(listingGuard({title:'마샬 액톤 III 블루투스 스피커',price:230000},{category:'스피커',userText:'마샬 스피커'}),'');
  }]
];
// The async catalog proof runs separately because every other case is pure.
async function catalogProof() {
  const { searchCatalog } = require('../api/_ai-v3-catalog');
  const { createSnapshotDb } = require('./ai-v31-rootcause/snapshot-db');
  const fresh = new Date(Date.now()-86400000).toISOString();
  const old = new Date(Date.now()-25*86400000).toISOString();
  const rows=Array.from({length:51},(_,i)=>({
    product_id:'other-'+i,mall:'쿠팡',keyword:'외장 SSD',
    title:'다른 브랜드 외장 SSD T7 1TB 신형 '+i,lprice:129000,collected_at:fresh,
    link:'https://example.com/o'+i
  }));
  rows.push({product_id:'old-samsung',mall:'쿠팡',keyword:'외장 SSD',
    title:'삼성전자 포터블 외장 SSD T7 1TB',lprice:145000,collected_at:old,
    link:'https://example.com/s'});
  const db=createSnapshotDb(rows);
  const mapRow=r=>({productId:r.product_id,title:r.title,lprice:r.lprice,mall:r.mall,link:r.link});
  const found=await searchCatalog('삼성 T7 1TB 가격 알려줘',{db,searchStrategy:'db-first',
    category:'외장하드',userText:'삼성 T7 1TB 가격 알려줘',identity:extractTitleEvidence('삼성 T7 1TB'),
    mapRow});
  assert(found.some(x=>x.productId==='old-samsung'),'narrow read must find a SKU past the broad LIMIT 40');
  assert(found._queries<=20,'bounded DB work');
  console.log('PASS Exact SKU exists past the LIMIT 40; stale price can be distinguished from absence');
}
let passed=0;
for(const [name,test] of cases){ test(); passed++; console.log('PASS '+name); }
catalogProof().then(()=>console.log(JSON.stringify({passed:passed+1,failed:0}))).catch(e=>{console.error(e);process.exitCode=1;});
