'use strict';
/*
 * GET /api/hotdeals        검증된 핫딜 목록
 * GET /api/hotdeals?id=..  핫딜 하나 + 판정 근거 + 다른 판매처
 *
 * ── 지키는 선 ──────────────────────────────────────────────────────
 *
 *   · 목록은 가볍게. 가격 이력 전체를 목록에 싣지 않는다 — 상세에서
 *     기존 /api/history 를 그대로 쓴다(그래프 코드가 이미 그것을 읽는다).
 *   · REJECTED 와 NORMAL 은 노출하지 않는다. 사용자가 볼 이유가 없다.
 *   · 같은 상품은 한 카드다. 군집 대표(is_primary)만 목록에 오른다.
 *   · 상품명·이미지·링크는 판매자 문자열이다. 여기서는 값만 넘기고 escape 는
 *     프론트가 한다(Fmt.esc / Fmt.safeUrl) — 기존 카드와 같은 규칙이다.
 *   · 읽기 전용. 이 엔드포인트는 아무것도 쓰지 않는다.
 *   · **없는 값을 만들지 않는다.** 모르는 신호는 0 이 아니라 null 로 나간다.
 *
 * ── 계약 안정성 (프론트와의 약속) ──────────────────────────────────
 *
 * 기존 필드는 이름도 뜻도 바꾸지 않는다. 새 정보는 전부 «추가» 다.
 * 마이그레이션(2026-09-07-hotdeal-groups.sql) 전에도 죽지 않아야 하므로,
 * 새 컬럼이 없으면 조용히 기본값으로 떨어진다 — 아래 GROUP_COLS 참고.
 */

const supabase = require('./_supabase');
const { applyCors, cachePublic, fail } = require('./_http');
const { guard } = require('./_ratelimit');
const HG = require('./_hotgroup');

/** 사용자에게 보여줄 상태. NORMAL·REJECTED 는 목록에 오르지 않는다. */
const VISIBLE = ['VERIFIED_HOT', 'GOOD_DEAL', 'POTENTIAL_DEAL'];
/** 만료된 딜은 보여주지 않는다. */
const VISIBLE_LIFECYCLE = ['NEW', 'ACTIVE', 'COOLING'];

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;
/** 같은 계열이 목록에서 연달아 나올 수 있는 최대 개수. */
const MAX_FAMILY_RUN = 2;

/** 2026-09-06 판에도 있던 컬럼. 이것만으로 목록이 성립해야 한다. */
const BASE_COLS = 'id, source, source_external_id, deal_status, hot_score, confidence, identity_confidence, title, image, mall, current_price,'
  + ' source_reference_price, reason_json, product_id, affiliate_url, last_checked_at';
/** 2026-09-07 마이그레이션이 추가하는 컬럼. 없으면 BASE_COLS 로 물러난다. */
const GROUP_COLS = ', group_key, is_primary, group_size, group_lowest_price, group_lowest_mall,'
  + ' group_offers, signal_json, price_drop_percent, confidence_rank';

/**
 * 정렬.
 *
 * ── 왜 hot_score 하나로는 부족한가 ─────────────────────────────────
 *
 * 점수는 confidence 천장에 눌려 뭉친다(SCORE_CEILING: LOW 는 69 가 끝이다).
 * 그래서 동점이 흔하고, 동점에서 순서를 정하지 않으면 «근거가 얇은 쪽» 이
 * 위로 올 수 있다. 그리고 정렬이 결정론이 아니면 새로고침마다 목록이
 * 흔들려서 사용자가 방금 본 카드를 다시 찾지 못한다.
 *
 *   1) hot_score        얼마나 싼가
 *   2) confidence_rank  근거가 얼마나 두꺼운가
 *   3) last_checked_at  얼마나 최근에 확인했는가
 *   4) price_drop_percent 실제 하락폭
 *   5) id               마지막 동점 해소 — 이것이 결정론을 보장한다
 */
const TIE_BREAK = [
  ['confidence_rank', false],
  ['last_checked_at', false],
  ['price_drop_percent', false]
];

