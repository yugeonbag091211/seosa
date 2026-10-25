#!/usr/bin/env node
'use strict';

/*
 * SEOSA 점심/저녁 적응형 재확인. 기존 daily collector, price_job_state,
 * 검색 속도 제한, 옵션 게이트, 이상가격 보류 로직을 그대로 사용한다.
 *
 * - 과거 30일간 동일 상품/옵션의 실제 관측 가격 변화 수로만 우선순위 결정.
 * - 점심: 3회 이상, 저녁: 1회 이상 변동된 옵션부터 검사.
 * - 검색 API는 반드시 forceRefresh=true. 캐시를 실시간 관측으로 기록하지 않는다.
 * - 기존 daily collector와 같은 CAS 잠금. 충돌하면 호출 0회로 건너뛴다.
 * - 하루 상한과 추가 실행별 상한을 확인. 카운터 조회에 실패하면 호출 0회.
 * - DB에 새 테이블이나 컬럼을 만들지 않는다.
 */

require('./_env');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const db = require('../api/_supabase');
const { kstDayStartUtc, vendorIdOf } = require('../api/_price');
const { searchCoupang } = require('../api/_coupang');
const { searchAdpick } = require('../api/_adpick');
const { recordPrices, adpickProductId } = require('../api/_shop');
const { pickOption, acquireLock, loadState, releaseLock } = require('./collect-all-prices');
const { keyOf, volatilityRanking, slotPlan, pickSearchGroups } = require('./_price-volatility');
const { sendVolatileReport } = require('./_volatile-report');

const HISTORY_DAYS = 30;
const MAX_HISTORY_ROWS = 500000; // 이보다 많으면 편향된 일부 표본으로 실행하지 않는다.
const HISTORY_PAGE = 1000;
const CACHE_PATH = process.env.PRICE_VOLATILE_CACHE_FILE || '';
const DAY_CAP = {
  '쿠팡': Number(process.env.PRICE_VOLATILE_COUPANG_DAY_CAP) || 3400,
  'ADPICK': Number(process.env.PRICE_VOLATILE_ADPICK_DAY_CAP) || 3000
};
const SLOT_CAP = Math.max(1, Math.min(50, Number(process.env.PRICE_VOLATILE_SLOT_CALLS) || 45));

function cacheRead(day) {
  if (!CACHE_PATH) return null;
  try {
    const parsed = JSON.parse(zlib.gunzipSync(fs.readFileSync(CACHE_PATH)).toString('utf8'));
    if (parsed.version !== 1 || parsed.day !== day || !Array.isArray(parsed.ranking)) return null;
    return parsed.ranking;
  } catch (_) { return null; }
}
function cacheWrite(day, ranking) {
  if (!CACHE_PATH) return;
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    const bytes = zlib.gzipSync(Buffer.from(JSON.stringify({ version: 1, day, ranking })));
    fs.writeFileSync(CACHE_PATH, bytes);
  } catch (e) {
    console.warn('[adaptive] 캐시 기록 실패(다음번 DB 재조회):', e.message);
  }
}

async function getRanking(day) {
  const hit = cacheRead(day);
  if (hit) {
    console.log(`[adaptive] 오늘의 30일 변동성 캐시 사용: ${hit.length}개 옵션`);
    return hit;
  }
  const since = new Date(Date.now() - HISTORY_DAYS * 86400000).toISOString();
  let cursor = null;
  const observed = [];
  for (;;) {
    let q = db.from('price_history')
      .select('id,product_id,mall,vendor_item_id,price,recorded_at')
      .gte('recorded_at', since).order('id', { ascending: true }).limit(HISTORY_PAGE);
    if (cursor != null) q = q.gt('id', cursor);
    const { data, error } = await q;
    if (error) throw new Error('30일 가격 이력 조회 실패(안전 중단): ' + error.message);
    if (!Array.isArray(data)) throw new Error('가격 이력 조회 형식 오류(안전 중단)');
    if (data.length === 0) break;
    observed.push(...data);
    if (observed.length > MAX_HISTORY_ROWS) throw new Error('이력이 50만 행을 넘어 안전 중단: DB 집계 RPC 필요');
    const next = data[data.length - 1].id;
    if (next == null || String(next) === String(cursor)) throw new Error('이력 페이지 커서 정지');
    cursor = next;
    // PostgREST db-max-rows=1000, 최대 크기보다 짧으면 끝.
    if (data.length < HISTORY_PAGE) break;
  }
  const ranking = volatilityRanking(observed, 1);
  console.log(`[adaptive] 최근 30일 원장 ${observed.length}행 / 변동 옵션 ${ranking.length}개`);
  cacheWrite(day, ranking);
  return ranking;
}

