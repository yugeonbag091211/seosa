#!/usr/bin/env node
'use strict';
/*
 * Product Identity — Phase 2 Shadow Matching 워커.
 *
 *   products ──READ──▶ api/_offeridentity (Phase 1) ──▶ identity_shadow_* 표
 *
 * ── 사용자에게 보이는 변화는 0 이다 ────────────────────────────────
 *
 * 검색·AI·상품 상세·최저가·가격 그래프·핫딜·수집기 중 어느 것도 이 표를 읽지
 * 않는다. Phase 2 는 «판정이 운영 데이터에서 어떻게 나오는지 지켜보는» 단계다.
 * 소비 경로를 잇는 것은 Phase 3 이후이고 별도 PR 로 한다
 * (scripts/test-identity-shadow.js 가 «소비자가 없음» 을 테스트로 고정한다).
 *
 * ── 안전장치 ───────────────────────────────────────────────────────
 *
 *   · opt-in   IDENTITY_SHADOW_ENABLED 가 없으면 아무것도 하지 않고 exit 0
 *   · 잠금     identity_shadow_job_state CAS + DB 의 «running 은 하나» 인덱스
 *   · dry-run  SELECT 만 한다. 쓰기 경로를 아예 타지 않는다
 *   · 검증     불변식 하나라도 깨지면 저장하지 않고 run 을 failed 로 끝낸다
 *   · 상태     completed 는 전부 저장한 뒤에만 적는다 (중간 실패는 partial/failed)
 *   · 운영표   products / price_history 에 쓰지 않는다 (SELECT 만)
 *
 * 사용법
 *   IDENTITY_SHADOW_ENABLED=true node scripts/run-offer-identity-shadow.js --dry-run
 *   IDENTITY_SHADOW_ENABLED=true node scripts/run-offer-identity-shadow.js --limit 100
 *   IDENTITY_SHADOW_ENABLED=true node scripts/run-offer-identity-shadow.js --mall 쿠팡
 *   ... --sample 20 --sample-out /tmp/sample.json   사람이 볼 표본 (repo 에 넣지 않는다)
 *
 * ★ 테스트는 CLI 를 거치지 않고 run(db, opts) 를 직접 부른다. 그래서 옵션은
 *   전역이 아니라 인자로 흐른다 (scripts/test-identity-shadow.js).
 */

const fs = require('fs');
const { execFileSync } = require('child_process');

const OI = require('../api/_offeridentity');
const SH = require('../api/_identityshadow');
const { withDbRetry, isMissingTable, classifyDbError } = require('../api/_dberror');

/** 잠금 유효 시간. 실행이 죽어도 이 시간 뒤에는 회수된다. */
const LOCK_TTL_MS = 30 * 60 * 1000;
const LOCK = { ACQUIRED: 'acquired', SKIP: 'skip', FAIL: 'fail' };

const DEFAULTS = {
  dryRun: false,
  limit: 0,
  malls: [],
  sample: 0,
  sampleOut: '',
  /*
   * 한 번에 보내는 행 수. PostgREST 한 요청의 payload 와 타임아웃을 함께 본다.
   * member 행은 identity_snapshot(jsonb)을 들고 있어 group 행보다 무겁다.
   */
  batchSize: 500,
  /** products 키셋 페이지 크기 (PostgREST 기본 상한과 같다). */
  pageSize: 1000,
  /*
   * 쌍 판정 전수 조사에서 한 블록이 이보다 크면 건너뛴다. 블록 안 비교는 O(n²) 이고,
   * 변별력 없는 큰 블록은 군집 결과에도 쓰이지 않는다(Phase 1 MAX_BLOCK 과 같은 생각).
   * 건너뛴 수는 metadata.censusSkippedBlocks 로 드러낸다 — 조용히 줄이지 않는다.
   */
  censusMaxBlock: 400,
  lockTtlMs: LOCK_TTL_MS,
  now: () => Date.now(),
  log: null
};

function withDefaults(opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  o.malls = o.malls || [];
  o.logFn = typeof o.log === 'function' ? o.log : defaultLog;
  return o;
}

