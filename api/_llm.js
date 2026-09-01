'use strict';
/*
 * OpenRouter 호출을 한 곳으로 모은다 — 모델 사슬 · 실패 분류 · 시간 예산 · 캐시.
 *
 * ── 왜 만들었나 ────────────────────────────────────────────────
 *
 * api/ai.js 는 세 자리에서 fetch 로 직접 OpenRouter 를 불렀고, 모델은 하나뿐이었다.
 * 그 하나가 402(크레딧 부족)를 내면 AI 기능 전체가 죽는다. 2026-08-28~29 운영에서
 * 실제로 그렇게 죽어 있었다 — 코드는 멀쩡한데 잔액이 0이라 아무도 답을 못 받았다.
 *
 * 여기서 모델을 사슬로 만든다.
 *
 *   1순위(유료·품질)  →  무료 모델들  →  (호출부의) SEOSA 결정론 답변
 *
 * 무료 모델은 크레딧 잔액이 0이어도 호출된다. 그래서 잔액이 떨어져도
 * AI 가 침묵하지 않는다. 잔액을 채우면 자동으로 1순위로 되돌아간다 —
 * 배포도 환경변수 변경도 필요 없다.
 *
 * ── 지키는 선 ──────────────────────────────────────────────────
 *
 *   · 새 서버리스 함수를 만들지 않는다. `_` 접두사 = 공유 모듈 (Vercel 11/12 유지)
 *   · 업스트림 원문을 호출부로 돌려주지 않는다. 이유 코드(reason)만 준다.
 *     ("Insufficient credits …" 가 사용자 말풍선에 그대로 뜬 적이 있다)
 *   · API 키는 로그에 절대 남기지 않는다. 응답 본문도 키 모양이면 지운다.
 *   · 사슬 전체가 요청 하나의 시간 예산 안에서 돈다. 모델이 4개라고
 *     타임아웃이 4배가 되면 함수가 상한까지 매달린다.
 */

const crypto = require('crypto');

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/*
 * 1순위. 크레딧이 있으면 여기서 끝나고, 아래 무료 사슬은 돌지 않는다.
 * 기존 api/ai.js 의 기본값을 그대로 옮겼다 — 품질 기본값을 낮추지 않는다.
 */
const DEFAULT_ANSWER_MODEL   = 'anthropic/claude-sonnet-5';
const DEFAULT_CLASSIFY_MODEL = 'anthropic/claude-haiku-4.5';

/*
 * 무료 사슬.
 *
 * OpenRouter 의 `:free` 판은 잔액 0에서도 호출된다(대신 일일 횟수 제한이 있다).
 * 모델 id 는 공급자 사정으로 사라진다 — 없는 id 는 404 로 돌아오고, 그때 이
 * 프로세스에서 죽은 것으로 표시하고 다음으로 넘어간다(dead 참고).
 * 목록을 통째로 갈아끼우려면 OPENROUTER_MODELS 를 쓴다.
 *
 * ── 2026-08-30 실측으로 고른 목록 ──────────────────────────────
 *
 * 처음에는 흔히 알려진 무료 id(deepseek-chat-v3 / llama-3.3-70b / qwen-2.5-72b)를
 * 적었는데, 실제로 /api/v1/models 를 받아 보니 **셋 다 존재하지 않았다.**
 * 그 상태로 배포했으면 매 요청이 404 세 번을 거쳐 결정론 답변으로만 떨어졌을
 * 것이다. 그래서 실제 목록(무료 18종)을 받아 후보를 직접 돌려 보고 골랐다.
 *
 *   모델                                    분류 정확도  답변 지연   지어낸 금액
 *   nvidia/nemotron-3-super-120b-a12b:free    5/5        1,327ms      없음   ← 1순위
 *   minimax/minimax-m3:free                   5/5        2,749ms      없음
 *   nvidia/nemotron-3.5-lightning:free        4/5          909ms      없음
 *   nvidia/nemotron-3-ultra-550b-a55b:free    4/5       11,291ms      없음   ← 너무 느려 제외
 *   minimax/minimax-m2.7:free                  —            —          —     ← reasoning 강제(400)
 *   z-ai/glm-5.2, google/gemma-4-*:free        —            —          —     ← 429 (공급자 혼잡)
 *
 * (분류 정확도 = CLASSIFY_SYSTEM 으로 A~E 5문항. 답변은 결정 데이터를 준
 *  프롬프트로 3문장 요약을 시켜 금액을 지어내는지 함께 봤다.)
 *
 * 분류용은 짧은 출력이 빠른 순서로 둔다 — 분류는 답변 앞에 서므로 여기서
 * 끄는 시간이 그대로 사용자 대기 시간이다.
 */
