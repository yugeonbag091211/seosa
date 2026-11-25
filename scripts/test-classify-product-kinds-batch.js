#!/usr/bin/env node
/*
 * scripts/classify-product-kinds-batch.js 회귀 테스트 — 실제 Supabase/OpenAI 호출 0회.
 * 가짜 "아직 분류 안 된 상품 목록"과 가짜 sync()(syncProductKinds 대역)를 주입해 검증한다.
 */
'use strict';

const { runBatchClassification, chunk } = require('./classify-product-kinds-batch');

const checks = [];
function check(name, cond, detail) {
  checks.push({ name, pass: !!cond });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`, cond ? '' : JSON.stringify(detail));
}

(async () => {
  console.log('1. chunk — 라운드 크기대로 나눈다');
  {
    const parts = chunk([1, 2, 3, 4, 5], 2);
    check('5개를 2개씩 3묶음으로', JSON.stringify(parts) === JSON.stringify([[1, 2], [3, 4], [5]]), parts);
  }

  console.log('\n2. 대상이 없으면 아무것도 안 하고 끝난다');
  {
    let syncCalls = 0;
    const result = await runBatchClassification({
      fetchUnclassified: async () => [],
      sync: async () => { syncCalls++; return new Map(); }
    });
    check('sync 호출 0회', syncCalls === 0, syncCalls);
    check('candidates 0, classified 0', result.candidates === 0 && result.classified === 0, result);
  }

  console.log('\n3. --dry-run 이면 목록만 세고 sync는 절대 안 부른다');
  {
    let syncCalls = 0;
    const items = [{ productId: 'A', title: '마우스' }, { productId: 'B', title: '마우스패드' }];
    const result = await runBatchClassification({
      dryRun: true,
      fetchUnclassified: async () => items,
      sync: async () => { syncCalls++; return new Map(); }
    });
    check('sync 호출 0회(dry-run)', syncCalls === 0, syncCalls);
    check('candidates만 채워짐', result.candidates === 2, result);
  }

  console.log('\n4. roundSize 단위로 나눠 sync를 여러 번 부른다');
  {
    const items = Array.from({ length: 5 }, (_, i) => ({ productId: `P${i}`, title: `상품${i}` }));
    const calls = [];
    const sync = async (round) => {
      calls.push(round.map(r => r.productId));
      return new Map(round.map(r => [r.productId, 'main']));
    };
    const result = await runBatchClassification({
      fetchUnclassified: async () => items, sync, roundSize: 2
    });
    check('5개를 2개씩 3라운드로 나눠 호출', calls.length === 3 && calls[2].length === 1, calls);
    check('5개 전부 classified로 집계', result.classified === 5 && result.stillUnknown === 0, result);
    check('rounds가 실제 호출 수와 일치', result.rounds === 3, result);
  }

  console.log('\n5. 일부가 타임아웃(맵에 없음)이면 재시도 대상(stillUnknown)으로 집계한다');
  {
    // ★ api/_product-kind-store.js의 null-vs-unknown 구분을 그대로 물려받는다 —
    //   sync()(=syncProductKinds)가 타임아웃난 상품은 맵에서 빼고 돌려주므로,
    //   이 스크립트는 "맵에 없으면 재시도 대상"으로만 집계하면 된다.
    const items = [
      { productId: 'A', title: '마우스' },
      { productId: 'B', title: '마우스패드' }, // 타임아웃 가정 — sync가 맵에서 뺌
      { productId: 'C', title: '애매한 상품' }
    ];
    const sync = async () => new Map([['A', 'main'], ['C', 'unknown']]); // B는 없음
    const result = await runBatchClassification({ fetchUnclassified: async () => items, sync, roundSize: 20 });
    check('classified 2건(A, C), 재시도 대상 1건(B)', result.classified === 2 && result.stillUnknown === 1, result);
  }

  console.log('\n6. 한 라운드가 예외를 던져도 전체가 멈추지 않고 다음 라운드로 넘어간다');
  {
    const items = Array.from({ length: 4 }, (_, i) => ({ productId: `P${i}`, title: `상품${i}` }));
    const calls = [];
    const sync = async (round) => {
      calls.push(round.map(r => r.productId));
      if (calls.length === 1) throw new Error('openai down');
      return new Map(round.map(r => [r.productId, 'main']));
    };
    const result = await runBatchClassification({ fetchUnclassified: async () => items, sync, roundSize: 2 });
    check('두 라운드 다 시도됨(첫 라운드 실패해도 중단 안 함)', calls.length === 2, calls);
    check('실패한 라운드의 2건은 집계에서 빠짐(에러로 죽지 않고 계속)', result.classified === 2, result);
  }

  console.log('\n7. fetchUnclassified에 rowLimit이 그대로 전달된다');
  {
    let askedLimit = null;
    await runBatchClassification({
      rowLimit: 77,
      fetchUnclassified: async (limit) => { askedLimit = limit; return []; },
      sync: async () => new Map()
    });
    check('rowLimit 그대로 전달', askedLimit === 77, askedLimit);
  }

  const passed = checks.filter(c => c.pass).length;
  const failed = checks.length - passed;
  console.log(`\n${'='.repeat(60)}\n상품 종류 배치 분류 테스트: ${passed} PASS / ${failed} FAIL\n${'='.repeat(60)}`);
  if (failed) process.exit(1);
})();
