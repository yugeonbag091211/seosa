'use strict';
const assert=require('node:assert/strict');
const {extractTitleEvidence,requestedIdentity,mergeRequested,checkListingIdentity} = require('../api/_ai-v3-identity');
const {validateCandidates,createEngine,resultFromSelection} = require('../api/_ai-v3-core');
let passed=0,failed=0;
async function test(name,fn){
  try {await fn();passed++;console.log('PASS '+name)}
  catch(e){failed++;console.log('FAIL '+name+': '+e.message)}
}
function row(id,title,price=490000,other={}){
  return {productId:id,title,lprice:price,mall:'쿠팡',
    link:'https://example.com/'+id,shippingFee:0,_source:'api',...other};
}
(async()=>{
  await test('request extracts explicitly asked family variant chip capacity and screen',()=>{
    const e=requestedIdentity('아이패드 에어 M4 13인치 256GB 와이파이');
    assert.equal(e.family,'ipad');assert.equal(e.variant,'air');
    assert.equal(e.chip,'m4');assert.equal(e.screenInches,13);
    assert.equal(e.storageGb,256);assert.equal(e.network,'wifi');
  });
  await test('requested 1TB equals listing 1024GB',()=>{
    const e=requestedIdentity('맥북 프로 M4 1TB');
    assert.equal(e.storageGb,1024);
    assert.equal(checkListingIdentity('Apple 맥북 프로 M4 1024GB',e).ok,true);
  });
  await test('requested text with no spec has no evidence invented',()=>{
    assert.deepEqual(requestedIdentity('가볍고 조용한 제품 뭐가 좋아?'),{});
  });
  await test('ambiguous multiple storage sizes are not treated as exact',()=>{
    const e=extractTitleEvidence('아이패드 에어 128GB / 256GB 선택 가능');
    assert.equal(e.family,'ipad'); assert.equal(e.storageGb,undefined);
  });
  await test('seller title with 16GB RAM and 512GB storage yields storage 512GB',()=>{
    assert.equal(extractTitleEvidence('맥북 에어 M4 16GB RAM 512GB SSD').storageGb,512);
  });
  await test('repeated parser calls have stable state',()=>{
    for(let i=0;i<10;i++){
      assert.equal(requestedIdentity('아이폰 15 프로').variant,'pro');
      assert.equal(extractTitleEvidence('iPhone 15 Pro').series,'15');
    }
  });
  await test('same user family permits Korean-English seller title translation',()=>{
    const check=checkListingIdentity('Apple iPad Air M4 13인치 WiFi 256GB',
      requestedIdentity('아이패드 에어 M4 13인치 256GB 와이파이'));
    assert.equal(check.ok,true);
  });
  await test('wrong product family rejected',()=>{
    const v=checkListingIdentity('삼성 갤럭시탭 S11 태블릿',requestedIdentity('아이패드 추천'));
    assert.equal(v.reason,'identity_mismatch');
  });
  await test('unknown family seller title is not considered verified',()=>{
    const v=checkListingIdentity('애플 태블릿 256GB',requestedIdentity('아이패드'));
    assert.equal(v.reason,'identity_unverified');
  });
  await test('wrong 128GB item rejected for 256GB user',()=>{
    const v=checkListingIdentity('아이패드 에어 128GB WiFi',requestedIdentity('아이패드 에어 256GB'));
    assert.equal(v.reason,'identity_mismatch');
    assert.equal(v.field,'storageGb');
  });
  await test('missing capacity rejected as unverified not guessed',()=>{
    const v=checkListingIdentity('아이패드 에어 M4 WiFi',requestedIdentity('아이패드 에어 256GB'));
    assert.equal(v.reason,'identity_unverified');
  });
  await test('requested tenth generation rejects ninth generation',()=>{
    const v=checkListingIdentity('애플 iPad 9세대 WiFi',requestedIdentity('아이패드 10세대'));
    assert.equal(v.reason,'identity_mismatch');
    assert.equal(v.field,'generation');
  });
  await test('M4 request rejects M3 chip',()=>{
    const v=checkListingIdentity('맥북 에어 M3 13인치',requestedIdentity('맥북 에어 M4'));
    assert.equal(v.reason,'identity_mismatch');
  });
  await test('M4 Pro not silently substituted for M4',()=>{
    const v=checkListingIdentity('맥북 프로 M4 Pro 14인치',requestedIdentity('맥북 프로 M4'));
    assert.equal(v.reason,'identity_mismatch');
  });
  await test('13-inch user does not get 11-inch listing',()=>{
    const v=checkListingIdentity('iPad Air 11인치 M4',requestedIdentity('아이패드 에어 13인치'));
    assert.equal(v.reason,'identity_mismatch');
  });
  await test('cellular listing is not WiFi-only listing',()=>{
    const v=checkListingIdentity('아이패드 에어 Wifi+Cellular 128GB',requestedIdentity('아이패드 에어 와이파이'));
    assert.equal(v.reason,'identity_mismatch');
    assert.equal(v.field,'network');
  });
  await test('iPhone 16 cannot satisfy iPhone 15 request',()=>{
    const v=checkListingIdentity('애플 iPhone 16 Pro 128GB',requestedIdentity('아이폰 15 프로'));
    assert.equal(v.reason,'identity_mismatch');
  });
  await test('iPhone 15 Pro Max is distinct from 15 Pro',()=>{
    const v=checkListingIdentity('아이폰 15 프로 맥스 256GB',requestedIdentity('아이폰 15 프로 256GB'));
    assert.equal(v.reason,'identity_mismatch');
  });
  await test('Galaxy Tab S11 not an S9',()=>{
    const v=checkListingIdentity('Galaxy Tab S11 256GB WiFi',requestedIdentity('갤럭시탭 S9'));
    assert.equal(v.reason,'identity_mismatch');
  });
  await test('Galaxy Tab S9 FE distinct from standard S9',()=>{
    const v=checkListingIdentity('Galaxy Tab S9 FE 128GB',requestedIdentity('갤럭시탭 S9'));
    assert.equal(v.reason,'identity_mismatch');
  });
  await test('Galaxy Tab S9 FE fits same exact family model',()=>{
    const v=checkListingIdentity('Galaxy Tab S9 FE 128GB',requestedIdentity('갤럭시탭 S9 FE 128GB'));
    assert.equal(v.ok,true);
  });
  await test('AirPods Pro distinct from regular',()=>{
    const v=checkListingIdentity('Apple AirPods 4',requestedIdentity('에어팟 프로'));
    assert.equal(v.reason,'identity_unverified');
  });
  await test('category filter plus identity excludes cross-family tablet',()=>{
    const p={category:'태블릿',identity:requestedIdentity('아이패드')};
    const c=validateCandidates(p,[row('1','갤럭시탭 S11 태블릿'),row('2','iPad Air 태블릿')]);
    assert.equal(c.accepted.length,1);assert.equal(c.accepted[0].id,'쿠팡:2');
    assert.equal(c.reasons.identity_mismatch,1);
  });
  await test('capacity and generation constraints reject wrong candidate in engine',async()=>{
    const result=await createEngine({
      planModel:async()=>({mode:'recommend',query:'아이패드 에어 M4',category:'태블릿',maxPrice:null}),
      searchProducts:async()=>[
        row('bad','아이패드 프로 M4 128GB 13인치'),
        row('bad2','아이패드 에어 M3 256GB 13인치'),
        row('good','아이패드 에어 M4 256GB 13인치'),
        row('bad3','아이패드 에어 M4 128GB 13인치')],
      decideModel:async({candidates})=>({productIds:['쿠팡:bad','쿠팡:bad2','쿠팡:good']})
    },{message:'아이패드 에어 M4 256GB 13인치 추천'});
    assert.equal(result.cards.length,1);
    assert.equal(result.cards[0].productId,'쿠팡:good');
    assert.equal(result.stats.rejectedReasons.identity_mismatch,3);
  });
  await test('seller title-only spec provenance appears in card',()=>{
    const i=row('1','아이패드 에어 M4 256GB 13인치');
    const p={category:'태블릿',identity:requestedIdentity('아이패드 에어 M4 256GB 13인치')};
    const candidates=validateCandidates(p,[i]).accepted;
    const got=resultFromSelection({mode:'recommend'},candidates,{productIds:['쿠팡:1']});
    assert.equal(got.cards[0].specEvidenceSource,'seller_listing_title_only');
    assert.equal(got.cards[0].titleEvidence.chip,'m4');
    assert.equal(got.cards[0].titleEvidence.storageGb,256);
  });
  await test('when spec unavailable no fabricated title evidence',()=>{
    const e=extractTitleEvidence('아이패드 에어 정품 태블릿');
    assert.equal(e.storageGb,undefined);
    assert.equal(e.chip,undefined);
  });
  await test('changing explicitly requested storage overrides previous storage',()=>{
    const old=requestedIdentity('아이패드 에어 128GB');
    const updated=mergeRequested(old,'256GB로 바꿔줘',false);
    assert.equal(updated.storageGb,256);
    assert.equal(updated.family,'ipad');
    assert.equal(updated.variant,'air');
  });
  await test('changing requested product family resets stale constraints',()=>{
    const old=requestedIdentity('아이패드 에어 256GB');
    const next=mergeRequested(old,'갤럭시탭으로 바꿔줘',true);
    assert.equal(next.family,'galaxytab');
    assert.equal(next.storageGb,undefined);
    assert.equal(next.variant,undefined);
  });
  await test('follow-up budget preserves previously grounded product specs',async()=>{
    let state;
    const dep={
      planModel:async()=>({mode:'recommend',query:'아이패드 에어',category:'태블릿',maxPrice:800000}),
      searchProducts:async()=>[row('1','아이패드 에어 M4 256GB',700000),row('2','아이패드 에어 M4 128GB',600000)],
      decideModel:async({candidates})=>({productIds:candidates.map(x=>x.id)})
    };
    const first=await createEngine(dep,{message:'아이패드 에어 M4 256GB 80만원 이하'});
    state=first.state;
    assert.equal(first.cards.length,1);
    assert.equal(state.identity.storageGb,256);
    const second=await createEngine(dep,{message:'70만원 이하로도 보여줘',state});
    assert.equal(second.cards.length,1);
    assert.equal(second.cards[0].title,'아이패드 에어 M4 256GB');
  });
  await test('chip comparison claims only seller-title evidence',()=>{
    const a=row('a','아이패드 에어 M4 256GB',580000);
    const b=row('b','갤럭시탭 S11 128GB',510000);
    const aa=validateCandidates({category:'태블릿'},[a,b]).accepted;
    const got=resultFromSelection({mode:'compare'},aa,{productIds:['쿠팡:a','쿠팡:b']});
    assert.match(got.answer,/판매 제목 기준/);
    assert.match(got.answer,/256GB/);
    assert.match(got.answer,/128GB/);
    assert.match(got.answer,/제조사 사양/);
    assert(!got.answer.includes('빠릅니다'));
  });
  await test('no comparative spec facts if seller title has no common evidence',()=>{
    const a=row('a','아이패드 태블릿',580000),b=row('b','갤럭시탭 태블릿',510000);
    const got=resultFromSelection({mode:'compare'},
      validateCandidates({category:'태블릿'},[a,b]).accepted,{productIds:['쿠팡:a','쿠팡:b']});
    assert.match(got.answer,/근거가 부족/);
  });
  await test('compare engine enforces distinct model attributes for each side',async()=>{
    const out=await createEngine({
      planModel:async()=>({mode:'compare',query:'아이패드 에어',compareQuery:'갤럭시탭 S9 FE',category:'태블릿'}),
      searchProducts:async q=>q.startsWith('아이패드')?[
        row('a','아이패드 프로 M4 128GB'),row('b','iPad Air M4 256GB 태블릿')]:[
        row('c','갤럭시탭 S11 태블릿'),row('d','갤럭시탭 S9 FE 128GB 태블릿')],
      decideModel:async({candidates})=>({productIds:candidates.map(c=>c.id)})
    },{message:'아이패드 에어와 갤럭시탭 S9 FE 비교해줘'});
    assert.equal(out.cards.length,2);
    assert.deepEqual(out.cards.map(c=>c.productId),['쿠팡:b','쿠팡:d']);
  });
  await test('RAM 16GB and SSD 512GB remain distinct',()=>{
    const requested=requestedIdentity('맥북 에어 M4 램 16GB SSD 512GB');
    const evidence=extractTitleEvidence('MacBook Air M4 16GB RAM / 512GB SSD');
    assert.equal(requested.ramGb,16);
    assert.equal(requested.storageGb,512);
    assert.equal(evidence.ramGb,16);
    assert.equal(evidence.storageGb,512);
    assert.equal(checkListingIdentity('MacBook Air M4 16GB RAM / 512GB SSD',requested).ok,true);
  });
  await test('32GB RAM alone is never inferred to be storage',()=>{
    const e=extractTitleEvidence('MacBook Pro M4 32GB RAM');
    assert.equal(e.ramGb,32);
    assert.equal(e.storageGb,undefined);
  });
  await test('requested 32GB RAM rejects 16GB RAM device',()=>{
    const v=checkListingIdentity('맥북 프로 M4 16GB RAM 512GB SSD',
      requestedIdentity('맥북 프로 M4 32GB RAM 512GB SSD'));
    assert.equal(v.reason,'identity_mismatch');
    assert.equal(v.field,'ramGb');
  });
  await test('requested RAM detail without title evidence is unverified',()=>{
    const v=checkListingIdentity('맥북 프로 M4 512GB SSD',
      requestedIdentity('맥북 프로 M4 16GB 램 512GB SSD'));
    assert.equal(v.reason,'identity_unverified');
    assert.equal(v.field,'ramGb');
  });
  await test('iPhone 16e is distinct from regular iPhone 16',()=>{
    assert.equal(extractTitleEvidence('iPhone 16e 128GB').variant,'e');
    assert.equal(checkListingIdentity('iPhone 16e 128GB',requestedIdentity('아이폰 16')).reason,
      'identity_mismatch');
    assert.equal(checkListingIdentity('iPhone 16e 128GB',requestedIdentity('아이폰 16e 128GB')).ok,
      true);
  });
  await test('seller promotional word does not get mistaken for Pro model',()=>{
    assert.equal(extractTitleEvidence('아이패드 10세대 프로모션 신상품').variant,undefined);
    assert.equal(checkListingIdentity('아이패드 10세대 프로모션 신상품',
      requestedIdentity('아이패드 10세대')).ok,true);
  });
  await test('mixed variant after a model is rejected',()=>{
    const v=checkListingIdentity('iPhone 15 Pro Max 256GB',
      requestedIdentity('아이폰 15 Pro 256GB'));
    assert.equal(v.reason,'identity_mismatch');
  });
  await test('storage ambiguity rejects exact requested capacity safely',()=>{
    const v=checkListingIdentity('iPad Air 128GB 또는 256GB 선택 가능',
      requestedIdentity('아이패드 에어 256GB'));
    assert.equal(v.reason,'identity_unverified');
    assert.equal(v.field,'storageGb');
  });
  await test('distinct unknown seller specs do not yield fabricated performance ratings',()=>{
    const first=row('a','iPad Air M4 128GB',550000),second=row('b','갤럭시탭 S9 FE 256GB',570000);
    const a=validateCandidates({category:'태블릿'},[first,second]).accepted;
    const out=resultFromSelection({mode:'compare'},a,{productIds:['쿠팡:a','쿠팡:b']});
    assert.match(out.answer,/판매 제목 기준/);
    assert(!/(?:성능이 높|벤치마크|배터리 오래|화면 더 선명)/.test(out.answer));
  });
  await test('user correction 128GB not 256GB keeps current family and new capacity',()=>{
    const r=requestedIdentity('아이패드 128GB 말고 256GB 추천해줘');
    assert.equal(r.family,'ipad');assert.equal(r.storageGb,256);
  });
  await test('user switches product family using 대신',()=>{
    const r=requestedIdentity('아이패드 대신 갤럭시탭 추천해줘');
    assert.equal(r.family,'galaxytab');assert.equal(r.storageGb,undefined);
  });
  await test('user correction changes model series',()=>{
    const r=requestedIdentity('아이폰 15 프로 아니고 아이폰 16 프로 추천해줘');
    assert.equal(r.family,'iphone');assert.equal(r.series,'16');assert.equal(r.variant,'pro');
  });
  await test('Galaxy Tab S9 FE+ is not the base S9 FE',()=>{
    const requested=requestedIdentity('갤럭시탭 S9 FE 128GB');
    for(const listing of [
      '삼성 갤럭시탭 S9 FE 플러스 128GB',
      '삼성 갤럭시탭S9FE+ 128GB',
      'Galaxy Tab S9 FE Plus 128GB'
    ]) {
      assert.equal(extractTitleEvidence(listing).variant,'fe-plus');
      assert.equal(checkListingIdentity(listing,requested).ok,false);
    }
    assert.equal(checkListingIdentity(
      '삼성전자 갤럭시탭S9FE 11인치 Wi-Fi 128GB SM-X510',requested).ok,true);
  });
  await test('search receives exact user capacity even when model plan omits it',async()=>{
    let observed;
    const result=await createEngine({
      planModel:async()=>({mode:'recommend',query:'갤럭시탭 S9 FE',category:'태블릿',maxPrice:null}),
      searchProducts:async(query,hints)=>{
        observed={query,hints};
        return [row('fe','삼성전자 갤럭시탭S9FE 11인치 Wi-Fi 128GB SM-X510')];
      },
      decideModel:async({candidates})=>({productIds:candidates.map(c=>c.id)})
    },{message:'갤럭시탭 S9 FE 128GB 추천해줘'});
    assert.equal(observed.query,'갤럭시탭 S9 FE');
    assert.equal(observed.hints.identity.storageGb,128);
    assert.equal(observed.hints.identity.variant,'fe');
    assert.equal(result.cards.length,1);
  });
  console.log(JSON.stringify({passed,failed,total:passed+failed}));
  if(failed)process.exitCode=1;
})().catch(e=>{console.error('Unexpected:',e);process.exitCode=1});