async function getUsage(mall, day) {
  let q;
  if (mall === '쿠팡') {
    const start = kstDayStartUtc(day);
    const end = new Date(Date.parse(start) + 86400000).toISOString();
    q = db.from('coupang_api_calls').select('*', { count: 'exact', head: true })
      .gte('called_at', start).lt('called_at', end).eq('source', 'collect');
  } else {
    q = db.from('adpick_api_calls').select('id', { count: 'exact', head: true })
      .eq('kst_date', day).eq('source', 'collect').eq('external_call', true);
  }
  const { count, error } = await q;
  if (error || count == null || !Number.isSafeInteger(Number(count))) {
    throw new Error(mall + ' 하루 API 호출량 확인 불가(안전 중단): ' + (error?.message || 'count=null'));
  }
  return Number(count);
}

async function catalogForRanking(ranking, minChanges, slotStartMs, mall) {
  // 상위 후보부터만 상품 메타를 읽는다. 전체 7만 products 를 내려받지 않는다.
  const chosen = ranking.filter(r => r.changes >= minChanges && r.key.split('|')[1] === mall).slice(0, 400);
  if (!chosen.length) return [];
  const byKey = new Map(chosen.map(r => [r.key, r]));
  const ids = [...new Set(chosen.map(r => r.key.split('|')[0]))];
  const found = [];
  for (let i = 0; i < ids.length; i += 70) {
    const { data, error } = await db.from('products')
      .select('product_id,mall,title,keyword,link,vendor_item_id,item_id,image,collected_at,lprice')
      .in('product_id', ids.slice(i, i + 70));
    if (error) throw new Error('가격 재확인 대상 조회 실패: ' + error.message);
    for (const p of data || []) {
      if (p.mall !== mall || !p.title) continue;
      const key = keyOf({ product_id: p.product_id, mall: p.mall,
        vendor_item_id: mall === '쿠팡' ? vendorIdOf(p) : '' });
      const r = byKey.get(key);
      if (!r) continue; // 과거와 현재의 옵션이 바뀌었으면 수집하지 않는다.
      if (Date.parse(p.collected_at) >= slotStartMs) continue; // 같은 시간대 이미 재확인.
      found.push({ ...p, changes: r.changes });
    }
  }
  return found.sort((a, b) => b.changes - a.changes);
}

function observation(target, match, query) {
  const price = Number(match.lprice);
  if (!Number.isSafeInteger(price) || price <= 0) return null;
  return {
    productId: target.product_id,
    mall: target.mall,
    title: target.title,
    keyword: target.keyword || query,
    price,
    oprice: Number(match.oprice) || price,
    link: match.link || target.link || '',
    image: target.image || match.image || '',
    itemId: match.itemId || '',
    vendorItemId: match.vendorItemId || '',
    targetVendorItemId: target.mall === '쿠팡' ? vendorIdOf(target) : '',
    mallLabel: match.mallLabel || ''
  };
}

async function fetchFresh(mall, keyword) {
  const opts = { source: 'collect', forceRefresh: true, minGapMs: mall === '쿠팡' ? 6000 : 12000,
    maxWaitMs: 60000, limit: mall === '쿠팡' ? 10 : 20 };
  return mall === '쿠팡' ? searchCoupang(keyword, opts) : searchAdpick(keyword, opts);
}

