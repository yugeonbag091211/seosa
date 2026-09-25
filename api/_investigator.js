'use strict';
/*
 * ③ AI 쇼핑 조사관 — "30만원 이하 가벼운 노트북 알아봐 줘" 를 여러 상품의 비교 보고서로.
 *
 * ── AI Concierge 와의 관계 ─────────────────────────────────────────
 *
 * 새 두뇌를 만들지 않는다. Concierge(api/ai.js)가 쓰는 모듈을 그대로 쓴다.
 *   말 → 검색어      _intent.extractQuery        (Concierge 의 정규식 경로와 같다)
 *   말 → 조건        _shopintent.parseConstraints (예산·우선순위)
 *   순서             _shopintent.rankItems        (Concierge 가 후보를 세우는 순서와 같다)
 *   사양·기능        _specs.extractSpecs · wantedFeatures · matchFeatures
 *   가격 판단        _pricestat.fairness · _deal.dealOf
 *   문장 조각        _concierge.won · shortTitle
 * 그래서 같은 상품을 두고 조사 보고서와 AI 대화가 다른 사실을 말하지 않는다.
 *
 * ── 잘못된 상품 정보를 만들지 않는 규칙 ──────────────────────────────
 *
 * 1. 사양은 상품명에 «적힌 것만» 쓴다. 각 값에 상품명의 어느 글자에서 나왔는지(evidence)를 붙인다.
 * 2. 상품명에서 확인되지 않은 기능은 «없다» 가 아니라 «확인 안 됨» 이다 (unverifiedFeatures).
 *    제목에 안 적었을 뿐 있는 기능이 흔하다 — 모르는 것을 부정으로 바꾸지 않는다.
 * 3. 가격은 원장(price_history)의 최근 관측으로 검증한다. 3일보다 오래됐거나 카탈로그 값과
 *    다르면 verified=false 로 밝힌다.
 * 4. 장단점 문장은 데이터에서만 만든다. 모든 문장에 근거(basis)가 붙는다.
 * 5. 요약의 모든 숫자는 후보 데이터 안의 값이어야 한다 (groundCheck). 하나라도 어긋나면
 *    숫자 없는 안전한 요약으로 바꾼다 — 모델이 없어도 템플릿 실수는 생긴다.
 * 6. LLM 을 부르지 않는다. 비용 0원, 같은 질문이면 같은 보고서.
 *
 * ★ 순수 함수만 있다. DB 는 api/_investigator-api.js 가 읽어서 넘긴다.
 */

const { parseConstraints, rankItems, constraintLine } = require('./_shopintent');
const { extractSpecs, wantedFeatures, matchFeatures, detectCategory, SPEC_LABEL } = require('./_specs');
const { extractQuery, extractUseCase } = require('./_intent');
const { fairness, statsFrom } = require('./_pricestat');
const { dealOf } = require('./_deal');
const { productLifecycle } = require('./_price');
const PR = require('./_product-role');
const PC = require('./_price-claims');
const CG = require('./_concierge');

/** 보고서에 싣는 최대 후보 수. */
const MAX_CANDIDATES = 8;
/** 원장 검증까지 가져갈 사전 후보 수 (DB 부하 상한). */
const MAX_VERIFY = 24;
/** 이보다 오래된 관측은 «지금 가격» 으로 검증하지 않는다. */
const FRESH_DAYS = 3;
/** 예산 «정도» 는 이만큼 넘어도 받는다 (_shopintent 의 soft 예산과 같은 관대함). */
const SOFT_BUDGET_SLACK = 0.1;
/** 사양 «정확히» 요구(20L 쿨러)의 허용 폭. */
const EQ_TOLERANCE = 0.1;
const MAX_QUESTION = 300;
/** 응답에 싣는 제외 상품 수 (종류별 개수는 excludedGroups 에 전부 있다). */
const MAX_EXCLUDED = 30;

/** 사용자가 개수를 말하지 않았을 때 보여 줄 수 — 말했으면 그 수(최대 MAX_CANDIDATES). */
const DEFAULT_COUNT = MAX_CANDIDATES;

/** 조사 요청 말투 — 검색어에서 뺀다. */
const RESEARCH_WORDS = /^(조사|조사해|조사해줘|조사해주세요|알아봐|알아봐줘|알아봐주세요|비교|비교해|비교해줘|비교해주세요|찾아|찾아줘|찾아주세요|추천|추천해줘|추천해주세요|골라|골라줘|정리|정리해줘|분석|분석해줘|제외|제외하고|빼고|말고|이상|이하|초과|미만|정도|쯤|내외|좀|제품|상품|것|거)$/;

/** 사양 요구 — "1.5kg 이하", "16GB 이상", "32인치", "20L". */
const SPEC_RULES = [
  { key: 'weight_g', re: /(\d+(?:\.\d+)?)\s*(kg|킬로)\s*(이하|미만|아래|보다\s*가벼운)?/gi, mul: 1000 },
  { key: 'weight_g', re: /(\d{2,4})\s*g(?![a-z가-힣])\s*(이하|미만|아래)?/gi, mul: 1 },
  { key: 'size_inch', re: /(\d{1,2}(?:\.\d)?)\s*(인치|형)\s*(이상|이하|넘는|초과|미만)?/g, mul: 1 },
  { key: 'capacity_ml', re: /(\d{1,3}(?:\.\d{1,2})?)\s*(l|리터)(?![a-z])\s*(이상|이하|넘는|초과|미만)?/gi, mul: 1000 },
  { key: 'battery_mah', re: /(\d{3,6})\s*(mah)\s*(이상|넘는|초과)?/gi, mul: 1 },
  { key: 'refresh_hz', re: /(\d{2,3})\s*(hz|헤르츠)\s*(이상|넘는|초과)?/gi, mul: 1 },
  { key: 'gb', re: /((?:램|ram|메모리|ssd|저장|용량)\s*)?(\d{1,4})\s*(gb|기가|tb|테라)\s*(이상|넘는|초과|이하|미만)?/gi, mul: 1 }
];
/** 사양별 «좋은 쪽». 크기·용량은 필요에 따라 달라 좋고 나쁨을 정하지 않는다. */
const BETTER = { weight_g: 'low', ram_gb: 'high', storage_gb: 'high', battery_mah: 'high', refresh_hz: 'high' };
const BETTER_WORD = {
  weight_g: ['가장 가벼워요', '가장 무거워요'],
  ram_gb: ['램이 가장 커요', '램이 가장 작아요'],
  storage_gb: ['저장 용량이 가장 커요', '저장 용량이 가장 작아요'],
  battery_mah: ['배터리 용량이 가장 커요', '배터리 용량이 가장 작아요'],
  refresh_hz: ['주사율이 가장 높아요', '주사율이 가장 낮아요']
};

