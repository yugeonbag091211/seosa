'use strict';

/*
 * SEOSA LLM entrypoint.
 *
 * Production now prefers the owner's direct OpenAI API credit.  The previous
 * zero-cost router is preserved intact in _llm-free.js and remains the fallback
 * for quota/rate/auth/provider failures.  Keeping the old router intact makes
 * this change easy to audit and keeps every existing free-provider safeguard.
 */
const crypto = require('crypto');
const free = require('./_llm-free');
const openai = require('./_openai-provider');

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 200;
const OPENAI_MAX_INFLIGHT = 2;
const OPENAI_ATTEMPT_MS = 8000;
const OPENAI_AUTH_COOLDOWN_MS = 10 * 60 * 1000;
const OPENAI_QUOTA_COOLDOWN_MS = 5 * 60 * 1000;
const OPENAI_FAILURE_COOLDOWN_MS = 60 * 1000;

/* Standard short-context rates, USD / 1M tokens.  Unknown models stay null. */
const OPENAI_PRICES_USD_PER_1M = Object.freeze({
  'gpt-6-luna': { in: 0.10, out: 0.50 }
});

const state = {
  attempts: 0,
  successes: 0,
  failures: 0,
  cacheHits: 0,
  coalesced: 0,
  inflight: 0,
  cooldownUntil: 0,
  cooldownReason: '',
  inTok: 0,
  outTok: 0,
  costUsd: 0,
  cache: new Map(),
  inflightChats: new Map()
};

function enabled() {
  return Boolean(String(process.env.OPENAI_API_KEY || '').trim());
}

function allowPaid() {
  return enabled();
}

function cacheTtl() {
  const raw = process.env.AI_CACHE_TTL_MS;
  if (raw === undefined || raw === '') return DEFAULT_CACHE_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 30 * 60 * 1000) : 0;
}

function cacheKey(role, messages, maxTokens, temperature, model) {
  return crypto.createHash('sha1')
    .update(`${model}|${role}|${maxTokens}|${temperature}|${JSON.stringify(messages)}`)
    .digest('hex');
}

function cacheGet(key, ttl, now) {
  if (!ttl) return null;
  const hit = state.cache.get(key);
  if (!hit) return null;
  if (now - hit.at > ttl) {
    state.cache.delete(key);
    return null;
  }
  return hit;
}

function cacheSet(key, ttl, value) {
  if (!ttl) return;
  if (state.cache.size >= CACHE_MAX) {
    const oldest = state.cache.keys().next();
    if (!oldest.done) state.cache.delete(oldest.value);
  }
  state.cache.set(key, value);
}

function estimateOpenAICostUsd(model, usage) {
  if (!usage) return null;
  const price = OPENAI_PRICES_USD_PER_1M[model];
  if (!price) return null;
  return (Number(usage.inputTokens || 0) / 1e6) * price.in +
    (Number(usage.outputTokens || 0) / 1e6) * price.out;
}

function classifyStatus(status) {
  if (status === 401 || status === 403) return { reason: 'auth', cooldown: OPENAI_AUTH_COOLDOWN_MS };
  if (status === 402 || status === 429) return { reason: 'quota', cooldown: OPENAI_QUOTA_COOLDOWN_MS };
  if (status >= 500) return { reason: 'server', cooldown: OPENAI_FAILURE_COOLDOWN_MS };
  if (status === 400 || status === 404) return { reason: 'request', cooldown: OPENAI_FAILURE_COOLDOWN_MS };
  return { reason: 'http', cooldown: OPENAI_FAILURE_COOLDOWN_MS };
}

function setCooldown(reason, ms) {
  state.cooldownReason = reason;
  state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + Math.max(0, Number(ms) || 0));
}

function responseJson(response, deadline, controller) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(Object.assign(new Error('deadline'), { name: 'AbortError' }));
  let timer;
  return Promise.race([
    response.json(),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error('deadline'), { name: 'AbortError' }));
      }, remaining);
    })
  ]).finally(() => clearTimeout(timer));
}