/**
 * 판매처에 실제로 저장된 현재가를 사후 조회하여 "실제 표시 가격 변경"만 센다.
 * 확인·저장된 상품 수와 가격이 바뀐 상품 수는 같은 숫자가 아니다.
 * 원래 가격과 다른 API 응답을 받더라도 suspect 보류면 0으로 계산한다.
 */
async function confirmAppliedChanges(differences, mall, client = db) {
  const byProduct = new Map();
  for (const d of differences || []) {
    const id = String(d.productId || '');
    if (!id || !Number.isSafeInteger(d.beforePrice) || !Number.isSafeInteger(d.afterPrice)) continue;
    if (d.beforePrice === d.afterPrice) continue;
    byProduct.set(id, d);
  }
  if (!byProduct.size) return 0;

  let applied = 0;
  const ids = [...byProduct.keys()];
  for (let i = 0; i < ids.length; i += 70) {
    const { data, error } = await client.from('products')
      .select('product_id,mall,lprice').in('product_id', ids.slice(i, i + 70)).eq('mall', mall);
    if (error) throw new Error(mall + ' 가격 반영 재검증 실패: ' + error.message);
    for (const row of data || []) {
      const expected = byProduct.get(String(row.product_id));
      if (expected && Number(row.lprice) === expected.afterPrice) applied++;
    }
  }
  return applied;
}

function emptyMallStats() {
  return {
    candidates: 0, groups: 0, spent: 0, checked: 0, saved: 0,
    observedDifferences: 0, changedApplied: 0, suspect: 0,
    rejected: 0, optionMiss: 0, cacheSkip: 0, failed: 0
  };
}

