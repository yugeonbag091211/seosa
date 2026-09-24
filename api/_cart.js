'use strict';
/*
 * ⑤ 장바구니 최저가 — 순수 계산부. DB 도 네트워크도 모른다.
 *
 * ── 무엇을 푸는가 ──────────────────────────────────────────────────
 *
 * 상품 여러 개를 «어느 판매처에서 나눠 사야» 배송비·쿠폰까지 합쳐 가장 싼가.
 *
 *   · 상품마다 가장 싼 곳을 고르면(cheapestEach) 판매처마다 배송비가 한 번씩
 *     붙는다. 무료배송 기준과 쿠폰 최소 주문 금액은 «그 판매처에서 산 금액의
 *     합» 으로 판정되므로, 조금 비싼 상품을 한 곳에 몰아 사는 쪽이 전체로는
 *     더 쌀 수 있다.
 *   · 그렇다고 한 곳에 몰아 사는 것(singleMall)이 답인 것도 아니다. 값 차이가
 *     배송비보다 크면 나눠 사는 쪽이 싸다.
 *
 * 두 기준 모두 이 파일이 함께 계산해서 돌려준다. 사용자가 «얼마나 아꼈는지» 를
 * 말하려면 비교 대상이 있어야 하고, 그 비교 대상도 같은 배송비·쿠폰 규칙으로
 * 계산해야 공정하다.
 *
 * ── 이 파일이 지키는 원칙 ──────────────────────────────────────────
 *
 * 1) 같은 상품이라는 판정은 _identity.judgeSameProduct(tier A) 와
 *    _hotgroup.canMerge 를 «둘 다» 통과해야 한다. 제목이 닮았다는 이유만으로
 *    다른 판매처 가격을 붙이지 않는다 (_hotgroup.js 첫 주석: false merge < duplicate).
 *    256GB 와 512GB, 블랙과 화이트, 1개와 2개를 한 줄에 놓고 "여기가 더 싸다" 고
 *    말하면 그건 틀린 값이다. 확신이 없으면 excluded 에 이유와 함께 남긴다.
 * 2) 쿠폰은 사용자가 입력한 것만 쓴다. 판매처 쿠폰을 확인할 수단이 없으므로
 *    지어내지 않는다 (CONTRACTS.md §3 ⑤).
 * 3) 배송비는 입력값 → 기본 추정치 순이다. 판매처별 정책을 아는 척하지 않는다 —
 *    모든 판매처에 같은 추정치를 쓰고, 그 사실을 assumptions 에 적는다.
 * 4) 재고 API 는 없다. «최근에 가격을 확인했다» 가 판매 중이라는 유일한 신호다.
 *    오래 확인하지 못한 판매처는 계산에서 빼고 이유를 보여 준다.
 * 5) 최적화는 정확해야 한다. 휴리스틱으로 찾은 조합을 «최저가» 라고 부르지
 *    않는다. 분기 한정(branch-and-bound)으로 전부를 따지고, 노드 상한에 걸리면
 *    optimal:false 로 솔직하게 말한다.
 *
 * 금액은 전부 원 단위 정수다. 정률 쿠폰의 원 미만은 버린다(할인을 부풀리지 않는 쪽).
 */

const { judgeSameProduct, idTokens, modelCodes, overlap, normTitle, colors } = require('./_identity');
const HG = require('./_hotgroup');
const { productLifecycle, vendorIdOf, kstToday, MAX_DISPLAY_AGE_DAYS, OPTION_SWITCH_RATIO } = require('./_price');

/* ==================================================================
 *  상수 — 각각 왜 그 값인지
 * ================================================================== */

/**
 * 한 번에 계산하는 상품 수. 정확 탐색의 최악 시간은 상품 수에 지수로 는다.
 * 20 이면 판매처 후보가 넉넉해도 노드 상한(아래) 안에서 대부분 끝난다
 * (scripts/test-v2-cart.js 가 20개짜리 최악 사례를 재서 남긴다).
 */
const MAX_ITEMS = 20;
/** 수량 상한. 두 자리면 장바구니 용도로 충분하고, 금액 합이 정수 범위를 넘지 않는다. */
const MAX_QTY = 99;
/** 쿠폰 개수 상한. 몰마다 최선 하나를 고르는 계산이 노드마다 돌므로 작게 둔다. */
const MAX_COUPONS = 10;
/** 배송비 입력을 받을 판매처 수 상한 (본문 크기와 별개로 키 폭주를 막는다). */
const MAX_SHIPPING_MALLS = 30;
/** 배송비 상한. 도서산간·설치배송도 이 안에 든다. 이보다 크면 입력 실수로 본다. */
const MAX_FEE = 100000;
/** 금액 상한 — _price.MAX_PRICE(1억)와 같은 선. */
const MAX_MONEY = 100000000;
/** 본문 크기 상한. 상품 20개 + 쿠폰 10개가 넉넉히 들어가고 그 이상은 남용이다. */
const MAX_BODY_BYTES = 32 * 1024;
/** 상품명만으로 찾을 때 필요한 최소 글자 수. 한 글자로는 후보가 무의미하게 넓다. */
const MIN_TITLE = 2;
const MAX_TITLE = 300;
/** 정률 쿠폰 범위. 90% 를 넘는 쿠폰은 현실적으로 입력 실수다. */
const MIN_PERCENT = 1;
const MAX_PERCENT = 90;

/**
 * 배송비 기본 추정치 — 사용자가 입력하지 않은 판매처에 쓴다.
 *
 * ★ 판매처별 정책을 지어내지 않는다. 쿠팡 로켓배송·와우 회원 여부, 오픈마켓
 *   판매자별 정책을 우리는 알 수 없다(isRocket/isFreeShipping 은 저장하지 않는다).
 *   그래서 모든 판매처에 같은 값을 쓰고, 계산 결과에 «추정» 이라고 적는다.
 *   3,000원 · 30,000원 이상 무료는 국내 오픈마켓에서 가장 흔한 조합이다.
 */
const DEFAULT_SHIPPING = Object.freeze({ fee: 3000, freeOver: 30000 });

/**
 * 분기 한정 탐색 노드 상한. 넘으면 그때까지 찾은 최선을 optimal:false 로 돌려준다.
 * 노드 하나는 몰 수만큼의 하한 계산이라 20만 노드도 서버리스 한 요청에서 수백 ms 안이다.
 */
const NODE_CAP = 200000;
/** 단일 몰 기준선 탐색의 상한 (몰 하나 안에서는 후보가 적어 거의 쓰이지 않는다). */
const SINGLE_MALL_NODE_CAP = 20000;
/** 시작 해를 다듬는 국소 개선의 최대 반복 수. 수렴은 보통 2~3회다. */
const LOCAL_PASSES = 20;

/**
 * excluded 에 보여 줄 «근처 후보» 의 제목 겹침 하한(자카드).
 *
 * 후보군은 같은 검색어로 수집된 최대 60개라 케이스·충전기 같은 무관한 상품이
 * 대부분이다. 그것까지 "다른 상품이라 뺐어요" 로 늘어놓으면 정작 알려야 할
 * «256GB 는 있는데 512GB 라서 뺐다» 가 묻힌다. 이 값은 병합 판정이 아니라
 * «무엇을 보여 줄지» 만 정한다 — 병합은 오직 tier A + canMerge 로 한다.
 */
const NEAR_MISS_JACCARD = 0.5;
/** 상품당 보여 줄 제외 후보 수. */
const MAX_EXCLUDED_PER_ITEM = 12;
/** 상품명으로 못 찾았을 때 제안할 후보 수. */
const MAX_SUGGESTIONS = 3;
/** 제안 후보의 최소 겹침(min 기준). 이보다 낮으면 제안이 오히려 혼란을 준다. */
const SUGGEST_MIN_OVERLAP = 0.5;

/** 검색 단서로 쓰지 않을 흔한 낱말 — 어느 상품에나 붙어서 후보를 좁히지 못한다. */
const SEARCH_STOP = new Set(['무료배송', '정품', '공식', '당일발송', '국내', '새상품', '특가', '최신', '신상',
  '인기', '추천', '선택', '옵션', '단품', '국내정품', '정식', '당일', '발송', '빠른배송']);

const COUPANG = '쿠팡';

/* ==================================================================
 *  작은 도구
 * ================================================================== */

function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 200); }

/** 숫자 또는 숫자 문자열만 받는다. 나머지는 NaN. ('' · null · true · [] 를 0 으로 읽지 않는다) */
function num(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return NaN;
}

function blank(v) { return v === undefined || v === null || v === ''; }

function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

/** 판매처 이름 비교용 키 — 공백·대소문자 차이로 사용자가 입력한 배송비·쿠폰이 빗나가지 않게. */
function mallKey(label) {
  return String(label == null ? '' : label).normalize('NFC').replace(/\s+/g, '').toLowerCase();
}

/** 'YYYY-MM-DD' 두 개 사이의 일수. 못 읽으면 null. */
function daysBetween(a, b) {
  const re = /^(\d{4})-(\d{2})-(\d{2})$/;
  const ma = re.exec(String(a || '')), mb = re.exec(String(b || ''));
  if (!ma || !mb) return null;
  const ta = Date.UTC(+ma[1], +ma[2] - 1, +ma[3]);
  const tb = Date.UTC(+mb[1], +mb[2] - 1, +mb[3]);
  return Math.round((tb - ta) / 86400000);
}

/** ISO 시각 → KST 'YYYY-MM-DD'. 못 읽으면 null. */
function kstDateOf(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? kstToday(t) : null;
}

function won(n) { return `${Math.round(Number(n) || 0).toLocaleString('ko-KR')}원`; }

/* ==================================================================
 *  1) 입력 검증
 * ================================================================== */