/*
 * 숫자 없이 말한 조건 — "가볍고", "배터리가 오래가는".
 *
 * 예전에는 이 말들이 검색어에 그대로 남았다. "배터리" 가 검색어가 되어 교체용 배터리가
 * 후보 위로 올라왔고(2026-09-24 신고), 조건 자체는 아무도 확인하지 않았다.
 * 이제 검색어에서 빼고, 상품명에 적힌 것으로만 확인한다.
 *   light    무게 숫자가 있으면 카테고리 기준(_product-role PROFILES.light)으로 판정.
 *            숫자를 말한 경우("1.5kg 이하")는 사양 규칙이 맡으므로 여기서는 쓰지 않는다.
 *   battery  기준이 되는 숫자가 없어 «충족» 을 선언하지 않는다. 판매자가 적은 사용 시간·
 *            용량을 근거와 함께 보여 주고, 없으면 «확인 안 됨» 이다.
 */
const ATTRS = [
  { key: 'light', label: '가벼움', re: /가볍|가벼|경량|무게\s*(?:가|이)?\s*(?:적|덜|안\s?나가)/ },
  { key: 'battery', label: '배터리 오래감',
    re: /배터리\s*(?:가|이|는)?\s*(?:오래|길|긴|넉넉|빵빵|좋|장시간|대용량|많이|잘\s?가|최대)|오래\s?가는\s*배터리|장시간\s*(?:사용|배터리)|대용량\s*배터리|배터리\s*(?:시간|수명|타임)/ }
];
/** 검색어에서 뺄 서술 낱말 (조건이지 상품 이름이 아니다). */
const ATTR_WORD = /^(?:가볍|가벼|경량|초경량|오래|길|긴|좋|편|큰|크|많|넉넉|장시간|빵빵|튼튼|밝|선명|빠르|빠른|조용|넓|높|괜찮|저렴|싼|싸|가성비)/;
/** "3개", "2~3개", "5가지" — 보여 줄 개수. "3개월"·"8개입" 은 개수 요청이 아니다. */
const COUNT_RE = /(\d{1,2})\s*(?:[~\-]\s*(\d{1,2})\s*)?(?:개|가지|종류|종|대|제품)(?!월|입|년|국)/;

function clean(v, max) {
  return String(v == null ? '' : v).replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function won(n) { return CG.won(n); }
/*
 * 상품명을 낱말 경계에서 자른다. _concierge.shortTitle 은 글자 수로 잘라서
 * "램 16GB" 가 "램 1…" 이 됐다 — 근거 검사(groundCheck)가 잡아낸 실제 사례다.
 * 숫자 한가운데서 자르면 없는 사양("램 1GB")을 말하게 된다.
 */
function cutTitle(t, n) {
  const s = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  const head = s.slice(0, n + 1);
  const at = head.lastIndexOf(' ');
  return `${(at > n * 0.5 ? head.slice(0, at) : s.slice(0, n)).replace(/[\s,·\-–—]+$/, '')}…`;
}
function dayNum(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : NaN;
}

/* ================================================================== *
 *  1) 질문 이해
 * ================================================================== */

/** "삼성 제외", "LG 빼고", "중국산 말고" → ['삼성', 'LG', '중국산'] */
function parseExclusions(q) {
  const out = [];
  const re = /([0-9A-Za-z가-힣]+?)(?:은|는|이|가|을|를)?\s*(?:제품|브랜드)?\s*(?:은|는)?\s*(제외|빼고|말고)/g;
  let m;
  while ((m = re.exec(q)) !== null) {
    const w = m[1];
    if (w && w.length >= 2 && !RESEARCH_WORDS.test(w)) out.push(w);
  }
  return [...new Set(out)].slice(0, 5);
}

/** 사양 요구를 규칙으로. op: min | max | eq */
function parseSpecRules(q) {
  const rules = [];
  const seen = new Set();
  SPEC_RULES.forEach(rule => {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(q)) !== null) {
      let key = rule.key, value, word, text = m[0].trim();
      if (key === 'gb') {
        const ctx = String(m[1] || '').toLowerCase();
        const n = Number(m[2]);
        const tb = /tb|테라/i.test(m[3]);
        word = m[4];
        if (/램|ram|메모리/.test(ctx)) key = 'ram_gb';
        else if (/ssd|저장|용량/.test(ctx) || tb) key = 'storage_gb';
        else key = n <= 64 ? 'ram_gb' : 'storage_gb';   // 문맥이 없으면 크기로 가른다 (추정 — assumed)
        value = tb ? n * 1024 : n;
        const r = { key, value, op: /이하|미만/.test(word || '') ? 'max' : (word ? 'min' : 'eq'), text,
          assumed: !/램|ram|메모리|ssd|저장|용량/.test(ctx) && !tb };
        if (!seen.has(r.key)) { seen.add(r.key); rules.push(r); }
        continue;
      }
      value = Math.round(Number(m[1]) * rule.mul);
      word = m[3] || m[2];
      if (!(value > 0)) continue;
      const op = /이하|미만|아래|가벼운/.test(word || '') ? 'max' : /이상|넘는|초과/.test(word || '') ? 'min' : 'eq';
      if (key === 'weight_g' && op === 'eq') continue;   // "1kg 짜리" 는 요구가 아니라 설명일 때가 많다
      if (!seen.has(key)) { seen.add(key); rules.push({ key, value, op, text, assumed: false }); }
    }
  });
  return rules;
}

/** "3개" → 3. 없으면 null. */
function parseCount(q) {
  const m = COUNT_RE.exec(String(q || ''));
  if (!m) return null;
  const n = Number(m[2] || m[1]);
  return n >= 1 ? { value: Math.min(n, MAX_CANDIDATES), said: n, text: m[0] } : null;
}

