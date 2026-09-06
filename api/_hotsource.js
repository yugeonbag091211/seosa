'use strict';
/*
 * SEOSA HOT — 핫딜 후보 source 계층.
 *
 * 이 파일이 하는 일은 둘뿐이다.
 *   1) 외부/내부 source 의 제각각인 응답을 하나의 후보(candidate) 모양으로 정규화
 *   2) source 를 꽂았다 뺐다 할 수 있는 등록부
 *
 * ★ source 고유 필드를 UI 까지 흘려보내지 않는다. 반드시 normalizeCandidate 를
 *   통과한 것만 엔진과 화면으로 간다. 그래야 source 를 하나 더 붙일 때
 *   프론트와 판정 엔진을 건드리지 않아도 된다.
 *
 * ★ 판정은 여기서 하지 않는다. 여기는 "무엇을 후보로 볼 것인가"까지고,
 *   "그게 진짜 싼가"는 api/_hotdeal.js 가 판정한다.
 *
 * ── source 현황 (2026-09-06 실측) ─────────────────────────────────
 *
 *   internal-history   ✅ 사용 중. SEOSA 가 직접 수집한 products + price_history.
 *                      외부 호출 0회. 가장 신뢰도가 높다 — 우리가 관측한 값이다.
 *
 *   adpick-hotdeal     ❌ NOT VERIFIED. 코드는 준비했으나 기본 비활성.
 *                      저장소 어디에도 ADPICK 핫딜 엔드포인트 문서가 없고,
 *                      read-only probe 결과 `/api/{key}/hotdeal` 은 404 였다
 *                      ({status, code, error} 형태). api/_adpick.js 머리말이
 *                      실측 검증했다고 적어 둔 function 은 `search` 하나뿐이다.
 *                      추측으로 엔드포인트를 만들지 않는다 — 잘못된 주소로
 *                      키를 계속 던지면 계정이 막힌다.
 *                      ADPICK_HOTDEAL_FUNCTION 환경변수에 공식 function 이름을
 *                      넣으면 그때 켜진다. 응답 필드 이름도 환경변수로 맞춘다.
 *
 *   coupang-goldbox    ❌ NOT VERIFIED. 저장소·계정 문서에서 공식 Gold Box
 *                      엔드포인트를 확인할 수 없었다. 제3자 SDK 만 근거로
 *                      주소를 만들지 않는다. v1 제외.
 */

const HD = require('./_hotdeal');

/* ==================================================================
 *  1) 후보 정규화 — PHASE 3
 * ================================================================== */

/** 몰 이름 표기 통일. api/_adpick.mallLabelFromCpName 과 같은 기준을 쓴다. */
function normalizeMall(v) {
  const s = HD.cleanTitle(v, 40);
  if (!s) return '';
  if (/알리익스프레스|aliexpress|^알리$/i.test(s)) return '알리';
  if (/11번가/.test(s)) return '11번가';
  if (/g\s*마켓|지마켓|gmarket/i.test(s)) return 'G마켓';
  if (/쿠팡|coupang/i.test(s)) return '쿠팡';
  if (/네이버/.test(s)) return '네이버';
  return s;
}

/**
 * source raw 항목 → 내부 공통 후보.
 *
 * @returns {object|null} 쓸 수 없는 항목이면 null (가격·제목·식별자 결손)
 */
