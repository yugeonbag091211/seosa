const { TODAY_PICKS, searchAll, saveProducts } = require('./_shop');
const { localStats, pruneLog } = require('./_coupang');

// 한 번에 3개씩만 돌려서 함수 실행 시간(maxDuration 60초) 안에 끝나게 한다.
// 쿠팡 호출은 _coupang.js가 최소 간격을 두고 직렬화하므로 이 숫자만큼
// 동시에 쿠팡을 때리지는 않는다.
const CONCURRENCY = 3;

// 쿠팡 호출 옵션.
//   forceRefresh — cron은 캐시를 새로 채우는 쪽이라 TTL을 무시하고 받아온다.
//                  키워드는 TODAY_PICKS 8개뿐이라 하루 8회로 끝난다.
//   maxWaitMs    — 사용자 요청과 달리 기다려도 되므로 간격 대기를 허용한다.
const CRON_COUPANG = { source: 'cron', forceRefresh: true, maxWaitMs: 20000 };

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

  const started = Date.now();
  const results = [];

  for (let i = 0; i < TODAY_PICKS.length; i += CONCURRENCY) {
    const batch = TODAY_PICKS.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(batch.map(async keyword => {
      try {
        const { items, errors } = await searchAll(keyword, { coupangOpts: CRON_COUPANG });
        const { saved, errors: saveErrors } = await saveProducts(keyword, items);
        return { keyword, found: items.length, saved, errors: [...errors, ...saveErrors] };
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
    `[cron] 저장 ${totalSaved}건 / 실패 키워드 ${failed.length}개 / ${elapsedMs}ms`
    + ` / 쿠팡 호출 ${coupang.calls}회(캐시 ${coupang.cacheHits} 생략 ${coupang.denied})`
    + (coupang.blocked ? ` / 쿠팡 차단중: ${coupang.blockReason}` : '')
    + ` / 로그정리 ${pruned}행`
  );

  // 전부 실패했을 때만 5xx로 응답해 Vercel Cron 로그에 실패로 남긴다.
  res.status(failed.length === results.length ? 500 : 200).json({
    ok: failed.length < results.length,
    totalSaved,
    elapsedMs,
    coupang,
    results
  });
};
