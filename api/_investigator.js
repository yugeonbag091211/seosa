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
const { isAccessory } = require('./_radar');
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

/**
 * @returns {object|null} 이해할 수 없으면 null
 */
function parseQuestion(question) {
  const raw = clean(question, MAX_QUESTION);
  if (raw.length < 2) return null;
  const constraints = parseConstraints(raw);
  const exclusions = parseExclusions(raw);
  const specRules = parseSpecRules(raw);

  let phrase = extractQuery(raw);
  // 조사 말투·제외어·사양 요구 문구는 검색어가 아니다.
  specRules.forEach(r => { phrase = phrase.split(r.text).join(' '); });
  const tokens = phrase.split(/\s+/).filter(t => t && !RESEARCH_WORDS.test(t) && exclusions.indexOf(t) === -1
    && !/^\d+(\.\d+)?(kg|g|l|ml|gb|tb|인치|형|mah|hz)?$/i.test(t));
  const searchPhrase = tokens.join(' ').trim();
  const category = detectCategory(searchPhrase || raw) || '';
  /*
   * DB 에서 후보를 찾을 낱말. 카테고리 명사가 있으면 그것 하나가 가장 넓고 정확하다
   * ("가벼운 게이밍 노트북" → "노트북"). 없으면 검색어의 마지막 낱말(대개 명사).
   */
  const searchTokens = category && searchPhrase.indexOf(category) > -1
    ? [category]
    : tokens.filter(t => /[가-힣A-Za-z]/.test(t) && t.length >= 2).slice(-1);
  return {
    raw, searchPhrase, searchTokens, constraints, category,
    wantedFeatures: wantedFeatures(raw), useCase: extractUseCase(raw),
    exclusions, specRules
  };
}

/* ================================================================== *
 *  2) 후보 고르기 (사전 필터 — DB 에서 온 카탈로그 행)
 * ================================================================== */

/**
 * @param {object[]} rows    products 행
 * @param {object} parsed    parseQuestion 결과
 * @returns {{keep:object[], excluded:{productId,title,reason}[], relevant:number}}
 */
