'use strict';
/*
 * ⑥ 가격 이상 패턴 — GET /api/anomaly (vercel.json → /api/history?__route=anomaly).
 *
 * 새 서버리스 함수가 아니다. api/history.js 첫 줄의 v2 라우터가 이 모듈로 넘긴다
 * (docs/seosa2/CONTRACTS.md §1). 판정은 전부 순수 함수 _anomaly.analyze 가 하고,
 * 이 파일은 읽고 → 넘기고 → 응답할 뿐이다.
 *
 * ★ 읽기 전용. _series.loadSeries 의 price_history 1회 + products 1회가 전부다.
 *   어떤 표에도 쓰지 않고, 외부 쇼핑 API·LLM 을 부르지 않는다.
 * ★ 공개 데이터라 CORS public + CDN 캐시 5분. 가격 기록은 하루 몇 번만 바뀐다.
 */

const { applyCors, cachePublic, fail } = require('./_http');
const { guard } = require('./_ratelimit');
const { loadSeries, readKey, productSummary } = require('./_series');
const { kstToday } = require('./_price');
const { analyze } = require('./_anomaly');

/** 180일 — _pricestat.WINDOW_DAYS 와 같은 창. 뻥튀기·옵션 변경을 볼 만큼 길고, 행 상한(3000) 안이다. */
const WINDOW_DAYS = 180;
/** CDN 캐시(초). 수집은 하루 몇 번이라 5분이면 충분히 새롭다. */
const CACHE_SECONDS = 300;

async function handler(req, res) {
  if (!applyCors(req, res, 'public')) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ ok: false, error: 'GET만 지원해요.', code: 'METHOD_NOT_ALLOWED' });
  }
  if (!guard(req, res, { name: 'v2-anomaly', limit: 60, windowMs: 60000 })) return;

  const key = readKey(req.query || {});
  if (!key) {
    return res.status(400).json({ ok: false, error: '상품 식별자가 필요해요', code: 'BAD_INPUT' });
  }

  try {
    const series = await loadSeries(key, { days: WINDOW_DAYS });
    const result = analyze({
      rawRows: series.rawRows,
      rows: series.rows,
      points: series.points,
      product: series.product,
      vendorItemId: series.vendorItemId,
      today: kstToday()
    });
    cachePublic(res, CACHE_SECONDS);
    return res.status(200).json(Object.assign({
      ok: true,
      asOf: new Date().toISOString(),
      product: productSummary(key, series),
      truncated: !!series.truncated
    }, result));
  } catch (e) {
    return fail(res, e, { where: 'v2-anomaly', route: '/api/anomaly', message: '가격 이상 패턴을 불러오지 못했어요.' });
  }
}

module.exports = { handler, WINDOW_DAYS, CACHE_SECONDS };
