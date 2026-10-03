#!/usr/bin/env node
'use strict';
// Diagnostics share the collector's cache, daily/minute quota and circuit breaker.
// Never probe alternative headers/IPs around the provider's refusal.
require('./_env');
const { searchCoupang } = require('../api/_coupang');

async function probe(keyword = '무선 이어폰') {
  const result = await searchCoupang(keyword, {
    limit: 5, source: 'collect', collectionMode: true,
    maxWaitMs: 5000, minGapMs: 4000, cacheTtlMs: 24 * 60 * 60 * 1000
  });
  return { from: result.from, apiCalled: result.apiCalled === true,
    items: (result.items || []).length, blocked: !!result.blocked,
    failureReason: result.failureReason || (result.error ? 'SOURCE_ERROR' : null) };
}

if (require.main === module) {
  probe(process.argv[2]).then(result => console.log(JSON.stringify(result)))
    .catch(() => { console.error('진단 실패: 공용 API/DB 설정을 확인하세요.'); process.exitCode = 1; });
}
module.exports = { probe };