function prefilter(rows, parsed) {
  const keep = [];
  const excluded = [];
  const seen = new Set();
  const wantAccessory = isAccessory(parsed.searchPhrase);
  const words = parsed.searchPhrase.split(/\s+/).filter(t => t.length >= 2 && /[가-힣A-Za-z]/.test(t));
  (rows || []).forEach(r => {
    if (!r || !r.product_id || !r.title) return;
    const key = `${r.product_id}|${r.mall || ''}|${r.vendor_item_id || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    const title = String(r.title);
    const hay = `${title} ${r.keyword || ''}`;
    // 검색 낱말(카테고리)이 제목·키워드에 없으면 관련 없는 상품이다 — 사유 목록에 올리지도 않는다.
    if (!parsed.searchTokens.every(t => hay.indexOf(t) > -1)) return;
    const ex = { productId: r.product_id, title };
    if (productLifecycle(r).state !== 'live') { excluded.push(Object.assign(ex, { reason: '최근 가격 확인이 안 돼 지금 파는지 알 수 없어요' })); return; }
    if (!wantAccessory && isAccessory(title)) { excluded.push(Object.assign(ex, { reason: '본품이 아니라 부속품이에요' })); return; }
    const hit = parsed.exclusions.find(w => title.indexOf(w) > -1);
    if (hit) { excluded.push(Object.assign(ex, { reason: `제외 요청(${hit})` })); return; }
    // 검색어의 다른 낱말(게이밍·무선…)이 얼마나 맞는지 — 순서를 정하는 데만 쓴다.
    r._match = words.filter(w => hay.indexOf(w) > -1).length;
    keep.push(r);
  });
  keep.sort((a, b) => (b._match - a._match) || String(b.collected_at || '').localeCompare(String(a.collected_at || '')));
  // relevant = 카테고리가 맞아 실제로 «살펴본» 상품 수 (검증 상한에 걸려 잘린 것까지 센다).
  return { keep: keep.slice(0, MAX_VERIFY), excluded, relevant: keep.length + excluded.length };
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

function evaluate(row, points, parsed, today) {
  const title = String(row.title);
  const specs = verifiedSpecs(title);
  const price = priceOf(row, points, today);
  // matchFeatures 는 제목이 아니라 extractSpecs 결과(features)를 받는다 (_specs.js).
  const fm = parsed.wantedFeatures.length ? matchFeatures(extractSpecs(title), parsed.wantedFeatures) : { hit: [], miss: [] };
  const violations = [];
  const unknowns = [];
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
  let level = null, deal = null;
  if (points && points.length) {
    level = fairness(points, price.value, today);
    const d = dealOf(statsFrom(points), price.value, today);
    deal = d ? { verdict: d.verdict, label: d.label } : null;
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
    specs: { verified: specs, matchedFeatures: fm.hit, unverifiedFeatures: fm.miss },
    fits: violations.length === 0 && !!price.value,
    violations,
    unknowns,
    level: level ? { level: level.level, label: level.label, pctRank: level.pctRank, obs: level.obs, windowDays: level.windowDays } : null,
    deal,
    historyDays: points ? points.length : 0,
    pros: [],
    cons: []
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
  list.forEach(c => {
    c.specs.matchedFeatures.forEach(f => c.pros.push({ text: `${f} — 상품명에 표기돼 있어요`, basis: 'title' }));
    c.specs.unverifiedFeatures.forEach(f => c.cons.push({ text: `${f} — 상품명에서 확인되지 않았어요 (없다는 뜻은 아니에요)`, basis: 'title' }));
    const lv = c.level;
    if (lv && lv.pctRank != null && lv.pctRank <= 30) {
      c.pros.push({ text: `지금 가격이 최근 ${lv.windowDays}일 기록 중 하위 ${lv.pctRank}%예요`, basis: 'price_history' });
    } else if (lv && lv.pctRank != null && lv.pctRank >= 70) {
      c.cons.push({ text: `지금 가격이 최근 ${lv.windowDays}일 기록 중 상위 ${100 - lv.pctRank}%로 비싼 편이에요`, basis: 'price_history' });
    } else if (lv && lv.level === 'insufficient') {
      c.cons.push({ text: `가격 기록이 ${lv.obs}일치뿐이라 싼지 비싼지 아직 판단하기 일러요`, basis: 'price_history' });
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

function summarize(parsed, candidates, excluded, scanned) {
  const lines = [];
  const cond = constraintLine(parsed.constraints);
  const what = parsed.searchPhrase || parsed.category || '요청하신 상품';
  lines.push(`«${what}»${cond ? ` (${cond})` : ''}로 SEOSA 가격 기록이 있는 상품 ${scanned}개를 살펴 ${candidates.length}개를 비교했어요.`);
  if (!candidates.length) {
    lines.push(excluded.length
      ? '조건에 맞는 상품을 찾지 못했어요. 아래 제외 사유를 보고 조건을 조금 넓혀 보세요.'
      : 'SEOSA가 가격을 기록하고 있는 상품 중에는 찾지 못했어요. 다른 말로 찾아보세요.');
    return lines.join(' ');
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
  lines.push('사양은 상품명에 적힌 것만 옮겼고, 가격은 판매처에서 한 번 더 확인해 주세요.');
  return lines.join(' ');
}

/**
 * @param {{parsed:object, rows:object[], pointsByKey:Map, today:string, limit?:number, scanned?:number,
 *          excluded?:object[], source?:string}} input
 */
function investigate(input) {
  const parsed = input.parsed;
  const today = input.today;
  const limit = Math.max(1, Math.min(MAX_CANDIDATES, Number(input.limit) || MAX_CANDIDATES));
  const excluded = (input.excluded || []).slice();

  const evaluated = (input.rows || []).map(r => evaluate(r,
    input.pointsByKey.get(`${r.product_id}|${r.mall || ''}|${r.vendor_item_id || ''}`) || [], parsed, today));
  const fits = [];
  evaluated.forEach(c => {
    if (c.fits) fits.push(c);
    else excluded.push({ productId: c.productId, title: c.title, reason: c.violations[0] || c.unknowns[0] || '조건 확인 불가' });
  });

  // Concierge 와 같은 순서 — rankItems 가 예산·우선순위·검색어 적합도로 세운다.
  const items = fits.map(c => ({ title: c.title, price: c.price.value, mall: c.mallLabel, spec: extractSpecs(c.title), _c: c }));
  let ranked = items;
  try { ranked = rankItems(items, parsed.constraints, parsed.searchPhrase); } catch (e) { ranked = items; }
  // 요청한 기능이 제목에서 확인된 상품을 앞에 — 같은 조건이면 확인된 쪽이 낫다.
  /*
   * 순서 보정 (Array.sort 는 안정 정렬이라 같은 값끼리는 Concierge 순서가 남는다).
   *   1) 요청한 기능이 제목에서 더 많이 확인된 상품
   *   2) 요청 조건 중 «확인 못 한» 것이 적은 상품 — 무게 표기가 없는 상품이 무게가
   *      확인된 상품보다 앞서면, 확인되지 않은 것을 조건 충족으로 대접하는 셈이다.
   */
  const candidates = ranked.map(it => it._c)
    .sort((a, b) => (b.specs.matchedFeatures.length - a.specs.matchedFeatures.length)
      || (a.unknowns.length - b.unknowns.length)
      // 3) 가격이 원장으로 검증된 상품 — 확인 못 한 값을 1순위 가격으로 내세우지 않는다.
      || ((b.price.verified ? 1 : 0) - (a.price.verified ? 1 : 0)))
    .slice(0, limit);

  prosAndCons(candidates);
  const scanned = input.scanned == null ? evaluated.length : input.scanned;
  let text = summarize(parsed, candidates, excluded, scanned);
  const evidence = evidenceOf(candidates, [scanned, candidates.length,
    parsed.constraints && parsed.constraints.budgetSaid, parsed.constraints && parsed.constraints.budgetMax,
    parsed.constraints && parsed.constraints.budgetMin]
    .concat(parsed.specRules.map(r => String(r.text).match(/\d[\d,.]*/) ? String(r.text).match(/\d[\d,.]*/)[0].replace(/,/g, '') : ''))
    .concat((constraintLine(parsed.constraints).match(/\d[\d,]*/g) || []).map(x => x.replace(/,/g, '')))
    .concat((parsed.searchPhrase.match(/\d[\d,.]*/g) || []).map(x => x.replace(/,/g, '')))
    .filter(Boolean));
  let grounded = groundCheck(text, evidence);
  if (!grounded.ok) {
    // 숫자가 근거에서 벗어났다 — 숫자 없는 요약으로 물러난다.
    text = candidates.length
      ? `조건에 맞는 상품 ${candidates.length}개를 비교했어요. 가장 잘 맞는 상품: ${cutTitle(candidates[0].title, 34)}. 자세한 가격과 사양은 아래 표를 확인해 주세요.`
      : '조건에 맞는 상품을 찾지 못했어요.';
    grounded = Object.assign(groundCheck(text, evidence), { replaced: true, original: grounded.unmatched });
  }

  return {
    query: {
      raw: parsed.raw, searchPhrase: parsed.searchPhrase, category: parsed.category,
      constraints: parsed.constraints, constraintLine: constraintLine(parsed.constraints),
      wantedFeatures: parsed.wantedFeatures, useCase: parsed.useCase,
      exclusions: parsed.exclusions, specRules: parsed.specRules
    },
    candidates,
    excluded: excluded.slice(0, 20),
    summary: { text, grounded },
    coverage: { source: input.source || 'catalog', scanned },
    disclaimers: [
      '사양은 판매자가 쓴 상품명에서만 확인했어요. 상세 페이지에만 있는 사양은 «확인 안 됨» 으로 표시돼요.',
      '가격은 SEOSA가 기록한 시점의 값이에요. 쿠폰·카드 할인은 반영하지 않았어요.',
      '추천 순서는 광고나 수수료와 무관하게 조건 적합도로만 정했어요.'
    ]
  };
}

module.exports = {
  parseQuestion, prefilter, investigate, evaluate, prosAndCons, groundCheck, evidenceOf,
  parseExclusions, parseSpecRules, verifiedSpecs, cutTitle,
  MAX_CANDIDATES, MAX_VERIFY, FRESH_DAYS
};
