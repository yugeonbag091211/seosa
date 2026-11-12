'use strict';
// Runs the Promptfoo evaluation with privacy switches forced on and the
// network guard preloaded, then cross-tabulates both judges per provider.
//   node tools/ai-eval/run-eval.js --config promptfooconfig.offline.yaml --out <result.json>
// env: SEOSA_EVAL_SNAPSHOT (required), SEOSA_EVAL_PGLITE, SEOSA_EVAL_V33_ROOT, SEOSA_EVAL_IDS
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function arg(name, fallback) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; }
const config = arg('--config', 'promptfooconfig.offline.yaml');
const out = path.resolve(arg('--out', path.join(os.tmpdir(), 'seosa-promptfoo-result.json')));
const guardReport = out.replace(/\.json$/, '') + '.network-guard.json';
const offline = !/preview/i.test(config);
// The CI fixture config brings its own committed corpus and question set.
if (/fixture/i.test(config)) { process.env.SEOSA_EVAL_SNAPSHOT = path.join(__dirname, 'fixtures', 'catalog-fixture.jsonl'); process.env.SEOSA_EVAL_SET = 'fixture'; }
if (!process.env.SEOSA_EVAL_SNAPSHOT && offline) { console.error('SEOSA_EVAL_SNAPSHOT is required'); process.exit(1); }
try { fs.unlinkSync(guardReport); } catch {}
const env = {
  ...process.env,
  PROMPTFOO_DISABLE_TELEMETRY: '1', PROMPTFOO_DISABLE_UPDATE: '1', PROMPTFOO_DISABLE_SHARING: '1',
  PROMPTFOO_DISABLE_REMOTE_GENERATION: 'true', PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION: 'true',
  PROMPTFOO_DISABLE_SHARE_EMAIL_REQUEST: '1',
  PROMPTFOO_CONFIG_DIR: path.join(os.tmpdir(), 'seosa-promptfoo-config'),
  SEOSA_GUARD_REPORT: guardReport,
  NODE_OPTIONS: ((process.env.NODE_OPTIONS || '') + (offline ? ' --require ' + JSON.stringify(path.join(__dirname, 'network-guard.cjs')) : '')).trim()
};
const bin = path.join(__dirname, 'node_modules', 'promptfoo', 'dist', 'src', 'main.js');
const t0 = Date.now();
const r = spawnSync(process.execPath, [bin, 'eval', '-c', config, '--no-share', '--no-cache', '--no-write', '--no-table', '-j', '1', '-o', out],
  { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const elapsedMs = Date.now() - t0;
let guard = { blocked: [] };
try { guard = JSON.parse(fs.readFileSync(guardReport, 'utf8')); } catch {}
if (!fs.existsSync(out)) {
  console.error((r.stderr || '').slice(-3000)); console.error((r.stdout || '').slice(-2000));
  console.error('promptfoo produced no output (exit ' + r.status + ')'); process.exit(1);
}
const result = JSON.parse(fs.readFileSync(out, 'utf8'));
const rows = (result.results && (result.results.results || result.results)) || [];
const table = {};
for (const row of rows) {
  const provider = (row.provider && (row.provider.label || row.provider.id)) || 'unknown';
  const comps = (row.gradingResult && row.gradingResult.componentResults) || [];
  const verdictOf = prefix => { const c = comps.find(x => String(x.reason || '').startsWith(prefix + ' ')); return c ? String(c.reason).split(' ')[1].replace(/:$/, '') : 'ERROR'; };
  const a = verdictOf('v34'), b = verdictOf('v2');
  const final = a === b ? a : 'NEEDS_REVIEW';
  const t = table[provider] = table[provider] || { total: 0, PASS: 0, FAIL: 0, UNVERIFIED: 0, NEEDS_REVIEW: 0, ERROR: 0, agree: 0, latencyMs: [] };
  t.total++; t[final] = (t[final] || 0) + 1; if (a === b) t.agree++;
  if (Number.isFinite(row.latencyMs)) t.latencyMs.push(row.latencyMs);
}
for (const t of Object.values(table)) {
  const l = t.latencyMs.sort((x, y) => x - y);
  t.PASS_ONLY = Math.round(t.PASS / Math.max(1, t.total) * 1000) / 10;
  t.p50Ms = l[Math.floor(l.length * 0.5)] || null; t.p95Ms = l[Math.min(l.length - 1, Math.ceil(l.length * 0.95) - 1)] || null;
  delete t.latencyMs;
}
// Promptfoo 0.125.1 sends ONE «telemetry disabled» event to r.promptfoo.app
// even with PROMPTFOO_DISABLE_TELEMETRY=1 (telemetry-*.js recordTelemetryDisabled);
// no switch stops it, so the guard blocks it. Anything else would mean the
// offline run tried to reach a model/seller API.
const PROMPTFOO_TELEMETRY = /^(?:https:\/\/)?(?:r\.promptfoo\.app|a\.promptfoo\.app|api\.promptfoo\.dev|us\.i\.posthog\.com)\b/i;
const blockedHosts = [...new Set(guard.blocked)];
const summary = { config, promptfooExit: r.status, elapsedMs, networkBlockedAttempts: guard.blocked.length,
  blockedHosts: blockedHosts.slice(0, 10), nonTelemetryAttempts: blockedHosts.filter(h => !PROMPTFOO_TELEMETRY.test(h)),
  egress: 'none (all non-loopback connections refused by network-guard.cjs)', byProvider: table };
fs.writeFileSync(out.replace(/\.json$/, '') + '.summary.json', JSON.stringify(summary, null, 1) + '\n');
console.log(JSON.stringify(summary));
