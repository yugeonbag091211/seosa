#!/usr/bin/env node
'use strict';

/**
 * External Hotdeal Radar collector.
 *
 *   enabled sources → normalize → match products → verify with price_history
 *   → group across sources (including recent stored rows) → decide exposure → save
 *
 * ── Exposure is OFF by default (shadow) ───────────────────────────────
 *   EXTERNAL_HOTDEAL_SHADOW          anything but '0' = shadow: every row is saved with is_exposed=false
 *   EXTERNAL_HOTDEAL_PUBLIC_SOURCES  with shadow off, only these comma-separated sources may be exposed
 *   api/hotdeals.js additionally requires EXTERNAL_HOTDEAL_PUBLIC=1. Both switches must be on.
 *
 * ── Flags ─────────────────────────────────────────────────────────────
 *   --dry-run   no writes (works before the external_hotdeals migration is applied)
 *   --sample    print every verdict for manual review (title, price, matched product, score, reasons)
 *
 * Logs carry counts, ids and product titles only. Adapters never read post bodies or authors.
 */
const path = require('path');
const fs = require('fs');
const root = path.resolve(__dirname, '..');
for (const name of ['.env.local', '.env']) {
  const file = path.join(root, name);
  if (fs.existsSync(file)) { require('dotenv').config({ path: file }); break; }
}

const supabase = require('../api/_supabase');
const registry = require('../api/_hotdeal-sources/registry');
const Radar = require('../api/_external-hotdeal');
const { kstToday } = require('../api/_kst');
const { sameVendorRows } = require('../api/_price');
const Shop = require('../api/_shop');
const HD = require('../api/_hotdeal');

const DRY_RUN = process.argv.includes('--dry-run');
const SAMPLE = process.argv.includes('--sample');
/** PostgREST caps one response at 1000 rows; limit(5000) alone silently returns 1000. */
const PAGE = 1000;
const PRODUCT_LIMIT = Math.max(100, Math.min(10000, Number(process.env.EXTERNAL_HOTDEAL_PRODUCT_LIMIT) || 5000));
const HISTORY_DAYS = 90;
const HISTORY_CHUNK = 20;
/** Stored posts inside this window are regrouped with the current batch (closeInTime is 48h). */
const GROUP_WINDOW_HOURS = 72;
/**
 * 커뮤니티 핫딜 → 제휴 상품 연결은 «정확도 우선».
 * 한 실행에서 너무 많은 쇼핑 API를 부르지 않도록 신규/미매칭 딜 일부만 보강한다.
 * 12건 × (쿠팡+ADPICK)도 기존 각 공급자 리미터/캐시를 그대로 거친다.
 */
const AFFILIATE_LOOKUP_LIMIT = Math.max(0, Math.min(30,
  Number(process.env.EXTERNAL_HOTDEAL_AFFILIATE_LOOKUPS) || 12));
/**
 * 한 상품에서 검색어를 바꿔 재시도할 수 있지만 전체 호출은 별도 상한으로 막는다.
 * 기본 24회면 최대 12개 딜을 평균 2번씩 찾을 수 있다.
 */
const AFFILIATE_SEARCH_LIMIT = Math.max(0, Math.min(60,
  Number(process.env.EXTERNAL_HOTDEAL_AFFILIATE_SEARCHES) || 24));
const AFFILIATE_MATCH_THRESHOLD = 0.90;
/**
 * 사진은 구매 링크보다 한 단계 낮은 0.82까지 허용하되, title-only / partial 은 제외한다.
 * 즉 수량·용량·모델 충돌을 모두 통과한 identity B 이상일 때만 검색 결과 사진을 쓴다.
 * 사진 때문에 엉뚱한 상품으로 보이는 것보다 빈 썸네일이 낫다.
 */
const IMAGE_MATCH_THRESHOLD = 0.70;
const IMAGE_MATCH_METHODS = new Set(['identity', 'identity-partial', 'model', 'mall-id', 'url']);

function log(message, extra) {
  console.log(JSON.stringify({ at: new Date().toISOString(), message, ...(extra || {}) }));
}

function exposurePolicy(env) {
  const e = env || process.env;
  const shadow = e.EXTERNAL_HOTDEAL_SHADOW !== '0';
  const publicSources = [...new Set(String(e.EXTERNAL_HOTDEAL_PUBLIC_SOURCES || '')
    .split(',').map(s => s.trim()).filter(Boolean))];
  return { shadow, publicSources, allows: source => !shadow && publicSources.indexOf(String(source || '')) > -1 };
}

