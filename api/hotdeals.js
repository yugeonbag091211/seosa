'use strict';
/*
 * GET /api/hotdeals        검증된 핫딜 목록
 * GET /api/hotdeals?id=..  핫딜 하나 + 판정 근거
 *
 * ── 지키는 선 ──────────────────────────────────────────────────────
 *
 *   · 목록은 가볍게. 가격 이력 전체를 목록에 싣지 않는다 — 상세에서
 *     기존 /api/history 를 그대로 쓴다(그래프 코드가 이미 그것을 읽는다).
 *   · REJECTED 와 NORMAL 은 노출하지 않는다. 사용자가 볼 이유가 없다.
 *   · 상품명·이미지·링크는 판매자 문자열이다. 여기서는 값만 넘기고 escape 는
 *     프론트가 한다(Fmt.esc / Fmt.safeUrl) — 기존 카드와 같은 규칙이다.
 *   · 읽기 전용. 이 엔드포인트는 아무것도 쓰지 않는다.
 */

const supabase = require('./_supabase');
const { applyCors, cachePublic, fail } = require('./_http');
const { guard } = require('./_ratelimit');

/** 사용자에게 보여줄 상태. NORMAL·REJECTED 는 목록에 오르지 않는다. */
const VISIBLE = ['VERIFIED_HOT', 'GOOD_DEAL', 'POTENTIAL_DEAL'];
/** 만료된 딜은 보여주지 않는다. */
const VISIBLE_LIFECYCLE = ['NEW', 'ACTIVE', 'COOLING'];

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

const SORTS = {
  score: { col: 'hot_score', asc: false },
  recent: { col: 'detected_at', asc: false },
  price: { col: 'current_price', asc: true }
};

function intParam(v, fallback, min, max) {
  const n = parseInt(String(v == null ? '' : v), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** 목록용 최소 형태. 근거는 한 줄만 — 나머지는 상세에서 준다. */
function toListItem(r) {
  const reasons = Array.isArray(r.reason_json) ? r.reason_json : [];
  return {
    id: r.id,
    status: r.deal_status,
    // 점수는 근거가 충분할 때만 내보낸다. LOW confidence 에서 숫자를 보여주면
    // 사용자는 그 숫자를 믿는다 — 우리가 아직 못 믿는 값을.
    score: (r.confidence === 'HIGH' || r.confidence === 'MEDIUM') ? r.hot_score : null,
    title: r.title,
    image: r.image,
    mall: r.mall,
    price: r.current_price,
    // 쇼핑몰 표시 정가. 참고용이며 우리 판정 근거가 아니다.
    listPrice: r.source_reference_price || 0,
    reason: reasons.length ? String(reasons[0].text || '') : '',
    productId: r.product_id || '',
    url: r.affiliate_url || '',
    checkedAt: r.last_checked_at
  };
}

module.exports = async function handler(req, res) {
  if (!applyCors(req, res, 'public')) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET만 지원' });
  if (!guard(req, res, { name: 'hotdeals', limit: 60, windowMs: 60 * 1000 })) return;

  const q = req.query || {};

  try {
    /* ── 상세 ── */
    if (q.id) {
      const id = intParam(q.id, 0, 1, Number.MAX_SAFE_INTEGER);
      if (!id) return res.status(400).json({ error: '잘못된 id' });

      const { data, error } = await supabase
        .from('hotdeals')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data || VISIBLE.indexOf(data.deal_status) < 0
        || VISIBLE_LIFECYCLE.indexOf(data.lifecycle) < 0) {
        return res.status(404).json({ error: '핫딜을 찾을 수 없어요' });
      }

      cachePublic(res, 60);
      return res.json({
        deal: Object.assign(toListItem(data), {
          reasons: Array.isArray(data.reason_json) ? data.reason_json : [],
          confidence: data.confidence,
          identityConfidence: data.identity_confidence,
          lifecycle: data.lifecycle,
          detectedAt: data.detected_at,
          // 사용자에게 "얼마나 확인했는지"를 말할 재료. 내부 점수는 넘기지 않는다.
          observations: data.observation_count,
          spanDays: data.observation_span_days,
          median30: data.median_30d,
          observedLow: data.observed_low,
          vendorItemId: data.vendor_item_id || ''
        })
      });
    }

    /* ── 목록 ── */
    const limit = intParam(q.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = intParam(q.cursor, 0, 0, 10000);
    const sort = SORTS[String(q.sort || 'score')] || SORTS.score;

    let statuses = VISIBLE;
    if (q.status) {
      const want = String(q.status).split(',').map(s => s.trim().toUpperCase())
        .filter(s => VISIBLE.indexOf(s) > -1);
      if (want.length) statuses = want;
    }

    let query = supabase
      .from('hotdeals')
      .select('id, deal_status, hot_score, confidence, title, image, mall, current_price,'
        + ' source_reference_price, reason_json, product_id, affiliate_url, last_checked_at')
      .in('deal_status', statuses)
      .in('lifecycle', VISIBLE_LIFECYCLE);

    if (q.mall) query = query.eq('mall', String(q.mall).slice(0, 40));

    const { data, error } = await query
      .order(sort.col, { ascending: sort.asc })
      .order('id', { ascending: true })
      .range(offset, offset + limit - 1);
    if (error) throw new Error(error.message);

    const items = (data || []).map(toListItem);

    // 목록은 자주 바뀌지 않는다 — 수집기가 도는 주기가 시간 단위다.
    cachePublic(res, 120);
    return res.json({
      items,
      nextCursor: items.length === limit ? offset + limit : null,
      // 화면이 "아직 검증된 핫딜이 없습니다"와 "가능성 있는 딜만 있습니다"를
      // 구분해서 말할 수 있게 갈래별 개수를 준다.
      counts: items.reduce((acc, it) => { acc[it.status] = (acc[it.status] || 0) + 1; return acc; }, {})
    });
  } catch (e) {
    // 표가 아직 없으면(마이그레이션 전) 빈 목록으로 답한다 — 화면이 죽지 않는다.
    if (/relation .*hotdeals.* does not exist|schema cache/i.test(e.message || '')) {
      console.warn('[hotdeals] hotdeals 표 없음 — supabase/2026-09-06-hotdeals.sql 을 실행하세요.');
      cachePublic(res, 30);
      return res.json({ items: [], nextCursor: null, counts: {}, pending: true });
    }
    return fail(res, e, { where: 'hotdeals', route: '/api/hotdeals', message: '핫딜을 불러오지 못했어요' });
  }
};