async function attemptOpenAI(opts, timeoutMs) {
  if (!enabled()) return { ok: false, reason: 'nokey' };
  if (state.cooldownUntil > Date.now()) return { ok: false, reason: 'cooldown' };
  if (state.inflight >= OPENAI_MAX_INFLIGHT) return { ok: false, reason: 'busy' };

  const model = openai.modelFromEnv();
  const request = openai.request(model, opts);
  const controller = new AbortController();
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || OPENAI_ATTEMPT_MS);
  state.inflight++;
  state.attempts++;

  let timer;
  try {
    const remaining = Math.max(1, deadline - Date.now());
    const fetchPromise = fetch(request.url, {
      method: 'POST',
      signal: controller.signal,
      headers: request.headers,
      body: JSON.stringify(request.body)
    });
    const response = await Promise.race([
      fetchPromise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error('deadline'), { name: 'AbortError' }));
        }, remaining);
      })
    ]).finally(() => clearTimeout(timer));

    if (!response || !response.ok) {
      state.failures++;
      const cls = classifyStatus((response && response.status) || 0);
      setCooldown(cls.reason, cls.cooldown);
      // Never log provider response bodies: they are unnecessary for fallback and may
      // echo request metadata.  In particular, the API key is never written to logs.
      console.warn(`[llm] openai/${model} ${(response && response.status) || 0} ${cls.reason}`);
      return { ok: false, reason: cls.reason, model };
    }

    const data = await responseJson(response, deadline, controller);
    const parsed = openai.parse(data);
    if (!parsed.text || !String(parsed.text).trim()) {
      state.failures++;
      setCooldown('empty', OPENAI_FAILURE_COOLDOWN_MS);
      return { ok: false, reason: 'empty', model };
    }

    state.successes++;
    state.cooldownUntil = 0;
    state.cooldownReason = '';
    if (parsed.usage) {
      state.inTok += Number(parsed.usage.inputTokens) || 0;
      state.outTok += Number(parsed.usage.outputTokens) || 0;
    }
    const costUsd = estimateOpenAICostUsd(model, parsed.usage);
    if (Number.isFinite(costUsd)) state.costUsd += costUsd;

    return {
      ok: true,
      text: parsed.text,
      finish: parsed.finish,
      usage: parsed.usage || null,
      costUsd,
      model
    };
  } catch (e) {
    state.failures++;
    const reason = e && e.name === 'AbortError' ? 'timeout' : 'network';
    setCooldown(reason, OPENAI_FAILURE_COOLDOWN_MS);
    console.warn(`[llm] openai/${model} ${reason}`);
    return { ok: false, reason, model };
  } finally {
    clearTimeout(timer);
    state.inflight = Math.max(0, state.inflight - 1);
  }
}

async function chatOnce(opts) {
  const o = opts || {};
  if (!enabled()) return free.chat(o);

  const role = o.role === 'classify' ? 'classify' : 'answer';
  const messages = Array.isArray(o.messages) ? o.messages : [];
  if (!messages.length) return free.chat(o);

  const maxTokens = Math.max(1, Number(o.maxTokens) || 900);
  const temperature = Number.isFinite(Number(o.temperature)) ? Number(o.temperature) : 0.2;
  const perCallMs = Math.max(1000, Number(o.perCallMs) || 25000);
  const budgetMs = Math.max(1000, Number(o.budgetMs) || perCallMs);
  const startedAt = Date.now();
  const model = openai.modelFromEnv();
  const ttl = cacheTtl();
  const key = ttl ? cacheKey(role, messages, maxTokens, temperature, model) : '';
  const hit = cacheGet(key, ttl, startedAt);
  if (hit) {
    state.cacheHits++;
    return {
      ok: true,
      text: hit.text,
      finish: hit.finish,
      model,
      provider: 'openai',
      reason: 'cache',
      tried: [],
      cached: true,
      usage: null,
      costUsd: 0,
      latencyMs: Date.now() - startedAt
    };
  }

  const attemptMs = Math.min(OPENAI_ATTEMPT_MS, perCallMs, budgetMs);
  const r = await attemptOpenAI({ messages, maxTokens, temperature, extra: o.extra }, attemptMs);
  if (r.ok) {
    cacheSet(key, ttl, { at: Date.now(), text: r.text, finish: r.finish });
    return {
      ok: true,
      text: r.text,
      finish: r.finish,
      model: r.model,
      provider: 'openai',
      reason: 'ok',
      tried: [{ provider: 'openai', model: r.model, reason: 'ok' }],
      cached: false,
      usage: r.usage || null,
      costUsd: r.costUsd,
      latencyMs: Date.now() - startedAt
    };
  }

  // Direct OpenAI failed or is cooling down.  Preserve SEOSA availability by
  // falling through to the existing free Gemini/Groq/OpenRouter chain.
  const elapsed = Date.now() - startedAt;
  const fallbackBudget = Math.max(1000, budgetMs - elapsed);
  const fallback = await free.chat(Object.assign({}, o, { budgetMs: fallbackBudget }));
  if (fallback && Array.isArray(fallback.tried)) {
    fallback.tried.unshift({ provider: 'openai', model: r.model || model, reason: r.reason || 'provider' });
  }
  return fallback;
}