function normalizeCandidate(raw, sourceId) {
  const r = raw || {};
  const title = HD.cleanTitle(r.title || r.product_name || r.productName, 300);
  const salePrice = HD.toKRW(r.salePrice !== undefined ? r.salePrice : (r.price_sale !== undefined ? r.price_sale : r.price));
  const externalId = HD.cleanTitle(r.externalId || r.productId || r.product_id || r.id, 120);

  // 이 셋 중 하나라도 없으면 상품을 특정할 수도, 값을 판정할 수도 없다.
  if (!title || !salePrice || !externalId) return null;

  /*
   * 쇼핑몰이 말하는 "정가". 화면에 참고로만 쓰고 판정에는 절대 쓰지 않는다.
   * 판매가보다 낮거나 같으면 정가가 아니므로 버린다.
   */
  const refRaw = HD.toKRW(r.referencePrice !== undefined ? r.referencePrice : (r.price_org !== undefined ? r.price_org : r.oprice));
  const referencePrice = (refRaw && refRaw > salePrice) ? refRaw : 0;

  return {
    source: String(sourceId || 'unknown'),
    externalId,
    productId: HD.cleanTitle(r.productId || r.product_id || '', 120),
    vendorItemId: HD.cleanTitle(r.vendorItemId || r.vendor_item_id || '', 120),
    mall: normalizeMall(r.mall || r.mall_name || r.mallLabel),
    title,
    image: HD.safeUrl(r.image || r.photo || r.image_url),
    salePrice,
    referencePrice,
    affiliateUrl: HD.safeUrl(r.affiliateUrl || r.buyurl || r.commissionlink || r.link),
    commission: Number(r.commission) > 0 ? Number(r.commission) : 0,
    fetchedAt: r.fetchedAt || new Date().toISOString()
  };
}

/**
 * 같은 source 응답 안의 중복 raw 항목을 제거한다.
 * 키는 externalId + mall. 값이 겹치면 싼 쪽을 남긴다.
 */
function dedupeCandidates(list) {
  const slot = new Map();
  const out = [];
  (list || []).filter(Boolean).forEach(c => {
    const key = `${c.source}|${c.externalId}|${c.mall}`;
    if (!slot.has(key)) { slot.set(key, out.length); out.push(c); return; }
    const i = slot.get(key);
    if (c.salePrice < out[i].salePrice) out[i] = c;
  });
  return out;
}

/* ==================================================================
 *  2) source 등록부 — PHASE 2 / 17
 * ================================================================== */

/**
 * internal-history — SEOSA 가 직접 수집한 카탈로그.
 *
 * 외부 API 를 부르지 않는다. 후보를 "찾는" 일이 곧 "우리가 어제까지 본 값보다
 * 오늘 싸진 상품을 고르는" 일이므로, source of truth 와 후보 source 가 같다.
 * 그래서 이 source 에서 온 후보는 identity 가 자동으로 EXACT 다 — 우리
 * 카탈로그의 그 행 자체이기 때문이다.
 *
 * 실제 조회는 collector 가 한다(여기서 supabase 를 끌어오면 이 모듈을 쓰는
 * 프론트/테스트까지 DB 의존이 된다). 여기서는 계약만 정의한다.
 */
const INTERNAL_HISTORY = {
  id: 'internal-history',
  label: 'SEOSA 가격 기록',
  enabled: () => true,
  external: false
};

/** ADPICK 핫딜 — 공식 function 이름이 확인되면 환경변수로 켠다. */
const ADPICK_HOTDEAL = {
  id: 'adpick-hotdeal',
  label: 'ADPICK 핫딜',
  external: true,
  enabled: () => !!(process.env.ADPICK_API_KEY && process.env.ADPICK_HOTDEAL_FUNCTION),
  /** 켜졌을 때 쓸 function 이름. 절대 기본값을 추측해서 넣지 않는다. */
  functionName: () => String(process.env.ADPICK_HOTDEAL_FUNCTION || '').trim()
};

/** 쿠팡 Gold Box — 공식 엔드포인트 미확인. v1 제외. */
const COUPANG_GOLDBOX = {
  id: 'coupang-goldbox',
  label: '쿠팡 골드박스',
  external: true,
  enabled: () => false,
  note: 'NOT VERIFIED — 공식 엔드포인트 문서 미확인'
};

const SOURCES = [INTERNAL_HISTORY, ADPICK_HOTDEAL, COUPANG_GOLDBOX];

/** 지금 켜져 있는 source 만. */
function activeSources() {
  return SOURCES.filter(s => {
    try { return !!s.enabled(); } catch (e) { return false; }
  });
}

function sourceById(id) {
  return SOURCES.find(s => s.id === id) || null;
}

module.exports = {
  normalizeMall, normalizeCandidate, dedupeCandidates,
  SOURCES, activeSources, sourceById,
  INTERNAL_HISTORY, ADPICK_HOTDEAL, COUPANG_GOLDBOX
};
