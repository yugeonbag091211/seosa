'use strict';
/*
 * ④ 브라우저 확장 — 상품 대조 · 다른 판매처 오퍼 조립. 순수 함수만 있다 (DB·네트워크 모름).
 *
 * ── 이 파일이 답하는 질문 ────────────────────────────────────────
 *
 * 사용자가 쿠팡(또는 11번가·G마켓) 상품 페이지에서 버튼을 누르면 확장이
 * «상품 번호 + 페이지 제목» 을 보낸다. 서버는 세 가지 중 하나로 답한다.
 *
 *   EXACT    SEOSA 카탈로그에 «이 쿠팡 상품 번호» 가 있다 → 이 상품의 기록
 *   SIMILAR  번호로는 없지만 제목으로 찾은 «다른 판매처의 같은(또는 거의 같은) 상품»
 *            → 그 상품의 기록. 화면은 반드시 «비슷한 상품의 기록» 이라고 말한다
 *   NONE     같은 상품이라고 볼 근거가 없다 → 기록 없음
 *
 * ── 왜 SIMILAR 를 EXACT 와 절대 섞지 않는가 ─────────────────────
 *
 * _identity.js 머리 주석이 이 저장소의 원칙을 적어 두었다 — **닮음은 동일이 아니다.**
 * LP 와 CD, 단품과 세트, 256GB 와 512GB, 실버와 블랙은 제목이 거의 같아도 가격이 다르다.
 * 그래서 제목으로 찾은 상품은 «이 페이지 상품의 기록» 으로 내보내지 않는다. match.status
 * 가 SIMILAR 이고, 화면(확장·extension.html)은 그 상태를 문장으로 바꿔 보여 준다.
 *
 * SIMILAR 로 인정하는 문턱은 _identity 보다 한 단계 높다. judgeSameProduct 의 tier A 는
 * «사람이 검토할 재등록 후보» 용이라 느슨하다 (_hotgroup.js 머리 주석: WIN11 같은 스펙
 * 낱말이 모델코드로 잡혀 "그램 16" 과 "그램 AI 17" 이 tier A 가 됐다). 그래서
 *
 *   · 스펙 숫자(단위 없는 맨숫자 — "그램 16" 의 16)가 다르면 → 탈락 (다른 상품)
 *   · tier A 이고 _hotgroup.canMerge 까지 통과          → tier A (동일 확실)
 *   · tier A 인데 canMerge 는 못 넘거나, 원래 tier B    → tier B (확신 낮음을 reasons 에 적는다)
 *   · tier C · D                                         → 탈락
 *
 * ── 다른 판매처 오퍼 ──────────────────────────────────────────────
 *
 * «이 몰이 더 싸다» 는 문장은 두 값이 같은 물건일 때만 참이다 (_hotgroup.js: false merge
 * < duplicate). 그래서 오퍼는 SEOSA HOT 이 카드를 묶을 때와 **같은 관문**을 통과해야 한다:
 * judgeSameProduct tier A + canMerge (옵션 식별자 · 스펙 숫자 · 자카드 · 값 비율 · 변별력
 * 있는 모델코드). 관문 하나라도 못 넘으면 싸 보여도 보여 주지 않는다.
 *
 * ★ 링크는 products.link (기존 제휴 링크) 를 그대로 쓴다. 새로 만들지 않는다.
 */

const { judgeSameProduct, modelCodes } = require('./_identity');
const HG = require('./_hotgroup');
const { productLifecycle, vendorIdOf, isRefreshableMall, kstToday, LIFECYCLE } = require('./_price');

/* ==================================================================
 *  상수 — 값마다 이유가 있다
 * ================================================================== */

/** 쿠팡 productId · vendorItemId · itemId 는 전부 숫자다. 20자리면 int64 를 넉넉히 덮는다. */
const ID_RE = /^\d{1,20}$/;
/** 제목 상한. 확장(parse.js MAX_TITLE)과 같은 값 — 한쪽만 고치지 말 것. */
const MAX_TITLE = 200;
/** 제목으로 찾으려면 최소 이만큼은 있어야 한다. 한 글자로는 무엇도 가를 수 없다. */
const MIN_TITLE = 2;
/**
 * EXACT 는 쿠팡 상품 번호로만 성립한다. ADPICK 의 product_id 는 제휴 링크 해시
 * (api/_shop.js adpickProductId) 라 사용자가 보는 페이지에서 얻을 방법이 없다.
 */
