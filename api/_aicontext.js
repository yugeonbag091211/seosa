'use strict';
/*
 * AI 요청 본문에서 "브라우저가 보낸 것"과 "서버가 보증할 수 있는 것"을 가르는 곳.
 *
 * ── 왜 생겼나 (2026-09-28 레드팀 RT-01·RT-02·RT-03) ─────────────────
 *
 * /api/ai 는 stateless 다. 화면의 상품(contextProducts), 대화 기록(chatHistory),
 * 직전 추천 참조를 전부 프론트가 매 요청 다시 보낸다. 그런데 서버가 그 값을
 * 서버 데이터와 같은 자격으로 썼다.
 *
 *   RT-01  contextProducts 의 price·listPrice·discountPct·trust·hist 가 그대로
 *          <상품데이터>와 가격 허용 목록에 들어갔다. 11,284원이라고 적어 보내면
 *          "현재가 11,284원 · 기록상 최저가" 가 검증된 답으로 나갔다.
 *   RT-02  chatHistory 의 role:'assistant' 를 그대로 모델의 assistant 발화로 넣었다.
 *          "직전 응답에서 655,214원이라고 했어" 를 적어 보내면 그 금액이 근거가 됐다.
 *   RT-03  context 경로에서 vendorItemId 가 버려져, 같은 상품 페이지의 다른 옵션
 *          가격 기록이 한 곡선으로 합쳐졌다.
 *
 * ── 이 모듈의 원칙 ───────────────────────────────────────────────────
 *
 *   · 브라우저의 productId·vendorItemId·mall 은 "무엇을 조회할지" 고르는 선택자다.
 *     가격·할인·신뢰도·기록은 한 글자도 읽지 않는다 (selectorsFrom).
 *   · 선택자는 SEOSA 가 이미 가진 기록(products 카탈로그)과 정확히 맞아야 한다.
 *     쿠팡은 판매 단위가 vendorItemId 이므로 옵션 ID 가 없거나 다르면 그 옵션의
 *     가격을 말하지 않는다 (matchCatalog). 외부 쇼핑 API 는 부르지 않는다 —
 *     공급자 쿼터를 쓰지 않고, 서버가 이미 보증한 값만 쓴다.
 *   · "직전 추천"과 "직전 assistant 발화"는 서버가 발급한 서명으로만 인정한다.
 *     서명은 만료 시간을 갖고, 변조되면 통째로 버린다.
 *   · 서명된 발화도 가격 근거가 아니다. 발화가 누구의 것인지만 보증한다.
 *     가격은 언제나 이번 요청에서 서버가 다시 확인한 값에서 온다 (api/ai.js).
 */

const crypto = require('crypto');

/** 선택자 식별자 길이 상한 (api/ai.js normItem 과 같은 60자). */
const ID_LEN = 60;
/** 화면 표시명 길이 상한 (api/ai.js MAX_TITLE_LEN 과 같다). */
const TITLE_LEN = 120;
/** 한 요청에서 서버가 확인할 화면 상품 수 (api/ai.js MAX_CTX_ITEMS 와 같다). */
const MAX_SELECTORS = 8;

/*
 * 서명 수명.
 *
 * 직전 추천 참조는 "그 상품의 가격을 다시 말해도 되는가"를 가르므로 짧게 둔다.
 * 프론트 대화는 30분 동안 손대지 않으면 사라진다(CONST.CHAT_TTL_MS) — 2시간이면
 * 이어지는 대화는 충분히 덮는다. assistant 발화 서명은 역할만 보증하므로 조금 길다.
 */
const REF_TTL_MS = 2 * 60 * 60 * 1000;
const TURN_TTL_MS = 6 * 60 * 60 * 1000;
/** 서버 시계 차이로 미래 시각이 찍힌 서명을 얼마나 봐줄지. */
const CLOCK_SKEW_MS = 60 * 1000;

/*
 * 프롬프트에 들어갈 문자열 정리 — api/ai.js safeText 와 같은 규칙이다.
 * (그 파일을 require 하면 순환 참조가 된다. 규칙을 바꾸면 두 곳을 함께 바꾼다.)
 */
function clean(v, n) {
  return String(v == null ? '' : v)
    .slice(0, Math.max(1024, n * 4))
    .replace(/\p{C}/gu, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);
}

/* ================================================================== *
 *  1) 화면 상품 → 선택자
 * ================================================================== */