const SORTS = {
  score: { col: 'hot_score', asc: false, tie: TIE_BREAK },
  recent: { col: 'last_checked_at', asc: false, tie: [['hot_score', false], ['confidence_rank', false]] },
  price: { col: 'current_price', asc: true, tie: [['hot_score', false], ['confidence_rank', false]] },
  drop: { col: 'price_drop_percent', asc: false, tie: [['hot_score', false], ['confidence_rank', false]] }
};

function intParam(v, fallback, min, max) {
  const n = parseInt(String(v == null ? '' : v), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * ?id= 는 «양의 정수 그대로» 여야 한다.
 *
 * 예전에는 intParam(q.id, 0, 1, MAX) 였다. 그래서 ?id=0 과 ?id=-5 가 1 로
 * 접혀 «1번 핫딜» 이 조용히 돌아왔다. 사용자가 요청하지 않은 딜을 요청한
 * 것처럼 보여 주는 것이라, 잘못된 입력은 잘못됐다고 답한다.
 */
function dealId(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^\d+$/.test(s)) return 0;
  const n = parseInt(s, 10);
  return (Number.isSafeInteger(n) && n > 0) ? n : 0;
}

function isMissingColumn(msg) {
  return /column .* does not exist|could not find the .* column|schema cache/i.test(String(msg || ''));
}

/** jsonb 는 null 로 올 수 있다. 배열이 아니면 빈 배열로 본다. */
function arr(v) { return Array.isArray(v) ? v : []; }
function obj(v) { return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }

/**
 * 다른 판매처 목록.
 *
 * ★ 자기 자신은 뺀다 — "다른 곳 2군데"라고 하면서 자기를 세면 안 된다.
 *   상세는 select('*') 라 자기 키를 직접 만들 수 있고, 목록은 is_primary
 *   행만 오므로 group_key 가 곧 자기 키다. 그래도 키가 비어 있는 옛 행이
 *   있을 수 있으니 구매 링크로도 한 번 더 거른다.
 * ★ 값이 없는 오퍼도 뺀다 — 가격을 모르면 비교의 뜻이 없다.
 */
function otherOffers(row) {
  const ownKey = (row.source && row.source_external_id != null)
    ? `${row.source}|${row.source_external_id}|${row.mall || ''}`
    : (row.is_primary !== false ? String(row.group_key || '') : '');
  const mine = String(row.affiliate_url || '');
  const isSelf = o => (ownKey && String(o.key || '') === ownKey)
    || (mine && String(o.url || '') === mine);

  return arr(row.group_offers)
    .filter(o => o && Number(o.price) > 0 && !isSelf(o))
    .map(o => ({
      mall: String(o.mall || ''),
      price: Number(o.price) || 0,
      url: String(o.url || ''),
      status: String(o.status || ''),
      productId: String(o.productId || '')
    }));
}

/** 목록용 최소 형태. 근거는 한 줄만 — 나머지는 상세에서 준다. */
function toListItem(r) {
  const reasons = arr(r.reason_json);
  const s = obj(r.signal_json);
  const others = otherOffers(r);
  const groupSize = Number(r.group_size) > 0 ? Number(r.group_size) : 1;

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
    checkedAt: r.last_checked_at,
    source: r.source || 'internal-history',
    sourceUrl: r.source && r.source !== 'internal-history' ? (r.affiliate_url || '') : '',
    productUrl: r.affiliate_url || '',
    dealScore: (r.confidence === 'HIGH' || r.confidence === 'MEDIUM') ? r.hot_score : null,
    matchConfidence: r.identity_confidence === 'EXACT' ? 1
      : r.identity_confidence === 'STRONG' ? 0.85 : null,
    verificationStatus: r.deal_status,

    /* ── 아래부터 2026-09-07 추가. 전부 additive 다. ── */

    /*
     * 왜 핫딜인지 화면이 스스로 설명할 수 있는 값들.
     * 모르는 값은 null 이다 — 0 과 구분해서 다뤄야 한다.
     */
    signals: {
      priceDropPercent: s.priceDropPercent == null ? null : Number(s.priceDropPercent),
      priceDropAmount: s.priceDropAmount == null ? null : Number(s.priceDropAmount),
      referencePrice: s.referencePrice == null ? null : Number(s.referencePrice),
      referenceKind: s.referenceKind || null,
      previousPrice: s.previousPrice == null ? null : Number(s.previousPrice),
      nearHistoricalLow: !!s.nearHistoricalLow,
      observedLow: s.observedLow == null ? null : Number(s.observedLow),
      historyCount: Number(s.historyCount) || 0,
      historyDays: Number(s.historyDays) || 0,
      freshness: s.freshness || null,
      staleDays: Number(s.staleDays) || 0,
      currentObserved: !!s.currentObserved
    },

    /*
     * 같은 상품의 다른 판매처. 군집이 혼자면 offerCount 1 · others [] 다.
     * lowestMall 은 «우리가 값을 믿는 오퍼 중» 가장 싼 곳이다.
     */
    offerCount: groupSize,
    otherOfferCount: others.length,
    lowestPrice: Number(r.group_lowest_price) > 0 ? Number(r.group_lowest_price) : (r.current_price || 0),
    lowestMall: r.group_lowest_mall || r.mall || '',
    isLowest: !(Number(r.group_lowest_price) > 0) || Number(r.group_lowest_price) >= Number(r.current_price)
  };
}

