/*
 * 일일 수집 크론 + 쿠팡 진단.
 *
 * 진단이 여기 같이 있는 이유: Vercel Hobby 플랜은 서버리스 함수를 12개까지만
 * 허용한다. 이미 12개라 /api/auth 를 추가하려면 한 자리를 비워야 했고,
 * CRON_SECRET 으로 보호되는 관리자 엔드포인트 둘을 합치는 것이 사용자 영향이
 * 가장 적었다. 기능은 그대로 있고 주소만 바뀌었다.
 *
 *   수집 실행:  curl -H "Authorization: Bearer $CRON_SECRET" https://<site>/api/cron
 *   상태 진단:  curl -H "Authorization: Bearer $CRON_SECRET" "https://<site>/api/cron?diag=1"
 *   실호출 진단: curl -H "Authorization: Bearer $CRON_SECRET" "https://<site>/api/cron?diag=1&live=1&keyword=마우스"
 *               (예전 주소: /api/coupang-diag)
 */
const supabase = require('./_supabase');
const { TODAY_PICKS, searchAll, saveProducts } = require('./_shop');
const { searchCoupang, localStats, globalUsage, pruneLog } = require('./_coupang');

// 한 번에 3개씩만 돌려서 함수 실행 시간(maxDuration 60초) 안에 끝나게 한다.
// 쿠팡 호출은 _coupang.js가 최소 간격을 두고 직렬화하므로 이 숫자만큼
// 동시에 쿠팡을 때리지는 않는다.
const CONCURRENCY = 3;

// maxDuration 60초에 걸려 통째로 죽는 것보다, 남은 키워드를 다음 실행으로
// 넘기고 여기까지의 결과를 저장하는 편이 낫다.
const TIME_BUDGET_MS = 45000;

// 쿠팡 호출 옵션.
//   forceRefresh — cron은 캐시를 새로 채우는 쪽이라 TTL을 무시하고 받아온다.
//   maxWaitMs    — 호출부에서 "남은 예산"으로 채운다. 고정값으로 두면
//                  44초 시점에 통과한 배치가 40초를 더 기다려 maxDuration을 넘긴다.
const CRON_COUPANG = { source: 'cron', forceRefresh: true };

/*
 * 저장할 상품 수. searchAll 의 기본값 6 을 10 으로 올린다.
 *
 * ★ 이 값이 하는 일을 정확히 적어 둔다 — 가격 정확도가 아니라 커버리지다.
 *
 *   api/_coupang.js 의 순서는  normalize → collapseOptions → items.slice(limit) 다
 *   (:576 → :581). 접기가 자르기보다 먼저이므로, limit 이 버리는 것은
 *   "같은 상품의 더 싼 옵션"이 아니라 서로 다른 상품이다.
 *   → 6 으로 두어도 가격이 틀려지지는 않는다. 저장되는 상품이 줄어들 뿐이다.
 *   (이 순서는 scripts/test-coupang.js 의 'collapse 가 slice 보다 먼저'
 *    케이스로 고정돼 있다. 순서가 뒤바뀌면 그 테스트가 깨진다)
 *
 *   쿠팡 호출은 어차피 FETCH_LIMIT(10)으로 나가므로 10 으로 올려도
 *   호출 횟수는 그대로다. 이미 받아온 4건을 버릴 이유가 없다.
 *   목적: 키워드당 저장 상품 수 6 → 10 (쿠팡 호출 증가 0회).
 */
const CRON_LIMIT = 10;

/**
 * 오늘 수집할 키워드.
 *
 * TODAY_PICKS 8개만 돌리고 있었는데, 그러면 '이달의 추천' 섹션이 보는
 * monthly_curation 키워드에는 상품이 한 건도 쌓이지 않는다. 실제로 8월
 * 큐레이션 키워드 8개는 products 에 0건이라 섹션이 통째로 비어 있었다.
 * (홈에 "이달의 키워드 상품을 준비 중이에요"만 뜬다)
 */
async function collectTargets() {
  const month = new Date().getMonth() + 1;
  let monthly = [];
  try {
    const { data } = await supabase
      .from('monthly_curation')
      .select('keywords')
      .eq('month', month)
      .maybeSingle();
    if (data && Array.isArray(data.keywords)) monthly = data.keywords.filter(Boolean);
  } catch (e) {
    console.warn(`[cron] 이달의 큐레이션 키워드 조회 실패(오늘의 셀렉션만 수집): ${e.message}`);
  }
  return [...new Set([...TODAY_PICKS, ...monthly])];
}

