#!/usr/bin/env node
/*
 * test-search.js 의 254개 회귀 테스트를, 형태소 분석기(키위)를 실제로 꽂은
 * 상태에서 다시 돌린다.
 *
 *   node scripts/test-search-with-morph.js
 *
 * test-search.js 자체는 "분석기 없이도 기존 동작이 안 깨지는지"를 지키는
 * 파일이라 그대로 두고, 이 파일은 "분석기를 켠 상태에서도 기존 254개가
 * 전부 그대로 통과하는지"를 추가로 확인한다. require 캐시를 공유하기
 * 때문에 _search.js 모듈 인스턴스는 동일하다 — setMorphProvider 로 먼저
 * 꽂아두고, 그 다음에 test-search.js 를 불러와서 같은 인스턴스로 돌린다.
 */
'use strict';

const S = require('../api/_search');
const M = require('../api/_morph-analyzer');

(async () => {
  await M.ensureReady();
  if (!M.isReady()) {
    console.error('키위 로딩 실패 — 모델 파일을 확인하세요.');
    process.exit(1);
  }
  S.setMorphProvider(M.analyzeFlatSync);
  require('./test-search.js');
})();
