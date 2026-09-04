const supabase = require('./_supabase');
const { applyCors, cachePublic, readStringList } = require('./_http');
const { guard } = require('./_ratelimit');
const { observedKstDate } = require('./_price');

/*
 * 차트의 가로축 날짜는 KST 달력으로 찍는다.
 *
 * recorded_date 라벨을 그대로 쓰면 안 된다 — 운영 DB 가 그 값을 recorded_at 의
 * UTC 날짜로 덮어쓰기 때문이다(api/_price.js kstToday 주석의 실측 참고).
 * 수집 크론이 KST 01·03·06시에 도는 탓에 그날 수집분이 통째로 '어제' 라벨을
 * 달고, 차트의 가장 최근 점이 하루 이른 날짜로 찍힌다.
 *
 * 그러면 홈의 "오늘의 가격 하락" 카드(= KST 기준으로 판정한다)와 그 상품을
 * 눌러서 여는 가격 이력 차트가 서로 다른 날을 가리킨다. 같은 화면 안에서
 * 두 숫자가 어긋나면 어느 쪽도 믿을 수 없게 된다.
 *
 * observedKstDate 는 절대 시각 recorded_at 을 KST 로 환산하고, 그 값이 없을
 * 때만 라벨로 폴백한다 — 라벨을 어느 시간대로 자르든 답이 같다.
 */

/*
 * ── history + history-batch 통합 ────────────────────────────────
 *
 * Vercel Hobby 플랜의 Serverless Function 12개 제한을 넘겨(13개) 배포가
 * 실패해서, 원래 별도 파일이던 history-batch.js를 이 파일로 흡수했다.
 * 로직은 옮기기만 했고 한 줄도 바꾸지 않았다.
 *
 * URL은 둘 다 그대로 유지된다 — vercel.json의 rewrite가
 *   /api/history-batch  →  /api/history?__route=batch
 * 로 보내고, 아래 handler가 __route로 두 로직을 나눠 부른다.
 * (쿼리스트링 자체는 원래 요청 것이 그대로 전달되고, __route만 rewrite가 덧붙인다)
 */

// ── 단건 조회 (기존 history.js) ─────────────────────────────────
// 하루에 여러 몰의 행이 쌓이므로 "행 수"와 "일 수"는 다르다.
// 넉넉히 최신순으로 가져온 뒤 날짜 단위로 접고, 마지막에 일 수로 자른다.
const SINGLE_MAX_ROWS = 3000;
const SINGLE_MAX_DAYS = 365;

/** [{recorded_date, recorded_at, price}] → KST 날짜당 최저가 한 점, 오름차순 */
function collapseToDaily(rows, maxDays) {
  const byDate = new Map();
  (rows || []).forEach(r => {
    const date = observedKstDate(r);
    if (!date) return;
    const cur = byDate.get(date);
    if (cur === undefined || r.price < cur) byDate.set(date, r.price);
  });

  const points = [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, price]) => ({ date, price }));

  return maxDays ? points.slice(-maxDays) : points;
}

/** 구매 시점 판정을 함께 달라고 했는가 (?deal=1). */
function wantDeal(q) {
  return String((q && q.deal) || '') === '1';
}

/**
 * 판정 결과에서 화면이 쓸 것만 골라 내보낸다.
 *
 * evidence 를 통째로 보내지 않는 이유는 두 가지다. 하나는 화면이 안 쓰는
 * 값을 실어 보낼 이유가 없다는 것이고, 다른 하나는 여기서 나가는 값이
 * 그대로 사용자에게 보이는 문장이 되기 때문에 무엇이 나가는지 한눈에
 * 보이는 편이 안전하다는 것이다.
 *
 * ★ 판정·근거·주의는 전부 서버에서 만든 문자열 그대로다. 화면이 다시
 *   계산하거나 말을 바꾸지 않는다.
 */
