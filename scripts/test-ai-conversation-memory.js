#!/usr/bin/env node
/**
 * 대화형 쇼핑 AI — 맥락 기억·자연스러운 설명·근거 검증·채팅창 UI (2026-10-24). 완전 오프라인.
 *
 *   node scripts/test-ai-conversation-memory.js
 *
 * ── 지키는 것 (요청서 «반드시 실행할 테스트» 1~11) ──────────────────────
 *   1. 그램 추천 → 추천 이유 → 지금 살까? → 영상 편집 용도 추가
 *   2. 이어폰 추천 → 예산 변경 → 배터리 중시 → 다른 제품 추천
 *   3. 같은 상품의 블랙·화이트 가격이 다를 때 옵션 혼동 방지
 *   4. 다른 상품으로 화제를 바꾸었을 때 이전 상품과 혼동하지 않기
 *   5. GPT 가 존재하지 않는 가격·사양을 말하면 그 문장만 막고, 대상이 틀리면 통째로 서버 답
 *   6. 긴 대화(기록 창 밖)와 새로고침 뒤에도 맥락 유지 · 확인 못 하는 옛 대화는 아는 척하지 않기
 *   7. 채팅창 좌우 드래그 확대·축소 (public/index.html ChatResize 실제 실행)
 *   8. 넓힌 창의 카드·가격 흐름 그래프·글 배치
 *   9. 모바일·태블릿에서는 드래그가 꺼져 있고 예전 레이아웃
 *  10. 창 너비 저장·복원·기본 크기로 되돌리기·키보드 조절
 *  11. 같은 상품을 이어 물을 때 카드·제휴 고지를 반복하지 않기 (새 추천·옵션·가격 변동이면 다시 그린다)
 *
 * api/ai.js 핸들러 전체가 돈다(scripts/_ai-chat-harness.js). DB 는 읽기 전용 메모리 표, GPT·쇼핑 검색은
 * 가짜다 — 외부 호출 0회, DB 쓰기 0회. 실제 GPT 로 같은 대화를 돌리는 검증은 reports/ 의 Preview 기록을 본다.
 */
'use strict';

const H = require('./_ai-chat-harness');
const F = require('./_ai-chat-fixtures');
const CG = require('../api/_concierge');
const Intent = require('../api/_intent');
const AC = require('../api/_aicontext');

F.ALL.forEach(H.addProduct);
const I = H.I;

let pass = 0, fail = 0;
const failures = [];
let current = '';
function section(name) { current = name; console.log(`\n── ${name} ──`); }
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); return; }
  fail++; failures.push(`${current} :: ${name}`);
  console.log(`  [FAIL] ${name}${detail ? ` — ${String(detail).slice(0, 500)}` : ''}`);
}
const won = n => Number(n).toLocaleString('en-US');
const text = r => String((r && r.body && r.body.text) || '');
const cards = r => (r && r.body && r.body.items) || [];
const blockHeads = r => String(r.system || '').split('\n\n').map(b => b.split('\n')[0]);
const NOT_FOUND = /찾지 못했|결과가 없었|검색했지만/;