const EXTERNAL_VISIBLE = ['STRONG_DEAL', 'GOOD_DEAL', 'INTEREST'];
const EXTERNAL_COLS = 'id, source, source_post_id, source_url, title, price, original_price, mall,'
  + ' product_url, image_url, posted_at, matched_product_id, match_confidence, deal_score,'
  + ' verification_status, price_vs_30d_avg, price_vs_90d_low, average_30d, low_90d,'
  + ' previous_price, history_observation_count, history_last_observed_at, source_count, sources,'
  + ' metadata, last_verified_at';

function externalStatus(status) {
  return status === 'STRONG_DEAL' ? 'VERIFIED_HOT'
    : status === 'GOOD_DEAL' ? 'GOOD_DEAL' : 'POTENTIAL_DEAL';
}

function externalReason(row) {
  const pct = Number(row.price_vs_30d_avg);
  if (Number.isFinite(pct) && pct > 0) return `최근 30일 평균보다 ${pct}% 저렴`;
  const delta = Number(row.price_vs_90d_low);
  if (Number.isFinite(delta) && delta <= 2) return '최근 90일 최저가에 가까운 가격';
  return 'SEOSA 가격 이력으로 검증한 외부 핫딜';
}

function toExternalListItem(r) {
  const meta = obj(r.metadata);
  return {
    id: `external:${r.id}`,
    status: externalStatus(r.verification_status),
    score: Number(r.deal_score),
    title: r.title,
    image: r.image_url || '',
    mall: r.mall || '',
    price: Number(r.price) || 0,
    listPrice: Number(r.original_price) || 0,
    reason: externalReason(r),
    productId: r.matched_product_id || '',
    url: r.product_url || r.source_url || '',
    checkedAt: r.last_verified_at,
    source: r.source,
    sourceUrl: r.source_url || '',
    productUrl: r.product_url || '',
    dealScore: Number(r.deal_score),
    matchConfidence: Number(r.match_confidence),
    verificationStatus: r.verification_status,
    priceVs30dAvg: r.price_vs_30d_avg == null ? null : Number(r.price_vs_30d_avg),
    priceVs90dLow: r.price_vs_90d_low == null ? null : Number(r.price_vs_90d_low),
    sourceCount: Math.max(1, Number(r.source_count) || 1),
    sources: arr(r.sources),
    badges: ['커뮤니티 발견', 'SEOSA 검증'],
    signals: {
      priceDropPercent: r.price_vs_30d_avg == null ? null : Number(r.price_vs_30d_avg),
      priceDropAmount: r.average_30d ? Math.max(0, Number(r.average_30d) - Number(r.price)) : null,
      referencePrice: r.average_30d == null ? null : Number(r.average_30d),
      referenceKind: r.average_30d == null ? null : 'average30',
      previousPrice: r.previous_price == null ? null : Number(r.previous_price),
      nearHistoricalLow: r.price_vs_90d_low != null && Number(r.price_vs_90d_low) <= 2,
      observedLow: r.low_90d == null ? null : Number(r.low_90d),
      historyCount: Number(r.history_observation_count) || 0,
      historyDays: 0,
      freshness: null,
      staleDays: 0,
      currentObserved: false
    },
    offerCount: Math.max(1, Number(r.source_count) || 1),
    otherOfferCount: Math.max(0, (Number(r.source_count) || 1) - 1),
    lowestPrice: Number(r.price) || 0,
    lowestMall: r.mall || '',
    isLowest: true,
    matchReason: meta.matchReason || ''
  };
}

