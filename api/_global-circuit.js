'use strict';
/*
 * Provider 장애 상태만 공유한다. 질문·계정·IP·프롬프트는 DB로 보내지 않는다.
 * CLOSED는 캐시하지 않는다: 다른 인스턴스가 방금 429를 본 직후에도 반드시
 * 공유 상태를 확인해야 한다. OPEN만 로컬 캐시해 DB 부하를 줄인다.
 */
const crypto = require('crypto');
const MAX_BLOCK_MS = 30 * 60 * 1000;
const GATE_TIMEOUT_MS = 700;
const WRITE_TIMEOUT_MS = 800;
const DB_BACKOFF_MS = 2000;

function rpcRow(data) { return Array.isArray(data) ? data[0] : data; }

let circuitClient;
function getClient() {
  if (circuitClient) return circuitClient;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    throw new Error('circuit database unavailable');
  }
  const { createClient } = require('@supabase/supabase-js');
  /*
   * gate 는 half-open lease 를 잡는다 — 같은 RPC 가 두 번 실행되면 뒤의 호출이
   * 승자의 lease 를 자기 토큰으로 덮어써, 죽은 인스턴스가 회복 탐침을 쥔 채
   * 사라질 수 있다. postgrest-js 는 POST 를 자동 재시도하지 않으므로 지금은
   * 안전하다(2026-09-20 dist 확인). 이 모듈에 재시도 래퍼를 끼우지 말 것.
   *
   * api/_supabase.js 를 쓰지 않는 이유: 그 프록시는 저장소 전역 클라이언트라
   * 다른 기능이 옵션을 바꾸면 회로도 같이 바뀐다. 장애 때만 도는 코드가
   * 남의 설정 변경에 끌려가지 않도록 여기서만 쓰는 클라이언트를 따로 만든다.
   */
  circuitClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return circuitClient;
}

// Supabase 클라이언트는 첫 사용 시에만 로드한다. 키가 없거나 DB가 죽어도
// 기존 프로세스 로컬 보호가 그대로 동작한다.
const defaultStore = {
  async rpc(name, args, signal) {
    let query = getClient().rpc(name, args);
    if (query && typeof query.abortSignal === 'function') query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw new Error('circuit database unavailable');
    return rpcRow(data);
  },
  gate(provider, model, token, signal) {
    return this.rpc('ai_circuit_gate', {
      p_provider: provider, p_model: model, p_token: token
    }, signal);
  },
  fail(provider, model, reason, ms, token, signal) {
    return this.rpc('ai_circuit_fail', {
      p_provider: provider, p_model: model, p_reason: reason,
      p_duration_ms: ms, p_token: token || null
    }, signal);
  },
  success(provider, model, token, signal) {
    return this.rpc('ai_circuit_success', {
      p_provider: provider, p_model: model, p_token: token
    }, signal);
  }
};

function createCircuit({ store = defaultStore, now = Date.now } = {}) {
  const open = new Map();
  let dbBackoffUntil = 0;
  const counts = { reads: 0, failAttempts: 0, probeSuccessAttempts: 0, dbErrors: 0,
    localOpenSkips: 0, sharedOpenSkips: 0, probes: 0 };

  async function bounded(method, args, ms) {
    const ac = new AbortController();
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => store[method](...args, ac.signal)),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            ac.abort();
            reject(new Error('circuit timeout'));
          }, ms);
        })
      ]);
    } finally { clearTimeout(timer); }
  }

  function remember(key, ms) {
    const duration = Math.max(0, Math.min(MAX_BLOCK_MS, Number(ms) || 0));
    if (duration > 0) open.set(key, Math.max(open.get(key) || 0, now() + duration));
  }

  function localBlock(provider, model) {
    for (const key of [`${provider}:*`, `${provider}:${model}`]) {
      const until = open.get(key) || 0;
      if (until > now()) return until - now();
      if (until) open.delete(key);
    }
    return 0;
  }

  async function before(provider, model) {
    const localMs = localBlock(provider, model);
    if (localMs > 0) {
      counts.localOpenSkips++;
      return { allowed: false, remainingMs: localMs, reason: 'cooldown' };
    }
    if (dbBackoffUntil > now()) return { allowed: true, degraded: true };
    try {
      counts.reads++;
      const row = await bounded('gate', [provider, model, crypto.randomUUID()], GATE_TIMEOUT_MS);
      if (!row || typeof row.allowed !== 'boolean') throw new Error('invalid circuit state');
      if (row.allowed) {
        if (row.probe_token || row.probeToken) counts.probes++;
        return { allowed: true, probeToken: row.probe_token || row.probeToken || null };
      }
      const ms = Math.max(1, Math.min(MAX_BLOCK_MS, Number(row.remaining_ms ?? row.remainingMs) || 1000));
      remember(`${provider}:${row.scope === '*' ? '*' : model}`, ms);
      counts.sharedOpenSkips++;
      return { allowed: false, remainingMs: ms, reason: 'cooldown' };
    } catch (_e) {
      counts.dbErrors++;
      dbBackoffUntil = now() + DB_BACKOFF_MS;
      return { allowed: true, degraded: true };
    }
  }

  async function failure(provider, model, reason, ms, probeToken) {
    const duration = Math.max(0, Math.min(MAX_BLOCK_MS, Number(ms) || 0));
    if (!duration) return;
    const scope = reason === 'auth' ? '*' : model;
    remember(`${provider}:${scope}`, duration);
    if (dbBackoffUntil > now()) return;
    try {
      counts.failAttempts++;
      const row = await bounded('fail', [provider, scope, reason, duration, probeToken || null], WRITE_TIMEOUT_MS);
      const remaining = Number(row && (row.remaining_ms ?? row.remainingMs ?? row));
      if (Number.isFinite(remaining) && remaining > 0) remember(`${provider}:${scope}`, remaining);
    } catch (_e) {
      counts.dbErrors++;
      dbBackoffUntil = now() + DB_BACKOFF_MS;
    }
  }

  async function success(provider, model, probeToken) {
    if (!probeToken || dbBackoffUntil > now()) return;
    try {
      counts.probeSuccessAttempts++;
      const closed = await bounded('success', [provider, model, probeToken], WRITE_TIMEOUT_MS);
      if (closed === true || (closed && closed.closed === true)) {
        open.delete(`${provider}:*`);
        open.delete(`${provider}:${model}`);
      }
    } catch (_e) {
      counts.dbErrors++;
      dbBackoffUntil = now() + DB_BACKOFF_MS;
    }
  }

  function stats() { return { ...counts, open: open.size }; }
  function _reset() {
    open.clear(); dbBackoffUntil = 0;
    Object.keys(counts).forEach(k => { counts[k] = 0; });
  }
  return { before, failure, success, stats, _reset };
}

module.exports = Object.assign(createCircuit(), { createCircuit, MAX_BLOCK_MS });