async function selectPaged(build, limit) {
  const rows = [];
  for (let from = 0; from < limit; from += PAGE) {
    const to = Math.min(from + PAGE, limit) - 1;
    const { data, error } = await build().range(from, to);
    if (error) throw new Error(error.message);
    const page = data || [];
    rows.push(...page);
    if (page.length < to - from + 1) break;
  }
  return rows;
}

async function loadProducts(db) {
  try {
    return await selectPaged(() => db.from('products')
      .select('product_id, vendor_item_id, mall, title, link, image, lprice, collected_at')
      .order('collected_at', { ascending: false })
      .order('product_id', { ascending: true })
      .order('mall', { ascending: true }), PRODUCT_LIMIT);
  } catch (error) {
    throw new Error(`products: ${error.message}`);
  }
}

async function loadHistory(matches, db, today) {
  const ids = [...new Set(matches.map(m => m && m.product && String(m.product.product_id)).filter(Boolean))];
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - (HISTORY_DAYS - 1) * 86400000).toISOString().slice(0, 10);
  const map = new Map();
  for (let i = 0; i < ids.length; i += HISTORY_CHUNK) {
    let rows;
    try {
      rows = await selectPaged(() => db.from('price_history')
        .select('product_id, vendor_item_id, mall, price, recorded_date, recorded_at')
        .in('product_id', ids.slice(i, i + HISTORY_CHUNK))
        .gte('recorded_date', since)
        .order('recorded_date', { ascending: true })
        .order('product_id', { ascending: true })
        .order('mall', { ascending: true })
        .order('vendor_item_id', { ascending: true }), 50000);
    } catch (error) {
      throw new Error(`price_history: ${error.message}`);
    }
    for (const row of rows) {
      const key = String(row.product_id);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
  }
  return map;
}

function historyFor(match, history) {
  if (!match || !match.product) return [];
  const product = match.product;
  const rows = history.get(String(product.product_id)) || [];
  // No fallback to other malls: another mall's history is not this listing's history.
  const sameMall = product.mall ? rows.filter(r => String(r.mall || '') === String(product.mall)) : rows;
  // The option guard is the shared _price.sameVendorRows rule (product page and price stats use it too).
  return sameVendorRows(sameMall, product.vendor_item_id);
}

function rowFor(deal, match, verification, nowMs) {
  const product = match && match.product;
  const candidate = match && match.candidate;
  const affiliateSafe = !!(product && product.link && Number(match && match.confidence) >= AFFILIATE_MATCH_THRESHOLD);
  return {
    source: deal.source,
    source_post_id: deal.externalId,
    source_url: deal.postUrl,
    canonical_source_url: deal.canonicalPostUrl,
    title: deal.title,
    normalized_title: deal.normalizedTitle,
    price: deal.price,
    original_price: deal.originalPrice,
    mall: deal.mall,
    product_url: deal.productUrl,
    canonical_product_url: deal.canonicalProductUrl,
    image_url: deal.imageUrl || (product && product.image) || '',
    posted_at: deal.postedAt,
    fetched_at: deal.fetchedAt,
    matched_product_id: product ? String(product.product_id) : null,
    matched_mall: product ? String(product.mall || '') : '',
    matched_vendor_item_id: product ? String(product.vendor_item_id || '') : '',
    match_confidence: Math.round(((match && match.confidence) || 0) * 1000) / 1000,
    match_method: (match && match.method) || 'none',
    deal_score: verification.dealScore,
    verification_status: verification.verificationStatus,
    verification_reasons: verification.reasons,
    price_vs_30d_avg: verification.priceVs30dAvg,
    price_vs_90d_low: verification.priceVs90dLow,
    average_30d: verification.stats.average30,
    low_30d: verification.stats.low30,
    low_90d: verification.stats.low90,
    previous_price: verification.stats.previousPrice,
    history_observation_count: verification.stats.count,
    history_last_observed_at: verification.stats.lastObservedAt,
    is_exposed: false,
    metadata: {
      ...deal.metadata,
      matchReason: match && match.reason,
      matchedTitle: product ? String(product.title || '').slice(0, 200) : '',
      bestCandidateId: !product && candidate ? String(candidate.product_id || '') : '',
      bestCandidateTitle: !product && candidate ? String(candidate.title || '').slice(0, 200) : '',
      effectivePrice: verification.effectivePrice,
      priceVs30dMedian: verification.priceVs30dMedian,
      scoreParts: verification.parts,
      ...(affiliateSafe ? {
        affiliateUrl: String(product.link),
        affiliateMall: String(product.mall || ''),
        affiliatePrice: Number(product.lprice || product.price) || null,
        affiliateProductId: String(product.product_id || product.productId || ''),
        affiliateVendorItemId: String(product.vendor_item_id || product.vendorItemId || ''),
        affiliateConfidence: Number(match.confidence) || 0,
        affiliateMatchReason: String(match.reason || '')
      } : {})
    },
    last_verified_at: new Date(nowMs).toISOString()
  };
}

