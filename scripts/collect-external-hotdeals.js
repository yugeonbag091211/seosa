#!/usr/bin/env node
'use strict';

/**
 * External Hotdeal Radar collector.
 *
 *   enabled sources → normalize → match products → verify with price_history
 *   → group across sources (including recent stored rows) → decide exposure → save
 *
 * ── Exposure is OFF by default (shadow) ───────────────────────────────
 *   EXTERNAL_HOTDEAL_SHADOW          anything but '0' = shadow: every row is saved with is_exposed=false
 *   EXTERNAL_HOTDEAL_PUBLIC_SOURCES  with shadow off, only these comma-separated sources may be exposed
 *   api/hotdeals.js additionally requires EXTERNAL_HOTDEAL_PUBLIC=1. Both switches must be on.
 *
 * ── Flags ─────────────────────────────────────────────────────────────
 *   --dry-run   no writes (works before the external_hotdeals migration is applied)
 *   --sample    print every verdict for manual review (title, price, matched product, score, reasons)
 *
 * Logs carry counts, ids and product titles only. Adapters never read post bodies or authors.
 */
const path = require('path');
const fs = require('fs');
const root = path.resolve(__dirname, '..');
for (const name of ['.env.local', '.env']) {
  const file = path.join(root, name);
  if (fs.existsSync(file)) { require('dotenv').config({ path: file }); break; }
}

const supabase = require('../api/_supabase');
const registry = require('../api/_hotdeal-sources/registry');
const Radar = require('../api/_external-hotdeal');
const { kstToday } = require('../api/_kst');
const { sameVendorRows } = require('../api/_price');
const Shop = require('../api/_shop');
const HD = require('../api/_hotdeal');
const Identity = require('../api/_identity');

const DRY_RUN = process.argv.includes('--dry-run');
const SAMPLE = process.argv.includes('--sample');
/** PostgREST caps one response at 1000 rows; limit(5000) alone silently returns 1000. */
const PAGE = 1000;
const PRODUCT_LIMIT = Math.max(100, Math.min(10000, Number(process.env.EXTERNAL_HOTDEAL_PRODUCT_LIMIT) || 5000));
const HISTORY_DAYS = 90;
const HISTORY_CHUNK = 20;
/** Stored posts inside this window are regrouped with the current batch (closeInTime is 48h). */
const GROUP_WINDOW_HOURS = 72;
/**
 * 커뮤니티 핫딜 → 제휴 상품 연결은 «정확도 우선».
 * 한 실행에서 너무 많은 쇼핑 API를 부르지 않도록 신규/미매칭 딜 일부만 보강한다.
 * 12건 × (쿠팡+ADPICK)도 기존 각 공급자 리미터/캐시를 그대로 거친다.
 */
const AFFILIATE_LOOKUP_LIMIT = Math.max(0, Math.min(30,
  Number(process.env.EXTERNAL_HOTDEAL_AFFILIATE_LOOKUPS) || 20));
/**
 * 한 상품에서 검색어를 바꿔 재시도할 수 있지만 전체 호출은 별도 상한으로 막는다.
 * 기본 24회면 최대 12개 딜을 평균 2번씩 찾을 수 있다.
 */
const AFFILIATE_SEARCH_LIMIT = Math.max(0, Math.min(60,
  Number(process.env.EXTERNAL_HOTDEAL_AFFILIATE_SEARCHES) || 40));
const AFFILIATE_MATCH_THRESHOLD = 0.90;
/**
 * 사진은 구매 링크보다 한 단계 낮은 0.82까지 허용하되, title-only / partial 은 제외한다.
 * 즉 수량·용량·모델 충돌을 모두 통과한 identity B 이상일 때만 검색 결과 사진을 쓴다.
 * 사진 때문에 엉뚱한 상품으로 보이는 것보다 빈 썸네일이 낫다.
 */
const IMAGE_MATCH_THRESHOLD = 0.70;
const IMAGE_MATCH_METHODS = new Set(['identity', 'identity-partial', 'model', 'mall-id', 'url']);
/**
 * 한 글을 다시 찾아보기까지의 간격. 피드에 며칠씩 남는 글을 실행마다(하루 세 번)
 * 같은 검색어로 다시 부르지 않는다. 사진을 못 찾은 글의 재시도는 백필이 맡는다.
 */
const LOOKUP_COOLDOWN_MS = 12 * 3600 * 1000;
/** 사진에 딸린 메타 키. 사진을 옮기거나 지울 때 같이 옮기고 지운다. */
const IMAGE_META_KEYS = ['imageSource', 'imageProductId', 'imageMatchConfidence', 'imageMatchReason', 'imageReference'];
const AFFILIATE_META_KEYS = ['affiliateUrl', 'affiliateMall', 'affiliatePrice', 'affiliateProductId',
  'affiliateVendorItemId', 'affiliateConfidence', 'affiliateMatchReason', 'affiliateSearchQuery'];

function log(message, extra) {
  console.log(JSON.stringify({ at: new Date().toISOString(), message, ...(extra || {}) }));
}

function exposurePolicy(env) {
  const e = env || process.env;
  const shadow = e.EXTERNAL_HOTDEAL_SHADOW !== '0';
  const publicSources = [...new Set(String(e.EXTERNAL_HOTDEAL_PUBLIC_SOURCES || '')
    .split(',').map(s => s.trim()).filter(Boolean))];
  return { shadow, publicSources, allows: source => !shadow && publicSources.indexOf(String(source || '')) > -1 };
}

async function selectPaged(build, limit) {
  const rows = [];
  for (let from = 0; from < limit; from += PAGE) {
    const to = Math.min(from + PAGE, limit) - 1;
    const { data, error } = await build().range(from, to);
    if (error) throw new Error(error.message);
    const page = data || [];
    rows.push(...page);
    if (page.length < to - from + 1) break;
  }
  return rows;
}

async function loadProducts(db) {
  try {
    return await selectPaged(() => db.from('products')
      .select('product_id, vendor_item_id, mall, title, link, image, lprice, collected_at')
      .order('collected_at', { ascending: false })
      .order('product_id', { ascending: true })
      .order('mall', { ascending: true }), PRODUCT_LIMIT);
  } catch (error) {
    throw new Error(`products: ${error.message}`);
  }
}