const EXACT_MALL = '쿠팡';
/** 제목 검색 한 번에 받을 후보 수 (명세: ≤ 40). judgeSameProduct 를 40번 부르는 비용은 무시할 만하다. */
const SEARCH_LIMIT = 40;
/** 오퍼 후보군 (같은 keyword 의 카탈로그 행, 명세: ≤ 60 — _radarapi ALT_POOL 과 같은 값). */
const OFFER_POOL = 60;
/** 화면에 보여 줄 다른 판매처 수. 확장 패널은 작다. */
const MAX_OFFERS = 8;
/** 가격 계열 창(일). fairness 는 90일을 보지만 차트는 반년이 있어야 계절을 본다. */
const SERIES_DAYS = 180;
/** ① 타이밍 예측 창 (계약 기본값). */
const TIMING_HORIZON = 14;
/** 지금도 다시 받아올 수 있는 몰만 후보로 삼는다 (_price.isRefreshableMall 과 같은 목록). */
const LIVE_MALLS = ['쿠팡', 'ADPICK'];
/** ② 대기실 등록 화면 (상대 경로 — 확장이 https://seosa.ai.kr 을 앞에 붙인다). */
const WAITROOM_PATH = '/v2/waitroom.html';

/*
 * 검색어로 쓰지 않는 낱말. 판매 문구는 거의 모든 제목에 붙어서 ilike 로 찾으면
 * 아무 상품이나 40개가 온다 — 검색이 아니라 표본 추출이 된다.
 */
const STOPWORDS = new Set([
  '정품', '무료배송', '당일발송', '당일출고', '국내', '국내정품', '공식', '공식판매', '특가', '최신형',
  '신형', '새상품', '단품', '쿠팡', '로켓배송', '로켓', '본사', '정식', '정식수입', '수입', '추천',
  '인기', '할인', '행사', '사은품', '증정', '빠른배송', '무료', '배송', '상품', '제품',
  'best', 'new', 'the', 'and', 'for', 'with', 'hot', 'sale'
]);
/** 단위가 붙은 수 — 검색어로는 변별력이 없다 (100매·500ml 는 수천 개 상품에 있다). */
const UNIT_TOKEN_RE = /^\d+(?:\.\d+)?[a-z가-힣]{0,3}$/i;

/* ==================================================================
 *  1) 입력
 * ================================================================== */

/*
 * 페이지 제목에 붙는 몰 이름. 확장의 parse.js cleanTitle 과 같은 규칙이다
 * (scripts/test-v2-extension.js 가 둘의 출력이 같음을 고정한다).
 *
 *   "상품명 - 쿠팡!"  "상품명 - 노트북 | 쿠팡"  "상품명 - 11번가"  "G마켓 - 상품명"  "[11번가] 상품명"
 *
 * 몰 이름을 남겨 두면 judgeSameProduct 가 '쿠팡' 을 제목 낱말로 세어, 카탈로그 제목과
 * «정규화 제목 완전 일치» 가 깨진다 — 같은 상품이 tier A 에서 B 로 떨어진다.
 */
const MALL_NAMES = '(?:쿠팡!?|coupang|11번가|11st|g마켓|gmarket|지마켓)';
const SEP = '[-|:·–—]';
const TITLE_RULES = [
  // "상품명 - 카테고리 | 쿠팡" — document.title 폴백일 때 쿠팡이 붙이는 모양
  new RegExp('\\s+-\\s+[^-|]{1,30}\\s*\\|\\s*쿠팡!?\\s*$', 'i'),
  new RegExp('\\s*' + SEP + '\\s*' + MALL_NAMES + '\\s*$', 'i'),
  new RegExp('^\\s*\\[\\s*' + MALL_NAMES + '\\s*\\]\\s*', 'i'),
  new RegExp('^\\s*' + MALL_NAMES + '\\s*' + SEP + '\\s*', 'i')
];
const ONLY_MALL_RE = new RegExp('^' + MALL_NAMES + '$', 'i');