function defaultLog(msg, extra) {
  const line = { t: new Date().toISOString(), msg };
  if (extra) Object.assign(line, extra);
  console.log(JSON.stringify(line));
}

/* ── CLI 인자 ───────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const a = argv || [];
  const flag = f => a.indexOf(f) > -1;
  const val = (name, fallback) => {
    const i = a.indexOf(name);
    return i > -1 && a[i + 1] && !String(a[i + 1]).startsWith('--') ? a[i + 1] : fallback;
  };
  const all = name => {
    const out = [];
    a.forEach((x, i) => { if (x === name && a[i + 1] && !String(a[i + 1]).startsWith('--')) out.push(a[i + 1]); });
    return out;
  };
  const num = (name, fallback) => {
    const v = Number(val(name, NaN));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
  };
  return {
    dryRun: flag('--dry-run'),
    limit: num('--limit', 0),
    malls: all('--mall'),
    sample: num('--sample', 0),
    sampleOut: val('--sample-out', ''),
    batchSize: num('--batch-size', Number(process.env.IDENTITY_SHADOW_BATCH) || DEFAULTS.batchSize),
    censusMaxBlock: Number(process.env.IDENTITY_SHADOW_CENSUS_MAX_BLOCK) || DEFAULTS.censusMaxBlock
  };
}

/** 이 코드가 어느 커밋인지. 결과를 나중에 비교하려면 반드시 남겨야 한다. */
function matcherVersion() {
  if (process.env.GITHUB_SHA) return String(process.env.GITHUB_SHA).slice(0, 40);
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) { return 'unknown'; }
}

/* ── 잠금 (identity_shadow_job_state singleton) ──────────────────────── */