const FREE_ANSWER_CHAIN = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'minimax/minimax-m3:free',
  'nvidia/nemotron-3.5-lightning:free'
];
const FREE_CLASSIFY_CHAIN = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3.5-lightning:free'
];

/*
 * 사슬 길이 상한.
 *
 * 길게 늘어놓으면 장애가 났을 때 사용자가 그만큼 오래 기다린다. 실패가
 * 이어지면 답을 억지로 받아내는 것보다 빨리 결정론 답변으로 넘어가는 쪽이 낫다.
 */
const MAX_CHAIN = 4;

/* ─── 모델 단가 (USD / 1M 토큰) ────────────────────────────────────
 *
 * ★ 여기 없는 모델은 비용을 null 로 둔다 — 지어내지 않는다.
 * ★ 값은 사람이 관리한다. provider 가 단가를 바꾸면 이 표만 고치면 된다.
 *   토큰 수는 provider 응답(usage)에서 온 실측값이고, 비용만 이 표로
 *   곱해서 얻는 추정치다. 그래서 필드 이름도 costUsd(추정)로 둔다.
 *
 * :free 접미사 모델은 OpenRouter 무료 티어라 0 이다(호출 자체는 무료이며,
 * 분당/일일 상한이 대신 걸린다).
 */
const MODEL_PRICES_USD_PER_1M = {
  'anthropic/claude-sonnet-5':   { in: 3.00, out: 15.00 },
  'anthropic/claude-haiku-4.5':  { in: 1.00, out: 5.00 }
};

/** 무료 티어 모델인가 (OpenRouter 는 :free 접미사로 표시한다). */
function isFreeModel(model) { return /:free$/.test(String(model || '')); }

/**
 * 예상 비용(USD). 단가를 모르는 모델이면 null 을 준다.
 *
 * @param {string} model
 * @param {{inputTokens:number,outputTokens:number}|null} usage provider 실측 토큰
 * @returns {number|null}
 */
function estimateCostUsd(model, usage) {
  if (isFreeModel(model)) return 0;
  if (!usage) return null;                       // 토큰을 모르면 비용도 모른다
  const p = MODEL_PRICES_USD_PER_1M[model];
  if (!p) return null;                           // 단가 미등록 — 추정하지 않는다
  return (usage.inputTokens / 1e6) * p.in + (usage.outputTokens / 1e6) * p.out;
}

/** 이만큼도 안 남았으면 새 모델을 시도하지 않는다 (부르자마자 끊길 시간) */
const MIN_ATTEMPT_MS = 2500;

/*
 * 402 를 한 번 보면 그 뒤 이 시간 동안은 유료 모델을 건너뛴다.
 *
 * 잔액이 0인 계정은 다음 요청도, 그다음 요청도 402 다. 매번 확인하면
 * 사용자마다 한 번씩 헛걸음(왕복 + 지연)을 한다. 잔액을 채우면 최대
 * 이 시간 뒤에 자동으로 1순위로 돌아온다.
 */
const PAID_BLOCK_MS = 10 * 60 * 1000;

/** 없는 모델 id 를 기억해 두는 시간. */
const DEAD_MODEL_MS = 30 * 60 * 1000;

/** 모델 id 로 받아들일 모양. 환경변수로 아무 문자열이나 URL 에 실리지 않게 한다. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(:[A-Za-z0-9._-]+)?$/;
const MAX_MODEL_LEN = 80;

/*
 * 프로세스 안에서만 사는 상태. 서버리스라 인스턴스마다 따로 논다 —
 * 그래도 같은 인스턴스가 받는 연속 요청에서는 헛걸음을 줄여 준다.
 * 판정 자체를 여기에 기대지는 않는다(어디까지나 최적화).
 */
