'use strict';

// Self-contained v3 pipeline. Only this module decides which products may reach cards.
const MAX_RESULTS = 16;
const MAX_CARDS = 4;
const { extractTitleEvidence, requestedIdentity, mergeRequested, checkListingIdentity } = require('./_ai-v3-identity');
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
const ACCESSORY = /충전기|보호필름|케이스|커버|파우치|거치대|어댑터|스트랩|충전케이블|키캡|리필|펜촉/i;
const USED = /중고|리퍼|리퍼비시|전시품|전시상품|\b(?:used|refurbished|renewed)\b/i;
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

function categoryOk(item, requested) {
  if (!requested) return false;
  const type = flat(requested);
  const title = flat(item.title);
  const cats = flat([item.category, item.productCategory, item.categoryName].filter(Boolean).join(' '));
  if (cats.includes(type) || title.includes(type)) return true;
  const entry = Object.entries(ALIASES).find(([name, words]) =>
    type === flat(name) || words.some(w => flat(w) === type));
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
function sanitizePlan(input, prev = {}, utterance = '') {
  const o = input && typeof input === 'object' ? input : {};
  const historyQuery = clean(prev.lastQuery, 80);
  const query = clean(o.query, 80) || historyQuery;
  const compareQuery = clean(o.compareQuery, 80)
    || (o.mode === 'compare' ? clean(prev.compareQuery, 80) : '');
  const category = clean(o.category || prev.category, 36);
  const exclusions = [...new Set([
    ...(Array.isArray(prev.exclusions) ? prev.exclusions : []),
    ...(Array.isArray(o.exclusions) ? o.exclusions : [])
  ].map(x => clean(x, 55)).filter(Boolean))].slice(0, 8);
  const maxPrice = o.maxPrice == null ? nprice(prev.maxPrice) : nprice(o.maxPrice);
  const mallOnly = clean(o.mallOnly || prev.mallOnly, 35);
  const exactModel = clean(o.exactModel, 80);
  const anchoredModel = exactModel && flat(utterance + ' ' + historyQuery).includes(flat(exactModel))
    ? exactModel : '';
  const newOnly = /중고.{0,9}(?:제외|빼|싫|말고|아닌|아니)|(?:새상품|새제품|신품)/i.test(utterance);
  const usedRequested = /중고|리퍼|리퍼비시|전시품|전시상품/i.test(utterance) && !newOnly;
  return {
    query, compareQuery, category, maxPrice, exclusions, mallOnly,
    exactModel: anchoredModel, allowUsed: newOnly ? false : usedRequested || !!prev.allowUsed,
    mode: o.mode === 'none' ? 'none' : o.mode === 'compare' ? 'compare' : 'recommend'
  };
}
function validateCandidates(plan, raw, { limit = MAX_RESULTS } = {}) {
  const accepted = [], provisional = [], rejected = [], reasons = {};
  const seen = new Set();
  const inspected = Math.min(Array.isArray(raw) ? raw.length : 0, MAX_CANDIDATE_SCAN);
  for (const source of (Array.isArray(raw) ? raw : []).slice(0, MAX_CANDIDATE_SCAN)) {
    const item = normalize(source);
    let reason = !item ? 'invalid_listing' : '';
    if (!reason && !categoryOk(item, plan.category)) reason = 'wrong_category';
    if (!reason && ACCESSORY.test(item.title) && !ACCESSORY.test(plan.category)) reason = 'accessory_not_requested';
    if (!reason && item.used && !plan.allowUsed) reason = 'used_not_requested';
    if (!reason && plan.identity && Object.keys(plan.identity).length) {
      const evidence = checkListingIdentity(item.title, plan.identity);
      if (!evidence.ok) reason = evidence.reason;
    }
    if (!reason && plan.mallOnly && !flat(item.mall).includes(flat(plan.mallOnly))) reason = 'wrong_merchant';
    const hasSpecificIdentity = plan.identity && Object.keys(plan.identity).some(k => k !== 'family');
    if (!reason && plan.exactModel && !hasSpecificIdentity && !flat(item.title).includes(flat(plan.exactModel)))
      reason = 'wrong_model';
    if (!reason && Array.isArray(plan.exclusions) && plan.exclusions.some(word =>
      flat(word) && flat(item.title).includes(flat(word)))) reason = 'excluded';
    if (!reason && plan.maxPrice != null && item.price > plan.maxPrice) reason = 'over_budget';
    if (!reason && plan.maxPrice != null && item.shipping != null &&
      item.price + item.shipping > plan.maxPrice) reason = 'over_budget';
    if (!reason && seen.has(item.id)) reason = 'duplicate';
    if (reason) {
      reasons[reason] = (reasons[reason] || 0) + 1;
      rejected.push({ reason });
      continue;
    }
    seen.add(item.id);
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
async function createEngine({ planModel, decideModel, searchProducts, getUsage }, request) {
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
    category: clean(saved.category, 36),
    maxPrice: nprice(saved.maxPrice),
    exclusions: Array.isArray(saved.exclusions) ? saved.exclusions.map(x => clean(x, 55)).filter(Boolean).slice(0, 8) : [],
    mallOnly: clean(saved.mallOnly, 35), exactModel: clean(saved.exactModel, 80), allowUsed: !!saved.allowUsed,
    identity: saved.identity && typeof saved.identity === 'object' ? Object.fromEntries(
      Object.entries(saved.identity).filter(([k,v]) =>
        ['family','series','variant','generation','storageGb','ramGb','screenInches','chip','network'].includes(k)
        && (typeof v === 'string' || typeof v === 'number')
        && String(v).length <= 30)) : {}
  };
  const rawPlan = await planModel({ message, history, state: prior });
  const plan = sanitizePlan(rawPlan, prior, message);
  const explicitIdentity = requestedIdentity(message);
  const changedSubject = !!(explicitIdentity.family && prior.identity.family
    && explicitIdentity.family !== prior.identity.family);
  // An LLM-made search keyword is NOT evidence of user intent.
  // Only the user's utterance and carried conversation constraints may impose exact model requirements.
  plan.identity = mergeRequested(prior.identity, message, changedSubject);
  if (plan.mode === 'none') return {
    status: 200, answer: '찾고 싶은 상품이나 쇼핑 관련 질문을 알려주세요.',
    cards: [], state: prior, stats: { searched: false, accepted: 0, provisional: 0 }
  };
  if (!plan.query || !plan.category || (plan.mode === 'compare' && !plan.compareQuery)) return {
    status: 200, answer: '찾으시는 상품 종류나 비교할 모델을 구체적으로 알려주세요.',
    cards: [], state: prior, stats: { searched: false, accepted: 0, provisional: 0 }
  };
  const queries = [...new Set([plan.query, ...(plan.mode === 'compare' ? [plan.compareQuery] : [])])].slice(0, 2);
  const groups = [], reasonCounts = {};
  let fetched = 0, inspected = 0, accepted = 0, provisional = 0, rejected = 0;
  for (const query of queries) {
    const raw = await searchProducts(query);
    if (!Array.isArray(raw)) throw new Error('Invalid search result');
    fetched += raw.length;
    // A comparison's two sides cannot borrow each other's similar-category products.
    const matched = plan.mode === 'compare'
      ? raw.filter(x => matchesComparisonSubject(x && x.title, query)) : raw;
    const excludedBySubject = raw.length - matched.length;
    if (excludedBySubject) reasonCounts.wrong_comparison_subject =
      (reasonCounts.wrong_comparison_subject || 0) + excludedBySubject;
    const groupIdentity = plan.mode === 'compare' ? requestedIdentity(query) : plan.identity;
    const evaluated = validateCandidates(
      { ...plan, identity: groupIdentity, exactModel: plan.mode === 'compare' ? '' : plan.exactModel }, matched);
    inspected += evaluated.checked;
    accepted += evaluated.acceptedCount;
    provisional += evaluated.provisionalCount;
    rejected += evaluated.rejected.length + excludedBySubject;
    for (const [reason, count] of Object.entries(evaluated.reasons))
      reasonCounts[reason] = (reasonCounts[reason] || 0) + count;
    // A confirmed total-price candidate is preferable to a shipping-unverified one.
    groups.push(evaluated.accepted.length ? evaluated.accepted : evaluated.provisional);
  }
  const compare = plan.mode === 'compare';
  const complete = !compare || (groups.length === 2 && groups.every(g => g.length > 0));
  const candidates = compare
    ? [...groups[0].slice(0, 8), ...groups[1].slice(0, 8)]
      .filter((x, index, list) => list.findIndex(y => y.id === x.id) === index)
    : groups[0].slice(0, MAX_RESULTS);
  const choice = complete && candidates.length
    ? await decideModel({ message, history, plan, candidates }) : { productIds: [] };
  const selection = resultFromSelection(plan, candidates, choice);
  if (compare) {
    const first = new Set((groups[0] || []).map(x => x.id));
    const second = new Set((groups[1] || []).map(x => x.id));
    const firstCard = selection.cards.find(x => first.has(x.productId));
    const secondCard = selection.cards.find(x => second.has(x.productId) && x.productId !== firstCard?.productId);
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
    state: {
      lastQuery: plan.query, compareQuery: plan.compareQuery,
      category: plan.category, maxPrice: plan.maxPrice,
      exclusions: plan.exclusions, mallOnly: plan.mallOnly,
      exactModel: plan.exactModel, allowUsed: plan.allowUsed,
      identity: plan.mode === 'compare' ? {} : plan.identity
    },
    stats: { searched: true, fetched, inspected, accepted, provisional, rejected,
      rejectedReasons: reasonCounts, chosen: selection.cards.length,
      ...(typeof getUsage === 'function' ? { modelUsage: getUsage() } : {}) }
  };
}
module.exports = { createEngine, sanitizePlan, validateCandidates, resultFromSelection,
  normalize, categoryOk, comparisonAnswer };
