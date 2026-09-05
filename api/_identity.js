'use strict';
/*
 * 동일상품 판정 — 순수 함수.
 *
 * ── 무엇을 위한 파일인가 ────────────────────────────────────────
 *
 * 쿠팡 판매자가 상품을 내리고 새 product_id 로 다시 올리면, 우리 카탈로그의
 * product_id 는 죽는다. 그 상품은 어떤 검색어로도 다시 잡히지 않는다
 * (검색 API 는 product_id 를 색인하지 않는다 — api/_coupang.js 주석 참고).
 *
 * 실측(2026-09-03 운영): 미수집 142개 중 57개가 이 상태였고, 그중 상당수는
 * "제목이 거의 같은 다른 product_id" 가 살아 있었다.
 *
 * ★ 그렇다고 제목이 닮았다는 이유로 이어붙이면 안 된다.
 *   이 파일이 존재하는 진짜 이유가 그것이다 — **닮음은 동일이 아니다.**
 *   운영 데이터에서 실제로 걸린 함정:
 *
 *     LP  vs CD          "(수입LP) Charlie Puth - Nine Track Mind"
 *                        "Charlie Puth - Nine Track Mind [CD] [Deluxe]"
 *     단품 vs 묶음        "아픔이 길이 되려면 (김승섭)"
 *                        "허무감에 압도될 때 지혜문학+아픔이 길이 되려면 세트"
 *     연식 다름          "에이수스 2025 비보북 S 16"  vs  "에이수스 2026 비보북 16"
 *     모델 한 글자 다름   "CRP-DHAS069FWM"  vs  "CRP-DHAS069FW"
 *     옵션 단위 다름      "…S820 골전도 이어폰, 오렌지-OR"  vs  "…S820 골전도 이어폰"
 *
 *   앞의 넷은 **다른 상품**이고, 마지막은 **다른 옵션**이다. 어느 쪽이든
 *   가격을 그대로 옮기면 사용자에게 틀린 값을 보여 준다.
 *
 * ── 이 파일이 하지 않는 것 ──────────────────────────────────────
 *
 * 자동으로 카탈로그를 고치지 않는다. 여기서는 **등급만** 매긴다.
 *   A  동일 확실   B  동일 유력   C  모호   D  다른 상품
 * A 라 해도 product_id 를 바꾸는 것은 상품 정체성을 바꾸는 일이라
 * 사람이 승인해야 한다 (scripts/audit-catalog-identity.js 가 목록만 만든다).
 */