const state = {
  paidBlockedUntil: 0,
  dead: new Map(),      // model → 언제까지 죽은 것으로 볼지
  cache: new Map()      // key → { at, text, finish, model }
};

/** `:free` 로 끝나면 잔액이 없어도 부를 수 있는 모델이다. */
function isFree(model) {
  return /:free$/i.test(String(model || ''));
}

function sanitizeModel(raw) {
  const s = String(raw == null ? '' : raw).trim().slice(0, MAX_MODEL_LEN);
  return MODEL_RE.test(s) ? s : '';
}

function envList(name) {
  return String(process.env[name] || '')
    .split(',')
    .map(sanitizeModel)
    .filter(Boolean);
}

/**
 * 이 역할에 쓸 모델 사슬.
 *
 * OPENROUTER_MODELS / OPENROUTER_CLASSIFY_MODELS 가 있으면 그것이 사슬 전체다
 * (무료만 적으면 비용이 0원인 운영이 된다). 없으면 기존 단일 모델을 1순위로
 * 두고 그 뒤에 무료 사슬을 잇는다.
 *
 * @param {'answer'|'classify'} role
 */
function chainFor(role) {
  const classify = role === 'classify';
  const override = envList(classify ? 'OPENROUTER_CLASSIFY_MODELS' : 'OPENROUTER_MODELS');

  let list;
  if (override.length) {
    list = override;
  } else {
    const head = sanitizeModel(
      process.env[classify ? 'OPENROUTER_CLASSIFY_MODEL' : 'OPENROUTER_MODEL']
    ) || (classify ? DEFAULT_CLASSIFY_MODEL : DEFAULT_ANSWER_MODEL);
    list = [head].concat(classify ? FREE_CLASSIFY_CHAIN : FREE_ANSWER_CHAIN);
  }

  const seen = Object.create(null);
  const out = [];
  list.forEach(m => {
    if (seen[m]) return;
    seen[m] = true;
    out.push(m);
  });
  return out.slice(0, MAX_CHAIN);
}

/**
 * 지금 시도해 볼 만한 모델만 남긴다.
 *
 * ★ 전부 걸러지면 거르지 않은 사슬을 그대로 쓴다. 최적화 때문에 아무것도
 *   시도하지 않는 것이 가장 나쁜 결과다 — 기억이 틀렸을 수도 있으니
 *   한 번은 부딪혀 본다.
 */
function usableChain(chain, now) {
  const live = chain.filter(m => {
    const until = state.dead.get(m) || 0;
    if (until > now) return false;
    if (until) state.dead.delete(m);
    if (!isFree(m) && state.paidBlockedUntil > now) return false;
    return true;
  });
  return live.length ? live : chain.slice();
}

/**
 * 업스트림 상태코드를 우리가 다룰 수 있는 갈래로 옮긴다.
 *
 * advance=false 는 "다음 모델을 시도해도 소용없다" 는 뜻이다. 키가 잘못됐으면
 * 사슬 전체가 같은 키를 쓰므로 네 번 더 물어봐야 네 번 다 401 이다.
 */
function classifyStatus(status) {
  if (status === 401 || status === 403) return { reason: 'auth',   advance: false };
  if (status === 402)                   return { reason: 'quota',  advance: true };
  if (status === 429)                   return { reason: 'rate',   advance: true };
  if (status === 400 || status === 404) return { reason: 'model',  advance: true };
  if (status >= 500)                    return { reason: 'server', advance: true };
  return { reason: 'http', advance: true };
}

/*
 * 로그에 남기기 전에 키 모양을 지운다.
 *
 * 업스트림 본문이 우리 키를 되돌려 줄 이유는 없지만, 로그는 한 번 새면
 * 되돌릴 수 없다. 값싼 보험이다.
 */
function redact(s) {
  return String(s == null ? '' : s).replace(/sk-or-[A-Za-z0-9_-]+/g, 'sk-or-***');
}

/* ── 캐시 ─────────────────────────────────────────────────────────
 *
 * 같은 프롬프트는 같은 답을 낸다(temperature 가 낮다). 새로고침·같은 질문
 * 반복에서 호출 1회를 통째로 아낀다.
 *
 * ★ 기본값은 꺼짐(0)이다.
 *   프롬프트에는 그 시점의 가격이 박혀 있어서 가격이 바뀌면 키도 바뀐다.
 *   그래도 "같은 질문에 늘 한 글자도 같은 답" 은 상담으로서 어색할 수 있어,
 *   켜고 끄는 판단을 운영에 맡긴다. AI_CACHE_TTL_MS 로 켠다.
 */