async function run() {
  if (process.env.PRICE_VOLATILE_OFF === '1') {
    console.log('[adaptive] 긴급 중지 스위치 ON — 가격 재확인하지 않음');
    return;
  }

  const plan = slotPlan(new Date(), process.env.PRICE_VOLATILE_SLOT || '');
  if (!plan) {
    console.log('[adaptive] 점심/저녁 수집 시간대 밖 — 외부 호출 0');
    return;
  }

  const report = {
    day: plan.day, slot: plan.slot, status: 'failed',
    startedAt: new Date().toISOString(), finishedAt: '',
    reason: '', usage: {}, caps: DAY_CAP, results: {
      '쿠팡': emptyMallStats(), 'ADPICK': emptyMallStats()
    }
  };

  try {
    const state = await loadState();
    if (!state) throw new Error('공유 수집기 잠금 상태 없음(안전 중단)');
    const lock = await acquireLock(state);
    if (!lock.ok) {
      report.status = 'skipped';
      report.reason = '기존 정기 수집과 잠금 충돌: ' + lock.reason;
      console.log('[adaptive] 재확인 건너뜀: ' + report.reason);
      return;
    }

    try {
      const usage = {
        '쿠팡': await getUsage('쿠팡', plan.day),
        'ADPICK': await getUsage('ADPICK', plan.day)
      };
      report.usage = usage;
      const allowances = Object.fromEntries(Object.keys(DAY_CAP).map(mall => [
        mall, Math.max(0, Math.min(SLOT_CAP, DAY_CAP[mall] - usage[mall]))
      ]));
      console.log(`[adaptive] ${plan.day} ${plan.slot}, 지난 30일 가격변동 최소 ${plan.minChanges}회`);
      console.log(`[adaptive] API 사용량: 쿠팡 ${usage['쿠팡']}/${DAY_CAP['쿠팡']}, ADPICK ${usage.ADPICK}/${DAY_CAP.ADPICK}`);
      if (!Object.values(allowances).some(Boolean)) {
        report.status = 'skipped';
        report.reason = '두 판매처 모두 추가 검증용 하루 API 호출 예산 소진';
        console.log('[adaptive] ' + report.reason);
        return;
      }

      const ranking = await getRanking(plan.day);
      for (const mall of ['쿠팡', 'ADPICK']) {
        const stats = report.results[mall];
        if (!allowances[mall]) { stats.reason = 'quota'; continue; }

        const candidates = await catalogForRanking(ranking, plan.minChanges, plan.startMs, mall);
        const groups = pickSearchGroups(candidates, allowances[mall]);
        stats.candidates = candidates.length;
        stats.groups = groups.length;
        const possibleChanges = [];
        console.log(`[adaptive] ${mall}: 후보 상품 ${candidates.length}, 검색어 그룹 ${groups.length}`);

        for (const group of groups) {
          if (stats.spent >= allowances[mall]) break;
          const r = await fetchFresh(mall, group.keyword);
          if (r.apiCalled === true || r.from === 'api') stats.spent++;
          // API 강제 갱신에 실패했다면 예전 캐시를 방금 확인한 가격으로 위장하지 않는다.
          if (r.from !== 'api' || r.blocked || r.error) {
            stats.cacheSkip++;
            if (r.blocked) {
              console.warn(`[adaptive] ${mall} 차단 감지 — 중지: ${r.error}`);
              stats.reason = 'blocked';
              break;
            }
            continue;
          }

          const sourceItems = mall === '쿠팡' ? (r.allItems || r.items || []) : (r.items || []);
          const observations = [];
          for (const p of group.targets) {
            let match;
            if (mall === '쿠팡') {
              const picked = pickOption(p, sourceItems);
              match = picked.item;
              if (!match && picked.reason === 'OPTION_MISMATCH') stats.optionMiss++;
            } else {
              match = sourceItems.find(it => adpickProductId(it.commissionlink) === String(p.product_id));
              if (match) match = {
                lprice: match.price, oprice: match.price, link: match.commissionlink,
                image: match.photo || '', itemId: '', vendorItemId: '', mallLabel: match.mallLabel || ''
              };
            }
            if (!match) continue;
            const obs = observation(p, match, group.keyword);
            if (!obs) continue;
            observations.push(obs);
            const beforePrice = Number(p.lprice);
            if (Number.isSafeInteger(beforePrice) && beforePrice > 0 && beforePrice !== obs.price) {
              possibleChanges.push({ productId: String(p.product_id), beforePrice, afterPrice: obs.price });
              stats.observedDifferences++;
            }
          }

          if (!observations.length) continue;
          stats.checked += observations.length;
          const saved = await recordPrices(observations, { source: 'collect', label: 'adaptive-' + plan.slot });
          if (saved.errors?.length) throw new Error('재확인 가격 저장 실패: ' + saved.errors.join('; '));
          stats.saved += saved.saved || 0;
          stats.suspect += saved.suspect || 0;
          stats.rejected += saved.rejected || 0;
          stats.failed += (saved.rejected || 0) + (saved.optionMismatch || 0);
        }

        stats.changedApplied = await confirmAppliedChanges(possibleChanges, mall);
        console.log(`[adaptive] ${mall}: 실제 API ${stats.spent}회 / 확인 ${stats.checked}개 / 현재가 반영 ${stats.saved}개 / 가격 변경 ${stats.changedApplied}개 / 이상값 보류 ${stats.suspect}개`);
      }

      report.status = 'completed';
      console.log('[adaptive] RESULT ' + JSON.stringify({
        day: plan.day, slot: plan.slot, status: report.status, results: report.results
      }));
    } finally {
      await releaseLock(lock.token);
    }
  } catch (error) {
    report.status = 'failed';
    report.reason = String(error.message || error).slice(0, 600);
    console.error('[adaptive] 실패:', report.reason);
    throw error;
  } finally {
    // 성공·예산 소진·잠금 충돌·오류 모두 결과를 발송한다.
    // 메일 실패가 API/DB 수집 결과를 뒤집지는 않는다.
    report.finishedAt = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false }) + ' KST';
    await sendVolatileReport(report);
  }
}

module.exports = { observation, catalogForRanking, getUsage, getRanking, confirmAppliedChanges, emptyMallStats };
if (require.main === module) {
  run().catch(e => { console.error('[adaptive] 실패:', e.stack || e.message); process.exitCode = 1; });
}