/**
 * 페이지 제목 정리 — 제어문자 제거 · 공백 접기 · 몰 이름 떼기 · 200자.
 * @param {*} raw
 * @returns {string}
 */
function cleanTitle(raw) {
  let s = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // 규칙이 겹쳐 붙는 경우("[11번가] 상품 - 11번가")를 위해 몇 번 반복한다. 무한 반복은 없다.
  for (let i = 0; i < 3; i++) {
    const before = s;
    TITLE_RULES.forEach(re => { s = s.replace(re, '').trim(); });
    if (s === before) break;
  }
  if (ONLY_MALL_RE.test(s)) s = '';
  // 서로게이트 쌍(이모지)을 반으로 자르지 않게 코드포인트 단위로 자른다.
  return Array.from(s).slice(0, MAX_TITLE).join('').trim();
}

/** 쿼리 값 하나. 배열(?a=1&a=2)은 «모호한 입력» 이라 null 로 돌려 호출부가 거절하게 한다. */
function scalar(v) {
  if (Array.isArray(v)) return null;
  return String(v == null ? '' : v).trim();
}

/**
 * GET /api/lookup 쿼리 → 검증된 입력.
 *
 * ★ 형식이 틀린 식별자는 고쳐 쓰지 않고 거절한다. "12a" 를 "12" 로 읽으면
 *   남의 상품 기록을 보여 줄 수 있다.
 *
 * @returns {{ok:true, productId:string, vendorItemId:string, itemId:string, mall:string, title:string}
 *          |{ok:false, error:string}}
 */
function readQuery(q) {
  const src = q || {};
  const bad = error => ({ ok: false, error });
  const productId = scalar(src.productId);
  const vendorItemId = scalar(src.vendorItemId);
  const itemId = scalar(src.itemId);
  const mallRaw = scalar(src.mall);
  const titleRaw = src.title;
  if (productId === null || vendorItemId === null || itemId === null || mallRaw === null || Array.isArray(titleRaw)) {
    return bad('같은 값을 여러 번 보낼 수 없어요.');
  }
  if (productId && !ID_RE.test(productId)) return bad('상품 번호(productId)는 숫자여야 해요.');
  if (vendorItemId && !ID_RE.test(vendorItemId)) return bad('옵션 번호(vendorItemId)는 숫자여야 해요.');
  if (itemId && !ID_RE.test(itemId)) return bad('아이템 번호(itemId)는 숫자여야 해요.');
  const mall = mallRaw || EXACT_MALL;
  if (mall !== EXACT_MALL) return bad('상품 번호로 찾을 수 있는 몰은 쿠팡뿐이에요. 다른 몰은 제목(title)으로 찾아 주세요.');
  const title = cleanTitle(titleRaw);
  if (!productId && Array.from(title).length < MIN_TITLE) {
    return bad('상품 번호(productId)나 두 글자 이상의 상품명(title)이 필요해요.');
  }
  return { ok: true, productId, vendorItemId, itemId, mall, title };
}

/* ==================================================================
 *  2) 제목 → 검색어
 * ================================================================== */

/**
 * 제목 → ilike 검색 계획. 계획 하나는 검색어 1~2개(AND)이고, 계획은 최대 두 개다.
 * 앞 계획에서 받아들일 후보가 없을 때만 다음 계획을 쓴다 (조회 최대 2회).
 *
 *   모델코드가 있다   [코드, 브랜드] → [코드]
 *                     브랜드 표기가 달라도("삼성" vs "삼성전자") 코드만으로 한 번 더 찾는다.
 *   모델코드가 없다   [브랜드, 가장 긴 낱말] → [브랜드, 두 번째로 긴 낱말]
 *                     페이지 제목에만 붙은 판매 문구("대용량")가 첫 계획을 망쳐도 둘째가 잡는다.
 *
 * 브랜드 = 판매 문구·단위를 건너뛴 첫 낱말. 길이가 같으면 제목 앞쪽 낱말을 먼저 쓴다
 * (상품 이름의 핵심은 대개 앞에 있고, 판매 문구는 뒤에 붙는다).
 *
 * ★ 검색어에는 [0-9A-Za-z가-힣-] 만 남는다. %·_·쉼표·괄호가 들어갈 자리가 없으므로
 *   PostgREST 필터 문법을 사용자가 조작할 수 없다 (ilike 와일드카드 주입 차단).
 *
 * @returns {string[][]} 예: [['SM-S931N','삼성전자'], ['SM-S931N']]
 */
