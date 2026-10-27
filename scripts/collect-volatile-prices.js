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
 *
 * ── 2026-10-27 안정화 ───────────────────────────────────────────────
 *
 * 2026-10-26 에 점심·저녁이 둘 다 «수집 0건 + GitHub SUCCESS + 메일 없음» 으로
 * 끝났다. 원인은 둘이다 (scripts/_price-volatility.js 머리말에 실측 수치).
 *
 *   ① GitHub schedule 이벤트가 5시간 42분 / 6시간 33분 늦게 «생성» 됐다.
 *      창 밖이라 수집을 건너뛴 것은 설계대로다.
 *   ② 그런데 그 건너뛰기가 report 객체를 만들기 «전에» return 해서, 메일도
 *      GitHub Summary 도 아무 것도 남지 않았다. 침묵이 성공처럼 보였다.
 *
 * 그래서 이 파일의 구조를 바꿨다.
 *   · report 는 어떤 경로로 끝나도 반드시 만들어지고 상태가 찍힌다
 *   · 상태는 7가지로 갈린다 (COMPLETED/NO_CHANGE/SKIPPED/MISSED/LOCKED/
 *     QUOTA_EXHAUSTED/FAILED) — «호출 0회로 끝났다» 와 «예약을 잃었다» 가
 *     더 이상 같은 초록색이 아니다
 *   · 같은 (KST 날짜, 슬롯) 은 슬롯 원장으로 한 번만 수집한다. 트리거를
 *     이중화해도 중복 호출·중복 기록이 생기지 않는다
 *   · 창이 닫혔는데 아무도 수집하지 않은 슬롯은 어느 실행이든 발견하면
 *     MISSED 로 메일 + 종료코드 1 (빨간 X)
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
const {
  keyOf, volatilityRanking, slotPlan, pickSearchGroups,
  STATUS, kstDay, slotWindow, delayMinutes,
  isServed, ledgerGet, ledgerPut, missedSlots, decideStatus, exitCodeFor
} = require('./_price-volatility');
const { sendVolatileReport, totals } = require('./_volatile-report');

const HISTORY_DAYS = 30;
const MAX_HISTORY_ROWS = 500000; // 이보다 많으면 편향된 일부 표본으로 실행하지 않는다.
const HISTORY_PAGE = 1000;
const CACHE_PATH = process.env.PRICE_VOLATILE_CACHE_FILE || '';
const DAY_CAP = {
  '쿠팡': Number(process.env.PRICE_VOLATILE_COUPANG_DAY_CAP) || 3400,
  'ADPICK': Number(process.env.PRICE_VOLATILE_ADPICK_DAY_CAP) || 3000
};
const SLOT_CAP = Math.max(1, Math.min(50, Number(process.env.PRICE_VOLATILE_SLOT_CALLS) || 45));

/*
 * KST 시각 표기 — 'YYYY-MM-DD HH:MM KST'.
 *
 * toLocaleString('ko-KR') 을 쓰지 않는다. 러너의 ICU 에 따라
 * '2026. 10. 26. 12시 5분 0초' 처럼 나와 메일마다 모양이 달라지고,
 * 예정 시각과 실제 시각을 눈으로 비교할 수 없다. UTC+9 는 서머타임이
 * 없으므로 9시간을 더해 자르면 항상 정확하다 (api/_kst.js 와 같은 기준).
 */
const kstText = ms => new Date(Number(ms) + 9 * 3600000)
  .toISOString().replace('T', ' ').slice(0, 16) + ' KST';

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

/* ─── 슬롯 원장 입출력 ───────────────────────────────────────────────
 *
 * price_job_state.last_result.volatileSlots 에 얹는다. 새 테이블·새 컬럼 없음.
 * 쓰기는 반드시 «잠금이 우리 것일 때만» (markV3Kill 과 같은 CAS 조건).
 * ------------------------------------------------------------------ */