async function loadHistory(matches, db, today) {
  const ids = [...new Set(matches.map(m => m && m.product && String(m.product.product_id)).filter(Boolean))];
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - (HISTORY_DAYS - 1) * 86400000).toISOString().slice(0, 10);
  const map = new Map();
  for (let i = 0; i < ids.length; i += HISTORY_CHUNK) {
    let rows;
    try {
      rows = await selectPaged(() => db.from('price_history')
        .select('product_id, vendor_item_id, mall, price, recorded_date, recorded_at')
        .in('product_id', ids.slice(i, i + HISTORY_CHUNK))
        .gte('recorded_date', since)
        .order('recorded_date', { ascending: true })
        .order('product_id', { ascending: true })
        .order('mall', { ascending: true })
        .order('vendor_item_id', { ascending: true }), 50000);
    } catch (error) {
      throw new Error(`price_history: ${error.message}`);
    }
    for (const row of rows) {
      const key = String(row.product_id);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
  }
  return map;
}

function historyFor(match, history) {
  if (!match || !match.product) return [];
  const product = match.product;
  const rows = history.get(String(product.product_id)) || [];
  // No fallback to other malls: another mall's history is not this listing's history.
  const sameMall = product.mall ? rows.filter(r => String(r.mall || '') === String(product.mall)) : rows;
  // The option guard is the shared _price.sameVendorRows rule (product page and price stats use it too).
  return sameVendorRows(sameMall, product.vendor_item_id);
}

function rowFor(deal, match, verification, nowMs) {
  const product = match && match.product;
  const candidate = match && match.candidate;
  const affiliateSafe = !!(product && product.link && Number(match && match.confidence) >= AFFILIATE_MATCH_THRESHOLD);
  return {
    source: deal.source,
    source_post_id: deal.externalId,
    source_url: deal.postUrl,
    canonical_source_url: deal.canonicalPostUrl,
    title: deal.title,
    normalized_title: deal.normalizedTitle,
    price: deal.price,
    original_price: deal.originalPrice,
    mall: deal.mall,
    product_url: deal.productUrl,
    canonical_product_url: deal.canonicalProductUrl,
    image_url: deal.imageUrl || (product && product.image) || '',
    posted_at: deal.postedAt,
    fetched_at: deal.fetchedAt,
    matched_product_id: product ? String(product.product_id) : null,
    matched_mall: product ? String(product.mall || '') : '',
    matched_vendor_item_id: product ? String(product.vendor_item_id || '') : '',
    match_confidence: Math.round(((match && match.confidence) || 0) * 1000) / 1000,
    match_method: (match && match.method) || 'none',
    deal_score: verification.dealScore,
    verification_status: verification.verificationStatus,
    verification_reasons: verification.reasons,
    price_vs_30d_avg: verification.priceVs30dAvg,
    price_vs_90d_low: verification.priceVs90dLow,
    average_30d: verification.stats.average30,
    low_30d: verification.stats.low30,
    low_90d: verification.stats.low90,
    previous_price: verification.stats.previousPrice,
    history_observation_count: verification.stats.count,
    history_last_observed_at: verification.stats.lastObservedAt,
    is_exposed: false,
    metadata: {
      ...deal.metadata,
      matchReason: match && match.reason,
      matchedTitle: product ? String(product.title || '').slice(0, 200) : '',
      bestCandidateId: !product && candidate ? String(candidate.product_id || '') : '',
      bestCandidateTitle: !product && candidate ? String(candidate.title || '').slice(0, 200) : '',
      effectivePrice: verification.effectivePrice,
      priceVs30dMedian: verification.priceVs30dMedian,
      scoreParts: verification.parts,
      ...(affiliateSafe ? {
        affiliateUrl: String(product.link),
        affiliateMall: String(product.mall || ''),
        affiliatePrice: Number(product.lprice || product.price) || null,
        affiliateProductId: String(product.product_id || product.productId || ''),
        affiliateVendorItemId: String(product.vendor_item_id || product.vendorItemId || ''),
        affiliateConfidence: Number(match.confidence) || 0,
        affiliateMatchReason: String(match.reason || '')
      } : {})
    },
    last_verified_at: new Date(nowMs).toISOString()
  };
}

/** _shop 검색 결과를 External Radar matcher가 읽는 catalog 모양으로 바꾼다. */
function affiliateCandidateProduct(item) {
  return {
    product_id: String((item && item.productId) || ''),
    vendor_item_id: String((item && item.vendorItemId) || ''),
    mall: String((item && item.mall) || ''),
    title: String((item && item.title) || ''),
    link: String((item && item.link) || ''),
    image: String((item && item.image) || ''),
    lprice: Number(item && item.lprice) || 0
  };
}

function safeImageUrl(value) {
  const url = HD.safeUrl(String(value || ''));
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? url : '';
  } catch (_) {
    return '';
  }
}

/*
 * ── 사진 URL 은 «실제로 열리는가» 로 판정한다 (2026-09-26) ──────────────
 *
 *   ADPICK 검색 응답의 photo 가 가리키는
 *   d2iaagr1j041pi.cloudfront.net/apis/search_img.php?code=… 는 원 서버(Apache)가
 *   404 text/html 을 준다(리퍼러·UA 무관, 표본 20/20). 카드 사진 143장 중 63장이 이 주소였고,
 *   화면에서는 깨진 사진 위에 «참고 이미지» 표시만 남았다. 형식 검사(https)만으로는
 *   못 거른다 — 그래서 저장 전에 한 번 GET 해서 200/206 + image/* 인지 본다.
 *   본문은 읽지 않고 헤더만 본 뒤 끊는다. 한 실행 안에서는 URL 별로 결과를 기억한다.
 */
const IMAGE_PROBE_TIMEOUT_MS = 6000;
const _imageProbeCache = new Map();
/** 테스트가 네트워크 없이 돌도록 기본 검사기를 바꿔 끼운다. 운영 코드는 부르지 않는다. */
let _defaultProbe = null;
function _setImageProbe(fn) { _defaultProbe = typeof fn === 'function' ? fn : null; _imageProbeCache.clear(); }