/**
 * 요청 본문 → 정규화된 장바구니. 틀린 입력은 «사람이 읽는 한 문장» 으로 거절한다.
 *
 * 조용히 고쳐 쓰지 않는다. 수량 0 을 1 로, 95% 쿠폰을 90% 로 바꿔 계산하면
 * 사용자는 자기가 넣은 조건으로 계산된 줄 안다 — 틀린 결론을 믿게 된다.
 *
 * @returns {{ok:true, value:{items, shipping, coupons}} | {ok:false, error:string}}
 */
function validateCart(body) {
  const bad = error => ({ ok: false, error });
  if (!isObj(body)) return bad('장바구니 정보를 읽지 못했어요.');

  const raw = body.items;
  if (!Array.isArray(raw) || raw.length === 0) return bad('담은 상품이 없어요. 상품을 1개 이상 넣어 주세요.');
  if (raw.length > MAX_ITEMS) return bad(`상품은 한 번에 ${MAX_ITEMS}개까지 계산할 수 있어요.`);

  const items = [];
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i];
    const n = i + 1;
    if (!isObj(it)) return bad(`${n}번째 상품 정보를 읽지 못했어요.`);

    const productId = blank(it.productId) ? '' : str(it.productId, 200);
    if (productId && !/^\w{1,128}$/.test(productId)) return bad(`${n}번째 상품 번호 형식이 올바르지 않아요.`);

    const mall = blank(it.mall) ? '' : str(it.mall, 100);
    if (mall.length > 40) return bad(`${n}번째 상품의 판매처 이름이 너무 길어요.`);

    const vendorItemId = blank(it.vendorItemId) ? '' : str(it.vendorItemId, 100);
    if (vendorItemId && !/^[\w-]{1,64}$/.test(vendorItemId)) return bad(`${n}번째 상품의 옵션 번호 형식이 올바르지 않아요.`);

    const title = blank(it.title) ? '' : String(it.title).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
    if (!productId && title.length < MIN_TITLE) {
      return bad(`${n}번째 상품에 상품 번호나 상품명(${MIN_TITLE}자 이상)을 넣어 주세요.`);
    }

    let quantity = 1;
    if (!blank(it.quantity)) {
      quantity = num(it.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) {
        return bad(`${n}번째 상품의 수량은 1~${MAX_QTY} 사이의 정수여야 해요.`);
      }
    }
    items.push({ productId, mall, vendorItemId, title, quantity });
  }

  /* ── 배송비 ── */
  const shipping = {};          // mallKey → { label, fee, freeOver }
  if (!blank(body.shipping)) {
    if (!isObj(body.shipping)) return bad('배송비 정보 형식이 올바르지 않아요.');
    const keys = Object.keys(body.shipping);
    if (keys.length > MAX_SHIPPING_MALLS) return bad(`배송비는 판매처 ${MAX_SHIPPING_MALLS}곳까지 넣을 수 있어요.`);
    for (const k of keys) {
      const label = String(k).trim();
      if (!label || label.length > 40) return bad('배송비의 판매처 이름을 확인해 주세요 (1~40자).');
      const v = body.shipping[k];
      if (!isObj(v)) return bad(`'${label}' 배송비 정보 형식이 올바르지 않아요.`);
      const fee = num(v.fee);
      if (!Number.isFinite(fee) || fee < 0 || fee > MAX_FEE) {
        return bad(`'${label}' 배송비는 0~${MAX_FEE.toLocaleString('ko-KR')}원 사이여야 해요.`);
      }
      let freeOver = null;
      if (!blank(v.freeOver)) {
        freeOver = num(v.freeOver);
        if (!Number.isFinite(freeOver) || freeOver < 0 || freeOver > MAX_MONEY) {
          return bad(`'${label}' 무료배송 기준 금액은 0원 이상이어야 해요.`);
        }
        freeOver = Math.round(freeOver);
      }
      shipping[mallKey(label)] = { label, fee: Math.round(fee), freeOver };
    }
  }

  /* ── 쿠폰 ── */
  const coupons = [];
  if (!blank(body.coupons)) {
    if (!Array.isArray(body.coupons)) return bad('쿠폰 정보 형식이 올바르지 않아요.');
    if (body.coupons.length > MAX_COUPONS) return bad(`쿠폰은 ${MAX_COUPONS}개까지 넣을 수 있어요.`);
    for (let i = 0; i < body.coupons.length; i++) {
      const c = body.coupons[i];
      const n = i + 1;
      if (!isObj(c)) return bad(`${n}번째 쿠폰 정보를 읽지 못했어요.`);
      const mall = str(c.mall, 100);
      if (!mall || mall.length > 40) return bad(`${n}번째 쿠폰의 판매처를 넣어 주세요.`);
      const hasAmount = !blank(c.amount), hasPercent = !blank(c.percent);
      if (hasAmount && hasPercent) return bad(`${n}번째 쿠폰은 금액 할인과 비율 할인 중 하나만 넣어 주세요.`);
      if (!hasAmount && !hasPercent) return bad(`${n}번째 쿠폰의 할인 금액이나 할인율을 넣어 주세요.`);
      const out = { mall, key: mallKey(mall), amount: null, percent: null, minSpend: 0, maxDiscount: null, index: i };
      if (hasAmount) {
        const a = num(c.amount);
        if (!Number.isFinite(a) || a < 1 || a > MAX_MONEY) return bad(`${n}번째 쿠폰의 할인 금액은 1원 이상이어야 해요.`);
        out.amount = Math.round(a);
      } else {
        const p = num(c.percent);
        if (!Number.isFinite(p) || p < MIN_PERCENT || p > MAX_PERCENT) {
          return bad(`${n}번째 쿠폰의 할인율은 ${MIN_PERCENT}~${MAX_PERCENT}% 사이여야 해요.`);
        }
        out.percent = p;
      }
      if (!blank(c.minSpend)) {
        const m = num(c.minSpend);
        if (!Number.isFinite(m) || m < 0 || m > MAX_MONEY) return bad(`${n}번째 쿠폰의 최소 주문 금액은 0원 이상이어야 해요.`);
        out.minSpend = Math.round(m);
      }
      if (!blank(c.maxDiscount)) {
        const m = num(c.maxDiscount);
        if (!Number.isFinite(m) || m < 1 || m > MAX_MONEY) return bad(`${n}번째 쿠폰의 최대 할인 금액은 1원 이상이어야 해요.`);
        out.maxDiscount = Math.round(m);
      }
      coupons.push(out);
    }
  }

  return { ok: true, value: { items, shipping, coupons } };
}

/* ==================================================================
 *  2) 배송비 · 쿠폰 계산 — 몰 하나의 소계 S 에 대해
 * ================================================================== */

/**
 * 배송비. 소계가 0 이면(그 몰에서 아무것도 안 사면) 0.
 * freeOver 가 null 이면 무료배송 기준이 없는 것이다(항상 fee). 0 이면 항상 무료.
 */
function shippingFor(rule, subtotal) {
  if (!(subtotal > 0)) return 0;
  if (rule.freeOver != null && subtotal >= rule.freeOver) return 0;
  return rule.fee;
}

/**
 * 쿠폰 하나의 할인액.
 *   정액 → amount (maxDiscount 가 있으면 그 이하)
 *   정률 → floor(소계 × percent / 100), maxDiscount 이하
 * 최소 주문 금액은 배송비를 뺀 상품 소계로 본다. 할인은 소계를 넘지 않는다.
 */
function couponDiscount(c, subtotal) {
  if (!(subtotal > 0) || subtotal < (c.minSpend || 0)) return 0;
  let d = c.amount != null ? c.amount : Math.floor(subtotal * c.percent / 100);
  if (c.maxDiscount != null && d > c.maxDiscount) d = c.maxDiscount;
  if (d > subtotal) d = subtotal;
  return d > 0 ? d : 0;
}

/** 몰마다 쿠폰은 가장 유리한 하나만 (중복 적용을 가정하지 않는다). */
function bestCoupon(coupons, subtotal) {
  let best = 0, index = -1;
  for (let i = 0; i < coupons.length; i++) {
    const d = couponDiscount(coupons[i], subtotal);
    if (d > best) { best = d; index = i; }
  }
  return { discount: best, index };
}

/**
 * 몰 하나의 «상품값 밖» 비용 = 배송비 − 쿠폰. 소계 0 이면 0.
 *
 * ★ 이 함수는 소계 S > 0 에서 S 에 대해 «증가하지 않는다».
 *     배송비: fee → (기준 이상이면) 0 — 증가하지 않는다
 *     쿠폰:   쓸 수 있는 쿠폰이 늘고 각 할인액도 S 와 함께 늘거나 같다 — 감소하지 않는다
 *   분기 한정의 하한(아래 search)이 이 성질에 기대어 정확성을 잃지 않는다.
 */
function extraOf(rule, subtotal) {
  if (!(subtotal > 0)) return 0;
  return shippingFor(rule, subtotal) - bestCoupon(rule.coupons, subtotal).discount;
}

function ruleOf(r) {
  const x = r || {};
  return {
    fee: Number.isFinite(x.fee) ? x.fee : DEFAULT_SHIPPING.fee,
    freeOver: x.freeOver === undefined ? DEFAULT_SHIPPING.freeOver : x.freeOver,
    coupons: Array.isArray(x.coupons) ? x.coupons : []
  };
}

/* ==================================================================
 *  3) 최적화 — 정확 분기 한정
 * ================================================================== */

/**
 * 문제를 정수 배열로 굳힌다.
 *
 * 같은 줄 안에서 (몰, 금액) 이 같은 후보는 하나만 남긴다 — 비용 함수가 몰별
 * 소계에만 의존하므로 서로 바꿔도 총액이 같다. 반면 «같은 몰의 더 비싼 후보» 는
 * 버리지 않는다. 무료배송 기준을 넘기려고 같은 몰에서 조금 비싼 걸 고르는 게
 * 이득일 수 있어서, 그 가지치기는 정확하지 않다.
 */
