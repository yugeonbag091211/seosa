'use strict';
// AI v3.4 — embedding providers + a fail-closed cost guard.
//
// 1) seosa-hash-ngram-v1 (default): deterministic, local, free. Signed
//    feature hashing of words + Korean/Latin character 2-3-grams over the
//    normalized retrieval document (_ai-v34-text). It is LEXICAL, not a
//    semantic language model: it tolerates spacing ("외장SSD"/"외장 SSD"),
//    word order, partial tokens and lexicon synonyms. Reports must say so.
// 2) openai:text-embedding-3-small (opt-in): semantic, paid. Every call is
//    reserved against a USD cap BEFORE it is sent; an unmetered response is
//    charged at the reserved upper bound — never assumed free.
const EMBEDDER_HASH = 'seosa-hash-ngram-v1';

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function l2normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = Math.round((v[i] / n) * 1e6) / 1e6;
  return out;
}
function hashTokens(text) {
  const out = [];
  for (const w of String(text || '').split(/\s+/).filter(Boolean)) {
    // structured tokens (cat_/brand_/model_/id_/syn_) are strong evidence
    const structured = /^(?:cat|brand|model|id|syn)_/.test(w);
    out.push(['w:' + w, structured ? 2.5 : 1.5]);
    if (structured) continue;
    const s = '\u0002' + w + '\u0003';
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= s.length; i++) out.push(['c' + n + ':' + s.slice(i, i + n), 1]);
    }
  }
  return out;
}
function hashEmbedder({ dims = 256 } = {}) {
  if (!Number.isInteger(dims) || dims < 32 || dims > 2000) throw new Error('hash embedder dims out of range');
  const embedOne = text => {
    const tf = new Map();
    for (const [token, weight] of hashTokens(text)) tf.set(token, (tf.get(token) || 0) + weight);
    const v = new Float64Array(dims);
    for (const [token, weight] of tf) {
      const h = fnv1a(token);
      const sign = (fnv1a('±' + token) & 1) ? 1 : -1;
      v[h % dims] += sign * (1 + Math.log(weight));
    }
    return l2normalize(v);
  };
  return {
    id: EMBEDDER_HASH, dims, kind: 'local-lexical', version: '1',
    async embed(texts) { return texts.map(embedOne); },
    usage() { return { calls: 0, tokens: 0, costUsd: 0, metered: true }; }
  };
}

// USD per 1M input tokens. Source: OpenAI public price list as recorded in
// docs/ai-v34-oss-integration.md; the guard multiplies by a safety factor so
// a stale price can only over-reserve, never under-reserve.
const OPENAI_EMBEDDING_PRICE = { 'text-embedding-3-small': 0.02, 'text-embedding-3-large': 0.13 };
function createCostGuard({ capUsd = 1, safety = 2 } = {}) {
  if (!(capUsd > 0)) throw new Error('cost cap required');
  let reserved = 0, committed = 0, unmetered = 0;
  return {
    capUsd, safety,
    reserve(usd) {
      const amount = Math.max(0, Number(usd) || 0) * safety;
      if (committed + reserved + amount > capUsd) {
        const e = new Error('cost cap reached'); e.code = 'COST_CAP'; throw e;
      }
      reserved += amount;
      return amount;
    },
    settle(reservedAmount, actualUsd) {
      reserved = Math.max(0, reserved - reservedAmount);
      // Unknown actual cost = charge the full reservation.
      if (actualUsd == null || !Number.isFinite(actualUsd)) { committed += reservedAmount; unmetered++; }
      else committed += actualUsd;
    },
    snapshot() { return { capUsd, committedUsd: Math.round(committed * 1e6) / 1e6, reservedUsd: reserved, unmeteredCalls: unmetered }; }
  };
}
const approxTokens = texts => texts.reduce((s, t) => s + Math.ceil(String(t).length / 1.5) + 8, 0);
function openAiEmbedder({ apiKey = process.env.OPENAI_API_KEY, model = 'text-embedding-3-small', dims = 256,
  fetchImpl = globalThis.fetch, guard, timeoutMs = 15000 } = {}) {
  if (!apiKey) throw new Error('OPENAI_API_KEY required for the OpenAI embedder');
  if (!guard) throw new Error('A cost guard is required for paid embeddings');
  const price = OPENAI_EMBEDDING_PRICE[model];
  if (!price) throw new Error('Unknown embedding price for ' + model + ' — refusing to call a paid API unpriced');
  const stats = { calls: 0, tokens: 0 };
  return {
    id: 'openai:' + model, dims, kind: 'remote-semantic', version: '1',
    async embed(texts) {
      const hold = guard.reserve(approxTokens(texts) / 1e6 * price);
      let actual = null;
      try {
        const res = await fetchImpl('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, input: texts, dimensions: dims }),
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!res.ok) throw new Error('Embedding request failed (HTTP ' + res.status + ')');
        const body = await res.json();
        const tokens = Number(body && body.usage && body.usage.total_tokens);
        if (Number.isFinite(tokens) && tokens >= 0) { actual = tokens / 1e6 * price; stats.tokens += tokens; }
        stats.calls++;
        const data = Array.isArray(body && body.data) ? body.data.slice().sort((a, b) => a.index - b.index) : [];
        if (data.length !== texts.length) throw new Error('Embedding count mismatch');
        return data.map(d => l2normalize(d.embedding));
      } finally { guard.settle(hold, actual); }
    },
    usage() { return { ...stats, ...guard.snapshot(), metered: true }; }
  };
}
function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
module.exports = { hashEmbedder, openAiEmbedder, createCostGuard, cosine, fnv1a, EMBEDDER_HASH, OPENAI_EMBEDDING_PRICE };