async function probeImageUrl(value, opts) {
  const o = opts || {};
  if (_defaultProbe && !o.fetch) return _defaultProbe(value);
  const url = safeImageUrl(value);
  if (!url) return { ok: false, status: 0, reason: 'invalid-url' };
  const cache = o.cache || _imageProbeCache;
  if (cache.has(url)) return cache.get(url);
  const fetchImpl = o.fetch || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) return { ok: false, status: 0, reason: 'no-fetch' };
  let out;
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { Accept: 'image/*', Range: 'bytes=0-2047', 'User-Agent': 'Mozilla/5.0 (compatible; SEOSA-ImageCheck/1.0)' },
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(o.timeoutMs || IMAGE_PROBE_TIMEOUT_MS) : undefined
    });
    const type = String((res.headers && res.headers.get && res.headers.get('content-type')) || '').toLowerCase();
    const length = res.headers && res.headers.get && res.headers.get('content-length');
    try { if (res.body && res.body.cancel) await res.body.cancel(); } catch (_) { /* 헤더만 필요하다 */ }
    if (res.status !== 200 && res.status !== 206) out = { ok: false, status: res.status, reason: `http-${res.status}` };
    else if (!type.startsWith('image/')) out = { ok: false, status: res.status, reason: `not-image:${type || 'none'}` };
    else if (length === '0') out = { ok: false, status: res.status, reason: 'empty' };
    else out = { ok: true, status: res.status, reason: 'ok' };
  } catch (error) {
    // 시간 초과·네트워크 오류는 «죽은 사진» 이 아니라 «확인 못 함» 이다. 캐시하지 않는다.
    return { ok: false, status: 0, reason: 'probe-error', transient: true };
  }
  cache.set(url, out);
  return out;
}

/**
 * 사진 전용 용량. _identity.capacities 는 g·L 을 보지 않는다(32G 같은 사양 표기와
 * 섞이지 않게). 사진은 190ml 캔과 500ml 병이 다른 물건으로 보이므로 g·kg·ml·L 까지
 * 기준 단위로 바꿔 비교한다. 1.7kg = 1700g.
 */
function imageCapacities(value) {
  const out = new Set();
  const re = /(\d+(?:\.\d+)?)\s?(kg|g|ml|l|gb|tb|mah|인치)(?![a-z])/gi;
  let m;
  const s = String(value || '');
  while ((m = re.exec(s)) !== null) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (!(n > 0)) continue;
    if (unit === 'kg') out.add(`${Math.round(n * 1000)}g`);
    else if (unit === 'l') out.add(`${Math.round(n * 1000)}ml`);
    else out.add(`${Math.round(n * 1000) / 1000}${unit}`);
  }
  return out;
}

const IMAGE_GENERIC_WORDS = new Set([
  '무료배송','무료','무배','핫딜','특가','정품','공식','국산','국내산','프리미엄',
  '고급','대용량','신상품','최신형','증정','사은품','골라담기','선물세트','세트'
]);
const IMAGE_UNIT_WORD_RE = /^\d+(?:\.\d+)?(?:g|kg|ml|l|개|매|입|팩|병|캔|장|봉|종|인분|cm|mm|인치|gb|tb)?$/i;

function imageWords(value) {
  return cleanAffiliateQuery(value)
    .toLowerCase()
    .replace(/[^0-9a-z가-힣\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !IMAGE_GENERIC_WORDS.has(w) && !IMAGE_UNIT_WORD_RE.test(w));
}

function mallKey(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '').replace(/지마켓/g, 'g마켓');
}

/**
 * 이미지 전용 짧은 모델 코드. _identity.modelCodes 는 4자 이상이라 E10/T35 같은
 * 짧은 이어폰 모델을 놓친다. 참고 사진에서 다른 모델을 보여주는 것도 오해를
 * 만들 수 있으므로 영문+숫자 3자 이상을 추가로 잡는다.
 */
function imageModelCodes(value) {
  const out = new Set(Identity.modelCodes(value));
  const tokens = String(value || '').toUpperCase()
    .replace(/[^0-9A-Z\s-]/g, ' ')
    .split(/\s+/).filter(Boolean);
  const unit = /^\d+(?:\.\d+)?(?:ML|L|G|KG|GB|TB|MAH|CM|MM|OZ)$/;
  for (const token of tokens) {
    if (token.length >= 3 && /[A-Z]/.test(token) && /\d/.test(token) && !unit.test(token)) out.add(token);
  }
  return out;
}

/**
 * 정확 SKU 판정(0.70)에도 못 미치지만 검색 결과 자체는 꽤 가까운 경우,
 * 카드에 «참고 이미지»만 붙이기 위한 별도 선택기.
 *
 * 구매 링크/상품 ID에는 절대 쓰지 않는다.
 * - 첫 번째(전체 제목) 검색 결과만 대상으로 함
 * - 기존 hard conflict(수량·용량·모델·옵션 충돌)는 그대로 차단
 * - 몰이 명시됐으면 같은 몰을 우선/강제
 * - 핵심 단어 2~3개 이상이 겹쳐야 함
 */
function referenceImageCandidate(deal, items) {
  return referenceImageCandidates(deal, items)[0] || null;
}