function prepare(lines, rules, onlyGroup) {
  const groupIndex = new Map();
  const groups = [];
  lines.forEach(l => (l.offers || []).forEach(o => {
    if (onlyGroup != null && o.group !== onlyGroup) return;
    if (!groupIndex.has(o.group)) { groupIndex.set(o.group, groups.length); groups.push(o.group); }
  }));
  const M = groups.length;
  const R = groups.map(g => ruleOf(rules && rules[g]));

  const L = lines.map(l => {
    const q = l.quantity || 1;
    const seen = new Set();
    const opts = [];
    (l.offers || []).forEach((o, k) => {
      if (onlyGroup != null && o.group !== onlyGroup) return;
      const cost = Math.round(o.unitPrice) * q;
      const m = groupIndex.get(o.group);
      const key = `${m}:${cost}`;
      if (seen.has(key)) return;
      seen.add(key);
      opts.push({ k, m, cost });
    });
    opts.sort((a, b) => a.cost - b.cost || a.k - b.k);
    let minCost = Infinity, maxCost = 0;
    const maxByMall = new Float64Array(M);
    opts.forEach(o => {
      if (o.cost < minCost) minCost = o.cost;
      if (o.cost > maxCost) maxCost = o.cost;
      if (o.cost > maxByMall[o.m]) maxByMall[o.m] = o.cost;
    });
    return { opts, minCost, spread: opts.length ? maxCost - minCost : 0, maxByMall };
  });
  return { groups, R, M, L };
}

/** 배정(줄마다 opts 인덱스) → 총액과 명세. 모든 기준선과 탐색이 이 한 함수로 총액을 잰다. */
function evaluate(ctx, picks) {
  const S = new Float64Array(ctx.M);
  let items = 0;
  ctx.L.forEach((l, i) => { const o = l.opts[picks[i]]; S[o.m] += o.cost; items += o.cost; });
  let shipping = 0, coupon = 0, used = 0;
  for (let m = 0; m < ctx.M; m++) {
    if (!(S[m] > 0)) continue;
    used++;
    shipping += shippingFor(ctx.R[m], S[m]);
    coupon += bestCoupon(ctx.R[m].coupons, S[m]).discount;
  }
  return { total: items + shipping - coupon, items, shipping, coupon, used, S };
}

/** 총액이 같으면 몰 수(= 택배 수)가 적은 쪽이 낫다. */
function better(t1, u1, t2, u2) { return t1 < t2 || (t1 === t2 && u1 < u2); }

/** 탐욕 시작 해: 정해진 순서로 «지금 넣으면 총액이 가장 적게 느는» 후보를 고른다. */
function greedy(ctx, order) {
  const S = new Float64Array(ctx.M);
  const picks = new Array(ctx.L.length).fill(0);
  order.forEach(i => {
    const l = ctx.L[i];
    let bestJ = 0, bestD = Infinity;
    l.opts.forEach((o, j) => {
      const d = o.cost + extraOf(ctx.R[o.m], S[o.m] + o.cost) - extraOf(ctx.R[o.m], S[o.m]);
      if (d < bestD) { bestD = d; bestJ = j; }
    });
    picks[i] = bestJ;
    S[l.opts[bestJ].m] += l.opts[bestJ].cost;
  });
  return picks;
}

/**
 * 국소 개선: 한 줄의 판매처를 바꿔서 총액이 줄면 바꾼다. 더 줄지 않을 때까지.
 * 정확성과는 무관하다 — 분기 한정의 첫 기준값을 낮춰서 가지치기를 빨리 시작하게 할 뿐이다.
 */
function improve(ctx, start) {
  const picks = start.slice();
  const S = new Float64Array(ctx.M);
  ctx.L.forEach((l, i) => { const o = l.opts[picks[i]]; S[o.m] += o.cost; });
  for (let pass = 0; pass < LOCAL_PASSES; pass++) {
    let moved = false;
    ctx.L.forEach((l, i) => {
      const cur = l.opts[picks[i]];
      let bestJ = -1, bestD = 0;
      l.opts.forEach((o, j) => {
        if (j === picks[i]) return;
        let d;
        if (o.m === cur.m) {
          d = (o.cost - cur.cost) + extraOf(ctx.R[o.m], S[o.m] - cur.cost + o.cost) - extraOf(ctx.R[o.m], S[o.m]);
        } else {
          d = (o.cost - cur.cost)
            + extraOf(ctx.R[o.m], S[o.m] + o.cost) - extraOf(ctx.R[o.m], S[o.m])
            + extraOf(ctx.R[cur.m], S[cur.m] - cur.cost) - extraOf(ctx.R[cur.m], S[cur.m]);
        }
        if (d < bestD) { bestD = d; bestJ = j; }
      });
      if (bestJ > -1) {
        const o = l.opts[bestJ];
        S[cur.m] -= cur.cost; S[o.m] += o.cost;
        picks[i] = bestJ;
        moved = true;
      }
    });
    if (!moved) break;
  }
  return picks;
}

/**
 * 몰별 쿠폰 할인의 «오목 덮개» h(S) = min(cap, rate·S).
 *
 * 쿠폰 하나의 할인 D(S) 는 언제나 이 덮개 아래에 있다.
 *   정액 amount(최소 주문 ms): S < ms 면 0, 아니면 min(amount', S) ≤ amount' ≤ (amount'/ms)·S
 *   정률 p%:                   floor(S·p/100) ≤ (p/100)·S, maxDiscount 이하
 *   그리고 할인은 소계를 넘지 않으므로 기울기는 1 이하
 * 몰 안에서는 cap · rate 를 각각 최댓값으로 잡는다 — 여러 쿠폰의 max 는 오목하지 않을 수
 * 있지만, 최댓값끼리 만든 min(cap, rate·S) 는 오목하고 그 위에 있다.
 */
function couponEnvelopes(R) {
  const env = [];
  R.forEach((r, m) => {
    let cap = 0, rate = 0;
    r.coupons.forEach(c => {
      let cc, rr;
      if (c.amount != null) {
        cc = c.maxDiscount != null ? Math.min(c.amount, c.maxDiscount) : c.amount;
        rr = c.minSpend > 0 ? Math.min(1, cc / c.minSpend) : 1;
      } else {
        cc = c.maxDiscount != null ? c.maxDiscount : Infinity;
        rr = Math.min(1, c.percent / 100);
      }
      if (cc > cap) cap = cc;
      if (rr > rate) rate = rr;
    });
    if (cap > 0 && rate > 0) env.push({ m, cap, rate, knee: cap / rate });
  });
  return env.sort((a, b) => b.rate - a.rate || a.m - b.m);
}

/**
 * 쿠폰 합의 상한 — 분수 배낭.
 *   최대화  Σ h_m(S_m)   조건  Σ S_m ≤ 총 지출 상한,  0 ≤ S_m ≤ 그 몰의 도달 가능 최대 소계
 * h 가 오목한 조각 선형이므로 기울기(rate)가 큰 몰부터 채우는 것이 이 완화 문제의 정확한 최댓값이다.
 * 제약을 풀어서 얻은 값이라 실제 쿠폰 합보다 작아질 수 없다.
 */
function couponCap(env, S, sufMax, row, cnt, budget) {
  let left = budget, total = 0;
  for (let i = 0; i < env.length && left > 0; i++) {
    const e = env[i];
    const add = sufMax[row + e.m];
    if (cnt[e.m] === 0 && !(add > 0)) continue;
    const take = Math.min(left, S[e.m] + add, e.knee);
    total += e.rate * take;
    left -= take;
  }
  return total;
}

/** 몰의 (배송비 − 쿠폰) 이 계단을 내려가는 소계 — 무료배송 기준과 쿠폰 최소 주문 금액. */
function thresholdsOf(rule) {
  const t = new Set();
  if (rule.freeOver != null && rule.freeOver > 0) t.add(rule.freeOver);
  rule.coupons.forEach(c => { if (c.minSpend > 0) t.add(c.minSpend); });
  return [...t].sort((a, b) => a - b);
}

/**
 * 깊이 d 에서 남은 줄들로 몰 m 의 소계를 X 만큼 더 채우는 데 드는 «최소 웃돈» 곡선.
 *
 * 웃돈 = 그 후보의 값 − 그 줄의 최저값. 분수로 담아도 된다고 풀고(줄 하나에서 같은 몰
 * 후보 여럿을 동시에 담는 것도 허용 — 더 풀어 줄수록 값이 작아질 뿐이라 하한으로 안전하다)
 * 웃돈/금액 비율이 작은 것부터 채우면 그 완화 문제의 최소가 된다. 남은 줄의 집합은
 * 탐색 경로와 무관하게 깊이만으로 정해지므로 탐색 전에 한 번 만든다.
 */
function premiumCurves(L, order, M) {
  const n = order.length;
  const curves = new Array((n + 1) * M);
  for (let m = 0; m < M; m++) {
    const acc = [];
    curves[n * M + m] = { c: [0], p: [0] };
    for (let d = n - 1; d >= 0; d--) {
      const l = L[order[d]];
      l.opts.forEach(o => { if (o.m === m && o.cost > 0) acc.push({ c: o.cost, p: o.cost - l.minCost }); });
      const sorted = acc.slice().sort((a, b) => a.p / a.c - b.p / b.c);
      const c = [0], p = [0];
      sorted.forEach(x => { c.push(c[c.length - 1] + x.c); p.push(p[p.length - 1] + x.p); });
      curves[d * M + m] = { c, p };
    }
  }
  return curves;
}