/** _shop 검색 결과를 External Radar matcher가 읽는 catalog 모양으로 바꾼다. */
function affiliateCandidateProduct(item) {
  return {
    product_id: String((item && item.productId) || ''),
    vendor_item_id: String((item && item.vendorItemId) || ''),
    mall: String((item && item.mall) || ''),
    title: String((item && item.title) || ''),
    link: String((item && item.link) || ''),
    image: String((item && item.image) || ''),
    lprice: Number(item && item.lprice) || 0
  };
}

function safeImageUrl(value) {
  const url = HD.safeUrl(String(value || ''));
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? url : '';
  } catch (_) {
    return '';
  }
}

/**
 * 제휴 검색용 제목 정리.
 *
 * 첫 시도는 수량/용량/모델명을 절대 버리지 않는다. 기존 searchPhraseFromTitle()
 * 은 재수집용이라 500ml·40개 같은 옵션 토큰을 의도적으로 제거하는데, 외부 핫딜
 * 제휴 매칭에서는 바로 그 값이 동일상품을 찾는 핵심이다.
 */
function cleanAffiliateQuery(value) {
  return String(value || '')
    .replace(/\b\d{1,3}(?:\.\d+)?\s*%\s*(?:할인)?/gi, ' ')
    .replace(/\b(?:무료배송|무배|핫딜|특가)\b/gi, ' ')
    .replace(/[\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
}

/**
 * 한 상품을 한 검색어로만 찾지 않는다.
 *
 * 1) 전체 제목(수량·용량·모델 유지) — 가장 정확한 SKU 검색
 * 2) 앞 5개 핵심 토큰 — 쇼핑몰 제목 장식/판매자 문구가 다른 경우
 * 3) 앞 3개 핵심 토큰 — 마지막 재현율 보강
 *
 * 중복은 제거하고 최대 3개만 쓴다. 매칭 문턱(0.90)은 그대로라 검색 범위만
 * 넓어지고 잘못된 제휴 상품을 승인하는 기준은 느슨해지지 않는다.
 */
function affiliateSearchQueries(deal) {
  const title = String(deal && deal.title || '');
  const out = [];
  const add = q => {
    const v = cleanAffiliateQuery(q);
    if (v && out.indexOf(v) < 0) out.push(v);
  };
  add(title);
  add(Shop.searchPhraseFromTitle(title, 5));
  add(Shop.searchPhraseFromTitle(title, 3));
  return out.slice(0, 3);
}

function affiliateCandidateKey(item) {
  return [
    String(item && item.mall || ''),
    String(item && item.productId || ''),
    String(item && item.vendorItemId || ''),
    String(item && item.link || '')
  ].join('|');
}

/**
 * 미매칭 커뮤니티 딜을 SEOSA의 기존 제휴 검색 통로(쿠팡 Partners + ADPICK)로
 * 한 번 더 찾는다. 외부 글의 일반 링크를 제휴 링크처럼 재사용하지 않는다.
 *
 * MATCH_THRESHOLD(0.75)보다 높은 0.90을 요구한다. 돈이 걸리는 버튼은
 * «비슷해 보인다»가 아니라 모델/identity A 수준의 근거가 있어야 한다.
 */
async function enrichAffiliateRows(deals, rows, options) {
  const opts = options || {};
  const injectedSearch = opts.searchAll || null;
  const fetchCoupang = opts.fetchCoupang || Shop.fetchCoupang;
  const fetchAdpick = opts.fetchAdpick || Shop.fetchAdpick;
  const save = opts.saveProducts || Shop.saveProducts;
  const lookupLimit = Math.max(0, Math.min(30,
    Number.isFinite(opts.lookupLimit) ? opts.lookupLimit : AFFILIATE_LOOKUP_LIMIT));
  const searchLimit = Math.max(0, Math.min(60,
    Number.isFinite(opts.searchLimit) ? opts.searchLimit : AFFILIATE_SEARCH_LIMIT));
  const stats = { attempted: 0, searches: 0, matched: 0, saved: 0, skipped: 0, errors: 0 };

  for (let i = 0; i < (rows || []).length; i++) {
    const row = rows[i];
    const deal = (deals || [])[i];
    if (!row || !deal) continue;
    row.metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};

    if (row.metadata.affiliateUrl || row.matched_product_id) { stats.skipped++; continue; }
    if (stats.attempted >= lookupLimit || stats.searches >= searchLimit) break;

    const queries = affiliateSearchQueries(deal);
    if (!queries.length) { stats.skipped++; continue; }

    stats.attempted++;
    try {
      const candidateMap = new Map();
      let match = null;
      let chosen = null;
      let matchedKeyword = '';
      let matchedFrom = 'api';
      let visualChosen = null;
      let visualMatch = null;

      for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
        const keyword = queries[queryIndex];
        if (stats.searches >= searchLimit) break;
        stats.searches++;

        let result;
        if (injectedSearch) {
          // 테스트/호출부가 searchAll을 주입한 경우 기존 계약을 그대로 쓴다.
          result = await injectedSearch(keyword, {
            coupangLimit: 10,
            coupangOpts: { source: 'external-hotdeal', maxWaitMs: 15000 },
            adpickLimit: 10,
            adpickOpts: { source: 'external-hotdeal', maxWaitMs: 15000 }
          });
        } else {
          /*
           * 운영에서는 ADPICK을 모든 재시도에 호출하지 않는다.
           * 첫 검색어가 모델/용량/수량을 모두 보존하므로 ADPICK은 여기서 한 번만 보고,
           * 2·3차 재검색은 쿠팡만 사용한다. 2026-09-20 실측에서 11번째 ADPICK
           * 호출부터 429가 발생했으므로, 재현율을 올리면서도 공급자 차단은 피한다.
           */
          const coupang = await fetchCoupang(keyword, 10,
            { source: 'external-hotdeal', maxWaitMs: 15000 })
            .catch(e => ({ items: [], error: e.message, from: 'none' }));
          const adpick = queryIndex === 0
            ? await fetchAdpick(keyword, 10,
                { source: 'external-hotdeal', maxWaitMs: 15000 })
                .catch(e => ({ items: [], error: e.message, from: 'none' }))
            : { items: [], error: null, from: 'none' };
          result = {
            items: [...(coupang.items || []), ...(adpick.items || [])],
            from: coupang.from || adpick.from || 'none'
          };
        }

        for (const item of (result && result.items || [])) {
          if (!item || !item.link || !item.productId || !(Number(item.lprice) > 0)) continue;
          const key = affiliateCandidateKey(item);
          if (!candidateMap.has(key)) candidateMap.set(key, item);
        }

        const candidates = [...candidateMap.values()];
        if (!candidates.length) continue;
        const products = candidates.map(affiliateCandidateProduct);
        // 커뮤니티 제목의 "77%할인/특가" 같은 홍보 문구는 상품 identity가 아니다.
        // 수량·용량·모델은 보존한 채 홍보 문구만 걷어 동일상품 판정에 사용한다.
        const matchDeal = { ...deal, title: cleanAffiliateQuery(deal.title) || deal.title };
        // 구매 링크는 0.90+, 사진은 identity B(0.82)+까지만 허용한다.
        // 둘 다 같은 conflict guard(수량/용량/모델/옵션)를 거친다.
        const vm = Radar.matchProduct(matchDeal, products, IMAGE_MATCH_THRESHOLD);
        if (!visualChosen && vm.product && IMAGE_MATCH_METHODS.has(String(vm.method || ''))) {
          const candidate = candidates.find(it =>
            String(it.productId) === String(vm.product.product_id)
            && String(it.mall || '') === String(vm.product.mall || '')
          );
          const image = candidate && safeImageUrl(candidate.image);
          if (image) {
            visualChosen = candidate;
            visualMatch = vm;
          }
        }

        match = Radar.matchProduct(matchDeal, products, AFFILIATE_MATCH_THRESHOLD);
        if (!match.product) continue;

        chosen = candidates.find(it =>
          String(it.productId) === String(match.product.product_id)
          && String(it.mall || '') === String(match.product.mall || '')
          && String(it.link || '') === String(match.product.link || '')
        ) || candidates.find(it =>
          String(it.productId) === String(match.product.product_id)
          && String(it.mall || '') === String(match.product.mall || '')
        );

        if (chosen) {
          matchedKeyword = keyword;
          matchedFrom = chosen._source || (result && result.from) || 'api';
          break;
        }
      }

      if (!row.image_url && visualChosen && visualMatch) {
        const image = safeImageUrl(visualChosen.image);
        if (image) {
          row.image_url = image;
          row.metadata = {
            ...row.metadata,
            imageSource: String(visualChosen.mallLabel || visualChosen.mall || ''),
            imageProductId: String(visualChosen.productId || ''),
            imageMatchConfidence: Number(visualMatch.confidence) || 0,
            imageMatchReason: String(visualMatch.reason || ''),
            imageReference: Number(visualMatch.confidence) < AFFILIATE_MATCH_THRESHOLD
          };
        }
      }

      if (!chosen || !match || !match.product) continue;

      const chosenImage = safeImageUrl(chosen.image);
      if (chosenImage) row.image_url = chosenImage;

      const meta = {
        ...row.metadata,
        affiliateUrl: String(chosen.link),
        affiliateMall: String(chosen.mallLabel || chosen.mall || ''),
        affiliatePrice: Number(chosen.lprice) || null,
        affiliateProductId: String(chosen.productId || ''),
        affiliateVendorItemId: String(chosen.vendorItemId || ''),
        affiliateConfidence: Number(match.confidence) || 0,
        affiliateMatchReason: String(match.reason || ''),
        affiliateSearchQuery: String(matchedKeyword || '').slice(0, 80),
        ...(chosenImage ? {
          imageSource: String(chosen.mallLabel || chosen.mall || ''),
          imageProductId: String(chosen.productId || ''),
          imageMatchConfidence: Number(match.confidence) || 0,
          imageMatchReason: String(match.reason || ''),
          imageReference: false
        } : {})
      };
      row.metadata = meta;

      // 정확한 제휴 후보는 다음 실행부터 가격 이력 검증도 받을 수 있게 catalog/원장에 남긴다.
      const saved = await save(matchedKeyword, [chosen], {
        from: matchedFrom,
        source: 'external-hotdeal'
      });
      if (saved && Number(saved.saved) > 0) stats.saved += Number(saved.saved);

      // 0.90+ identity만 row의 SEOSA 상품 identity로 승격한다.
      row.matched_product_id = String(chosen.productId || '');
      row.matched_mall = String(chosen.mall || '');
      row.matched_vendor_item_id = String(chosen.vendorItemId || '');
      row.match_confidence = Number(match.confidence) || 0;
      row.match_method = 'affiliate-' + String(match.method || 'identity');
      stats.matched++;
    } catch (error) {
      stats.errors++;
      log('affiliate_enrich_error', {
        source: row.source,
        id: row.source_post_id,
        error: String((error && error.message) || error).slice(0, 180)
      });
    }
  }

  return stats;
}