module.exports = async function handler(req, res) {
  // CRON_SECRET을 설정하면 Vercel Cron이 Authorization 헤더를 붙여 보낸다.
  //
  // 예전에는 secret이 없으면 검사를 건너뛰었는데, 그러면 이 주소를 아는 누구나
  // 8개 키워드 × 쿠팡 호출을 반복시켜 일일 쿼터를 태울 수 있었다.
  // 이제는 열지 않고 막는다(fail closed).
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[cron] CRON_SECRET 미설정 — Vercel > Settings > Environment Variables에 추가하세요.');
    return res.status(500).json({ error: 'CRON_SECRET 환경변수가 설정되지 않았습니다.' });
  }
  if (req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: '인증 실패' });
  }

  // 진단 모드 — 수집을 돌리지 않는다.
  if (req.query && req.query.diag === '1') return diagnose(req, res);

  const started = Date.now();
  const results = [];
  const targets = await collectTargets();
  let skipped = 0;

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    // 남은 시간이 곧 이번 배치가 간격 대기에 쓸 수 있는 최대치다.
    const leftMs = TIME_BUDGET_MS - (Date.now() - started);
    if (leftMs <= 0) {
      skipped = targets.length - i;
      console.warn(`[cron] 시간 예산 초과 — 남은 키워드 ${skipped}개는 다음 실행으로 넘긴다.`);
      break;
    }
    const opts = { ...CRON_COUPANG, maxWaitMs: leftMs };
    const batch = targets.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(batch.map(async keyword => {
      try {
        const { items, errors, from } = await searchAll(keyword, {
          coupangLimit: CRON_LIMIT, coupangOpts: opts
        });
        // 오래된 캐시로 응답한 경우에는 저장하지 않는다 (_shop.isRecordableSource 참고).
        const { saved, errors: saveErrors } = await saveProducts(keyword, items, { from });
        return { keyword, found: items.length, saved, from, errors: [...errors, ...saveErrors] };
      } catch (e) {
        return { keyword, found: 0, saved: 0, errors: [e.message] };
      }
    }));
    results.push(...settled);
  }

  const totalSaved = results.reduce((n, r) => n + r.saved, 0);
  const failed = results.filter(r => r.errors.length);
  const elapsedMs = Date.now() - started;
  const coupang = localStats();

  // 호출 로그가 무한히 쌓이지 않게 하루 한 번 정리한다.
  const pruned = await pruneLog(7);

  console.log(
    `[cron] 키워드 ${results.length}개(미처리 ${skipped}) / 저장 ${totalSaved}건`
    + ` / 실패 키워드 ${failed.length}개 / ${elapsedMs}ms`
    + ` / 쿠팡 호출 ${coupang.calls}회(캐시 ${coupang.cacheHits} 생략 ${coupang.denied})`
    + (coupang.blocked ? ` / 쿠팡 차단중: ${coupang.blockReason}` : '')
    + ` / 로그정리 ${pruned}행`
  );

  // 전부 실패했을 때만 5xx로 응답해 Vercel Cron 로그에 실패로 남긴다.
  res.status(results.length && failed.length === results.length ? 500 : 200).json({
    ok: !results.length || failed.length < results.length,
    totalSaved,
    skipped,
    elapsedMs,
    coupang,
    results
  });
};

/* ------------------------------------------------------------------ *
 *  쿠팡 진단 (구 /api/coupang-diag)
 *
 *  기본값은 DB에 쌓인 호출량만 읽는다 (쿠팡 API 호출 0회).
 *  ?live=1 을 명시했을 때만 실제로 한 번 호출한다 — 그마저도 리미터와
 *  차단 상태를 그대로 따른다.
 * ------------------------------------------------------------------ */
async function diagnose(req, res) {
  const out = {
    env: {
      COUPANG_ACCESS_KEY: process.env.COUPANG_ACCESS_KEY ? `설정됨(${process.env.COUPANG_ACCESS_KEY.length}자)` : '없음',
      COUPANG_SECRET_KEY: process.env.COUPANG_SECRET_KEY ? `설정됨(${process.env.COUPANG_SECRET_KEY.length}자)` : '없음',
      RESEND_API_KEY:     process.env.RESEND_API_KEY     ? '설정됨' : '없음 (인증코드 메일 발송 불가)'
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

  if (req.query.live === '1') {
    const keyword = String(req.query.keyword || '마우스').slice(0, 80);
    const r = await searchCoupang(keyword, {
      limit: 5, source: 'diag', maxWaitMs: 5000, useCache: false
    });
    out.live = {
      keyword,
      from: r.from,          // api / none / stale-cache
      blocked: r.blocked,
      // error 에는 쿠팡이 실제로 내려준 본문 앞부분이 들어 있다.
      // 2026-08 에 "HTTP 200 + Sorry! Access denied HTML" 을 받은 적이 있는데,
      // 이 값을 보지 못하면 단순 파싱 실패와 구분할 수 없다.
      error: r.error,
      itemCount: r.items.length,
      firstProduct: r.items[0]
        ? { productId: r.items[0].productId, title: r.items[0].title.slice(0, 60) }
        : null
    };
    out.해석 = r.from === 'api'
      ? '정상 — 쿠팡 API 응답을 받았습니다.'
      : /차단|denied|Access/i.test(String(r.error))
        ? '쿠팡이 요청을 거부했습니다. IP 또는 계정 차단일 수 있습니다. partners.coupang.com 에서 이용 상태를 확인하세요.'
        : '호출이 나가지 않았거나 캐시로 응답했습니다. instance/global 수치를 함께 보세요.';
  } else {
    out.live = '생략됨 — 실제 호출을 하려면 &live=1 을 붙이세요 (쿠팡 API 1회 소모)';
  }

  res.json(out);
}