const newToken = () => `${process.env.GITHUB_RUN_ID || 'local'}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function acquireLock(db, opts) {
  const o = withDefaults(opts);
  // dry-run 은 아무것도 쓰지 않는다. 잠금도 쓰기이므로 잡지 않는다.
  if (o.dryRun) return { result: LOCK.ACQUIRED, token: '', dry: true };

  const read = await db.from('identity_shadow_job_state')
    .select('id, status, lock_token, lock_until').eq('id', 1).maybeSingle();
  if (read.error) {
    // 표가 «없을» 때만 SKIP 이다 (마이그레이션 전). DB 일시 장애는 FAIL 로 드러낸다.
    if (isMissingTable(read.error)) {
      o.logFn('lock_table_missing', { hint: 'supabase/2026-10-13-identity-shadow.sql 을 실행하세요' });
      return { result: LOCK.SKIP, reason: 'table_missing' };
    }
    o.logFn('lock_read_failed', { error: read.error.message });
    return { result: LOCK.FAIL, reason: 'read_failed' };
  }
  if (!read.data) { o.logFn('lock_row_missing'); return { result: LOCK.SKIP, reason: 'row_missing' }; }

  const row = read.data;
  const heldUntil = row.lock_until ? Date.parse(row.lock_until) : 0;
  if (row.status === 'running' && heldUntil > o.now()) {
    o.logFn('lock_busy', { until: row.lock_until });
    return { result: LOCK.SKIP, reason: 'busy' };
  }
  if (row.status === 'running') o.logFn('lock_expired_reclaim');

  // CAS — 우리가 읽은 토큰이 그대로일 때만 잡는다. 동시에 들어오면 한쪽만 행을 받는다.
  const token = newToken();
  const now = new Date(o.now());
  const upd = await db.from('identity_shadow_job_state')
    .update({
      status: 'running', lock_token: token,
      lock_until: new Date(now.getTime() + o.lockTtlMs).toISOString(),
      last_run_at: now.toISOString(), updated_at: now.toISOString()
    })
    .eq('id', 1).eq('lock_token', row.lock_token || '').select('id');

  if (upd.error) { o.logFn('lock_acquire_failed', { error: upd.error.message }); return { result: LOCK.FAIL, reason: 'acquire_failed' }; }
  if (!upd.data || upd.data.length === 0) { o.logFn('lock_cas_lost'); return { result: LOCK.SKIP, reason: 'cas_lost' }; }
  return { result: LOCK.ACQUIRED, token };
}

/** 잠금 반납. ★ 자기 토큰일 때만 — 남의 잠금을 풀지 않는다. */
async function releaseLock(db, lock, runId, summary, opts) {
  const o = withDefaults(opts);
  if (!lock || lock.dry || lock.result !== LOCK.ACQUIRED || !lock.token) return;
  const now = new Date(o.now()).toISOString();
  const r = await db.from('identity_shadow_job_state')
    .update({
      status: 'idle', lock_token: '', lock_until: null,
      last_run_id: runId || null, last_result: summary || {}, updated_at: now
    })
    .eq('id', 1).eq('lock_token', lock.token).select('id');
  if (r && r.error) o.logFn('lock_release_failed', { error: r.error.message });
}

/*
 * 죽은 실행이 남긴 running run 을 내린다.
 *
 * 이게 없으면 «running 은 전체에서 하나» 인덱스(마이그레이션)가 영원히 막힌다.
 * 잠금을 쥔 뒤에만 부른다 — 살아 있는 남의 run 을 내리지 않기 위해서다.
 */
async function reclaimStaleRuns(db, opts) {
  const o = withDefaults(opts);
  const cutoff = new Date(o.now() - o.lockTtlMs).toISOString();
  const r = await db.from('identity_shadow_runs')
    .update({
      status: 'failed', error_reason: 'stale_running_reclaimed',
      finished_at: new Date(o.now()).toISOString(), updated_at: new Date(o.now()).toISOString()
    })
    .eq('status', 'running').lt('started_at', cutoff).select('id');
  if (r && r.error) { o.logFn('reclaim_failed', { error: r.error.message }); return 0; }
  const n = ((r && r.data) || []).length;
  if (n) o.logFn('reclaimed_stale_runs', { count: n });
  return n;
}

/* ── 운영 데이터 읽기 (SELECT 만) ────────────────────────────────────── */

async function loadOffers(db, opts) {
  const o = withDefaults(opts);
  const rows = [];
  let after = 0;
  let snapshotAt = null;
  for (;;) {
    let q = db.from('products')
      .select('id, product_id, mall, mall_label, title, lprice, vendor_item_id, collected_at')
      .gt('id', after).order('id', { ascending: true }).limit(o.pageSize);
    if (o.malls.length === 1) q = q.eq('mall', o.malls[0]);
    else if (o.malls.length > 1) q = q.in('mall', o.malls);

    const r = await withDbRetry(() => q, { onRetry: (info, n) => o.logFn('products_read_retry', { attempt: n, kind: info.kind }) });
    if (r.error) throw new Error(`products 읽기 실패: ${r.error.message}`);
    const data = r.data || [];
    if (!data.length) break;
    data.forEach(row => {
      if (row.collected_at && (!snapshotAt || row.collected_at > snapshotAt)) snapshotAt = row.collected_at;
    });
    rows.push(...data);
    after = data[data.length - 1].id;
    if (o.limit && rows.length >= o.limit) break;
    if (data.length < o.pageSize) break;
  }
  const sliced = o.limit ? rows.slice(0, o.limit) : rows;
  return {
    sourceProductCount: sliced.length,
    snapshotAt,
    offers: sliced.map(r => ({
      // 짧고 안정적인 키. products 의 logical key 와 1:1 이다.
      key: `${r.mall}|${r.product_id}`,
      title: r.title,
      // 화면 표시 이름이 다르면 다른 판매처다 (ADPICK/SSG ≠ ADPICK/롯데홈쇼핑).
      mall: r.mall_label ? `${r.mall}/${r.mall_label}` : r.mall,
      // products 의 실제 열 값을 그대로 보존한다 (shadow 행이 products 를 가리켜야 하므로).
      productId: r.product_id,
      vendorItemId: r.vendor_item_id || '',
      price: r.lprice
    }))
  };
}

/* ── 쌍 판정 전수 조사 ───────────────────────────────────────────────
 *
 * clusterOffers 는 «몇 번 비교했나» 만 돌려준다. run 통계의 MATCH/REVIEW/NO_MATCH
 * 수와 REVIEW 행의 근거(confidence·evidence·conflicts)는 쌍 판정 자체가 있어야 한다.
 * 그래서 같은 블록 키 안의 후보 쌍을 다시 판정한다 — 판정기는 Phase 1 것 그대로이고,
 * 문맥(lineDimensions)도 clusterOffers 가 쓰는 contextFactory 로 똑같이 만든다.
 * 그러지 않으면 여기 숫자와 군집 결과가 어긋난다.
 */
function censusPairs(ids, opts) {
  const o = withDefaults(opts);
  const pairContext = OI.contextFactory(ids);
  const blocks = new Map();
  ids.forEach(id => OI.blockKeys(id).forEach(k => {
    if (!blocks.has(k)) blocks.set(k, []);
    blocks.get(k).push(id);
  }));

  const seen = new Set();
  const census = { match: 0, review: 0, noMatch: 0, comparisons: 0, skippedBlocks: 0, capped: false };
  const results = new Map();
  const reviewPairs = [];

  blocks.forEach(list => {
    if (list.length > o.censusMaxBlock) { census.skippedBlocks++; census.capped = true; return; }
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [a, b] = list[i].key < list[j].key ? [list[i], list[j]] : [list[j], list[i]];
        const id = `${a.key}\u0000${b.key}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const r = OI.matchOffers(a, b, pairContext(a, b));
        census.comparisons++;
        results.set(id, r);
        if (r.decision === OI.DECISION.MATCH) census.match++;
        else if (r.decision === OI.DECISION.REVIEW) { census.review++; reviewPairs.push({ a, b, result: r }); }
        else census.noMatch++;
      }
    }
  });

  return { census, results, reviewPairs, pairContext };
}

