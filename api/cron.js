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
const { qualitySnapshot } = require('./_quality');
// 달력 월은 KST 기준이다. 이 크론은 KST 03:00 에 도는데, 그 시각의 UTC 는
// 매월 1일이면 아직 전달이다 (_kst.kstMonth 주석 참고).
const { kstMonth } = require('./_kst');
// PRO 자동결제 갱신. 새 엔드포인트를 만들 자리가 없어(Hobby 12개 상한) 여기 얹는다.
const billing = require('./_billing');
// 진단용. 키 값은 절대 읽지 않고 keySummary()(환경/유형만) 로만 쓴다.
const toss = require('./_toss');

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
// ADPICK도 같은 이유로 캐시 TTL을 무시하고 매일 새로 받아온다 — 그래야
// isRefreshableMall('ADPICK')이 라이브로 인정하는 최신성을 유지한다.
const CRON_ADPICK = { source: 'cron', forceRefresh: true };

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
/*
 * 수요 키워드 시딩 (2026-09-02 감사).
 *
 * 카탈로그는 큐레이션 키워드(여름 생활용품)로 채워졌는데 사용자가 실제로
 * 치는 검색어는 전자기기(무선 이어폰·노트북·마우스·키보드·아이폰)다.
 * 그 키워드의 상품은 사용자가 검색하는 순간에만 저장되고, 그 뒤로는 일일
 * 수집기가 "이미 저장된 상품"만 되찾으므로 가격 기록이 얕게 남는다.
 *
 * 상위 검색어 몇 개를 매일 한 번씩 새로 받아 두면 홈 셀렉션·가격 기록이
 * 수요 쪽으로 자란다. 호출은 키워드당 쿠팡 1회 + ADPICK 1회 — 하루 최대
 * DEMAND_SEED_MAX(6)종이라 비용 증가는 무시할 수준이다.
 *
 * search_stats 는 사람이 친 말이라 소음이 섞인다(오타·내부 점검용 문자열).
 * api/_search.isValidSuggestion 으로 거른다 — 홈 칩과 같은 기준이다.
 */
const DEMAND_SEED_MAX = Number(process.env.CRON_DEMAND_SEED_MAX) || 6;

async function demandKeywords() {
  try {
    const { isValidSuggestion } = require('./_search');
    const { data } = await supabase
      .from('search_stats')
      .select('keyword, count')
      .order('count', { ascending: false })
      .limit(30);
    return (data || [])
      .map(r => r && r.keyword)
      .filter(k => k && isValidSuggestion(k))
      .slice(0, DEMAND_SEED_MAX);
  } catch (e) {
    console.warn(`[cron] 수요 키워드 조회 실패(큐레이션만 수집): ${e.message}`);
    return [];
  }
}

async function collectTargets() {
  const month = kstMonth();
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
  const demand = await demandKeywords();
  // 순서가 곧 우선순위다 — 시간 예산이 모자라면 뒤쪽(수요 시딩)이 다음 실행으로 밀린다.
  return [...new Set([...monthly, ...TODAY_PICKS, ...demand])];
}

