#!/usr/bin/env node
'use strict';
/*
 * Single *live* Coupang Search API SUBID attribution diagnostic.
 *
 * Deliberately not wired to npm test, cron, or public API routes.
 * Makes at most one authorized call through searchCoupang's global quota gate,
 * bypasses keyword cache, and writes NO product/cache/conversion rows.
 *
 * Usage (from repository root, with .env.local configured):
 *   node scripts/diag-coupang-subid-once.js --live-once
 */
if (!process.argv.includes('--live-once')) {
  console.error('실제 쿠팡 API 요청 1회가 발생합니다. 명시적으로 --live-once를 붙여 실행하세요.');
  process.exit(2);
}
require('./_env');
const { searchCoupang } = require('../api/_coupang');
const { classifyCoupang } = require('../api/_affiliate');

(async () => {
  const subId = 'SEOSA2026';
  if (!process.env.COUPANG_ACCESS_KEY || !process.env.COUPANG_SECRET_KEY) {
    console.error('환경변수 COUPANG_ACCESS_KEY / COUPANG_SECRET_KEY가 없습니다. 키를 채팅이나 로그에 붙여넣지 마세요.');
    process.exitCode = 2;
    return;
  }
  if (process.env.COUPANG_API_HOST
      && new URL(process.env.COUPANG_API_HOST).hostname !== 'api-gateway.coupang.com') {
    console.error('실제 진단은 공식 API 호스트에서만 수행합니다. COUPANG_API_HOST를 제거하세요.');
    process.exitCode = 2;
    return;
  }
  console.log('[coupang-subid] 채널 SEOSA2026, 검색 1회, 캐시/상품 저장 없음, 재시도 없음');
  const r = await searchCoupang('에어팟 프로 3', {
    source: 'diag',
    subId,
    useCache: false,
    forceRefresh: false,
    limit: 1,
    maxWaitMs: 0
  });
  const item = r.items && r.items[0];
  const affiliate = item && item.link ? classifyCoupang(item.link) : { ok: false, kind: 'missing' };
  let linkHost = '', linkPath = '', hasExplicitSubId = false;
  if (item && item.link) {
    try {
      const u = new URL(item.link);
      linkHost = u.hostname;
      linkPath = u.pathname;
      hasExplicitSubId = [...u.searchParams.keys()].some(k => k.toLowerCase() === 'subid');
    } catch (_) { /* malformed response is reflected in affiliate.kind */ }
  }
  console.log(JSON.stringify({
    channelRequested: subId,
    from: r.from,
    error: r.error || null,
    blocked: !!r.blocked,
    apiCalled: !!r.apiCalled,
    itemCount: (r.items || []).length,
    firstProductId: item ? item.productId : null,
    partnerLinkValid: affiliate.ok,
    partnerLinkKind: affiliate.kind,
    linkHost,
    linkPath,
    linkContainsExplicitSubId: hasExplicitSubId
  }, null, 2));
  console.log('주의: 응답 링크에 SUBID가 안 보일 수 있습니다. 쿠팡 파트너스 채널별 실적 리포트에서 실제 귀속 확인이 필요합니다.');
  if (r.from !== 'api' || !item || !affiliate.ok) process.exitCode = 1;
})().catch(e => {
  console.error('[coupang-subid] 진단 실패:', e && e.message);
  process.exitCode = 1;
});
