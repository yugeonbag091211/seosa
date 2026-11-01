'use strict';

// New questions through the actual handler with mocked LLM, shopping and DB.
// One question passes only if the real device appears and the wrong type does not.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const H = require('./_ai-chat-harness');
let feed = [];
require('../api/_shop').searchAll = async () => ({items: feed.map(x => ({...x, _source: 'api'})), from: 'api', blocked: false});
const item = (id, title, price) => ({productId: id, vendorItemId: id, title, lprice: price, mall: 'ADPICK', mallLabel: 'ADPICK', link: 'https://example.com/'+id, image: '', isCoupang: false});
const groups = [
  { type:'laptop', query:'노트북', good:'LG 울트라PC 15U50R 인텔 i5 8GB 256GB 노트북', bad:[
    '노트북 활용법 온라인 교육', '노트북으로 돈버는 방법 온라인 교육', '노트북 입문자를 위한 코딩 클래스', '노트북 하나로 3억 번 AI 바이브코딩 사업의 모든것', '노트북 온라인 강의 입문' ], questions:[
    '문서 작업할 노트북 본체를 찾아줄래?', '집에서 쓸 노트북 기기를 골라줘', '새 노트북 본체 추천 부탁해', '노트북 컴퓨터를 하나 추천해줄 수 있어?', '일상 업무에 맞는 노트북 본체 보여줘' ] },
  { type:'ipad', query:'아이패드', good:'Apple 아이패드 에어 M2 11인치 128GB 태블릿 본체', bad:[
    '아이패드 호환 애플펜슬 2세대', '아이패드 프로 호환 애플펜슬 여분 펜촉 증정', 'Apple 아이패드 호환 케이스 11인치', '애플 아이패드 프로 매직키보드', '아이패드 에어 액정 디스플레이 교체 부품' ], questions:[
    '아이패드 기기 본체를 구하고 싶어', '새 아이패드 태블릿 본체 골라줄래?', '아이패드 본체로 사용할 제품 추천해줘', '아이패드 본품을 하나 골라줘', '태블릿 본체로 아이패드를 추천해줘' ] },
  { type:'galaxy-tab', query:'갤럭시탭', good:'삼성 갤럭시탭 S9 태블릿 본체 S펜 포함', bad:[
    '갤럭시탭 S9 호환 스타일러스 펜촉 포함', '갤럭시탭 S9 S펜 정품', '갤럭시탭 호환 S펜 정품 스타일러스', '갤럭시탭 S9 호환 액정 패널 교체', '갤럭시탭 S9 호환 케이스' ], questions:[
    '갤럭시탭 기기 본체를 구하고 싶어', '새 갤럭시탭 태블릿 본체 골라줄래?', '갤럭시탭 본체로 사용할 제품 추천해줘', '갤럭시탭 본품을 하나 골라줘', '태블릿 본체로 갤럭시탭을 추천해줘' ] },
  { type:'headset', query:'헤드셋', good:'소니 WH-CH520 블루투스 무선 헤드셋', bad:[
    '무선 TWS 블루투스 이어버드 헤드셋', 'JBL 웨이브 300 TWS 완전 무선 스테레오 이어버드 헤드셋', '이어버드 블루투스 무선 헤드셋', 'TWS 이어폰 블루투스 헤드셋', 'in-ear earbuds 블루투스 헤드셋' ], questions:[
    '귀를 덮는 헤드셋 기기를 골라줘', '머리에 쓰는 헤드셋 본체 찾아줘', '음악을 듣는 헤드셋을 보여줘', '헤드셋 본품 하나 추천해줄래?', '무선 헤드셋 기기를 구하고 싶어' ] }
];
const old200 = fs.readFileSync(path.join(__dirname,'test-ai-200-questions.js'),'utf8');
const old1000 = fs.readFileSync(path.join(__dirname,'..','reports','ai-pr197-final-1000-2026-10-26','offline-results.jsonl'),'utf8').trim().split(/\r?\n/).map(x=>JSON.parse(x).question);
const previous = new Set(old1000);
let passed = 0, failed = 0, questions = [];
(async () => {
 for (const g of groups) for (let i=0; i<g.questions.length; i++) {
   const question = g.questions[i];
   if (previous.has(question) || old200.includes(question) || questions.includes(question)) throw Error('holdout question overlaps: '+question);
   questions.push(question);
   feed = [item('wrong', g.bad[i], 9000), item('correct', g.good, 490000)];
   const r = await H.ask({question}, {classify:'C|'+g.query, answer:'확인된 상품을 살펴보세요.'});
   const cards = Array.isArray(r.body.items) ? r.body.items : [];
   const ids = cards.map(x => x.productId);
   const ok = r.status === 200 && ids.includes('correct') && !ids.includes('wrong');
   if (ok) passed++; else failed++;
   console.log('TYPE_HOLDOUT_CASE '+JSON.stringify({question, type:g.type, expected:'본체 카드 포함 및 다른 유형 카드 제외', actual:ids, status:r.status, result:ok?'PASS':'FAIL'}));
 }
 const summary={mode:'REAL_HANDLER_MOCK_GPT',questions:questions.length,passed,failed,unverified:0,corpusSha256:crypto.createHash('sha256').update(questions.join('\n')).digest('hex'),gptApiCalls:0,externalCalls:H.counters.external,dbWrites:H.counters.dbWrites};
 console.log('TYPE_HOLDOUT_SUMMARY '+JSON.stringify(summary));
 if (questions.length!==20 || failed || H.counters.external || H.counters.dbWrites) process.exitCode=1;
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
