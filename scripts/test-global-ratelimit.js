'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const migration = read('supabase/2026-09-19-global-rate-limit.sql');
assert(migration.includes('create table if not exists public.security_rate_limits'), 'distributed limiter table exists');
assert(migration.includes('primary key (bucket, subject_hash, window_start)'), 'counter upsert key is deterministic');
assert(migration.includes('security invoker'), 'RPC does not bypass RLS');
assert(migration.includes('set search_path = public, pg_temp'), 'RPC search_path is pinned');
assert(migration.includes('revoke all on function public.security_rate_limit'), 'RPC is revoked from public roles');
assert(migration.includes('grant execute on function public.security_rate_limit') && migration.includes('to service_role'), 'only service role can execute RPC');

for (const p of ['api/search.js','api/ai.js','api/auth.js','api/payment.js']) {
  const s = read(p);
  assert(s.includes("const { guardGlobal } = require('./_ratelimit');"), p + ' imports shared limiter');
  assert(s.includes('await guardGlobal(req, res'), p + ' awaits shared limiter before sensitive work');
}

const supabasePath = require.resolve('../api/_supabase');
let rpcMode = 'deny';
let lastArgs = null;
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    rpc: async (_name, args) => {
      lastArgs = args;
      if (rpcMode === 'error') return { data: null, error: { message: 'temporary db outage' } };
      return { data: [{ allowed: false, remaining: 0, retry_after: 17 }], error: null };
    }
  }
};

process.env.SUPABASE_URL = 'https://example.test';
process.env.SUPABASE_SECRET_KEY = 'test-secret-not-a-real-key';

const rlPath = require.resolve('../api/_ratelimit');
delete require.cache[rlPath];
const { guardGlobal, hashSubject, normalizeRpcRow } = require('../api/_ratelimit');

function req(ip) {
  return { headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: ip } };
}
function res() {
  return {
    headers: {}, statusCode: 200, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

(async () => {
  const rawIp = '203.0.113.77';
  const hashed = hashSubject(req(rawIp), 'shared-unit');
  assert.equal(hashed.length, 64, 'subject is sha256 length');
  assert(!hashed.includes(rawIp), 'raw IP is not embedded in stored subject');

  const out = res();
  const allowed = await guardGlobal(req(rawIp), out, { name: 'shared-unit', limit: 99, windowMs: 60000 });
  assert.equal(allowed, false, 'global deny blocks request');
  assert.equal(out.statusCode, 429, 'global deny returns 429');
  assert.equal(out.headers['Retry-After'], '17', 'global retry-after is propagated');
  assert(lastArgs && lastArgs.p_subject_hash === hashed, 'RPC receives only hashed subject');
  assert(!JSON.stringify(lastArgs).includes(rawIp), 'RPC args do not contain raw IP');

  rpcMode = 'error';
  const fallback = res();
  const fallbackAllowed = await guardGlobal(req('203.0.113.88'), fallback, { name: 'fallback-unit', limit: 99, windowMs: 60000 });
  assert.equal(fallbackAllowed, true, 'temporary DB failure falls back to local limiter');
  assert.equal(fallback.statusCode, 200, 'fallback does not turn DB incident into API outage');

  assert.deepEqual(normalizeRpcRow([{ allowed: true, remaining: 4, retry_after: 9 }]),
    { ok: true, remaining: 4, retryAfter: 9 }, 'RPC row normalization');

  console.log('PASS global rate limit: shared deny, hashed subject, local fallback, sensitive routes wired');
})().catch(e => {
  console.error(e);
  process.exit(1);
});