/** 위 선택기의 후보 전체(높은 순위 먼저). 1순위 사진이 죽어 있으면 다음 후보를 본다. */
function referenceImageCandidates(deal, items) {
  const title = cleanAffiliateQuery(deal && deal.title);
  const dw = imageWords(title);
  if (!dw.length) return [];
  const dealMall = mallKey(deal && deal.mall);
  const dmodels = imageModelCodes(title);
  const dgrades = Identity.grades(title);
  const dformats = Identity.formats(title);
  const dvariants = Identity.variants(title);
  const dcolors = Identity.colors(title);
  const dcaps = imageCapacities(title);
  const found = [];

  const conflicts = (a, b) => a.size && b.size && ![...a].some(v => b.has(v));
  const semanticShared = (left, right) => {
    const out = [];
    for (const a of left) {
      const hit = right.find(b => a === b
        || (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a))));
      if (hit) out.push(a);
    }
    return out;
  };

  for (const item of items || []) {
    const image = safeImageUrl(item && item.image);
    if (!image) continue;

    const candidateTitle = cleanAffiliateQuery(item && item.title);
    const cw = imageWords(candidateTitle);
    if (!cw.length) continue;

    /*
     * 참고 사진은 «상품 판매 단위»가 아니라 «보이는 물건»을 돕는 용도다.
     * 그래서 10봉↔4봉 같은 수량(개수) 차이는 참고 이미지에서 허용한다.
     * 하지만 모델/세대/형태/색상, 그리고 용량(190ml 캔 ↔ 500ml 병, 1kg ↔ 600g)처럼
     * 사진 자체가 다른 물건이 되는 충돌은 거부한다 (2026-09-26: 용량 충돌 추가).
     * 구매 링크의 0.90 identity 판정은 전혀 건드리지 않는다.
     */
    const cmodels = imageModelCodes(candidateTitle);
    const cgrades = Identity.grades(candidateTitle);
    const cformats = Identity.formats(candidateTitle);
    const cvariants = Identity.variants(candidateTitle);
    const ccolors = Identity.colors(candidateTitle);
    if (conflicts(dmodels, cmodels)
      || conflicts(dgrades, cgrades)
      || conflicts(dformats, cformats)
      || conflicts(dvariants, cvariants)
      || conflicts(dcolors, ccolors)
      || conflicts(dcaps, imageCapacities(candidateTitle))) continue;

    const shared = semanticShared(dw, cw);
    const overlap = shared.length / Math.max(1, Math.min(dw.length, cw.length));
    const sameFirst = dw[0] && cw[0]
      && (dw[0] === cw[0] || dw[0].includes(cw[0]) || cw[0].includes(dw[0]));
    const sharedModel = [...dmodels].some(m => cmodels.has(m));

    // 모델이 없으면 최소 2개 핵심어, 혹은 긴 고유어 하나 + 높은 겹침을 요구한다.
    const distinctiveOne = shared.length === 1 && shared[0].length >= 4 && overlap >= 0.45;
    const enough = sharedModel
      || shared.length >= 3
      || (shared.length >= 2 && (sameFirst || overlap >= 0.34))
      || distinctiveOne;
    if (!enough) continue;

    const itemMall = mallKey((item && item.mallLabel) || (item && item.mall));
    const sameMall = !!dealMall && !!itemMall && dealMall === itemMall;
    const rank = (sharedModel ? 100 : 0) + shared.length * 10 + overlap * 8 + (sameMall ? 3 : 0);
    found.push({
      item,
      image,
      rank,
      confidence: Math.min(0.69,
        0.44 + Math.min(0.19, shared.length * 0.045) + Math.min(0.06, overlap * 0.06)),
      reason: `전체 제목 검색 결과 핵심 단어 ${shared.length}개 일치 · 참고용`
    });
  }
  // 같은 점수면 먼저 온 결과(검색 순위가 높은 쪽)를 앞에 둔다 — 예전 «최고 1개» 와 같은 선택.
  return found.map((f, i) => ({ f, i })).sort((a, b) => (b.f.rank - a.f.rank) || (a.i - b.i)).map(x => x.f);
}

/**
 * 제휴 검색용 제목 정리.
 *
 * 첫 시도는 수량/용량/모델명을 절대 버리지 않는다. 기존 searchPhraseFromTitle()
 * 은 재수집용이라 500ml·40개 같은 옵션 토큰을 의도적으로 제거하는데, 외부 핫딜
 * 제휴 매칭에서는 바로 그 값이 동일상품을 찾는 핵심이다.
 */