// 표가 «없을» 때만 참이다. DB 일시 장애를 마이그레이션 전으로 읽지 않는다 (api/_dberror.js).
function isMissingTable(message) {
  return require('../api/_dberror').isMissingTable(String(message || ''));
}

async function loadRecentGroupRows(db, rows, nowMs, dryRun) {
  const ids = [...new Set(rows.map(r => r.matched_product_id).filter(Boolean))];
  if (!ids.length) return { rows: [], tableMissing: false };
  const since = new Date(nowMs - GROUP_WINDOW_HOURS * 3600000).toISOString();
  try {
    const found = await selectPaged(() => db.from('external_hotdeals').select('*')
      .in('matched_product_id', ids)
      .gte('posted_at', since)
      .order('id', { ascending: true }), 5000);
    return { rows: found, tableMissing: false };
  } catch (error) {
    if (isMissingTable(error.message)) {
      if (dryRun) return { rows: [], tableMissing: true };
      throw new Error('external_hotdeals table is missing — apply supabase/2026-09-12-external-hotdeals.sql manually');
    }
    throw new Error(`external_hotdeals(read): ${error.message}`);
  }
}

/**
 * Regroup the current batch together with recently stored posts so a product
 * posted on two communities in different runs still has one primary row.
 * Every source row is kept; only group fields and exposure are rewritten.
 */