/** 숫자 없이 말한 조건 → [{key, label, text, rule, threshold, basis}] */
function parseAttributes(q, specRules, target) {
  const P = target && target.P;
  const out = [];
  ATTRS.forEach(a => {
    const m = a.re.exec(q);
    if (!m) return;
    if (a.key === 'light' && specRules.some(r => r.key === 'weight_g')) return;   // "1.5kg 이하" 가 이미 있다
    const th = a.key === 'light' && P && P.light ? P.light : null;
    out.push({
      key: a.key, label: a.label, text: m[0].trim(),
      threshold: th,
      rule: th ? `무게 ${fmtWeight(th)} 이하` : null,
      basis: a.key === 'light'
        ? (th ? `숫자를 말하지 않아 SEOSA 기준으로 확인해요` : '상품명의 무게 표기로만 확인해요')
        : '상품명에 적힌 사용 시간·용량으로만 확인해요. 기준 숫자가 없어 «충족» 이라고 단정하지 않아요'
    });
  });
  return out;
}
function fmtWeight(g) { return g >= 1000 ? `${Math.round(g / 100) / 10}kg` : `${g}g`; }

/**
 * @returns {object|null} 이해할 수 없으면 null
 */
function parseQuestion(question) {
  const raw = clean(question, MAX_QUESTION);
  if (raw.length < 2) return null;
  const constraints = parseConstraints(raw);
  const exclusions = parseExclusions(raw);
  const specRules = parseSpecRules(raw);
  const count = parseCount(raw);

  let phrase = extractQuery(raw);
  // 조사 말투·제외어·사양 요구·개수 문구는 검색어가 아니다.
  specRules.forEach(r => { phrase = phrase.split(r.text).join(' '); });
  if (count) phrase = phrase.split(count.text).join(' ');
  const tokens = phrase.split(/\s+/).filter(t => t && !RESEARCH_WORDS.test(t) && exclusions.indexOf(t) === -1
    && !/^\d+(\.\d+)?(kg|g|l|ml|gb|tb|인치|형|mah|hz|개|가지|대)?$/i.test(t));

  /*
   * 무엇을 찾는가 — 머리 명사 규칙(_product-role.targetOf).
   * "배터리가 오래가는 노트북" 은 노트북(본체)을, "노트북 배터리" 는 배터리(부속)를 찾는다.
   */
  const target = PR.targetOf(raw, { tokens });
  const attributes = parseAttributes(raw, specRules, target);

  /*
   * 검색어 = 머리 명사 + 그 앞의 꾸밈말(게이밍·무선…). 조건 낱말(가볍고·오래가)과,
   * 본체를 찾을 때의 부속 낱말(배터리)은 뺀다 — 검색어에 남으면 그 낱말을 가진 상품이
   * 순위에서 올라온다(원래 버그).
   */
  let searchPhrase = tokens.join(' ').trim();
  if (target) {
    const P = target.P;
    const isAccWord = t => !target.generic && P.accTerms.some(x => x.re.test(t));
    const keep = tokens.filter(t => !ATTR_WORD.test(t) && !(target.role === PR.MAIN && isAccWord(t))
      && lower(t).indexOf(lower(target.anchorText)) === -1 && lower(target.anchorText).indexOf(lower(t)) === -1);
    const head = target.role === PR.ACCESSORY ? `${target.anchorText} ${target.accessory.term}` : target.anchorText;
    searchPhrase = keep.concat([head]).join(' ').replace(/\s+/g, ' ').trim();
  }
  const category = (target && target.category) || detectCategory(searchPhrase || raw) || '';
  /*
   * DB 에서 후보를 찾을 낱말 — 기기 이름(부속을 찾으면 기기 이름 + 부속).
   * 비어 있으면 무엇을 찾는지 모르는 것이다 (API 가 400).
   */
  const searchTokens = !target ? [] : (target.role === PR.ACCESSORY ? [target.anchorText, target.accessory.term] : [target.anchorText]);
  let wanted = wantedFeatures(raw);
  // "가볍고" 는 무게 숫자로 확인한다(attributes). 기능 «경량» 으로 한 번 더 세지 않는다.
  if (attributes.some(a => a.key === 'light')) wanted = wanted.filter(f => f !== '경량');
  return {
    raw, searchPhrase, searchTokens, constraints, category,
    wantedFeatures: wanted, useCase: extractUseCase(raw),
    exclusions, specRules, attributes,
    requestedCount: count ? count.value : null, countSaid: count ? count.said : null,
    target
  };
}
function lower(s) { return String(s || '').toLowerCase(); }

/* ================================================================== *
 *  2) 후보 고르기 (사전 필터 — DB 에서 온 카탈로그 행)
 * ================================================================== */

/**
 * @param {object[]} rows    products 행 (여러 번의 검색에서 모은 것 — 중복은 여기서 걸러진다)
 * @param {object} parsed    parseQuestion 결과
 * @returns {{keep:object[], excluded:{productId,title,reason,kind,group}[], relevant:number, accepted:number}}
 *   keep      원장 검증까지 가져갈 행 (최대 MAX_VERIFY)
 *   accepted  역할·판매 여부·제외 요청을 통과한 행 수 (MAX_VERIFY 로 자르기 전)
 */