function searchPlans(title) {
  const t = cleanTitle(title);
  const codes = [...modelCodes(t)]
    .filter(c => /^[0-9A-Z][0-9A-Z-]*[0-9A-Z]$/.test(c))
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const inCode = w => codes.some(c => c.indexOf(w.toUpperCase()) > -1);
  const usable = w => w.length >= 2 && !STOPWORDS.has(w.toLowerCase()) && !UNIT_TOKEN_RE.test(w) && !inCode(w);

  const words = [];
  t.replace(/[^0-9a-zA-Z가-힣\s]/g, ' ').split(/\s+/).forEach((w, i) => {
    if (w && usable(w) && !words.some(x => x.w.toLowerCase() === w.toLowerCase())) words.push({ w, i });
  });
  const brand = words.length ? words[0].w : '';
  const rest = words.slice(1).sort((a, b) => b.w.length - a.w.length || a.i - b.i).map(x => x.w);

  const safe = s => String(s || '').replace(/[^0-9A-Za-z가-힣-]/g, '').slice(0, 40);
  let plans;
  if (codes.length) plans = brand ? [[codes[0], brand], [codes[0]]] : [[codes[0]]];
  else if (brand && rest.length) plans = rest[1] ? [[brand, rest[0]], [brand, rest[1]]] : [[brand, rest[0]]];
  else plans = brand ? [[brand]] : [];
  return plans.map(p => p.map(safe).filter(Boolean)).filter(p => p.length);
}

/* ==================================================================
 *  3) 제목 대조 — SIMILAR 후보 고르기
 * ================================================================== */

function sameSet(a, b) {
  return a.size === b.size && [...a].every(x => b.has(x));
}

function collectedMs(row) {
  const t = Date.parse((row && row.collected_at) || '');
  return Number.isFinite(t) ? t : 0;
}

/**
 * 제목으로 찾은 카탈로그 행을 등급 매기고 정렬한다.
 *
 * @param {string} title        페이지 제목 (cleanTitle 을 거친 값)
 * @param {object[]} rows       products 행
 * @param {object} [opts]       { excludeProductId }
 * @returns {{accepted:Array<{row, tier:'A'|'B', reasons:string[]}>, rejected:Array<{title, reason}>}}
 *   accepted 는 좋은 순서로 정렬돼 있다. [0] 이 SIMILAR 로 쓸 후보다.
 */
function rankSimilar(title, rows, opts) {
  const o = opts || {};
  const t = cleanTitle(title);
  const list = (rows || []).filter(r => r && r.product_id && r.title && isRefreshableMall(r.mall))
    .filter(r => !(o.excludeProductId && String(r.product_id) === String(o.excludeProductId)));
  const df = HG.modelCodeFrequency(list.map(r => r.title).concat([t]));
  const myNums = HG.specNumbers(t);
  const accepted = [], rejected = [];

  list.forEach(r => {
    const j = judgeSameProduct(t, r.title);
    if (j.tier !== 'A' && j.tier !== 'B') {
      rejected.push({ title: r.title, reason: j.reasons[0] || `tier ${j.tier}` });
      return;
    }
    const nums = HG.specNumbers(r.title);
    if (!sameSet(myNums, nums)) {
      // "그램 16" vs "그램 AI 17" — 판정이 A 여도 다른 상품이다 (_hotgroup.specNumbers 주석).
      rejected.push({ title: r.title, reason: `스펙 숫자가 다르다 [${[...myNums].join(',')}] ≠ [${[...nums].join(',')}]` });
      return;
    }
    if (j.tier === 'A') {
      const m = HG.canMerge({ title: t, vendorItemId: '' }, { title: r.title, vendorItemId: '' }, df);
      if (m.merge) {
        accepted.push({ row: r, tier: 'A', reasons: j.reasons.concat([`묶음 검증 통과 (${m.reason})`]), jac: HG.jaccard(t, r.title) });
        return;
      }
      accepted.push({
        row: r, tier: 'B', jac: HG.jaccard(t, r.title),
        reasons: j.reasons.concat([`묶음 검증 미통과 (${m.reason}) — 같은 상품이라는 확신이 낮아요`])
      });
      return;
    }
    accepted.push({
      row: r, tier: 'B', jac: HG.jaccard(t, r.title),
      reasons: j.reasons.concat(['제목 근거만 있어 같은 상품이라는 확신이 낮아요 (등급 B)'])
    });
  });

  /*
   * 좋은 후보 순서.
   *   등급 A → 지금 살아 있는 행 → 쿠팡(옵션 단위 기록이라 곡선이 가장 믿을 만하다)
   *   → 제목이 더 닮은 것 → 최근 확인 → product_id (결정론)
   */
  const live = r => productLifecycle(r).state === LIFECYCLE.LIVE ? 1 : 0;
  accepted.sort((a, b) =>
    (a.tier === b.tier ? 0 : a.tier === 'A' ? -1 : 1)
    || live(b.row) - live(a.row)
    || (b.row.mall === EXACT_MALL ? 1 : 0) - (a.row.mall === EXACT_MALL ? 1 : 0)
    || b.jac - a.jac
    || collectedMs(b.row) - collectedMs(a.row)
    || (String(a.row.product_id) < String(b.row.product_id) ? -1 : 1));

  return { accepted: accepted.map(x => ({ row: x.row, tier: x.tier, reasons: x.reasons })), rejected };
}