function regroup(current, recent, policy) {
  const key = r => `${r.source}|${r.source_post_id}`;
  const seen = new Set(current.map(key));
  const carried = (recent || []).filter(r => !seen.has(key(r))).map(r => {
    const copy = { ...r };
    delete copy.id;
    return copy;
  });
  const rows = Radar.dedupeAcrossSources(current.concat(carried)).map(row => {
    const out = { ...row, group_key: row.groupKey, is_primary: row.isPrimary, source_count: row.sourceCount, sources: row.sources };
    delete out.groupKey; delete out.isPrimary; delete out.sourceCount;
    out.is_exposed = !!(out.is_primary && policy.allows(out.source) && Radar.isExposableRow(out));
    return out;
  });
  return { rows, carried: carried.length };
}

async function save(rows, db) {
  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await db.from('external_hotdeals')
      .upsert(rows.slice(i, i + 100), { onConflict: 'source,source_post_id' });
    if (error) throw new Error(`external_hotdeals: ${error.message}`);
  }
}

function countRows(rows) {
  return {
    unique: rows.length,
    matched: rows.filter(r => r.matched_product_id).length,
    highConfidence: rows.filter(r => r.matched_product_id && Number(r.match_confidence) >= Radar.HIGH_MATCH_CONFIDENCE).length,
    unmatched: rows.filter(r => !r.matched_product_id).length,
    verified: rows.filter(Radar.isExposableRow).length,
    suspicious: rows.filter(r => r.verification_status === 'SUSPICIOUS_PRICE').length,
    groupedUnderOther: rows.filter(r => !r.is_primary).length,
    exposed: rows.filter(r => r.is_exposed).length
  };
}

