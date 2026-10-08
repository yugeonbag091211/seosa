#!/usr/bin/env node
'use strict';
/*
 * Multi-instance AI circuit Red Team. Every LLM instance has an independent VM
 * and local state; only FakeStore is shared. All provider and DB calls are fake.
 *
 * Run: node scripts/test-ai-global-circuit.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const LLM_PATH = path.join(ROOT, 'api', '_llm.js');
const LLM_SOURCE = fs.readFileSync(LLM_PATH, 'utf8');
const requireFromLlm = Module.createRequire(LLM_PATH);
const { createCircuit } = require('../api/_global-circuit');
const ORIGINAL_ENV = { GEMINI_API_KEY: 'fake-gemini', GROQ_API_KEY: 'fake-groq',
  OPENROUTER_API_KEY: 'fake-openrouter', AI_CACHE_TTL_MS: '0',
  OPENROUTER_MODELS: 'test/one:free,test/two:free,test/three:free' };
const GEMINI_A = 'gemini-2.5-flash-lite';
const GEMINI_B = 'gemini-2.5-flash';
let passes = 0;

function check(label, condition, detail = '') {
  assert.ok(condition, `${label}${detail ? ': ' + detail : ''}`);
  passes++;
  console.log(`PASS ${label}${detail ? ` (${detail})` : ''}`);
}

class FakeStore {
  constructor() {
    this.rows = new Map();
    this.reads = 0;
    this.failCalls = 0;
    this.successCalls = 0;
    this.writes = 0;
    this.mode = 'ok';
    this.nextToken = 1;
  }

  key(provider, model) { return `${provider}:${model}`; }
  row(provider, model) { return this.rows.get(this.key(provider, model)); }
  put(provider, model, row) { this.rows.set(this.key(provider, model), { ...row }); }
  resetMetrics() { this.reads = this.failCalls = this.successCalls = this.writes = 0; }

  async gate(provider, model, token) {
    this.reads++;
    if (this.mode === 'error') throw Error('fake database unavailable');
    if (this.mode === 'timeout') return new Promise(() => {});
    if (this.mode === 'malformed') return { allowed: 'perhaps', remainingMs: 'never' };
    if (this.mode === 'far-future') return { allowed: false,
      remainingMs: Number.MAX_SAFE_INTEGER, reason: 'rate' };
    const now = Date.now();
    for (const key of [this.key(provider, '*'), this.key(provider, model)]) {
      const row = this.rows.get(key);
      if (!row) continue;
      if (row.blockedUntil > now) {
        return { allowed: false, remainingMs: row.blockedUntil - now, reason: row.reason };
      }
      if (row.probeUntil > now) {
        return { allowed: false, remainingMs: row.probeUntil - now, reason: 'probe' };
      }
      // Expired OPEN: one atomic lease wins. No network call is required to
      // make this decision, so concurrent gate() calls are deterministic.
      const probeToken = token || `probe-${this.nextToken++}`;
      row.probeToken = probeToken;
      row.probeUntil = now + 10000;
      row.blockedUntil = 0;
      this.writes++;
      return { allowed: true, probeToken };
    }
    return { allowed: true };
  }

  async fail(provider, model, reason, ms, token) {
    this.failCalls++;
    if (this.mode === 'error') throw Error('fake database unavailable');
    if (this.mode === 'timeout') return new Promise(() => {});
    const scope = reason === 'auth' ? '*' : model;
    const key = this.key(provider, scope);
    const now = Date.now();
    const duration = Math.max(1, Math.min(30 * 60 * 1000, Number(ms) || 0));
    const candidate = now + duration;
    const row = this.rows.get(key);
    // A late result from an expired probe must not replace a newer probe.
    if (token && row && row.probeToken && row.probeToken !== token) return;
    // Debounce near-identical failures while allowing a materially longer
    // Retry-After to extend the block. Count physical row updates, not RPCs.
    if (row && row.blockedUntil >= candidate - 5000 && !row.probeToken) return;
    this.rows.set(key, { reason, blockedUntil: Math.max(candidate,
      row && Number(row.blockedUntil) || 0), probeUntil: 0, probeToken: '' });
    this.writes++;
  }

  async success(provider, model, token) {
    this.successCalls++;
    if (this.mode === 'error') throw Error('fake database unavailable');
    if (this.mode === 'timeout') return new Promise(() => {});
    if (!token) return;
    for (const key of [this.key(provider, '*'), this.key(provider, model)]) {
      const row = this.rows.get(key);
      if (row && row.probeToken === token) {
        this.rows.delete(key);
        this.writes++;
        return { closed: true };
      }
    }
  }
}

function noCircuit() {
  return { before: async () => ({ allowed: true }), failure: async () => {},
    success: async () => {}, stats: () => ({}), _reset: () => {} };
}

function providerOf(url) {
  if (String(url).includes('generativelanguage.googleapis.com')) return 'gemini';
  if (String(url).includes('api.groq.com')) return 'groq';
  if (String(url).includes('openrouter.ai')) return 'openrouter';
  throw Error(`unexpected provider URL: ${url}`);
}

function response(provider, mode) {
  const status = typeof mode === 'number' ? mode : mode && mode.status;
  if (status) return { ok: false, status,
    headers: { get: name => name.toLowerCase() === 'retry-after'
      ? String(mode && mode.retryAfter || '') : '' },
    text: async () => '{"error":"fake offline failure"}' };
  if (provider === 'gemini') return { ok: true, status: 200, json: async () => ({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'fake answer' }] } }]
  }) };
  return { ok: true, status: 200, json: async () => ({
    choices: [{ finish_reason: 'stop', message: { content: 'fake answer' } }]
  }) };
}

function makeInstance(id, store, calls, modes = {}, options = {}) {
  const circuit = options.disabled ? noCircuit() : createCircuit({ store });
  const mod = { exports: {} };
  const env = { ...ORIGINAL_ENV, ...options.env };
  if (!options.allProviders) {
    delete env.GROQ_API_KEY;
    delete env.OPENROUTER_API_KEY;
  }
  const localRequire = name => name === './_global-circuit' ? circuit : requireFromLlm(name);
  const sandbox = { module: mod, exports: mod.exports, require: localRequire,
    process: { env }, Date, AbortController, setTimeout, clearTimeout,
    console: { warn() {}, error() {} } };
  sandbox.fetch = async (url, request) => {
    const provider = providerOf(url);
    const body = JSON.parse(request.body);
    const model = provider === 'gemini' ? decodeURIComponent(String(url).match(/models\/([^:]+)/)[1])
      : body.model;
    calls.push({ instance: id, provider, model });
    const mode = typeof modes[provider] === 'function'
      ? modes[provider]({ instance: id, model }) : modes[provider];
    return response(provider, mode === undefined ? 'ok' : mode);
  };
  vm.runInNewContext(Module.wrap(LLM_SOURCE), sandbox, { filename: LLM_PATH })
    (mod.exports, localRequire, mod, LLM_PATH, path.dirname(LLM_PATH));
  return { llm: mod.exports, circuit };
}

function ask(instance, id, extra = {}) {
  return instance.llm.chat({ role: 'answer', messages: [{ role: 'user', content: id }],
    maxTokens: 50, temperature: 0, perCallMs: 1000, budgetMs: 15000, ...extra });
}

async function wave(count, usersEach, store, modes, options = {}) {
  const calls = [];
  const instances = Array.from({ length: count }, (_, i) =>
    makeInstance(`i${i}`, store, calls, modes, options));
  const results = await Promise.all(instances.flatMap((instance, i) =>
    Array.from({ length: usersEach }, (_, j) => ask(instance, `unique-${i}-${j}`))));
  return { calls, instances, results };
}

async function bounded(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`operation exceeded ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function run() {
  // Reproduce the old process-local failure with the same LLM source but an
  // intentionally disabled shared circuit. These are deterministic baselines.
  let s = new FakeStore();
  let r = await wave(10, 10, s, { gemini: 429 }, { disabled: true });
  check('before fix: 10 instances × 10 users cause 20 Gemini calls',
    r.calls.length === 20 && r.calls.every(c => c.provider === 'gemini'));
  r = await wave(50, 10, new FakeStore(), { gemini: 429, groq: 429, openrouter: 429 },
    { disabled: true, allProviders: true });
  check('before fix: 50 instances cause 500 all-provider calls', r.calls.length === 500,
    `Gemini ${r.calls.filter(c => c.provider === 'gemini').length}, Groq ${r.calls.filter(c => c.provider === 'groq').length}, OpenRouter ${r.calls.filter(c => c.provider === 'openrouter').length}`);

  // A detects an upstream failure, then a fresh instance B must read OPEN.
  for (const status of [429, 402]) {
    s = new FakeStore();
    const calls = [];
    const a = makeInstance('A', s, calls, { gemini: status });
    const b = makeInstance('B', s, calls, { gemini: status });
    await ask(a, `A-${status}`);
    await ask(b, `B-${status}`);
    check(`A ${status} makes B skip Gemini`, calls.length === 1 && s.reads >= 2);
  }
  s = new FakeStore();
  let calls = [];
  const authA = makeInstance('A', s, calls, { gemini: 401 },
    { env: { GEMINI_MODEL: GEMINI_A } });
  const authB = makeInstance('B', s, calls, { gemini: 401 },
    { env: { GEMINI_MODEL: GEMINI_B } });
  await ask(authA, 'auth-A'); await ask(authB, 'auth-B');
  check('401 opens provider-wide circuit across models', calls.length === 1
    && s.row('gemini', '*') && !s.row('gemini', GEMINI_A));

  s = new FakeStore();
  const scopedA = createCircuit({ store: s });
  const scopedB = createCircuit({ store: s });
  await scopedA.failure('gemini', GEMINI_A, 'rate', 60000);
  check('429 remains model-specific', !(await scopedB.before('gemini', GEMINI_A)).allowed
    && (await scopedB.before('gemini', GEMINI_B)).allowed);
  await scopedA.failure('groq', 'openai/gpt-oss-20b', 'auth', 60000);
  check('auth OPEN covers another provider model',
    !(await scopedB.before('groq', 'openai/gpt-oss-120b')).allowed);

  s = new FakeStore(); calls = [];
  const deletedModes = { openrouter: ({ model }) => model === 'test/one:free' ? 404 : 'ok' };
  const openrouterOnly = { allProviders: true, env: {
    GEMINI_API_KEY: '', GROQ_API_KEY: '', OPENROUTER_API_KEY: 'fake-openrouter' } };
  const deletedA = makeInstance('A', s, calls, deletedModes, openrouterOnly);
  const deletedB = makeInstance('B', s, calls, deletedModes, openrouterOnly);
  await ask(deletedA, 'deleted-A'); await ask(deletedB, 'deleted-B');
  check('404 deprecated OpenRouter model is skipped across instances',
    calls.filter(c => c.model === 'test/one:free').length === 1
    && calls.filter(c => c.model === 'test/two:free').length === 2);

  s = new FakeStore(); calls = [];
  const retryA = makeInstance('A', s, calls, { gemini: { status: 429, retryAfter: 600 } });
  const retryB = makeInstance('B', s, calls, { gemini: 429 });
  await ask(retryA, 'retry-A'); await ask(retryB, 'retry-B');
  check('Retry-After 600s is shared', calls.length === 1
    && s.row('gemini', GEMINI_A)?.blockedUntil - Date.now() >= 590000);

  s = new FakeStore();
  const c1 = createCircuit({ store: s });
  const c2 = createCircuit({ store: s });
  await c1.failure('gemini', GEMINI_A, 'quota', 15 * 60 * 1000);
  const longer = s.row('gemini', GEMINI_A).blockedUntil;
  await c2.failure('gemini', GEMINI_A, 'rate', 60 * 1000);
  check('short cooldown cannot overwrite longer cooldown',
    s.row('gemini', GEMINI_A).blockedUntil >= longer && s.writes === 1);

  // The shared guard is optional for availability: DB errors, timeouts, and
  // malformed responses must fall back to the existing local protection.
  for (const mode of ['error', 'timeout', 'malformed']) {
    s = new FakeStore(); s.mode = mode; calls = [];
    const inst = makeInstance(mode, s, calls, { gemini: 'ok' });
    const result = await bounded(ask(inst, `db-${mode}`), 2500);
    check(`DB ${mode} does not stop AI`, result.ok && calls.length === 1);
  }
  s = new FakeStore(); s.mode = 'timeout'; calls = [];
  const timedFailure = makeInstance('timeout-failure', s, calls, { gemini: 429 });
  const failedResult = await bounded(ask(timedFailure, 'timeout-on-failure'), 2500);
  await bounded(ask(timedFailure, 'timeout-local-retry'), 2500);
  check('DB timeout during 429 preserves local cooldown and terminates',
    !failedResult.ok && calls.length === 1);

  // One lease after OPEN expires. A failed/restarted probe must not strand the
  // provider, and an old success must not close a newer OPEN.
  s = new FakeStore();
  s.put('gemini', GEMINI_A, { reason: 'rate', blockedUntil: Date.now() - 1,
    probeUntil: 0, probeToken: '' });
  const probes = Array.from({ length: 10 }, () => createCircuit({ store: s }));
  const gates = await Promise.all(Array.from({ length: 100 }, (_, i) =>
    probes[i % 10].before('gemini', GEMINI_A)));
  const winners = gates.filter(g => g.allowed && g.probeToken);
  check('100 requests after expiry allow one half-open probe', winners.length === 1
    && gates.filter(g => !g.allowed).length === 99);
  await probes[0].success('gemini', GEMINI_A, winners[0].probeToken);
  check('successful probe closes circuit', (await createCircuit({ store: s })
    .before('gemini', GEMINI_A)).allowed === true && !s.row('gemini', GEMINI_A));

  // A corrupt distant timestamp must be capped locally. A past timestamp is
  // an expired OPEN and therefore enters half-open rather than staying stuck.
  s = new FakeStore(); s.mode = 'far-future';
  let fakeNow = Date.now();
  const capped = createCircuit({ store: s, now: () => fakeNow });
  const distant = await capped.before('gemini', GEMINI_A);
  fakeNow += 30 * 60 * 1000 + 1;
  s.mode = 'ok';
  const afterCap = await capped.before('gemini', GEMINI_A);
  check('far-future shared block is capped at 30 minutes',
    !distant.allowed && afterCap.allowed && s.reads === 2);
  s = new FakeStore();
  s.put('gemini', GEMINI_A, { reason: 'rate', blockedUntil: Date.now() - 1000,
    probeUntil: 0, probeToken: '' });
  const past = await createCircuit({ store: s }).before('gemini', GEMINI_A);
  check('past shared block admits one recovery probe', past.allowed && !!past.probeToken);

  s = new FakeStore();
  s.put('gemini', GEMINI_A, { reason: 'rate', blockedUntil: Date.now() - 1,
    probeUntil: 0, probeToken: '' });
  const old = createCircuit({ store: s });
  const fresh = createCircuit({ store: s });
  const oldGate = await old.before('gemini', GEMINI_A);
  s.row('gemini', GEMINI_A).probeUntil = Date.now() - 1;
  const newGate = await fresh.before('gemini', GEMINI_A);
  await fresh.failure('gemini', GEMINI_A, 'rate', 60000, newGate.probeToken);
  await old.success('gemini', GEMINI_A, oldGate.probeToken);
  check('stale probe success cannot close newer failure',
    !(await createCircuit({ store: s }).before('gemini', GEMINI_A)).allowed);

  // In the initial storm every instance may see CLOSED before the first 429.
  // The shared state must then stop fresh instances and collapse DB writes.
  s = new FakeStore();
  r = await wave(10, 10, s, { gemini: 429 });
  const first10 = r.calls.length;
  const writes10 = s.writes;
  const after10 = await wave(10, 1, s, { gemini: 429 });
  check('10-instance 429 storm has bounded first wave and zero next wave',
    first10 <= 20 && first10 > 0 && after10.calls.length === 0,
    `first=${first10}, writes=${writes10}`);
  check('10-instance failure race collapses physical DB writes', writes10 <= 2);

  s = new FakeStore();
  r = await wave(50, 10, s, { gemini: 429, groq: 429, openrouter: 429 },
    { allProviders: true });
  const first50 = r.calls.length;
  const writes50 = s.writes;
  const after50 = await wave(50, 1, s, { gemini: 429, groq: 429, openrouter: 429 },
    { allProviders: true });
  check('50-instance all-provider storm stops the next wave',
    first50 <= 500 && first50 > 0 && after50.calls.length === 0,
    `first=${first50}, writes=${writes50}`);
  check('50-instance failure race writes once per model', writes50 <= 5);
  check('all circuits OPEN terminate without provider calls',
    after50.results.every(x => !x.ok));

  s = new FakeStore();
  r = await wave(10, 100, s, { gemini: 429, groq: 429, openrouter: 429 },
    { allProviders: true });
  const failureCosts = { reads: s.reads, failRpcAttempts: s.failCalls,
    writes: s.writes, networkCalls: r.calls.length };
  check('1000 failed requests terminate with bounded DB writes',
    r.results.length === 1000 && r.results.every(x => !x.ok)
    && failureCosts.writes <= 5 && failureCosts.networkCalls <= 100,
    JSON.stringify(failureCosts));

  // Read amplification is reported explicitly. CLOSED reads once per provider
  // attempt; the test rejects multiple shared operations per healthy request.
  s = new FakeStore(); calls = [];
  const healthy = makeInstance('healthy', s, calls, { gemini: 'ok' });
  for (let i = 0; i < 1000; i++) {
    const answer = await ask(healthy, `healthy-${i}`);
    if (!answer.ok) throw Error(`healthy request ${i} failed`);
  }
  check('1000 healthy requests produce zero DB writes', s.writes === 0,
    `reads=${s.reads}, writes=${s.writes}`);
  check('1000 healthy requests use at most one DB read each',
    s.reads <= 1000 && calls.length === 1000);

  s = new FakeStore(); calls = [];
  const concurrent = makeInstance('concurrent', s, calls, { gemini: 'ok' });
  await Promise.all(Array.from({ length: 1000 }, (_, i) =>
    ask(concurrent, `concurrent-healthy-${i}`)));
  check('1000 concurrent healthy requests gate only acquired provider slots',
    s.reads <= 2 && calls.length <= 2 && s.writes === 0,
    `reads=${s.reads}, network=${calls.length}, writes=${s.writes}`);
  check('all simulations preserve zero-cost provider policy',
    healthy.llm.stats().paidCalls === 0 && healthy.llm.stats().estimatedCostUsd === 0);

  console.log(`TOTAL ${passes} PASS / 0 FAIL`);
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