/** 곡선에서 X 만큼 채우는 최소 웃돈 (채울 수 없으면 Infinity). */
function minPremium(curve, X) {
  if (!(X > 0)) return 0;
  const c = curve.c, p = curve.p;
  if (X > c[c.length - 1]) return Infinity;
  let lo = 1, hi = c.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (c[mid] >= X) hi = mid; else lo = mid + 1; }
  const seg = c[lo] - c[lo - 1];
  return p[lo - 1] + (seg > 0 ? (X - c[lo - 1]) * (p[lo] - p[lo - 1]) / seg : 0);
}

/**
 * 한 구간 [start, right] 안에서 «웃돈 + 배송비 − 쿠폰» 의 하한 — 쿠폰이 소계에 비례해
 * 커질 때(최대 할인 없는 정률 쿠폰) 필요하다.
 *
 * 구간 안에서는 배송비와 «쓸 수 있는 쿠폰» 이 고정이다(구간 끝이 기준 금액이므로).
 * 몰당 쿠폰은 가장 유리한 하나이므로  배송비 − max_c D_c(S) = min_c (배송비 − D_c(S)) 이고,
 * 구간 최소는 «쿠폰마다 따로 구한 최소» 중 가장 작은 값과 같다. 쿠폰 하나는
 *   D_c(S) ≤ min(cap_c, rate_c·S)   (정액은 rate 1 — 할인은 소계를 넘지 않는다)
 * 이므로  g_c(S) = 최소웃돈(S − s0) + 배송비 − min(cap_c, rate_c·S)  는 볼록(볼록 + 오목의 음수)
 * 하고, 최소점은 «웃돈 곡선의 기울기가 rate_c 를 넘는 첫 지점» 을 [start, min(right, cap/rate)]
 * 로 자른 곳이다. 그 너머는 기울기가 0 이상이라 늘기만 한다.
 *
 * 구간 끝값만 쓰는 하한(extraOf(right))은 할인을 «최대 소계에서» 받는다고 보면서 그 소계를
 * 채우는 웃돈은 구간 시작까지만 센다 — 이 하한이 그 틈을 메운다.
 */
function intervalFloor(rule, curve, s0, start, right) {
  const s1 = Math.max(start, 1);
  const fee = shippingFor(rule, s1);
  const c = curve.c, p = curve.p;
  const reach = s0 + c[c.length - 1];
  let best = minPremium(curve, start - s0) + fee;          // 쿠폰 없이
  for (const cp of rule.coupons) {
    if ((cp.minSpend || 0) > s1) continue;                  // 이 구간에서는 못 쓰는 쿠폰
    const cap = cp.amount != null
      ? (cp.maxDiscount != null ? Math.min(cp.amount, cp.maxDiscount) : cp.amount)
      : (cp.maxDiscount != null ? cp.maxDiscount : Infinity);
    const rate = cp.amount != null ? 1 : Math.min(1, cp.percent / 100);
    // 기울기(웃돈/금액)가 rate 이상이 되는 첫 조각의 시작
    let lo = 1, hi = c.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const seg = c[mid] - c[mid - 1];
      const ratio = seg > 0 ? (p[mid] - p[mid - 1]) / seg : 0;
      if (ratio >= rate) hi = mid; else lo = mid + 1;
    }
    const top = Math.max(start, Math.min(right, reach, cap / rate));
    const sStar = Math.min(Math.max(s0 + c[lo - 1], start), top);
    const v = minPremium(curve, sStar - s0) + fee - Math.min(cap, rate * sStar);
    if (v < best) best = v;
  }
  return best;
}

/**
 * 정확 분기 한정.
 *
 * ── 순서 ──────────────────────────────────────────────────────────
 * 후보가 적은 줄부터, 같으면 값 차이(spread)가 큰 줄부터 정한다. 선택지가 적은
 * 줄을 먼저 고정하면 가지가 좁게 시작하고, 값 차이가 큰 줄을 먼저 정하면 하한이
 * 빨리 조여진다. 자식은 «지금 넣으면 총액이 가장 적게 느는» 순으로 탐색한다.
 *
 * ── 하한 (admissible — 절대 실제보다 크지 않다) ────────────────────
 * 계약이 적은 기본형은  «고른 상품값 + 남은 줄의 최저값 − Σ_몰 최대 쿠폰, 배송비 0» 이다.
 * 여기서는 그것보다 항상 크거나 같은(= 더 많이 자르는) 두 하한의 큰 쪽을 쓴다.
 *
 *   ① 몰별 분해 (premiumCurves · intervalFloor)
 *      총액 = 고른 상품값 + Σ 남은 줄의 최저값 + Σ_몰 [웃돈 + 배송비 − 쿠폰]
 *      «웃돈» 은 그 몰로 보낸 줄이 자기 최저값보다 더 낸 돈이다. 무료배송·쿠폰을 열려면
 *      그 몰에 소계를 채워야 하고, 채우려면 웃돈을 내야 한다 — 기본형은 이 대가를 모른다.
 *      몰마다 괄호를 «혼자» 최소화하면(줄을 여러 몰이 나눠 가져도 된다고 풀면) 합은
 *      실제보다 작거나 같다. 한 몰 안에서는 기준 금액 사이 구간마다 따로 최소를 구한다.
 *   ② 쿠폰 합의 상한 (couponCap)
 *      몰마다 쿠폰 최소 금액을 «전부» 채울 돈은 없다. 총 지출 상한 안에서 쿠폰 합의
 *      상한을 분수 배낭으로 구해 빼고, 쓰기 시작한 몰의 피할 수 없는 배송비를 더한다.
 *
 * 올바름은 테스트가 고정한다: 결정론 난수 사례 수백 개에서 완전 탐색과 같은 총액·같은
 * 택배 수를 내야 한다 (scripts/test-v2-cart.js).
 *
 * ── 동점 ──────────────────────────────────────────────────────────
 * 총액이 같으면 택배(몰) 수가 적은 쪽을 고른다. 몰 수는 지금 쓰는 몰 수보다 줄 수
 * 없으므로 «하한 = 현재 최선 이고 몰 수도 못 줄인다» 면 자른다.
 */
function search(ctx, seeds, nodeCap) {
  const { L, M, R } = ctx;
  const n = L.length;
  /*
   * 같은 상품을 수량 대신 여러 줄로 담으면 똑같은 줄이 생긴다. 그 줄들끼리 판매처를
   * 맞바꾼 배정은 총액도 택배 수도 같으므로, «앞 줄의 선택 이하로는 고르지 않는다»
   * 는 대칭 깨기로 한 가지만 본다(어떤 최적해든 그렇게 줄 세울 수 있으므로 정확하다).
   * 서명이 같은 줄이 이웃하도록 정렬 키에 넣는다.
   */
  const sig = L.map(l => l.opts.map(o => `${o.m}:${o.cost}`).join(','));
  const order = L.map((_, i) => i).sort((a, b) =>
    L[a].opts.length - L[b].opts.length || L[b].spread - L[a].spread
    || (sig[a] < sig[b] ? -1 : sig[a] > sig[b] ? 1 : 0) || a - b);
  const twinOfPrev = order.map((li, d) => d > 0 && sig[li] === sig[order[d - 1]]);

  const sufMin = new Float64Array(n + 1);
  const sufMax = new Float64Array((n + 1) * M);
  const sufAny = new Float64Array(n + 1);          // 남은 줄이 낼 수 있는 최대 상품값 (몰 무관)
  for (let d = n - 1; d >= 0; d--) {
    const l = L[order[d]];
    sufMin[d] = sufMin[d + 1] + l.minCost;
    sufAny[d] = sufAny[d + 1] + (l.opts.length ? l.opts[l.opts.length - 1].cost : 0);
    for (let m = 0; m < M; m++) sufMax[d * M + m] = sufMax[(d + 1) * M + m] + l.maxByMall[m];
  }
  const env = couponEnvelopes(R);
  const TH = R.map(thresholdsOf);
  const curves = premiumCurves(L, order, M);

  let best = Infinity, bestUsed = Infinity, bestPicks = null;
  (seeds || []).forEach(p => {
    if (!p) return;
    const e = evaluate(ctx, p);
    if (better(e.total, e.used, best, bestUsed)) { best = e.total; bestUsed = e.used; bestPicks = p.slice(); }
  });

  const S = new Float64Array(M);
  const cnt = new Int32Array(M);
  const cur = new Array(n).fill(0);
  let used = 0, nodes = 0, capped = false;

  function dfs(d, items) {
    if (nodes >= nodeCap) { capped = true; return; }
    nodes++;
    if (d === n) {
      let t = items;
      for (let m = 0; m < M; m++) if (cnt[m] > 0) t += extraOf(R[m], S[m]);
      if (better(t, used, best, bestUsed)) { best = t; bestUsed = used; bestPicks = cur.slice(); }
      return;
    }
    /*
     * 하한 두 개 중 큰 쪽 (둘 다 과소평가만 하므로 큰 쪽도 하한이다).
     *
     *   ① 몰별 분해. 총액 = 고른 상품값 + Σ 남은 줄의 최저값
     *                     + Σ_몰 [ 그 몰로 보낸 줄의 웃돈(최저값보다 더 낸 돈) + 배송비 − 쿠폰 ]
     *      몰마다 괄호 안을 «그 몰 혼자» 최소로 만들면(줄을 여러 몰이 나눠 가져도 된다고
     *      풀어 주면) 합은 실제보다 작거나 같다. 한 몰의 최소는 기준 금액(무료배송·쿠폰
     *      최소 주문) 사이 구간마다 «구간 시작까지 채우는 최소 웃돈(premiumCurves)
     *      + 구간 끝의 (배송비 − 쿠폰)» 으로 아래에서 막는다 — 웃돈은 소계에 대해 늘기만
     *      하고 (배송비 − 쿠폰)은 줄기만 하므로 구간 안 어느 점보다도 작다.
     *      아직 빈 몰은 끝까지 안 쓸 수도 있으므로 0 과 비교한다.
     *      → 계약이 적은 하한(상품 최저값 − 몰별 최대 쿠폰, 배송비 0)보다 항상 크거나 같다.
     *   ② 쿠폰을 한데 묶어: 남은 돈을 다 써도 쿠폰 최소 금액을 «전부» 채울 수는 없다.
     *      총 지출 상한 안에서 쿠폰 합의 상한을 분수 배낭으로 구한다(couponCap 주석).
     */
    const base = items + sufMin[d];
    const row = d * M;
    let perMall = 0, ship = 0, dsum = 0;
    for (let m = 0; m < M; m++) {
      const add = sufMax[row + m];
      if (cnt[m] === 0 && !(add > 0)) continue;
      const r = R[m];
      const s0 = S[m], hi = s0 + add;
      const dc = r.coupons.length ? bestCoupon(r.coupons, hi).discount : 0;
      if (cnt[m] > 0) ship += shippingFor(r, hi);
      dsum += dc;
      if (!(add > 0)) { perMall += extraOf(r, s0); continue; }
      let lb = cnt[m] > 0 ? Infinity : 0;
      const th = TH[m], curve = curves[row + m];
      let ti = 0;
      while (ti < th.length && th[ti] <= s0) ti++;
      for (let start = s0; ;) {
        const next = ti < th.length && th[ti] <= hi ? th[ti] : hi + 1;
        let v = minPremium(curve, start - s0) + extraOf(r, next - 1);
        const g = intervalFloor(r, curve, s0, start, next - 1);
        if (g > v) v = g;
        if (v < lb) lb = v;
        if (next > hi) break;
        start = next; ti++;
      }
      perMall += lb;
    }
    let bound = Math.ceil(base + perMall - 1e-6);       // 실제 총액은 정수 — 올림해도 하한이다
    if (dsum > 0) {
      const cap = couponCap(env, S, sufMax, row, cnt, items + sufAny[d]);
      if (cap < dsum) {
        const joint = Math.ceil(base + ship - cap - 1e-6);
        if (joint > bound) bound = joint;
      }
    }
    // 완성하면 총액 ≥ bound, 몰 수 ≥ 지금 쓰는 몰 수. 어느 쪽으로도 나아질 수 없으면 자른다.
    if (bound > best || (bound === best && used >= bestUsed)) return;

    const li = order[d];
    const opts = L[li].opts;
    const minJ = twinOfPrev[d] ? cur[order[d - 1]] : 0;
    const kids = [];
    for (let j = minJ; j < opts.length; j++) {
      const o = opts[j];
      kids.push({ j, o, delta: o.cost + extraOf(R[o.m], S[o.m] + o.cost) - extraOf(R[o.m], S[o.m]) });
    }
    kids.sort((a, b) => a.delta - b.delta || a.o.cost - b.o.cost || a.j - b.j);
    for (const kid of kids) {
      const m = kid.o.m;
      if (cnt[m] === 0) used++;
      cnt[m]++; S[m] += kid.o.cost; cur[li] = kid.j;
      dfs(d + 1, items + kid.o.cost);
      cnt[m]--; S[m] -= kid.o.cost;
      if (cnt[m] === 0) used--;
      if (capped) return;
    }
  }

  if (n > 0) dfs(0, 0);
  return { picks: bestPicks, total: best, nodes, optimal: !capped, order };
}