function summarize(sourceStats, rows, extra) {
  const sum = key => sourceStats.reduce((s, stat) => s + (Number(stat[key]) || 0), 0);
  const totals = countRows(rows);
  return {
    dryRun: extra.dryRun,
    shadow: extra.policy.shadow,
    publicSources: extra.policy.publicSources,
    fetched: sum('fetched'),
    normalized: sum('normalized'),
    duplicates: sum('duplicates') + totals.groupedUnderOther,
    ...totals,
    written: extra.written,
    carriedFromDb: extra.carried,
    tableMissing: extra.tableMissing,
    errors: sourceStats.filter(stat => stat.status !== 'ok').length,
    sources: sourceStats.map(stat => ({ ...stat, ...countRows(rows.filter(r => r.source === stat.source)) }))
  };
}

function summaryText(s) {
  const lines = [];
  for (const src of s.sources) {
    lines.push(`Source: ${src.source} (${src.kind || 'feed'}) status=${src.status}${src.errorKind ? ` error=${src.errorKind}` : ''}`
      + ` http=${src.httpStatus == null ? '-' : src.httpStatus} attempts=${src.attempts == null ? '-' : src.attempts} latency=${src.latencyMs}ms`);
    lines.push(`  Fetched: ${src.fetched}  Normalized: ${src.normalized}  Duplicates: ${src.duplicates}  Skipped: ${JSON.stringify(src.skipped || {})}`);
    lines.push(`  Matched: ${src.matched}  High-confidence: ${src.highConfidence}  Unmatched: ${src.unmatched}`);
    lines.push(`  Verified >=${Radar.EXPOSURE_SCORE}: ${src.verified}  Suspicious: ${src.suspicious}  Grouped under another post: ${src.groupedUnderOther}  Exposed: ${src.exposed}`);
  }
  if (!s.sources.length) lines.push('Source: (none enabled)');
  lines.push(`Mode: ${s.dryRun ? 'dry-run' : 'write'} · ${s.shadow ? 'shadow (verified exposure off; community feed may still show unverified rows)' : `public sources=[${s.publicSources.join(',')}]`}`
    + ` · written=${s.written} · carried=${s.carriedFromDb}${s.tableMissing ? ' · external_hotdeals table missing' : ''}`);
  if (s.affiliate) {
    lines.push(`Affiliate: attempted=${s.affiliate.attempted} searches=${s.affiliate.searches || 0} matched=${s.affiliate.matched} saved=${s.affiliate.saved} errors=${s.affiliate.errors}`);
  }
  return lines.join('\n');
}

