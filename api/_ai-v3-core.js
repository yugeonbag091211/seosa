'use strict';

// Pure v3 pipeline. No network, DB writes, legacy concierge, or implicit fallback.
const MAX_RESULTS = 16;
const MAX_CARDS = 4;
const clean = (x, n = 120) => String(x == null ? '' : x).normalize('NFKC').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const flat = x => clean(x, 200).toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
const nprice = v => Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null;
const money = n => Number(n).toLocaleString('ko-KR') + '원';
const ALIASES = {
  '노트북': ['노트북','랩탑','laptop','그램','맥북','thinkpad','ideapad','vivobook'],
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
function categoryOk(item, requested) {
  if (!requested) return false; // No verifiable category => no ungrounded recommendation.
  const type = flat(requested);
  const title = flat(item.title);
  const cats = flat([item.category, item.productCategory, item.categoryName].filter(Boolean).join(' '));
  if (cats.includes(type) || title.includes(type)) return true;
  const entries = Object.entries(ALIASES);
  const group = entries.find(([name, words]) => type === flat(name) || words.some(w => flat(w) === type));
  if (!group) return false;
  return group[1].some(w => title.includes(flat(w)) || cats.includes(flat(w)));
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
  if (!['https:','http:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  if (!id || !title || !price || !mall) return null;
  return { id: mall + ':' + id, title, price, mall, url, image: clean(item.image, 1000),
    category: clean(item.category || item.categoryName, 70),
    source: clean(item._source || item.source, 30),
    shipping: item.shippingFee != null && Number.isSafeInteger(Number(item.shippingFee)) && Number(item.shippingFee) >= 0 ? Number(item.shippingFee) : null };
}
function sanitizePlan(input, prev = {}, utterance = '') {
  const o = input && typeof input === 'object' ? input : {};
  const historyQuery = clean(prev.lastQuery, 80);
  const utteranceFlat = flat(utterance);
  const freshQuery = clean(o.query, 80);
  // Never allow the LLM to create arbitrary product identity not mentioned by the user
  // or held in the prior server-issued state. Keyword expansion is for the provider,
  // not a claim that a new exact model was requested.
  const query = freshQuery || historyQuery;
  const compareQuery = clean(o.compareQuery, 80);
  const category = clean(o.category || prev.category, 36);
  const exclusions = [...new Set([...(Array.isArray(prev.exclusions) ? prev.exclusions : []),
    ...(Array.isArray(o.exclusions) ? o.exclusions : [])].map(x => clean(x, 55)).filter(Boolean))].slice(0, 8);
  const maxPrice = o.maxPrice == null ? (prev.maxPrice || null) : nprice(o.maxPrice);
  const mallOnly = clean(o.mallOnly || prev.mallOnly, 35);
  const exactModel = clean(o.exactModel, 80);
  const groundedIn = flat(utterance + ' ' + historyQuery);
  // Exact identity claims may only be enforced when in the conversation.
  const anchoredModel = exactModel && groundedIn.includes(flat(exactModel)) ? exactModel : '';
  return { query, compareQuery, category, maxPrice, exclusions, mallOnly, exactModel: anchoredModel,
    mode: o.mode === 'none' ? 'none' : o.mode === 'compare' ? 'compare' : 'recommend', notes: utteranceFlat ? '' : 'empty input' };
}
function validateCandidates(plan, raw) {
  const accepted = [], rejected = [];
  const seen = new Set();
  for (const source of (Array.isArray(raw) ? raw : []).slice(0, MAX_RESULTS * 3)) {
    const item = normalize(source);
    let reason = !item ? 'invalid_listing' : '';
    if (!reason && !categoryOk(item, plan.category)) reason = 'wrong_category';
    // Product category words can occur inside accessory titles. Never promote a charger/case to the main product.
    const accessory = /충전기|보호필름|케이스|커버|파우치|거치대|어댑터|스트랩|충전케이블|키캡|리필|펜촉/i;
    if (!reason && accessory.test(item.title) && !accessory.test(plan.category)) reason = 'accessory_not_requested';
    if (!reason && plan.maxPrice !== null && (item.shipping === null || item.price + item.shipping > plan.maxPrice))
      reason = item.shipping === null ? 'unknown_total_price' : 'over_budget';
    if (!reason && plan.mallOnly && !flat(item.mall).includes(flat(plan.mallOnly))) reason = 'wrong_merchant';
    if (!reason && plan.exactModel && !flat(item.title).includes(flat(plan.exactModel))) reason = 'wrong_model';
    if (!reason && plan.exclusions.some(word => flat(word) && flat(item.title).includes(flat(word)))) reason = 'excluded';
    if (!reason && seen.has(item.id)) reason = 'duplicate';
    if (reason) rejected.push({ reason });
    else { seen.add(item.id); accepted.push(item); }
  }
  return { accepted: accepted.slice(0, MAX_RESULTS), rejected };
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
  // Server, not model, authors all factual listing claims.
  const answer = selected.length
    ? (plan.mode === 'compare' ? '비교할 수 있는 후보를 찾았어요. 각 상품의 실제 옵션과 배송비를 판매처에서 확인해 주세요.'
      : '조건에 맞는 상품 후보를 찾았어요. 표시된 상품을 비교해 보세요.')
    : '현재 확인 가능한 상품 중에는 요청 조건을 충족하는 후보가 없어요. 조건을 조정하거나 다시 검색해 주세요.';
  return { answer, cards: selected.map(x => ({
    productId: x.id, title: x.title, price: x.price, priceText: money(x.price),
    mall: x.mall, link: x.url, image: x.image,
    priceStatus: x.source === 'api' ? 'observed' : 'cached_or_unverified',
    shippingFee: x.shipping
  })) };
}
async function createEngine({ planModel, decideModel, searchProducts }, request) {
  if (typeof planModel !== 'function' || typeof decideModel !== 'function' || typeof searchProducts !== 'function')
    throw new Error('Missing dependency');
  const message = clean(request && request.message, 800);
  if (!message) return { status: 400, error: 'message required' };
  const hist = Array.isArray(request.history) ? request.history.slice(-8)
    .filter(x => x && ['user','assistant'].includes(x.role))
    .map(x => ({ role: x.role, content: clean(x.content, 500) })) : [];
  // State is bounded and has no prices/product identities to trust from the client.
  const saved = request && request.state && typeof request.state === 'object' ? request.state : {};
  const prior = { lastQuery: clean(saved.lastQuery, 80), category: clean(saved.category, 36),
    maxPrice: nprice(saved.maxPrice),
    exclusions: Array.isArray(saved.exclusions) ? saved.exclusions.map(x => clean(x, 55)).filter(Boolean).slice(0, 8) : [],
    mallOnly: clean(saved.mallOnly, 35), exactModel: clean(saved.exactModel, 80) };
  const rawPlan = await planModel({ message, history: hist, state: prior });
  const plan = sanitizePlan(rawPlan, prior, message);
  if (plan.mode === 'none') return {
    status: 200, answer: '쇼핑 관련 질문이나 찾으시는 상품을 알려주세요.',
    cards: [], state: prior, stats: { searched: false, accepted: 0 }
  };
  if (!plan.query || !plan.category || (plan.mode === 'compare' && !plan.compareQuery)) return {
    status: 200, answer: '찾으시는 상품 종류나 모델을 조금 더 구체적으로 알려주세요.',
    cards: [], state: { ...plan, exactModel: '' }, stats: { searched: false, accepted: 0 }
  };
  const queries = [...new Set([plan.query, ...(plan.mode === 'compare' && plan.compareQuery ? [plan.compareQuery] : [])])].slice(0, 2);
  const raw = [], buckets = [];
  for (const query of queries) {
    const results = await searchProducts(query);
    if (!Array.isArray(results)) throw new Error('Invalid search result');
    raw.push(...results);
    buckets.push(validateCandidates({ ...plan, exactModel: plan.mode === 'compare' ? '' : plan.exactModel }, results).accepted);
  }
  const { accepted, rejected } = validateCandidates({ ...plan, exactModel: plan.mode === 'compare' ? '' : plan.exactModel }, raw);
  const completeComparison = plan.mode !== 'compare' || (buckets.length === 2 && buckets.every(b => b.length > 0));
  const choice = accepted.length && completeComparison
    ? await decideModel({ message, history: hist, plan, candidates: accepted }) : { productIds: [] };
  const selection = resultFromSelection(plan, accepted, choice);
  if (plan.mode === 'compare') {
    const first = new Set((buckets[0] || []).map(x => x.id));
    const second = new Set((buckets[1] || []).map(x => x.id));
    const matched = selection.cards.some(x => first.has(x.productId)) && selection.cards.some(x => second.has(x.productId))
      && selection.cards.length >= 2;
    if (!completeComparison || !matched) {
      selection.answer = '두 비교 대상을 모두 확인하지 못했어요. 정확한 모델명을 다시 알려주세요.';
      selection.cards = [];
    }
  }
  return { status: 200, ...selection,
    state: { lastQuery: plan.query, category: plan.category, maxPrice: plan.maxPrice,
      exclusions: plan.exclusions, mallOnly: plan.mallOnly, exactModel: plan.exactModel },
    stats: { searched: true, inspected: raw.length, accepted: accepted.length, rejected: rejected.length } };
}
module.exports = { createEngine, sanitizePlan, validateCandidates, resultFromSelection, normalize, categoryOk };