function isMissingExternalTable(message) {
  return /relation .*external_hotdeals.* does not exist|could not find the table.*external_hotdeals|schema cache/i
    .test(String(message || ''));
}

async function loadExternal(queryParams, minScore, limit) {
  let query = supabase.from('external_hotdeals')
    .select(EXTERNAL_COLS)
    .in('verification_status', EXTERNAL_VISIBLE)
    .eq('is_primary', true)
    .gte('deal_score', Math.max(60, minScore))
    .order('deal_score', { ascending: false })
    .order('posted_at', { ascending: false })
    .limit(limit);
  if (queryParams.source) query = query.eq('source', String(queryParams.source).slice(0, 60));
  if (queryParams.mall) query = query.eq('mall', String(queryParams.mall).slice(0, 40));
  const { data, error } = await query;
  if (error && (isMissingExternalTable(error.message) || isMissingColumn(error.message))) {
    return { items: [], pending: true };
  }
  if (error) throw new Error(error.message);
  return { items: (data || []).map(toExternalListItem), pending: false };
}

/**
 * 목록 한 페이지 안에서 «같은 계열» 이 연달아 붙지 않게 자리를 바꾼다.
 *
 * ★ 항목을 버리지 않는다. 페이지에서 빼면 커서가 어긋나 다음 페이지에서
 *   그 항목이 통째로 사라진다. 순서만 바꾸면 그럴 일이 없다.
 * ★ 계열은 «같은 상품» 이 아니다. 같은 브랜드·모델의 변형(색상·용량)이
 *   나란히 다섯 개 뜨는 것을 막을 뿐, 합치지는 않는다 — 합치는 일은
 *   수집기에서 훨씬 엄격한 규칙으로만 한다.
 */
function spread(rows) {
  const fam = new Map();
  rows.forEach(r => fam.set(r.id, HG.familyKeyOf(r.title)));
  return HG.diversify(rows, r => fam.get(r.id), MAX_FAMILY_RUN);
}