function prefilter(rows, parsed) {
  const keep = [];
  const excluded = [];
  const seen = new Set();
  const target = parsed.target;
  const words = parsed.searchPhrase.split(/\s+/).filter(t => t.length >= 2 && /[가-힣A-Za-z]/.test(t));
  const c = parsed.constraints || {};
  const cap = c.budgetMax > 0 ? (c.budgetSoft ? c.budgetMax * (1 + SOFT_BUDGET_SLACK) : c.budgetMax) : 0;
  (rows || []).forEach(r => {
    if (!r || !r.product_id || !r.title) return;
    const key = `${r.product_id}|${r.mall || ''}|${r.vendor_item_id || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    const title = String(r.title);
    const ex = { productId: r.product_id, title };
    /*
     * 1) 찾는 «종류» 인가 — 본체를 찾는데 배터리·건전지·키보드면 여기서 끝난다.
     *    검색어에 «배터리» 가 들어 있다는 이유로 이 검사를 끄지 않는다(원래 버그).
     *    판단은 상품명으로만 한다. 수집 키워드("노트북 배터리")는 근거가 아니다.
     */
    if (target) {
      const cls = PR.classify(title, target);
      const a = PR.accepts(target, cls);
      if (!a.ok) { excluded.push(Object.assign(ex, { reason: a.reason, kind: a.kind, group: a.group })); return; }
      r._role = cls;
    }
    if (productLifecycle(r).state !== 'live') {
      excluded.push(Object.assign(ex, { reason: '최근 가격 확인이 안 돼 지금 파는지 알 수 없어요', kind: 'stale', group: null }));
      return;
    }
    const hit = parsed.exclusions.find(w => title.indexOf(w) > -1);
    if (hit) { excluded.push(Object.assign(ex, { reason: `제외 요청(${hit})`, kind: 'exclusion', group: hit })); return; }
    const hay = `${title} ${r.keyword || ''}`;
    // 검색어의 다른 낱말(게이밍·무선…)이 얼마나 맞는지 — 순서를 정하는 데만 쓴다.
    r._match = words.filter(w => hay.indexOf(w) > -1).length;
    // 카탈로그 가격이 예산 안인 것부터 검증한다 — 판정은 원장 가격으로 다시 한다.
    r._inBudget = cap > 0 && Number(r.lprice) > 0 && Number(r.lprice) <= cap ? 1 : 0;
    keep.push(r);
  });
  keep.sort((a, b) => (b._inBudget - a._inBudget) || (b._match - a._match)
    || String(b.collected_at || '').localeCompare(String(a.collected_at || '')));
  // relevant = 실제로 «살펴본» 상품 수 (종류가 달라 뺀 것, 검증 상한에 걸려 잘린 것까지 센다).
  return { keep: keep.slice(0, MAX_VERIFY), excluded, relevant: keep.length + excluded.length, accepted: keep.length };
}

/* ================================================================== *
 *  3) 후보 검증
 * ================================================================== */

function verifiedSpecs(title) {
  const sp = extractSpecs(title);
  const out = {};
  Object.keys(sp.specs || {}).forEach(k => {
    if (k === 'model' || k === 'color') return;
    const ev = sp.evidence && sp.evidence[k];
    // 제목에 그 글자가 실제로 있을 때만 쓴다 — 추출기의 실수를 한 번 더 거른다.
    if (ev && title.indexOf(ev) > -1) out[k] = { value: sp.specs[k], text: ev, evidence: ev };
  });
  return out;
}

function priceOf(row, points, today) {
  const catalog = Number(row.lprice) > 0 ? Math.round(Number(row.lprice)) : null;
  const last = points && points.length ? points[points.length - 1] : null;
  if (last) {
    const staleDays = Number.isFinite(dayNum(today)) ? Math.max(0, dayNum(today) - dayNum(last.date)) : null;
    return {
      value: last.price,
      verified: staleDays != null && staleDays <= FRESH_DAYS && (catalog == null || catalog === last.price),
      observedDate: last.date, staleDays, source: 'price_history', catalogPrice: catalog
    };
  }
  return {
    value: catalog, verified: false,
    observedDate: row.collected_at ? String(row.collected_at).slice(0, 10) : null,
    staleDays: null, source: 'catalog', catalogPrice: catalog
  };
}

function checkRule(rule, specs) {
  const s = specs[rule.key];
  const label = SPEC_LABEL[rule.key] || rule.key;
  if (!s) return { unknown: `${label}: 상품명에 표기가 없어 «${rule.text}» 조건을 확인하지 못했어요` };
  const v = s.value;
  if (rule.op === 'max' && v > rule.value) return { violation: `${label} ${s.text} — «${rule.text}» 조건을 넘어요` };
  if (rule.op === 'min' && v < rule.value) return { violation: `${label} ${s.text} — «${rule.text}» 조건에 못 미쳐요` };
  if (rule.op === 'eq' && Math.abs(v - rule.value) > rule.value * EQ_TOLERANCE) {
    return { violation: `${label} ${s.text} — 찾는 ${rule.text} 와 달라요` };
  }
  return {};
}

/*
 * 배터리 표기 — 판매자가 상품명에 적은 사용 시간·용량. 없으면 null.
 * «배터리 20시간», «최대 20시간 사용», «72Wh» 처럼 숫자와 단위가 붙은 것만 쓴다.
 */
function batteryEvidence(title, specs) {
  const t = String(title || '');
  const h = /(?:배터리|사용|재생|연속|최대)[^\d\n]{0,8}(\d{1,2}(?:\.\d)?)\s*시간|(\d{1,2}(?:\.\d)?)\s*시간\s*(?:사용|재생|지속|연속)/.exec(t);
  if (h) return { unit: 'h', value: Number(h[1] || h[2]), text: h[0].trim() };
  const wh = /(\d{2,3}(?:\.\d{1,2})?)\s*wh(?![a-z])/i.exec(t);
  if (wh) return { unit: 'wh', value: Number(wh[1]), text: wh[0].trim() };
  if (specs.battery_mah) return { unit: 'mah', value: specs.battery_mah.value, text: specs.battery_mah.text };
  return null;
}

/** 숫자 없이 말한 조건을 상품명으로 확인한다. status: met | unmet | claimed | unknown */
function checkAttribute(attr, title, specs) {
  if (attr.key === 'light') {
    const w = specs.weight_g;
    if (w && attr.threshold) {
      return w.value <= attr.threshold
        ? { status: 'met', pro: `무게 ${w.text} — 가벼움 기준(${fmtWeight(attr.threshold)} 이하)에 맞아요`, evidence: w.text }
        : { status: 'unmet', violation: `무게 ${w.text} — «가벼운» 기준(${fmtWeight(attr.threshold)} 이하)보다 무거워요`, evidence: w.text };
    }
    if (w) return { status: 'claimed', pro: `무게 ${w.text} (상품명 표기)`, evidence: w.text };
    const claim = /초경량|경량|가벼운|라이트\s?웨이트/.exec(title);
    return {
      status: 'unknown', evidence: claim ? claim[0] : null,
      unknown: claim ? `무게: 숫자 표기가 없어 가벼운지 확인하지 못했어요 (상품명에는 «${claim[0]}» 라고만 적혀 있어요)`
        : '무게: 상품명에 표기가 없어 «가벼운» 조건을 확인하지 못했어요'
    };
  }
  if (attr.key === 'battery') {
    const b = batteryEvidence(title, specs);
    if (b) return { status: 'claimed', pro: `배터리: 상품명에 «${b.text}» 표기 (판매자 표기)`, evidence: b.text, battery: b };
    const claim = /(?:대용량|장시간|고용량)\s*배터리|배터리\s*(?:대용량|장시간)/.exec(title);
    return {
      status: 'unknown', evidence: claim ? claim[0] : null,
      unknown: claim ? `배터리: 사용 시간 숫자가 없어 확인하지 못했어요 (상품명에는 «${claim[0]}» 라고만 적혀 있어요)`
        : '배터리: 상품명에 사용 시간·용량 표기가 없어 «배터리 오래가는» 조건을 확인하지 못했어요'
    };
  }
  return { status: 'unknown', unknown: `${attr.label}: 확인하지 못했어요` };
}

/**
 * 가격 기록의 두께 — «최저가» · «싸다» 를 말해도 되는지 (_price-claims 와 같은 기준).
 * points 는 날짜별 최저가 한 점씩이므로 점 수 = 관측한 날 수다.
 */
function priceRecordOf(points, current) {
  const pts = (points || []).filter(p => p && p.date && p.price > 0);
  const b = PC.basisOf({ points: pts });
  if (!pts.length) return { obs: 0, spanDays: 0, enough: false, low: null, lowDate: null, firstDate: null, lastDate: null, atLow: false };
  const low = Math.min.apply(null, pts.map(p => p.price));
  let lowDate = null;
  for (let i = pts.length - 1; i >= 0; i--) { if (pts[i].price === low) { lowDate = pts[i].date; break; } }
  return {
    obs: b.obs, spanDays: b.spanDays, enough: b.enough,
    minObs: PC.RECORD_MIN_OBS, minSpanDays: PC.RECORD_MIN_SPAN_DAYS,
    low, lowDate, firstDate: pts[0].date, lastDate: pts[pts.length - 1].date,
    atLow: current != null && current <= low
  };
}

function evaluate(row, points, parsed, today) {
  const title = String(row.title);
  const specs = verifiedSpecs(title);
  const price = priceOf(row, points, today);
  // matchFeatures 는 제목이 아니라 extractSpecs 결과(features)를 받는다 (_specs.js).
  const fm = parsed.wantedFeatures.length ? matchFeatures(extractSpecs(title), parsed.wantedFeatures) : { hit: [], miss: [] };
  const violations = [];
  const unknowns = [];
  const attrPros = [];
  const c = parsed.constraints || {};
  if (price.value && c.budgetMax > 0) {
    const cap = c.budgetSoft ? c.budgetMax * (1 + SOFT_BUDGET_SLACK) : c.budgetMax;
    if (price.value > cap) violations.push(`가격 ${won(price.value)}원 — 예산 ${won(c.budgetSaid || c.budgetMax)}원을 넘어요`);
  }
  if (price.value && c.budgetMin > 0 && price.value < c.budgetMin) {
    violations.push(`가격 ${won(price.value)}원 — 말씀하신 가격대(${won(c.budgetMin)}원 이상)보다 낮아요`);
  }
  if (!price.value) unknowns.push('가격을 확인하지 못했어요');
  parsed.specRules.forEach(rule => {
    const r = checkRule(rule, specs);
    if (r.violation) violations.push(r.violation);
    if (r.unknown) unknowns.push(r.unknown);
  });
  const attributes = (parsed.attributes || []).map(attr => {
    const r = checkAttribute(attr, title, specs);
    if (r.violation) violations.push(r.violation);
    if (r.unknown) unknowns.push(r.unknown);
    if (r.pro) attrPros.push(r.pro);
    return { key: attr.key, label: attr.label, status: r.status, evidence: r.evidence || null, battery: r.battery || null };
  });

  /*
   * 가격 위치·판정은 기록이 두꺼울 때만 (관측 7일 · 기간 14일 이상).
   * 기록 3일로 "싼 편이다" · "지금 사도 좋다" 를 말하지 않는다.
   */
  const record = priceRecordOf(points, price.value);
  let level = null, deal = null;
  if (points && points.length) {
    if (record.enough) {
      const lv = fairness(points, price.value, today);
      level = { level: lv.level, label: lv.label, pctRank: lv.pctRank, obs: lv.obs, windowDays: lv.windowDays };
      const d = dealOf(statsFrom(points), price.value, today);
      deal = d ? { verdict: d.verdict, label: d.label } : null;
    } else {
      level = { level: 'insufficient', label: '판단 데이터 부족', pctRank: null, obs: record.obs, windowDays: record.spanDays };
    }
  }
  return {
    productId: row.product_id,
    mall: row.mall || '',
    mallLabel: row.mall_label || row.mall || '',
    vendorItemId: row.vendor_item_id || '',
    title,
    image: /^https:\/\//i.test(row.image || '') ? row.image : null,
    url: /^https:\/\//i.test(row.link || '') ? row.link : null,
    price,
    priceHistory: record,
    role: row._role ? { role: row._role.role, confidence: row._role.confidence, why: row._role.why } : null,
    specs: { verified: specs, matchedFeatures: fm.hit, unverifiedFeatures: fm.miss },
    attributes,
    fits: violations.length === 0 && !!price.value,
    violations,
    unknowns,
    level,
    deal,
    historyDays: points ? points.length : 0,
    pros: [],
    cons: [],
    _attrPros: attrPros
  };
}

/* ================================================================== *
 *  4) 장단점 — 데이터에서만
 * ================================================================== */

function prosAndCons(list) {
  const n = list.length;
  const priced = list.filter(c => c.price.value);
  if (n >= 2 && priced.length >= 2) {
    const min = Math.min.apply(null, priced.map(c => c.price.value));
    const max = Math.max.apply(null, priced.map(c => c.price.value));
    if (max > min) {
      priced.filter(c => c.price.value === min).forEach(c =>
        c.pros.push({ text: `비교한 ${n}개 중 가장 저렴해요 (${won(min)}원)`, basis: 'comparison' }));
      priced.filter(c => c.price.value === max).forEach(c =>
        c.cons.push({ text: `비교한 ${n}개 중 가장 비싸요 (${won(max)}원)`, basis: 'comparison' }));
    }
  }
  Object.keys(BETTER).forEach(key => {
    const has = list.filter(c => c.specs.verified[key]);
    if (has.length < 2) return;
    const vals = has.map(c => c.specs.verified[key].value);
    const lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (lo === hi) return;
    const best = BETTER[key] === 'low' ? lo : hi;
    const worst = BETTER[key] === 'low' ? hi : lo;
    // 절반 이상이 같은 값이면 «가장 ~» 은 정보가 아니다 (넷 중 셋이 «램이 가장 작아요»).
    const rare = v => has.filter(c => c.specs.verified[key].value === v).length * 2 <= has.length;
    has.forEach(c => {
      const s = c.specs.verified[key];
      if (s.value === best && rare(best)) c.pros.push({ text: `${has.length}개 중 ${BETTER_WORD[key][0]} (${s.text})`, basis: 'title' });
      if (s.value === worst && rare(worst)) c.cons.push({ text: `${has.length}개 중 ${BETTER_WORD[key][1]} (${s.text})`, basis: 'title' });
    });
  });
  // 배터리 표기 비교 — 같은 단위(시간·Wh·mAh)끼리만, 둘 이상일 때만.
  ['h', 'wh', 'mah'].forEach(unit => {
    const has = list.filter(c => (c.attributes || []).some(a => a.battery && a.battery.unit === unit));
    if (has.length < 2) return;
    const val = c => c.attributes.find(a => a.battery && a.battery.unit === unit).battery;
    const hi = Math.max.apply(null, has.map(c => val(c).value));
    const top = has.filter(c => val(c).value === hi);
    if (top.length * 2 > has.length) return;
    top.forEach(c => c.pros.push({ text: `${has.length}개 중 배터리 표기가 가장 커요 (${val(c).text})`, basis: 'title' }));
  });
  list.forEach(c => {
    (c._attrPros || []).forEach(t => c.pros.push({ text: t, basis: 'title' }));
    c.specs.matchedFeatures.forEach(f => c.pros.push({ text: `${f} — 상품명에 표기돼 있어요`, basis: 'title' }));
    c.specs.unverifiedFeatures.forEach(f => c.cons.push({ text: `${f} — 상품명에서 확인되지 않았어요 (없다는 뜻은 아니에요)`, basis: 'title' }));
    /*
     * 가격 위치 — 기간과 건수를 함께 말한다 ("최근 90일" 은 창의 길이일 뿐 기록의 길이가 아니다).
     * 기록이 얇으면(evaluate 의 record.enough=false) 판단하지 않았다고만 말한다.
     */
    const lv = c.level;
    const rec = c.priceHistory || {};
    const basis = `SEOSA 기록 ${rec.spanDays}일·관측 ${rec.obs}회`;
    if (rec.enough && rec.atLow) {
      c.pros.push({ text: `지금 가격이 ${basis} 중 최저가예요 (기록 이전 가격은 알 수 없어요)`, basis: 'price_history' });
    } else if (lv && lv.pctRank != null && lv.pctRank <= 30) {
      c.pros.push({ text: `지금 가격이 ${basis} 중 하위 ${lv.pctRank}%예요`, basis: 'price_history' });
    } else if (lv && lv.pctRank != null && lv.pctRank >= 70) {
      c.cons.push({ text: `지금 가격이 ${basis} 중 상위 ${100 - lv.pctRank}%로 비싼 편이에요`, basis: 'price_history' });
    } else if (lv && lv.level === 'insufficient') {
      c.cons.push({ text: `가격 기록이 ${rec.spanDays}일·관측 ${rec.obs}회뿐이라 싼지 비싼지 아직 판단하기 일러요`, basis: 'price_history' });
    }
    if (c.deal && (c.deal.verdict === 'BUY' || c.deal.verdict === 'GOOD_BUY')) {
      c.pros.push({ text: `가격 판정: ${c.deal.label}`, basis: 'deal_engine' });
    } else if (c.deal && (c.deal.verdict === 'WAIT' || c.deal.verdict === 'DONT_BUY')) {
      c.cons.push({ text: `가격 판정: ${c.deal.label}`, basis: 'deal_engine' });
    }
    if (!c.price.verified) {
      c.cons.push({
        text: c.price.source === 'price_history' && c.price.staleDays != null && c.price.staleDays > FRESH_DAYS
          ? `가격이 ${c.price.staleDays}일 전 기록이라 지금과 다를 수 있어요`
          : '가격을 최근 기록으로 확인하지 못했어요',
        basis: 'price_history'
      });
    }
    c.unknowns.forEach(u => c.cons.push({ text: u, basis: 'title' }));
  });
}

/* ================================================================== *
 *  5) 요약 + 근거 검사
 * ================================================================== */

/** 요약 속 숫자·날짜가 전부 근거 안에 있는가. */
function groundCheck(text, evidence) {
  const tokens = String(text).match(/\d{4}-\d{2}-\d{2}|\d[\d,]*(?:\.\d+)?/g) || [];
  const unmatched = tokens.map(t => t.replace(/,/g, '')).filter(t => !evidence.has(t));
  return { ok: unmatched.length === 0, unmatched: [...new Set(unmatched)] };
}

function evidenceOf(candidates, extra) {
  const ev = new Set((extra || []).map(String));
  candidates.forEach(c => {
    // 상품명 속 숫자(모델명·연식·인치)는 판매자가 쓴 데이터다 — 요약에 제목을 옮기면 함께 온다.
    (String(c.title).match(/\d[\d,]*(?:\.\d+)?/g) || []).forEach(x => ev.add(x.replace(/,/g, '')));
    [c.price.value, c.price.catalogPrice].forEach(v => { if (v) ev.add(String(v)); });
    if (c.price.observedDate) ev.add(c.price.observedDate);
    if (c.price.staleDays != null) ev.add(String(c.price.staleDays));
    Object.keys(c.specs.verified).forEach(k => {
      const t = c.specs.verified[k].text;
      (t.match(/\d[\d,]*(?:\.\d+)?/g) || []).forEach(x => ev.add(x.replace(/,/g, '')));
    });
    if (c.level) {
      [c.level.pctRank, c.level.obs, c.level.windowDays].forEach(v => { if (v != null) ev.add(String(v)); });
      if (c.level.pctRank != null) ev.add(String(100 - c.level.pctRank));
    }
    c.pros.concat(c.cons).forEach(p => (p.text.match(/\d[\d,]*(?:\.\d+)?/g) || []).forEach(x => ev.add(x.replace(/,/g, ''))));
  });
  return ev;
}

/** "부속품 12개(배터리 8개·키보드 4개)" — 묶음이 많으면 앞의 3개만. */
function groupLine(g) {
  const parts = g.groups.slice(0, 3).map(x => `${x.name} ${x.count}개`);
  return `${g.label} ${g.count}개${parts.length ? `(${parts.join('·')})` : ''}`;
}

/** 조사 범위 한 줄 — 어디서, 몇 번, 실시간 검색을 썼는가. */
function scopeLine(coverage) {
  const cv = coverage || {};
  const n = (cv.attempts || []).length;
  const live = cv.liveSearch === 'used'
    ? '실시간 쇼핑몰 검색도 한 번 했어요'
    : cv.liveSearch === 'off' ? '실시간 쇼핑몰 검색은 꺼져 있어 SEOSA가 이미 수집한 쿠팡·ADPICK 상품만 조사했어요' : '';
  const tries = n > 1 ? `원하는 상품이 모자라 검색어를 바꿔 모두 ${n}번 찾았어요` : '';
  return [tries, live].filter(Boolean).join('. ');
}

function summarize(parsed, candidates, excluded, scanned, ctx) {
  const x = ctx || {};
  const lines = [];
  const cond = [constraintLine(parsed.constraints)].concat((parsed.attributes || []).map(a => a.label)).filter(Boolean).join(' · ');
  const target = parsed.target;
  const what = target ? PR.describeTarget(target) : (parsed.searchPhrase || parsed.category || '요청하신 상품');
  lines.push(`«${what}»${cond ? ` (${cond})` : ''}로 SEOSA 가격 기록이 있는 상품 ${scanned}개를 살펴 ${candidates.length}개를 비교했어요.`);
  const scope = scopeLine(x.coverage);
  const roleGroups = (x.groups || []).filter(g => ['accessory', 'accessory-other', 'unrelated', 'other-device', 'main'].indexOf(g.kind) > -1);
  const notWhat = target && target.role === PR.ACCESSORY ? `찾는 ${target.accessory.term}` : PR.describeTarget(target);
  const J = PR._internal.josa;
  const roleText = roleGroups.length ? `${roleGroups.map(groupLine).join(', ')}는 ${notWhat}${J(notWhat, '이', '가')} 아니라서 뺐어요.` : '';
  // 종류는 맞지만 조건(예산·무게·판매 여부·제외 요청)에 걸린 상품
  const condText = x.condN ? `${target ? `${notWhat} 중 ` : ''}${x.condN}개는 조건에 맞지 않아 뺐어요 (아래 제외 사유 참고).` : '';

  if (!candidates.length) {
    if (target && x.accepted === 0 && !x.condN) {
      lines.push(`${notWhat}${J(notWhat, '은', '는')} 찾지 못했어요.`);
      if (roleText) lines.push(roleText);
    } else {
      lines.push(excluded.length
        ? '조건에 맞는 상품을 찾지 못했어요. 아래 제외 사유를 보고 조건을 조금 넓혀 보세요.'
        : 'SEOSA가 가격을 기록하고 있는 상품 중에는 찾지 못했어요. 다른 말로 찾아보세요.');
      if (condText) lines.push(condText);
      if (roleText) lines.push(roleText);
    }
    if (scope) lines.push(`${scope}.`);
    return lines.join(' ');
  }
  if (x.requested && candidates.length < x.requested) {
    lines.push(`요청하신 ${x.requested}개 중 ${candidates.length}개만 조건에 맞았어요.`);
  }
  const top = candidates[0];
  const pro = top.pros[0];
  /*
   * 상품명 뒤에 조사를 붙이지 않는다 — 판매자 제목은 한글·영문·숫자 어느 것으로도 끝나서
   * "노트북예요" 같은 비문이 나온다. 쌍점으로 이어 붙인다.
   */
  lines.push(`가장 잘 맞는 상품: ${cutTitle(top.title, 34)} — ${won(top.price.value)}원 (${top.price.observedDate} 기록).`);
  if (pro) lines.push(`${pro.text}.`);
  const con = top.cons[0];
  if (con) lines.push(`다만 ${con.text}.`);
  if (candidates[1]) lines.push(`다음 후보: ${cutTitle(candidates[1].title, 34)} — ${won(candidates[1].price.value)}원.`);
  // 종류가 달라 뺀 상품은 결과가 충분해도 밝힌다 — 무엇을 걸렀는지 사용자가 알아야 한다.
  if (x.requested && candidates.length < x.requested && condText) lines.push(condText);
  if (roleText) lines.push(roleText);
  if (x.requested && candidates.length < x.requested && scope) lines.push(`${scope}.`);
  lines.push('사양은 상품명에 적힌 것만 옮겼고, 가격은 판매처에서 한 번 더 확인해 주세요.');
  return lines.join(' ');
}

/** 매긴 순서에 쓰는 조건 점수 — 확인된(met) 2, 판매자 표기(claimed) 1. */
function attrScore(c) {
  return (c.attributes || []).reduce((s, a) => s + (a.status === 'met' ? 2 : a.status === 'claimed' ? 1 : 0), 0);
}

/**
 * @param {{parsed:object, rows:object[], pointsByKey:Map, today:string, limit?:number, scanned?:number,
 *          excluded?:object[], source?:string, coverage?:object, accepted?:number}} input
 */
function investigate(input) {
  const parsed = input.parsed;
  const today = input.today;
  const asked = Number(input.limit) || parsed.requestedCount || DEFAULT_COUNT;
  const limit = Math.max(1, Math.min(MAX_CANDIDATES, asked));
  const requested = parsed.requestedCount ? limit : null;
  const excluded = (input.excluded || []).slice();

  const evaluated = (input.rows || []).map(r => evaluate(r,
    input.pointsByKey.get(`${r.product_id}|${r.mall || ''}|${r.vendor_item_id || ''}`) || [], parsed, today));
  const fits = [];
  evaluated.forEach(c => {
    if (c.fits) fits.push(c);
    else excluded.push({ productId: c.productId, title: c.title, reason: c.violations[0] || c.unknowns[0] || '조건 확인 불가', kind: 'condition', group: null });
  });

  // Concierge 와 같은 순서 — rankItems 가 예산·우선순위·검색어 적합도로 세운다.
  const items = fits.map(c => ({ title: c.title, price: c.price.value, mall: c.mallLabel, spec: extractSpecs(c.title), _c: c }));
  let ranked = items;
  try { ranked = rankItems(items, parsed.constraints, parsed.searchPhrase); } catch (e) { ranked = items; }
  /*
   * 순서 보정 (Array.sort 는 안정 정렬이라 같은 값끼리는 Concierge 순서가 남는다).
   *   1) 요청한 기능이 제목에서 더 많이 확인된 상품
   *   2) 숫자 없이 말한 조건(가볍고·배터리)이 상품명으로 확인된 상품
   *   3) 요청 조건 중 «확인 못 한» 것이 적은 상품 — 무게 표기가 없는 상품이 무게가
   *      확인된 상품보다 앞서면, 확인되지 않은 것을 조건 충족으로 대접하는 셈이다.
   *   4) 가격이 원장으로 검증된 상품 — 확인 못 한 값을 1순위 가격으로 내세우지 않는다.
   */
  const candidates = ranked.map(it => it._c)
    .sort((a, b) => (b.specs.matchedFeatures.length - a.specs.matchedFeatures.length)
      || (attrScore(b) - attrScore(a))
      || (a.unknowns.length - b.unknowns.length)
      || ((b.price.verified ? 1 : 0) - (a.price.verified ? 1 : 0)))
    .slice(0, limit);

  prosAndCons(candidates);
  candidates.forEach(c => { delete c._attrPros; });
  const scanned = input.scanned == null ? evaluated.length : input.scanned;
  const groups = PR.groupDropped(excluded);
  const coverage = Object.assign({ source: input.source || 'catalog', scanned }, input.coverage || {});
  const accepted = input.accepted == null ? evaluated.length : input.accepted;
  const condN = excluded.filter(e => ['condition', 'stale', 'exclusion'].indexOf(e.kind) > -1).length;
  let text = summarize(parsed, candidates, excluded, scanned, { groups, coverage, requested, accepted, condN });
  const evidence = evidenceOf(candidates, [scanned, candidates.length, requested, parsed.countSaid, condN,
    (coverage.attempts || []).length,
    parsed.constraints && parsed.constraints.budgetSaid, parsed.constraints && parsed.constraints.budgetMax,
    parsed.constraints && parsed.constraints.budgetMin]
    .concat(groups.reduce((a, g) => a.concat([g.count], g.groups.map(x => x.count)), []))
    .concat((parsed.attributes || []).map(a => a.threshold ? fmtWeight(a.threshold) : '').join(' ').match(/\d[\d,.]*/g) || [])
    .concat(parsed.specRules.map(r => String(r.text).match(/\d[\d,.]*/) ? String(r.text).match(/\d[\d,.]*/)[0].replace(/,/g, '') : ''))
    .concat((constraintLine(parsed.constraints).match(/\d[\d,]*/g) || []).map(v => v.replace(/,/g, '')))
    .concat((parsed.searchPhrase.match(/\d[\d,.]*/g) || []).map(v => v.replace(/,/g, '')))
    .filter(v => v != null && v !== ''));
  let grounded = groundCheck(text, evidence);
  if (!grounded.ok) {
    // 숫자가 근거에서 벗어났다 — 숫자 없는 요약으로 물러난다.
    text = candidates.length
      ? `조건에 맞는 상품을 비교했어요. 가장 잘 맞는 상품: ${cutTitle(candidates[0].title, 34)}. 자세한 가격과 사양은 아래 표를 확인해 주세요.`
      : '조건에 맞는 상품을 찾지 못했어요. 아래 제외 사유를 확인해 주세요.';
    grounded = Object.assign(groundCheck(text, evidence), { replaced: true, original: grounded.unmatched });
  }

  /*
   * 제외 목록 — 조건을 어긴 «본체» 를 먼저 보여 준다. 부속품 수십 개가 앞을 채우면
   * 사용자는 정작 예산에 걸린 본체를 보지 못한다. 종류별 개수는 excludedGroups 에 있다.
   */
  const ORDER = { condition: 0, exclusion: 1, stale: 2, main: 3, 'accessory-other': 4, accessory: 5, 'other-device': 6, unrelated: 7, unknown: 8 };
  const excludedOut = excluded.map((e, i) => Object.assign({ _i: i }, e))
    .sort((a, b) => ((ORDER[a.kind] == null ? 9 : ORDER[a.kind]) - (ORDER[b.kind] == null ? 9 : ORDER[b.kind])) || (a._i - b._i))
    .slice(0, MAX_EXCLUDED)
    .map(e => ({ productId: e.productId, title: e.title, reason: e.reason, kind: e.kind || null }));

  const target = parsed.target;
  return {
    query: {
      raw: parsed.raw, searchPhrase: parsed.searchPhrase, category: parsed.category,
      target: target ? {
        profile: target.profile, label: target.label, role: target.role,
        accessory: target.accessory ? target.accessory.term : null, describe: PR.describeTarget(target)
      } : null,
      requestedCount: parsed.requestedCount, countSaid: parsed.countSaid,
      constraints: parsed.constraints, constraintLine: constraintLine(parsed.constraints),
      wantedFeatures: parsed.wantedFeatures, useCase: parsed.useCase,
      attributes: parsed.attributes || [],
      exclusions: parsed.exclusions, specRules: parsed.specRules
    },
    candidates,
    excluded: excludedOut,
    excludedGroups: groups,
    excludedTotal: excluded.length,
    summary: { text, grounded },
    coverage,
    disclaimers: [
      '사양은 판매자가 쓴 상품명에서만 확인했어요. 상세 페이지에만 있는 사양은 «확인 안 됨» 으로 표시돼요.',
      `«최저가»·«싼 편» 같은 가격 판단은 SEOSA 기록이 ${PC.RECORD_MIN_OBS}일·${PC.RECORD_MIN_SPAN_DAYS}일 이상 쌓인 상품에만 붙여요. 기록 이전 가격과 다른 판매처 가격은 알 수 없어요.`,
      '가격은 SEOSA가 기록한 시점의 값이에요. 쿠폰·카드 할인은 반영하지 않았어요.',
      '추천 순서는 광고나 수수료와 무관하게 조건 적합도로만 정했어요.'
    ]
  };
}

module.exports = {
  parseQuestion, prefilter, investigate, evaluate, prosAndCons, groundCheck, evidenceOf,
  parseExclusions, parseSpecRules, parseCount, parseAttributes, verifiedSpecs, cutTitle, batteryEvidence,
  MAX_CANDIDATES, MAX_VERIFY, FRESH_DAYS
};
