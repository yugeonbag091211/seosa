'use strict';
/*
 * GET /api/timing — ① 구매 타이밍 (docs/seosa2/CONTRACTS.md §3 ①).
 *
 *   /api/timing?productId=..&mall=..&vendorItemId=..&horizon=7|14|30
 *
 * 새 서버리스 함수가 아니다 — api/history.js 첫 줄의 v2 훅이 이리로 넘긴다
 * (api/_v2router.js). 계산은 전부 api/_timing.js 의 순수 함수가 하고, 여기서는
 * 읽고(_series) 넘기고 돌려줄 뿐이다.
 *
 * ★ 읽기 전용. price_history · products 를 한 번씩 읽는다. 어떤 표에도 쓰지 않는다.
 * ★ 외부 API 를 부르지 않는다 — 이미 쌓인 기록만 쓴다.
 */

const { applyCors, cachePublic, fail } = require('./_http');
const { guard } = require('./_ratelimit');
const { kstToday } = require('./_kst');
const { loadSeries, readKey, productSummary } = require('./_series');
const timing = require('./_timing');

/** 백테스트가 볼 기록 창. 1년이면 계절 행사 한 바퀴를 본다. */
const SERIES_DAYS = 365;

async function handler(req, res) {
  if (!applyCors(req, res, 'public')) return;
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET만 지원해요', code: 'METHOD' });
  if (!guard(req, res, { name: 'v2-timing', limit: 60, windowMs: 60 * 1000 })) return;

  const q = req.query || {};
  const key = readKey(q);
  if (!key) return res.status(400).json({ ok: false, error: '상품 식별자가 필요해요', code: 'BAD_INPUT' });

  let horizon = timing.DEFAULT_HORIZON;
  if (q.horizon !== undefined && q.horizon !== '') {
    horizon = Number(q.horizon);
    if (timing.HORIZONS.indexOf(horizon) === -1) {
      return res.status(400).json({ ok: false, error: `기간은 ${timing.HORIZONS.join('·')}일 중에서 골라 주세요`, code: 'BAD_INPUT' });
    }
  }

  try {
    const series = await loadSeries(key, { days: SERIES_DAYS });
    const today = kstToday();
    const result = timing.analyze(series.points, { today, horizon, product: series.product });
    // 가격 기록은 하루 한 번 늘어난다 — 짧게 캐시해도 사용자가 보는 값은 같다.
    cachePublic(res, 300);
    return res.json(Object.assign(
      { ok: true, asOf: today, product: productSummary(key, series) },
      result,
      { points: series.points, truncated: series.truncated }
    ));
  } catch (e) {
    return fail(res, e, { where: 'v2-timing', route: '/api/timing', message: '구매 타이밍을 계산하지 못했어요.' });
  }
}

module.exports = { handler, SERIES_DAYS };