/* ==================================================================
 *  4) 다른 판매처 오퍼
 * ================================================================== */

function int(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** http(s) 링크만. javascript: · data: 같은 값은 null (화면이 한 번 더 https 만 거른다). */
function safeLink(u) {
  const s = String(u || '').trim();
  return /^https?:\/\/[^\s]+$/i.test(s) ? s : null;
}

function kstDateOf(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? kstToday(new Date(t)) : null;
}

function isSelf(row, matched) {
  return !!matched && String(row.product_id) === String(matched.product_id)
    && String(row.mall || '') === String(matched.mall || '');
}

/**
 * 가격을 읽기 전에 거를 수 있는 것은 먼저 거른다 — loadStats 에 넘길 키를 줄인다.
 * 자기 자신 · 살아 있지 않은 행 · 제목 판정 A 가 아닌 행을 뺀다.
 *
 * @returns {object[]} products 행
 */
function offerCandidates(matched, pool) {
  if (!matched || !matched.title) return [];
  return (pool || []).filter(r => r && r.product_id && r.title
    && !isSelf(r, matched)
    && productLifecycle(r).state === LIFECYCLE.LIVE
    && judgeSameProduct(matched.title, r.title).tier === 'A');
}

/**
 * 오퍼 목록.
 *
 * @param {object} o
 * @param {object} o.matched        대조된 카탈로그 행 (EXACT 또는 SIMILAR)
 * @param {number} o.matchedPrice   그 상품의 최근 관측가 (값 비율 관문에 쓴다; 모르면 0)
 * @param {string} o.matchedVid     그 상품의 옵션 식별자
 * @param {object[]} o.pool         같은 keyword 의 카탈로그 행
 * @param {Map} o.stats             `${productId}|${mall}` → _pricestat.statsFrom 결과
 * @returns {Array<{mall, mallLabel, title, price, url, observedDate, identity:{tier}}>}
 */
function buildOffers(o) {
  const matched = o && o.matched;
  if (!matched || !matched.title) return [];
  const pool = (o.pool || []).filter(Boolean);
  const stats = o.stats || new Map();
  // 변별력 있는 모델코드 판정용 df — 후보군 전체(자기 자신 포함)에서 센다 (_hotgroup.groupOffers 와 같다).
  const df = HG.modelCodeFrequency(pool.map(r => r.title).concat([matched.title]));
  const me = { title: matched.title, price: int(o.matchedPrice) || int(matched.lprice), vendorItemId: String(o.matchedVid || '') };

  const out = [];
  offerCandidates(matched, pool).forEach(r => {
    const st = stats.get(`${r.product_id}|${r.mall || ''}`) || null;
    const catalogDate = kstDateOf(r.collected_at);
    /*
     * 값은 가격 기록의 마지막 관측가를 쓴다 (명세). 다만 카탈로그가 그보다 «나중에»
     * 확인됐다면 카탈로그 값이 더 새 값이다 — 오래된 기록을 현재가처럼 말하지 않는다.
     */
    let price = 0, observedDate = null;
    if (st && int(st.lastPrice) && (!catalogDate || String(st.lastDate) >= catalogDate)) {
      price = int(st.lastPrice); observedDate = st.lastDate || null;
    } else if (int(r.lprice)) {
      price = int(r.lprice); observedDate = catalogDate;
    }
    if (!price) return;

    /*
     * ★ SEOSA HOT 과 같은 병합 관문. 옵션 식별자가 둘 다 있고 다르면(쿠팡의 다른
     *   상품 페이지·다른 옵션) 제목이 같아도 붙이지 않는다 — _hotgroup.canMerge 0) 규칙.
     */
    const m = HG.canMerge(me, { title: r.title, price, vendorItemId: vendorIdOf(r) }, df);
    if (!m.merge) return;

    out.push({
      mall: String(r.mall || ''),
      mallLabel: String(r.mall_label || r.mall || ''),
      title: String(r.title),
      price,
      url: safeLink(r.link),
      observedDate,
      identity: { tier: 'A' }
    });
  });

  out.sort((a, b) => a.price - b.price
    || (a.mallLabel < b.mallLabel ? -1 : a.mallLabel > b.mallLabel ? 1 : 0)
    || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  return out.slice(0, MAX_OFFERS);
}

/* ==================================================================
 *  5) 응답 조각
 * ================================================================== */

/**
 * ② 대기실 등록 링크 (상대 경로). 등록할 상품을 알 수 없으면 null.
 * 빈 값은 싣지 않는다 — 대기실 화면이 없는 키를 '' 로 읽는다.
 */
function waitroomUrl(p) {
  if (!p || !p.productId) return null;
  const pairs = [['add', '1'], ['productId', p.productId], ['mall', p.mall],
    ['vendorItemId', p.vendorItemId], ['title', p.title]];
  return WAITROOM_PATH + '?' + pairs
    .filter(kv => kv[1] != null && String(kv[1]) !== '')
    .map(kv => `${kv[0]}=${encodeURIComponent(String(kv[1]))}`)
    .join('&');
}

/** ① _timing.analyze 결과 → { action, label }. 모양이 다르면 null (지어내지 않는다). */
function timingOf(r) {
  const rec = r && r.recommendation;
  if (!rec || typeof rec.action !== 'string') return null;
  return { action: rec.action, label: typeof rec.label === 'string' ? rec.label : '' };
}

/** ⑥ _anomaly.analyze 결과 → { status, label }. 모양이 다르면 null. */
function anomalyOf(r) {
  const s = r && r.summary;
  if (!s || typeof s.status !== 'string') return null;
  return { status: s.status, label: typeof s.label === 'string' ? s.label : '' };
}

/** NONE 일 때 «왜 못 찾았는지» 를 짧게. 후보 제목은 싣지 않는다 (판정 이유만). */
function noneReasons(input, search) {
  const out = [];
  if (input.productId) out.push('SEOSA 카탈로그에 이 쿠팡 상품 번호의 기록이 없어요.');
  if (!input.title) {
    out.push('상품명이 없어 제목으로 찾아보지 못했어요.');
    return out;
  }
  const rej = (search && search.rejected) || [];
  if (!search || !search.scanned) {
    out.push('제목이 닮은 상품을 SEOSA 카탈로그에서 찾지 못했어요.');
  } else {
    out.push(`제목이 닮은 상품 ${search.scanned}개를 찾았지만 같은 상품이라고 볼 근거가 부족해요.`);
    const seen = new Set();
    rej.forEach(r => {
      if (out.length >= 4 || seen.has(r.reason)) return;
      seen.add(r.reason);
      out.push(`예: ${r.reason}`);
    });
  }
  return out;
}

module.exports = {
  ID_RE, MAX_TITLE, MIN_TITLE, EXACT_MALL, SEARCH_LIMIT, OFFER_POOL, MAX_OFFERS, SERIES_DAYS,
  TIMING_HORIZON, LIVE_MALLS, WAITROOM_PATH, STOPWORDS,
  cleanTitle, readQuery, searchPlans, rankSimilar, offerCandidates, buildOffers,
  waitroomUrl, timingOf, anomalyOf, noneReasons, safeLink
};