function cleanAffiliateQuery(value) {
  return String(value || '')
    .replace(/\b\d{1,3}(?:\.\d+)?\s*%\s*(?:할인)?/gi, ' ')
    .replace(/\b(?:무료배송|무배|핫딜|특가)\b/gi, ' ')
    .replace(/[\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
}

/**
 * 한 상품을 한 검색어로만 찾지 않는다.
 *
 * 1) 전체 제목(수량·용량·모델 유지) — 가장 정확한 SKU 검색
 * 2) 앞 5개 핵심 토큰 — 쇼핑몰 제목 장식/판매자 문구가 다른 경우
 * 3) 앞 3개 핵심 토큰 — 마지막 재현율 보강
 *
 * 중복은 제거하고 최대 3개만 쓴다. 매칭 문턱(0.90)은 그대로라 검색 범위만
 * 넓어지고 잘못된 제휴 상품을 승인하는 기준은 느슨해지지 않는다.
 */
function affiliateSearchQueries(deal) {
  const title = String(deal && deal.title || '');
  const out = [];
  const add = q => {
    const v = cleanAffiliateQuery(q);
    if (v && out.indexOf(v) < 0) out.push(v);
  };
  add(title);
  add(Shop.searchPhraseFromTitle(title, 5));
  add(Shop.searchPhraseFromTitle(title, 3));
  return out.slice(0, 3);
}

function affiliateCandidateKey(item) {
  return [
    String(item && item.mall || ''),
    String(item && item.productId || ''),
    String(item && item.vendorItemId || ''),
    String(item && item.link || '')
  ].join('|');
}

/**
 * 미매칭 커뮤니티 딜을 SEOSA의 기존 제휴 검색 통로(쿠팡 Partners + ADPICK)로
 * 한 번 더 찾는다. 외부 글의 일반 링크를 제휴 링크처럼 재사용하지 않는다.
 *
 * MATCH_THRESHOLD(0.75)보다 높은 0.90을 요구한다. 돈이 걸리는 버튼은
 * «비슷해 보인다»가 아니라 모델/identity A 수준의 근거가 있어야 한다.
 */
async function enrichAffiliateRows(deals, rows, options) {
  const opts = options || {};
  const injectedSearch = opts.searchAll || null;
  const fetchCoupang = opts.fetchCoupang || Shop.fetchCoupang;
  const fetchAdpick = opts.fetchAdpick || Shop.fetchAdpick;
  const save = opts.saveProducts || Shop.saveProducts;
  const lookupLimit = Math.max(0, Math.min(30,
    Number.isFinite(opts.lookupLimit) ? opts.lookupLimit : AFFILIATE_LOOKUP_LIMIT));
  const searchLimit = Math.max(0, Math.min(60,
    Number.isFinite(opts.searchLimit) ? opts.searchLimit : AFFILIATE_SEARCH_LIMIT));
  // 사진 검사기 — 테스트는 주입한다. 운영은 실제 GET(헤더만)으로 본다.
  const probe = opts.probeImage || (url => probeImageUrl(url));
  const nowIso = new Date(opts.nowMs == null ? Date.now() : Number(opts.nowMs)).toISOString();
  const stats = { attempted: 0, searches: 0, matched: 0, saved: 0, skipped: 0, errors: 0,
    imageFilled: 0, deadImagesRejected: 0 };

  for (let i = 0; i < (rows || []).length; i++) {
    const row = rows[i];
    const deal = (deals || [])[i];
    if (!row || !deal) continue;
    row.metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};

    if (row.metadata.affiliateUrl || row.matched_product_id) { stats.skipped++; continue; }
    // 같은 글을 실행마다 다시 찾지 않는다 — 앞 실행이 이미 찾아봤고 사진도 있으면 건너뛴다.
    if (opts.skipRecentlyLooked && row.metadata.imageLookup
      && Date.parse(row.metadata.imageLookup.at || '') > Date.parse(nowIso) - LOOKUP_COOLDOWN_MS) { stats.skipped++; continue; }
    if (stats.attempted >= lookupLimit || stats.searches >= searchLimit) break;

    const queries = affiliateSearchQueries(deal);
    if (!queries.length) { stats.skipped++; continue; }

    stats.attempted++;
    const lookup = { at: nowIso, searches: 0, results: 0, candidates: 0, dead: 0, probeErrors: 0, outcome: '' };
    try {
      const candidateMap = new Map();
      let match = null;
      let chosen = null;
      let matchedKeyword = '';
      let matchedFrom = 'api';
      // 사진 후보 전부 — identity(0.70+) 와 참고 사진(≤0.69). 저장 전에 순서대로 열어 본다.
      const visuals = [];
      const visualByImage = new Map();
      const addVisual = (item, vm) => {
        const image = safeImageUrl(item && item.image);
        if (!image) return;
        const seen = visualByImage.get(image);
        // 같은 사진이 참고(≤0.69)와 identity(0.70+) 로 두 번 오면 높은 쪽 근거를 남긴다.
        if (seen) {
          if (Number(vm.confidence) > Number(seen.match.confidence)) { seen.item = item; seen.match = vm; }
          return;
        }
        const v = { item, image, match: vm };
        visualByImage.set(image, v);
        visuals.push(v);
      };

      for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
        const keyword = queries[queryIndex];
        if (stats.searches >= searchLimit) break;
        stats.searches++;
        lookup.searches++;

        let result;
        if (injectedSearch) {
          // 테스트/호출부가 searchAll을 주입한 경우 기존 계약을 그대로 쓴다.
          result = await injectedSearch(keyword, {
            coupangLimit: 10,
            coupangOpts: { source: 'external-hotdeal', maxWaitMs: 15000 },
            adpickLimit: 10,
            adpickOpts: { source: 'external-hotdeal', maxWaitMs: 15000 }
          });
        } else {
          /*
           * 운영에서는 ADPICK을 모든 재시도에 호출하지 않는다.
           * 첫 검색어가 모델/용량/수량을 모두 보존하므로 ADPICK은 여기서 한 번만 보고,
           * 2·3차 재검색은 쿠팡만 사용한다. 2026-09-20 실측에서 11번째 ADPICK
           * 호출부터 429가 발생했으므로, 재현율을 올리면서도 공급자 차단은 피한다.
           */
          const coupang = await fetchCoupang(keyword, 10,
            { source: 'external-hotdeal', maxWaitMs: 15000 })
            .catch(e => ({ items: [], error: e.message, from: 'none' }));
          const adpick = queryIndex === 0
            ? await fetchAdpick(keyword, 10,
                { source: 'external-hotdeal', maxWaitMs: 15000 })
                .catch(e => ({ items: [], error: e.message, from: 'none' }))
            : { items: [], error: null, from: 'none' };
          result = {
            items: [...(coupang.items || []), ...(adpick.items || [])],
            from: coupang.from || adpick.from || 'none'
          };
        }

        lookup.results += (result && result.items || []).length;
        for (const item of (result && result.items || [])) {
          if (!item || !item.link || !item.productId || !(Number(item.lprice) > 0)) continue;
          const key = affiliateCandidateKey(item);
          if (!candidateMap.has(key)) candidateMap.set(key, item);
        }

        const candidates = [...candidateMap.values()];
        if (!candidates.length) continue;
        const products = candidates.map(affiliateCandidateProduct);
        // 커뮤니티 제목의 "77%할인/특가" 같은 홍보 문구는 상품 identity가 아니다.
        // 수량·용량·모델은 보존한 채 홍보 문구만 걷어 동일상품 판정에 사용한다.
        const matchDeal = { ...deal, title: cleanAffiliateQuery(deal.title) || deal.title };

        // Every already-budgeted query may yield a reference photo. Compare against
        // the ORIGINAL deal title; model/variant/color/capacity conflicts are rejected.
        // Reference photos never grant an affiliate link or product identity.
        for (const ref of referenceImageCandidates(matchDeal, result && result.items)) {
          addVisual(ref.item, { confidence: ref.confidence, reason: ref.reason, method: 'reference-search' });
        }

        // 구매 링크는 0.90+, 사진은 identity B/partial(0.70)+까지 허용한다.
        // 둘 다 같은 conflict guard(수량/용량/모델/옵션)를 거친다.
        const vm = Radar.matchProduct(matchDeal, products, IMAGE_MATCH_THRESHOLD);
        if (vm.product && IMAGE_MATCH_METHODS.has(String(vm.method || ''))) {
          const candidate = candidates.find(it =>
            String(it.productId) === String(vm.product.product_id)
            && String(it.mall || '') === String(vm.product.mall || '')
          );
          if (candidate) addVisual(candidate, vm);
        }

        match = Radar.matchProduct(matchDeal, products, AFFILIATE_MATCH_THRESHOLD);
        if (!match.product) continue;

        chosen = candidates.find(it =>
          String(it.productId) === String(match.product.product_id)
          && String(it.mall || '') === String(match.product.mall || '')
          && String(it.link || '') === String(match.product.link || '')
        ) || candidates.find(it =>
          String(it.productId) === String(match.product.product_id)
          && String(it.mall || '') === String(match.product.mall || '')
        );

        if (chosen) {
          matchedKeyword = keyword;
          matchedFrom = chosen._source || (result && result.from) || 'api';
          break;
        }
      }

      lookup.candidates = visuals.length;
      /** 높은 확신 순으로 열어 보고, 처음으로 실제 열리는 사진을 준다. */
      const firstLiveImage = async (list) => {
        const ordered = list.map((v, k) => ({ v, k }))
          .sort((a, b) => (Number(b.v.match.confidence) - Number(a.v.match.confidence)) || (a.k - b.k))
          .map(x => x.v);
        for (const v of ordered) {
          const p = await probe(v.image);
          if (p && p.ok) return v;
          if (p && p.transient) lookup.probeErrors++;
          else { lookup.dead++; stats.deadImagesRejected++; }
        }
        return null;
      };
      const imageMeta = (item, vm, reference) => ({
        imageSource: String(item.mallLabel || item.mall || ''),
        imageProductId: String(item.productId || ''),
        imageMatchConfidence: Number(vm.confidence) || 0,
        imageMatchReason: String(vm.reason || ''),
        imageReference: reference
      });

      let chosenImage = '';
      if (chosen && match && match.product) {
        const own = safeImageUrl(chosen.image);
        const p = own ? await probe(own) : null;
        if (p && p.ok) chosenImage = own;
        else if (own) { if (p && p.transient) lookup.probeErrors++; else { lookup.dead++; stats.deadImagesRejected++; } }
      }

      if (!row.image_url && !chosenImage && visuals.length) {
        const live = await firstLiveImage(visuals);
        if (live) {
          row.image_url = live.image;
          row.metadata = {
            ...row.metadata,
            ...imageMeta(live.item, live.match, Number(live.match.confidence) < AFFILIATE_MATCH_THRESHOLD)
          };
          stats.imageFilled++;
        }
      }

      lookup.outcome = chosen && match && match.product ? 'affiliate'
        : row.image_url ? 'image'
        : !lookup.results ? 'no-results'
        : !visuals.length ? 'no-safe-candidate'
        : lookup.probeErrors && !lookup.dead ? 'probe-error' : 'image-dead';
      row.metadata = { ...row.metadata, imageLookup: lookup };

      if (!chosen || !match || !match.product) continue;

      if (chosenImage) { if (!row.image_url) stats.imageFilled++; row.image_url = chosenImage; }

      const meta = {
        ...row.metadata,
        affiliateUrl: String(chosen.link),
        affiliateMall: String(chosen.mallLabel || chosen.mall || ''),
        affiliatePrice: Number(chosen.lprice) || null,
        affiliateProductId: String(chosen.productId || ''),
        affiliateVendorItemId: String(chosen.vendorItemId || ''),
        affiliateConfidence: Number(match.confidence) || 0,
        affiliateMatchReason: String(match.reason || ''),
        affiliateSearchQuery: String(matchedKeyword || '').slice(0, 80),
        ...(chosenImage ? {
          imageSource: String(chosen.mallLabel || chosen.mall || ''),
          imageProductId: String(chosen.productId || ''),
          imageMatchConfidence: Number(match.confidence) || 0,
          imageMatchReason: String(match.reason || ''),
          imageReference: false
        } : {})
      };
      row.metadata = meta;

      // 정확한 제휴 후보는 다음 실행부터 가격 이력 검증도 받을 수 있게 catalog/원장에 남긴다.
      const saved = await save(matchedKeyword, [chosen], {
        from: matchedFrom,
        source: 'external-hotdeal'
      });
      if (saved && Number(saved.saved) > 0) stats.saved += Number(saved.saved);

      // 0.90+ identity만 row의 SEOSA 상품 identity로 승격한다.
      row.matched_product_id = String(chosen.productId || '');
      row.matched_mall = String(chosen.mall || '');
      row.matched_vendor_item_id = String(chosen.vendorItemId || '');
      row.match_confidence = Number(match.confidence) || 0;
      row.match_method = 'affiliate-' + String(match.method || 'identity');
      stats.matched++;
    } catch (error) {
      stats.errors++;
      log('affiliate_enrich_error', {
        source: row.source,
        id: row.source_post_id,
        error: String((error && error.message) || error).slice(0, 180)
      });
    }
  }

  return stats;
}