function publicDeal(d) {
  if (!d) return null;
  const e = d.evidence || {};
  return {
    verdict: d.verdict,
    label: d.label,
    score: d.score,
    percentile: d.percentile,
    freshness: {
      level: d.freshness.level,
      days: d.freshness.days,
      label: d.freshness.label,
      trusted: d.freshness.trusted
    },
    reasons: d.reasons.slice(0, 4),
    cautions: d.cautions.slice(0, 3),
    anomalies: d.anomalies.map(a => a.note).slice(0, 3),
    // 화면이 문장을 만들 때 쓰는 수치. 없는 값은 0/null 그대로 나간다.
    stats: {
      low: e.low || 0, high: e.high || 0,
      avg7: e.avg7 || 0, avg30: e.avg30 || 0,
      trendPct: e.trendPct == null ? null : e.trendPct,
      trendDays: e.trendDays || 0,
      volatility: e.volatility == null ? null : e.volatility,
      historyDays: e.historyDays || 0,
      count: e.count || 0
    }
  };
}

/**
 * 오름차순 + limit으로 가져오면 가장 "오래된" 행만 남아서
 * 기록이 limit을 넘는 순간 최신 가격이 차트에서 사라진다. 반드시 최신순으로 자른다.
 */
function baseQuery() {
  return supabase
    .from('price_history')
    // recorded_at 도 받는다 — 날짜는 이 값을 KST 로 환산해 찍는다(위 주석).
    .select('recorded_date, recorded_at, price')
    .order('recorded_date', { ascending: false })
    .limit(SINGLE_MAX_ROWS);
}