async function readLedger(client = db) {
  const { data, error } = await client.from('price_job_state')
    .select('last_result').eq('id', 1).maybeSingle();
  if (error) throw new Error('슬롯 원장 조회 실패(안전 중단): ' + error.message);
  return (data && data.last_result && data.last_result.volatileSlots) || {};
}

/**
 * 슬롯 한 칸을 원장에 기록한다. 잠금을 잃었으면 false (던지지 않는다).
 * 원장을 못 써도 가격은 이미 저장돼 있다 — 다음 실행이 중복으로 보는 쪽이
 * 가격을 잃는 쪽보다 낫고, 그 중복도 products.collected_at 게이트가 막는다.
 */
async function writeSlot(lockToken, day, slot, patch, client = db) {
  try {
    const { data, error } = await client.from('price_job_state')
      .select('last_result').eq('id', 1).maybeSingle();
    if (error) throw new Error(error.message);
    const lr = (data && data.last_result) || {};
    const next = ledgerPut(lr.volatileSlots, day, slot, patch);
    const u = await client.from('price_job_state')
      .update({ last_result: { ...lr, volatileSlots: next } })
      .eq('id', 1).eq('last_result->lock->>runId', lockToken).select('id');
    if (u.error) throw new Error(u.error.message);
    if (!u.data || !u.data.length) throw new Error('잠금이 우리 것이 아니다');
    return true;
  } catch (e) {
    console.warn(`[adaptive] 슬롯 원장 기록 실패(${day} ${slot}): ${e.message}`);
    return false;
  }
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

/** 어떤 경로로 끝나도 같은 모양의 보고서를 만든다. */
function newReport(now, window, wantedSlot) {
  const ms = now.getTime();
  return {
    day: window ? window.day : kstDay(ms),
    slot: window ? window.slot : (wantedSlot || ''),
    status: STATUS.SKIPPED,
    reason: '',
    scheduledAt: window ? kstText(window.targetMs) : '',
    startedAt: kstText(ms),
    startedAtIso: new Date(ms).toISOString(),
    delayMinutes: delayMinutes(window, ms),
    finishedAt: '',
    usage: {}, caps: DAY_CAP,
    results: { '쿠팡': emptyMallStats(), 'ADPICK': emptyMallStats() }
  };
}

/**
 * GitHub Actions 가 결과를 그대로 읽을 수 있게 남긴다.
 * Summary 단계가 status 를 보고 초록/노랑/빨강을 가른다.
 */
function publishOutputs(report) {
  const t = totals(report.results);
  const line = `status=${report.status} slot=${report.slot || '-'} day=${report.day}`
    + ` delayMin=${report.delayMinutes} coupangCalls=${report.results['쿠팡'].spent}`
    + ` adpickCalls=${report.results.ADPICK.spent} checked=${t.checked}`
    + ` saved=${t.saved} changed=${t.changedApplied} optionMiss=${t.optionMiss}`
    + (report.reason ? ` reason=${JSON.stringify(report.reason)}` : '');
  console.log('[adaptive] RESULT ' + line);
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  try {
    fs.appendFileSync(out, [
      `status=${report.status}`,
      `slot=${report.slot || ''}`,
      `day=${report.day}`,
      `delay_minutes=${report.delayMinutes}`,
      `coupang_calls=${report.results['쿠팡'].spent}`,
      `adpick_calls=${report.results.ADPICK.spent}`,
      `checked=${t.checked}`,
      `saved=${t.saved}`,
      `changed=${t.changedApplied}`,
      `reason=${String(report.reason || '').replace(/[\r\n]+/g, ' ').slice(0, 300)}`
    ].join('\n') + '\n');
  } catch (e) {
    console.warn('[adaptive] GITHUB_OUTPUT 기록 실패:', e.message);
  }
}

/**
 * 창이 닫혔는데 수집 기록이 없는 슬롯을 MISSED 로 보고한다.
 * 예약 자체가 발화하지 않은 날은 워크플로 내부 코드로 알 수 없으므로,
 * «다음에 깨어난 실행» 이 원장을 보고 대신 발견한다.
 *
 * 경고 표식을 원장에 남기지 못하면 메일을 보내지 않는다 — 표식이 없으면
 * 다음 실행이 또 보내 하루에 열 통이 된다.
 */
async function sweepMissed(now, ledger, lockToken, opts = {}) {
  const client = opts.client || db;
  const send = opts.send || sendVolatileReport;
  const sent = [];
  for (const w of missedSlots(now, ledger)) {
    const marked = await writeSlot(lockToken, w.day, w.slot,
      { status: STATUS.MISSED, notifiedMissAt: new Date().toISOString() }, client);
    if (!marked) {
      console.warn(`[adaptive] ${w.day} ${w.slot} 누락을 발견했지만 원장에 표시하지 못해 경고를 보류합니다.`);
      continue;
    }
    const missReport = newReport(new Date(now), w, w.slot);
    missReport.status = STATUS.MISSED;
    missReport.delayMinutes = Math.round((now.getTime() - w.targetMs) / 60000);
    missReport.reason = `예약 시각 ${kstText(w.targetMs)} 의 재확인이 창(${kstText(w.startMs)}~${kstText(w.endMs)})`
      + ' 안에 한 번도 실행되지 않았습니다. GitHub Actions 예약 지연 또는 미발화로 추정됩니다.';
    missReport.finishedAt = kstText(now.getTime());
    console.error(`[adaptive] MISSED ${w.day} ${w.slot} — 창 안에 실행 없음`);
    await send(missReport);
    sent.push(w);
  }
  return sent;
}

/*
 * 메일을 보낼 상태인가 — 침묵도 스팸도 둘 다 사고다.
 *
 *   보낸다:   실제로 슬롯을 맡아 처리한 실행(COMPLETED/NO_CHANGE/
 *             QUOTA_EXHAUSTED/FAILED), 그리고 MISSED
 *   안 보낸다: 중복분(SKIPPED) · 잠금 충돌(LOCKED) · 창 밖 감시 실행
 *             — 창을 끝내 놓치면 sweepMissed 가 MISSED 로 보낸다.
 *             칸이 23개인데 전부 보내면 창마다 메일이 여덟 통이 된다.
 *   suppressed: sweepMissed 가 이미 슬롯별로 보냈다는 뜻.
 */
const EMAIL_STATUSES = [STATUS.COMPLETED, STATUS.NO_CHANGE,
  STATUS.QUOTA_EXHAUSTED, STATUS.FAILED, STATUS.MISSED];
function shouldEmail(status, suppressed) {
  return !suppressed && EMAIL_STATUSES.includes(status);
}

async function run() {
  const now = new Date();
  const wantedSlot = process.env.PRICE_VOLATILE_SLOT || '';
  const plan = slotPlan(now, wantedSlot);
  const report = newReport(now, plan, wantedSlot);
  let suppressEmail = false;
  let claimed = false;
  let missed = [];

  try {
    if (process.env.PRICE_VOLATILE_OFF === '1') {
      /*
       * 사용자가 직접 내린 스위치다. 이 스위치는 저장소 변수라 그날의 모든
       * 실행에 똑같이 걸린다 — 누락 감시(sweepMissed)도 여기서 함께 멈추므로
       * 스위치를 내린 동안 MISSED 경고가 울지 않는다. 의도된 침묵이다.
       */
      report.status = STATUS.SKIPPED;
      report.reason = '긴급 중지 스위치(PRICE_VOLATILE_OFF=1) — 가격 재확인하지 않음';
      console.log('[adaptive] ' + report.reason);
      return;
    }

    const state = await loadState();
    if (!state) throw new Error('공유 수집기 잠금 상태 없음(안전 중단)');
    const lock = await acquireLock(state);
    if (!lock.ok) {
      // 호출 0회. 같은 창의 다음 칸이 다시 시도하고, 창이 닫히면 MISSED 가 된다.
      report.status = STATUS.LOCKED;
      report.reason = '기존 정기 수집과 잠금 충돌: ' + lock.reason;
      console.log('[adaptive] 재확인 보류(LOCKED): ' + report.reason);
      return;
    }

    try {
      const ledger = (state.last_result && state.last_result.volatileSlots) || {};

      // ① 창 밖이다 — 수집할 슬롯이 없다. 놓친 슬롯이 있는지만 본다.
      if (!plan) {
        missed = await sweepMissed(now, ledger, lock.token);
        const ownSwept = wantedSlot && missed.some(w => w.slot === wantedSlot);
        const ownWindow = wantedSlot ? slotWindow(kstDay(now), wantedSlot) : null;
        // ★ 창이 «닫혔을» 때만 누락이다. 아직 열리지 않은 창을 MISSED 로
        //   부르면(예: 수동 dispatch 를 새벽에 돌림) 거짓 경보에 빨간 X 다.
        const ownClosed = ownWindow && now.getTime() >= ownWindow.endMs;
        if (wantedSlot && !ownSwept && ownClosed) {
          // 특정 슬롯을 하라고 지시받았는데 그 창이 이미 닫혔다.
          // 2026-10-26 에 일어난 바로 그 경우다 (예약 +5h42m / +6h33m).
          report.status = STATUS.MISSED;
          report.reason = `${wantedSlot} 슬롯을 지시받았지만 실행 시각이 창 밖입니다`
            + ' — 예약 지연으로 이 슬롯의 수집 기회를 잃었습니다.';
          console.error('[adaptive] ' + report.reason);
        } else if (wantedSlot && !ownSwept) {
          // 창이 아직 열리지 않았다 — 너무 이른 실행. 누락이 아니다.
          report.status = STATUS.SKIPPED;
          report.reason = `${wantedSlot} 창이 아직 열리지 않았습니다`
            + ` (${ownWindow ? kstText(ownWindow.startMs) : '-'} 부터) — 외부 호출 0회`;
          console.log('[adaptive] ' + report.reason);
        } else if (missed.length) {
          // sweepMissed 가 슬롯별로 이미 메일을 보냈다. 여기서 또 보내지 않는다.
          report.status = STATUS.MISSED;
          report.reason = missed.map(w => `${w.day} ${w.slot} 누락 감지`).join(', ');
          suppressEmail = true;
        } else {
          report.status = STATUS.SKIPPED;
          report.reason = '점심/저녁 수집 창 밖 — 외부 호출 0회(정상 감시 실행)';
          console.log('[adaptive] ' + report.reason);
        }
        return;
      }

      // ② 같은 (KST 날짜, 슬롯) 을 이미 처리했다 — 트리거 이중화의 중복분.
      const prior = ledgerGet(ledger, plan.day, plan.slot);
      if (prior && isServed(prior)) {
        report.status = STATUS.SKIPPED;
        report.reason = `${plan.day} ${plan.slot} 슬롯은 이미 처리됨(${prior.status}`
          + `${prior.at ? ' @' + prior.at : ''}) — 중복 수집하지 않음`;
        console.log('[adaptive] ' + report.reason);
        return;
      }

      // ③ 이제부터가 이 슬롯의 담당자다. 외부 호출 전에 시도 횟수를 먼저 남긴다.
      const attempts = Number(prior && prior.attempts) || 0;
      await writeSlot(lock.token, plan.day, plan.slot, {
        status: 'RUNNING', attempts: attempts + 1, at: new Date().toISOString(),
        runId: process.env.GITHUB_RUN_ID || 'local'
      });
      claimed = true;

      const usage = {
        '쿠팡': await getUsage('쿠팡', plan.day),
        'ADPICK': await getUsage('ADPICK', plan.day)
      };
      report.usage = usage;
      const allowances = Object.fromEntries(Object.keys(DAY_CAP).map(mall => [
        mall, Math.max(0, Math.min(SLOT_CAP, DAY_CAP[mall] - usage[mall]))
      ]));
      console.log(`[adaptive] ${plan.day} ${plan.slot}, 예정 ${report.scheduledAt},`
        + ` 실제 ${report.startedAt}, 지연 ${report.delayMinutes}분,`
        + ` 지난 30일 가격변동 최소 ${plan.minChanges}회`);
      console.log(`[adaptive] API 사용량: 쿠팡 ${usage['쿠팡']}/${DAY_CAP['쿠팡']}, ADPICK ${usage.ADPICK}/${DAY_CAP.ADPICK}`);

      if (!Object.values(allowances).some(Boolean)) {
        report.status = STATUS.QUOTA_EXHAUSTED;
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

      const t = totals(report.results);
      const blocked = Object.values(report.results).some(s => s.reason === 'blocked');
      if (blocked && t.checked === 0) {
        // 판매처 차단은 일시적이다. FAILED 로 남겨 같은 창의 다음 칸이
        // (MAX_SLOT_ATTEMPTS 안에서) 다시 시도할 수 있게 한다.
        report.status = STATUS.FAILED;
        report.reason = '판매처 검색이 차단되어 재확인하지 못했습니다 — 같은 창에서 재시도합니다';
      } else {
        report.status = decideStatus(t);
        if (report.status === STATUS.SKIPPED) {
          report.reason = '재확인 대상 후보가 없었습니다 — 외부 호출 0회';
        } else if (t.checked === 0) {
          report.reason = '검색 응답에서 동일 상품·옵션이 매칭되지 않아 기록한 가격이 없습니다';
        }
      }

      // 창이 닫힌 다른 슬롯(어제 저녁 등)이 남아 있으면 같이 보고한다.
      missed = await sweepMissed(now, ledger, lock.token);
    } catch (inner) {
      // 안쪽에서 상태를 확정해야 한다 — 바깥 catch 는 아래 finally 보다 늦게 돈다.
      // 그대로 두면 실패한 실행이 원장에 SKIPPED 로 적혀 재시도가 막힌다.
      report.status = STATUS.FAILED;
      report.reason = String(inner.message || inner).slice(0, 600);
      throw inner;
    } finally {
      // 상태를 원장에 확정한 뒤에 잠금을 놓는다. 순서가 바뀌면 다음 러너가
      // 「아직 아무도 안 했다」로 보고 같은 슬롯을 한 번 더 수집한다.
      // claimed 가 아니면(중복분·창 밖) 남의 기록을 덮어쓰지 않는다.
      if (claimed) {
        await writeSlot(lock.token, plan.day, plan.slot, {
          status: report.status, at: new Date().toISOString(),
          reason: String(report.reason || '').slice(0, 300),
          checked: totals(report.results).checked,
          changed: totals(report.results).changedApplied
        });
      }
      await releaseLock(lock.token);
    }
  } catch (error) {
    report.status = STATUS.FAILED;
    report.reason = String(error.message || error).slice(0, 600);
    console.error('[adaptive] 실패:', report.reason);
  } finally {
    report.finishedAt = kstText(Date.now());
    publishOutputs(report);
    /*
     * 메일 정책 — 침묵도 스팸도 둘 다 사고다.
     *   보낸다:  실제로 슬롯을 맡아 처리한 실행(COMPLETED/NO_CHANGE/
     *            QUOTA_EXHAUSTED/FAILED), 그리고 MISSED
     *   안 보낸다: 중복분(SKIPPED) · 잠금 충돌(LOCKED) · 창 밖 감시 실행
     *            — 창을 끝내 놓치면 sweepMissed 가 MISSED 로 보낸다.
     */
    if (shouldEmail(report.status, suppressEmail)) await sendVolatileReport(report);
    process.exitCode = exitCodeFor(report.status);
  }
  return report;
}

module.exports = {
  observation, catalogForRanking, getUsage, getRanking, confirmAppliedChanges,
  emptyMallStats, newReport, publishOutputs, sweepMissed, readLedger, writeSlot,
  shouldEmail, EMAIL_STATUSES, run
};
if (require.main === module) {
  run().catch(e => { console.error('[adaptive] 실패:', e.stack || e.message); process.exitCode = 1; });
}
