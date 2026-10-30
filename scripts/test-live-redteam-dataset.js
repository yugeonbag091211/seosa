'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { COMPOSITE_EXPECTATIONS } = require('./_live-redteam-dataset');

// Listing scenarios is offline and must work in CI without a provider secret.
const output = execFileSync(process.execPath, [
  path.join(__dirname, 'live-redteam-codex.js'), '--list', '--round', 'all'
], {
  encoding: 'utf8',
  env: { ...process.env, OPENAI_API_KEY: 'list-only-test-key' },
  timeout: 15000
});
const listing = JSON.parse(output.trim());

assert.equal(listing.round, 'all');
assert.equal(listing.scenarios, 825, 'all means every generated live red-team scenario');
assert.equal(listing.multiTurnScenarios, 50, 'the full set includes long-context conversations');
assert.equal(listing.repeatCandidates, 50, 'the full set includes repeated stability cases');
assert.equal(listing.families['direct-injection-authority'], 85);
assert.equal(listing.families['grounding-hallucination'], 65);
assert.equal(listing.families['stability-3x'], 150);
assert.deepEqual(COMPOSITE_EXPECTATIONS.map(x => x.expectedIdentity || null), [
  'iPhone 17 Pro', 'MX Master 3S', 'Galaxy S26+', 'AirPods Pro 3', 'Dyson V15 Detect',
  'Galaxy Buds3', 'iPhone 17 Pro', null, 'MX Master 3S', null
], 'compound scenarios must be scored against the model requested by each query');
assert.equal(COMPOSITE_EXPECTATIONS[7].expectedNoProducts, true,
  'a 14-inch LG laptop under 1m cannot be satisfied by the 15-inch 1.39m fixture');
assert.equal(COMPOSITE_EXPECTATIONS[9].expectedNoProducts, true,
  'a follow-up without conversation context must not invent a target product');

// The paid harness must never treat a typo or help request as consent to run a
// live model evaluation. Keep a tiny preflight budget in this regression so
// even the buggy behavior cannot send a provider request.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seosa-live-redteam-cli-'));
try {
  for (const args of [['--help'], []]) {
    const reportPath = path.join(tempDir, `report-${args.length}.json`);
    const eventsPath = path.join(tempDir, `events-${args.length}.jsonl`);
    const cliOutput = execFileSync(process.execPath, [
      path.join(__dirname, 'live-redteam-codex.js'), ...args,
      '--report', reportPath
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        OPENAI_API_KEY: 'cli-help-test-key',
        LIVE_REDTEAM_MAX_USD: '0.000000001',
        LIVE_REDTEAM_EVENTS_PATH: eventsPath
      },
      timeout: 20000,
      maxBuffer: 8 * 1024 * 1024
    });
    assert.match(cliOutput, /Usage:/, `${args[0] || 'no args'} prints usage`);
    assert.doesNotMatch(cliOutput, /live-redteam-start|live-redteam-complete/,
      `${args[0] || 'no args'} does not start an evaluation`);
    assert.equal(fs.existsSync(reportPath), false, 'non-run CLI invocation writes no report');
    assert.equal(fs.existsSync(eventsPath), false, 'non-run CLI invocation writes no provider events');
  }
  const uncappedReportPath = path.join(tempDir, 'uncapped-report.json');
  const uncappedEventsPath = path.join(tempDir, 'uncapped-events.jsonl');
  const { OPENAI_API_KEY: _unusedKey, LIVE_REDTEAM_MAX_USD: _unusedBudget, ...safeEnv } = process.env;
  const uncapped = spawnSync(process.execPath, [
    path.join(__dirname, 'live-redteam-codex.js'), '--run', '--limit', '1',
    '--report', uncappedReportPath
  ], {
    encoding: 'utf8',
    env: { ...safeEnv, OPENAI_API_KEY: 'cli-cap-test-key', LIVE_REDTEAM_EVENTS_PATH: uncappedEventsPath },
    timeout: 10000,
    maxBuffer: 1024 * 1024
  });
  assert.equal(uncapped.status, 1, 'live run without a spend cap is rejected');
  assert.match(uncapped.stderr, /LIVE_REDTEAM_MAX_USD/, 'missing spend cap explains the failure');
  assert.doesNotMatch(uncapped.stdout, /live-redteam-start/, 'uncapped run never starts scenarios');
  assert.equal(fs.existsSync(uncappedReportPath), false, 'uncapped run writes no report');
  assert.equal(fs.existsSync(uncappedEventsPath), false, 'uncapped run sends no provider request');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('PASS live red-team all-scenario listing: 825 scenarios across every round');
