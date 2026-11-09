'use strict';

// Self-contained v3 pipeline. Only this module decides which products may reach cards.
//
// v3.2 (2026-11-06 root-cause work, see docs/ai-v31-rootcause-2026-11-06/):
//  * user-grounded intent: informational questions never search; "X 가격
//    비교" about ONE product is a price lookup; "N만원대" is a band;
//  * "그중/위에서" follow-ups re-validate the cards actually displayed (loaded
//    by ID) instead of re-searching and intersecting;
//  * model codes are verified token-wise ("소니 WF-C700N" no longer needs the
//    brand and code to be contiguous in the seller title);
//  * exclusions are the user's words only (no product IDs, no particles);
//  * early returns keep the newly stated budget and report model usage.
const MAX_RESULTS = 16;
const MAX_CARDS = 4;
const { extractTitleEvidence, requestedIdentity, mergeRequested, checkListingIdentity } = require('./_ai-v3-identity');
const { canonicalCategory, canonicalName, comparisonFromUtterance, explicitType, productTypeMatches,
  isPart, mergeFeatures, featureContext, familyCategory } = require('./_ai-v31-taxonomy');
const { brandMatches, brandsFromUser, modelEvidence, modelClues, linesFromUser } = require('./_ai-v31-retrieval');
const { parseBudget, analyzeUtterance, userExclusions, groundExclusions, excludedBy, LOOKS_LIKE_ID } = require('./_ai-v32-intent');
const MAX_CANDIDATE_SCAN = 200;
const clean = (x, n = 120) => String(x == null ? '' : x).normalize('NFKC')
  .replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const flat = x => clean(x, 200).toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
const nprice = v => v == null || v === '' ? null
  : Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null;
const money = n => Number(n).toLocaleString('ko-KR') + '원';
const ALIASES = {
  '노트북': ['노트북','랩탑','laptop','그램','맥북','thinkpad','ideapad','vivobook','갤럭시북'],
  '태블릿': ['태블릿','아이패드','ipad','갤럭시탭','galaxy tab'],
  '이어폰': ['이어폰','이어버드','earbuds','버즈','에어팟','airpods'],
  '헤드폰': ['헤드폰','헤드셋','headset','headphone'],
  '마우스': ['마우스','mouse','mx master'],
  '키보드': ['키보드','keyboard'],
  '스마트폰': ['스마트폰','휴대폰','핸드폰','아이폰','iphone','갤럭시s'],
  '공기청정기': ['공기청정기','air purifier'],
  '청소기': ['청소기','로보락','roborock','로봇청소기','vacuum'],
  '모니터': ['모니터','monitor','display'],
  '스피커': ['스피커','speaker'],
  '시계': ['시계','스마트워치','watch','애플워치'],
  '기타': ['일렉기타','어쿠스틱기타','electric guitar','acoustic guitar']
};
// Second-hand evidence includes seller grading ("S급", "모든등급", "개봉 제품").
const USED = /중고|리퍼|리퍼비시|전시품|전시상품|(?:특\s*S|S|A\+?|B|C)\s*급(?!\s*(?:에너지|효율))|모든\s*등급|리퍼급|개봉\s*(?:된\s*)?(?:제품|상품)|거의\s*새\s*(?:제품|것|상품)|단순\s*(?:변심|개봉)|반품\s*(?:제품|상품|회수)|회수\s*제품|\b(?:used|refurbished|renewed|open[\s-]?box)\b/i;
const TRANSLITERATIONS = [
  ['아이패드', 'ipad'], ['갤럭시탭', 'galaxytab'],
  ['에어팟', 'airpods'], ['맥북', 'macbook'], ['갤럭시북', 'galaxybook']
];
function matchesComparisonSubject(title, subject) {
  const required = requestedIdentity(subject);
  if (required.family) return checkListingIdentity(title, required).ok;
  const t = flat(title), q = flat(subject);
  if (!q) return false;
  if (t.includes(q)) return true;
  if (TRANSLITERATIONS.some(pair => pair.includes(q) && pair.some(alias => t.includes(alias)))) return true;
  const terms = clean(subject).split(/[\s,./]+/).map(flat).filter(x => x.length >= 2);
  return terms.length > 1 && terms.every(x => t.includes(x));
}