(async () => {
  console.log('=== 대화형 쇼핑 AI 시나리오 — 외부 호출 0회, DB 쓰기 0회 ===');

  /* ================================================================ */
  section('1. 그램 추천 → 추천 이유 → 지금 살까? → 영상 편집');
  {
    const s = H.session();
    const t1 = await s.say('노트북 그램으로 추천해줘', {
      classify: 'C|그램 노트북',
      answer: '그램15 15ZB95N을 추천드려요. i5·16GB 구성이라 문서 작업과 학교 과제에는 충분한 편이에요. '
        + '현재 판매가는 645,000원이에요. 지금 사도 괜찮은 가격이에요. 다만 외장 그래픽이 없어 무거운 영상 편집에는 한계가 있어요.'
    });
    ok(t1.searches === 1 && cards(t1).length >= 2 && !!t1.body.topRecommendationRef
        && AC.verifyRecommendationRef(t1.body.topRecommendationRef).productId === F.GRAM_15.pid,
      '1턴: 검색해서 그램15 를 1위로 추천하고 서명 참조를 준다', JSON.stringify({ s: t1.searches, top: t1.body.topProductId }));
    ok(!t1.body.degraded && /문서 작업과 학교 과제/.test(text(t1)) && /영상 편집에는 한계/.test(text(t1))
        && !/지금 사도 괜찮은 가격/.test(text(t1)),
      '1턴: GPT 설명은 살리고, 묻지 않은 «지금 사도 괜찮다» 단정 한 문장만 뺀다', text(t1));

    const reasonGpt = '그램15 15ZB95N을 추천한 이유는 말씀하신 그램 시리즈 가운데 가격과 구성이 가장 무난했기 때문이에요.\n\n'
      + '상품명 기준으로 i5 프로세서와 16GB 메모리, 512GB 저장공간이라 문서 작업·인강·웹 서핑 같은 일상 작업에는 충분해요. '
      + '그램 시리즈는 일반적으로 가볍고 휴대가 편한 노트북으로 알려져 있어요.\n\n'
      + '현재 645,000원은 SEOSA가 확인한 30일 평균보다 낮은 편이에요. 다만 외장 그래픽이 없어서 고사양 게임이나 무거운 영상 편집에는 한계가 있어요.\n\n'
      + '사기 전에는 판매처 페이지에서 정확한 CPU 세대와 보증 조건을 확인해 주세요.';
    const t2 = await s.say('이거 왜 추천했어?', { answer: reasonGpt });
    ok(t2.searches === 0 && t2.llmMain === 1 && cards(t2).length === 1 && cards(t2)[0].productId === F.GRAM_15.pid,
      '2턴: 새 검색 없이 서명된 직전 추천(그램15) 하나로 GPT 가 설명한다', JSON.stringify({ s: t2.searches, llm: t2.llmMain, items: cards(t2).map(c => c.productId) }));
    ok(blockHeads(t2).includes('[이번 질문 — 방금 추천한 상품을 왜 골랐는지]')
        && t2.messages.some(m => m.role === 'assistant' && /그램15 15ZB95N을 추천드려요/.test(m.content)),
      '2턴: 프롬프트에 «추천 이유» 지시와 1턴 대화가 함께 실린다');
    ok(text(t2) === reasonGpt && !t2.body.degraded,
      '2턴: 근거 있는 2~4문단 설명이 기본 답변으로 바뀌지 않고 그대로 나간다', text(t2));
    ok(t2.body.reusePreviousCard === true && !(t2.body.followups || []).some(q => /왜\s*추천/.test(q)),
      '2턴: 같은 카드 재사용 힌트 · 방금 물은 «왜 추천했어?» 칩을 다시 권하지 않는다', JSON.stringify(t2.body.followups));

    const t3 = await s.say('지금 사는 게 좋을까?', {
      classify: 'C|그램 노트북',   // 분류 LLM 이 새 검색으로 읽어도 서명 참조가 이긴다(불리지도 않는다)
      answer: '네, 지금 사도 좋은 가격이에요. 현재 645,000원은 30일 평균보다 낮은 편이에요. 다만 영상 편집까지 생각하신다면 사양을 먼저 확인하세요.'
    });
    const deal = CG.STANCE.BUY;
    ok(t3.searches === 0 && t3.body.intent === 'PRODUCT_DECISION' && cards(t3).length === 1 && cards(t3)[0].productId === F.GRAM_15.pid,
      '3턴: «지금 사는 게 좋을까?» 를 새 상품 검색으로 오해하지 않는다 (그램15 하나)', JSON.stringify({ s: t3.searches, intent: t3.body.intent }));
    ok(text(t3).startsWith('서사가 확인한') && text(t3).includes(`${won(F.GRAM_15.price)}원 기준으로 보면`)
        && text(t3).includes(deal) && /영상 편집까지 생각하신다면/.test(text(t3)) && !/^네, 지금 사도/.test(text(t3)),
      '3턴: 결론은 서버 판정(가격 기록) 한 문장을 맨 앞에, GPT 의 근거·고려사항은 그대로', text(t3));
    ok(!NOT_FOUND.test(text(t3)) && !(t3.body.followups || []).some(q => /지금 사는 게/.test(q)),
      '3턴: «찾지 못했어요» 가 나오지 않고, 방금 물은 칩을 다시 권하지 않는다', JSON.stringify(t3.body.followups));

    const t4 = await s.say('근데 나는 영상 편집도 할 거야.', {
      classify: 'B',   // 모델이 잡담으로 읽어도 찾던 상품을 놓치지 않는다
      answer: '영상 편집까지 하신다면 앞에서 추천한 그램15는 외장 그래픽이 없어 무거운 편집에는 부족할 수 있어요. '
        + '그램 프로 17Z90SP는 RTX3050과 32GB 메모리가 상품명에 있어 편집 작업에 더 여유가 있어요. 가격은 2,190,000원으로 훨씬 비싸요.'
    });
    ok(H.searchLog[H.searchLog.length - 1] === '노트북 그램' && !NOT_FOUND.test(text(t4)) && cards(t4).length >= 2,
      '4턴: «영상 편집» 을 검색어로 쓰지 않고 찾던 그램을 다시 본다 (예전: "근데 영상 편집도" → 0건)', JSON.stringify({ q: H.searchLog.slice(-1), text: text(t4) }));
    ok(blockHeads(t4).includes('[직전에 추천한 상품 — 서버가 서명 참조로 다시 확인한 바로 그 상품·옵션]')
        && /용도: 영상 편집/.test(t4.system),
      '4턴: 직전 추천(그램15)과 새 용도(영상 편집)를 함께 프롬프트에 실어 다시 평가하게 한다');
    ok(/그램15는 외장 그래픽이 없어/.test(text(t4)) && /그램 프로 17Z90SP/.test(text(t4)) && !t4.body.degraded,
      '4턴: 직전 추천의 한계와 더 맞는 후보를 함께 말한 GPT 답이 그대로 나간다', text(t4));
  }

  /* ================================================================ */
  section('1-b. 실제 ADPICK 상품명 — 종류명 없이 계열만 적힌 노트북 (2026-10-24 Preview 실호출)');
  {
    const AIID = require('../api/_aiidentity');
    // Preview 실호출에서 "노트북 그램으로 추천해줘" 가 받은 ADPICK 결과 그대로 (상품명만).
    const titles = [
      '[해외] LG 그램 노트북 충전기, AC 어댑터, 19V 전원 공급 장치, 2.37A, 45W, 14T90N',
      '[기프트] 멀티 맥북 그램 노트북파우치 13인치 15인치 16인치',
      '그램 피 언스 국립 공원 멜버른에서 소그룹 에코 투어',
      'LG전자 LG그램 14ZD95U-GX5WK/AMD 라이젠 16GB 256GB OS 미탑재',
      'LG전자 그램 14ZD95U-GX5WK AMD 라이젠 AI 5/16GB 256GB OS 미탑재',
      'LG그램 프로 17Z90U 17ZD90U 키보드 보호필름',
      '[보리보리] 오너클랜 커버 그램 LG 키보드 15Z960LR10K 덮개 키스킨',
      '카스 전자저울 0.1g 500그램 주방저울',
      '삼성 갤럭시북4 프로 NT960XGQ'
    ];
    const items = titles.map((t, i) => ({ title: t, price: 500000 + i, productId: `p${i}`, mall: 'ADPICK' }));
    const gate = AIID.partition(items, AIID.buildContract({ query: '노트북 그램', userText: '노트북 그램으로 추천해줘', titles }));
    const kept = gate.items.map(it => it.title);
    ok(gate.state === 'EXACT' && kept.length === 2 && kept.every(t => /14ZD95U/.test(t)),
      '«노트북» 이 상품명에 없어도 LG 그램 본품은 노트북으로 알아본다 (예전: 전부 «다른 종류» → "찾지 못했어요")', JSON.stringify(kept));
    ok(!kept.some(t => /충전기|파우치|투어|보호필름|키스킨|저울|갤럭시북/.test(t)),
      '부속(충전기·파우치·보호필름·키스킨)·여행 상품·주방저울(500그램)·다른 계열(갤럭시북)은 계속 빠진다');
    const any = AIID.partition(items, AIID.buildContract({ query: '노트북', userText: '노트북 추천해줘', titles }));
    ok(any.items.some(it => /갤럭시북4/.test(it.title)) && !any.items.some(it => /저울|보호필름/.test(it.title)),
      '«노트북» 만 물으면 갤럭시북도 노트북으로 들어온다 (계열 이름 → 종류)');
  }

  /* ================================================================ */
  section('2. 이어폰 추천 → 예산 변경 → 배터리 중시 → 다른 제품');
  {
    const s = H.session();
    const e1 = await s.say('무선 이어폰 추천해줘', { classify: 'C|무선 이어폰', answer: '소니 WF-1000XM5를 추천해요. 노이즈캔슬링이 강점이에요.' });
    ok(e1.searches === 1 && cards(e1).length >= 3, '1턴: 이어폰 후보를 찾는다', JSON.stringify(cards(e1).map(c => c.title)));
    const e2 = await s.say('예산은 10만원 이하로 해줘', { classify: 'C|무선 이어폰', answer: 'JBL 튠 비즈2를 추천해요. 노이즈캔슬링이 있고 예산 안이에요.' });
    ok(cards(e2).length >= 1 && cards(e2).every(c => c.lprice <= 100000) && H.searchLog[H.searchLog.length - 1] === '무선 이어폰',
      '2턴: 예산을 바꾸면 같은 상품(무선 이어폰)을 그 예산 안에서만 다시 고른다', JSON.stringify(cards(e2).map(c => [c.title, c.lprice])));
    const e3 = await s.say('배터리 오래가는 게 중요해', { classify: 'B', answer: 'JBL 튠 비즈2와 QCY T13 ANC 중에서는 배터리 정보가 상품명에 없어 비교하기 어려워요. 둘 다 예산 안이에요.' });
    ok(H.searchLog[H.searchLog.length - 1] === '무선 이어폰' && cards(e3).length >= 1 && cards(e3).every(c => c.lprice <= 100000),
      '3턴: «배터리 오래가» 를 검색하지 않고, 앞 예산(10만원)도 그대로 이어받는다', JSON.stringify({ q: H.searchLog.slice(-2), cards: cards(e3).map(c => c.lprice) }));
    ok(!NOT_FOUND.test(text(e3)), '3턴: «검색 결과가 없었어요» 로 끝나지 않는다', text(e3));
    const before = AC.verifyRecommendationRef(s.prevTopRef);
    const e4 = await s.say('다른 제품 추천해줘', {
      classify: 'C|무선 이어폰',
      answer: msgs => /사용자는 이 상품 «말고» 다른 후보를 원한다/.test(msgs[0].content)
        ? 'QCY T13 ANC를 추천해요. 앞에서 권한 상품보다 가격 부담이 적어요.' : '같은 상품을 다시 권합니다.'
    });
    const after = AC.verifyRecommendationRef(e4.body.topRecommendationRef);
    ok(before && after && after.productId !== before.productId
        && !cards(e4).some(c => c.productId === before.productId && (c.vendorItemId || '') === (before.vendorItemId || '')),
      '4턴: «다른 제품» — 직전 추천은 1위·카드에서 빠지고 새 1위가 나온다', JSON.stringify({ before, after, cards: cards(e4).map(c => c.title) }));
    ok(/QCY T13 ANC를 추천해요/.test(text(e4)) && cards(e4).every(c => c.lprice <= 100000),
      '4턴: «말고 다른 후보» 지시가 프롬프트에 실리고, 예산은 계속 지킨다', text(e4));
  }

  /* ================================================================ */
  section('3. 블랙·화이트 옵션 가격이 다를 때');
  {
    const s = H.session();
    const b1 = await s.say('갤럭시 버즈3 프로 블랙 얼마야?', { classify: 'D|갤럭시 버즈3 프로 블랙',
      answer: '갤럭시 버즈3 프로 블랙은 현재 139,000원이에요.' });
    ok(/139,000원/.test(text(b1)) && !/99,000원/.test(text(b1).replace(/139,000원/g, '')),
      '블랙 가격은 블랙 옵션(139,000원)으로만 말한다', text(b1));
    ok(AC.verifyRecommendationRef(b1.body.topRecommendationRef).vendorItemId === F.BUDS_BLACK.vid,
      '블랙 질문의 직전 추천 참조는 블랙 옵션(vendorItemId)이다');
    const w1 = await s.say('화이트는 얼마야?', { classify: 'D|갤럭시 버즈3 프로 화이트',
      answer: '갤럭시 버즈3 프로 화이트는 139,000원이에요. 블랙과 같은 가격이에요.' });
    ok(!/화이트는 139,000원/.test(text(w1)) && text(w1).includes('99,000원'),
      'GPT 가 화이트에 블랙 가격을 붙이면 그 문장은 빠지고 화이트의 확인된 가격으로 바로잡힌다', text(w1));
    ok(AC.verifyRecommendationRef(w1.body.topRecommendationRef).vendorItemId === F.BUDS_WHITE.vid,
      '화이트 질문 뒤 직전 추천 참조는 화이트 옵션으로 바뀐다');
    const w2 = await s.say('이거 지금 사도 돼?', { answer: '현재 99,000원은 SEOSA가 확인한 기록에서 낮은 편이에요.' });
    const facts = H.productData(w2.system);
    ok(w2.searches === 0 && cards(w2).length === 1 && cards(w2)[0].vendorItemId === F.BUDS_WHITE.vid
        && facts.includes('99,000원') && !facts.includes('139,000원') && !facts.includes('135,000원'),
      '«이거 지금 사도 돼?» 는 화이트 옵션의 기록만 본다 (블랙 기록 135,000원이 섞이지 않는다)', facts.slice(0, 400));
  }

  /* ================================================================ */
  section('4. 화제 전환 — 이전 상품과 섞지 않는다');
  {
    const s = H.session();
    await s.say('노트북 그램으로 추천해줘', { classify: 'C|그램 노트북', answer: '그램15 15ZB95N을 추천드려요.' });
    const a1 = await s.say('에어팟 프로 2 얼마야?', { classify: 'D|에어팟 프로 2',
      answer: '에어팟 프로 2세대 USB-C는 현재 329,000원이에요.' });
    ok(H.searchLog[H.searchLog.length - 1] === '에어팟 프로 2' && cards(a1).every(c => c.productId === F.AIRPODS.pid)
        && !/그램/.test(text(a1)) && !blockHeads(a1).some(h => /직전에 추천한 상품/.test(h)),
      '새 상품(에어팟)으로 바꾸면 그 상품만 찾고, 그램을 «직전 추천» 으로 끌어오지 않는다', JSON.stringify({ q: H.searchLog.slice(-1), text: text(a1) }));
    const a2 = await s.say('이거 지금 사도 돼?', { answer: '현재 329,000원은 30일 평균보다 낮은 편이에요.' });
    ok(cards(a2).length === 1 && cards(a2)[0].productId === F.AIRPODS.pid && !/그램|645,000/.test(text(a2))
        && H.productData(a2.system).includes('에어팟') && !H.productData(a2.system).includes('그램'),
      '«이거» 는 방금 이야기한 에어팟이다 — 그램 가격이 섞이지 않는다', text(a2));
  }

  /* ================================================================ */
  section('5. 없는 가격·사양 차단 — 문장 단위, 대상이 틀리면 통째로');
  {
    const s = H.session();
    const h1 = await s.say('노트북 그램으로 추천해줘', { classify: 'C|그램 노트북',
      answer: '그램15 15ZB95N을 추천드려요. 문서 작업에 무난한 구성이에요. '
        + '그램15는 RTX 4060 그래픽과 32GB 메모리를 탑재했어요. 현재 599,000원으로 역대 최저가예요. '
        + '가볍게 들고 다니며 쓰기 좋은 노트북이라는 점이 장점이에요.' });
    const t = text(h1);
    ok(!/RTX 4060|32GB|599,000|역대 최저/.test(t) && /문서 작업에 무난한 구성/.test(t) && /들고 다니며 쓰기 좋은/.test(t),
      '없는 부품(RTX 4060)·사양(32GB)·가격(599,000원)·역대 최저 문장만 빠지고 나머지 설명은 남는다', t);
    ok(!h1.body.degraded, '문장만 덜어낸 답은 «기본 답변» 으로 바뀌지 않는다');

    const all = await H.ask({ question: '노트북 그램으로 추천해줘' }, { classify: 'C|그램 노트북',
      answer: '현재 599,000원이에요. 32GB 메모리예요.' });
    ok(all.body.degraded === true && !/599,000/.test(text(all)) && /추천: LG전자 그램15 15ZB95N/.test(text(all)),
      '거의 전부가 근거 없으면 서버 조립본으로 바꾼다', text(all));

    const wrong = await H.ask({ question: '노트북 그램으로 추천해줘' }, { classify: 'C|그램 노트북',
      answer: '삼성 갤럭시북4 프로를 추천해요. 가볍고 화면이 좋아요.' });
    ok(wrong.body.degraded === true && !/갤럭시북/.test(text(wrong)),
      '후보에 없는 상품(갤럭시북4 프로)을 권하면 그 문장을 빼고, 남는 것이 없으면 서버 답으로 바꾼다', text(wrong));
    const mixed = await H.ask({ question: '노트북 그램으로 추천해줘' }, { classify: 'C|그램 노트북',
      answer: '그램15 15ZB95N을 추천드려요. 문서 작업과 인강 위주라면 i5·16GB 구성으로 충분한 편이에요. 삼성 갤럭시북4 프로도 추천해요.' });
    ok(!mixed.body.degraded && !/갤럭시북/.test(text(mixed)) && /그램15 15ZB95N을 추천드려요/.test(text(mixed)),
      '목록의 상품을 권하는 문장은 남기고, 목록에 없는 상품을 권하는 문장만 뺀다', text(mixed));
    ok(I.recommendsUnlistedProduct('삼성 갤럭시북4 프로를 추천해요.', [{ title: F.GRAM_15.title }, { title: F.GRAM_PRO.title }])
        && !I.recommendsUnlistedProduct('그램 프로 17Z90SP를 추천해요.', [{ title: F.GRAM_15.title }, { title: F.GRAM_PRO.title }])
        && !I.recommendsUnlistedProduct('이 상품을 추천해요.', [{ title: F.GRAM_15.title }]),
      '목록 밖 상품 판정: 이름이 다른 상품만 잡고, 목록의 상품·이름 없는 지시어는 통과');

    // 한 상품을 두고 묻는 턴에서 다른 상품을 «추천했다» 고 하면 — 대상이 틀린 답이다.
    const s2 = H.session();
    await s2.say('노트북 그램으로 추천해줘', { classify: 'C|그램 노트북', answer: '그램15 15ZB95N을 추천드려요.' });
    const r = await s2.say('이거 왜 추천했어?', { answer: '그램 프로 17Z90SP를 추천했어요. RTX3050이 있어서요.' });
    ok(r.body.degraded === true && /그램15/.test(text(r)) && !/그램 프로 17Z90SP를 추천했어요/.test(text(r)),
      '추천 이유 턴에서 다른 모델을 권했다고 하면 서버 근거 답으로 바뀐다', text(r));

    // 단위 함수
    const g15 = { title: F.GRAM_15.title, productId: F.GRAM_15.pid, price: F.GRAM_15.price };
    const gp = { title: F.GRAM_PRO.title, productId: F.GRAM_PRO.pid, price: F.GRAM_PRO.price };
    ok(I.unverifiedHardware('그램15는 RTX 4060을 탑재했어요.', [g15, gp]).length === 1
        && I.unverifiedHardware('그램 프로는 RTX3050이 있어 편집에 유리해요.', [g15, gp]).length === 0
        && I.unverifiedHardware('영상 편집에는 보통 RTX 4060 이상이 권장돼요.', [g15, gp]).length === 0
        && I.unverifiedHardware('이 노트북은 i7 프로세서예요.', [g15], g15).length === 1,
      '부품 주장: 상품에 붙인 없는 부품만 잡고, 일반론·상품명에 있는 부품은 통과');
    const rep = I.repairUngrounded('좋은 문장입니다. 나쁜 문장 X 입니다. 또 좋은 문장입니다.', t2 => (/X/.test(t2) ? ['x'] : []));
    ok(rep.text === '좋은 문장입니다. 또 좋은 문장입니다.' && rep.removed.length === 1,
      'repairUngrounded: 걸린 문장 하나만 빠지고 순서·문단은 그대로', JSON.stringify(rep));
  }

  /* ================================================================ */
  section('5-b. Preview 실호출에서 찾은 것 (실제 GPT 답의 모양)');
  {
    // ① 이름이 같은 두 판매 글 — 이름+가격 문장이 빠져도 답이 무엇을 권하는지 잃지 않는다.
    const o = await H.ask({ question: '오픈형 이어폰 추천해줘' }, { classify: 'C|오픈형 이어폰',
      answer: '아이리버 오픈형 무선 이어폰 IBO-OPENRING3(41,900원)을 권합니다.\n\n'
        + '상품명에서 무선이 확인되고, 귀에 넣지 않는 오픈형이라 오래 착용해도 귀가 덜 답답한 편으로 알려져 있어요. 다만 노이즈캔슬링은 상품명에 없어요.' });
    const top = (o.body.items || []).find((c, i) => o.body.topRecommendation && i === o.body.topRecommendation.index) || (o.body.items || [])[0];
    ok(!/41,900원\)을 권합니다/.test(text(o)) && /오픈형이라 오래 착용해도/.test(text(o))
        && top && I.namesProduct(text(o), { title: top.title }) && !o.body.degraded,
      '가격을 어느 판매 글 것인지 가를 수 없는 이름+가격 문장은 빠지되, 서버가 고른 상품 이름을 다시 밝힌다', text(o));

    // ② 같은 되묻기를 연달아 하지 않는다.
    const s = H.session();
    const q1 = await s.say('무선 이어폰 추천해줘', { classify: 'C|무선 이어폰',
      answer: m => {
        const block = (m[0].content.match(/\[되물을 값어치가 있는 질문 — 딱 하나\]\n\s+([^\n]+)/) || [])[1] || '';
        return `소니 WF-1000XM5를 추천해요. 노이즈캔슬링이 상품명에 있어요. ${block}`;
      } });
    const asked = /\[되물을 값어치가 있는 질문 — 딱 하나\]/.test(q1.system);
    const q2 = await s.say('예산은 10만원 이하로 해줘', { classify: 'C|무선 이어폰', answer: 'JBL 튠 비즈2를 추천해요.' });
    const q1Question = (q1.system.match(/\[되물을 값어치가 있는 질문 — 딱 하나\]\n\s+([^\n?]+)/) || [])[1] || '';
    const q2Question = (q2.system.match(/\[되물을 값어치가 있는 질문 — 딱 하나\]\n\s+([^\n?]+)/) || [])[1] || '';
    ok(asked && q1Question && q2Question !== q1Question,
      '바로 앞 답에서 한 되묻기(같은 질문)를 다음 답에서 되풀이하게 하지 않는다', JSON.stringify({ asked, q1Question, q2Question }));

    // ③ 추천 이유 답이 다른 후보와 «비교» 하는 문장은 대상이 틀린 답이 아니다.
    const subj = { title: 'LG전자 LG그램 14ZD95U-GX5WK/AMD 라이젠 16GB 256GB OS 미탑재' };
    ok(!I.recommendsOtherThanSubject('라이젠 AI 5 모델보다 이 14ZD95U-GX5WK를 먼저 추천했어요.', subj)
        && I.recommendsOtherThanSubject('그램 프로 17Z90SP를 추천했어요.', subj),
      '추천한 상품을 함께 말하는 비교 문장은 통과, 다른 모델만 권하는 문장은 대상 오류');

    // ⑤ "다른 제품" — 같은 모델 번호를 단 다른 판매처 글은 «다른 제품» 이 아니다.
    const alt = H.session();
    await alt.say('오픈형 이어폰 추천해줘', { classify: 'C|오픈형 이어폰', answer: '아이리버 오픈형 무선 이어폰 IBO-OPENRING3 러닝 귀찌형 오픈링3를 권합니다.' });
    const first = AC.verifyRecommendationRef(alt.prevTopRef);
    const altR = await alt.say('다른 제품 추천해줘', { classify: 'C|오픈형 이어폰', answer: 'JBL 튠 비즈2를 추천해요. 노이즈캔슬링이 상품명에 있어요.' });
    const second = AC.verifyRecommendationRef(altR.body.topRecommendationRef);
    ok(first && first.productId === F.OPENRING_A.pid && second && second.productId !== F.OPENRING_A.pid && second.productId !== F.OPENRING_B.pid
        && !cards(altR).some(c => /OPENRING3/i.test(c.title)),
      '«다른 제품» 에서 같은 모델(IBO-OPENRING3)의 다른 판매처 글은 1위·카드에서 빠진다', JSON.stringify({ first, second, cards: cards(altR).map(c => c.title) }));

    // ⑥ 추천 이유·구매 시점 턴에는 상품 하나로 다시 계산한 결정 블록(«유일한 후보»)을 싣지 않는다.
    const one = H.session();
    await one.say('노트북 그램으로 추천해줘', { classify: 'C|그램 노트북', answer: '그램15 15ZB95N을 추천드려요.' });
    const why = await one.say('이거 왜 추천했어?', { answer: '그램15 15ZB95N은 i5와 16GB 구성이라 문서 작업에 충분해요.' });
    ok(!/\[결정 데이터\]/.test(why.system) && /처음 추천할 때 후보가 이것뿐이었다는 뜻이 아니다/.test(why.system),
      '추천 이유 턴: 단일 상품 결정 블록 없음 · «후보가 하나뿐» 이라고 말하지 말라는 지시', blockHeads(why).join(' | ').slice(0, 300));
    const when = await one.say('지금 사는 게 좋을까?', { answer: '현재 645,000원은 30일 평균보다 낮은 편이에요.' });
    ok(!/\[결정 데이터\]/.test(when.system) && /말하지 않았다면 "말했다"고 쓰지 말고/.test(when.system),
      '구매 시점 턴: 단일 상품 결정 블록 없음 · 사용자가 말하지 않은 예산·용도를 말했다고 쓰지 않게 한다');

    // ⑦ 대체 모델이 쓴 구분선·# 제목은 말풍선에 기호로 남지 않는다. **굵게**·"- " 목록은 화면이 알아보므로 둔다.
    const md = I.tidyMarkdown('### 이유\n**가볍습니다**\n\n---\n\n- 16GB 메모리\n***\n끝');
    ok(md === '이유\n**가볍습니다**\n\n- 16GB 메모리\n\n끝', '마크다운 구분선·제목 정리', JSON.stringify(md));
    const cond = Intent.classify('근데 나는 영상 편집도 할 거야.', [{ role: 'user', text: '노트북 그램으로 추천해줘' }, { role: 'assistant', text: '…' }]);
    ok(cond.conditionFollowup && cond.confidence === 'high' && cond.query === '노트북 그램',
      '정규식이 조건(용도)까지 뽑은 후속 말은 분류 LLM 을 부르지 않는다 (분류 시간 초과 → 공급자 60초 쉼 방지)', JSON.stringify(cond));

    // ④ 직전 추천을 다시 확인하지 못했을 때 «지금 보고 계신 상품» 이라고 부르지 않는다.
    const lines = CG.contextLines({ unverified: [{ productId: 'x' }], fromRecommendation: true }).join(' ');
    ok(/직전에 추천한 상품/.test(lines) && !/지금 보고 계신/.test(lines), '직전 추천 확인 실패 문구', lines);
  }

  /* ================================================================ */
  section('6. 긴 대화 · 새로고침 뒤 맥락 유지');
  {
    const s = H.session();
    await s.say('노트북 그램으로 추천해줘', { classify: 'C|그램 노트북', answer: '그램15 15ZB95N을 추천드려요.' });
    for (const q of ['고마워', '오늘 날씨 좋다', '주말에 뭐 할까', '고마워 정말', '요즘 좀 피곤하네', '좋아']) {
      await s.say(q, { classify: 'A', answer: '네, 좋아요.' });
    }
    ok(!s.history.some(h => /노트북 그램으로 추천해줘/.test(h.text)) && !!s.prevTopRef && !!s.convState,
      '(전제) 첫 질문은 기록 창(10개) 밖으로 밀렸지만 서명 참조·대화 상태는 남아 있다');
    const reloaded = s.reload();   // 새로고침 — localStorage 의 기록·convState·서명 참조를 그대로 다시 읽는다
    const l1 = await reloaded.say('아까 추천한 그 노트북 지금 사도 돼?', { answer: '현재 645,000원은 30일 평균보다 낮은 편이에요.' });
    ok(cards(l1).length === 1 && cards(l1)[0].productId === F.GRAM_15.pid && l1.searches === 0 && !NOT_FOUND.test(text(l1)),
      '새로고침 뒤 7턴이 지나도 «아까 추천한 그 노트북» 은 그램15다', text(l1));
    const l2 = await reloaded.say('근데 게임도 할 거야', { classify: 'B',
      answer: '게임까지 생각하신다면 그램15는 외장 그래픽이 없어 한계가 있어요. 그램 프로 17Z90SP는 RTX3050이 상품명에 있어요.' });
    ok(H.searchLog[H.searchLog.length - 1] === '노트북 그램' && /용도: 게임/.test(l2.system),
      '기록 창 밖에서 말한 «그램» 을 대화 상태로 이어받아 «게임» 조건으로 다시 본다', JSON.stringify({ q: H.searchLog.slice(-1) }));

    // 직전 추천과 다른 종류를 «아까 추천한 그 ○○» 으로 가리키면 직전 추천으로 바꿔 답하지 않는다.
    const other = await reloaded.say('아까 추천한 그 이어폰 얼마야?', { answer: '그램15는 645,000원이에요.' });
    ok(!/645,000/.test(text(other)) && /달라요/.test(text(other)) && !cards(other).length && other.llmMain === 0,
      '«아까 추천한 그 이어폰» 인데 직전 추천이 노트북이면 노트북 가격을 대신 말하지 않고 되묻는다', text(other));
    ok(AC.verifyRecommendationRef(reloaded.prevTopRef).productId === F.GRAM_15.pid,
      '그 되물음 뒤에도 직전 추천(그램15) 참조는 그대로 이어진다');

    // 서명이 만료되면 기억하는 척하지 않는다.
    const expired = AC.createRecommendationRef({ productId: F.GRAM_15.pid, vendorItemId: F.GRAM_15.vid, mallId: '쿠팡' }, Date.now() - AC.REF_TTL_MS - 60e3);
    const old = await H.ask({ question: '이거 왜 추천했어?', prevTopRef: expired,
      chatHistory: [{ role: 'user', text: '노트북 그램으로 추천해줘' }, { role: 'assistant', text: '그램15를 추천드려요.' }] },
    { answer: '그램15를 추천한 이유는 가볍기 때문이에요.' });
    ok(text(old) === CG.REASON_REF_MISSING && !cards(old).length && old.llmMain === 0,
      '만료된 옛 추천은 아는 척하지 않고 «특정하기 어렵다» 고 말한다', text(old));
  }

  /* ================================================================ */
  section('11. 같은 상품을 이어 물을 때 카드 반복 방지 (서버 힌트)');
  {
    const s = H.session();
    const r1 = await s.say('노트북 그램으로 추천해줘', { classify: 'C|그램 노트북', answer: '그램15 15ZB95N을 추천드려요.' });
    const r2 = await s.say('이거 왜 추천했어?', { answer: '그램15 15ZB95N은 i5와 16GB 구성이라 문서 작업에 충분해요. 현재 645,000원이에요.' });
    ok(!r1.body.reusePreviousCard && r2.body.reusePreviousCard === true && cards(r2).length === 1,
      '새 추천은 카드를 그리고, 같은 상품을 이어 묻는 답에는 «앞 카드와 같다» 힌트를 준다');
    ok(Array.isArray(cards(r2)[0].spark) && cards(r2)[0].spark.length >= 3 && cards(r2)[0].spark.every(v => v > 0),
      '카드에 그 옵션의 최근 관측가(가격 흐름 그래프 재료)가 실린다', JSON.stringify(cards(r2)[0].spark));
  }

  /* ================================================================ */
  section('7·8·9·10·11. 채팅창 UI (public/index.html 실제 실행)');
  {
    const { loadApp, FakeEl } = require('./_fake-dom');
    const env = loadApp();
    const { app, ctx } = env;
    const CR = ctx.ChatResize;
    ok(!!CR && typeof CR.init === 'function', 'ChatResize 가 있다');
    const panel = env.register(new FakeEl('div'), { id: 'panel' });
    const handle = env.register(new FakeEl('div'), { id: 'chatResize' });
    const vars = {};
    panel.style.setProperty = (k, v) => { vars[k] = v; };
    let rectW = 420;
    panel.getBoundingClientRect = () => ({ width: rectW, left: 0, top: 0, right: rectW, bottom: 0, height: 0 });
    let desktop = true;
    ctx.matchMedia = () => ({ matches: desktop, addEventListener() {}, addListener() {} });
    CR._mq = null;
    ctx.innerWidth = 1600;
    ctx.requestAnimationFrame = fn => { fn(); return 1; };
    ctx.cancelAnimationFrame = () => {};

    CR.init();
    ok(vars['--chat-w'] === '420px' && !panel.classList.contains('is-resized'), '처음에는 예전과 같은 420px');

    // 7. 드래그 — 왼쪽 가장자리를 300px 왼쪽으로 끌면 그만큼 넓어진다 (끄는 동안 실시간)
    const fire = (type, ev) => (handle.listeners[type] || []).forEach(fn => fn(Object.assign({ preventDefault() {}, button: 0, pointerId: 1 }, ev)));
    fire('pointerdown', { clientX: 1180 });
    ok(env.ctx.document.body.classList.contains('chat-resizing'), '끄는 동안 본문 선택·전환이 멈춘다(chat-resizing)');
    fire('pointermove', { clientX: 1030 });
    ok(vars['--chat-w'] === '570px', '끄는 도중 너비가 실시간으로 바뀐다 (420 → 570)', vars['--chat-w']);
    fire('pointermove', { clientX: 880 });
    fire('pointerup', {});
    ok(vars['--chat-w'] === '720px' && panel.classList.contains('is-resized') && !env.ctx.document.body.classList.contains('chat-resizing'),
      '놓으면 720px 로 고정되고 «기본 크기» 버튼이 나타난다', vars['--chat-w']);
    ok(ctx.localStorage.getItem('seosa_chat_width') === '720', '10. 고른 너비를 localStorage 에 저장한다');

    // 화면 밖으로 나가지 않는다 — 최대 화면의 90%, 최소 360px
    rectW = 720;
    fire('pointerdown', { clientX: 880 });
    fire('pointermove', { clientX: -2000 });
    fire('pointerup', {});
    ok(vars['--chat-w'] === `${Math.floor(1600 * 0.9)}px`, '아무리 넓혀도 화면 너비의 90%(1440px)에서 멈춘다', vars['--chat-w']);
    rectW = 1440;
    fire('pointerdown', { clientX: 160 });
    fire('pointermove', { clientX: 5000 });
    fire('pointerup', {});
    ok(vars['--chat-w'] === '360px', '아무리 줄여도 최소 360px', vars['--chat-w']);

    // 10. 키보드 — ← 넓게 · → 좁게 · Shift 크게 · Home/End
    const key = (k, shift) => (handle.listeners.keydown || []).forEach(fn => fn({ key: k, shiftKey: !!shift, preventDefault() {} }));
    key('ArrowLeft');
    ok(vars['--chat-w'] === '384px', '← 키로 24px 넓어진다', vars['--chat-w']);
    key('ArrowLeft', true);
    ok(vars['--chat-w'] === '504px', 'Shift+← 로 120px 넓어진다', vars['--chat-w']);
    key('ArrowRight');
    ok(vars['--chat-w'] === '480px', '→ 키로 좁아진다', vars['--chat-w']);
    key('End');
    ok(vars['--chat-w'] === '1440px' && handle.getAttribute('aria-valuenow') === '1440' && handle.getAttribute('aria-valuemax') === '1440',
      'End 는 최대, 화면 낭독기용 aria-valuenow·valuemax 가 함께 바뀐다');

    // 창을 줄이면 화면 안으로 다시 묶되 저장값은 지킨다
    ctx.innerWidth = 1000;
    CR.apply(CR.saved, false);
    ok(vars['--chat-w'] === '900px' && ctx.localStorage.getItem('seosa_chat_width') === '1440',
      '창을 1000px 로 줄이면 900px 로 묶이고, 저장값(1440)은 그대로');
    ctx.innerWidth = 1600;

    // 새로고침 — 저장된 너비를 복원한다
    const env2 = loadApp();
    const p2 = env2.register(new FakeEl('div'), { id: 'panel' });
    env2.register(new FakeEl('div'), { id: 'chatResize' });
    const vars2 = {};
    p2.style.setProperty = (k, v) => { vars2[k] = v; };
    env2.ctx.innerWidth = 1600;
    env2.ctx.localStorage.setItem('seosa_chat_width', '700');
    env2.ctx.ChatResize.init();
    ok(vars2['--chat-w'] === '700px' && p2.classList.contains('is-resized'), '10. 새로고침해도 저장한 700px 로 열린다', vars2['--chat-w']);

    // 기본 크기로 되돌리기 — 버튼(data-act) · 손잡이 Enter · 두 번 누르기
    const btn = new FakeEl('button'); btn.setAttribute('data-act', 'chat-width-reset');
    env.click(btn);
    ok(vars['--chat-w'] === '420px' && !panel.classList.contains('is-resized') && ctx.localStorage.getItem('seosa_chat_width') === null,
      '10. «기본 크기» 를 누르면 420px 로 돌아가고 저장값이 지워진다');
    key('End'); key('Enter');
    ok(vars['--chat-w'] === '420px', '10. 손잡이에서 Enter 도 기본 크기로 되돌린다');
    key('End'); (handle.listeners.dblclick || []).forEach(fn => fn({}));
    ok(vars['--chat-w'] === '420px', '10. 손잡이를 두 번 눌러도 기본 크기');

    // 9. 모바일·태블릿(터치) — 드래그·키 조절이 아무 일도 하지 않는다
    desktop = false;
    CR._mq = null;
    fire('pointerdown', { clientX: 300 });
    fire('pointermove', { clientX: 100 });
    fire('pointerup', {});
    key('ArrowLeft');
    ok(vars['--chat-w'] === '420px' && !env.ctx.document.body.classList.contains('chat-resizing'),
      '9. 터치·좁은 화면에서는 끌어도·키를 눌러도 너비가 바뀌지 않는다');

    // 9. CSS — 데스크톱 조건 안에서만 --chat-w 를 쓰고, 모바일 규칙은 그대로
    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const deskBlock = (html.match(/@media \(min-width:768px\) and \(hover:hover\) and \(pointer:fine\)\{[\s\S]*?\n\}/) || [''])[0];
    ok(/#panel\{width:var\(--chat-w,420px\);max-width:calc\(100vw - 16px\)\}/.test(deskBlock) && /\.chat-resize\{display:block/.test(deskBlock),
      '9. 너비 변수·손잡이는 데스크톱(정밀 포인터·768px 이상) 조건 안에서만 켜진다');
    ok(/\.chat-resize\{display:none\}/.test(html) && /\n  \.panel\{width:100%;max-width:100%\}/.test(html),
      '9. 모바일(≤480px) 패널은 예전처럼 화면 전체 너비 · 손잡이 기본값은 숨김');
    ok(/@container \(min-width:540px\)\{\.mini-grid\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)\}\}/.test(html)
        && /@container \(min-width:760px\)/.test(html) && /\.chat\{container-type:inline-size;overflow-x:hidden\}/.test(html),
      '8. 넓힌 창에서 카드가 3·4·5열로 다시 놓이고, 채팅창 안에서만 스크롤된다(가로 넘침 없음)');

    // 8. 카드 안 가격 흐름 그래프
    const card = { productId: 'G15', vendorItemId: 'G15-V1', mall: '쿠팡', title: F.GRAM_15.title, lprice: 645000,
      link: 'https://www.coupang.com/vp/products/G15?vendorItemId=G15-V1', image: '', spark: [699000, 699000, 659000, 699000, 645000, 645000] };
    const mini = app.Chat.miniCard(card, true);
    ok(/<svg class="mspark" viewBox="0 0 100 18" preserveAspectRatio="none"/.test(mini) && /<polyline points="0\.0,/.test(mini)
        && /aria-label="최근 관측 6회 가격 흐름 · 최저 645,000원 · 최고 699,000원"/.test(mini),
      '8. 카드에 패널 너비를 따라 늘어나는 가격 흐름 그래프가 그려진다', mini.slice(mini.indexOf('<svg'), mini.indexOf('<svg') + 220));
    ok(app.Chat.sparkSvg([645000, 645000, 645000]) === '' && app.Chat.sparkSvg([1, 2]) === '',
      '8. 값이 움직이지 않았거나 관측이 3회 미만이면 그래프를 그리지 않는다');

    // 11. 카드 반복 방지 — 화면에 같은 묶음이 있을 때만 생략
    const res = { items: [card], topRecommendation: { productId: 'G15', vendorItemId: 'G15-V1', mall: '쿠팡', index: 0 } };
    app.Chat.lastCards = null;
    ok(!app.Chat.sameAsShownCards(res), '11. 앞에 그린 카드가 없으면(새로고침 직후 등) 그린다');
    const g16 = { productId: 'G16', vendorItemId: 'G16-V1', mall: '쿠팡', lprice: 1590000 };
    app.Chat.lastCards = { keys: app.Chat.cardKeys({ items: [card, g16] }), top: app.Chat.cardKey(card), el: new FakeEl('div') };
    ok(app.Chat.sameAsShownCards(res), '11. 앞 묶음(그램15·그램16)에 이미 있는 그램15 카드 하나는 다시 그리지 않는다');
    app.Chat.lastCards = { keys: app.Chat.cardKeys(res), top: app.Chat.topCardKey(res), el: new FakeEl('div') };
    ok(app.Chat.sameAsShownCards(res), '11. 바로 앞에 같은 상품·옵션·가격 카드가 있으면 다시 그리지 않는다');
    ok(!app.Chat.sameAsShownCards({ items: [Object.assign({}, card, { lprice: 639000 })], topRecommendation: res.topRecommendation }),
      '11. 같은 상품이라도 가격이 바뀌면 다시 그린다');
    ok(!app.Chat.sameAsShownCards({ items: [Object.assign({}, card, { vendorItemId: 'G15-V2' })] }),
      '11. 옵션이 다르면 다시 그린다');
    ok(!app.Chat.sameAsShownCards({ items: [card], topRecommendation: { productId: 'G15', vendorItemId: 'G15-V1', mall: '쿠팡', index: 0 } }) === false
        && (() => { app.Chat.lastCards = { keys: app.Chat.cardKeys({ items: [card, g16] }), top: app.Chat.cardKey(g16), el: new FakeEl('div') }; return !app.Chat.sameAsShownCards(res); })(),
      '11. 같은 카드들이어도 «추천 상품» 강조가 바뀌면(그램16 → 그램15) 새 추천으로 보고 다시 그린다');
    app.Chat.lastCards = { keys: app.Chat.cardKeys(res), top: app.Chat.topCardKey(res), el: new FakeEl('div') };
    ok(!app.Chat.sameAsShownCards({ items: [card, g16] }),
      '11. 새 추천(앞에 없던 후보가 하나라도 있음)이면 다시 그린다');
    app.Chat.lastCards = { keys: app.Chat.cardKeys(res), top: app.Chat.topCardKey(res), el: new FakeEl('div') };
    app.AppState.chatHistory = [{ role: 'user', text: 'x' }];
    app.Chat.clear();
    ok(app.Chat.lastCards === null, '11. 대화를 지우면 기억한 카드도 비운다');

    // 6(UI). 직전 추천 서명 참조를 대화와 함께 저장·복원
    app.AppState.chatHistory = [{ role: 'user', text: '노트북 그램으로 추천해줘' }];
    app.AppState.lastTopRecommendationRef = 'air2.payload.sig';
    app.AppState.lastTopProductId = 'G15';
    app.Chat.persist();
    const saved = JSON.parse(ctx.localStorage.getItem('seosa_chat'));
    ok(saved.topRef === 'air2.payload.sig' && saved.topId === 'G15', '6. 직전 추천 참조를 대화 기록과 같은 곳에 저장한다');
    // 새로고침 — 같은 저장소로 페이지를 다시 띄운다.
    const reloaded = loadApp({ storage: { seosa_chat: JSON.stringify(saved) } }).app;
    ok(reloaded.AppState.lastTopRecommendationRef === 'air2.payload.sig' && reloaded.AppState.lastTopProductId === 'G15'
        && reloaded.AppState.chatHistory.length === 1,
      '6. 새로고침하면 대화와 함께 직전 추천 참조도 복원된다 («이거 왜 추천했어?» 가 이어진다)');
    const stale = loadApp({ storage: { seosa_chat: JSON.stringify(Object.assign({}, saved, { savedAt: Date.now() - 31 * 60e3 })) } }).app;
    ok(stale.AppState.lastTopRecommendationRef === '' && !stale.AppState.chatHistory.length,
      '6. 대화가 만료(30분)되면 참조도 함께 버린다 — 오래된 대화를 기억하는 척하지 않는다');
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`외부 호출 ${H.counters.external}회 · DB 쓰기 시도 ${H.counters.dbWrites}회`);
  ok(H.counters.external === 0 && H.counters.dbWrites === 0, '외부 호출 0회 · DB 쓰기 0회');
  console.log(`=== 결과: ${pass}/${pass + fail} PASS ===`);
  if (fail) {
    console.log('\n실패:');
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
})().catch(e => { console.error(e); process.exit(1); });
