#!/usr/bin/env node
'use strict';
/*
 * 확정 전환 적재기 — 파트너 전환 리포트 → conversions.
 *
 * ── 이 스크립트가 존재하는 이유 ────────────────────────────────────
 *
 * conversions 는 «샀다» 를 담는 표이고, 그 값의 출처는 파트너의 전환
 * 리포트뿐이다. 클릭에서 추정하지 않는다. 그 규칙을 코드로 강제하려면
 * conversions 에 쓰는 경로가 «여기 하나» 여야 한다 — api/_funnel.js 에
 * conversions 쓰기 코드가 없는 것과 짝이다.
 *
 * ── 사용법 ─────────────────────────────────────────────────────────
 *
 *   node scripts/import-conversions.js --provider=adpick --dry-run
 *   node scripts/import-conversions.js --provider=coupang --dry-run
 *   node scripts/import-conversions.js --provider=adpick --days=30 --write
 *
 * ★ 기본이 dry-run 이다. --write 를 «명시해야만» DB 에 쓴다.
 *   전환 데이터는 회계 값이라, 실수로 쓰는 쪽보다 실수로 안 쓰는 쪽이 낫다.
 *
 * ── 멱등성 ─────────────────────────────────────────────────────────
 *
 * upsert onConflict: (source, external_id) — 2026-09-07-funnel.sql 이 만든
 * 기존 unique index 를 그대로 쓴다. 같은 전환을 몇 번 넣어도 행 수가 늘지
 * 않고, 상태만 최신으로 갱신된다(정상→확인중→확정→취소).
 *
 * ── 안전장치 ───────────────────────────────────────────────────────
 *
 *   · 키   URL 경로에 API 키가 들어가므로 모든 로그를 redact 한다
 *   · 격리 provider 하나가 실패해도 다른 provider 를 막지 않는다
 *   · 상한 페이지 수·조회 기간을 공식 계약 안으로 자른다
 *   · 미검증 provider 는 아예 돌지 않는다 (아래 PROVIDERS.verified)
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
for (const f of ['.env.local', '.env']) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) { require('dotenv').config({ path: p }); break; }
}

const C = require('../api/_conversion');
const AC = require('../api/_adpickconv');

/* ── 인자 ──────────────────────────────────────────────────────────── */

function arg(name, fallback) {
  const hit = process.argv.find(a => a.indexOf('--' + name + '=') === 0);
  if (hit) return hit.slice(name.length + 3);
  return process.argv.indexOf('--' + name) > -1 ? true : fallback;
}
const PROVIDER = String(arg('provider', 'adpick')).toLowerCase();
const DAYS = parseInt(arg('days', '7'), 10) || 7;
/** ★ --write 가 없으면 무조건 dry-run 이다. */
const WRITE = arg('write', false) === true && arg('dry-run', false) !== true;

function log(msg, extra) {
  const line = { t: new Date().toISOString(), msg: msg };
  if (extra) Object.assign(line, extra);
  // 어떤 경로로 들어온 문자열이든 키가 섞일 수 있다 — 출력 직전에 한 번 더 지운다.
  console.log(AC.redact(JSON.stringify(line)));
}

/* ── provider 등록부 ───────────────────────────────────────────────
 *
 * verified 가 false 면 importer 를 돌리지 않는다. 계약을 확인하지 못한
 * provider 에서 «추측한 필드» 로 회계 값을 만드는 것보다 미구현이 낫다.
 */
const PROVIDERS = {
  adpick: {
    id: 'adpick',
    source: 'adpick-report',
    verified: true,
    note: '공식 계약 확인 + 2026-09-07 엔드포인트 probe(403 whitelist) 로 존재 확인',
    hasCredential: () => AC.hasKey(),
    fetch: (days) => AC.fetchConversions({ days: days }),
    normalize: (row) => C.fromAdpick(row)
  },
  coupang: {
    id: 'coupang',
    source: 'coupang-report',
    /*
     * ★ NOT VERIFIED.
     *
     * 2026-09-07 read-only probe (리포트당 1회):
     *   orders     HTTP 200 rCode 0 — data 0건이라 «행의 모양» 을 못 봤다
     *   clicks     HTTP 200 rCode 0 — date/trackingCode/subId/addtag/ctag/click
     *   commission HTTP 200 rCode 0 — date/trackingCode/subId/commission/click
     *   cancel     HTTP 404
     *
     * clicks·commission 은 «날짜별 집계» 라 주문 식별자도 결제 금액도 없다.
     * 그것을 conversions 로 넣으면 external_id 를 지어내야 하고, 금액도
     * 없으니 GMV 를 만들 수 없다. orders 의 필드와 cancel 경로가 확인될
     * 때까지 이 provider 는 돌지 않는다.
     */
    verified: false,
    note: 'COUPANG_CONVERSION = NOT VERIFIED — orders 필드 shape 미확인, cancel 경로 404',
    hasCredential: () => !!(process.env.COUPANG_ACCESS_KEY && process.env.COUPANG_SECRET_KEY),
    fetch: null,
    normalize: null
  }
};