/**
 * 저장된 사진이 실제로 열리지 않으면 비운다 (죽은 주소는 metadata.imageDeadUrl 에 남긴다).
 * 확인이 안 된 경우(시간 초과 등)는 건드리지 않는다. 비운 행은 enrich 가 다시 찾는다.
 * @returns {number} 비운 행 수
 */
async function dropDeadImages(rows, opts) {
  const o = opts || {};
  const probe = o.probeImage || (url => probeImageUrl(url));
  const nowIso = new Date(o.nowMs == null ? Date.now() : Number(o.nowMs)).toISOString();
  let dropped = 0;
  for (const row of rows || []) {
    const url = safeImageUrl(row && row.image_url);
    if (!url) continue;
    const p = await probe(url);
    if (!p || p.ok || p.transient) continue;
    const meta = { ...(row.metadata || {}) };
    IMAGE_META_KEYS.forEach(k => { delete meta[k]; });
    row.metadata = { ...meta, imageDeadUrl: url, imageDeadReason: String(p.reason || ''), imageDeadAt: nowIso };
    row.image_url = '';
    dropped++;
  }
  return dropped;
}

/**
 * 이번 피드에 다시 실린 글이 «이미 찾은 것» 을 이어받는다 (2026-09-26).
 *
 *   rowFor 는 행을 매 실행 새로 만들고 save 는 (source, source_post_id) 로 upsert 한다.
 *   그래서 앞 실행·백필이 찾은 사진과 제휴 링크가 다음 실행에서 빈 값으로 덮였고,
 *   피드에 남은 같은 글을 실행마다 다시 검색했다. 제휴는 0.90 이상 affiliate- 매칭만
 *   이어받는다 — 이번 실행 카탈로그 매칭이 있으면 그쪽이 이긴다.
 * @returns {Promise<{carriedImages:number, carriedAffiliates:number}>}
 */
