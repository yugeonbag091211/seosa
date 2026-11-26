#!/usr/bin/env node
/*
 * api/_category-classifier.js 회귀 테스트 — 실제 OpenAI 호출 0회.
 * api/_product-kind-classifier.js 테스트와 같은 구조.
 */
'use strict';

const { classifyBatch, parseResponse, buildPrompt, CATEGORIES, DEFAULT_MAX_BATCH } = require('../api/_category-classifier');

const checks = [];
function check(name, cond, detail) {
  checks.push({ name, pass: !!cond });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`, cond ? '' : JSON.stringify(detail));
}

(async () => {
  console.log('1. parseResponse — 정상 JSON');
  check('["전자기기","패션의류"] 그대로 파싱',
    JSON.stringify(parseResponse('["전자기기","패션의류"]', 2)) === JSON.stringify(['전자기기', '패션의류']));

  console.log('\n2. parseResponse — 코드펜스/설명 섞여도 뽑아낸다');
  check('```json 로 감싸도 파싱',
    JSON.stringify(parseResponse('```json\n["패션잡화","전자기기","unknown"]\n```', 3))
      === JSON.stringify(['패션잡화', '전자기기', 'unknown']));

  console.log('\n3. parseResponse — 고정 목록에 없는 값은 unknown으로');
  check('목록에 없는 값(오타·영어)은 unknown',
    JSON.stringify(parseResponse('["전자기기","electronics","뷰티"]', 3))
      === JSON.stringify(['전자기기', 'unknown', '뷰티']));

  console.log('\n4. parseResponse — 배열은 찾았는데 길이가 모자라면 그 자리만 unknown');
  check('배열보다 짧은 응답은 모자란 자리만 unknown',
    JSON.stringify(parseResponse('["전자기기"]', 3)) === JSON.stringify(['전자기기', 'unknown', 'unknown']));

  console.log('\n5. classifyBatch — 정상 호출 (그래픽카드 vs 트럼프카드 맨투맨)');
  {
    const titles = [
      'RTX 4070 그래픽카드 지포스 게이밍 PC용',
      '오픈런 아토가토 그래픽 맨투맨뒤면 게임 트럼프카드 니트패턴'
    ];
    const fakeChat = async () => ({ ok: true, text: '["전자기기","패션의류"]' });
    const r = await classifyBatch(titles, { chat: fakeChat });
    check('2건 분류 결과', JSON.stringify(r) === JSON.stringify(['전자기기', '패션의류']), r);
  }

  console.log('\n6. classifyBatch — LLM이 실패해도(ok:false) 전부 null(= 못 물어봄), 안 터진다');
  {
    const fakeChat = async () => ({ ok: false, reason: 'cooldown' });
    const r = await classifyBatch(['아무 상품'], { chat: fakeChat });
    check('ok:false → null(재시도 대상)', JSON.stringify(r) === JSON.stringify([null]));
  }

  console.log('\n7. classifyBatch — chat()이 예외를 던져도 안 터진다 (역시 null)');
  {
    const fakeChat = async () => { throw new Error('network down'); };
    const r = await classifyBatch(['상품A', '상품B'], { chat: fakeChat });
    check('예외 → 전부 null(재시도 대상)', JSON.stringify(r) === JSON.stringify([null, null]));
  }

  console.log(`\n8. classifyBatch — ${DEFAULT_MAX_BATCH}건 넘으면 한 번에 안 묻고 쪼갠다`);
  {
    let calls = 0;
    const titles = Array.from({ length: DEFAULT_MAX_BATCH + 5 }, (_, i) => `상품${i}`);
    const fakeChat = async ({ messages }) => {
      calls++;
      const m = messages[1].content.match(/길이 (\d+)/);
      const n = Number(m[1]);
      return { ok: true, text: JSON.stringify(Array.from({ length: n }, () => '기타')) };
    };
    const r = await classifyBatch(titles, { chat: fakeChat });
    check('두 번 이상 나눠 호출', calls >= 2, calls);
    check('전체 길이는 원래 입력과 같다', r.length === titles.length, r.length);
    check('전부 기타로 채워짐', r.every(v => v === '기타'));
  }

  console.log('\n9. buildPrompt — 메시지 모양 확인(실제 호출 아님)');
  {
    const msgs = buildPrompt(['상품A', '상품B']);
    check('system + user 2개', msgs.length === 2 && msgs[0].role === 'system' && msgs[1].role === 'user');
    check('user 메시지에 번호 매겨 담김', /1\. 상품A[\s\S]*2\. 상품B/.test(msgs[1].content));
    check('카테고리 고정 목록이 13개', CATEGORIES.length === 13, CATEGORIES.length);
  }

  const passed = checks.filter(c => c.pass).length;
  const failed = checks.length - passed;
  console.log(`\n${'='.repeat(60)}\n상품 카테고리 분류기 테스트: ${passed} PASS / ${failed} FAIL\n${'='.repeat(60)}`);
  if (failed) process.exit(1);
})();
