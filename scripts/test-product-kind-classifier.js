#!/usr/bin/env node
/*
 * api/_product-kind-classifier.js 회귀 테스트 — 실제 OpenAI 호출 0회.
 * chat() 을 가짜 함수로 주입해 응답 파싱·배치 분할·실패 안전장치를 검증한다.
 */
'use strict';

const { classifyBatch, parseResponse, buildPrompt, DEFAULT_MAX_BATCH } = require('../api/_product-kind-classifier');

const checks = [];
function check(name, cond, detail) {
  checks.push({ name, pass: !!cond });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`, cond ? '' : JSON.stringify(detail));
}

(async () => {
  console.log('1. parseResponse — 정상 JSON');
  check('["main","accessory"] 그대로 파싱',
    JSON.stringify(parseResponse('["main","accessory"]', 2)) === JSON.stringify(['main', 'accessory']));

  console.log('\n2. parseResponse — 코드펜스/설명 섞여도 뽑아낸다');
  check('```json 로 감싸도 파싱',
    JSON.stringify(parseResponse('```json\n["accessory","main","unknown"]\n```', 3))
      === JSON.stringify(['accessory', 'main', 'unknown']));

  console.log('\n3. parseResponse — 이상한 값은 unknown으로');
  check('모르는 문자열(한글·오타)은 unknown, 대소문자는 구분 안 함',
    JSON.stringify(parseResponse('["Main","부속","accessory"]', 3))
      === JSON.stringify(['main', 'unknown', 'accessory']));
  // "MAIN"(대문자)은 소문자 변환 후 'main'과 일치해야 한다.
  check('대문자 MAIN도 소문자 변환 후 인식',
    JSON.stringify(parseResponse('["MAIN"]', 1)) === JSON.stringify(['main']));

  console.log('\n4. parseResponse — 배열은 찾았는데 길이가 모자라면 그 자리만 unknown');
  check('배열보다 짧은 응답은 모자란 자리만 unknown',
    JSON.stringify(parseResponse('["main"]', 3)) === JSON.stringify(['main', 'unknown', 'unknown']));

  console.log('\n5. classifyBatch — 정상 호출');
  {
    const titles = ['로지텍 G304 무선 마우스', '마우스패드 XL', '한성 기계식 키보드'];
    const fakeChat = async () => ({ ok: true, text: '["main","accessory","main"]' });
    const r = await classifyBatch(titles, { chat: fakeChat });
    check('3건 분류 결과', JSON.stringify(r) === JSON.stringify(['main', 'accessory', 'main']), r);
  }

  console.log('\n6. classifyBatch — LLM이 실패해도(ok:false) 전부 null(= 못 물어봄), 안 터진다');
  {
    // ★ 2026-11-25: 타임아웃/쿨다운은 "몰랐다"(unknown)가 아니라 "못 물어봤다"(null)다.
    //   이 둘을 섞어서 전부 unknown으로 캐싱했다가, 운영 리허설에서 타임아웃난 상품이
    //   영구히 재분류 안 되는 사고가 났다 — null 이어야 store.js가 재시도 대상으로 남긴다.
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

  console.log('\n6b. parseResponse — 응답 자체를 못 알아보면 null, 배열 속 이상한 값만 unknown');
  check('빈 문자열은 null(= 답을 못 받음)', JSON.stringify(parseResponse('', 2)) === JSON.stringify([null, null]));
  check('JSON 아니면 null', JSON.stringify(parseResponse('모르겠어요', 2)) === JSON.stringify([null, null]));
  check('배열은 왔는데 한 자리가 이상하면 그 자리만 unknown',
    JSON.stringify(parseResponse('["main","???"]', 2)) === JSON.stringify(['main', 'unknown']));

  console.log('\n8. classifyBatch — 빈 배열/미지정 입력');
  check('빈 배열 → 빈 배열', JSON.stringify(await classifyBatch([])) === '[]');
  check('undefined → 빈 배열', JSON.stringify(await classifyBatch(undefined)) === '[]');

  console.log(`\n9. classifyBatch — ${DEFAULT_MAX_BATCH}건 넘으면 한 번에 안 묻고 쪼갠다 (토큰 비용 상한)`);
  {
    let calls = 0;
    const titles = Array.from({ length: DEFAULT_MAX_BATCH + 5 }, (_, i) => `상품${i}`);
    const fakeChat = async ({ messages }) => {
      calls++;
      // user 메시지에 적힌 "길이 N" 만큼 main을 채워 돌려준다.
      const m = messages[1].content.match(/길이 (\d+)/);
      const n = Number(m[1]);
      return { ok: true, text: JSON.stringify(Array.from({ length: n }, () => 'main')) };
    };
    const r = await classifyBatch(titles, { chat: fakeChat });
    check('두 번 이상 나눠 호출', calls >= 2, calls);
    check('전체 길이는 원래 입력과 같다', r.length === titles.length, r.length);
    check('전부 main으로 채워짐', r.every(v => v === 'main'));
  }

  console.log('\n10. buildPrompt — 메시지 모양 확인(실제 호출 아님)');
  {
    const msgs = buildPrompt(['상품A', '상품B']);
    check('system + user 2개', msgs.length === 2 && msgs[0].role === 'system' && msgs[1].role === 'user');
    check('user 메시지에 번호 매겨 담김', /1\. 상품A[\s\S]*2\. 상품B/.test(msgs[1].content));
  }

  const passed = checks.filter(c => c.pass).length;
  const failed = checks.length - passed;
  console.log(`\n${'='.repeat(60)}\n상품 종류 분류기 테스트: ${passed} PASS / ${failed} FAIL\n${'='.repeat(60)}`);
  if (failed) process.exit(1);
})();
