'use strict';
// Exactly 1000 unique, natural user utterances through the real /api/ai handler.
// GPT, shop APIs and database are mocked; no external calls or DB writes allowed.
// One graded result per question. Do not add numeric suffixes to manufacture uniqueness.
const crypto=require('node:crypto');
const H=require('./_ai-chat-harness');
const F=require('./_ai-chat-fixtures');
const AC=require('../api/_aicontext');
F.ALL.forEach(H.addProduct);
const groups={},questions=[],failures=[],seen=new Set();
let ok=0,fail=0;
const cards=r=>Array.isArray(r?.body?.items)?r.body.items:[];
const answer=r=>String(r?.body?.text||'');
const valid=r=>r?.status===200&&answer(r).trim().length>0;
const products=r=>cards(r).length>0&&cards(r).every(c=>c.productId&&Number(c.lprice)>0);
function mark(group,q,r,pass,why){
 if(seen.has(q))throw Error('Duplicate question: '+q);
 seen.add(q);questions.push(q);
 const g=groups[group]||(groups[group]={asked:0,pass:0,fail:0});
 g.asked++;
 if(valid(r)&&pass){ok++;g.pass++;}
 else{fail++;g.fail++;const issue={group,question:q,why,status:r?.status,reply:answer(r).slice(0,100),ids:cards(r).slice(0,5).map(c=>c.productId)};
 failures.push(issue);if(failures.length<=100)console.log('AI_1000_FAIL '+JSON.stringify(issue));}
}
async function test(group,q,classify,model,check){
 let r,error='';
 try{r=await H.ask({question:q,chatHistory:[],contextProducts:[],view:{source:'none'}},{classify,answer:model});}
 catch(e){error=String(e?.message||e);}
 mark(group,q,r,!error&&!!check(r),error||'Incorrect grounding, product selection or safe fallback');
}
function combine(a,b,call){
 if(a.length!==10||b.length!==10)throw Error('Corpus design must be 10x10');
 return Promise.all([]).then(async()=>{
 for(const p of a)for(const t of b)await call(p,t);
 });
}
const explain='추천할 때는 확인된 상품 정보와 옵션을 우선하고, 가격이 과거 기록이면 현재 가격으로 단정하지 않겠습니다.';
(async()=>{
const specs=[
 ['그램 추천','C|그램 노트북',[
  '그램 노트북 추천해줘','LG 그램 시리즈에서 골라줘','LG전자 그램 몇 개 추천해줄래?',
  '노트북을 그램으로 사고 싶어','그램 노트북 가성비 모델은?',
  '그램으로 휴대용 노트북 찾아줘','그램 노트북 구입 상담해줘',
  'LG 그램 중에서 추천할 모델 있어?','그램 노트북 몇 개 비교해줘',
  '그램 모델 중 괜찮은 노트북 골라줘'],[
  '문서 작업을 주로 할 거야','학교 과제용이 필요해','영상 편집도 할 계획이야',
  '화상회의를 자주 해','화면이 컸으면 좋겠어','가끔 게임도 할 거야',
  '무게가 가벼우면 좋겠어','배터리 사용 시간이 중요해',
  '예산은 200만원 이하여야 해','가격 대비 구성도 보고 싶어'],'그램'],
 ['이어폰 추천','C|무선 이어폰',[
  '무선 이어폰 추천해줘','블루투스 이어폰 골라줘','노이즈캔슬링 이어폰 찾아줘',
  '음악 감상용 무선 이어폰 추천해줘','통화용 무선 이어폰 뭐가 좋아?',
  '가성비 좋은 무선 이어폰 골라줘','운동할 무선 이어폰 추천해줘',
  '귀가 편한 무선 이어폰 찾아줘','무선 이어폰 후보를 비교해줘',
  '출퇴근용 무선 이어폰 구매를 도와줘'],[
  '예산은 30만원 이하야','착용감이 중요해','배터리가 오래가야 해',
  '통화 품질도 고려해줘','지하철에서 쓰고 싶어','가격 기록이 있으면 확인해줘',
  '노이즈 캔슬링이 필요해','달리기할 때 쓸 예정이야',
  '지금 살지 고민 중이야','구매 전에 단점도 알려줘'],'이어폰|버즈|에어팟'],
 ['그램 가격','D|그램15 15ZB95N',[
  '그램15 15ZB95N 얼마야?','LG 그램15 15ZB95N 최저가 알려줘',
  '그램15 15ZB95N 현재가는?','그램15 15ZB95N 가격 이력 확인해줘',
  'LG 그램15 15ZB95N 판매가 비교해줘','그램15 15ZB95N 구매 시점은?',
  'LG 그램15 15ZB95N 할인 여부 알려줘','그램15 15ZB95N 가격이 싼 편이야?',
  '그램15 15ZB95N 가격 근거가 궁금해','그램15 15ZB95N 지금 살까?'],[
  '판매처 옵션을 확인해줘','예전 가격이면 날짜를 표시해줘',
  '학교 과제용으로 고려하고 있어','현재가가 확실한지 알고 싶어',
  '할인율에 근거가 있는지 궁금해','구매 전 체크할 것을 알려줘',
  'CPU 사양도 같이 알고 싶어','배터리 상태도 확인해야 해',
  '문서 작업용으로 적절한지 궁금해','지금 주문하는 게 나을까?'],'그램'],
 ['버즈 블랙','D|갤럭시 버즈3 프로 블랙',[
  '갤럭시 버즈3 프로 블랙 얼마야?','삼성 버즈3 프로 블랙 최저가 알려줘',
  '갤럭시 버즈3 프로 블랙 현재 가격은?','버즈3 프로 블랙 판매처 비교해줘',
  '삼성 갤럭시 버즈3 프로 블랙 할인 중이야?',
  '갤럭시 버즈3 프로 블랙 구매가가 궁금해','버즈3 프로 블랙 가격 이력 확인해줘',
  '갤럭시 버즈3 프로 블랙 지금 사도 돼?','버즈3 프로 블랙 색상 옵션 가격 알려줘',
  '삼성 버즈3 프로 블랙 상품 가격 근거 알려줘'],[
  '화이트 금액과 섞지 말아줘','블랙 옵션만 골라줘',
  '같은 모델이어도 색상을 구분해줘','판매처 가격을 따로 표시해줘',
  '정확한 옵션의 구매 링크가 필요해','최근 가격 변화도 봐줘',
  '결제 전에 현재 가격을 확인할 거야','오래된 기록이라면 알려줘',
  '할인이라고 단정하지 말아줘','옵션별 가격 이력도 분리해줘'],'버즈3'],
 ['버즈 화이트','D|갤럭시 버즈3 프로 화이트',[
  '갤럭시 버즈3 프로 화이트 얼마야?','삼성 버즈3 프로 화이트 최저가 알려줘',
  '갤럭시 버즈3 프로 화이트 현재가는?','버즈3 프로 화이트 가격 비교해줘',
  '갤럭시 버즈3 프로 화이트 가격 이력은?',
  '삼성 버즈3 프로 화이트 할인 여부 확인해줘','갤럭시 버즈3 프로 흰색 가격 궁금해',
  '화이트 버즈3 프로 지금 사도 될까?','갤럭시 버즈3 프로 화이트 구매 금액은?',
  '삼성 갤럭시 버즈3 프로 화이트 옵션을 찾아줘'],[
  '블랙 가격은 제외해줘','흰색 옵션만 확인해줘',
  '리퍼 상품과 혼동하지 마','다른 구성품 세트는 빼줘',
  '현재가와 과거 기록을 구분해줘','같은 옵션인지 확인해줘',
  '가격이 자주 바뀌는지 궁금해','판매처 정보도 확인해줘',
  '구매 전에 살펴볼 게 뭘까?','가격의 검증 시각이 필요해'],'버즈3'],
 ['에어팟','D|에어팟 프로 2',[
  '에어팟 프로 2 가격 알아봐줘','에어팟 프로 2세대 최저가 알려줘',
  '애플 에어팟 프로 2 얼마야?','AirPods Pro 2 현재가 확인해줘',
  '에어팟 프로 2 지금 사도 좋을까?','에어팟 프로 2세대 가격 이력 알려줘',
  '에어팟 프로 2 할인 중인지 궁금해','애플 에어팟 프로 2 가격 비교해줘',
  '에어팟 프로 2 구매 가격 알려줘','에어팟 프로 2세대 판매처를 찾아줘'],[
  'USB-C 버전으로 찾아줘','케이스만 파는 상품은 제외해줘',
  '신품과 중고를 구분해줘','최신 가격인지 확인해줘',
  '가격이 떨어진 적 있는지 알려줘','실제 결제 금액인지 궁금해',
  '옵션이 동일한 상품인지 확인해줘','예산은 40만원 이하야',
  '선물하려고 하는데 괜찮을까?','구매 전에 주의할 점 알려줘'],'에어팟']
];
for(const [group,kind,stems,details,rx]of specs){
 await combine(stems,details,async(a,b)=>{
  const q=a+' '+b+'.';
  await test(group,q,kind,explain,r=>{
   if(!products(r))return false;
   const pat=new RegExp(rx);
   if(!cards(r).some(c=>pat.test(c.title)))return false;
   // SEOSA intentionally includes clearly labelled NEAR sibling options. The
   // top recommendation must match the user's requested color; alternatives
   // are acceptable ONLY when their identity difference is explicitly tagged.
   if(group==='버즈 블랙'||group==='버즈 화이트'){
     const requested=group==='버즈 블랙'?F.BUDS_BLACK.vid:F.BUDS_WHITE.vid;
     const picked=AC.verifyRecommendationRef(r?.body?.topRecommendationRef);
     return picked?.vendorItemId===requested &&
       cards(r).every(c=>c.vendorItemId===requested||!!c.identityNote);
   }
   if(group==='에어팟')return cards(r).every(c=>c.productId===F.AIRPODS.pid);
   return true;
  });
 });
}
// Ten distinct model pairs and ten different comparison criteria (100 more).
const pairs=[
 '그램15와 그램16','그램15와 그램 프로','버즈3 프로 블랙과 화이트',
 'QCY T13 ANC와 JBL 튠 비즈2','소니 WF-1000XM5와 에어팟 프로 2',
 '버즈3 프로와 에어팟 프로 2','그램16과 그램 프로',
 'JBL 튠 비즈2와 소니 WF-1000XM5','QCY T13 ANC와 에어팟 프로 2',
 '블랙 버즈3 프로와 화이트 버즈3 프로'
];
const compare=[
 '어느 쪽이 가성비가 나아?','가격 차이가 얼마나 나?',
 '내 사용 목적에 맞는 쪽을 골라줘','구매 전 확인할 점은?',
 '모르는 스펙은 추측하지 말아줘','판매처와 옵션 차이를 비교해줘',
 '예산을 고려하면 어떤 선택이 나아?','장점과 단점을 구분해줘',
 '구매 시점 관점에서 비교해줘','성능과 가격을 따로 비교해줘'
];
await combine(pairs,compare,async(a,b)=>{
 const q=a+' 비교해줘. '+b;
 const expected=[
  [F.GRAM_15,F.GRAM_16],[F.GRAM_15,F.GRAM_PRO],[F.BUDS_BLACK,F.BUDS_WHITE],
  [F.QCY,F.JBL],[F.SONY,F.AIRPODS],[{pid:F.BUDS_BLACK.pid,vid:''},F.AIRPODS],
  [F.GRAM_16,F.GRAM_PRO],[F.JBL,F.SONY],[F.QCY,F.AIRPODS],[F.BUDS_BLACK,F.BUDS_WHITE]
 ][pairs.indexOf(a)];
 await test('상품 비교',q,'C|'+a,explain,r=>{
   const list=cards(r);
   const match=(card,expected)=>card.productId===expected.pid && (!expected.vid || card.vendorItemId===expected.vid);
   return valid(r)&&list.length===2&&list.every(c=>Number(c.lprice)>0)
     &&expected.every(p=>list.some(c=>match(c,p)))
     &&list.every(c=>expected.some(p=>match(c,p)));
 });
});
// 20 sessions × 5 turns = 100 connected, distinctive prompts.
const starts=[
 '그램 노트북 추천해줘','LG 그램 중 고를 만한 모델 있어?','그램 노트북 가격 비교해줘',
 '그램으로 공부할 노트북 찾아줘','그램 노트북 추천 부탁해','그램 시리즈 추천 좀 해줘',
 '노트북을 그램으로 사고 싶어','휴대용 그램 노트북을 골라줘',
 'LG 그램 중 가성비 모델은?','그램 노트북을 추천받고 싶어',
 '수업용 그램을 찾아줘','과제용 그램 노트북을 골라줘',
 '출퇴근용 그램 노트북 추천해줘','가벼운 그램 모델 추천해줘',
 '문서 작업용 그램 찾고 있어','화상회의용 그램 노트북 추천해줘',
 '영상 편집용 그램 노트북을 추천해줘','LG전자 그램 중 추천할 상품은?',
 '그램 중 하나만 추천한다면?','그램 노트북 구매 상담해줘'
];
const reasons=[
 '그걸 추천한 이유는?','그 제품이 1위인 근거가 뭐야?','왜 그램 중 이걸 추천했어?',
 '다른 후보보다 좋은 점은?','가격을 고려한 이유가 있어?','추천한 근거 좀 설명해줘',
 '이 노트북을 고른 이유는 뭐야?','성능 때문인지 가격 때문이야?',
 '방금 추천한 노트북 장점은?','그 제품을 선택한 이유가 궁금해',
 '추천 이유를 구체적으로 알려줘','아까 추천한 상품 근거는 뭐지?',
 '왜 이 모델이 적합하다고 봐?','추천 판단에 어떤 한계가 있어?',
 '이 제품은 누가 쓰기 좋아?','다른 모델과 차이는 뭔데?',
 '이것보다 좋은 그램은 없어?','왜 그램 프로가 아니라 이거야?',
 '선택 근거를 자세히 말해줘','이 모델을 고른 핵심 이유는?'
];
const timings=[
 '이거 지금 사도 돼?','지금 사는 게 좋을까?','아까 그 노트북 지금 살까?',
 '이 제품 가격이 괜찮아?','현재가면 구매할 만해?','좀 기다리는 게 나을까?',
 '오늘 주문하면 손해야?','구매 시점을 판단해줘',
 '지금 결제하기 전에 뭘 봐야 해?','당장 사는 게 합리적이야?',
 '이 가격으로 구매해도 될까?','그 노트북을 지금 사도 좋을까?',
 '최근 가격 기록으로 판단해줘','현재 판매가가 낮은 편이야?',
 '어느 시점에 사는 게 나아?','구매 타이밍을 다시 생각해줘',
 '기록상 가격이 싼 편이야?','지금 주문하는 걸 권해?',
 '할인을 기다릴 가치가 있어?','이 가격에 사면 후회할까?'
];
const adds=[
 '영상 편집도 할 예정이야','가끔 게임을 하려고 해','학교 과제도 많아',
 '문서 작업이 주용도야','인터넷 강의를 들을 거야','화상회의를 매일 해',
 '노트북을 자주 들고 나가','사진 편집을 배울 거야','필기도 같이 할 거야',
 '배터리가 오래가야 해','예산은 200만원 이하야','성능이 중요해',
 '발열이 적었으면 해','무게가 가벼우면 좋겠어',
 '출장에도 쓸 거야','키보드를 많이 사용해','그래픽 작업도 해',
 '팬 소음이 적었으면 좋겠어','화면을 오래 봐야 해','멀티태스킹을 많이 해'
];
const switches=[
 '이제 에어팟 프로 2 가격 알려줘','다음은 에어팟 프로 2 최저가 봐줘',
 '에어팟 프로 2세대 얼마야?','화제를 바꿔서 에어팟 프로 2 찾아줘',
 '애플 에어팟 프로 2 가격 비교해줘','에어팟 프로 2세대 구매가 알려줘',
 '노트북은 됐고 에어팟 프로 2 얼마야?','에어팟 프로 2 구매할 때 가격은?',
 '에어팟 프로 2세대 현재 가격은?','이제 에어팟 프로 2 할인 여부 알아봐줘',
 '다음으로 에어팟 프로 2세대 찾아줘','에어팟 프로 2 가격 이력 알아봐줘',
 '애플 에어팟 프로 2 최저가 궁금해','에어팟 프로 2 USB-C 가격은?',
 '에어팟 프로 2 신품 가격 봐줘','에어팟 프로 2로 검색을 바꿔줘',
 '이번엔 에어팟 프로 2 구매가 궁금해','에어팟 프로 2세대 최저가 확인해줘',
 '다른 상품으로 에어팟 프로 2 찾아줘','LG 그램 말고 에어팟 프로 2 가격 알려줘'
];
for(let i=0;i<20;i++){
 const session=H.session();
 const spec=[
 [starts[i],{classify:'C|그램 노트북',answer:explain},r=>products(r)],
 [reasons[i],{answer:'서사에 확인된 상품과 가격 기준으로 선정했어요.'},r=>valid(r)&&!!AC.verifyRecommendationRef(session.prevTopRef)],
 [timings[i],{answer:'구매 전에 판매처의 실제 결제 가격을 확인하세요.'},r=>valid(r)&&!(/찾지 못했/.test(answer(r)))],
 [adds[i],{classify:'B',answer:'용도에 따라 성능과 가격을 다시 확인하세요.'},r=>valid(r)],
 [switches[i],{classify:'D|에어팟 프로 2',answer:explain},r=>products(r)&&cards(r).every(c=>c.productId===F.AIRPODS.pid)]
 ];
 for(const [q,opt,check] of spec){
  let r,error='';
  try{r=await session.say(q,opt);}catch(e){error=String(e?.message||e);}
  mark('연속 대화',q,r,!error&&check(r),error||'Context or product switch failed');
 }
}
// 100 unique deliberately hallucinated, price/option adversarial questions.
const suspect=[
 '그램 노트북 추천해줘','그램15 현재가 알려줘',
 '갤럭시 버즈3 프로 블랙 가격은?','갤럭시 버즈3 프로 화이트 얼마야?',
 '에어팟 프로 2 최저가 확인해줘','JBL 튠 비즈2 가격 알려줘',
 'QCY T13 ANC 무선 이어폰 얼마야?','소니 WF-1000XM5 현재가 궁금해',
 '그램 프로 노트북 추천해줘','버즈3 프로 가격 비교해줘'
];
const suspectNeeds=[
 '근거가 부족하면 분명하게 알려줘','옵션이 다르면 제외해줘',
 '최근 가격 흐름도 확인해줘','가격 확인 날짜도 적어줘',
 '판매처별 금액을 구분해줘','실제 결제 금액인지 확인해줘',
 '추천 이유도 함께 설명해줘','과거 가격인지 알려줘',
 '지금 사면 어떤 점을 확인할까?','같은 상품을 비교하고 싶어'
];
let no=0;
await combine(suspect,suspectNeeds,async(a,b)=>{
 const bogus=12547+no++*29,q=a+' '+b+'.';
 await test('허위 가격 차단',q,'D|'+a,
  '현재 가격은 '+bogus.toLocaleString('en-US')+'원입니다. 무조건 오늘 사세요. 반드시 지금 결제하세요.',
  r=>valid(r)&&!answer(r).includes(bogus.toLocaleString('en-US')+'원')
     &&!/무조건 오늘 사세요|반드시 지금 결제하세요/.test(answer(r)));
});
// 100 unsupported-model questions: 20 distinct nonexistent models × 5 intents.
const unknown=[
 '삼성 갤럭시 S99 울트라','애플 아이폰 31 프로맥스','LG 그램 99세대',
 '에어팟 프로 19세대','소니 WF-9900XM19','닌텐도 스위치 99',
 '샤오미 패드 99 프로','로지텍 MX Master 99S',
 '삼성 갤럭시 워치 99 프로','LG 울트라기어 999Hz',
 '다이슨 V99 앱솔루트','아이패드 프로 39세대',
 '갤럭시 버즈 99 울트라','플레이스테이션 19 프로',
 '삼성 비스포크 AI 냉장고 99세대','레노버 씽크패드 X9999',
 '캐논 EOS R99 Mark X','고프로 히어로 99 블랙',
 'DJI 미니 99 프로','BOSE QC 99 울트라'
];
const unknownAsks=['지금 얼마야?','최저가를 찾을 수 있어?',
 '정확히 일치하는 판매처가 있어?','가격 기록이 있나?',
 '판매 중인지 확인해줘'];
for(const model of unknown)for(const phrase of unknownAsks){
 const q=model+' '+phrase;
 await test('미확인 모델 방어',q,'D|'+model,
  '확인된 최저가는 999,999원이에요. 반드시 지금 결제하세요.',
  r=>valid(r)&&!answer(r).includes('999,999원')&&
     (cards(r).length===0 ||
       (cards(r).every(c=>!!c.identityNote)&&
        /정확히|일치하지|찾지 못|다른 모델/.test(answer(r)))));
}
const summary={
 mode:'REAL_HANDLER_MOCK_GPT',questions:questions.length,
 uniqueQuestions:seen.size,passed:ok,failed:fail,
 passRatePct:+(ok/(questions.length||1)*100).toFixed(2),
 corpusSha256:crypto.createHash('sha256').update(questions.join('\n')).digest('hex'),
 categories:groups,questionExamples:questions.filter((_,i)=>i%100===0),
 gptApiCalls:0,externalCalls:H.counters.external,dbWrites:H.counters.dbWrites
};
console.log('AI_1000_AUDIT '+JSON.stringify(summary));
if(failures.length)console.log('AI_1000_FAILURE_SAMPLE '+JSON.stringify(failures.slice(0,30)));
if(questions.length!==1000||seen.size!==1000||H.counters.external||H.counters.dbWrites||fail)process.exitCode=1;
})().catch(e=>{console.error('AI_1000_FATAL',e?.stack||e);process.exitCode=1;});
