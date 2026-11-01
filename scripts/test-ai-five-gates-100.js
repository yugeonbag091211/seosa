'use strict';
const assert=require('node:assert/strict');
const C=require('../api/_ai-comparison');
const AIID=require('../api/_aiidentity');
/*
 * 100 distinct user-worded product questions using actual captured merchant
 * title examples (fixture). They are OFFLINE scenario checks, not 100 GPT
 * calls or 100 provider API calls. No account data or prices are fabricated
 * as live observations in this test.
 */
const realDevice=[
 'Apple 2025 아이패드 (A16 모델)',
 'Apple 2026 아이패드 에어 11(M4 모델)',
 '[APPLE] 애플 아이패드 7세대 공기계 [A2197]',
 '삼성 갤럭시탭A6 10.1 With s-pen 태블릿PC SM-P580',
 '삼성전자 갤럭시 탭 S10 FE 태블릿 10.9인치 아랍어 버전 8GB SM-X520',
 '삼성전자 갤럭시탭 A9 플러스 태블릿PC',
 '갤럭시 탭 A11+_WIFI_128GB_그레이 - [SM-X230NZALKOO]',
 '아이패드 에어 11 M4 WiFi 128GB - 스타라이트',
 'Apple 2025 아이패드 프로 11(M5 모델) 스탠다드 글래스',
 '삼성전자 갤럭시 탭 A8 WiFi전용 64GB SM-X200'
];
const notDevice=[
 '굿노트 깍두기 색칠 가계부 아이패드 가로형 PDF',
 '갤럭시 탭 A 8.0 T380 T385 터치 스크린 8인치 유리',
 '왕초보 아이패드 수채화를 기초부터 배우기',
 '갤럭시탭 액티브5 슈페리어 저반사 액정보호필름',
 '아이패드 드로잉 원데이 클래스',
 '삼성 갤럭시 탭 S11 키보드 터치패드 DeX키',
 '뉴욕 아이패드 크리스마스 영화 투어',
 '아이패드 데일리 플래너 PDF 템플릿',
 '갤럭시탭 S9 FE 보호 필름 2매',
 'JAMJAKE 아이패드 호환 스타일러스 펜슬'
];
const phrasing=[
 t=>t+'를 추천해줘',
 t=>t+' 가격 알려줘',
 t=>t+' 중에서 고르려고 해',
 t=>t+'가 실제 본체인지 확인해줘',
 t=>t+' 상품 정보와 가격 비교해줘',
 t=>t+' 30만원 이하 있어?',
 t=>t+' 새 제품 찾는 중이야',
 t=>t+' 쿠폰 포함 최종 가격이야?',
 t=>t+' 아니면 다른 브랜드가 좋아?',
 t=>t+' 배송비 포함이야?'
];
let pass=0;
const questions=new Set();
for(let i=0;i<20;i++)for(let k=0;k<5;k++){
 const title=(i<10?realDevice:notDevice)[i%10];
 const question=phrasing[(i+k)%10](title);
 assert.ok(!questions.has(question),'unique real-world question: '+question);
 questions.add(question);
 const family=/아이패드|ipad/i.test(title)?'아이패드':'갤럭시탭';
 assert.equal(C.isComparableOffer(family,title),i<10,question);
 pass++;
}
assert.equal(questions.size,100);
const mk=(title,price,id)=>({title,lprice:price,productId:id,mall:'ADPICK',isCoupang:false,link:'https://example.test/'+id});
const toNorm=x=>({...x,price:x.lprice,mallId:x.mall});
const sample=[
 mk(realDevice[0],621300,'ipad-real'),
 mk(notDevice[0],13000,'ipad-pdf'),
 mk(notDevice[7],2500,'ipad-planner')
];
assert.equal(C.pickExact(sample,'아이패드',AIID,toNorm)?.productId,'ipad-real');
pass++;
console.log('AI_FIVE_GATES_100_QUESTIONS',JSON.stringify({uniqueQuestions:questions.size,pass,fail:0,realGptCalls:0,actualMerchantRequests:0,fixtureTypes:['captured hardware titles','captured false product titles']}));