module.exports = Object.assign(async function handler(req, res) {
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

  /*
   * ★ 결제부터 처리한다 — 상품 수집보다 먼저.
   *
   * 예전에는 수집 루프가 먼저였다. 그런데 그 루프는 TIME_BUDGET_MS(45초)를
   * 다 쓸 때까지 도는데 함수 상한(vercel.json maxDuration)은 60초다. 즉
   * 갱신·미결정리에 남는 시간이 최악 15초뿐이고, chargeBilling 은 혼자
   * 최대 60초(_toss.CHARGE_TIMEOUT_MS)까지 걸릴 수 있다. 그러면 갱신
   * 대상이 몇 건만 있어도 뒤쪽이 통째로 잘려 그날 청구가 나가지 않는다.
   *
   * 우선순위를 뒤집는 것이 맞다.
   *   · 수집이 밀리면 — 다음 실행(KST 03시·06시)과 GitHub Actions 수집기가
   *     같은 일을 다시 한다. 루프에 이미 skipped 처리가 있다.
   *   · 청구가 밀리면 — 돈이 걸린다. 되돌리기가 비싸다.
   *
   * started 를 위에 두었으므로 수집 루프의 leftMs 는 "결제가 쓰고 남은 시간"
   * 으로 자동 계산된다. 예산이 바닥나면 루프가 알아서 다음 실행으로 넘긴다.
   */

  /*
   * PRO 자동결제 갱신.
   *
   * ★ 왜 여기 있는가 — Vercel Hobby 는 서버리스 함수 12개가 상한이고 이미
   *   11개다. 갱신은 하루 한 번이면 충분하므로, CRON_SECRET 뒤에서 매일 도는
   *   이 함수에 얹는다. 새 엔드포인트를 만들면 배포가 상한에 걸린다.
   *
   * 갱신이 실패해도 수집을 막지 않는다 — 서로 무관한 일이다.
   */
  let renewal = { attempted: 0, renewed: 0, failed: 0, gaveUp: 0 };
  try {
    renewal = await billing.renewDueSubscriptions();
  } catch (e) {
    console.error(`[cron] 구독 갱신 중 오류(수집 결과에는 영향 없음): ${e.message}`);
    renewal = { attempted: 0, renewed: 0, failed: 0, gaveUp: 0, error: e.message };
  }
  if (renewal.error) {
    /*
     * 조용히 넘기지 않는다. 마이그레이션(2026-08-24-...) 전이면 여기서
     * subscriptions.renew_failures 컬럼이 없어 매일 실패한다 — 로그가 없으면
     * 자동결제가 한 번도 안 돌고 있다는 것을 아무도 모른다.
     */
    console.error(`[cron] 구독 갱신을 돌리지 못했습니다: ${renewal.error}`);
  } else if (renewal.attempted) {
    console.log(`[cron] 구독 갱신 ${renewal.renewed}/${renewal.attempted}건 성공`
      + ` (실패 ${renewal.failed}, 포기 ${renewal.gaveUp})`);
  }

  /*
   * 신규 가입 결제 중 confirm 이 maxDuration(60초)에 잘려 charging 으로 멈춘
   * 주문을 정리한다. renewOne 과 달리 갱신 스케줄과 무관하게 발생할 수 있어
   * (billing.sweepStalePayments 주석 참고) 별도로 돌린다. 갱신과 마찬가지로
   * 수집 결과에는 영향을 주지 않는다.
   */
  let staleSweep = { checkedCharging: 0, checkedPending: 0, paid: 0, failed: 0, unresolved: 0, expiredPending: 0 };
  try {
    staleSweep = await billing.sweepStalePayments();
  } catch (e) {
    console.error(`[cron] 미결 결제 정리 중 오류(수집 결과에는 영향 없음): ${e.message}`);
    staleSweep = { ...staleSweep, error: e.message };
  }
  if (staleSweep.error) {
    console.error(`[cron] 미결 결제 정리를 돌리지 못했습니다: ${staleSweep.error}`);
  } else if (staleSweep.checkedCharging || staleSweep.checkedPending) {
    console.log(`[cron] 미결 결제 정리 — charging ${staleSweep.checkedCharging}건 확인`
      + ` (복구 ${staleSweep.paid}, 실패확정 ${staleSweep.failed}, 보류 ${staleSweep.unresolved})`
      + ` / 방치된 pending ${staleSweep.expiredPending}건 만료`);
  }

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
    const adpickOpts = { ...CRON_ADPICK, maxWaitMs: leftMs };
    const batch = targets.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(batch.map(async keyword => {
      try {
        const { items, allItems, errors, from } = await searchAll(keyword, {
          coupangLimit: CRON_LIMIT, coupangOpts: opts,
          adpickLimit: CRON_LIMIT, adpickOpts
        });
        const { saved, errors: saveErrors } = await saveProducts(keyword, allItems || items, { from, source: 'cron' });
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
    renewal,
    staleSweep,
    results
  });
}, { collectTargets, demandKeywords });

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
      // 길이만 적는다 — 값의 일부라도 로그/응답에 남기지 않는다.
      COUPANG_ACCESS_KEY: process.env.COUPANG_ACCESS_KEY ? `설정됨(${process.env.COUPANG_ACCESS_KEY.length}자)` : '없음',
      COUPANG_SECRET_KEY: process.env.COUPANG_SECRET_KEY ? `설정됨(${process.env.COUPANG_SECRET_KEY.length}자)` : '없음',
      /*
       * ★ 없으면 로그인 자체가 안 된다 — 인증코드 메일이 나가지 않으므로
       *   AI·위시리스트·결제까지 전부 막힌다. 출시 전 필수.
       */
      RESEND_API_KEY:     process.env.RESEND_API_KEY     ? '설정됨' : '★없음 (인증코드 메일 발송 불가 → 로그인 불가)',
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ? '설정됨' : '★없음 (AI Concierge 불가)',
      SUPABASE_URL:       process.env.SUPABASE_URL       ? '설정됨' : '★없음',
      SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY ? '설정됨' : '★없음',
      CRON_SECRET:        process.env.CRON_SECRET        ? '설정됨' : '없음',
      // 없으면 _auth 가 SUPABASE_SECRET_KEY 에서 파생한다 (동작은 한다).
      AUTH_SECRET:        process.env.AUTH_SECRET        ? '설정됨' : '없음 (SUPABASE_SECRET_KEY 에서 파생)'
    },
    /*
     * 결제 키 진단 — 값이 아니라 "환경(test/live)"과 "유형(api/widget)"만.
     *
     * 과거 사고 두 건이 여기서 잡힌다.
     *   kind=widget  → 프론트 tp.payment() 가 거부한다 (PRO 결제가 시작조차 안 됨).
     *                  Toss 콘솔 "결제 > API 개별 연동" 의 ck/sk 키로 바꿔야 한다.
     *   env 불일치   → test/live 혼용. 실청구가 테스트로 오인되거나 그 반대.
     */
    toss: (() => {
      const s = toss.keySummary();
      const problems = [];
      if (!toss.isConfigured()) problems.push('★ 키 미설정 — PRO 결제가 열리지 않습니다');
      if (toss.isWidgetClientKey()) problems.push('★ TOSS_CLIENT_KEY 가 결제위젯 유형(gck) — API 개별 연동 키(ck)로 교체하세요');
      if (toss.isWidgetSecretKey()) problems.push('★ TOSS_SECRET_KEY 가 결제위젯 유형(gsk) — API 개별 연동 키(sk)로 교체하세요');
      if (toss.isMixedKeyEnv()) problems.push('★ client/secret 환경 불일치 (test+live 혼용)');
      if (toss.isConfigured() && toss.isTestKey()) problems.push('테스트 키입니다 — 실제 정산이 되지 않습니다');
      return { client: s.client, secret: s.secret, 문제: problems.length ? problems : ['없음'] };
    })(),
    /*
     * AI Cost Guard (2026-09-02). "유료 비용 0원" 을 주장하려면 볼 수 있어야 한다.
     * zeroCost:false 이면 이 인스턴스에서 유료 호출이 실제로 나간 것이다.
     */
    ai: (() => {
      try {
        const s = require('./_llm').stats();
        return Object.assign({}, s, {
          문제: s.zeroCost
            ? (s.allowPaid ? ['OPENROUTER_ALLOW_PAID=1 — 유료 호출이 허용된 상태입니다'] : ['없음'])
            : [`★ 유료 모델 호출 ${s.paidCalls}회 — zero-cost 정책이 깨졌습니다`]
        });
      } catch (e) { return { error: e.message }; }
    })(),
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

  /*
   * 데이터 품질 지표.
   *
   * 기본으로 포함한다 — 진단을 볼 때 가장 알고 싶은 것이 "지금 데이터가
   * 멀쩡한가"이기 때문이다. DB 를 몇 천 행 읽으므로 필요 없으면 &quality=0.
   *
   * 이 엔드포인트 전체가 CRON_SECRET 뒤에 있다. 여기 있는 수치(상품 수·
   * 수집 실패·API 성공률)는 운영 정보라 공개 엔드포인트로 나가면 안 된다.
   */
  if (req.query.quality !== '0') {
    out.데이터품질 = await qualitySnapshot();
  }

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