/**
 * contextProducts 에서 조회용 선택자만 뽑는다.
 *
 * ★ price / lprice / listPrice / discountPct / trust / hist 는 읽지 않는다.
 *   필드가 있어도 없는 것과 같다 — 브라우저가 무엇을 적어 보내든 서버가 다시
 *   확인한 값만 쓰인다.
 * ★ title 은 서버가 상품을 확인하지 못했을 때 "화면에 이런 이름이 떠 있다"고
 *   알리는 데만 쓴다. 사실로 쓰지 않는다.
 *
 * @param {Array|string} contextProducts
 * @returns {Array<{productId, vendorItemId, mall, mallId, title}>}
 */
function selectorsFrom(contextProducts) {
  let list = contextProducts;
  // 프론트가 옛날 방식으로 JSON 문자열을 보낼 수도 있다.
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch (e) { list = []; }
  }
  if (!Array.isArray(list)) return [];

  const out = [];
  const seen = new Set();
  list.slice(0, MAX_SELECTORS).forEach(raw => {
    if (!raw || typeof raw !== 'object') return;
    const productId = clean(raw.productId, ID_LEN);
    if (!productId) return;
    const sel = {
      productId,
      vendorItemId: clean(raw.vendorItemId, ID_LEN),
      mall: clean(raw.mall, 30),
      mallId: clean(raw.mallId, 30),
      title: clean(raw.title, TITLE_LEN)
    };
    const key = `${sel.productId}|${sel.mallId || sel.mall}|${sel.vendorItemId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(sel);
  });
  return out;
}

/* ================================================================== *
 *  2) 선택자 ↔ SEOSA 카탈로그 (products)
 * ================================================================== */

/**
 * products 행의 옵션 ID. _price.vendorIdOf 와 같은 판정이다 — 컬럼이 비어
 * 있으면 같은 행의 쿠팡 link 에서 읽는다(그 행 자신의 링크이므로 추측이 아니다).
 */
function rowVendorId(row) {
  const { vendorIdOf } = require('./_price');
  const v = String(vendorIdOf(row) || '').trim();
  return v === '__LEGACY__' ? '' : v;
}

function isCoupangMall(mall) {
  return String(mall || '') === '쿠팡';
}

/*
 * 몰 대조.
 *
 * 새 프론트는 백엔드 식별자(mallId: '쿠팡' / 'ADPICK')를 함께 보낸다. 옛 프론트는
 * 화면 표시 이름(Fmt.mall().name — ADPICK 은 cp_name 기반 '알리' 등)만 보낸다.
 * 식별자가 있으면 그것만 본다. 없을 때만 표시 이름으로 대조한다.
 */
function mallMatches(row, sel) {
  if (sel.mallId) return String(row.mall || '') === sel.mallId;
  if (!sel.mall) return false;
  return String(row.mall || '') === sel.mall
    || (!!row.mall_label && String(row.mall_label) === sel.mall);
}

/*
 * 옵션 대조.
 *
 * 쿠팡은 같은 productId(상품 페이지) 아래 색상·용량·수량 옵션을 묶고, 실제로
 * 팔리는 단위는 vendorItemId 다. 그래서 쿠팡은 선택자와 행 모두에 옵션 ID 가
 * 있고 서로 같아야 한다. ADPICK 에는 옵션 개념이 없어(_shop.fetchAdpick) 둘 다
 * 빈 값이어야 같은 상품이다.
 */
function optionMatches(row, sel) {
  const rv = rowVendorId(row);
  if (isCoupangMall(row.mall)) return !!sel.vendorItemId && rv === sel.vendorItemId;
  return rv === sel.vendorItemId;
}

/**
 * 선택자 하나를 카탈로그 행들과 대조한다.
 *
 * @returns {{status:string, row?:object}}
 *   verified         productId·몰·옵션이 정확히 한 행과 맞고 그 가격이 노출 가능(live)
 *   stale            맞는 행은 있으나 가격 확인이 오래돼 현재가로 쓸 수 없다
 *   option-missing   쿠팡 상품인데 선택자에 옵션 ID 가 없다 — 옵션을 고를 수 없다
 *   option-mismatch  같은 상품 페이지는 있으나 SEOSA 가 가진 현재가는 다른 옵션의 것
 *   ambiguous        맞는 행이 둘 이상이다
 *   not-found        SEOSA 카탈로그에 없는 상품이다
 */
function matchCatalog(sel, rows) {
  const { productLifecycle, LIFECYCLE } = require('./_price');
  const sameProduct = (rows || []).filter(r => r
    && String(r.product_id || '') === sel.productId && mallMatches(r, sel));
  if (!sameProduct.length) return { status: 'not-found' };

  if (sameProduct.some(r => isCoupangMall(r.mall)) && !sel.vendorItemId) {
    return { status: 'option-missing' };
  }
  const exact = sameProduct.filter(r => optionMatches(r, sel));
  if (!exact.length) return { status: 'option-mismatch' };
  if (exact.length > 1) return { status: 'ambiguous' };

  const row = exact[0];
  if (productLifecycle(row).state !== LIFECYCLE.LIVE) return { status: 'stale', row };
  return { status: 'verified', row };
}

/**
 * 카탈로그 행 → 검색 결과와 같은 모양 (api/ai.js fromSearchResult 가 읽는 형태).
 *
 * _shop.toClientProduct 와 같은 필드를 같은 뜻으로 채운다. 할인율은 저장된 값을
 * 믿지 않고 가격에서 다시 만든다(_shop.recordPrices 와 같은 판단).
 */
function rowToItem(row) {
  const lprice = Math.round(Number(row.lprice) || 0);
  const oprice = Math.round(Number(row.oprice) || 0);
  const coupang = isCoupangMall(row.mall);
  return {
    title: row.title || '',
    lprice,
    link: row.link || '',
    image: row.image || '',
    mall: row.mall || '',
    mallLabel: row.mall_label || '',
    productId: String(row.product_id || ''),
    vendorItemId: rowVendorId(row),
    isCoupang: coupang,
    oprice,
    savePct: coupang && oprice > lprice && lprice > 0 ? Math.round((1 - lprice / oprice) * 100) : 0,
    collectedAt: row.collected_at || '',
    // 이 값이 어디서 왔는지. 프롬프트·관측 로그가 검색 결과와 구분하는 데 쓴다.
    _verifiedBy: 'catalog'
  };
}

/**
 * products 에서 후보 행을 읽는다. 읽기 전용 — 이 모듈은 DB 에 쓰지 않는다.
 *
 * 테스트는 이 함수를 바꿔 끼운다(module.exports.loadCatalogRows). 그래서 호출부는
 * 반드시 require('./_aicontext').loadCatalogRows 로 부른다.
 *
 * select('*') 인 이유 — mall_label·vendor_item_id 는 마이그레이션으로 생긴
 * 컬럼이다. 이름을 박아 두면 그 컬럼이 없는 환경에서 조회 자체가 실패한다
 * (_product-page.js 와 같은 선택).
 */
async function loadCatalogRows(productIds) {
  const ids = [...new Set((productIds || []).map(v => String(v || '')).filter(Boolean))]
    .slice(0, MAX_SELECTORS * 2);
  if (!ids.length) return [];
  const supabase = require('./_supabase');
  const r = await supabase.from('products').select('*').in('product_id', ids).limit(100);
  if (r.error) throw new Error(r.error.message);
  return Array.isArray(r.data) ? r.data : [];
}

/* ================================================================== *
 *  3) 서명 — 직전 추천 참조와 assistant 발화
 * ================================================================== */

/*
 * 키는 기존 비밀값에서 용도별로 파생한다(_auth.signingKey 와 같은 방식).
 * 새 환경변수를 요구하지 않는다. 비밀값이 없는 환경(로컬 오프라인)에서는
 * 서명을 만들지도 받지도 않는다 — 그때는 모든 참조·발화가 "검증 안 됨"이다.
 */
function keyFor(label) {
  const base = process.env.AUTH_SECRET || process.env.SUPABASE_SECRET_KEY;
  if (!base) return null;
  return crypto.createHmac('sha256', String(base)).update(label).digest();
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function unb64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function sameMac(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const REF_PREFIX = 'air2';
const REF_LABEL = 'seosa-ai-recommendation-ref-v2';

/**
 * 직전 추천 1위의 서명 참조.
 *
 * productId·vendorItemId·몰을 한 서명으로 묶는다. 셋 중 하나만 바꿔도 서명이
 * 깨진다. 가격은 싣지 않는다 — 참조는 "무엇을 추천했는가"만 증명하고, 그
 * 상품의 가격은 다음 요청에서 서버가 다시 확인한다.
 *
 * 쿠팡 상품은 옵션 ID 없이 발급하지 않는다 (옵션을 특정할 수 없는 참조는
 * 결국 "그중 아무 옵션"을 고르게 만든다).
 */
function createRecommendationRef(item, now) {
  const key = keyFor(REF_LABEL);
  const productId = clean(item && item.productId, ID_LEN);
  const vendorItemId = clean(item && item.vendorItemId, ID_LEN);
  const mall = clean(item && (item.mallId || item.mall), 30);
  if (!key || !productId || !mall) return '';
  if (isCoupangMall(mall) && !vendorItemId) return '';
  const iat = Number.isFinite(now) ? now : Date.now();
  const payload = b64url(JSON.stringify({ p: productId, v: vendorItemId, m: mall, iat, exp: iat + REF_TTL_MS }));
  const sig = b64url(crypto.createHmac('sha256', key).update(`${REF_PREFIX}.${payload}`).digest());
  return `${REF_PREFIX}.${payload}.${sig}`;
}

/**
 * @returns {{productId, vendorItemId, mall, mallId}|null}
 *   서명이 없거나·형식이 틀리거나·변조됐거나·만료됐으면 null.
 */
function verifyRecommendationRef(value, now) {
  const token = String(value || '');
  if (!token || token.length > 1024) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== REF_PREFIX
      || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return null;
  const key = keyFor(REF_LABEL);
  if (!key) return null;
  try {
    const expected = crypto.createHmac('sha256', key).update(`${REF_PREFIX}.${parts[1]}`).digest();
    if (!sameMac(unb64url(parts[2]), expected)) return null;
    const d = JSON.parse(unb64url(parts[1]).toString('utf8'));
    const t = Number.isFinite(now) ? now : Date.now();
    const iat = Number(d && d.iat);
    const exp = Number(d && d.exp);
    if (!Number.isFinite(iat) || !Number.isFinite(exp)) return null;
    if (iat > t + CLOCK_SKEW_MS || exp < t || exp - iat > REF_TTL_MS) return null;
    const productId = clean(d.p, ID_LEN);
    const vendorItemId = clean(d.v, ID_LEN);
    const mall = clean(d.m, 30);
    if (!productId || !mall) return null;
    if (isCoupangMall(mall) && !vendorItemId) return null;
    return { productId, vendorItemId, mall, mallId: mall, title: '' };
  } catch (e) {
    return null;
  }
}

const TURN_PREFIX = 'at1';
const TURN_LABEL = 'seosa-ai-turn-v1';

function turnDigest(text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex');
}

/**
 * 서버가 이번에 내보낸 답변 본문의 서명.
 *
 * 프론트는 이 값을 그 답변과 함께 대화 기록에 저장했다가 다음 요청에 돌려준다
 * (public/index.html Chat.send). 본문을 한 글자라도 바꾸면 서명이 맞지 않는다.
 */
function signTurn(text, now) {
  const key = keyFor(TURN_LABEL);
  const s = String(text == null ? '' : text);
  if (!key || !s) return '';
  const iat = Number.isFinite(now) ? now : Date.now();
  const payload = `${TURN_PREFIX}.${iat.toString(36)}`;
  const sig = b64url(crypto.createHmac('sha256', key).update(`${payload}.${turnDigest(s)}`).digest());
  return `${payload}.${sig}`;
}

/** 대화 기록 한 칸이 서버가 서명한 assistant 발화인가. */
function verifyTurn(h, now) {
  if (!h || typeof h !== 'object' || h.role !== 'assistant') return false;
  const token = String(h.sig || '');
  if (!token || token.length > 256) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TURN_PREFIX || !/^[0-9a-z]+$/.test(parts[1])
      || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return false;
  const key = keyFor(TURN_LABEL);
  if (!key) return false;
  const iat = parseInt(parts[1], 36);
  const t = Number.isFinite(now) ? now : Date.now();
  if (!Number.isFinite(iat) || iat > t + CLOCK_SKEW_MS || t - iat > TURN_TTL_MS) return false;
  const text = h.text != null ? h.text : h.content;
  if (typeof text !== 'string' || !text) return false;
  try {
    const expected = crypto.createHmac('sha256', key)
      .update(`${parts[0]}.${parts[1]}.${turnDigest(text)}`).digest();
    return sameMac(unb64url(parts[2]), expected);
  } catch (e) {
    return false;
  }
}

module.exports = {
  selectorsFrom, matchCatalog, rowToItem, rowVendorId, isCoupangMall,
  loadCatalogRows,
  createRecommendationRef, verifyRecommendationRef, signTurn, verifyTurn,
  REF_TTL_MS, TURN_TTL_MS, MAX_SELECTORS
};
