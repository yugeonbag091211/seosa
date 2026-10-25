'use strict';
/**
 * 200 distinct input turns through the REAL /api/ai handler, with mock LLM +
 * mock catalogue and write-blocked database. These are NOT 200 GPT API calls.
 * Report counts precisely; never count a Node assertion as a user question.
 * Run: node scripts/test-ai-200-questions.js
 */
const H = require('./_ai-chat-harness');
const F = require('./_ai-chat-fixtures');
const AC = require('../api/_aicontext');

F.ALL.forEach(H.addProduct);

const counted = { asked: 0, pass: 0, fail: 0, groups: {}, fails: [], unique: new Set() };
const seen = (r) => (r && r.body && typeof r.body.text === 'string') ? r.body.text : '';
const cards = r => (r && r.body && Array.isArray(r.body.items)) ? r.body.items : [];
const REF = r => AC.verifyRecommendationRef(r && r.body && r.body.topRecommendationRef);
const badEmpty = /조건에 맞는 상품을 찾지 못|상품을 찾지 못했|어떤 상품을 말씀하시는지.*확인하기 어렵/;

function record(group, question, response, valid, why) {
  counted.asked++;
  counted.unique.add(question);
  const g = counted.groups[group] || (counted.groups[group] = { asked: 0, pass: 0, fail: 0 });
  g.asked++;
  const pass = response && response.status === 200 && !!valid;
  if (pass) { counted.pass++; g.pass++; }
  else {
    counted.fail++; g.fail++;
    const rec = { group, question, reason: why || 'assertion failed',
      status: response && response.status,
      intent: response && response.body && response.body.intent,
      cards: cards(response).map(x=>[x.productId,x.vendorItemId,x.lprice]).slice(0,4),
      excerpt: seen(response).slice(0,110) };
    counted.fails.push(rec);
    console.log('QA_FAIL ' + JSON.stringify(rec));
  }
}
const pick = (arr,i)=>arr[i%arr.length];
const gramStarts = [
 '노트북 그램으로 추천해줘','LG 그램 노트북 추천해줘',
 '그램 노트북 추천해줘','그램 노트북 좀 추천해줘',
 'LG 그램 노트북 골라줘','LG 그램 노트북 추천 부탁해',
 '그램 시리즈 노트북 추천해줘','LG전자 그램 노트북 추천해줘'
];
const gramReasons = [
 '이거 왜 추천했어?','이 모델은 왜 추천했어?','왜 이걸 추천한 거야?',
 '추천한 이유를 알려줘','추천 이유가 뭐야?','이거 왜 골랐어?',
 '아까 추천한 이유가 궁금해','이 제품을 추천한 이유가 뭐야?'
];
const gramTiming = [
 '지금 사는 게 좋을까?','이거 지금 사도 돼?','지금 살까?',
 '이 제품 지금 사는 게 괜찮아?','아까 그 노트북 지금 사도 돼?',
 '그거 지금 사면 좋을까?','지금 사도 괜찮을까?','이거 가격 괜찮은 편이야?'
];
const gramExtra = [
 '근데 영상 편집도 할 거야','영상 편집도 해보려고 해',
 '근데 나는 영상 편집도 할 거야','문서 작업이랑 영상 편집도 하고 싶어',
 '영상 편집할 예정이야','학교 과제랑 영상 편집도 해야 해',
 '게임도 할 거야','그리고 영상 편집도 할 건데'
];
const earStarts = [
 '무선 이어폰 추천해줘','무선 이어폰 좀 추천해줘','무선 이어폰 추천 부탁해',
 '무선 이어폰 좋은 거 추천해줘','무선 이어폰으로 골라줘',
 '무선 이어폰 하나 추천해줘','무선 이어폰 몇 개 추천해줘',
 '블루투스 무선 이어폰 추천해줘'
];
const earBudget = [
 '예산은 10만원 이하로 해줘','10만원 이하로 찾아줘','예산 10만원 이하야',
 '10만원 안쪽으로 추천해줘','예산을 10만원으로 할게',
 '10만원 넘지 않는 걸로','가격은 10만원 이하로',
 '10만원 이하 제품으로 바꿔줘'
];
const earCondition = [
 '배터리 오래가는 게 중요해','근데 배터리도 오래가야 해','배터리 오래가는 게 좋아',
 '통화 품질도 중요해','배터리 오래가는 이어폰이면 좋겠어',
 '배터리 지속시간이 중요해','배터리 수명이 중요해',
 '충전 오래가는 제품으로 부탁해'
];
const earAlt = [
 '다른 제품 추천해줘','이거 말고 다른 제품 추천해줘','다른 거 보여줘',
 '다른 상품도 추천해줘','다른 후보 추천해줘',
 '다른 모델로 추천해줘','그거 말고 다른 걸로','대신 다른 이어폰도 알려줘'
];
const budsStarts = [
 '갤럭시 버즈3 프로 블랙 얼마야?','갤럭시 버즈3 프로 블랙 가격 알려줘',
 '삼성 버즈3 프로 블랙 얼마야?','갤럭시 버즈3 프로 블랙 현재가 알려줘',
 '갤럭시 버즈3 프로 블랙 최저가 알려줘','버즈3 프로 블랙 가격은?',
 '버즈3 프로 블랙 얼마에 팔아?','갤럭시 버즈3 프로 블랙 살 가격 알려줘'
];
const budsWhite = [
 '화이트는 얼마야?','그럼 화이트는 얼마야?','화이트 가격도 알려줘',
 '화이트 색상은 얼마야?','화이트 모델 가격은?',
 '그 모델 화이트는 얼마야?','버즈3 프로 화이트 얼마야?',
 '블랙 말고 화이트 가격 알려줘'
];
const budsWhy = [
 '이거 왜 추천했어?','왜 그걸 추천한 거야?','추천 이유 말해줘',
 '이거 추천한 이유가 뭐야?','이 제품은 왜 추천했어?',
 '아까 추천한 이유 알려줘','왜 이 상품을 골랐어?',
 '이 상품 추천 이유를 설명해줘'
];
const airStarts = [
 '에어팟 프로 2 얼마야?','애플 에어팟 프로 2 가격 알려줘',
 '에어팟 프로 2 현재 가격은?','에어팟 프로 2세대 얼마야?',
 'AirPods Pro 2 가격 알려줘','에어팟 프로2 가격 얼마야?',
 '애플 에어팟 프로 2 최저가 알려줘','에어팟 프로 2세대 가격 확인해줘'
];
const airTiming = [
 '지금 사는 게 좋을까?','이거 지금 사도 돼?','지금 살까?',
 '아까 추천한 에어팟 지금 사도 돼?','지금 사면 괜찮을까?',
 '조금 기다리는 게 나을까?','이 모델 가격 괜찮을까?','지금 구매해도 될까?'
];

