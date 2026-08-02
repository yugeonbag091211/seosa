const { searchCoupang, localStats, globalUsage } = require('./_coupang');

/*
 * 쿠팡 API 상태 / 호출량 진단.
 *
 * 예전에는 인증도 레이트리밋도 없이 요청마다 쿠팡 검색 API를 한 번씩 때렸다.
 * 주소만 알면 누구나(혹은 크롤러가) 분당 제한을 태울 수 있었다.
 * 이제는
 *   - CRON_SECRET 인증을 요구하고
 *   - 기본값은 DB에 쌓인 호출량만 읽는다 (쿠팡 API 호출 0회)
 *   - ?live=1 을 명시했을 때만 실제로 한 번 호출한다 (그마저도 리미터를 통과해야 함)
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://<site>/api/coupang-diag
 *   curl -H "Authorization: Bearer $CRON_SECRET" "https://<site>/api/coupang-diag?live=1&keyword=마우스"
 */
module.exports = async function handler(req, res) {
  // 진단 결과에는 차단 사유·호출량이 담긴다. 공개 CORS를 붙이지 않는다.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(500).json({ error: 'CRON_SECRET 환경변수가 설정되지 않았습니다.' });
  }
  if (req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: '인증 실패' });
  }

  const out = {
    env: {
      COUPANG_ACCESS_KEY: process.env.COUPANG_ACCESS_KEY ? `설정됨(${process.env.COUPANG_ACCESS_KEY.length}자)` : '없음',
      COUPANG_SECRET_KEY: process.env.COUPANG_SECRET_KEY ? `설정됨(${process.env.COUPANG_SECRET_KEY.length}자)` : '없음'
    },
    // 이 인스턴스 기준
    instance: localStats(),
    // 모든 인스턴스 + GitHub Actions 합계 (coupang_api_calls 테이블)
    global: await globalUsage(),
    limits: {
      공식_검색API: '1분당 50회',
      공식_전체API: '1분당 100회',
      자체_상한: `1분당 ${localStats().maxPerMin}회`
    }
  };

  // 실제 호출은 명시적으로 요청했을 때만. 리미터·차단 상태를 그대로 따른다.
  if (req.query && req.query.live === '1') {
    const keyword = String((req.query.keyword || '마우스')).slice(0, 80);
    const r = await searchCoupang(keyword, {
      limit: 5, source: 'diag', maxWaitMs: 5000, useCache: false
    });
    out.live = {
      keyword,
      from: r.from,          // api / none / stale-cache
      blocked: r.blocked,
      error: r.error,
      itemCount: r.items.length,
      firstProduct: r.items[0]
        ? { productId: r.items[0].productId, title: r.items[0].title.slice(0, 60) }
        : null
    };
  } else {
    out.live = '생략됨 — 실제 호출을 하려면 ?live=1 을 붙이세요 (쿠팡 API 1회 소모)';
  }

  res.json(out);
};