/* ── shadow 저장 ─────────────────────────────────────────────────────
 *
 * 묶음 INSERT. 한 묶음이라도 실패하면 호출부가 run 을 partial/failed 로 끝낸다.
 */
async function insertBatches(db, table, rows, opts) {
  const o = withDefaults(opts);
  let written = 0;
  const back = [];
  for (let i = 0; i < rows.length; i += o.batchSize) {
    const chunk = rows.slice(i, i + o.batchSize);
    const r = await withDbRetry(() => db.from(table).insert(chunk).select('id'), {
      onRetry: (info, n) => o.logFn('insert_retry', { table, attempt: n, kind: info.kind })
    });
    if (r.error) {
      const info = classifyDbError(r.error);
      throw Object.assign(new Error(`${table} 저장 실패(${info.kind}): ${r.error.message}`), { written, table });
    }
    back.push(...(r.data || []));
    written += chunk.length;
    o.logFn('batch_written', { table, written, total: rows.length });
  }
  return back;
}

/* ── 본체 ───────────────────────────────────────────────────────────── */

async function run(db, opts) {
  const o = withDefaults(opts);
  const log = o.logFn;
  const startedMs = o.now();

  const lock = await acquireLock(db, o);
  if (lock.result === LOCK.SKIP) { log('skipped', { reason: lock.reason }); return { skipped: true, reason: lock.reason }; }
  if (lock.result === LOCK.FAIL) { log('lock_failed', { reason: lock.reason }); return { failed: true, reason: lock.reason }; }

  let runId = null;
  let storedGroups = 0;
  try {
    if (!o.dryRun) await reclaimStaleRuns(db, o);

    /* 1. 운영 데이터 읽기 */
    const loaded = await loadOffers(db, o);
    log('products_loaded', { count: loaded.sourceProductCount, snapshotAt: loaded.snapshotAt });

    /* 2. run 행 (dry-run 은 만들지 않는다) */
    const scope = {
      dryRun: o.dryRun, limit: o.limit || null, malls: o.malls,
      batchSize: o.batchSize, censusMaxBlock: o.censusMaxBlock
    };
    if (!o.dryRun) {
      const ins = await db.from('identity_shadow_runs').insert({
        status: 'running', matcher_id: SH.MATCHER_ID, matcher_version: o.matcherVersion || matcherVersion(),
        source_snapshot_at: loaded.snapshotAt, scope,
        source_product_count: loaded.sourceProductCount,
        started_at: new Date(startedMs).toISOString()
      }).select('id');
      if (ins.error) {
        if (isMissingTable(ins.error)) throw new Error('identity_shadow_runs 표가 없습니다 (supabase/2026-10-13-identity-shadow.sql)');
        throw new Error(`run 생성 실패: ${ins.error.message}`);
      }
      runId = ins.data && ins.data[0] && ins.data[0].id;
      log('run_created', { runId });
    }

    /* 3. Phase 1 matcher — 여기서 식별을 다시 구현하지 않는다 */
    let parseFailed = 0;
    const ids = [];
    loaded.offers.forEach(x => {
      try { ids.push(OI.parseOffer(x)); } catch (e) { parseFailed++; }
    });
    const clustered = OI.clusterOffers(ids);
    const offersByKey = new Map(ids.map(id => [id.key, id]));
    const { census, results, reviewPairs } = censusPairs(ids, o);
    const pairDecision = (a, b) => results.get(a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

    /* 4. 저장 «전» 검증 — 깨지면 아무것도 쓰지 않는다 */
    const verdict = SH.validateShadowResult({
      groups: clustered.groups, offersByKey,
      reviewPairs: reviewPairs.map(p => [p.a.key, p.b.key])
    });
    log('validated', { ok: verdict.ok, violations: verdict.violations.length, checkedPairs: verdict.checkedPairs });

    const stats = SH.summarize({
      offers: ids, offersByKey, groups: clustered.groups, census,
      clusterStats: clustered.stats, parseFailed, violations: verdict.violations,
      sourceProductCount: loaded.sourceProductCount, durationMs: o.now() - startedMs
    });

    if (!verdict.ok) {
      verdict.violations.slice(0, 5).forEach(v => log('invariant_violation', v));
      if (!o.dryRun && runId) {
        await db.from('identity_shadow_runs').update(Object.assign({}, stats, {
          status: 'failed', error_reason: `invariant_violation:${verdict.violations[0].kind}`,
          finished_at: new Date(o.now()).toISOString(), updated_at: new Date(o.now()).toISOString()
        })).eq('id', runId);
      }
      await releaseLock(db, lock, runId, { status: 'failed', violations: verdict.violations.length }, o);
      return { failed: true, reason: 'invariant_violation', violations: verdict.violations, stats, runId };
    }

    const groupRows = SH.buildGroupRows({ groups: clustered.groups, offersByKey, pairDecision });
    const reviewRows = SH.buildReviewRows(reviewPairs);
    const sample = o.sample ? buildSample(groupRows, offersByKey, o.sample) : null;

    /* 5. dry-run 은 여기서 끝 — 쓰기 경로를 타지 않는다 */
    if (o.dryRun) {
      log('dry_run_complete', Object.assign({ groups: groupRows.length, reviews: reviewRows.length }, stats));
      emitSample(sample, o);
      return { dryRun: true, stats, groups: groupRows.length, reviews: reviewRows.length, members: groupRows.reduce((n, g) => n + g._members.length, 0), sample };
    }

    /* 6. 저장 — groups → members → reviews */
    const inserted = await insertBatches(db, 'identity_shadow_groups',
      groupRows.map(g => Object.assign({ run_id: runId }, stripInternal(g))), o);
    storedGroups = inserted.length;
    if (inserted.length !== groupRows.length) throw new Error(`group 저장 수 불일치 (${inserted.length}/${groupRows.length})`);

    const memberRows = [];
    groupRows.forEach((g, i) => g._members.forEach(m => memberRows.push(Object.assign({ run_id: runId, group_id: inserted[i].id }, m))));
    await insertBatches(db, 'identity_shadow_group_members', memberRows, o);
    if (reviewRows.length) await insertBatches(db, 'identity_shadow_reviews', reviewRows.map(r => Object.assign({ run_id: runId }, r)), o);

    /* 7. completed 는 전부 저장한 뒤에만 */
    const done = await db.from('identity_shadow_runs').update(Object.assign({}, stats, {
      status: 'completed', stored_group_count: storedGroups,
      finished_at: new Date(o.now()).toISOString(), updated_at: new Date(o.now()).toISOString(),
      duration_ms: Math.max(0, o.now() - startedMs)
    })).eq('id', runId).select('id');
    if (done.error) throw new Error(`run 완료 기록 실패: ${done.error.message}`);

    log('completed', { runId, groups: groupRows.length, members: memberRows.length, reviews: reviewRows.length, durationMs: o.now() - startedMs });
    emitSample(sample, o);
    await releaseLock(db, lock, runId, { status: 'completed', groups: groupRows.length }, o);
    return { runId, stats, groups: groupRows.length, members: memberRows.length, reviews: reviewRows.length, sample };
  } catch (e) {
    log('run_failed', { error: e.message, runId, storedGroups });
    if (!o.dryRun && runId) {
      /*
       * 일부라도 썼으면 partial — 감사자가 «이 run 의 행은 불완전하다» 를 알아야 한다.
       * ★ 어떤 경로로도 completed 를 적지 않는다.
       */
      const status = storedGroups > 0 ? 'partial' : 'failed';
      try {
        await db.from('identity_shadow_runs').update({
          status, error_reason: String(e.message).slice(0, 500), stored_group_count: storedGroups,
          finished_at: new Date(o.now()).toISOString(), updated_at: new Date(o.now()).toISOString(),
          duration_ms: Math.max(0, o.now() - startedMs)
        }).eq('id', runId);
      } catch (e2) { log('status_write_failed', { error: e2.message }); }
    }
    await releaseLock(db, lock, runId, { status: 'failed', error: String(e.message).slice(0, 200) }, o);
    return { failed: true, reason: e.message, runId, storedGroups };
  }
}

function stripInternal(row) {
  const out = Object.assign({}, row);
  delete out._members;
  return out;
}

/** 사람이 볼 표본. 상품명이 들어가므로 파일/표준오류로만 내보낸다 (repo 에 넣지 않는다). */
function buildSample(groupRows, offersByKey, n) {
  return groupRows.slice(0, n).map(g => ({
    groupKey: g.group_key, tier: g.confidence_tier, merchants: g.merchant_count,
    canonicalIdentity: g.canonical_identity,
    members: g._members.map(m => {
      const id = offersByKey.get(m.offer_key) || {};
      return {
        mall: m.mall, productId: m.product_id, price: id.price, title: id.title,
        confidence: m.confidence, tier: m.tier, evidence: m.evidence
      };
    })
  }));
}

function emitSample(sample, opts) {
  const o = withDefaults(opts);
  if (!sample) return;
  if (o.sampleOut) {
    fs.writeFileSync(o.sampleOut, JSON.stringify(sample, null, 1));
    console.error(`표본 ${sample.length}건을 ${o.sampleOut} 에 썼다 (저장소에 넣지 않는다)`);
    return;
  }
  console.error(JSON.stringify(sample, null, 1));
}

/** opt-in 관문. 코드 merge 와 운영 활성화를 분리한다. */
function shadowEnabled(env) {
  const flag = String(((env || process.env).IDENTITY_SHADOW_ENABLED) || '').trim().toLowerCase();
  return flag === 'true' || flag === '1';
}

async function main() {
  // 관문을 보기 «전에» .env.local 을 읽는다 — 플래그를 거기 둔 운영자도 켤 수 있어야 한다.
  require('./_env.js');
  if (!shadowEnabled()) {
    defaultLog('disabled', { hint: 'IDENTITY_SHADOW_ENABLED=true 일 때만 동작합니다 (dry-run 포함)' });
    process.exit(0);
  }
  const supabase = require('../api/_supabase');
  const r = await run(supabase, parseArgs(process.argv.slice(2)));
  if (r && r.failed) process.exit(1);
}

if (require.main === module) {
  main().catch(e => { defaultLog('fatal', { error: e.message }); process.exit(1); });
}

module.exports = {
  run, acquireLock, releaseLock, reclaimStaleRuns, loadOffers, censusPairs,
  insertBatches, matcherVersion, buildSample, parseArgs, shadowEnabled,
  LOCK, LOCK_TTL_MS, DEFAULTS
};