async function doSay(s, group, question, opt, validate, label) {
  let response = null, err = '';
  try { response = await s.say(question, opt || {}); }
  catch(e) { err = String(e && e.message || e); }
  let valid = false;
  if (response && typeof validate === 'function') {
    try { valid = !!validate(response,s); } catch (e) { err=String(e.message||e); }
  }
  record(group,question,response,valid,err || label);
  return response;
}

(async()=>{
  // 8 chats x 5 messages = 40, plus follow-ups after changed use case.
  for(let i=0;i<8;i++){
    const s=H.session();
    await doSay(s,'그램 추천·기억',gramStarts[i],{
      classify:'C|노트북 그램',answer:'그램15 15ZB95N을 추천해요. 정확한 사양과 판매 조건은 확인해 보세요.'
    },r=>cards(r).length>0 && !!REF(r) && !badEmpty.test(seen(r)), '그램 검색 결과/서명 누락');
    const origin=AC.verifyRecommendationRef(s.prevTopRef);
    await doSay(s,'그램 추천·기억',gramReasons[i],{
      answer:'추천한 이유는 그램 모델 가운데 가격 기록을 확인할 수 있기 때문이에요. 용도에 맞는 사양은 따로 살펴봐야 해요.'
    },r=>cards(r).length===1 && !!REF(r) && REF(r).productId===origin.productId && r.searches===0,
    '추천 이유가 직전 상품을 잊음');
    await doSay(s,'그램 추천·기억',gramTiming[i],{
      answer:'지금 가격이 적정한지는 최근 기록과 확인 시점을 함께 보셔야 해요.'
    },r=>cards(r).length===1 && !!REF(r) && REF(r).productId===origin.productId
      && !badEmpty.test(seen(r)), '구매 질문이 직전 상품을 잊음');
    await doSay(s,'그램 추천·기억',gramExtra[i],{
      classify:'B',answer:'그 용도에서는 필요한 성능을 따로 확인해야 해요.'
    },r=>cards(r).length>0 && !badEmpty.test(seen(r)) && (r.searches>=1 || !!r.body.topRecommendationRef),
    '추가 사용 목적 질문이 검색 맥락을 잃음');
    await doSay(s,'그램 추천·기억','그럼 마지막으로 추천한 노트북을 좀 더 설명해줘',{
      answer:'앞에서 안내한 노트북의 사양과 가격을 확인한 뒤 결정하시면 돼요.'
    },r=>r.status===200 && !!seen(r), '연속 후속 설명 불가');
  }

  for(let i=0;i<8;i++){
    const s=H.session();
    await doSay(s,'이어폰 예산·조건',earStarts[i],{
      classify:'C|무선 이어폰',answer:'무선 이어폰 후보를 살펴봤어요. 음질과 착용감도 비교해 보세요.'
    },r=>cards(r).length>0 && !!REF(r),'이어폰 검색 실패');
    await doSay(s,'이어폰 예산·조건',earBudget[i],{
      classify:'C|무선 이어폰',answer:'예산 안에서 무선 이어폰 후보를 비교해 드릴게요.'
    },r=>cards(r).length>0 && cards(r).every(c=>c.lprice<=100000),'예산 밖 상품 표시');
    await doSay(s,'이어폰 예산·조건',earCondition[i],{
      classify:'B',answer:'제조사 배터리 사용 시간은 상품명만으로는 확인하기 어려워요.'
    },r=>cards(r).length>0 && cards(r).every(c=>c.lprice<=100000),'추가 조건에서 예산 기억 실패');
    await doSay(s,'이어폰 예산·조건',earAlt[i],{
      classify:'C|무선 이어폰',answer:'다른 제품의 특징과 판매 조건을 비교해 보세요.'
    },r=>cards(r).length>0 && cards(r).every(c=>c.lprice<=100000),'다른 후보 요청 실패');
    await doSay(s,'이어폰 예산·조건','이 제품 지금 사는 게 좋을까?',{
      answer:'저장된 가격 기록으로 판단하되 구매 전에 확인해야 해요.'
    },r=>r.status===200 && !!seen(r),'구매 여부 후속 질문 응답 실패');
  }

  for(let i=0;i<8;i++){
    const s=H.session();
    await doSay(s,'버즈 옵션 분리',budsStarts[i],{
      classify:'D|갤럭시 버즈3 프로 블랙',answer:'갤럭시 버즈3 프로 블랙은 현재 139,000원이에요.'
    },r=>cards(r).length>0 && !!REF(r) && REF(r).vendorItemId===F.BUDS_BLACK.vid
      && !/화이트는 99,000/.test(seen(r)), '버즈 블랙/화이트 혼동');
    await doSay(s,'버즈 옵션 분리',budsWhite[i],{
      classify:'D|갤럭시 버즈3 프로 화이트',answer:'갤럭시 버즈3 프로 화이트는 99,000원이에요.'
    },r=>cards(r).length>0 && !!REF(r) && REF(r).vendorItemId===F.BUDS_WHITE.vid
      && !/화이트는 139,000/.test(seen(r)), '화이트 옵션 전환 실패');
    await doSay(s,'버즈 옵션 분리','이거 지금 사도 돼?',{
      answer:'화이트의 판매 가격과 기록을 구분해 확인하세요.'
    },r=>cards(r).length===1 && cards(r)[0].vendorItemId===F.BUDS_WHITE.vid
      && !/139,000원/.test(seen(r)),'후속 구매 판단에 블랙 가격 혼입');
    await doSay(s,'버즈 옵션 분리',budsWhy[i],{
      answer:'같은 제품이라도 색상별 옵션 가격과 가격 기록은 다를 수 있어요.'
    },r=>r.status===200 && !!seen(r),'버즈 추천 이유 후속 질문 실패');
    await doSay(s,'버즈 옵션 분리','에어팟 프로 2 가격도 알려줘',{
      classify:'D|에어팟 프로 2',answer:'에어팟 프로 2세대의 가격을 비교해 드릴게요.'
    },r=>cards(r).length>0 && cards(r).every(c=>c.productId===F.AIRPODS.pid),
    '다른 카테고리 전환 시 버즈 혼입');
  }

  for(let i=0;i<8;i++){
    const s=H.session();
    await doSay(s,'에어팟 대화·전환',airStarts[i],{
      classify:'D|에어팟 프로 2',answer:'에어팟 프로 2세대 USB-C는 329,000원이에요.'
    },r=>cards(r).length>0 && cards(r).every(c=>c.productId===F.AIRPODS.pid)
      && !!REF(r),'에어팟 상품 선택 실패');
    await doSay(s,'에어팟 대화·전환','이거 왜 추천했어?',{
      answer:'이 상품을 추천한 이유는 요청하신 모델이기 때문이에요. 가격 기록을 확인해 주세요.'
    },r=>cards(r).length===1 && cards(r)[0].productId===F.AIRPODS.pid,
    '에어팟 추천 이유 참조 실패');
    await doSay(s,'에어팟 대화·전환',airTiming[i],{
      answer:'지금 살지 결정하기 전에 가격의 최신성을 확인해 주세요.'
    },r=>cards(r).length===1 && cards(r)[0].productId===F.AIRPODS.pid,
    '에어팟 구매 질문 참조 실패');
    await doSay(s,'에어팟 대화·전환','이거랑 비슷한 무선 이어폰도 볼래',{
      classify:'C|무선 이어폰',answer:'유사한 무선 이어폰도 비교해 볼 수 있어요.'
    },r=>r.status===200 && !!seen(r),'유사 후보 탐색 실패');
    await doSay(s,'에어팟 대화·전환','LG 그램 노트북으로 바꿔서 추천해줘',{
      classify:'C|노트북 그램',answer:'그램 노트북 모델을 비교해 드릴게요.'
    },r=>cards(r).length>0 && cards(r).every(c=>/그램/.test(c.title)),'상품 종류 전환 실패');
  }

  // 40 independently varied hallucinated prices, one /api/ai handler call each.
  // No fake amount should survive either accepted or repaired response.
  const bogusP = [12345,34567,45678,65432,78901,87654,98765,11111,22222,33333];
  for(let i=0;i<40;i++){
    const p=bogusP[i%10] + Math.floor(i/10);
    const s=H.session();
    const choices=[
      {q:'노트북 그램으로 추천해줘',cl:'C|노트북 그램',name:'그램15',category:'그램'},
      {q:'무선 이어폰 추천해줘',cl:'C|무선 이어폰',name:'QCY',category:'이어폰'},
      {q:'갤럭시 버즈3 프로 블랙 얼마야?',cl:'D|갤럭시 버즈3 프로 블랙',name:'버즈3',category:'버즈'},
      {q:'에어팟 프로 2 얼마야?',cl:'D|에어팟 프로 2',name:'에어팟',category:'에어팟'}
    ];
    const item=choices[i%4];
    // Unique question per case, 40 actual questions not just re-assertions.
    const question=item.q+' 상품과 가격 확인 부탁해 ('+(i+1)+')';
    await doSay(s,'환각 가격 차단',question,{
      classify:item.cl,answer:`${item.name} 추천합니다. 실제 현재가는 ${p.toLocaleString('en-US')}원이고 무조건 오늘 사세요.`
    },r=>r.status===200 && !seen(r).includes(p.toLocaleString('en-US')+'원')
      && !/무조건 오늘 사세요/.test(seen(r)),'GPT 환각 금액/무조건 구매 권유 노출');
  }

  const summary={kind:'OFFLINE_HANDLER_MOCK_LLM',questions:counted.asked,
    uniqueQuestionStrings:counted.unique.size,pass:counted.pass,fail:counted.fail,
    passRatePct:+((counted.pass/Math.max(1,counted.asked))*100).toFixed(2),
    categories:counted.groups,dbWrites:H.counters.dbWrites,externalCalls:H.counters.external,
    realGptCalls:0};
  console.log('AI_QUESTION_AUDIT '+JSON.stringify(summary));
  if(counted.fail)console.log('AI_QUESTION_FAILURES '+JSON.stringify(counted.fails.slice(0,50)));
  if(counted.asked<100 || counted.pass+counted.fail!==counted.asked
    || H.counters.dbWrites>0 || H.counters.external>0 || counted.fail>0){
    process.exitCode=1;
  }
})().catch(e=>{console.error('AI_QUESTION_HARNESS_ERROR',e);process.exitCode=1;});
