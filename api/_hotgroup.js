'use strict';
/*
 * SEOSA HOT — 같은 상품 묶기 · 현재 최저가 판정.
 *
 * ── 이 파일이 지키는 단 하나의 원칙 ────────────────────────────────
 *
 *     false merge  <  duplicate
 *
 *   중복 카드가 하나 남는 것은 보기 싫은 일이다. 서로 다른 상품을 하나로
 *   합치는 것은 **틀린 값을 보여 주는 일**이다. "이 몰이 더 싸다"는 문장은
 *   두 값이 같은 물건일 때만 참이므로, 확신이 없으면 합치지 않는다.
 *
 * ── 왜 _identity.judgeSameProduct 를 그대로 쓰지 않는가 ────────────
 *
 * 그 함수는 «카탈로그 재등록 후보를 사람이 검토할 목록» 을 만들려고 만든
 * 것이라 tier A 가 곧 자동 병합 허가는 아니다. 실측으로 확인했다
 * (2026-09-07, products 최신 2,235건 read-only 스캔).
 *
 *   tier A 로 판정된 123쌍 중 명백한 오병합이 섞여 있었다.
 *
 *     "LG전자 2025 그램 16 … WIN11 Home"
 *     "LG전자 2025 그램 AI 17 … WIN11 Home"      ← tier A
 *
 *   원인은 MODEL_RE(`영문+숫자 4자 이상`)가 WIN11 · 2-IN-1 · USB3 같은
 *   **스펙 낱말**을 모델코드로 잡는다는 것이다. 그런 코드는 상품을 가르지
 *   못한다 — WIN11 은 그때 카탈로그에서 30개 상품에 붙어 있었다.
 *
 *   ★ _identity.js 를 고치지 않는다. 그쪽 소비자(재등록 감사)는 recall 이
 *     중요해서 느슨한 편이 맞다. 병합 쪽에서만 관문을 더 세운다.
 *
 * ── 그래서 병합 조건이 이렇다 (전부 만족해야 한다) ─────────────────
 *
 *   0) 옵션이 다르면 절대 안 된다
 *      vendorItemId 가 둘 다 있고 서로 다르면 그것은 «다른 옵션» 이다.
 *      쿠팡이 우리에게 준 옵션 식별자보다 제목 유사도를 믿을 이유가 없다.
 *      (반대로 vendorItemId 가 같으면 같은 오퍼다 — 제목을 볼 필요가 없다)
 *   1) judgeSameProduct tier === 'A'
 *   2) 스펙 숫자 집합이 완전히 같을 것
 *      "그램 16" vs "그램 17" 을 여기서 끊는다. 용량·인치는 _identity 가
 *      보지만 «그램 16» 처럼 단위 없이 붙는 숫자는 보지 못한다.
 *   3) 자카드 유사도 ≥ 0.8
 *      min 기준 겹침(_identity.overlap)은 짧은 제목이 긴 제목에 통째로
 *      들어가기만 하면 1.0 이 된다. 실측에서 그 때문에
 *        "…14Z95U 무광 팜레스트/터치패드 필름"
 *        "…14Z95U 무광 하판보호필름"
 *      두 «다른 부속» 이 합쳐졌다. 대칭 유사도로 바꾸면 0.67 로 걸린다.
 *   4) 값이 터무니없이 벌어지지 않을 것 (싼 쪽 ≥ 비싼 쪽 × 0.35)
 *      본체와 부속·단품과 묶음이 제목만으로 닮아 보일 때의 마지막 방어다.
 *   5) 제목만으로 붙일 때는 «변별력 있는» 모델코드나 완전 일치 제목이 있을 것
 *      카탈로그 안에서 서로 다른 상품 5개 이상에 붙어 있는 코드는
 *      식별자가 아니라 스펙이므로 근거로 쓰지 않는다.
 *
 * 이 규칙으로 위 2,235건을 다시 돌리면 13개 군집 · 16행이 묶인다(0.7%).
 * 눈으로 전수 확인했고 오병합은 0건이었다. 놓친 진짜 중복도 몇 건 있다 —
 * 그쪽이 안전한 방향이라 그대로 둔다.
 *
 * ★ 순수 함수만 있다. DB 도 네트워크도 모른다.
 */