async function chat(opts) {
  if (!enabled()) return free.chat(opts);
  const o = opts || {};
  const messages = Array.isArray(o.messages) ? o.messages : [];
  const ttl = cacheTtl();
  if (!ttl || !messages.length) return chatOnce(o);

  const role = o.role === 'classify' ? 'classify' : 'answer';
  const maxTokens = Math.max(1, Number(o.maxTokens) || 900);
  const temperature = Number.isFinite(Number(o.temperature)) ? Number(o.temperature) : 0.2;
  const key = cacheKey(role, messages, maxTokens, temperature, openai.modelFromEnv());
  const pending = state.inflightChats.get(key);
  if (pending) {
    state.coalesced++;
    const startedAt = Date.now();
    const r = await pending;
    if (!r || !r.ok) return r;
    return Object.assign({}, r, {
      reason: r.reason === 'cache' ? 'cache' : 'coalesced',
      cached: true,
      usage: null,
      costUsd: 0,
      latencyMs: Date.now() - startedAt
    });
  }

  const p = chatOnce(o);
  state.inflightChats.set(key, p);
  try {
    return await p;
  } finally {
    if (state.inflightChats.get(key) === p) state.inflightChats.delete(key);
  }
}

function reset() {
  if (free._internal && typeof free._internal._reset === 'function') free._internal._reset();
  state.attempts = 0;
  state.successes = 0;
  state.failures = 0;
  state.cacheHits = 0;
  state.coalesced = 0;
  state.inflight = 0;
  state.cooldownUntil = 0;
  state.cooldownReason = '';
  state.inTok = 0;
  state.outTok = 0;
  state.costUsd = 0;
  state.cache.clear();
  state.inflightChats.clear();
}

function stats() {
  const base = free.stats();
  const attempts = state.attempts;
  return Object.assign({}, base, {
    zeroCost: base.zeroCost && attempts === 0,
    allowPaid: allowPaid(),
    calls: Number(base.calls || 0) + attempts,
    paidCalls: Number(base.paidCalls || 0) + attempts,
    failures: Number(base.failures || 0) + state.failures,
    cacheHits: Number(base.cacheHits || 0) + state.cacheHits,
    coalesced: Number(base.coalesced || 0) + state.coalesced,
    inputTokens: Number(base.inputTokens || 0) + state.inTok,
    outputTokens: Number(base.outputTokens || 0) + state.outTok,
    estimatedCostUsd: Math.round((Number(base.estimatedCostUsd || 0) + state.costUsd) * 1e6) / 1e6,
    primaryProvider: enabled() ? 'openai' : 'free-router',
    openAI: {
      enabled: enabled(),
      model: openai.modelFromEnv(),
      attempts: state.attempts,
      successes: state.successes,
      failures: state.failures,
      cacheHits: state.cacheHits,
      coalesced: state.coalesced,
      inflight: state.inflight,
      cooldownReason: state.cooldownUntil > Date.now() ? state.cooldownReason : '',
      estimatedCostUsd: Math.round(state.costUsd * 1e6) / 1e6
    }
  });
}

const exportedInternal = Object.assign({}, free._internal || {}, {
  _reset: reset,
  attemptOpenAI,
  openAIState: state,
  openAIProvider: openai,
  estimateOpenAICostUsd
});

module.exports = Object.assign({}, free, {
  chat,
  allowPaid,
  stats,
  DEFAULT_OPENAI_MODEL: openai.DEFAULT_MODEL,
  OPENAI_PRICES_USD_PER_1M,
  _internal: exportedInternal
});