function categoryOk(item, requested, userMessage='') {
  if (!requested) return false;
  // Never trust a seller's keyword/category tail as proof of product type.
  const canonical=canonicalName(requested);
  if(canonical)return productTypeMatches(item.title,canonical,userMessage);
  const type = flat(requested);
  const title = flat(item.title);
  const cats = flat([item.category, item.productCategory, item.categoryName].filter(Boolean).join(' '));
  const primaryTitle = String(item.title || '').split(/\/디지털기기/i)[0];
  const headphoneRequest = type.includes('헤드셋') || type.includes('헤드폰') ||
    type === 'headset' || type === 'headphone';
  if (headphoneRequest &&
    /이어폰|이어버드|earbuds|에어팟|airpods|갤럭시\s*버즈|galaxy\s*buds/i.test(primaryTitle) &&
    !/헤드셋|헤드폰|headset|headphone/i.test(primaryTitle)) return false;
  if (cats.includes(type) || title.includes(type)) return true;
  const entry = Object.entries(ALIASES).find(([name, words]) =>
    type === flat(name) || type.includes(flat(name)) ||
    words.some(w => flat(w) === type));
  return !!(entry && entry[1].some(w => title.includes(flat(w)) || cats.includes(flat(w))));
}
function normalize(item) {
  if (!item || typeof item !== 'object') return null;
  const title = clean(item.title, 180);
  const id = clean(item.productId || item.id, 100);
  const price = nprice(item.lprice == null ? item.price : item.lprice);
  const mall = clean(item.mall, 40);
  const url = clean(item.link || item.url, 1500);
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  if (!id || !title || !price || !mall) return null;
  // Explicit free-shipping evidence is different from "shipping fee missing".
  let shipping = item.shippingFee != null && item.shippingFee !== ''
    && Number.isSafeInteger(Number(item.shippingFee)) && Number(item.shippingFee) >= 0
    ? Number(item.shippingFee) : null;
  if (shipping === null && item.isFreeShipping === true) shipping = 0;
  return {
    id: mall + ':' + id, title, price, mall, url,
    image: clean(item.image, 1000), category: clean(item.category || item.categoryName, 70),
    source: clean(item._source || item.source, 30), shipping,
    used: USED.test(title), budgetTier: 'not_applicable',
    identityEvidence: extractTitleEvidence(title)
  };
}
// A fitted accessory ("아이패드 에어 11 M4 키보드 케이스") must name the host
// device it fits. Seller titles LIST compatible models ("에어 11 M2 M3 M4"),
// so each requested attribute is checked as set membership, not as the
// single identity a device title would have.
function compatibilityEvidence(title, host) {
  const t = String(title || '').normalize('NFKC').toLowerCase();
  const familyWords = { ipad: /(?:아이패드|ipad)/, galaxytab: /(?:갤럭시\s*탭|galaxy\s*tab|갤탭)/ };
  if (familyWords[host.family] && !familyWords[host.family].test(t)) return { ok: false, field: 'family' };
  const variantWords = { air: /(?:에어|air)/, pro: /(?:프로|pro)(?!\s*맥스)/, mini: /(?:미니|mini)/, fe: /\bfe\b/ };
  if (host.variant && variantWords[host.variant] && !variantWords[host.variant].test(t)) return { ok: false, field: 'variant' };
  // "에어 11", "11인치", "11 M4" — but not "11색" or "10/11세대".
  if (host.screenInches) {
    const n = String(host.screenInches).replace('.', '\\.');
    const size = new RegExp('(?:(?:에어|air|프로|pro|미니|mini)\\s*' + n + '(?![\\d.])|(?<![\\d.])' + n +
      '\\s*(?:인치|inch|형|"|in\\b)|(?<![\\d.])' + n + '\\s*m\\d)', 'i');
    if (!size.test(t)) return { ok: false, field: 'screenInches' };
  }
  if (host.chip && !new RegExp('(?<![a-z0-9])' + host.chip.replace('-', '\\s*') + '(?![0-9])').test(t)) return { ok: false, field: 'chip' };
  if (host.series && host.family === 'galaxytab' && !new RegExp('s\\s*' + host.series + '(?!\\d)').test(t)) return { ok: false, field: 'series' };
  return { ok: true };
}
function sanitizePlan(input, prev = {}, utterance = '') {
  const o = input && typeof input === 'object' ? input : {};
  const historyQuery = clean(prev.lastQuery, 80);
  const query = clean(o.query, 80) || historyQuery;
  const compareQuery = clean(o.compareQuery, 80)
    || (o.mode === 'compare' ? clean(prev.compareQuery, 80) : '');
  const category = canonicalCategory({
    message:utterance, query, planCategory:o.category, priorCategory:prev.category
  });
  const priorCategory=canonicalName(prev.category);
  const spokenCategory=explicitType(utterance);
  const changedType=!!(spokenCategory&&priorCategory&&spokenCategory!==priorCategory);
  const features=mergeFeatures(prev.features,utterance,changedType);
  // "그중 SSD 제품만" in an external-storage conversation means external SSD.
  if(category==='외장하드'&&/\bssd\b/i.test(utterance)&&!/\bhdd\b/i.test(utterance))features.externalSsd=true;
  const mentionedBrand=brandsFromUser(utterance,category)[0]||'';
  const brandTerm=mentionedBrand ? mentionedBrand : changedType ? '' : clean(prev.brandTerm,35);
  // Exclusions are grounded in the user's words; GPT may only restate them.
  const priorExclusions=(Array.isArray(prev.exclusions)?prev.exclusions:[])
    .map(x=>clean(x,55)).filter(x=>x&&!LOOKS_LIKE_ID.test(x));
  const exclusions = [...new Set([
    ...userExclusions(utterance),
    ...priorExclusions,
    ...groundExclusions(o.exclusions, utterance, priorExclusions)
  ].map(x => clean(x, 55)).filter(Boolean))].slice(0, 8);
  // Budget: the user's literal words win; GPT fills in only when the user
  // stated nothing in this turn; a follow-up never silently drops the budget.
  const budget=parseBudget(utterance);
  let maxPrice=budget.max!=null?budget.max:o.maxPrice==null?nprice(prev.maxPrice):nprice(o.maxPrice);
  let maxExclusive=budget.max!=null?budget.maxExclusive:o.maxPrice==null?!!prev.maxExclusive:false;
  let minPrice=budget.min!=null?budget.min:nprice(prev.minPrice);
  if(budget.band){minPrice=budget.min;maxPrice=budget.max;maxExclusive=false;}
  if (minPrice != null && maxPrice != null && minPrice > maxPrice) minPrice = null;
  const mallOnly = clean(o.mallOnly || prev.mallOnly, 35);
  const exactModel = clean(o.exactModel, 80);
  const anchoredModel = exactModel && flat(utterance + ' ' + historyQuery).includes(flat(exactModel))
    ? exactModel : '';
  // Model codes the USER typed (verified token-wise against titles).
  const modelText = (modelClues(utterance).length || linesFromUser(utterance).length) ? clean(utterance, 160)
    : (changedType || (spokenCategory && !/(?:그\s*중|이\s*중|위에서)/.test(utterance) && mentionedBrand) ? '' : clean(prev.modelText, 160));
  const newOnly = /중고.{0,9}(?:제외|빼|싫|말고|아닌|아니)|(?:새상품|새제품|신품|미개봉|새\s*(?:것|거|제품))/i.test(utterance);
  const usedRequested = /중고|리퍼|리퍼비시|전시품|전시상품/i.test(utterance) && !newOnly;
  return {
    query, compareQuery, category, features, brandTerm,
    maxPrice, maxExclusive, minPrice, exclusions, mallOnly, modelText,
    exactModel: anchoredModel, allowUsed: newOnly ? false : usedRequested || !!prev.allowUsed,
    // "중고 X 찾아줘": condition-labelled used listings rank first (not a hard
    // filter — many used listings carry no condition label).
    usedPreferred: newOnly ? false : usedRequested || (!changedType && !!prev.usedPreferred),
    mode: o.mode === 'none' ? 'none' : o.mode === 'compare' ? 'compare' : 'recommend',
    budgetSource: budget.max!=null||budget.min!=null ? 'user' : o.maxPrice!=null ? 'model' : prev.maxPrice!=null ? 'prior' : 'none'
  };
}
function validateCandidates(plan, raw, { limit = MAX_RESULTS } = {}) {
  const accepted = [], provisional = [], rejected = [], reasons = {};
  const seen = new Set();
  const inspected = Math.min(Array.isArray(raw) ? raw.length : 0, MAX_CANDIDATE_SCAN);
  for (const source of (Array.isArray(raw) ? raw : []).slice(0, MAX_CANDIDATE_SCAN)) {
    const item = normalize(source);
    let reason = !item ? 'invalid_listing' : '';
    // Validate what is actually being sold, not every incidental accessory
    // word in a seller's gift/promotion copy.
    if(!reason && isPart(item.title,plan.category))
      reason='accessory_not_requested';
    if (!reason && !categoryOk(item,plan.category,plan.subject||'')) reason = 'wrong_category';
    if (!reason && item.used && !plan.allowUsed) reason = 'used_not_requested';
    if (!reason && plan.identity && Object.keys(plan.identity).length) {
      const evidence = checkListingIdentity(item.title, plan.identity, { category: plan.category });
      if (!evidence.ok) reason = evidence.reason;
    }
    if (!reason && plan.compatibility && compatibilityRequired(plan)) {
      if (!compatibilityEvidence(item.title, plan.compatibility).ok) reason = 'compatibility_unverified';
    }
    if(!reason && plan.brandTerm && !brandMatches(item.title,plan.brandTerm,plan.category))reason='wrong_brand';
    if (!reason && plan.mallOnly && !flat(item.mall).includes(flat(plan.mallOnly))) reason = 'wrong_merchant';
    if (!reason && plan.modelText && !modelEvidence(item.title, plan.modelText).ok) reason = 'wrong_model';
    if (!reason && Array.isArray(plan.exclusions) && excludedBy(item.title, plan.exclusions)) reason = 'excluded';
    if (!reason && plan.minPrice != null && item.price < plan.minPrice) reason = 'below_min_price';
    if (!reason && plan.maxPrice != null && (plan.maxExclusive ? item.price >= plan.maxPrice : item.price > plan.maxPrice)) reason = 'over_budget';
    if (!reason && plan.maxPrice != null && item.shipping != null &&
      item.price + item.shipping > plan.maxPrice) reason = 'over_budget';
    // Same listing re-posted under another ID (identical title and price).
    const twin = item && flat(item.title).slice(0, 60) + '|' + item.price;
    if (!reason && (seen.has(item.id) || seen.has(twin))) reason = 'duplicate';
    if (reason) {
      reasons[reason] = (reasons[reason] || 0) + 1;
      rejected.push({ reason });
      continue;
    }
    seen.add(item.id); seen.add(twin);
    if (plan.maxPrice != null && item.shipping == null) {
      item.budgetTier = 'listing_only_shipping_unverified';
      provisional.push(item);
    } else {
      item.budgetTier = plan.maxPrice != null ? 'total_verified' : 'not_applicable';
      accepted.push(item);
    }
  }
  return { accepted: accepted.slice(0, limit), provisional: provisional.slice(0, limit),
    acceptedCount: accepted.length, provisionalCount: provisional.length,
    rejected, checked: inspected, reasons };
}
// Reference market for an identity: listings of the same product type whose
// title evidence agrees with the requested identity on the fields it states.
// A candidate below 35% of that median price is flagged (needs >= 3 refs).
function priceOutliers(plan, rawItems) {
  const id = plan.identity || {};
  const strongKeys = ['family', 'series', 'variant', 'storageGb', 'chip'].filter(k => id[k] != null);
  // A low-price listing for a *generic category* (e.g. a beginner classical
  // guitar) can be genuine. Only compare market prices for grounded exact
  // identity attributes, never just a model-generated search phrase.
  if (!strongKeys.length) return new Set();
  const refs = [];
  for (const source of (rawItems || []).slice(0, MAX_CANDIDATE_SCAN)) {
    const item = normalize(source);
    if (!item || item.used || isPart(item.title, plan.category) || !categoryOk(item, plan.category, plan.subject || '')) continue;
    const e = item.identityEvidence || {};
    // a reference must STATE the same identity (a capacity-less listing is no market reference)
    if (!strongKeys.every(k => e[k] != null && String(e[k]) === String(id[k]))) continue;
    if (plan.modelText && !modelEvidence(item.title, plan.modelText).ok) continue;
    refs.push(item);
  }
  if (refs.length < 3) return new Set();
  const prices = refs.map(x => x.price).sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  return new Set(refs.filter(x => x.price < median * 0.35).map(x => x.id));
}
// Tablet keyboards and keyboard cases are model-specific fits.
function compatibilityRequired(plan) {
  return plan.category === '키보드' && plan.compatibility &&
    ['ipad', 'galaxytab'].includes(plan.compatibility.family) &&
    Object.keys(plan.compatibility).some(k => k !== 'family');
}
function toCard(item) {
  return {
    productId: item.id, title: item.title, price: item.price, priceText: money(item.price),
    mall: item.mall, link: item.url, image: item.image,
    priceStatus: item.source === 'api' ? 'observed' : 'cached_or_unverified',
    shippingFee: item.shipping, budgetStatus: item.budgetTier,
    totalPrice: item.shipping != null ? item.price + item.shipping : null,
    condition: item.used ? 'used_or_refurbished' : 'unknown',
    titleEvidence: item.identityEvidence, specEvidenceSource: 'seller_listing_title_only'
  };
}
function hasUnverifiedShipping(cards) {
  return cards.some(c => c.budgetStatus === 'listing_only_shipping_unverified');
}
function compareTitleSpecifications(cards) {
  const [a, b] = cards;
  const x = a.titleEvidence || {}, y = b.titleEvidence || {};
  // Seller-title claims are not verified manufacturer spec sheets.
  const fields = [
    ['storageGb', '저장용량', 'GB'],
    ['ramGb', '메모리(RAM)', 'GB'],
    ['screenInches', '화면 크기', '인치'],
    ['chip', '칩 표기', ''],
    ['network', '통신 방식 표기', '']
  ];
  const available = fields.filter(([field]) => x[field] != null && y[field] != null)
    .slice(0, 3)
    .map(([field, label, unit]) =>
      label + '은(는) 판매 제목 기준으로 각각 ' + x[field] + unit + ', ' + y[field] + unit + '입니다.');
  if (x.family && x.family === y.family && x.generation != null && y.generation != null)
    available.push('세대 표기는 각각 ' + x.generation + '세대, ' + y.generation + '세대입니다.');
  return available.length
    ? available.join(' ') + ' 실제 제조사 사양과 같은지 추가 확인이 필요합니다.'
    : '상세 성능·규격은 판매 제목만으로 객관적으로 비교할 근거가 부족합니다.';
}
function comparisonAnswer(cards) {
  const [a, b] = cards;
  // Only compare prices actually provided by the listing; never invent delivery totals.
  const hasTotals = [a, b].every(c => Number.isSafeInteger(c.totalPrice));
  const aAmount = hasTotals ? a.totalPrice : a.price;
  const bAmount = hasTotals ? b.totalPrice : b.price;
  const diff = Math.abs(aAmount - bAmount);
  const cheaper = aAmount === bAmount ? null : aAmount < bAmount ? a : b;
  const summary = [a, b].map(c => c.title + ' ' + c.priceText).join(' / ');
  const basis = hasTotals ? '확인된 배송비를 포함한 기록상 금액' : '상품 표시 가격';
  const priceDifference = cheaper
    ? basis + ' 기준 ' + cheaper.title + ' 쪽이 ' + money(diff) + ' 낮습니다.'
    : basis + '은 두 상품이 같습니다.';
  const shipping = hasTotals
    ? '확인된 배송비 포함 합계는 각각 ' + money(aAmount) + ', ' + money(bAmount) + '입니다.'
    : '배송비가 확인되지 않은 상품이 있어 최종 결제 금액 비교는 불가능합니다.';
  return '선택된 실제 판매 상품 기준 비교: ' + summary + '. ' + priceDifference + ' ' + shipping
    + ' ' + compareTitleSpecifications(cards)
    + ' 세대·용량·구성이 다를 수 있으니 같은 조건인지 상품 상세에서 확인해 주세요.';
}
// One named product across sellers: report the displayed price range only.
function priceLookupAnswer(cards) {
  const prices = cards.map(c => c.price).sort((a, b) => a - b);
  const range = prices.length > 1 ? money(prices[0]) + '~' + money(prices[prices.length - 1]) : money(prices[0]);
  return '같은 모델로 확인된 판매 상품 ' + cards.length + '개의 표시 가격은 ' + range + '입니다(낮은 가격 순). '
    + '배송비·옵션·쿠폰에 따라 최종 결제 금액이 달라질 수 있으니 판매처에서 확인해 주세요.';
}
function resultFromSelection(plan, candidates, choice) {
  const ids = Array.isArray(choice && choice.productIds) ? choice.productIds : [];
  const index = new Map(candidates.map(x => [x.id, x]));
  const selected = [], seen = new Set();
  for (const id of ids) {
    if (!index.has(id) || seen.has(id)) continue;
    seen.add(id); selected.push(index.get(id));
    if (selected.length >= MAX_CARDS) break;
  }
  const cards = selected.map(toCard);
  let answer;
  if (!cards.length) answer = '지금 확인 가능한 상품 중에는 조건에 맞는 후보가 없어요. 검색어 또는 조건을 조정해 주세요.';
  else if (plan.mode === 'compare' && cards.length >= 2) answer = comparisonAnswer(cards);
  else if (hasUnverifiedShipping(cards)) answer =
    '상품 표시 가격이 예산 이내인 후보입니다. 다만 배송비가 확인되지 않아 최종 결제 금액이 예산 이내인지는 보장할 수 없어요. 구매 전 배송비를 확인해 주세요.';
  else answer = '요청한 상품 조건에 맞는 후보를 찾았어요. 가격과 옵션은 판매처에서 최종 확인해 주세요.';
  return { answer, cards };
}
function stateFrom(plan, presented) {
  return {
    lastQuery: plan.query, compareQuery: plan.compareQuery,
    category: plan.category, features: plan.features, brandTerm: plan.brandTerm,
    maxPrice: plan.maxPrice, maxExclusive: !!plan.maxExclusive, minPrice: plan.minPrice,
    exclusions: plan.exclusions, mallOnly: plan.mallOnly,
    exactModel: plan.exactModel, modelText: plan.modelText || '', allowUsed: plan.allowUsed, usedPreferred: !!plan.usedPreferred,
    identity: plan.mode === 'compare' ? {} : (plan.identity || {}),
    ...(presented ? { presentedProductIds: presented } : {})
  };
}
async function createEngine({ planModel, decideModel, searchProducts, getUsage, loadDisplayed }, request) {
  if (typeof planModel !== 'function' || typeof decideModel !== 'function' ||
    typeof searchProducts !== 'function') throw new Error('Missing dependency');
  const message = clean(request && request.message, 800);
  if (!message) return { status: 400, error: 'message required' };
  const history = Array.isArray(request.history) ? request.history.slice(-8)
    .filter(x => x && ['user', 'assistant'].includes(x.role))
    .map(x => ({ role: x.role, content: clean(x.content, 500) })) : [];
  const saved = request && request.state && typeof request.state === 'object' ? request.state : {};
  const prior = {
    lastQuery: clean(saved.lastQuery, 80), compareQuery: clean(saved.compareQuery, 80),
    category: clean(saved.category, 36),brandTerm:clean(saved.brandTerm,35),
    features:saved.features&&typeof saved.features==='object'?{
      wireless:saved.features.wireless===true,anc:saved.features.anc===true,
      externalSsd:saved.features.externalSsd===true
    }: {},
    maxPrice: nprice(saved.maxPrice), maxExclusive: saved.maxExclusive === true, minPrice: nprice(saved.minPrice),
    exclusions: Array.isArray(saved.exclusions) ? saved.exclusions.map(x => clean(x, 55)).filter(Boolean).slice(0, 8) : [],
    mallOnly: clean(saved.mallOnly, 35), exactModel: clean(saved.exactModel, 80), allowUsed: !!saved.allowUsed, usedPreferred: saved.usedPreferred === true,
    modelText: clean(saved.modelText, 160),
    // A bounded list of server-presented IDs; an empty array means the last
    // answer actually displayed zero products. Missing means legacy state.
    presentedProductIds:Array.isArray(saved.presentedProductIds)?
      [...new Set(saved.presentedProductIds.filter(v=>typeof v==='string'&&v.length>0&&v.length<=160))].slice(0,4):null,
    identity: saved.identity && typeof saved.identity === 'object' ? Object.fromEntries(
      Object.entries(saved.identity).filter(([k,v]) =>
        ['family','series','variant','generation','storageGb','ramGb','screenInches','chip','network','caseMm'].includes(k)
        && (typeof v === 'string' || typeof v === 'number')
        && String(v).length <= 30)) : {}
  };
  const intent = analyzeUtterance(message);
  const usage = () => (typeof getUsage === 'function' ? { modelUsage: getUsage() } : {});
  const intentStats = () => ({ informational: intent.informational, thanks: intent.thanks,
    priceLookup: !!plan.priceLookup, followup: followupKind, wantsSingle: intent.wantsSingle,
    budgetSource: plan.budgetSource });
  let followupKind = null;
  const rawPlan = await planModel({ message, history, state: prior });
  const plan = sanitizePlan(rawPlan, prior, message);
  // Compare different product kinds even if the model omitted compareQuery.
  const twoKinds=comparisonFromUtterance(message);
  if(twoKinds)Object.assign(plan,{mode:'compare',query:twoKinds.query,
    compareQuery:twoKinds.compareQuery,category:twoKinds.category,
    features:mergeFeatures({},message,true)});
  // "삼성 T9 1TB 가격 비교해줘": one product across sellers, not two products.
  if(!twoKinds && intent.priceLookup && plan.mode==='compare' &&
    (!plan.compareQuery || flat(plan.compareQuery)===flat(plan.query) || !explicitType(plan.compareQuery) ||
     canonicalName(explicitType(plan.compareQuery))===plan.category)){
    plan.mode='recommend';plan.compareQuery='';plan.priceLookup=true;
  } else if(!twoKinds && intent.priceLookup && plan.mode==='recommend') plan.priceLookup=true;
  const groundedShoppingType=explicitType(message);
  const shoppingIntent=(intent.purchase||intent.hasBudget)&&!intent.informational&&!intent.thanks;
  // In a shopping-only interface, a *specific* product specification by itself
  // ("갤럭시탭 S10 FE 플러스 256GB 와이파이") is a search request even if
  // the planner chooses 'none'. Generic nouns and explanations do not qualify.
  const specificBareProduct=!!groundedShoppingType && !intent.informational && !intent.thanks &&
    /(?:\d{2,4}\s*(?:GB|TB|기가|테라|mm|인치)|\b[A-Z]{1,5}[-]?\d{1,3}\b)/i.test(message);
  if(plan.mode==='none' && groundedShoppingType && (shoppingIntent||specificBareProduct))
    plan.mode='recommend';
  // If GPT emptied the search keyword but the user named a product and
  // explicitly requested shopping, rebuild a bounded grounded query.
  if(plan.mode==='recommend' && !plan.query && groundedShoppingType && (shoppingIntent||specificBareProduct))
    plan.query=groundedShoppingType;
  // Follow-up filters are shopping actions even without a product noun.
  // A reference to previously displayed products is a filtering request,
  // even when GPT mistakenly selects "compare" without a second subject.
  // Preserve the actual displayed set and re-validate it deterministically.
  if(intent.referencesDisplayed && prior.lastQuery && !intent.informational &&
    !twoKinds && !/(?:비교|차이|\bvs\b)/i.test(message)){
    plan.mode='recommend';plan.compareQuery='';
    if(!plan.query)plan.query=clean(prior.lastQuery,80);
    if(!plan.category)plan.category=canonicalName(prior.category);
  }
  // An explanation question ("OLED와 LCD 차이가 있니?", "aptX 원리") or thanks
  // never triggers a product search, whatever the planner said.
  if(!twoKinds && (intent.informational || intent.thanks) && !intent.referencesDisplayed) plan.mode='none';
  const explicitIdentity = requestedIdentity(message);
  const changedSubject = !!(explicitIdentity.family && prior.identity.family
    && explicitIdentity.family !== prior.identity.family);
  // A different product type drops the previous product's identity.
  const priorCategory=canonicalName(prior.category);
  const typeChanged=!!(priorCategory && plan.category && priorCategory!==plan.category && !intent.referencesDisplayed);
  // An LLM-made search keyword is NOT evidence of user intent.
  // Only the user's utterance and carried conversation constraints may impose exact model requirements.
  plan.identity = mergeRequested(prior.identity, message, changedSubject || typeChanged);
  // A named host device of another category ("아이패드 에어 11 M4 키보드 케이스",
  // "맥북에 연결할 SSD") is a compatibility target, not the product's identity.
  if(plan.identity.family && familyCategory(plan.identity.family) &&
    familyCategory(plan.identity.family)!==plan.category) {
    plan.compatibility={...plan.identity};
    // A capacity in an external-storage request belongs to the drive, before
    // or after the noun ("맥북에 연결할 2TB 외장하드", "… 외장 SSD 512기가"), unless
    // it is glued to the host device itself ("맥북 256GB에 연결할").
    const hostStorage=/(?:맥북|macbook|아이패드|ipad|노트북|아이폰|iphone|갤럭시)[^,.]{0,12}?\d{2,4}\s*(?:gb|기가|tb|테라)\s*(?:에|용|과|와)/i.test(message);
    const storageEvidence=plan.category==='외장하드'&&!hostStorage?extractTitleEvidence(message):{};
    plan.identity=storageEvidence.storageGb?
      {storageGb:storageEvidence.storageGb}:{};
    // Model words that only describe the HOST ("에어 11", "M4") are checked
    // by compatibilityEvidence, not as the accessory's own model code.
    const hostOnly=c=>/^m\d{1,2}(?:pro|max)?$/.test(c.token)||/^(?:air|pro|mini)\d{1,2}$/.test(c.token);
    if(plan.modelText&&modelClues(plan.modelText).every(hostOnly))plan.modelText='';
  }
  if (plan.mode === 'none') return {
    status: 200,
    answer: intent.informational
      ? '이 대화창은 상품 검색·가격 비교 전용이라 설명형 질문에는 상품을 추천하지 않아요. 원하시는 상품이나 예산을 알려주시면 찾아드릴게요.'
      : '찾고 싶은 상품이나 쇼핑 관련 질문을 알려주세요.',
    cards: [], state: prior, stats: { searched: false, accepted: 0, provisional: 0, intent: intentStats(), ...usage() }
  };
  if (!plan.query || !plan.category || (plan.mode === 'compare' && !plan.compareQuery)) return {
    status: 200, answer: '찾으시는 상품 종류나 비교할 모델을 구체적으로 알려주세요.',
    // Keep what the user just stated (budget, exclusions) for the next turn.
    // No cards were presented in this turn: never silently reuse cards from
    // an older answer in a later "그중" instruction.
    cards: [], state: { ...stateFrom(plan), presentedProductIds: [] },
    stats: { searched: false, accepted: 0, provisional: 0, intent: intentStats(), ...usage() }
  };
  const subjectText=featureContext(message,plan.features);
  // ── "그중 / 위에서": re-validate the cards actually shown last turn ─────
  const refersToDisplayed=intent.referencesDisplayed&&plan.mode!=='compare'&&Array.isArray(prior.presentedProductIds);
  if(refersToDisplayed&&(typeof loadDisplayed==='function'||!prior.presentedProductIds.length)){
    followupKind='displayed';
    let pool=[],checked=0,reasons={},rejected=0;
    if(prior.presentedProductIds.length){
      const raw=await loadDisplayed(prior.presentedProductIds);
      if(!Array.isArray(raw))throw new Error('Invalid displayed lookup');
      const evaluated=validateCandidates({...plan,subject:subjectText},raw,{limit:MAX_CARDS});
      const order=new Map(prior.presentedProductIds.map((id,i)=>[id,i]));
      pool=[...evaluated.accepted,...evaluated.provisional].sort((a,b)=>(order.get(a.id)??9)-(order.get(b.id)??9));
      checked=evaluated.checked;reasons=evaluated.reasons;rejected=evaluated.rejected.length;
    }
    let cards=pool.slice(0,MAX_CARDS).map(toCard);
    if(intent.wantsSingle&&pool.length>1){
      const choice=await decideModel({message,history,plan,candidates:pool});
      const picked=resultFromSelection(plan,pool,choice).cards.slice(0,1);
      cards=picked.length?picked:cards.slice(0,1);
    } else if(intent.wantsSingle) cards=cards.slice(0,1);
    const answer=!prior.presentedProductIds.length
      ? '앞서 보여드린 상품이 없어 그중에서 고를 수 없어요. 조건을 말씀해 주시면 새로 찾아볼게요.'
      : !cards.length
        ? '앞서 보여드린 상품 중에는 새 조건에 맞는 상품이 없어요. 다른 상품까지 새로 찾으려면 그렇게 말씀해 주세요.'
        : '앞서 보여드린 상품 중 조건에 맞는 ' + cards.length + '개입니다. '
          + (hasUnverifiedShipping(cards) ? '배송비가 확인되지 않아 최종 결제 금액은 판매처에서 확인해 주세요.' : '가격과 옵션은 판매처에서 최종 확인해 주세요.');
    return { status:200, answer, cards,
      state: stateFrom(plan, cards.map(c=>c.productId)),
      stats: { searched:true, fetched:prior.presentedProductIds.length, inspected:checked, accepted:pool.length,
        provisional:0, rejected, rejectedReasons:reasons, chosen:cards.length, dbQueries: prior.presentedProductIds.length?1:0,
        intent: intentStats(), ...usage() } };
  }
  const queries = [...new Set([plan.query, ...(plan.mode === 'compare' ? [plan.compareQuery] : [])])].slice(0, 2);
  const groups = [], reasonCounts = {};
  let fetched = 0, inspected = 0, accepted = 0, provisional = 0, rejected = 0, dbQueries = 0;
  for (const query of queries) {
    // Carry the user's verified model/option constraints into catalog retrieval.
    // GPT may shorten a search keyword, but it cannot erase user-specified capacity.
    const groupIdentity = plan.mode === 'compare' ? requestedIdentity(query) : plan.identity;
    const groupCategory = plan.mode === 'compare'
      ? canonicalCategory({message:query,query,planCategory:plan.category}) : plan.category;
    const subject=featureContext(plan.mode==='compare'?query:message,plan.features)
      +(plan.mode==='compare'?'':[plan.brandTerm,plan.modelText&&plan.modelText!==message?plan.modelText:''].filter(Boolean).map(x=>' '+x).join(''));
    const raw = await searchProducts(query, { identity: groupIdentity,
      minPrice: plan.minPrice,maxPrice: plan.maxPrice,category:groupCategory,
      userText:subject });
    if (!Array.isArray(raw)) throw new Error('Invalid search result');
    dbQueries += Number(raw._queries) || 0;
    fetched += raw.length;
    // A comparison's two sides cannot borrow each other's similar-category products.
    const matched = plan.mode === 'compare'
      ? raw.filter(x => matchesComparisonSubject(x && x.title, query)) : raw;
    const excludedBySubject = raw.length - matched.length;
    if (excludedBySubject) reasonCounts.wrong_comparison_subject =
      (reasonCounts.wrong_comparison_subject || 0) + excludedBySubject;
    const evaluated = validateCandidates(
      { ...plan,category:groupCategory,subject:featureContext(
          plan.mode==='compare'?query:message,plan.features),
        brandTerm:plan.mode==='compare'?(brandsFromUser(query,groupCategory)[0]||''):plan.brandTerm,
        modelText:plan.mode==='compare'?(modelClues(query).length?query:''):plan.modelText,
        identity:groupIdentity,exactModel:plan.mode==='compare'?'':plan.exactModel },matched);
    inspected += evaluated.checked;
    accepted += evaluated.acceptedCount;
    provisional += evaluated.provisionalCount;
    rejected += evaluated.rejected.length + excludedBySubject;
    for (const [reason, count] of Object.entries(evaluated.reasons))
      reasonCounts[reason] = (reasonCounts[reason] || 0) + count;
    // A confirmed total-price candidate is preferable to a shipping-unverified one.
    // v3.2: a price far below the same identity's market (S25 at 180k, a
    // 2TB drive at 35k) is not evidence of a real sale of that product.
    const outliers = priceOutliers({ ...plan, category: groupCategory, identity: groupIdentity }, matched);
    if (outliers.size) {
      const drop = list => list.filter(x => !outliers.has(x.id));
      const removed = evaluated.accepted.length + evaluated.provisional.length - drop(evaluated.accepted).length - drop(evaluated.provisional).length;
      evaluated.accepted = drop(evaluated.accepted); evaluated.provisional = drop(evaluated.provisional);
      if (removed) reasonCounts.price_outlier_low = (reasonCounts.price_outlier_low || 0) + removed;
    }
    groups.push(evaluated.accepted.length ? evaluated.accepted : evaluated.provisional);
  }
  const compare = plan.mode === 'compare';
  const complete = !compare || (groups.length === 2 && groups.every(g => g.length > 0));
  let candidatesAll = compare
    ? [...groups[0].slice(0, 8), ...groups[1].slice(0, 8)]
      .filter((x, index, list) => list.findIndex(y => y.id === x.id) === index)
    : groups[0].slice(0, MAX_RESULTS);
  if(plan.priceLookup)candidatesAll=candidatesAll.slice().sort((a,b)=>a.price-b.price);
  else if(plan.usedPreferred&&!compare)candidatesAll=candidatesAll.slice().sort((a,b)=>Number(b.used)-Number(a.used));
  // Legacy state without displayed IDs (or no loader): "그중" means among the
  // cards ACTUALLY displayed previously; never let GPT redefine that set.
  const constrainToDisplayed=refersToDisplayed;
  if(constrainToDisplayed)followupKind='displayed_research';
  const allowedDisplayed=new Set(prior.presentedProductIds||[]);
  const candidates=constrainToDisplayed?
    candidatesAll.filter(x=>allowedDisplayed.has(x.id)):candidatesAll;
  const choice = complete && candidates.length
    ? await decideModel({ message, history, plan, candidates }) : { productIds: [] };
  const selection = resultFromSelection(plan, candidates, choice);
  if(intent.wantsSingle && !compare) selection.cards = selection.cards.slice(0, 1);
  if(plan.priceLookup && selection.cards.length){
    selection.cards.sort((a,b)=>a.price-b.price);
    selection.answer = priceLookupAnswer(selection.cards);
  }
  if(constrainToDisplayed && !selection.cards.length)
    selection.answer='앞서 보여드린 상품 중에는 새 조건에 맞는 상품이 없어요. 다른 상품까지 새로 찾으려면 그렇게 말씀해 주세요.';
  if (compare) {
    const first = new Set((groups[0] || []).map(x => x.id));
    const second = new Set((groups[1] || []).map(x => x.id));
    // v3.2: pick one card per side from the WHOLE choice list. Truncating the
    // choice to 4 cards first lost side B whenever GPT listed 4+ side-A IDs.
    const chosen = (Array.isArray(choice && choice.productIds) ? choice.productIds : []).filter(id => typeof id === 'string');
    const byId = new Map(candidates.map(x => [x.id, x]));
    const pick = (side, not) => {
      const id = chosen.find(x => side.has(x) && x !== not && byId.has(x));
      return id ? toCard(byId.get(id)) : null;
    };
    // A side GPT did not pick falls back to that side's top verified listing.
    const top = (group, not) => { const x = (group || []).find(y => y.id !== not); return x ? toCard(x) : null; };
    const firstCard = pick(first, null) || top(groups[0], null);
    const secondCard = pick(second, firstCard?.productId) || top(groups[1], firstCard?.productId);
    if (!complete || !firstCard || !secondCard) {
      selection.answer = '두 비교 대상을 모두 확인하지 못했어요. 정확한 이름이나 모델을 다시 알려주세요.';
      selection.cards = [];
    } else {
      // Present exactly one verified listing per comparison side; the text and cards
      // must refer to the same two product IDs, even when the model selected 4.
      selection.cards = [firstCard, secondCard];
      selection.answer = comparisonAnswer(selection.cards);
    }
  }
  return {
    status: 200, ...selection,
    state: stateFrom(plan, selection.cards.map(c=>c.productId)),
    stats: { searched: true, fetched, inspected, accepted, provisional, rejected,
      rejectedReasons: reasonCounts, chosen: selection.cards.length, dbQueries,
      intent: intentStats(), ...usage() }
  };
}
module.exports = { createEngine, sanitizePlan, validateCandidates, resultFromSelection,
  normalize, categoryOk, comparisonAnswer, compatibilityEvidence, priceLookupAnswer, USED };