let identityMod = null;
function identity() {
  if (identityMod === null) {
    try { identityMod = require('./_identity'); }
    catch (e) { console.warn(`[hotgroup] _identity 로드 실패: ${e.message}`); identityMod = false; }
  }
  return identityMod || null;
}

/* ==================================================================
 *  임계값 — 전부 위 실측에서 나왔다.
 * ================================================================== */

/** 대칭(자카드) 유사도 하한. */
const MERGE_MIN_JACCARD = 0.8;
/** 싼 쪽 / 비싼 쪽. 이보다 벌어지면 같은 물건으로 보지 않는다. */
const MERGE_MIN_PRICE_RATIO = 0.35;
/** 서로 다른 상품 이 개수를 넘겨 붙어 있는 «모델코드» 는 스펙 낱말이다. */
const MODEL_CODE_MAX_DF = 4;
/** 후보군이 이보다 크면 그 블록은 변별력이 없다 — 통째로 건너뛴다. */
const MAX_BLOCK = 400;
/** 한 군집이 이보다 커지면 무언가 잘못된 것이다. 더 붙이지 않는다. */
const MAX_GROUP = 12;

/* ==================================================================
 *  1) 보조 지표
 * ================================================================== */

/**
 * 제목 안의 «맨숫자» 집합. 1~4자리 순수 숫자 토큰만 본다.
 *
 * 왜 필요한가: _identity.capacities 는 256gb·16인치처럼 단위가 붙은 값만
 * 잡는다. 실제 상품명에는 단위 없이 상품을 가르는 숫자가 흔하다.
 *
 *     "그램 16"  vs  "그램 17"        ← 화면 크기
 *     "24개"      vs  "12개"           ← 수량 (단위가 한글이라 토큰에 붙는다)
 *     "스위치12"  vs  "스위치"         ← 세대
 *
 * 5자리 이상은 모델코드·연식·용량 쪽에 맡긴다(예: 95134972901 같은 식별자가
 * 제목에 섞여 들어오면 비교가 의미 없어진다).
 */
function specNumbers(title) {
  const out = new Set();
  String(title == null ? '' : title)
    .replace(/[^0-9a-zA-Z가-힣\s]/g, ' ')
    .split(/\s+/)
    .forEach(w => { if (/^\d{1,4}$/.test(w)) out.add(w); });
  return out;
}

/**
 * 대칭 유사도 |A∩B| / |A∪B|.
 *
 * _identity.overlap 은 분모가 min(|A|,|B|) 라서 «짧은 제목이 긴 제목에
 * 들어가기만 하면» 1.0 이다. 부속끼리 비교할 때 그 성질이 위험하다.
 */
