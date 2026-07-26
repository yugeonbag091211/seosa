const { TODAY_PICKS, searchAll, saveProducts } = require('./_shop');

// 한 번에 3개씩만 돌려서 함수 실행 시간(maxDuration 60초) 안에 끝나게 한다.
const CONCURRENCY = 3;

module.exports = async function handler(req, res) {
  // CRON_SECRET을 설정해두면 Vercel Cron이 Authorization 헤더를 붙여 보낸다.
  // 설정하지 않았다면 검사를 건너뛴다.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: '인증 실패' });
  }

  const started = Date.now();
  const results = [];

  for (let i = 0; i < TODAY_PICKS.length; i += CONCURRENCY) {
    const batch = TODAY_PICKS.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(batch.map(async keyword => {
      try {
        const { items, errors } = await searchAll(keyword);
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

  console.log(`[cron] 저장 ${totalSaved}건 / 실패 키워드 ${failed.length}개 / ${elapsedMs}ms`);

  // 전부 실패했을 때만 5xx로 응답해 Vercel Cron 로그에 실패로 남긴다.
  res.status(failed.length === results.length ? 500 : 200).json({
    ok: failed.length < results.length,
    totalSaved,
    elapsedMs,
    results
  });
};
