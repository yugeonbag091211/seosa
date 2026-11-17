'use strict';
/*
 * products.keyword 오염 진단 — 읽기 전용 (2026-11-15).
 *
 *   RO_DB_URL=<postgres 연결 문자열> node scripts/db-quality/classify-products.js [--out report.json] [--csv suspects.csv]
 *   node scripts/db-quality/classify-products.js --snapshot <catalog.jsonl>   (DB 없이 동결 스냅숏으로)
 *
 * - 세션을 시작하자마자 READ ONLY 로 고정하고(default_transaction_read_only=on), 그것을 확인한 뒤에만 읽는다.
 *   INSERT·UPDATE·DELETE 문은 이 파일에 없다. 연결 문자열은 출력하지 않는다.
 * - 판정은 검색·저장·홈 표시와 같은 관문(api/_product-gate.classifyStoredRow).
 *     mismatch  그 키워드의 상품이 아니다는 근거가 있다 (정정 후보)
 *     unknown   근거가 모자라다 (정정하지 않는다)
 *     match     그 키워드의 상품이다
 * - 옛 규칙(_shop.matchesKeyword: 토큰 하나만 맞으면 통과)과 나란히 센다 — 무엇이 새로 잡혔는지 보이게.
 * - 정정은 하지 않는다. 정정은 scripts/db-quality/quarantine-keywords.sql (승인 후, 가역).
 */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const OUT = arg('--out');
const CSV = arg('--csv');
const SNAPSHOT = arg('--snapshot');
const LIVE_DAYS = Number(arg('--live-days', 3));

const Gate = require('../../api/_product-gate');
const { matchesKeyword, keywordTokens } = require('../../api/_shop');

async function loadRows() {
  if (SNAPSHOT) {
    return fs.readFileSync(SNAPSHOT, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
      .map(r => ({ product_id: r.product_id, mall: r.mall, keyword: r.keyword, title: r.title, collected_at: r.collected_at }));
  }
  const url = process.env.RO_DB_URL;
  if (!url) throw new Error('RO_DB_URL 또는 --snapshot 이 필요합니다');
  const { Client } = require('pg');
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: true }, application_name: 'seosa-db-quality-ro' });
  await client.connect();
  try {
    await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    await client.query('SET default_transaction_read_only = on');
    await client.query("SET statement_timeout = '60s'");
    const ro = await client.query('SHOW default_transaction_read_only');
    if (ro.rows[0].default_transaction_read_only !== 'on') throw new Error('세션이 읽기 전용이 아닙니다 — 중단');
    const rows = [];
    let last = '';
    // keyset 페이지(1만 행) — 한 번에 큰 결과를 들고 오지 않는다.
    for (;;) {
      const r = await client.query(
        `select product_id, mall, keyword, title, collected_at, (product_id || '|' || mall) as k
           from products where (product_id || '|' || mall) > $1
          order by (product_id || '|' || mall) limit 10000`, [last]);
      if (!r.rows.length) break;
      rows.push(...r.rows);
      last = r.rows[r.rows.length - 1].k;
      if (r.rows.length < 10000) break;
    }
    return rows;
  } finally { await client.end(); }
}

(async () => {
  const t0 = Date.now();
  const rows = await loadRows();
  const now = Date.now();
  const live = r => r.collected_at && now - Date.parse(r.collected_at) <= LIVE_DAYS * 86400e3;
  const summary = { rows: rows.length, withKeyword: 0, verdict: { match: 0, unknown: 0, mismatch: 0 },
    oldRuleMismatch: 0, newOnlyMismatch: 0, liveMismatch: 0, byReason: {}, byMall: {}, topKeywords: [] };
  const perKeyword = new Map();
  const suspects = [];
  for (const r of rows) {
    if (!r.keyword) continue;
    summary.withKeyword++;
    const v = Gate.classifyStoredRow(r.keyword, r.title || '');
    summary.verdict[v.verdict]++;
    const oldMiss = !matchesKeyword(keywordTokens(r.keyword), r.title);
    if (oldMiss) summary.oldRuleMismatch++;
    const k = perKeyword.get(r.keyword) || { keyword: r.keyword, rows: 0, mismatch: 0, live: 0 };
    k.rows++;
    if (v.verdict === 'mismatch') {
      if (!oldMiss) summary.newOnlyMismatch++;
      const reason = String(v.reasons[0] || '').split(':')[0];
      summary.byReason[reason] = (summary.byReason[reason] || 0) + 1;
      summary.byMall[r.mall] = (summary.byMall[r.mall] || 0) + 1;
      k.mismatch++;
      if (live(r)) { summary.liveMismatch++; k.live++; }
      suspects.push({ product_id: r.product_id, mall: r.mall, keyword: r.keyword, title: r.title, reason: v.reasons.slice(0, 3).join('|'), live: live(r) });
    }
    perKeyword.set(r.keyword, k);
  }
  summary.mismatchRate = summary.withKeyword ? Math.round(summary.verdict.mismatch / summary.withKeyword * 10000) / 100 : 0;
  summary.topKeywords = [...perKeyword.values()].filter(k => k.mismatch).sort((a, b) => b.mismatch - a.mismatch).slice(0, 30)
    .map(k => ({ ...k, rate: Math.round(k.mismatch / k.rows * 1000) / 10 }));
  summary.ms = Date.now() - t0;
  console.log(JSON.stringify(summary, null, 1));
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ summary, sample: suspects.slice(0, 500) }, null, 1));
  if (CSV) {
    const esc = s => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
    fs.writeFileSync(CSV, ['product_id,mall,keyword,title,reason,live'].concat(
      suspects.map(s => [s.product_id, s.mall, s.keyword, s.title, s.reason, s.live].map(esc).join(','))).join('\n'));
  }
})().catch(e => { console.error('DB_QUALITY_FAIL', e.message); process.exitCode = 1; });