function jaccard(a, b) {
  const id = identity();
  if (!id) return 0;
  const A = id.idTokens(a), B = id.idTokens(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  A.forEach(w => { if (B.has(w)) n++; });
  const u = A.size + B.size - n;
  return u ? n / u : 0;
}

/**
 * 모델코드별 «서로 다른 상품» 개수.
 *
 * 같은 제목이 여러 번 들어오면(중복 수집) 한 번으로 센다 — 그러지 않으면
 * 진짜 중복이 많은 코드일수록 변별력이 없다고 잘못 판정된다.
 *
 * @param {Array<string>} titles
 * @returns {Map<string, number>}
 */
function modelCodeFrequency(titles) {
  const df = new Map();
  const id = identity();
  if (!id) return df;
  const seen = new Set();
  (titles || []).forEach(t => {
    const key = id.normTitle(t);
    if (!key || seen.has(key)) return;
    seen.add(key);
    id.modelCodes(t).forEach(c => df.set(c, (df.get(c) || 0) + 1));
  });
  return df;
}

/** 이 코드가 상품을 가르는가, 그냥 스펙 낱말인가. */
function discriminativeCodes(title, df) {
  const id = identity();
  if (!id) return [];
  return [...id.modelCodes(title)].filter(c => (df.get(c) || 0) <= MODEL_CODE_MAX_DF);
}

/* ==================================================================
 *  2) 병합 판정
 * ================================================================== */

/**
 * 두 오퍼가 «같은 상품 · 같은 옵션» 인가.
 *
 * @param {object} a  {title, price, productId, vendorItemId}
 * @param {object} b  같은 모양
 * @param {Map} df    modelCodeFrequency 결과
 * @returns {{merge:boolean, reason:string}}
 */
function canMerge(a, b, df) {
  const no = reason => ({ merge: false, reason });
  if (!a || !b) return no('빈 오퍼');

  const av = String(a.vendorItemId || '').trim();
  const bv = String(b.vendorItemId || '').trim();

  /*
   * ★ 옵션 식별자가 먼저다.
   *
   *   같다  → 같은 오퍼. 제목이 조금 달라도(판매자가 제목을 고친다) 같은 것이다.
   *   다르다 → 다른 옵션. 제목이 완전히 같아도 합치지 않는다. 실측에서
   *            "HP 2025 노트북 15 N-시리즈" 두 행이 vendorItemId 만 다른 채
   *            402,300원 · 521,250원으로 있었다 — 사양이 다른 구성이다.
   */
  if (av && bv) {
    if (av === bv) return { merge: true, reason: 'vendorItemId 일치' };
    return no('옵션(vendorItemId)이 다르다');
  }

  const at = String(a.title || ''), bt = String(b.title || '');
  if (!at || !bt) return no('제목이 비어 있다');

  const id = identity();
  if (!id) return no('동일상품 판정 모듈을 쓸 수 없다');

  const j = id.judgeSameProduct(at, bt);
  if (j.tier !== 'A') return no(`동일 확신 부족 (tier ${j.tier})`);

  const na = specNumbers(at), nb = specNumbers(bt);
  if (na.size !== nb.size || [...na].some(x => !nb.has(x))) {
    return no(`스펙 숫자가 다르다 [${[...na].join(',')}] ≠ [${[...nb].join(',')}]`);
  }

  const jac = jaccard(at, bt);
  if (jac < MERGE_MIN_JACCARD) return no(`제목 겹침 ${Math.round(jac * 100)}% (기준 ${MERGE_MIN_JACCARD * 100}%)`);

  const pa = Math.round(Number(a.price) || 0), pb = Math.round(Number(b.price) || 0);
  if (pa > 0 && pb > 0) {
    const lo = Math.min(pa, pb), hi = Math.max(pa, pb);
    if (lo < hi * MERGE_MIN_PRICE_RATIO) return no(`값 차이가 너무 크다 (${lo} vs ${hi})`);
  }

  if (id.normTitle(at) === id.normTitle(bt)) return { merge: true, reason: '정규화 제목 완전 일치' };

  const shared = discriminativeCodes(at, df).filter(c => id.modelCodes(bt).has(c));
  if (!shared.length) return no('변별력 있는 모델코드가 겹치지 않는다');

  return { merge: true, reason: `모델코드 ${shared[0]} 일치` };
}

/* ==================================================================
 *  3) 군집 만들기
 * ================================================================== */

/** 후보군을 좁히는 블록 키. 여기서 통과한 쌍만 canMerge 를 부른다. */
function blockKeys(entry, df) {
  const id = identity();
  const keys = [];
  const v = String(entry.vendorItemId || '').trim();
  if (v) keys.push('v:' + v);
  if (id) {
    keys.push('n:' + id.normTitle(entry.title).slice(0, 160));
    discriminativeCodes(entry.title, df).forEach(c => keys.push('m:' + c));
  }
  return keys;
}

/**
 * 오퍼들을 같은 상품끼리 묶는다.
 *
 * ── 왜 union-find 를 쓰지 않는가 ───────────────────────────────────
 *
 * union-find(단일 연결)는 A~B, B~C 만으로 A~C 를 만든다. 병합 조건이
 * 추이적이지 않으므로(제목 유사도는 원래 추이적이지 않다) 그렇게 하면
 * 사슬을 타고 다른 상품까지 끌려 들어온다. 그래서 **군집 대표와만**
 * 견준다 — 대표에 붙지 못하면 새 군집을 연다.
 *
 * @param {Array<object>} entries  {key, title, price, mall, productId, vendorItemId, ...}
 * @param {object} opts            {pickPrimary}
 * @returns {{groups:Array, byKey:Map}}
 */
function groupOffers(entries, opts) {
  const list = (entries || []).filter(e => e && e.key);
  const df = modelCodeFrequency(list.map(e => e.title));

  const index = new Map();          // blockKey → [군집 인덱스]
  const groups = [];                // {members:[entry], repIndex}

  list.forEach(e => {
    const keys = blockKeys(e, df);
    const seen = new Set();
    let target = -1, why = '';

    for (const k of keys) {
      const bucket = index.get(k);
      if (!bucket || bucket.length > MAX_BLOCK) continue;
      for (const gi of bucket) {
        if (seen.has(gi)) continue;
        seen.add(gi);
        const g = groups[gi];
        if (g.members.length >= MAX_GROUP) continue;
        const r = canMerge(g.members[0], e, df);   // ★ 대표와만 견준다
        if (r.merge) { target = gi; why = r.reason; break; }
      }
      if (target > -1) break;
    }

    if (target < 0) {
      target = groups.length;
      groups.push({ members: [e], reasons: [] });
    } else {
      groups[target].members.push(e);
      groups[target].reasons.push(why);
    }
    keys.forEach(k => {
      if (!index.has(k)) index.set(k, []);
      const bucket = index.get(k);
      if (bucket.indexOf(target) < 0) bucket.push(target);
    });
  });

  const pickPrimary = (opts && opts.pickPrimary) || defaultPrimary;
  const byKey = new Map();
  const out = groups.map(g => {
    const members = g.members;
    /*
     * 현재 최저가. «판정을 통과해 우리가 값을 믿는» 오퍼만 후보다.
     * 호출부가 REJECTED 를 넣지 않기로 계약했다 — 값 자체를 못 믿는
     * 오퍼의 가격으로 "여기가 제일 싸다"고 말하면 안 되기 때문이다.
     */
    const priced = members.filter(m => Number(m.price) > 0);
    let lowest = null;
    priced.forEach(m => {
      if (!lowest || m.price < lowest.price
        || (m.price === lowest.price && String(m.key) < String(lowest.key))) lowest = m;
    });
    const primary = pickPrimary(members) || members[0];
    const malls = [...new Set(members.map(m => String(m.mall || '')).filter(Boolean))];

    const info = {
      groupKey: String(primary.key),
      size: members.length,
      mallCount: malls.length,
      malls,
      primaryKey: String(primary.key),
      lowestKey: lowest ? String(lowest.key) : '',
      lowestPrice: lowest ? lowest.price : 0,
      lowestMall: lowest ? String(lowest.mall || '') : '',
      offers: members.map(m => ({
        key: String(m.key),
        mall: String(m.mall || ''),
        price: Number(m.price) || 0,
        url: String(m.url || ''),
        status: String(m.status || ''),
        hotScore: Number(m.hotScore) || 0,
        productId: String(m.productId || ''),
        checkedAt: m.checkedAt || null
      })).sort((x, y) => x.price - y.price || (x.key < y.key ? -1 : 1)),
      mergeReasons: g.reasons
    };
    members.forEach(m => byKey.set(String(m.key), info));
    return info;
  });

  return { groups: out, byKey };
}

/**
 * 어느 오퍼를 카드로 보여 줄 것인가.
 *
 * 노출 가능한(deal !== false) 오퍼 중 **가장 싼 것**을 고른다. 점수가 가장
 * 높은 것을 고르면 카드에 적힌 값과 "최저가"가 어긋나서, 사용자가 카드를
 * 눌렀을 때 더 비싼 곳으로 간다. 값이 같으면 점수 · 키 순으로 결정론.
 */
function defaultPrimary(members) {
  const usable = members.filter(m => m.deal !== false && Number(m.price) > 0);
  const pool = usable.length ? usable : members;
  return pool.slice().sort((a, b) =>
    (Number(a.price) || 0) - (Number(b.price) || 0)
    || (Number(b.hotScore) || 0) - (Number(a.hotScore) || 0)
    || (String(a.key) < String(b.key) ? -1 : 1))[0];
}

/* ==================================================================
 *  4) 목록 다양성 — TASK 7
 * ================================================================== */

/**
 * 같은 «계열» 이 상위를 도배하지 않게 한 페이지 안에서만 자리를 바꾼다.
 *
 * ★ 버리지 않고 «미룬다». 페이지에서 항목을 빼면 커서 계산이 어긋나
 *   다음 페이지에서 그 항목이 통째로 사라진다. 순서만 바꾸면 그런 일이 없다.
 *
 * 계열 키는 브랜드(첫 토큰) + 변별력 있는 모델코드다. 계열이 «같은 상품»
 * 이라는 뜻은 아니다 — 합치지는 않고 나란히 붙지만 않게 한다.
 *
 * @param {Array<object>} items      순서가 이미 정해진 목록
 * @param {function} familyOf        item → 계열 키
 * @param {number} maxRun            같은 계열이 연달아 나올 수 있는 최대 개수
 */
function diversify(items, familyOf, maxRun) {
  const cap = Math.max(1, maxRun || 2);
  const src = (items || []).slice();
  const out = [];
  const held = [];
  let lastFam = null, run = 0;

  const take = it => {
    const fam = familyOf(it) || '';
    if (fam && fam === lastFam) run++; else { lastFam = fam; run = 1; }
    out.push(it);
  };

  while (src.length || held.length) {
    // 미뤄 둔 것 중 지금 자리에 맞는 게 있으면 먼저 넣는다 (원래 순서 유지).
    let placed = false;
    for (let i = 0; i < held.length; i++) {
      const fam = familyOf(held[i]) || '';
      if (!fam || fam !== lastFam || run < cap) { take(held.splice(i, 1)[0]); placed = true; break; }
    }
    if (placed) continue;

    if (!src.length) { held.forEach(take); held.length = 0; break; }
    const it = src.shift();
    const fam = familyOf(it) || '';
    if (fam && fam === lastFam && run >= cap) { held.push(it); continue; }
    take(it);
  }
  return out;
}

/** 계열 키 — 브랜드 + 변별력 있는 모델코드. 없으면 브랜드만. */
function familyKeyOf(title, df) {
  const id = identity();
  if (!id) return '';
  const t = String(title || '');
  const brand = [...id.idTokens(t)].length
    ? t.replace(/[^0-9a-zA-Z가-힣\s]/g, ' ').trim().split(/\s+/)[0].toLowerCase()
    : '';
  const codes = df ? discriminativeCodes(t, df) : [...id.modelCodes(t)];
  return `${brand}|${codes.sort()[0] || ''}`;
}

module.exports = {
  MERGE_MIN_JACCARD, MERGE_MIN_PRICE_RATIO, MODEL_CODE_MAX_DF, MAX_GROUP, MAX_BLOCK,
  specNumbers, jaccard, modelCodeFrequency, discriminativeCodes,
  canMerge, groupOffers, defaultPrimary, diversify, familyKeyOf,
  _internal: { blockKeys }
};