function sampleOf(rows) {
  return rows.map(r => {
    const meta = r.metadata || {};
    return {
      source: r.source,
      id: r.source_post_id,
      title: r.title,
      price: r.price,
      mall: r.mall,
      shipping: meta.shippingNote || null,
      match: r.matched_product_id
        ? { productId: r.matched_product_id, title: meta.matchedTitle, confidence: Number(r.match_confidence), method: r.match_method, reason: meta.matchReason }
        : { confidence: Number(r.match_confidence), method: r.match_method, reason: meta.matchReason, bestCandidate: meta.bestCandidateTitle || null },
      score: r.deal_score,
      status: r.verification_status,
      reasons: r.verification_reasons,
      vs30dAvg: r.price_vs_30d_avg,
      vs90dLow: r.price_vs_90d_low,
      historyDays: r.history_observation_count,
      primary: r.is_primary,
      exposed: r.is_exposed,
      postUrl: r.source_url
    };
  });
}

async function main(options) {
  const opts = options || {};
  const db = opts.db || supabase;
  const sourceRegistry = opts.registry || registry;
  const dryRun = DRY_RUN || !!opts.dryRun;
  const policy = exposurePolicy(opts.env);
  const nowMs = opts.now == null ? Date.now() : Number(opts.now);
  const today = opts.today || kstToday();

  const fetched = await sourceRegistry.fetchAll({ now: new Date(nowMs) });
  (fetched.errors || []).forEach(error => log('source_error', error));

  let rows = [];
  let carried = 0;
  let tableMissing = false;
  let affiliate = { attempted: 0, searches: 0, matched: 0, saved: 0, skipped: 0, errors: 0 };
  if (fetched.items.length) {
    const products = await loadProducts(db);
    const matches = fetched.items.map(deal => Radar.matchProduct(deal, products));
    const history = await loadHistory(matches, db, today);
    const current = fetched.items.map((deal, i) => rowFor(deal, matches[i],
      Radar.verifyDeal(deal, matches[i], historyFor(matches[i], history), today), nowMs));

    // dry-run은 외부 쇼핑 API를 추가로 부르지 않는다. 테스트는 주입한 fake search로 별도 검증한다.
    affiliate = dryRun
      ? { attempted: 0, searches: 0, matched: 0, saved: 0, skipped: 0, errors: 0 }
      : await enrichAffiliateRows(fetched.items, current, {
          searchAll: opts.searchAll,
          saveProducts: opts.saveProducts,
          lookupLimit: opts.affiliateLookupLimit,
          searchLimit: opts.affiliateSearchLimit
        });
    const recent = await loadRecentGroupRows(db, current, nowMs, dryRun);
    tableMissing = recent.tableMissing;
    const grouped = regroup(current, recent.rows, policy);
    rows = grouped.rows;
    carried = grouped.carried;
  }

  if (!dryRun && rows.length) await save(rows, db);
  const currentKeys = new Set(fetched.items.map(d => `${d.source}|${d.externalId}`));
  const currentRows = rows.filter(r => currentKeys.has(`${r.source}|${r.source_post_id}`));
  const summary = summarize(fetched.sources || [], currentRows,
    { dryRun, policy, written: dryRun ? 0 : rows.length, carried, tableMissing });
  summary.affiliate = affiliate;

  if (!opts.quiet) {
    console.log(summaryText(summary));
    if (SAMPLE || opts.sample) console.log(JSON.stringify(sampleOf(currentRows), null, 2));
    log(dryRun ? 'dry_run' : 'complete', summary);
  }
  return summary;
}

if (require.main === module) {
  main().catch(error => { log('failed', { error: String((error && error.message) || error) }); process.exitCode = 1; });
}

module.exports = {
  main, loadProducts, loadHistory, historyFor, rowFor, exposurePolicy, regroup, selectPaged,
  enrichAffiliateRows, affiliateCandidateProduct, affiliateSearchQueries, cleanAffiliateQuery, safeImageUrl,
  summaryText, sampleOf
};