/**
 * 장바구니 최적화 (순수). 계획과 두 기준선을 함께 낸다.
 *
 * @param {Array<{quantity:number, offers:Array<{group:string, unitPrice:number}>}>} lines
 *        줄마다 후보가 1개 이상이어야 한다 (호출부가 LIVE 후보 없는 상품을 미리 뺀다)
 * @param {Object<string,{fee:number, freeOver:number|null, coupons:Array}>} rules  group → 규칙
 * @param {{nodeCap?:number}} [opts]
 * @returns {{picks:number[], total, itemsCost, shippingCost, couponDiscount, optimal, searchedNodes,
 *            groups:Array<{group, lines:number[], subtotal, shipping, coupon, couponIndex, total}>,
 *            baselines:{singleMall:{group,total}|null, cheapestEach:{total}}}}
 *   picks 는 줄마다 offers 배열의 인덱스다.
 */
function optimize(lines, rules, opts) {
  const nodeCap = (opts && opts.nodeCap) || NODE_CAP;
  const list = lines || [];
  if (list.some(l => !l.offers || !l.offers.length)) throw new Error('[cart] 후보가 없는 줄이 있다');
  const ctx = prepare(list, rules, null);
  const n = ctx.L.length;

  if (!n) {
    return {
      picks: [], total: 0, itemsCost: 0, shippingCost: 0, couponDiscount: 0, optimal: true, searchedNodes: 0,
      groups: [], baselines: { singleMall: null, cheapestEach: { total: 0 } }
    };
  }

  /* ── 기준선 1: 상품마다 가장 싼 단가 (opts 가 금액 오름차순이라 0번) ── */
  const cheapPicks = ctx.L.map(() => 0);
  const cheap = evaluate(ctx, cheapPicks);

  /* ── 기준선 2: 모든 상품을 파는 몰 하나에서 전부 ── */
  let single = null;
  ctx.groups.forEach((g, m) => {
    if (!ctx.L.every(l => l.opts.some(o => o.m === m))) return;
    const sub = prepare(list, rules, g);
    const subOrder = sub.L.map((_, i) => i);
    const r = search(sub, [improve(sub, greedy(sub, subOrder))], SINGLE_MALL_NODE_CAP);
    // sub 의 opts 인덱스 → ctx 의 opts 인덱스. ctx 는 (몰, 금액) 마다 대표 하나를 남겼으므로
    // 같은 (몰, 금액) 을 찾으면 된다 — 총액은 (몰, 금액) 에만 달려 있다.
    const picks = r.picks.map((j, i) => {
      const cost = sub.L[i].opts[j].cost;
      return ctx.L[i].opts.findIndex(o => o.m === m && o.cost === cost);
    });
    const e = evaluate(ctx, picks);
    if (!single || e.total < single.total || (e.total === single.total && g < single.group)) {
      single = { group: g, total: e.total, picks };
    }
  });

  /* ── 계획: 탐욕 + 국소 개선, 그리고 두 기준선을 시작 해로 ──
   * 기준선을 시작 해로 넣으므로 계획 총액은 어떤 경우에도(노드 상한에 걸려도)
   * 두 기준선보다 크지 않다. «절약액이 음수» 는 구조적으로 나올 수 없다. */
  const order0 = ctx.L.map((_, i) => i).sort((a, b) =>
    ctx.L[a].opts.length - ctx.L[b].opts.length || ctx.L[b].spread - ctx.L[a].spread || a - b);
  const seeds = [improve(ctx, greedy(ctx, order0)), cheapPicks, single ? single.picks : null];
  const r = search(ctx, seeds, nodeCap);
  const e = evaluate(ctx, r.picks);

  if (e.total > cheap.total || (single && e.total > single.total)) {
    // 여기에 오면 시작 해 처리에 버그가 있는 것이다. 틀린 «절약» 을 말하느니 멈춘다.
    throw new Error('[cart] 불변식 위반: 계획이 기준선보다 비싸다');
  }

  const groups = [];
  for (let m = 0; m < ctx.M; m++) {
    if (!(e.S[m] > 0)) continue;
    const subtotal = e.S[m];
    const shipping = shippingFor(ctx.R[m], subtotal);
    const c = bestCoupon(ctx.R[m].coupons, subtotal);
    groups.push({
      group: ctx.groups[m],
      lines: ctx.L.map((l, i) => (l.opts[r.picks[i]].m === m ? i : -1)).filter(i => i > -1),
      subtotal, shipping, coupon: c.discount, couponIndex: c.index,
      total: subtotal + shipping - c.discount
    });
  }

  return {
    picks: r.picks.map((j, i) => ctx.L[i].opts[j].k),
    total: e.total, itemsCost: e.items, shippingCost: e.shipping, couponDiscount: e.coupon,
    optimal: r.optimal, searchedNodes: r.nodes,
    groups,
    baselines: {
      singleMall: single ? { group: single.group, total: single.total } : null,
      cheapestEach: { total: cheap.total }
    }
  };
}

/* ==================================================================
 *  4) 판매처 · 가격 · 동일상품 판정
 * ================================================================== */

/**
 * 배송비를 나눠 붙이는 단위(판매처 이름).
 *
 *   쿠팡 행         → '쿠팡'
 *   ADPICK 행       → mall_label (실제 판매몰: 11번가, G마켓 …)
 *   ADPICK + 이름 없음 → 상품마다 따로 («같은 판매처» 라고 가정하면 배송비를 한 번만
 *                     세게 되어 총액을 낮게 말한다. 모르면 따로 센다 — 비싸게 틀리는 쪽이 안전하다)
 */
function mallLabelOf(row) {
  const mall = String((row && row.mall) || '').trim();
  if (mall === COUPANG) return { label: COUPANG, unknownSeller: false };
  const label = String((row && row.mall_label) || '').trim().slice(0, 40);
  if (label) return { label, unknownSeller: false };
  if (mall === 'ADPICK') return { label: `ADPICK 제휴몰 #${String(row.product_id || '').slice(0, 6)}`, unknownSeller: true };
  return { label: mall || '판매처 미상', unknownSeller: !mall };
}

function rowKey(r) { return `${r.product_id}|${r.mall || ''}|${vendorIdOf(r)}`; }