/** 같은 군집이 두 장 새어 들어오는 것을 마지막으로 막는다. */
function dropDuplicateGroups(rows) {
  const seen = new Set();
  return rows.filter(r => {
    const k = String(r.group_key || '');
    if (!k) return true;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

module.exports = async function handler(req, res) {
  if (!applyCors(req, res, 'public')) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET만 지원' });
  if (!guard(req, res, { name: 'hotdeals', limit: 60, windowMs: 60 * 1000 })) return;

  const q = req.query || {};

  try {
    /* ── 상세 ── */
    if (q.id) {
      const id = dealId(q.id);
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
          reasons: arr(data.reason_json),
          confidence: data.confidence,
          identityConfidence: data.identity_confidence,
          lifecycle: data.lifecycle,
          detectedAt: data.detected_at,
          // 사용자에게 "얼마나 확인했는지"를 말할 재료. 내부 점수는 넘기지 않는다.
          observations: data.observation_count,
          spanDays: data.observation_span_days,
          median30: data.median_30d,
          observedLow: data.observed_low,
          vendorItemId: data.vendor_item_id || '',
          // 같은 상품을 파는 다른 곳. 대표 자신은 빠져 있다.
          otherOffers: otherOffers(data)
        })
      });
    }

    /* ── 목록 ── */
    const limit = intParam(q.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const minScore = intParam(q.minScore, 0, 0, 100);
    const offset = intParam(q.cursor, 0, 0, 10000);
    const sort = SORTS[String(q.sort || 'score')] || SORTS.score;

    let statuses = VISIBLE;
    if (q.status) {
      const want = String(q.status).split(',').map(s => s.trim().toUpperCase())
        .filter(s => VISIBLE.indexOf(s) > -1);
      if (want.length) statuses = want;
    }

    /*
     * 마이그레이션 전에는 새 컬럼이 없다. 그때는 예전 모양으로 한 번 더
     * 물어본다 — 배포 순서(코드 먼저 / SQL 나중)에 목록이 죽지 않아야 한다.
     */
    const run = async (withGroups) => {
      let query = supabase
        .from('hotdeals')
        .select(withGroups ? BASE_COLS + GROUP_COLS : BASE_COLS)
        .in('deal_status', statuses)
        .in('lifecycle', VISIBLE_LIFECYCLE);

      if (withGroups) query = query.eq('is_primary', true);
      if (q.mall) query = query.eq('mall', String(q.mall).slice(0, 40));
      if (q.source) query = query.eq('source', String(q.source).slice(0, 60));
      if (minScore > 0) query = query.gte('hot_score', minScore);

      query = query.order(sort.col, { ascending: sort.asc });
      if (withGroups) {
        (sort.tie || []).forEach(([col, asc]) => { query = query.order(col, { ascending: asc }); });
      }
      // 마지막 동점 해소. 이것이 있어야 같은 입력에 같은 순서가 나온다.
      query = query.order('id', { ascending: true });

      return query.range(offset, offset + limit - 1);
    };

    let grouped = true;
    let { data, error } = await run(true);
    if (error && isMissingColumn(error.message)) {
      grouped = false;
      ({ data, error } = await run(false));
    }
    if (error) throw new Error(error.message);

    const rows = data || [];
    /*
     * ★ 커서는 «DB 에서 읽은 행 수» 로 넘긴다. 중복 제거로 항목이 줄어도
     *   다음 페이지가 건너뛰지 않는다. 페이지가 가끔 limit 보다 짧아지는
     *   것은 괜찮지만, 항목이 사라지는 것은 괜찮지 않다.
     */
    const nextCursor = rows.length === limit ? offset + rows.length : null;
    const internalItems = spread(dropDuplicateGroups(rows)).map(toListItem);
    // External cards are folded into the first page. Repeating them on every
    // legacy cursor page would be worse than keeping later pages internal-only.
    const external = offset === 0
      ? await loadExternal(q, minScore, limit)
      : { items: [], pending: false };
    let items = internalItems;
    if (external.items.length) {
      const compare = q.sort === 'price'
        ? (a, b) => Number(a.price) - Number(b.price)
        : q.sort === 'recent'
          ? (a, b) => String(b.checkedAt || '').localeCompare(String(a.checkedAt || ''))
          : q.sort === 'drop'
            ? (a, b) => Number((b.signals || {}).priceDropPercent || 0) - Number((a.signals || {}).priceDropPercent || 0)
            : (a, b) => Number(b.dealScore || 0) - Number(a.dealScore || 0);
      items = spread(internalItems.concat(external.items).sort(compare)).slice(0, limit);
    }

    // 목록은 자주 바뀌지 않는다 — 수집기가 도는 주기가 시간 단위다.
    cachePublic(res, 120);
    return res.json({
      items,
      nextCursor,
      // 화면이 "아직 검증된 핫딜이 없습니다"와 "가능성 있는 딜만 있습니다"를
      // 구분해서 말할 수 있게 갈래별 개수를 준다. (이 페이지 기준)
      counts: items.reduce((acc, it) => { acc[it.status] = (acc[it.status] || 0) + 1; return acc; }, {}),
      // 군집·신호가 실린 응답인지. false 면 마이그레이션 전이라는 뜻이다.
      grouped,
      externalPending: external.pending
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

module.exports._internal = {
  VISIBLE, VISIBLE_LIFECYCLE, SORTS, MAX_FAMILY_RUN,
  toListItem, otherOffers, spread, dropDuplicateGroups, isMissingColumn, dealId,
  toExternalListItem, externalStatus, loadExternal, isMissingExternalTable
};