async function carryStoredEnrichment(db, rows) {
  const out = { carriedImages: 0, carriedAffiliates: 0 };
  const bySource = new Map();
  (rows || []).forEach(r => {
    if (!r || !r.source || !r.source_post_id) return;
    if (!bySource.has(r.source)) bySource.set(r.source, []);
    bySource.get(r.source).push(String(r.source_post_id));
  });
  const stored = new Map();
  for (const [source, ids] of bySource) {
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await db.from('external_hotdeals')
        .select('source, source_post_id, image_url, metadata, matched_product_id, matched_mall, matched_vendor_item_id, match_confidence, match_method')
        .in('source', [source]).in('source_post_id', ids.slice(i, i + 100));
      if (error) {
        if (isMissingTable(error.message)) return out;
        throw new Error(`external_hotdeals(carry): ${error.message}`);
      }
      (data || []).forEach(s => stored.set(`${s.source}|${s.source_post_id}`, s));
    }
  }
  for (const row of rows || []) {
    const s = stored.get(`${row.source}|${row.source_post_id}`);
    if (!s) continue;
    const sm = s.metadata && typeof s.metadata === 'object' ? s.metadata : {};
    row.metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    if (!safeImageUrl(row.image_url) && safeImageUrl(s.image_url)) {
      row.image_url = s.image_url;
      IMAGE_META_KEYS.forEach(k => { if (sm[k] !== undefined) row.metadata[k] = sm[k]; });
      out.carriedImages++;
    }
    if (!row.matched_product_id && !row.metadata.affiliateUrl && sm.affiliateUrl && s.matched_product_id
      && Number(s.match_confidence) >= AFFILIATE_MATCH_THRESHOLD
      && String(s.match_method || '').startsWith('affiliate-')) {
      AFFILIATE_META_KEYS.forEach(k => { if (sm[k] !== undefined) row.metadata[k] = sm[k]; });
      row.matched_product_id = s.matched_product_id;
      row.matched_mall = s.matched_mall || '';
      row.matched_vendor_item_id = s.matched_vendor_item_id || '';
      row.match_confidence = Number(s.match_confidence) || 0;
      row.match_method = s.match_method;
      out.carriedAffiliates++;
    }
    ['imageLookup', 'imageBackfillAttemptedAt', 'imageDeadUrl', 'imageDeadReason', 'imageDeadAt'].forEach(k => {
      if (sm[k] !== undefined && row.metadata[k] === undefined) row.metadata[k] = sm[k];
    });
  }
  return out;
}

// 표가 «없을» 때만 참이다. DB 일시 장애를 마이그레이션 전으로 읽지 않는다 (api/_dberror.js).
function isMissingTable(message) {
  return require('../api/_dberror').isMissingTable(String(message || ''));
}

async function loadRecentGroupRows(db, rows, nowMs, dryRun) {
  const ids = [...new Set(rows.map(r => r.matched_product_id).filter(Boolean))];
  if (!ids.length) return { rows: [], tableMissing: false };
  const since = new Date(nowMs - GROUP_WINDOW_HOURS * 3600000).toISOString();
  try {
    const found = await selectPaged(() => db.from('external_hotdeals').select('*')
      .in('matched_product_id', ids)
      .gte('posted_at', since)
      .order('id', { ascending: true }), 5000);
    return { rows: found, tableMissing: false };
  } catch (error) {
    if (isMissingTable(error.message)) {
      if (dryRun) return { rows: [], tableMissing: true };
      throw new Error('external_hotdeals table is missing — apply supabase/2026-09-12-external-hotdeals.sql manually');
    }
    throw new Error(`external_hotdeals(read): ${error.message}`);
  }
}

/**
 * Regroup the current batch together with recently stored posts so a product
 * posted on two communities in different runs still has one primary row.
 * Every source row is kept; only group fields and exposure are rewritten.
 */
function regroup(current, recent, policy) {
  const key = r => `${r.source}|${r.source_post_id}`;
  const seen = new Set(current.map(key));
  const carried = (recent || []).filter(r => !seen.has(key(r))).map(r => {
    const copy = { ...r };
    delete copy.id;
    return copy;
  });
  const rows = Radar.dedupeAcrossSources(current.concat(carried)).map(row => {
    const out = { ...row, group_key: row.groupKey, is_primary: row.isPrimary, source_count: row.sourceCount, sources: row.sources };
    delete out.groupKey; delete out.isPrimary; delete out.sourceCount;
    out.is_exposed = !!(out.is_primary && policy.allows(out.source) && Radar.isExposableRow(out));
    return out;
  });
  return { rows, carried: carried.length };
}

async function save(rows, db) {
  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await db.from('external_hotdeals')
      .upsert(rows.slice(i, i + 100), { onConflict: 'source,source_post_id' });
    if (error) throw new Error(`external_hotdeals: ${error.message}`);
  }
}

function countRows(rows) {
  return {
    unique: rows.length,
    matched: rows.filter(r => r.matched_product_id).length,
    highConfidence: rows.filter(r => r.matched_product_id && Number(r.match_confidence) >= Radar.HIGH_MATCH_CONFIDENCE).length,
    unmatched: rows.filter(r => !r.matched_product_id).length,
    verified: rows.filter(Radar.isExposableRow).length,
    suspicious: rows.filter(r => r.verification_status === 'SUSPICIOUS_PRICE').length,
    groupedUnderOther: rows.filter(r => !r.is_primary).length,
    exposed: rows.filter(r => r.is_exposed).length
  };
}

function summarize(sourceStats, rows, extra) {
  const sum = key => sourceStats.reduce((s, stat) => s + (Number(stat[key]) || 0), 0);
  const totals = countRows(rows);
  return {
    dryRun: extra.dryRun,
    shadow: extra.policy.shadow,
    publicSources: extra.policy.publicSources,
    fetched: sum('fetched'),
    normalized: sum('normalized'),
    duplicates: sum('duplicates') + totals.groupedUnderOther,
    ...totals,
    written: extra.written,
    carriedFromDb: extra.carried,
    tableMissing: extra.tableMissing,
    errors: sourceStats.filter(stat => stat.status !== 'ok').length,
    sources: sourceStats.map(stat => ({ ...stat, ...countRows(rows.filter(r => r.source === stat.source)) }))
  };
}