/* ── 적재 ──────────────────────────────────────────────────────────── */

async function upsert(rows) {
  const supabase = require('../api/_supabase');
  let ok = 0, failed = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const slice = rows.slice(i, i + 200);
    /*
     * onConflict 는 기존 unique index (source, external_id) 다.
     * 같은 전환을 다시 넣으면 행이 늘지 않고 status·금액만 갱신된다 —
     * 확정/취소가 나중에 오는 구조라 «갱신» 이 정상 동작이다.
     */
    const { error } = await supabase.from('conversions')
      .upsert(slice, { onConflict: 'source,external_id' });
    if (error) { failed += slice.length; log('upsert_failed', { n: slice.length, error: error.message }); }
    else ok += slice.length;
  }
  return { ok: ok, failed: failed };
}

async function run(provider) {
  const p = PROVIDERS[provider];
  if (!p) { log('unknown_provider', { provider: provider }); return { ok: false }; }

  if (!p.verified) {
    log('provider_not_verified', { provider: p.id, note: p.note });
    return { ok: false, skipped: 'not-verified' };
  }
  if (!p.hasCredential()) {
    log('no_credential', { provider: p.id });
    return { ok: false, skipped: 'no-credential' };
  }

  const res = await p.fetch(DAYS);
  log('fetched', {
    provider: p.id, range: res.range, pages: res.pages,
    rows: res.rows.length, errors: res.errors.length, whitelist: res.whitelist
  });
  res.errors.forEach(e => log('fetch_error', { provider: p.id, page: e.page, status: e.status, reason: e.reason }));

  if (res.whitelist) {
    /*
     * IP whitelist 거부. 현재 실행 환경(로컬/Actions/Vercel)은 출구 IP 가
     * 고정되지 않아 이 조건을 안정적으로 만족하지 못한다. 자동 스케줄을
     * 켜면 매번 실패하고, 실패가 반복되면 아무도 안 본다.
     */
    log('AUTOMATION_BLOCKED_BY_STATIC_EGRESS', {
      provider: p.id,
      detail: '성과추적 API 는 IP whitelist 필수. 고정 출구 IP 가 확보될 때까지 자동 스케줄을 켜지 않는다.'
    });
    return { ok: false, blocked: 'whitelist' };
  }

  /* 정규화 — 실패한 행은 버리지 않고 이유별로 센다. */
  const rows = [], skipped = {};
  res.rows.forEach(raw => {
    const n = p.normalize(raw);
    if (n.ok) rows.push(n.row);
    else skipped[n.reason] = (skipped[n.reason] || 0) + 1;
  });

  const sum = C.summarize(rows);
  log('normalized', {
    provider: p.id, usable: rows.length, skipped: skipped,
    byStatus: sum.byStatus,
    orderedGmv: sum.orderedGmv, confirmedGmv: sum.confirmedGmv,
    cancelledGmv: sum.cancelledGmv, commissionRevenue: sum.commissionRevenue,
    withAttribution: rows.filter(r => r.sub_id).length,
    distinctExternalIds: new Set(rows.map(r => r.external_id)).size
  });

  if (!WRITE) {
    log('dry_run_no_write', { provider: p.id, wouldUpsert: rows.length });
    rows.slice(0, 5).forEach(r => log('sample', {
      external_id: r.external_id, status: r.status, partner_status: r.partner_status,
      gmv: r.gmv, commission: r.commission, order_date: r.order_date, sub_id: r.sub_id
    }));
    return { ok: true, dryRun: true, rows: rows.length };
  }

  const w = await upsert(rows);
  log('upserted', { provider: p.id, ok: w.ok, failed: w.failed });
  return { ok: w.failed === 0, written: w.ok };
}

async function main() {
  log('start', { provider: PROVIDER, days: DAYS, write: WRITE, idField: C.adpickIdField() });
  if (!WRITE) log('mode', { note: 'dry-run — DB 에 쓰지 않는다. 쓰려면 --write 를 명시할 것.' });
  try {
    const r = await run(PROVIDER);
    log('done', r);
    if (!r.ok && !r.dryRun) process.exitCode = 1;
  } catch (e) {
    log('failed', { error: AC.redact(e && e.message) });
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { PROVIDERS, run, upsert, _internal: { arg } };