const CACHE_MAX = 200;

function cacheTtl() {
  const n = Number(process.env.AI_CACHE_TTL_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 30 * 60 * 1000) : 0;
}

function cacheKey(role, messages, maxTokens, temperature) {
  return crypto.createHash('sha1')
    .update(`${role}|${maxTokens}|${temperature}|${JSON.stringify(messages)}`)
    .digest('hex');
}

function cacheGet(key, ttl, now) {
  if (!ttl) return null;
  const hit = state.cache.get(key);
  if (!hit) return null;
  if (now - hit.at > ttl) { state.cache.delete(key); return null; }
  return hit;
}

function cacheSet(key, ttl, value) {
  if (!ttl) return;
  // 가장 오래된 것부터 버린다. Map 은 넣은 순서를 지킨다.
  if (state.cache.size >= CACHE_MAX) {
    const oldest = state.cache.keys().next();
    if (!oldest.done) state.cache.delete(oldest.value);
  }
  state.cache.set(key, value);
}

/**
 * 모델 하나에 한 번 물어본다.
 *
 * @returns {{ok:boolean, text?:string, finish?:string, reason?:string, advance?:boolean}}
 */
async function attempt(model, opts, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  const body = {
    model,
    messages: opts.messages,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature
  };
  // reasoning:{enabled:false} 같은 공급자 옵션. 지원하지 않는 모델은 그냥 무시한다.
  if (opts.extra) Object.keys(opts.extra).forEach(k => { body[k] = opts.extra[k]; });

  let r;
  try {
    r = await fetch(ENDPOINT, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, reason: 'timeout', advance: true };
    console.warn(`[llm] ${model} 연결 실패: ${redact(e && e.message)}`);
    return { ok: false, reason: 'network', advance: true };
  } finally {
    clearTimeout(timer);
  }

  if (!r || !r.ok) {
    const status = (r && r.status) || 0;
    const cls = classifyStatus(status);
    let detail = '';
    try { detail = redact(String(await r.text()).slice(0, 200)); } catch (e) { detail = ''; }
    console.warn(`[llm] ${model} ${status} ${cls.reason}${detail ? ` — ${detail}` : ''}`);
    if (cls.reason === 'quota') state.paidBlockedUntil = Date.now() + PAID_BLOCK_MS;
    if (cls.reason === 'model') state.dead.set(model, Date.now() + DEAD_MODEL_MS);
    return { ok: false, reason: cls.reason, advance: cls.advance };
  }

  let data;
  try { data = await r.json(); }
  catch (e) {
    console.warn(`[llm] ${model} 응답 파싱 실패`);
    return { ok: false, reason: 'parse', advance: true };
  }

  const choice = ((data && data.choices) || [])[0] || {};
  const text = String(((choice.message || {}).content) || '');
  /*
   * 빈 답도 실패로 본다.
   *
   * 무료 모델에서 실제로 자주 나는 모양이다 — 200 을 주고 content 가 빈 문자열.
   * 성공으로 다루면 호출부가 "답변을 만들지 못했어요" 로 끝내 버린다.
   * 다음 모델에 물어보면 대개 답이 나온다.
   */
  if (!text.trim()) return { ok: false, reason: 'empty', advance: true };

  /*
   * ★ usage 는 provider 가 준 값을 그대로만 싣는다 (2026-09-01).
   *   OpenRouter 는 OpenAI 호환 형식으로 prompt_tokens / completion_tokens /
   *   total_tokens 를 준다. 없으면 null 이다 — 추정해서 채우지 않는다.
   *   답변 동작에는 관여하지 않는다(계측 전용).
   */
  const u = (data && data.usage) || null;
  const usage = u ? {
    inputTokens:  Number(u.prompt_tokens) || 0,
    outputTokens: Number(u.completion_tokens) || 0,
    totalTokens:  Number(u.total_tokens) || ((Number(u.prompt_tokens) || 0) + (Number(u.completion_tokens) || 0))
  } : null;

  return { ok: true, text, finish: String(choice.finish_reason || ''), usage };
}