/** 최근에 수집된 행이 먼저. 같으면 식별자 순 (결정론). */
function byRecent(a, b) {
  const ta = Date.parse(a.collected_at || '') || 0, tb = Date.parse(b.collected_at || '') || 0;
  if (ta !== tb) return tb - ta;
  const ka = rowKey(a), kb = rowKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** 'A ≠ B' 꼴 꼬리를 뽑는다 (판정 이유 문장에서 사람이 볼 부분). */
function detailOf(reason) {
  const m = /(\[[^\]]*\]|\S+)\s*≠\s*(\[[^\]]*\]|\S+)\s*$/.exec(String(reason || ''));
  if (!m) return '';
  const clean = s => s.replace(/^\[|\]$/g, '');
  return ` (${clean(m[1])} ≠ ${clean(m[2])})`;
}

/**
 * _identity.judgeSameProduct 의 이유 → 사용자 문장.
 * 원문 이유는 identity.reasons 에 그대로 남긴다 (감사 가능성).
 */
function identityReasonText(j) {
  const r = String(((j && j.reasons) || [])[0] || '');
  if (/^용량\/크기 충돌/.test(r)) return `용량·크기 옵션이 달라요${detailOf(r)}`;
  if (/^옵션\(색상\)/.test(r)) return `색상 옵션이 달라요${detailOf(r)}`;
  if (/^수량/.test(r)) return `수량 옵션이 달라요${detailOf(r)}`;
  if (/^모델코드 충돌/.test(r)) return `모델이 달라요${detailOf(r)}`;
  if (/^연식 충돌/.test(r)) return `연식이 달라요${detailOf(r)}`;
  if (/^세대\/등급 충돌/.test(r)) return `세대·등급이 달라요${detailOf(r)}`;
  if (/^매체\/형태 충돌/.test(r)) return `형태(매체)가 달라요${detailOf(r)}`;
  if (/^변형 충돌/.test(r)) return `모델 변형이 달라요${detailOf(r)}`;
  if (/묶음|세트|번들|패키지|단품/.test(r)) return '묶음·세트 구성이 달라요';
  if (/^제목이 비어/.test(r)) return '상품명이 없어 같은 상품인지 비교할 수 없어요';
  return '동일 상품 확신 부족 — 제목만 비슷하고 같은 상품이라는 근거가 모자라요';
}

/** _hotgroup.canMerge 의 이유 → 사용자 문장 (tier A 였지만 병합 관문에서 걸린 경우). */
function mergeReasonText(reason) {
  const r = String(reason || '');
  if (/^옵션\(vendorItemId\)/.test(r)) return '다른 옵션이에요 (쿠팡 옵션 번호가 달라요)';
  if (/^스펙 숫자/.test(r)) return `스펙 숫자가 달라요${detailOf(r)}`;
  if (/^제목 겹침/.test(r)) return '동일 상품 확신 부족 — 제목이 충분히 같지 않아요';
  if (/^값 차이/.test(r)) return '가격 차이가 너무 커서 같은 구성으로 보기 어려워요';
  if (/^변별력 있는 모델코드/.test(r)) return '동일 상품 확신 부족 — 상품을 가르는 모델코드가 겹치지 않아요';
  return '동일 상품 확신 부족';
}

/**
 * 사용자가 적은 상품명과 카탈로그 행이 «옵션이 어긋났다» 는 신호인가.
 *
 * 막연한 «근거 약함»(tier B/C) 은 충돌이 아니다. 색상은 사용자가 색을 적었을 때만
 * 충돌로 본다 — judgeSameProduct 는 한쪽에만 색이 있어도 C 를 주는데(카탈로그 재등록
 * 감사에서는 그게 맞다), 사람이 "갤럭시 S24" 라고만 적은 것을 "블랙과 다르다" 고
 * 말하면 거짓 경고가 된다.
 */
function isConflict(j, inputTitle) {
  if (!j) return false;
  if (j.tier === 'D') return true;
  return j.tier === 'C' && /^옵션\(색상\)/.test(String((j.reasons || [])[0] || ''))
    && colors(inputTitle).size > 0;
}

function mergeShape(row) {
  return { title: row.title, price: Number(row.lprice) || 0, productId: row.product_id, vendorItemId: vendorIdOf(row) };
}

/**
 * 상품명 검색 단서 1~2개. 모델코드가 있으면 그것이 가장 좋은 단서다.
 * 숫자로 시작하는 낱말(256gb · 2개 · 2026)은 표기가 제각각이라(256 GB / 256기가) 빼고,
 * 나머지는 긴 낱말 순. ilike 에 넣으므로 영문·숫자·한글·하이픈만 남는다 (와일드카드 주입 없음).
 */
function titleSearchTokens(title) {
  const codes = [...modelCodes(title)].map(c => c.toLowerCase()).filter(c => /^[0-9a-z-]+$/.test(c));
  const words = [...idTokens(title)]
    .filter(w => w.length >= 2 && !/^\d/.test(w) && !SEARCH_STOP.has(w) && /^[0-9a-z가-힣]+$/.test(w));
  const ranked = codes.sort((a, b) => b.length - a.length)
    .concat(words.map((w, i) => ({ w, i })).sort((a, b) => b.w.length - a.w.length || a.i - b.i).map(x => x.w));
  const out = [];
  ranked.forEach(w => {
    if (out.length >= 2) return;
    // 모델코드 'sm-s921n' 과 그 조각 's921n' 을 둘 다 쓰면 단서가 하나뿐인 셈이다.
    if (out.some(x => x.indexOf(w) > -1 || w.indexOf(x) > -1)) return;
    out.push(w);
  });
  return out;
}

/**
 * 상품 하나의 «기준 행» 을 정한다. 이 행이 곧 «사용자가 사려는 것» 이다.
 *
 *   productId 가 있으면 → 그 상품 행. vendorItemId 도 있으면 그 옵션 행만.
 *       다른 옵션 행은 «다른 옵션» 으로 제외한다 (_price.sameVendorRows 와 같은 뜻:
 *       옵션 번호가 비어 있으면 모르는 것이지 다른 것이 아니다).
 *   상품명만 있으면 → 검색 결과 중 tier A 로 판정된 행 중 가장 확실한 것.
 *       tier A 가 없으면 고르지 않는다. 비슷한 후보는 suggestions 로만 보여 준다.
 *
 * @returns {{base:{row, identity, option}|null, excluded:Array<{row, identity, reason}>,
 *            extraPool:Array, reason:string, suggestions:Array}}
 */
function resolveBase(input, productRows, titleRows) {
  const out = { base: null, excluded: [], extraPool: [], reason: '', suggestions: [] };

  if (input.productId) {
    const rows = (productRows || []).filter(r => String(r.product_id) === input.productId
      && (!input.mall || String(r.mall || '') === input.mall));
    if (rows.length) {
      const want = input.vendorItemId;
      let pick;
      if (want) {
        pick = rows.filter(r => vendorIdOf(r) === want).sort(byRecent)[0]
          || rows.filter(r => !vendorIdOf(r)).sort(byRecent)[0] || null;
      } else {
        pick = rows.slice().sort(byRecent)[0];
      }
      rows.forEach(r => {
        if (r === pick) return;
        if (pick && String(r.mall || '') !== String(pick.mall || '')) { out.extraPool.push(r); return; }
        const vid = vendorIdOf(r);
        out.excluded.push({
          row: r,
          identity: { tier: 'A', reasons: ['같은 상품 번호'] },
          reason: vid
            ? `다른 옵션이에요 (같은 상품 페이지의 다른 옵션 번호 ${vid})`
            : '옵션 번호가 없어 같은 옵션인지 확인할 수 없어요'
        });
      });
      if (!pick) {
        out.reason = `요청한 옵션(옵션 번호 ${want})의 가격을 SEOSA 가 확인한 적이 없어요 — 같은 상품의 다른 옵션만 있어요.`;
        return out;
      }
      const baseVid = vendorIdOf(pick);
      const notes = [];
      let ok = true;
      if (want) {
        if (baseVid === want) notes.push('요청한 옵션 번호와 같아요.');
        else { ok = false; notes.push('SEOSA 기록에 옵션 번호가 없어 요청한 옵션인지 확인하지 못했어요.'); }
      } else if (baseVid) {
        notes.push(`옵션 번호를 지정하지 않아 SEOSA 가 확인한 옵션(${baseVid})으로 계산했어요.`);
      }
      if (input.title) {
        const j = judgeSameProduct(input.title, pick.title);
        if (isConflict(j, input.title)) { ok = false; notes.push(`입력한 상품명과 옵션이 달라 보여요 — ${identityReasonText(j)}`); }
      }
      out.base = { row: pick, identity: { tier: 'A', reasons: ['요청한 상품 번호'] }, option: { ok, notes } };
      return out;
    }
    if (!input.title) {
      out.reason = 'SEOSA 카탈로그에서 이 상품 번호를 찾지 못했어요.';
      return out;
    }
    // 상품 번호로 못 찾았지만 상품명이 있다 → 상품명으로 이어서 찾는다.
  }

  const cands = (titleRows || [])
    .filter(r => !input.mall || String(r.mall || '') === input.mall)
    .map(r => ({ r, j: judgeSameProduct(input.title, r.title), jac: HG.jaccard(input.title, r.title) }));
  const live = r => productLifecycle(r).state === 'live';
  const wantNorm = normTitle(input.title);
  const same = c => normTitle(c.r.title) === wantNorm;
  const tierA = cands.filter(c => c.j.tier === 'A').sort((a, b) =>
    (same(b) ? 1 : 0) - (same(a) ? 1 : 0)
    || (input.vendorItemId ? (vendorIdOf(b.r) === input.vendorItemId ? 1 : 0) - (vendorIdOf(a.r) === input.vendorItemId ? 1 : 0) : 0)
    || b.jac - a.jac
    || (live(b.r) ? 1 : 0) - (live(a.r) ? 1 : 0)
    || byRecent(a.r, b.r));

  if (tierA.length) {
    const c = tierA[0];
    const notes = ['상품명으로 찾은 상품이에요 — 사려는 상품이 맞는지 확인해 주세요.'];
    let ok = true;
    if (input.vendorItemId && vendorIdOf(c.r) !== input.vendorItemId) {
      ok = false;
      notes.push('요청한 옵션 번호와 같은 행을 찾지 못했어요.');
    }
    out.base = { row: c.r, identity: { tier: 'A', reasons: c.j.reasons.slice() }, option: { ok, notes } };
    return out;
  }

  out.reason = cands.length
    ? '상품명만으로는 같은 상품이라고 확신할 수 없어요 — 상품 번호로 넣어 주세요.'
    : 'SEOSA 카탈로그에서 이 상품명을 찾지 못했어요.';
  out.suggestions = cands
    .filter(c => (c.j.tier === 'B' || c.j.tier === 'C') && !isConflict(c.j, input.title)
      && overlap(input.title, c.r.title) >= SUGGEST_MIN_OVERLAP)
    .sort((a, b) => (a.j.tier < b.j.tier ? -1 : a.j.tier > b.j.tier ? 1 : 0) || b.jac - a.jac || byRecent(a.r, b.r))
    .slice(0, MAX_SUGGESTIONS)
    .map(c => ({
      productId: String(c.r.product_id), mall: String(c.r.mall || ''), mallLabel: mallLabelOf(c.r).label,
      title: String(c.r.title || ''), tier: c.j.tier
    }));
  return out;
}

