#!/usr/bin/env node
/*
 * api/_compat-accessory.js 테스트 — 외부 호출·DB 0회, 순수 함수만 검증.
 *
 *   node scripts/test-compat-accessory-noun-20261125.js
 */
'use strict';

const { compatibilityAccessoryNoun, isCompatibilityAccessoryQuery } = require('../api/_compat-accessory');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail != null ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail != null ? '  — ' + detail : ''}`); }
}

console.log('1) 모델코드+용 패턴 — 사전에 없는 낱말도 뽑는다');
check('DS224+용 트레이', compatibilityAccessoryNoun('DS224+용 트레이 찾는 중이야') === '트레이');
check('60cm용 서랍 레일', compatibilityAccessoryNoun('60cm용 서랍 레일 찾아줘') === '레일');
check('RTX4090용 브라켓', compatibilityAccessoryNoun('RTX4090용 지지대 브라켓 사려고') === '브라켓');

console.log('\n2) "OOO에 쓸/사용할" 패턴');
check('냉장고에 쓸 정수필터', compatibilityAccessoryNoun('냉장고에 쓸 정수필터 추천해줘') === '정수필터');
check('노트북에 사용할 받침대', compatibilityAccessoryNoun('노트북에 사용할 받침대 보여줘') === '받침대');

console.log('\n3) 패턴이 없으면 빈 문자열 — 오탐 금지');
check('평범한 본품 검색', compatibilityAccessoryNoun('노트북 추천해줘') === '');
check('용이 들어가지만 호환 대상이 아님(가정용)', compatibilityAccessoryNoun('가정용 공기청정기 찾아줘') === '', JSON.stringify(compatibilityAccessoryNoun('가정용 공기청정기 찾아줘')));
check('모델코드 없이 용만', compatibilityAccessoryNoun('사무용 키보드 추천') === '', JSON.stringify(compatibilityAccessoryNoun('사무용 키보드 추천')));

console.log('\n4) isCompatibilityAccessoryQuery — 불리언 래퍼');
check('호환 질의 true', isCompatibilityAccessoryQuery('DS224+용 트레이') === true);
check('일반 질의 false', isCompatibilityAccessoryQuery('노트북 추천해줘') === false);

console.log('\n5) 경계값 — 빈 입력·null·undefined에서 던지지 않는다');
check('빈 문자열', compatibilityAccessoryNoun('') === '');
check('null', compatibilityAccessoryNoun(null) === '');
check('undefined', compatibilityAccessoryNoun(undefined) === '');

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