/**
 * 사슬을 따라 답이 나올 때까지 물어본다.
 *
 * @param {object} opts
 *   role        'answer' | 'classify'
 *   messages    OpenRouter 메시지 배열
 *   maxTokens   출력 상한
 *   temperature
 *   extra       공급자 옵션 (선택)
 *   perCallMs   모델 하나당 타임아웃
 *   budgetMs    사슬 전체에 쓸 수 있는 시간
 *
 * @returns {{ok:boolean, text:string, finish:string, model:string,
 *            reason:string, tried:Array<{model:string, reason:string}>}}
 *   ok=false 일 때 reason 은 마지막 실패 이유다. 업스트림 원문은 담기지 않는다.
 */
async function chat(opts) {
  const o = opts || {};
  const role = o.role === 'classify' ? 'classify' : 'answer';
  const messages = Array.isArray(o.messages) ? o.messages : [];
  const maxTokens = Math.max(1, Number(o.maxTokens) || 900);
  const temperature = Number.isFinite(Number(o.temperature)) ? Number(o.temperature) : 0.2;
  const perCallMs = Math.max(1000, Number(o.perCallMs) || 25000);
  const budgetMs = Math.max(1000, Number(o.budgetMs) || perCallMs);

  const tried = [];
  if (!process.env.OPENROUTER_API_KEY) {
    return { ok: false, text: '', finish: '', model: '', reason: 'nokey', tried };
  }
  if (!messages.length) {
    return { ok: false, text: '', finish: '', model: '', reason: 'nomessages', tried };
  }

  const ttl = cacheTtl();
  const key = ttl ? cacheKey(role, messages, maxTokens, temperature) : '';
  const now0 = Date.now();
  const hit = cacheGet(key, ttl, now0);
  if (hit) {
    return { ok: true, text: hit.text, finish: hit.finish, model: hit.model, reason: 'cache', tried,
      // 캐시 히트는 토큰을 쓰지 않는다. usage 는 null 이고 cached 로 구분한다.
      cached: true, usage: null, costUsd: 0, latencyMs: Date.now() - now0 };
  }

  const deadline = now0 + budgetMs;
  const chain = usableChain(chainFor(role), now0);

  let last = 'none';
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    const remaining = deadline - Date.now();
    if (remaining < MIN_ATTEMPT_MS) {
      tried.push({ model, reason: 'budget' });
      last = 'budget';
      break;
    }

    const r = await attempt(model, { messages, maxTokens, temperature, extra: o.extra },
      Math.min(perCallMs, remaining));

    if (r.ok) {
      // 유료 모델이 성공했다 = 잔액이 돌아왔다. 건너뛰기를 즉시 푼다.
      if (!isFree(model)) state.paidBlockedUntil = 0;
      tried.push({ model, reason: 'ok' });
      cacheSet(key, ttl, { at: Date.now(), text: r.text, finish: r.finish, model });
      return { ok: true, text: r.text, finish: r.finish, model, reason: 'ok', tried,
        cached: false, usage: r.usage || null,
        costUsd: estimateCostUsd(model, r.usage), latencyMs: Date.now() - now0 };
    }

    tried.push({ model, reason: r.reason });
    last = r.reason;
    if (!r.advance) break;   // 키 문제 등 — 다음 모델도 같은 결과다
  }

  return { ok: false, text: '', finish: '', model: '', reason: last, tried };
}

/** 테스트가 프로세스 기억을 지우기 위해 부른다. */
function _reset() {
  state.paidBlockedUntil = 0;
  state.dead.clear();
  state.cache.clear();
}

module.exports = {
  chat, chainFor, isFree,
  DEFAULT_ANSWER_MODEL, DEFAULT_CLASSIFY_MODEL,
  FREE_ANSWER_CHAIN, FREE_CLASSIFY_CHAIN,
  MODEL_PRICES_USD_PER_1M, estimateCostUsd, isFreeModel,
  MAX_CHAIN, MIN_ATTEMPT_MS, PAID_BLOCK_MS, DEAD_MODEL_MS,
  _internal: { sanitizeModel, classifyStatus, usableChain, redact, cacheKey, state, _reset }
};