/**
 * 같은 검색어 후보군에서 «같은 상품 · 같은 옵션» 오퍼만 받아들인다.
 *
 * 받아들이는 조건 (둘 중 하나)
 *   · 기준 행 그 자체
 *   · judgeSameProduct(기준, 후보).tier === 'A'  그리고  canMerge(기준, 후보, df).merge
 *     df 는 이 후보군 제목으로 센 모델코드 빈도 — 후보군에 흔한 코드(스펙 낱말)는
 *     근거로 쓰지 않는다 (_hotgroup.MODEL_CODE_MAX_DF)
 *
 * 같은 상품 번호 · 같은 몰인데 옵션 번호가 다르면 «다른 옵션» 이다 — 제목을 볼 필요도 없다.
 *
 * @returns {{accepted:Array<{row, identity, option, isBase}>, excluded:Array<{row, identity, reason}>, hidden:number}}
 */
function screenPool(resolution, input, poolRows) {
  const base = resolution.base;
  const accepted = [{ row: base.row, identity: base.identity, option: base.option, isBase: true }];
  const excluded = resolution.excluded.slice();
  const baseRow = base.row;
  const baseKey = rowKey(baseRow);
  const seen = new Set([baseKey].concat(resolution.excluded.map(x => rowKey(x.row))));
  const rows = [];
  (poolRows || []).forEach(r => {
    if (!r || !r.product_id) return;
    const k = rowKey(r);
    if (seen.has(k)) return;
    seen.add(k);
    rows.push(r);
  });

  const df = HG.modelCodeFrequency([baseRow.title].concat(rows.map(r => r.title)));
  const near = [];
  let hidden = 0;

  rows.forEach(r => {
    const samePage = String(r.product_id) === String(baseRow.product_id) && String(r.mall || '') === String(baseRow.mall || '');
    if (samePage) {
      const vid = vendorIdOf(r);
      excluded.push({
        row: r, identity: { tier: 'A', reasons: ['같은 상품 번호'] },
        reason: vid ? `다른 옵션이에요 (같은 상품 페이지의 다른 옵션 번호 ${vid})` : '옵션 번호가 없어 같은 옵션인지 확인할 수 없어요'
      });
      return;
    }
    const j = judgeSameProduct(baseRow.title, r.title);
    const m = HG.canMerge(mergeShape(baseRow), mergeShape(r), df);
    if (j.tier === 'A' && m.merge) {
      const sameVid = /vendorItemId 일치/.test(m.reason);
      accepted.push({
        row: r,
        identity: { tier: 'A', reasons: j.reasons.concat([m.reason]) },
        option: {
          ok: base.option.ok,
          notes: sameVid
            ? ['옵션 번호가 같아요.']
            : ['다른 판매처 상품 — 제목의 모델·용량·색상·수량이 같은지까지 확인했어요. 제목에 없는 옵션은 판매처에서 확인해 주세요.']
        },
        isBase: false
      });
      return;
    }
    const reason = j.tier !== 'A' ? identityReasonText(j) : mergeReasonText(m.reason);
    const score = HG.jaccard(baseRow.title, r.title);
    if (score < NEAR_MISS_JACCARD) { hidden++; return; }
    near.push({
      row: r, score, reason,
      identity: { tier: j.tier, reasons: j.reasons.concat(j.tier === 'A' && !m.merge ? [m.reason] : []) }
    });
  });

  near.sort((a, b) => b.score - a.score || byRecent(a.row, b.row));
  near.slice(0, MAX_EXCLUDED_PER_ITEM).forEach(x => excluded.push({ row: x.row, identity: x.identity, reason: x.reason }));
  hidden += Math.max(0, near.length - MAX_EXCLUDED_PER_ITEM);
  return { accepted, excluded, hidden };
}

/** loadStats 에 넘길 키 — 받아들인 오퍼만 (옵션 번호로 좁혀 다른 옵션 가격이 섞이지 않게). */
function statKeys(screens) {
  const out = new Map();
  (screens || []).forEach(s => (s ? s.accepted : []).forEach(a => {
    const k = `${a.row.product_id}|${a.row.mall || ''}`;
    if (!out.has(k)) out.set(k, { productId: String(a.row.product_id), mall: String(a.row.mall || ''), vendorItemId: vendorIdOf(a.row) });
  }));
  return [...out.values()];
}

/**
 * 가격 확인. 가격 기록(price_history)의 마지막 관측이 먼저, 없으면 카탈로그 lprice.
 *
 * 재고 API 가 없으므로 «판매 중» 의 근거는 최근 관측뿐이다. 카탈로그 행이 살아 있고
 * (_price.productLifecycle 'live') 관측이 MAX_DISPLAY_AGE_DAYS 안이면 LIVE.
 */
function priceOf(row, stat, today) {
  let unitPrice = null, observedDate = null, priceSource = 'catalog';
  if (stat && Number(stat.lastPrice) > 0) {
    unitPrice = Math.round(Number(stat.lastPrice));
    observedDate = stat.lastDate || null;
    priceSource = 'price_history';
  } else {
    const p = Math.round(Number(row.lprice));
    unitPrice = p > 0 ? p : null;
    observedDate = kstDateOf(row.collected_at);
  }
  let staleDays = observedDate ? daysBetween(observedDate, today) : null;
  if (staleDays != null && staleDays < 0) staleDays = 0;
  const lc = productLifecycle(row);
  const live = lc.state === 'live' && staleDays != null && staleDays <= MAX_DISPLAY_AGE_DAYS && unitPrice > 0;
  let staleReason = '';
  if (!live) {
    if (lc.state === 'dead-mall') staleReason = '연동이 끊긴 판매처라 지금 가격·판매 여부를 확인할 수 없어요';
    else if (!(unitPrice > 0)) staleReason = '가격 값을 확인할 수 없어요';
    else {
      staleReason = '최근 가격 확인이 안 돼 판매·재고 여부를 알 수 없어요'
        + (observedDate ? ` (마지막 확인 ${observedDate})` : '');
    }
  }
  const catalog = Math.round(Number(row.lprice)) || 0;
  const drift = priceSource === 'price_history' && catalog > 0 && unitPrice > 0
    && Math.max(catalog, unitPrice) >= Math.min(catalog, unitPrice) * OPTION_SWITCH_RATIO;
  return { unitPrice, observedDate, staleDays, priceSource, availability: live ? 'LIVE' : 'STALE', staleReason, drift, catalog };
}

function httpsOnly(u) {
  const s = String(u || '').trim();
  return /^https:\/\//i.test(s) ? s : null;
}

/** 공개 Offer (CONTRACTS.md §3 ⑤) + priceSource. */
function buildOffer(row, stat, today, identity, option) {
  const p = priceOf(row, stat, today);
  const notes = (option && option.notes ? option.notes : []).slice();
  if (p.drift) notes.push(`최근 기록가(${won(p.unitPrice)})와 카탈로그 가격(${won(p.catalog)})이 크게 달라요 — 옵션이 바뀌었을 수 있어요.`);
  const offer = {
    mall: String(row.mall || ''),
    mallLabel: mallLabelOf(row).label,
    productId: String(row.product_id),
    vendorItemId: vendorIdOf(row) || null,
    title: String(row.title || ''),
    unitPrice: p.unitPrice,
    observedDate: p.observedDate,
    staleDays: p.staleDays,
    availability: p.availability,
    priceSource: p.priceSource,
    url: httpsOnly(row.link),
    identity: { tier: identity.tier, reasons: identity.reasons.slice() },
    option: { ok: !!(option && option.ok), notes }
  };
  return { offer, staleReason: p.staleReason, unknownSeller: mallLabelOf(row).unknownSeller };
}

function inputEcho(it) {
  return {
    productId: it.productId || null, mall: it.mall || null, vendorItemId: it.vendorItemId || null,
    title: it.title || null, quantity: it.quantity
  };
}

/* ==================================================================
 *  5) 응답 조립
 * ================================================================== */