async function singleHandler(req, res) {
  if (!guard(req, res, { name: 'history', limit: 90, windowMs: 60 * 1000 })) return;

  const q = req.query || {};
  const title        = String(q.title || '').trim();
  const productId    = String(q.productId || '').trim();
  const mall         = String(q.mall || '').trim();
  const vendorItemId = String(q.vendorItemId || '').trim();

  if (!title && !productId) return res.status(400).json({ error: '상품명 없음' });

  try {
    let rows = null;

    if (productId) {
      let query = baseQuery().eq('product_id', productId);
      if (mall) query = query.eq('mall', mall);
      if (vendorItemId) query = query.eq('vendor_item_id', vendorItemId);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      if (data && data.length) rows = data;
    }

    /*
     * 상품명 폴백은 없앴다.
     *
     * 예전에는 productId 로 0건이면 상품명으로 다시 찾았고, 그 다음에는
     * "productId 를 아예 안 보낸 경우"에만 폴백했다. 둘 다 지웠다.
     *
     * 이 응답의 마지막 점이 프론트 가격 모달의 헤드라인 가격이 되고
     * (AppState.modalPrice) 그 위에서 '지금 사도 되는지' 판정이 돌아간다.
     * 상품명으로 모은 이력은 이름이 같은 여러 상품·여러 몰의 기록을 날짜별
     * 최저가로 합친 값이라 어느 상품의 것도 아니다. 그걸 현재가로 쓰면
     * 사용자는 존재하지 않는 가격을 보고 구매를 결정한다.
     *
     * 식별자가 없으면 "기록 없음"이 정답이다. 이름으로 추측하지 않는다.
     * (productId 가 없는 옛 위시/조회기록은 빈 배열을 받아 차트가 비고,
     *  카드를 다시 열어 찜하면 productId 가 채워진 값으로 교체된다)
     */
    if (!productId) {
      cachePublic(res, 300);
      return res.json(wantDeal(q) ? { points: [], deal: null } : []);
    }

    // 프론트는 오름차순 [{date, price}] 배열을 기대한다 (sparkSVG / 차트 라벨).
    const points = collapseToDaily(rows, SINGLE_MAX_DAYS);
    cachePublic(res, 300);

    if (!wantDeal(q)) return res.json(points);

    /*
     * 구매 시점 판정을 서버에서 계산해 함께 보낸다.
     *
     * ── 왜 서버가 계산하는가 ────────────────────────────────────────
     *
     * 가격 모달은 지금까지 자기가 직접 판정을 만들어 왔다(Modal.renderVerdict —
     * 최저/평균/최고 위치로 "역대 최저가 수준"·"지금은 비싼 편"). 그런데 서버에는
     * _pricestat.assess() 와 _deal.js 가 이미 있고, AI 답변은 그 판정을 쓴다.
     *
     * 그래서 같은 상품을 두고 화면과 AI 가 다른 말을 할 수 있었다. 모달은
     * "역대 최저가 수준 · 지금이 기회" 라고 띄우는데 AI 는 "NORMAL" 이라고
     * 말하는 식이다. 사용자 입장에서는 둘 다 SEOSA 가 한 말이다.
     *
     * 판정하는 곳을 한 군데로 모은다. 계산은 여기서 하고, 화면은 받아서 그린다.
     *
     * ★ 기존 응답 모양(배열)은 그대로 둔다. deal=1 을 붙였을 때만 객체로 돌려준다 —
     *   배포 직후 캐시된 옛 프론트가 계속 배열을 기대하고 있기 때문이다.
     */
    let deal = null;
    try {
      const { statsFrom } = require('./_pricestat');
      const { dealOf } = require('./_deal');
      const { kstToday } = require('./_price');
      const stat = statsFrom(points);
      const price = points.length ? points[points.length - 1].price : 0;
      deal = publicDeal(dealOf(stat, price, kstToday()));
    } catch (e) {
      // 판정에 실패해도 가격 이력은 보내야 한다 — 차트가 비면 안 된다.
      console.warn(`[history] 구매 시점 판정 실패(이력만 보냄): ${e.message}`);
    }
    res.json({ points, deal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ── 배치 조회 (기존 history-batch.js) ───────────────────────────
const MAX_TITLES = 100;
const MAX_KEYS   = 100;
// 잘릴 경우 오래된 쪽이 버려지도록 최신순으로 가져온다 (단건 조회와 같은 이유).
const BATCH_MAX_ROWS = 10000;
const BATCH_MAX_DAYS = 365;

/**
 * 프론트가 보내는 조회 키는 두 종류다. 둘 다 지원해야 한다.
 *
 *   keys   — "<product_id>|<mall>". 상품 단위. 프론트의 histKey()가 만든다.
 *   titles — 상품명. productId가 없는 옛 위시/조회기록 전용 폴백.
 *
 * 예전에는 titles만 읽고 keys를 통째로 버렸다. 그런데 지금 프론트는
 * productId가 있는 상품(=쿠팡 상품 전부)을 keys로만 보내기 때문에,
 * 스파크라인 · 역대최저가 뱃지 · 위시 최신가 · "가격이 움직였어요" 섹션 ·
 * AI 가격 이력이 전부 빈 응답({})을 받고 조용히 사라져 있었다.
 */
function splitKey(key) {
  const s = String(key);
  const parts = s.split('|');
  if (parts.length >= 3) {
    return { productId: parts[0], mall: parts[1], vendorItemId: parts.slice(2).join('|') };
  }
  const i = s.lastIndexOf('|');
  if (i < 0) return { productId: s, mall: '', vendorItemId: '' };
  return { productId: s.slice(0, i), mall: s.slice(i + 1), vendorItemId: '' };
}

/** Map<날짜, 최저가> → [{date, price}] 오름차순, 최근 maxDays 일만 */
function toPoints(byDate) {
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, price]) => ({ date, price }))
    .slice(-BATCH_MAX_DAYS);
}

/** 같은 날짜에 여러 행이 있으면 최저가 한 점만 남긴다. */
function keepLowest(byDate, date, price) {
  const cur = byDate.get(date);
  if (cur === undefined || price < cur) byDate.set(date, price);
}

async function batchHandler(req, res) {
  // 최대 100개 키 × 10000행짜리 쿼리다. 인증이 없는 만큼 호출 빈도는 막아둔다.
  if (!guard(req, res, { name: 'history-batch', limit: 60, windowMs: 60 * 1000 })) return;

  const q = req.query || {};
  const titles = readStringList(q.titles, MAX_TITLES);
  const keys   = readStringList(q.keys,   MAX_KEYS);

  if (titles === null) return res.status(400).json({ error: 'titles 파싱 실패' });
  if (keys === null)   return res.status(400).json({ error: 'keys 파싱 실패' });

  // 조회된 것만 채우면 프론트가 map[k] === undefined로 건너뛰므로 전부 빈 배열로 초기화한다.
  // ("조회했는데 기록이 없다"와 "아직 모른다"를 프론트가 구분한다)
  const map = {};
  keys.forEach(k => { map[k] = []; });
  titles.forEach(t => { map[t] = []; });

  if (!keys.length && !titles.length) return res.json(map);

  try {
    // ── 1) 상품 단위(keys) ────────────────────────────────────────
    if (keys.length) {
      const parsed = new Map(keys.map(k => [k, splitKey(k)]));
      const productIds = [...new Set([...parsed.values()].map(p => p.productId))].filter(Boolean);

      if (productIds.length) {
        const { data, error } = await supabase
          .from('price_history')
          .select('product_id, mall, vendor_item_id, recorded_date, recorded_at, price')
          .in('product_id', productIds)
          .order('recorded_date', { ascending: false })
          .limit(BATCH_MAX_ROWS);
        if (error) throw new Error(error.message);

        const byKey = new Map();
        (data || []).forEach(r => {
          const vid = r.vendor_item_id || '';
          for (const [origKey, p] of parsed) {
            if (r.product_id !== p.productId) continue;
            if (p.mall && r.mall !== p.mall) continue;
            if (p.vendorItemId && vid !== p.vendorItemId) continue;
            if (!byKey.has(origKey)) byKey.set(origKey, new Map());
            // 단건 조회(collapseToDaily)와 같은 기준으로 KST 날짜에 접는다.
            const date = observedKstDate(r);
            if (!date) continue;
            keepLowest(byKey.get(origKey), date, r.price);
          }
        });
        byKey.forEach((byDate, k) => { map[k] = toPoints(byDate); });
      }
    }

    /*
     * ── 2) 상품명(titles) — 더 이상 조회하지 않는다 ────────────────
     *
     * 가격 이력은 상품 단위 식별자(product_id + mall)로만 연결한다.
     * 상품명으로 모으면 이름이 같은 여러 상품·여러 몰의 기록이 날짜별
     * 최저가로 합쳐져, 어느 상품의 것도 아닌 곡선이 나온다. 프론트는 그
     * 마지막 점을 위시 현재가·'역대 최저가' 뱃지·AI 판단 근거로 썼다.
     *
     * 파라미터는 계속 받는다. 배포 직후에는 옛 index.html 을 캐시해 둔
     * 브라우저가 여전히 titles 를 보내기 때문이다. 그 요청도 여기서
     * 빈 배열을 받아 "기록 없음"으로 그려지고, 틀린 이력을 보지 않는다.
     * (map 초기화에서 이미 titles 키가 빈 배열로 들어가 있다)
     */
    if (titles.length) {
      console.log(`[history-batch] 상품명 조회 ${titles.length}건 무시 — 상품 단위 식별자로만 이력을 연결합니다`);
    }

    // 가격 기록은 하루 한 번만 늘어난다. 짧게 캐시해도 사용자가 보는 값은 같다.
    cachePublic(res, 300);
    res.json(map);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ── 라우팅 ───────────────────────────────────────────────────────
/*
 * 상품 페이지 라우트 (2026-09-02).
 *
 *   /p/{pid}                → __route=page     HTML (vercel.json rewrite)
 *   /sitemap-products.xml   → __route=sitemap  XML
 *   ?__route=product&pid=   → JSON (프론트 딥링크 ?p= 가 쓴다)
 *
 * 새 서버리스 함수를 만들지 않고 이 함수에 얹었다 (Hobby 12개 상한, 11개 사용 중).
 * 구현은 api/_product-page.js 에 있다 — 이 파일은 갈래만 나눈다.
 */
module.exports = async function handler(req, res) {
  if (!applyCors(req, res, 'public')) return;

  const q = req.query || {};
  if (q.__route === 'batch') return batchHandler(req, res);
  if (q.__route === 'page' || q.__route === 'sitemap' || q.__route === 'product') {
    try {
      const page = require('./_product-page');
      if (q.__route === 'page') return await page.pageHandler(req, res);
      if (q.__route === 'sitemap') return await page.sitemapHandler(req, res);
      return await page.productHandler(req, res);
    } catch (e) {
      const { fail } = require('./_http');
      return fail(res, e, { where: 'product-page', route: `/api/history?__route=${q.__route}`, message: '상품 페이지를 불러오지 못했어요.' });
    }
  }
  return singleHandler(req, res);
};