function summaryText(s) {
  const lines = [];
  for (const src of s.sources) {
    lines.push(`Source: ${src.source} (${src.kind || 'feed'}) status=${src.status}${src.errorKind ? ` error=${src.errorKind}` : ''}`
      + ` http=${src.httpStatus == null ? '-' : src.httpStatus} attempts=${src.attempts == null ? '-' : src.attempts} latency=${src.latencyMs}ms`);
    lines.push(`  Fetched: ${src.fetched}  Normalized: ${src.normalized}  Duplicates: ${src.duplicates}  Skipped: ${JSON.stringify(src.skipped || {})}`);
    lines.push(`  Matched: ${src.matched}  High-confidence: ${src.highConfidence}  Unmatched: ${src.unmatched}`);
    lines.push(`  Verified >=${Radar.EXPOSURE_SCORE}: ${src.verified}  Suspicious: ${src.suspicious}  Grouped under another post: ${src.groupedUnderOther}  Exposed: ${src.exposed}`);
  }
  if (!s.sources.length) lines.push('Source: (none enabled)');
  lines.push(`Mode: ${s.dryRun ? 'dry-run' : 'write'} · ${s.shadow ? 'shadow (verified exposure off; community feed may still show unverified rows)' : `public sources=[${s.publicSources.join(',')}]`}`
    + ` · written=${s.written} · carried=${s.carriedFromDb}${s.tableMissing ? ' · external_hotdeals table missing' : ''}`);
  if (s.affiliate) {
    lines.push(`Affiliate: attempted=${s.affiliate.attempted} searches=${s.affiliate.searches || 0} matched=${s.affiliate.matched} saved=${s.affiliate.saved} errors=${s.affiliate.errors}`);
  }
  return lines.join('\n');
}

function sampleOf(rows) {
  return rows.map(r => {
    const meta = r.metadata || {};
    return {
      source: r.source,
      id: r.source_post_id,
      title: r.title,
      price: r.price,
      mall: r.mall,
      shipping: meta.shippingNote || null,
      match: r.matched_product_id
        ? { productId: r.matched_product_id, title: meta.matchedTitle, confidence: Number(r.match_confidence), method: r.match_method, reason: meta.matchReason }
        : { confidence: Number(r.match_confidence), method: r.match_method, reason: meta.matchReason, bestCandidate: meta.bestCandidateTitle || null },
      score: r.deal_score,
      status: r.verification_status,
      reasons: r.verification_reasons,
      vs30dAvg: r.price_vs_30d_avg,
      vs90dLow: r.price_vs_90d_low,
      historyDays: r.history_observation_count,
      primary: r.is_primary,
      exposed: r.is_exposed,
      postUrl: r.source_url
    };
  });
}

async function main(options) {
  const opts = options || {};
  const db = opts.db || supabase;
  const sourceRegistry = opts.registry || registry;
  const dryRun = DRY_RUN || !!opts.dryRun;
  const policy = exposurePolicy(opts.env);
  const nowMs = opts.now == null ? Date.now() : Number(opts.now);
  const today = opts.today || kstToday();

  const fetched = await sourceRegistry.fetchAll({ now: new Date(nowMs) });
  (fetched.errors || []).forEach(error => log('source_error', error));

  let rows = [];
  let carried = 0;
  let tableMissing = false;
  let affiliate = { attempted: 0, searches: 0, matched: 0, saved: 0, skipped: 0, errors: 0 };
  if (fetched.items.length) {
    const products = await loadProducts(db);
    const matches = fetched.items.map(deal => Radar.matchProduct(deal, products));
    const history = await loadHistory(matches, db, today);
    const current = fetched.items.map((deal, i) => rowFor(deal, matches[i],
      Radar.verifyDeal(deal, matches[i], historyFor(matches[i], history), today), nowMs));

    // dry-run은 외부 쇼핑 API를 추가로 부르지 않는다. 테스트는 주입한 fake search로 별도 검증한다.
    // 사진 검사(이미지 CDN GET)도 dry-run 에서는 하지 않는다.
    let imageCare = { droppedDead: 0, carriedImages: 0, carriedAffiliates: 0 };
    if (!dryRun) {
      const probeOpts = { probeImage: opts.probeImage, nowMs };
      // 이번 행의 죽은 사진(카탈로그 ADPICK 주소 등) → 앞 실행이 찾은 것 이어받기 → 이어받은 것도 검사
      imageCare.droppedDead += await dropDeadImages(current, probeOpts);
      Object.assign(imageCare, await carryStoredEnrichment(db, current));
      imageCare.droppedDead += await dropDeadImages(current, probeOpts);
    }
    affiliate = dryRun
      ? { attempted: 0, searches: 0, matched: 0, saved: 0, skipped: 0, errors: 0 }
      : await enrichAffiliateRows(fetched.items, current, {
          searchAll: opts.searchAll,
          saveProducts: opts.saveProducts,
          lookupLimit: opts.affiliateLookupLimit,
          searchLimit: opts.affiliateSearchLimit,
          probeImage: opts.probeImage,
          nowMs,
          skipRecentlyLooked: true
        });
    affiliate.imageCare = imageCare;
    const recent = await loadRecentGroupRows(db, current, nowMs, dryRun);
    tableMissing = recent.tableMissing;
    const grouped = regroup(current, recent.rows, policy);
    rows = grouped.rows;
    carried = grouped.carried;
  }

  if (!dryRun && rows.length) await save(rows, db);
  const currentKeys = new Set(fetched.items.map(d => `${d.source}|${d.externalId}`));
  const currentRows = rows.filter(r => currentKeys.has(`${r.source}|${r.source_post_id}`));
  const summary = summarize(fetched.sources || [], currentRows,
    { dryRun, policy, written: dryRun ? 0 : rows.length, carried, tableMissing });
  summary.affiliate = affiliate;

  if (!opts.quiet) {
    console.log(summaryText(summary));
    if (SAMPLE || opts.sample) console.log(JSON.stringify(sampleOf(currentRows), null, 2));
    log(dryRun ? 'dry_run' : 'complete', summary);
  }
  return summary;
}

if (require.main === module) {
  main().catch(error => { log('failed', { error: String((error && error.message) || error) }); process.exitCode = 1; });
}

module.exports = {
  main, loadProducts, loadHistory, historyFor, rowFor, exposurePolicy, regroup, selectPaged,
  enrichAffiliateRows, affiliateCandidateProduct, affiliateSearchQueries, cleanAffiliateQuery, safeImageUrl,
  imageWords, imageModelCodes, referenceImageCandidate, referenceImageCandidates, imageCapacities,
  probeImageUrl, _setImageProbe, dropDeadImages, carryStoredEnrichment, LOOKUP_COOLDOWN_MS, IMAGE_META_KEYS,
  summaryText, sampleOf
};
