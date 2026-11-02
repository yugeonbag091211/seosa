#!/usr/bin/env node
'use strict';
/*
 * 서버 로그 수집 — «실제 GPT 호출·판매처 검색 성공 여부» 의 유일한 근거.
 *
 * 응답 x-vercel-id 끝부분이 Vercel 로그의 id 와 같다. responses.jsonl 에 있는 요청만 지표를 저장하고,
 * 다른 이용자의 /api/ai 요청은 수와 상태 코드만 센다(검색어·내용 저장 안 함).
 * vercel CLI 는 메인 체크아웃의 프로젝트 연결을 쓰고, 한글 PC 이름 때문에 hostname 을 ASCII 로 덮어쓴다.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const MAIN_CHECKOUT = process.env.SEOSA_MAIN_CHECKOUT || 'C:/Users/yugeo/seosa';
const NEON_PROJECT = 'withered-dew-45175008';

function hostnameShim() {
  const p = path.join(os.tmpdir(), 'seosa-qa-ascii-host.js');
  if (!fs.existsSync(p)) fs.writeFileSync(p, "require('os').hostname = () => 'seosa-qa';\n");
  return p;
}
function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, Object.assign({ maxBuffer: 256 * 1024 * 1024, timeout: 120000, shell: process.platform === 'win32' }, opts), (e, out, err) => {
      if (e && !out) reject(new Error(String(err || e.message).slice(0, 300))); else resolve(String(out));
    });
  });
}

function parseEntry(e) {
  const m = { id: e.id, ts: e.timestamp, status: e.responseStatusCode, deployment: e.deploymentId, level: e.level };
  const logs = Array.isArray(e.logs) ? e.logs : [];
  const out = { obs: null, adpick: [], coupang: [], warn: 0, grounding: 0, llmFail: 0, classifySkipped: false, dbErrors: 0, messages: [], kwSeen: [] };
  for (const l of logs) {
    const t = String(l.message || '');
    if (t.startsWith('[ai:obs] ')) {
      try { const o = JSON.parse(t.slice(9)); if (!out.obs || o.model !== undefined) out.obs = Object.assign(out.obs || {}, o); } catch (_) { /* 잘린 줄 */ }
    }
    const a = t.match(/^\[adpick\] source=(\S+) kw="([^"]*)" (\S+)(.*)/);
    if (a) { const kw = a[2]; a.splice(2, 1); out.kwSeen.push(kw); }
    if (a) out.adpick.push({ source: a[1], decision: a[2], http: (a[3].match(/http=(\d+)/) || [])[1] || null, items: Number((a[3].match(/items=(\d+)/) || [])[1] || 0), denied: Number((a[3].match(/denied=(\d+)/) || [])[1] || 0) });
    const c = t.match(/^\[coupang\] source=(\S+) kw="([^"]*)" (\S+)(.*)/);
    if (c) { const kw = c[2]; c.splice(2, 1); out.kwSeen.push(kw); }
    if (c) out.coupang.push({ source: c[1], decision: c[2], http: (c[3].match(/http=(\d+)/) || [])[1] || null, items: Number((c[3].match(/items=(\d+)/) || [])[1] || 0) });
    if (/grounding/.test(t)) out.grounding++;
    if (/LLM 분류 실패|모델 실패|llm .*실패|provider|timeout|타임아웃/i.test(t)) out.llmFail++;
    if (/정규식 분류로 확정/.test(t)) out.classifySkipped = true;
    if (/\[db\]|neon|supabase|connection|too many/i.test(t) && /(error|fail|실패|오류)/i.test(t)) out.dbErrors++;
    if (l.level === 'warn' || l.level === 'error') { out.warn++; if (out.messages.length < 8) out.messages.push(t.replace(/kw="[^"]*"/g, 'kw=…').slice(0, 300)); }
  }
  return Object.assign(m, out);
}

async function harvest(dir) {
  const R = path.join(dir, 'responses.jsonl');
  const L = path.join(dir, 'server-logs.jsonl');
  const O = path.join(dir, 'other-traffic.json');
  const mine = new Set();
  if (fs.existsSync(R)) for (const l of fs.readFileSync(R, 'utf8').split('\n')) {
    const m = l.match(/"requestId":"([^"]+)"/); if (m) mine.add(m[1]);
  }
  const have = new Set();
  if (fs.existsSync(L)) for (const l of fs.readFileSync(L, 'utf8').split('\n')) {
    const m = l.match(/"id":"([^"]+)"/); if (m) have.add(m[1]);
  }
  const env = Object.assign({}, process.env, { NODE_OPTIONS: `--require ${hostnameShim()}` });
  const out = await run('vercel', ['logs', '--environment', 'production', '--since', '15m', '--json', '--expand', '--limit', '2000', '--cwd', MAIN_CHECKOUT], { env });
  let added = 0, other = {};
  try { other = JSON.parse(fs.readFileSync(O, 'utf8')); } catch (_) { other = { seen: {}, ai: 0, byStatus: {}, sampledFrom: new Date().toISOString() }; }
  for (const line of out.split('\n')) {
    if (!line.startsWith('{')) continue;
    let e; try { e = JSON.parse(line); } catch (_) { continue; }
    if (e.requestPath !== '/api/ai') continue;
    if (mine.has(e.id)) {
      if (!have.has(e.id)) { fs.appendFileSync(L, JSON.stringify(parseEntry(e)) + '\n'); have.add(e.id); added++; }
    } else if (!other.seen[e.id]) {
      other.seen[e.id] = 1; other.ai++;
      const s = String(e.responseStatusCode); other.byStatus[s] = (other.byStatus[s] || 0) + 1;
    }
  }
  other.updatedAt = new Date().toISOString();
  fs.writeFileSync(O, JSON.stringify(other));
  return { added, mine: mine.size, have: have.size };
}

function readCost(dir) {
  const L = path.join(dir, 'server-logs.jsonl');
  let usd = 0, inTok = 0, outTok = 0, n = 0;
  if (fs.existsSync(L)) for (const l of fs.readFileSync(L, 'utf8').split('\n')) {
    if (!l) continue;
    try { const e = JSON.parse(l); if (e.obs) { usd += Number(e.obs.costUsd) || 0; inTok += Number(e.obs.inTok) || 0; outTok += Number(e.obs.outTok) || 0; n++; } } catch (_) { /* 무시 */ }
  }
  return { usd, inTok, outTok, n };
}

async function neonSnapshot(dir) {
  const out = await run('neon', ['projects', 'get', NEON_PROJECT, '--output', 'json']);
  const p = JSON.parse(out);
  const snap = { at: new Date().toISOString(), computeHours: +(p.compute_time_seconds / 3600).toFixed(2), activeHours: +(p.active_time_seconds / 3600).toFixed(2), transferGB: +(p.data_transfer_bytes / 1e9).toFixed(3) };
  fs.appendFileSync(path.join(dir, 'neon-usage.jsonl'), JSON.stringify(snap) + '\n');
  return snap;
}

module.exports = { harvest, readCost, neonSnapshot };
if (require.main === module) {
  const dir = path.resolve(__dirname, '../../reports/production-ai-5000');
  harvest(dir).then(r => { console.log(r, readCost(dir)); }).catch(e => { console.error(e.message); process.exit(1); });
}