/** 판정용 토큰 — 괄호 안까지 살린다. */
function idTokens(t) {
  return new Set(String(t == null ? '' : t)
    .replace(/[^0-9a-zA-Z가-힣\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w.toLowerCase()));
}

/** 정렬된 토큰 문자열 — 어순만 다른 제목을 같게 본다. */
function normTitle(t) {
  return [...idTokens(t)].sort().join(' ');
}

function overlap(a, b) {
  const A = idTokens(a), B = idTokens(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  A.forEach(w => { if (B.has(w)) n++; });
  return n / Math.min(A.size, B.size);
}

/** 영문+숫자 4자 이상 = 모델코드 후보. 하이픈 포함. */
const MODEL_RE = /^(?=.*[a-z])(?=.*\d)[a-z0-9-]{4,}$/i;
/** 단위는 모델코드가 아니다. */
const UNIT_RE = /^\d+(\.\d+)?(ml|l|g|kg|gb|tb|mm|cm|m|인치|w|k|p|매|개|팩|입|구|병|장|호|년|주|박스|캔|oz)$/i;

function modelCodes(t) {
  return new Set(String(t == null ? '' : t)
    .replace(/[^0-9a-zA-Z가-힣\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => MODEL_RE.test(w) && !UNIT_RE.test(w))
    .map(w => w.toUpperCase()));
}

function years(t) {
  return new Set(String(t == null ? '' : t).match(/\b(20[12]\d)\b/g) || []);
}

/*
 * 세대·등급 표기. 한쪽에만 있으면 다른 상품이다.
 *
 * ★ 한글에는 \b 를 쓸 수 없다. JS 의 \b 는 ASCII 단어 경계라 "4세대" 의 뒤나
 *   "프로" 의 앞뒤에서 기대대로 끊기지 않는다(실측으로 테스트가 깨졌다).
 *   한글 표기는 부분문자열로 찾고, 영문만 \b 를 쓴다.
 */
const GRADE_KO = [['pro', '프로'], ['plus', '플러스'], ['max', '맥스'],
  ['mini', '미니'], ['ultra', '울트라'], ['lite', '라이트']];
function grades(t) {
  const s = String(t == null ? '' : t);
  const out = new Set();
  (s.match(/\d+\s*세대/g) || []).forEach(m => out.add(m.replace(/\s/g, '')));
  [['pro', /\bpro\b/i], ['plus', /\bplus\b/i], ['max', /\bmax\b/i],
   ['mini', /\bmini\b/i], ['ultra', /\bultra\b/i], ['lite', /\blite\b/i]]
    .forEach(([k, re]) => { if (re.test(s)) out.add(k); });
  GRADE_KO.forEach(([k, ko]) => { if (s.indexOf(ko) > -1) out.add(k); });
  return out;
}

/**
 * 용량·크기. 상품을 실제로 가르는 값만.
 * 한글 단위(인치·형) 뒤에는 \b 를 붙이지 않는다 — 위 grades 주석과 같은 이유다.
 */
function capacities(t) {
  const out = new Set();
  const re = /(\d+(?:\.\d+)?)\s?(gb|tb|ml|kg|mah|oz)\b|(\d+(?:\.\d+)?)\s?(인치|형)/gi;
  let m;
  while ((m = re.exec(String(t == null ? '' : t))) !== null) {
    const num = m[1] || m[3], unit = m[2] || m[4];
    out.add((num + unit).toLowerCase());
  }
  return out;
}

/**
 * 매체·형태. 한쪽에만 있으면 다른 상품이다.
 *
 * ★ 토큰이 아니라 부분문자열로 찾는다. "(수입LP)" 는 토큰화하면 "수입lp" 한
 *   덩어리가 되어 'lp' 토큰이 존재하지 않는다(실측으로 테스트가 깨졌다).
 *   영문 약어는 앞뒤가 글자가 아닐 때만 인정해서 "clipboard" 의 'cd' 같은
 *   우연한 일치를 막는다.
 */
const FORMATS = ['lp', 'cd', 'dvd', 'bluray', '블루레이', '중고', '리퍼', '전자책', 'ebook'];
function formats(t) {
  const s = String(t == null ? '' : t).replace(/blu-?ray/gi, 'bluray').toLowerCase();
  const out = new Set();
  FORMATS.forEach(f => {
    if (/^[a-z]+$/.test(f)) {
      const re = new RegExp(`(^|[^a-z])${f}([^a-z]|$)`, 'i');
      if (re.test(s)) out.add(f);
    } else if (s.indexOf(f) > -1) out.add(f);
  });
  return out;
}

const COLORS = ['블랙', '화이트', '실버', '그레이', '블루', '레드', '핑크', '그린', '오렌지',
  '베이지', '네이비', '골드', '퍼플', '아이보리', '카키', '브라운', '민트', '옐로우'];
/** 색상 토큰. "오렌지-OR" 처럼 붙어 있어도 잡는다. */
function colors(t) {
  const s = String(t == null ? '' : t);
  return new Set(COLORS.filter(c => s.indexOf(c) > -1));
}

function isBundle(t) {
  return /[+＋]|세트|묶음|\d+\s*권세트/.test(String(t == null ? '' : t));
}

function firstToken(t) {
  const a = [...idTokens(t)];
  const raw = String(t == null ? '' : t).replace(/[^0-9a-zA-Z가-힣\s]/g, ' ').trim().split(/\s+/)[0];
  return (raw || a[0] || '').toLowerCase();
}

const setsDisjoint = (a, b) => a.size > 0 && b.size > 0 && ![...a].some(x => b.has(x));
const setsDiffer = (a, b) => [...a].some(x => !b.has(x)) || [...b].some(x => !a.has(x));

/**
 * 우리 상품과 후보가 같은 상품인지 등급을 매긴다.
 *
 * @param {string} ours  우리 카탈로그 제목
 * @param {string} cand  후보(살아 있는 다른 product_id) 제목
 * @returns {{tier:'A'|'B'|'C'|'D', reasons:string[]}}
 */
function judgeSameProduct(ours, cand) {
  const reasons = [];
  if (!String(ours || '').trim() || !String(cand || '').trim()) {
    return { tier: 'D', reasons: ['제목이 비어 있다'] };
  }

  /* ── 충돌 신호가 하나라도 있으면 즉시 탈락. 유사도는 보지도 않는다. ── */
  const mo = modelCodes(ours), mc = modelCodes(cand);
  if (setsDisjoint(mo, mc)) {
    return { tier: 'D', reasons: [`모델코드 충돌 ${[...mo].join('/')} ≠ ${[...mc].join('/')}`] };
  }
  const yo = years(ours), yc = years(cand);
  if (setsDisjoint(yo, yc)) {
    return { tier: 'D', reasons: [`연식 충돌 ${[...yo].join('/')} ≠ ${[...yc].join('/')}`] };
  }
  const go = grades(ours), gc = grades(cand);
  if ((go.size || gc.size) && setsDiffer(go, gc)) {
    return { tier: 'D', reasons: [`세대/등급 충돌 [${[...go].join(',')}] ≠ [${[...gc].join(',')}]`] };
  }
  const co = capacities(ours), cc = capacities(cand);
  if (co.size && cc.size && setsDiffer(co, cc)) {
    return { tier: 'D', reasons: [`용량/크기 충돌 [${[...co].join(',')}] ≠ [${[...cc].join(',')}]`] };
  }
  const fo = formats(ours), fc = formats(cand);
  if (setsDiffer(fo, fc)) {
    return { tier: 'D', reasons: [`매체/형태 충돌 [${[...fo].join(',')}] ≠ [${[...fc].join(',')}]`] };
  }
  if (isBundle(ours) !== isBundle(cand)) {
    return { tier: 'D', reasons: [isBundle(cand) ? '상대가 묶음/세트' : '우리가 묶음인데 상대는 단품'] };
  }

  /* ── 옵션 단위가 다르면 같은 상품이라도 자동 연결 금지 ── */
  const lo = colors(ours), lc = colors(cand);
  if (setsDiffer(lo, lc)) {
    return { tier: 'C', reasons: [`옵션(색상) 단위가 다르다 [${[...lo].join(',')}] ≠ [${[...lc].join(',')}]`] };
  }

  const bo = firstToken(ours), bc = firstToken(cand);
  const sameBrandish = !!bo && !!bc
    && (bo === bc || idTokens(cand).has(bo) || idTokens(ours).has(bc));
  const shareModel = mo.size > 0 && mc.size > 0 && [...mo].some(m => mc.has(m));

  if (normTitle(ours) === normTitle(cand)) {
    reasons.push('정규화 제목 완전 일치');
    return { tier: 'A', reasons };
  }
  if (shareModel && sameBrandish) {
    reasons.push(`브랜드 + 모델코드 일치 (${[...mo].filter(m => mc.has(m)).join('/')})`);
    return { tier: 'A', reasons };
  }
  const ov = overlap(ours, cand);
  if (sameBrandish && ov >= 0.9) {
    reasons.push(`브랜드 일치 + 제목 겹침 ${(ov * 100).toFixed(0)}%`);
    return { tier: 'B', reasons };
  }
  reasons.push(`근거 약함 (브랜드일치=${sameBrandish ? 'Y' : 'N'}, 겹침 ${(ov * 100).toFixed(0)}%,`
    + ` 모델코드 ${mo.size ? '있음' : '없음'})`);
  return { tier: 'C', reasons };
}

module.exports = {
  judgeSameProduct,
  idTokens, normTitle, overlap,
  modelCodes, years, grades, capacities, formats, colors, isBundle
};

