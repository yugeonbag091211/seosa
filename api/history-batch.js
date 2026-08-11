const supabase = require('./_supabase');
const { applyCors, cachePublic, readStringList } = require('./_http');
const { guard } = require('./_ratelimit');

const MAX_TITLES = 100;
const MAX_KEYS   = 100;
// 잘릴 경우 오래된 쪽이 버려지도록 최신순으로 가져온다 (history.js와 같은 이유).
const MAX_ROWS = 10000;
const MAX_DAYS = 365;

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
  // 프론트는 productId + '|' + mall 로 만든다. 몰 이름에는 '|'가 들어가지 않지만
  // 옛 행의 product_id 에는 상품명이 그대로 들어간 것이 있어서 뒤에서부터 자른다.
  const s = String(key);
  const i = s.lastIndexOf('|');
  if (i < 0) return { productId: s, mall: '' };
  return { productId: s.slice(0, i), mall: s.slice(i + 1) };
}

/** Map<날짜, 최저가> → [{date, price}] 오름차순, 최근 maxDays 일만 */
function toPoints(byDate) {
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, price]) => ({ date, price }))
    .slice(-MAX_DAYS);
}

/** 같은 날짜에 여러 행이 있으면 최저가 한 점만 남긴다. */
function keepLowest(byDate, date, price) {
  const cur = byDate.get(date);
  if (cur === undefined || price < cur) byDate.set(date, price);
}

module.exports = async function handler(req, res) {
  if (!applyCors(req, res, 'public')) return;

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
      const wanted = new Set(keys);
      const productIds = [...new Set(keys.map(k => splitKey(k).productId))].filter(Boolean);

      if (productIds.length) {
        const { data, error } = await supabase
          .from('price_history')
          .select('product_id, mall, recorded_date, price')
          .in('product_id', productIds)
          .order('recorded_date', { ascending: false })
          .limit(MAX_ROWS);
        if (error) throw new Error(error.message);

        const byKey = new Map();
        (data || []).forEach(r => {
          const k = `${r.product_id}|${r.mall}`;
          if (!wanted.has(k)) return;   // 같은 product_id의 다른 몰 행은 섞지 않는다
          if (!byKey.has(k)) byKey.set(k, new Map());
          keepLowest(byKey.get(k), r.recorded_date, r.price);
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
};