/**
 * 읽어 온 행들로 응답 전체를 만든다 (CONTRACTS.md §3 ⑤ 모양).
 *
 * @param {object} p
 * @param {Array} p.items         validateCart().value.items
 * @param {Array} p.resolutions   resolveBase 결과 (상품마다)
 * @param {Array} p.screens       screenPool 결과 (기준 행이 없으면 null)
 * @param {Map}   p.stats         _pricestat.loadStats 결과
 * @param {object} p.shipping     validateCart().value.shipping
 * @param {Array} p.coupons       validateCart().value.coupons
 * @param {string} p.today        KST 'YYYY-MM-DD'
 * @param {number} [p.nodeCap]
 */
function assemble(p) {
  const today = p.today;
  const stats = p.stats || new Map();
  const outItems = [];
  const unresolved = [];
  const lines = [];                     // 최적화에 넣을 줄
  const lineOffers = [];                // 줄마다 공개 Offer 배열 (offers 인덱스와 같다)
  const groupLabel = new Map();         // mallKey → 표시 이름 (처음 본 것)
  let unknownSeller = false, catalogPriced = 0, hiddenTotal = 0, oldest = null;

  p.items.forEach((it, i) => {
    const res = p.resolutions[i];
    const scr = p.screens[i];
    const excluded = [];
    const offers = [];

    (res.excluded || []).forEach(x => {
      if (scr) return;                  // 기준 행이 있으면 screenPool 이 이미 옮겨 담았다
      const b = buildOffer(x.row, null, today, x.identity, { ok: false, notes: [] });
      excluded.push({ offer: b.offer, reason: x.reason });
    });

    if (scr) {
      hiddenTotal += scr.hidden || 0;
      scr.accepted.forEach(a => {
        const stat = stats.get(`${a.row.product_id}|${a.row.mall || ''}`) || null;
        const b = buildOffer(a.row, stat, today, a.identity, a.option);
        if (b.offer.availability === 'LIVE') {
          offers.push(b.offer);
          if (b.unknownSeller) unknownSeller = true;
        } else {
          excluded.push({ offer: b.offer, reason: b.staleReason });
        }
      });
      scr.excluded.forEach(x => {
        const b = buildOffer(x.row, null, today, x.identity, { ok: false, notes: [] });
        excluded.push({ offer: b.offer, reason: x.reason });
      });
    }

    offers.sort((a, b) => a.unitPrice - b.unitPrice || (a.mallLabel < b.mallLabel ? -1 : a.mallLabel > b.mallLabel ? 1 : 0)
      || (a.productId < b.productId ? -1 : 1));
    outItems.push({ input: inputEcho(it), offers, excluded });

    if (!res.base) {
      unresolved.push({ itemIndex: i, input: inputEcho(it), reason: res.reason, suggestions: res.suggestions || [] });
      return;
    }
    if (!offers.length) {
      unresolved.push({
        itemIndex: i, input: inputEcho(it),
        reason: '최근에 가격을 확인한 판매처가 없어 계산에서 뺐어요.', suggestions: []
      });
      return;
    }
    offers.forEach(o => {
      if (o.priceSource === 'catalog') catalogPriced++;
      if (o.observedDate && (!oldest || o.observedDate < oldest)) oldest = o.observedDate;
      const k = mallKey(o.mallLabel);
      if (!groupLabel.has(k)) groupLabel.set(k, o.mallLabel);
    });
    lines.push({
      itemIndex: i, quantity: it.quantity,
      offers: offers.map(o => ({ group: mallKey(o.mallLabel), unitPrice: o.unitPrice }))
    });
    lineOffers.push(offers);
  });

  /* ── 판매처별 규칙: 입력한 배송비 → 기본 추정치. 쿠폰은 입력한 것만. ── */
  const rules = {};
  const estimated = [];
  groupLabel.forEach((label, k) => {
    const s = p.shipping[k];
    rules[k] = {
      fee: s ? s.fee : DEFAULT_SHIPPING.fee,
      freeOver: s ? s.freeOver : DEFAULT_SHIPPING.freeOver,
      coupons: p.coupons.filter(c => c.key === k),
      estimated: !s
    };
    if (!s) estimated.push(label);
  });

  const r = optimize(lines, rules, { nodeCap: p.nodeCap });

  const byMall = r.groups.map(g => ({
    mall: groupLabel.get(g.group) || g.group,
    lines: g.lines.map(li => {
      const offer = lineOffers[li][r.picks[li]];
      const quantity = lines[li].quantity;
      return { itemIndex: lines[li].itemIndex, offer, quantity, lineTotal: offer.unitPrice * quantity };
    }).sort((a, b) => a.itemIndex - b.itemIndex),
    subtotal: g.subtotal,
    shipping: g.shipping,
    coupon: g.coupon,
    total: g.total,
    shippingEstimated: !!rules[g.group].estimated
  })).sort((a, b) => b.subtotal - a.subtotal || (a.mall < b.mall ? -1 : a.mall > b.mall ? 1 : 0));

  const single = r.baselines.singleMall;
  const baselines = {
    singleMall: single ? { mall: groupLabel.get(single.group) || single.group, total: single.total } : null,
    cheapestEach: { total: r.baselines.cheapestEach.total }
  };
  const savings = {
    vsSingleMall: single ? single.total - r.total : null,
    vsCheapestEach: r.baselines.cheapestEach.total - r.total
  };
  if ((savings.vsSingleMall != null && savings.vsSingleMall < 0) || savings.vsCheapestEach < 0) {
    throw new Error('[cart] 불변식 위반: 절약액이 음수');
  }

  /* ── 가정 — 계산이 기대는 것 전부를 사용자에게 적는다 ── */
  const assumptions = [];
  assumptions.push(`재고·판매 여부를 알려 주는 API 가 없어요. 최근 ${MAX_DISPLAY_AGE_DAYS}일 안에 가격을 확인한 판매처만 판매 중으로 보고 계산했어요.`);
  assumptions.push('가격은 SEOSA 가 마지막으로 확인한 값이에요' + (oldest ? ` (가장 오래된 확인 ${oldest})` : '')
    + '. 결제 전에 판매처에서 실제 금액을 확인해 주세요.');
  if (catalogPriced) assumptions.push(`가격 기록이 없는 판매처 ${catalogPriced}곳은 카탈로그에 저장된 가격을 썼어요.`);
  if (estimated.length) {
    assumptions.push(`배송비를 입력하지 않은 판매처(${estimated.join(', ')})는 기본 추정치 `
      + `${won(DEFAULT_SHIPPING.fee)} · ${won(DEFAULT_SHIPPING.freeOver)} 이상 무료로 계산했어요 — 판매처마다 달라요. 입력하면 정확해져요.`);
  }
  if (lines.length) {
    assumptions.push('배송비는 판매처마다 한 번 붙고, 무료배송 기준은 쿠폰 적용 전 상품 금액으로 봤어요. 오픈마켓은 판매자마다 배송비가 따로 붙을 수 있어요.');
  }
  if (p.coupons.length) {
    assumptions.push('쿠폰은 직접 입력한 것만, 판매처마다 가장 유리한 하나만 적용했어요. 최소 주문 금액은 배송비를 뺀 상품 금액으로 봤어요.');
  } else {
    assumptions.push('쿠폰은 직접 입력한 것만 적용해요. 입력한 쿠폰이 없어 쿠폰 할인 없이 계산했어요.');
  }
  const orphanCoupons = [...new Set(p.coupons.filter(c => !groupLabel.has(c.key)).map(c => c.mall))];
  if (orphanCoupons.length) assumptions.push(`입력한 쿠폰의 판매처(${orphanCoupons.join(', ')})에 비교할 상품이 없어 적용하지 못했어요.`);
  const orphanShip = Object.keys(p.shipping).filter(k => !groupLabel.has(k)).map(k => p.shipping[k].label);
  if (orphanShip.length) assumptions.push(`입력한 배송비의 판매처(${orphanShip.join(', ')})에 비교할 상품이 없어 쓰지 않았어요.`);
  if (unknownSeller) assumptions.push('판매처 이름이 없는 ADPICK 상품은 서로 다른 판매처로 보고 배송비를 따로 셌어요.');
  if (hiddenTotal) assumptions.push(`같은 검색어로 수집된 다른 상품 ${hiddenTotal}개는 같은 상품이 아니라서 비교하지 않았어요.`);
  if (!r.optimal) {
    assumptions.push(`조합이 너무 많아 ${r.searchedNodes.toLocaleString('ko-KR')}단계에서 탐색을 멈췄어요. 찾은 것 중 가장 싼 조합이고, 최저가가 아닐 수 있어요.`);
  }
  if (!lines.length) assumptions.push('계산할 수 있는 상품이 없어요. 아래 «찾지 못한 상품» 을 확인해 주세요.');

  return {
    ok: true,
    items: outItems,
    plan: {
      total: r.total, itemsCost: r.itemsCost, shippingCost: r.shippingCost, couponDiscount: r.couponDiscount,
      optimal: r.optimal, searchedNodes: r.searchedNodes, byMall
    },
    baselines,
    savings,
    assumptions,
    unresolved
  };
}

module.exports = {
  MAX_ITEMS, MAX_QTY, MAX_COUPONS, MAX_FEE, MAX_BODY_BYTES, DEFAULT_SHIPPING, NODE_CAP,
  NEAR_MISS_JACCARD, MAX_EXCLUDED_PER_ITEM,
  validateCart, shippingFor, couponDiscount, bestCoupon, extraOf,
  optimize, mallLabelOf, mallKey, titleSearchTokens, resolveBase, screenPool, statKeys, priceOf,
  buildOffer, assemble,
  _internal: { prepare, evaluate, greedy, improve, search, identityReasonText, mergeReasonText, daysBetween }
};
