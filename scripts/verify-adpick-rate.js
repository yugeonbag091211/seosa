#!/usr/bin/env node
/*
 * ADPICK 호출률 운영 검증 — 읽기 전용 (adpick_api_calls 만 읽는다, 외부 호출 0회).
 *
 *   node scripts/verify-adpick-rate.js [--from ISO] [--to ISO]   (기본: 최근 24시간)
 *
 * 공식 한도 (ADPICK BIZ API 가이드, 2026-09-23 확인)
 *   상품 검색 분당 10회 / 성과 조회 분당 60회 / 모든 기능 합 분당 60회 — API 키 기준
 *
 * 내는 값
 *   · 소스별·전체 «임의의 연속 60초(양 끝 포함)» 최대 호출 수 — api/_adpicklimit.rollingStats 와 같은 정의
 *   · 연속 호출 최소 간격
 *   · 429/403 각각의 직전 60초 호출 수 (분당 초과가 원인인지 가린다)
 * 수집기 상한(ADPICK_MAX_PER_MIN, workflow 5)·전역 상한(8)·공식 10 을 넘은 창이 있으면 exit 1.
 */
'use strict';

require('./_env');
const supabase = require('../api/_supabase');
const { rollingStats } = require('../api/_adpicklimit');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const to = arg('--to', new Date().toISOString());
const from = arg('--from', new Date(Date.parse(to) - 24 * 3600e3).toISOString());
const COLLECT_CAP = Number(process.env.ADPICK_MAX_PER_MIN_COLLECT) || 5;
const GLOBAL_CAP = 8;
const OFFICIAL_SEARCH = 10;

(async () => {
  const rows = [];
  let after = null, maxPage = 0;
  for (;;) {
    let q = supabase.from('adpick_api_calls')
      .select('id, called_at, source, operation, http_status, outcome, external_call')
      .gte('called_at', from).lte('called_at', to).eq('external_call', true)
      .order('id', { ascending: true }).limit(1000);
    if (after !== null) q = q.gt('id', after);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (!data.length) break;
    maxPage = Math.max(maxPage, data.length);
    if (data.length < maxPage) break;
    after = data[data.length - 1].id;
  }
  const t = r => Date.parse(r.called_at);
  const search = rows.filter(r => (r.operation || 'search') === 'search');
  console.log(`ADPICK 외부 호출 ${from} → ${to}: 전체 ${rows.length}회 (검색 ${search.length})`);
  const bySource = {};
  search.forEach(r => (bySource[r.source] = bySource[r.source] || []).push(t(r)));
  let bad = 0;
  Object.entries(bySource).sort().forEach(([s, ts]) => {
    const st = rollingStats(ts);
    const cap = s === 'collect' ? COLLECT_CAP : null;
    const over = cap != null && st.maxIn60s > cap;
    if (over) bad++;
    console.log(`  ${s.padEnd(18)} ${String(st.count).padStart(5)}회  60초 최대 ${st.maxIn60s}${cap != null ? ` (상한 ${cap})` : ''}`
      + `  최소 간격 ${st.minGapMs == null ? '-' : (st.minGapMs / 1000).toFixed(3) + 's'}${over ? '  ← 초과' : ''}`);
  });
  const all = rollingStats(search.map(t));
  const overGlobal = all.maxIn60s > GLOBAL_CAP, overOfficial = all.maxIn60s > OFFICIAL_SEARCH;
  if (overOfficial) bad++;
  console.log(`  ${'검색 전체'.padEnd(18)} ${String(all.count).padStart(5)}회  60초 최대 ${all.maxIn60s}`
    + ` (전역 ${GLOBAL_CAP} · 공식 ${OFFICIAL_SEARCH})${overOfficial ? '  ← 공식 한도 초과' : overGlobal ? '  ← 전역 상한 초과(전역 리미터 미적용?)' : ''}`);
  const allOps = rollingStats(rows.map(t));
  if (allOps.maxIn60s > 60) bad++;
  console.log(`  ${'모든 기능 합'.padEnd(18)} ${String(allOps.count).padStart(5)}회  60초 최대 ${allOps.maxIn60s} (공식 60)`);
  const errs = rows.filter(r => r.http_status === 429 || r.http_status === 403);
  console.log(`429/403 ${errs.length}건`);
  errs.forEach(e => {
    const w = search.filter(r => t(r) > t(e) - 60000 && t(r) <= t(e));
    console.log(`  ${e.called_at.slice(0, 19)} HTTP ${e.http_status} ${e.source} — 직전 60초 검색 ${w.length}회`);
  });
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('실패:', e.message); process.exit(2); });
