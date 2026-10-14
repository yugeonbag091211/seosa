'use strict';

/* Phase 5 canonical read path. Disabled by default; no writes and no cache. */
const OI = require('./_offeridentity');
const P = require('./_identitypromotion');
const Price = require('./_price');
const Affiliate = require('./_affiliate');

const MAX_GROUP_MEMBERS = 20;
const MAX_INPUTS = 100;
const METRICS = { calls: 0, groups: 0, offers: 0, rejected: 0, errors: 0 };

function envEnabled(env) { return /^(true|1)$/i.test(String((env || process.env).IDENTITY_CANONICAL_CONSUMER_ENABLED || '').trim()); }
function config(env) {
  const source = env || process.env;
  const percent = Number(source.IDENTITY_CANONICAL_CONSUMER_ROLLOUT_PERCENT || 0);
  const keys = String(source.IDENTITY_CANONICAL_CONSUMER_GROUP_KEYS || '').split(',').map(x => x.trim()).filter(Boolean);
  return { enabled: envEnabled(source), percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0, allowlist: new Set(keys) };
}
function stableHash(value) {
  let h = 2166136261;
  for (const ch of String(value || '')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h % 100;
}
function eligibleForRollout(groupKey, opts) {
  const cfg = opts.config || config(opts.env);
  if (!cfg.enabled || cfg.percent <= 0) return false;
  if (cfg.allowlist.size && !cfg.allowlist.has(String(groupKey))) return false;
  return stableHash(groupKey) < cfg.percent;
}
function sourceMallOf(item) { return String(item && (item.mallId || item.mall || item.sourceMall) || '').trim(); }
function productIdOf(item) { return String(item && (item.productId || item.product_id) || '').trim(); }
function vendorIdOf(item) { return String(item && (item.vendorItemId || item.vendor_item_id) || '').trim(); }
function inputKey(item) { return sourceMallOf(item) + '|' + productIdOf(item); }
function requestKey(item) { return inputKey(item) + '|' + vendorIdOf(item); }
function failOnError(result, label) {
  if (result && result.error) throw new Error(label + ': ' + (result.error.message || result.error.code || 'database error'));
  return result || { data: null };
}
function currentPriceFresh(row, now) {
  const date = String(row && row.collected_at || '');
  if (!date || !Number.isFinite(Date.parse(date))) return false;
  const age = Price.ageDays(date, now);
  return Number.isFinite(age) && age >= 0 && age <= 3;
}
function displayMerchant(row, member) {
  const label = String(row.mall_label || '').trim();
  if (label) return label;
  const persisted = String(member.mall || row.mall || '').trim();
  const slash = persisted.indexOf('/');
  return slash >= 0 ? persisted.slice(slash + 1) : persisted;
}
function toOffer(row, member) {
  if (row.mall === '쿠팡' && !String(member.vendor_item_id || '').trim()) return null;
  const link = Affiliate.safeBuyLink(row.link, { vendorItemId: member.vendor_item_id || '', isCoupang: row.mall === '쿠팡', mall: row.mall });
  if (!link) return null;
  // For a known Coupang option, the affiliate URL must name this exact option.
  if (row.mall === '쿠팡' && member.vendor_item_id) {
    let linked = '';
    try { linked = new URL(link).searchParams.get('vendorItemId') || ''; } catch (_) { /* unavailable */ }
    if (!link || linked !== String(member.vendor_item_id)) return null;
  }
  return {
    productId: String(row.product_id), mall: String(row.mall), mallLabel: displayMerchant(row, member),
    vendorItemId: String(member.vendor_item_id || ''), title: String(row.title || ''),
    price: Number(row.lprice), link, image: String(row.image || ''), collectedAt: row.collected_at || ''
  };
}
function parseCurrent(row, member) {
  const offer = OI.parseOffer({ key: String(row.mall) + '|' + String(row.product_id), title: row.title,
    mall: displayMerchant(row, member), productId: row.product_id, vendorItemId: member.vendor_item_id || '',
    price: row.lprice, gtin: row.gtin || row.ean || row.upc || row.barcode || '', modelNumber: row.model_number || '' });
  offer.sourceMall = String(row.mall || '');
  return offer;
}
/*
 * 저장된 식별이 지금 파서의 결과와 같은가 — 같은 자리를 «둘» 본다 (2026-10-14 matcher transition).
 *
 *   primary  기존 자리(canonical_key · identity · identity_snapshot). 예전 동작 그대로다.
 *   next     matcher 전환 중에만 채워지는 다음 자리(next_*). 새 matcher 로 구성원 전부를 다시 검증한
 *            그룹에만 staging 된다(scripts/run-canonical-transition.js). 새 코드가 배포된 직후에도
 *            가격비교가 끊기지 않게 한다.
 *
 * 구성원 «전부» 가 한 자리와 같아야 그 자리를 쓴다. 섞이거나 어느 쪽과도 다르면 null — fail-closed.
 * next 자리를 모르는 DB(마이그레이션 전)에서는 next 값이 없으므로 예전과 똑같이 동작한다.
 */
function identityVersion(group, members, identities) {
  if (!group || !Array.isArray(members) || members.length !== identities.length || !members.length) return null;
  const now = identities.map(identity => P.stableJson(P.snapshotOf(identity)));
  const primary = members.every((member, i) => now[i] === P.stableJson(member.identity_snapshot || {}));
  if (primary) return { version: 'primary', key: String(group.canonical_key || ''), identity: group.identity || {}, tier: group.confidence_tier };
  const staged = group.next_canonical_key && group.next_identity && group.next_confidence_tier
    && members.every((member, i) => member.next_identity_snapshot && now[i] === P.stableJson(member.next_identity_snapshot));
  if (staged) return { version: 'next', key: String(group.next_canonical_key), identity: group.next_identity, tier: group.next_confidence_tier };
  return null;
}

/* rollout 은 그룹의 «처음» 키로 정한다 — matcher 전환으로 키가 바뀌어도 노출 범위가 넓어지거나 끊기지 않는다. */
function rolloutKeyOf(group) { return String((group && (group.rollout_key || group.canonical_key)) || ''); }

function activeCandidate(group, members, rowsByKey, opts, stats) {
  if (!group || group.status !== 'ACTIVE' || !group.canonical_key || !eligibleForRollout(rolloutKeyOf(group), opts)) return null;
  if (!Array.isArray(members) || members.length < 2 || members.length > MAX_GROUP_MEMBERS) return null;
  const memberKeys = new Set();
  const offers = [];
  const identities = [];
  const verifiedMembers = [];
  for (const member of members) {
    const source = String(member.source_mall || '');
    const pid = String(member.product_id || '');
    const key = source + '|' + pid;
    if (!source || !pid || memberKeys.has(key) || String(member.offer_key || '') !== key) return null;
    memberKeys.add(key);
    const row = rowsByKey.get(key);
    if (!row || String(row.mall || '') !== source || String(row.product_id || '') !== pid) return null;
    const currentVid = Price.vendorIdOf(row);
    if (currentVid !== String(member.vendor_item_id || '')) return null;
    identities.push(parseCurrent(row, member));
    verifiedMembers.push({ key, vendorItemId: currentVid });
    // A member can remain a valid identity while its current offer is temporarily
    // unusable (stale, suspect, unpriced, or missing a safe purchase link). Filter
    // that offer so the next verified seller can become the canonical display.
    if (Price.isDisplayable(row) && Number(row.lprice) > 0 && currentPriceFresh(row, opts.now)) {
      const linkOffer = toOffer(row, member);
      if (linkOffer) offers.push(linkOffer);
    }
  }
  // 저장된 식별(기존 자리 또는 matcher 전환의 next 자리)과 지금 파서의 결과가 같아야 한다. 아니면 fail-closed.
  const version = identityVersion(group, members, identities);
  if (!version) {
    if (stats) stats.stale = (stats.stale || 0) + 1;
    return null;
  }
  const context = OI.contextFactory(identities);
  for (let i = 0; i < identities.length; i++) {
    for (let j = i + 1; j < identities.length; j++) {
      const match = OI.matchOffers(identities[i], identities[j], context(identities[i], identities[j]));
      if (match.decision === OI.DECISION.NO_MATCH || (match.conflicts || []).length) {
        stats.rejected++;
        return null;
      }
    }
  }
  // 키는 «맞은 자리» 의 키·식별·등급과 비교한다 — 기존 자리 스냅숏에 next 키를 섞어 받지 않는다.
  const identity = version.identity || {};
  if (!['A', 'B'].includes(version.tier) || identity.tier !== version.tier) return null;
  const strong = identity.strongIdentifier || null;
  const computed = P.canonicalKeyOf(P.canonicalIdentity(identities, strong, version.tier));
  if (!computed || computed !== version.key) return null;
  const merchants = new Set(offers.map(o => o.mallLabel).filter(Boolean));
  if (offers.length < 2 || merchants.size < 2) return null;
  offers.sort((a, b) => a.price - b.price || a.mallLabel.localeCompare(b.mallLabel) || a.productId.localeCompare(b.productId));
  if (version.version === 'next' && stats) stats.transition = (stats.transition || 0) + 1;
  return { id: String(group.id), key: version.key, identity, identityVersion: version.version, offers, verifiedMembers };
}

async function resolveGroups(items, opts = {}) {
  const stats = { groups: 0, offers: 0, rejected: 0, errors: 0 };
  const empty = { byOfferKey: new Map(), groups: [], stats };
  const cfg = opts.config || config(opts.env);
  if (!cfg.enabled || cfg.percent <= 0 || !Array.isArray(items) || !items.length) return empty;
  const db = opts.db || require('./_supabase');
  const inputs = [...new Map(items.filter(Boolean).map(item => [inputKey(item), item])).values()]
    .filter(x => sourceMallOf(x) && productIdOf(x)).slice(0, MAX_INPUTS);
  if (!inputs.length) return empty;
  try {
    const keys = inputs.map(inputKey);
    const memberResult = failOnError(await db.from('canonical_product_members')
      .select('group_id,source_mall,product_id,mall,vendor_item_id,offer_key').in('offer_key', keys), 'canonical member lookup failed');
    const matched = memberResult.data || [];
    if (!matched.length) return empty;
    const groupIds = [...new Set(matched.map(x => String(x.group_id)))];
    // '*' — matcher 전환 컬럼(next_* · rollout_key)이 있으면 함께 받고, 마이그레이션 전 DB 에서도 그대로 동작한다.
    const groupResult = failOnError(await db.from('canonical_product_groups')
      .select('*').in('id', groupIds).eq('status', 'ACTIVE'), 'canonical group lookup failed');
    const groupRows = groupResult.data || [];
    if (!groupRows.length) return empty;
    const activeIds = groupRows.map(x => x.id);
    const allMembersResult = failOnError(await db.from('canonical_product_members')
      .select('*').in('group_id', activeIds), 'canonical group members lookup failed');
    const allMembers = allMembersResult.data || [];
    const pids = [...new Set(allMembers.map(x => String(x.product_id)))];
    if (!pids.length || pids.length > groupRows.length * MAX_GROUP_MEMBERS) return empty;
    const productResult = failOnError(await db.from('products')
      .select('product_id,mall,mall_label,title,lprice,link,image,keyword,collected_at,vendor_item_id')
      .in('product_id', pids), 'canonical product lookup failed');
    const rowsByKey = new Map((productResult.data || []).map(row => [String(row.mall) + '|' + String(row.product_id), row]));
    const membersByGroup = new Map();
    allMembers.forEach(member => {
      const id = String(member.group_id);
      if (!membersByGroup.has(id)) membersByGroup.set(id, []);
      membersByGroup.get(id).push(member);
    });
    let candidates = [];
    for (const group of groupRows) {
      const groupMembers = membersByGroup.get(String(group.id)) || [];
      const candidate = activeCandidate(group, groupMembers, rowsByKey, { config: cfg, now: opts.now }, stats);
      if (candidate) candidates.push(candidate);
    }
    if (!candidates.length) return empty;
    const trustItems = candidates.flatMap(g => g.offers.map(o => ({
      productId: o.productId, mall: o.mall, vendorItemId: o.vendorItemId,
      lprice: o.price, collectedAt: o.collectedAt, title: o.title, link: o.link,
      image: o.image, mallLabel: o.mallLabel, isCoupang: o.mall === '쿠팡'
    })));
    if (opts.attachTrust) await opts.attachTrust(trustItems);
    else await require('./_trust').attachTrust(trustItems);
    let offset = 0;
    candidates = candidates.map(group => {
      const offers = group.offers.map(() => trustItems[offset++]).filter(item => item
        && ['high', 'medium'].includes(item.trust && item.trust.level)
        && !(item.trust.reasons || []).some(reason => reason.code === 'volatile_high'));
      if (offers.length < 2 || new Set(offers.map(item => item.mallLabel).filter(Boolean)).size < 2) {
        stats.rejected++;
        return null;
      }
      group.offers = offers.map(item => ({
        productId: item.productId, mall: item.mall, mallLabel: item.mallLabel,
        vendorItemId: item.vendorItemId, title: item.title, price: item.lprice,
        link: Affiliate.safeBuyLink(item.link, item), image: item.image || '', collectedAt: item.collectedAt
      })).sort((a, b) => a.price - b.price || a.mallLabel.localeCompare(b.mallLabel));
      return group;
    }).filter(Boolean);
    const membershipCount = new Map();
    candidates.forEach(group => group.verifiedMembers.forEach(member => {
      const key = member.key;
      membershipCount.set(key, (membershipCount.get(key) || 0) + 1);
    }));
    const byOfferKey = new Map();
    const accepted = [];
    const inputsByOfferKey = new Map();
    inputs.forEach(item => {
      const key = inputKey(item);
      if (!inputsByOfferKey.has(key)) inputsByOfferKey.set(key, []);
      inputsByOfferKey.get(key).push(item);
    });
    for (const group of candidates) {
      const memberKeys = group.verifiedMembers.map(member => member.key);
      const valid = group.offers.length >= 2 && new Set(group.offers.map(x => x.mallLabel)).size >= 2
        && memberKeys.every(key => membershipCount.get(key) === 1);
      if (!valid) { stats.rejected++; continue; }
      let matchedInput = false;
      group.verifiedMembers.forEach(member => {
        const key = member.key;
        (inputsByOfferKey.get(key) || []).forEach(input => {
          if (vendorIdOf(input) === member.vendorItemId) {
            matchedInput = true;
            byOfferKey.set(requestKey(input), group);
          }
        });
      });
      if (!matchedInput) continue;
      accepted.push(group);
      stats.groups++;
      stats.offers += group.offers.length;
    }
    return { byOfferKey, groups: accepted, stats };
  } catch (_) {
    stats.errors++;
    METRICS.errors++;
    return { byOfferKey: new Map(), groups: [], stats };
  }
}

function annotate(item, group) {
  const out = Object.assign({}, item);
  if (Object.prototype.hasOwnProperty.call(item, '_raw')) {
    Object.defineProperty(out, '_raw', { value: item._raw, enumerable: false });
  }
  out.canonicalGroupId = group.id;
  out.canonicalKey = group.key;
  out.canonicalIdentity = group.identity;
  out.isCanonicalGroup = true;
  out.canonicalOfferCount = group.offers.length;
  out.canonicalOffers = group.offers.map(offer => Object.assign({}, offer));
  out.canonicalLowestPrice = group.offers[0].price;
  out.canonicalLowestMerchant = group.offers[0].mallLabel;
  out.canonicalLowestMall = group.offers[0].mall;
  out.canonicalLowestLink = group.offers[0].link;
  out.canonicalLowestProductId = group.offers[0].productId;
  out.canonicalLowestVendorItemId = group.offers[0].vendorItemId;
  // Customer-facing display and purchase identities are explicit. The ranked
  // representative's productId/title/link/price remain the history identity.
  out.displayPrice = out.canonicalLowestPrice;
  out.displayMerchant = out.canonicalLowestMerchant;
  out.displayBuyLink = out.canonicalLowestLink;
  out.displayProductId = out.canonicalLowestProductId;
  out.displayVendorItemId = out.canonicalLowestVendorItemId;
  // Convenient aliases for search/AI rows that do not already define these fields.
  if (out.offerCount == null) out.offerCount = out.canonicalOfferCount;
  if (!(Number(out.lowestPrice) > 0)) out.lowestPrice = out.canonicalLowestPrice;
  if (!out.lowestMerchant) out.lowestMerchant = out.canonicalLowestMerchant;
  if (!out.lowestLink) out.lowestLink = out.canonicalLowestLink;
  if (!Array.isArray(out.offers)) out.offers = out.canonicalOffers;
  return out;
}

function aggregateHistoryRows(group, rows, history, now) {
  const today = history.kstToday(now);
  const cutoff = new Date(Date.parse(today + 'T00:00:00Z') - 364 * 86400000).toISOString().slice(0, 10);
  const daily = new Map();
  group.offers.forEach(offer => {
    const exact = (rows || []).filter(row => String(row.product_id) === String(offer.productId)
      && String(row.mall || '') === String(offer.mall)
      && String(row.vendor_item_id || '') === String(offer.vendorItemId || ''));
    history.acceptedObservations(exact).forEach(row => {
      const date = history.observedKstDate(row);
      const price = history.parsePrice(row.price);
      if (!date || date < cutoff || date > today || !price) return;
      const previous = daily.get(date);
      if (!previous || price < previous) daily.set(date, price);
    });
  });
  return [...daily].sort((a, b) => a[0].localeCompare(b[0])).map(([date, price]) => ({ date, price }));
}

async function loadAggregatedHistories(groups, opts = {}) {
  const list = [...new Map((groups || []).filter(g => g && Array.isArray(g.offers) && g.offers.length > 1)
    .map(g => [g.id, g])).values()];
  if (!list.length) return new Map();
  const db = opts.db || require('./_supabase');
  try {
    const ids = [...new Set(list.flatMap(g => g.offers.map(o => o.productId)))];
    const result = failOnError(await db.from('price_history')
      .select('product_id,mall,vendor_item_id,recorded_date,recorded_at,price')
      .in('product_id', ids).order('recorded_date', { ascending: false }).limit(10000), 'canonical history lookup failed');
    const history = require('./_price');
    return new Map(list.map(group => [group.id, aggregateHistoryRows(group, result.data || [], history, opts.now)]));
  } catch (_) {
    return null;
  }
}
async function loadAggregatedHistory(group, opts = {}) {
  const results = await loadAggregatedHistories([group], opts);
  return results ? results.get(group && group.id) || [] : null;
}
async function collapseItems(items, opts = {}) {
  if (!Array.isArray(items) || !items.length) return items;
  const cfg = opts.config || config(opts.env);
  if (!cfg.enabled || cfg.percent <= 0) return items;
  METRICS.calls++;
  const resolved = await resolveGroups(items, Object.assign({}, opts, { config: cfg }));
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const group = resolved.byOfferKey.get(requestKey(item));
    if (!group) { out.push(item); continue; }
    if (seen.has(group.id)) continue;
    seen.add(group.id);
    out.push(annotate(item, group));
  }
  METRICS.groups += resolved.stats.groups;
  METRICS.offers += resolved.stats.offers;
  METRICS.rejected += resolved.stats.rejected;
  if (METRICS.calls % 100 === 0) {
    console.info('[canonical-consumer] request batch totals', {
      calls: METRICS.calls, groups: METRICS.groups, offers: METRICS.offers,
      rejected: METRICS.rejected, errors: METRICS.errors
    });
  }
  return out;
}

function resolveIdentityForHistory(item, opts) { return resolveGroups([item], opts); }
function _resetMetrics() { Object.keys(METRICS).forEach(k => { METRICS[k] = 0; }); }

module.exports = {
  config, envEnabled, eligibleForRollout, stableHash, resolveGroups, collapseItems,
  inputKey, requestKey, sourceMallOf, productIdOf, vendorIdOf, resolveIdentityForHistory,
  loadAggregatedHistory, loadAggregatedHistories,
  _internal: { activeCandidate, identityVersion, rolloutKeyOf, currentPriceFresh, parseCurrent, toOffer, aggregateHistoryRows, METRICS, _resetMetrics, MAX_GROUP_MEMBERS, MAX_INPUTS }
};
