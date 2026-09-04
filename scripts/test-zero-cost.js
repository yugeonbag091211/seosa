#!/usr/bin/env node
/**
 * ZERO-COST 보안 테스트 — "유료 API 비용이 0원인가" 를 코드로 증명한다.
 *
 *   node scripts/test-zero-cost.js
 *
 * ── 왜 이 파일이 있는가 (2026-09-02 감사) ─────────────────────────
 *
 * SEOSA 는 무료로 배포된다. 그런데 감사 시점의 운영은 그렇지 않았다.
 *
 *   · api/_llm.js chainFor() 의 기본 1순위 = anthropic/claude-sonnet-5 (유료)
 *   · 운영(Vercel)에 OPENROUTER_MODELS 가 없다 (.env.local 전수 확인)
 *   · 즉 로그인 사용자의 모든 AI 요청이 유료 모델을 먼저 호출하고 있었다
 *   · OpenRouter /api/v1/key 실측: is_free_tier=false, 누적 usage $9.79,
 *     limit=null(상한 없음) — 호출한 만큼 계속 과금되는 상태
 *
 * 정책을 바꾼 것만으로는 부족하다. **다음 사람이 되돌리지 못하게** 고정한다.
 * 여기서 FAIL 이 나면 그건 테스트가 틀린 게 아니라 돈이 새고 있다는 뜻이다.
 *
 * ── 안전성 ───────────────────────────────────────────────────────
 * 외부 호출 0회. fetch 를 가로채 "무엇을 부르려 했는지" 만 기록하고,
 * :free 가 아닌 모델을 부르려 하면 그 자리에서 테스트를 실패시킨다.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');

process.env.AUTH_SECRET = 'test-secret-zerocost';
process.env.OPENROUTER_API_KEY = 'sk-or-v1-TESTKEY';
delete process.env.OPENROUTER_MODELS;
delete process.env.OPENROUTER_CLASSIFY_MODELS;
delete process.env.OPENROUTER_MODEL;
delete process.env.OPENROUTER_CLASSIFY_MODEL;
delete process.env.OPENROUTER_ALLOW_PAID;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;

/* ── 가짜 Supabase (닿으면 실패) ─────────────────────────────── */
const supabasePath = path.resolve(ROOT, 'api', '_supabase.js');
const realLoad = Module._load;
Module._load = function (request) {
  if (request === './_supabase' || request === supabasePath) {
    return new Proxy({}, { get(_t, p) { if (p === 'then') return undefined; throw new Error('Supabase 접근'); } });
  }
  return realLoad.apply(this, arguments);
};

/* ── fetch 가로채기 — 부른 모델을 전부 기록한다 ─────────────── */
const called = [];        // { model, free }
let violation = null;     // 유료 호출 시도가 있었다면 여기에 남는다

global.fetch = async (url, opts) => {
  if (String(url).indexOf('openrouter.ai') < 0) {
    throw new Error(`오프라인 테스트에서 예상 밖 외부 호출: ${url}`);
  }
  const body = JSON.parse(opts.body);
  const free = /:free$/.test(String(body.model));
  called.push({ model: body.model, free });
  if (!free) violation = body.model;      // ★ 이 줄이 남으면 zero-cost 가 깨진 것이다
  const content = body.max_tokens >= 700 ? '추천드립니다.'
    : (body.max_tokens === 120 ? '{"q":"무선 이어폰","use":"","brand":"","avoid":""}' : 'C|무선 이어폰');
  return {
    ok: true, status: 200,
    json: async () => ({ choices: [{ finish_reason: 'stop', message: { content } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 } })
  };
};

/* ── 대역 ───────────────────────────────────────────────────── */
const http = require('../api/_http'); http.applyCors = () => true; http.noStore = () => {};
require('../api/_ratelimit').guard = () => true;
const auth = require('../api/_auth');
const plan = require('../api/_plan');
plan.resolvePlan = async () => ({ plan: 'pro', limit: 9999 });
plan.reserve = async () => ({ allowed: true, used: 1, degraded: false });
plan.release = async () => {};
plan.usagePayload = (p, u, l) => ({ plan: p, used: u, limit: l, remaining: l - u });
const shop = require('../api/_shop');
shop.searchAll = async () => ({
  items: [{ productId: '1001', mall: '쿠팡', title: 'QCY T13 무선 이어폰', lprice: 39900,
    link: 'https://link.coupang.com/a/1', image: '', isCoupang: true, oprice: 0, savePct: 0 }],
  allItems: [], from: 'api', blocked: false
});
shop.saveProducts = async () => {};
require('../api/_trust').attachTrust = async l => l;
require('../api/_pricestat').loadStats = async () => new Map();

const llm = require('../api/_llm');
const aiHandler = require('../api/ai.js');

/* ── 도구 ───────────────────────────────────────────────────── */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; failures.push(name); console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t) { console.log(`\n── ${t} ──`); }

function callAi(body, headers) {
  return new Promise((resolve, reject) => {
    let code = 200;
    const res = {
      status(c) { code = c; return this; }, setHeader() { return this; },
      json(payload) { resolve({ status: code, body: payload }); return this; },
      end() { resolve({ status: code, body: {} }); return this; }
    };
    Promise.resolve(aiHandler({ method: 'POST', headers: headers || {}, query: {}, body,
      socket: { remoteAddress: '10.0.0.9' } }, res)).catch(reject);
  });
}

(async () => {
  console.log('=== ZERO-COST 보안 테스트 (외부 호출 0회) ===');

  /* ══════════════════════════════════════════════════════════
     1. 정적 검사 — 소스에 유료 경로가 열려 있지 않은가
     ══════════════════════════════════════════════════════════ */
  section('1. 정적 — 유료 모델 문자열의 위치');
  {
    const files = fs.readdirSync(path.join(ROOT, 'api'))
      .filter(f => f.endsWith('.js'))
      .map(f => [f, fs.readFileSync(path.join(ROOT, 'api', f), 'utf-8')]);

    /*
     * 유료 모델 id 는 api/_llm.js 안에만 있어야 한다. 다른 파일이 모델 id 를
     * 직접 들고 있으면 사슬(과 그 가드)을 우회하는 경로가 생긴 것이다.
     */
    const PAID_RE = /['"](?:anthropic|openai|google|meta-llama|mistralai|deepseek|x-ai|cohere)\/[a-z0-9][\w.\-]*['"]/gi;
    const offenders = [];
    files.forEach(([name, src]) => {
      // 주석은 뺀다 — 설명에 이름이 나오는 것은 실행 경로가 아니다.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
      const hits = (code.match(PAID_RE) || []).filter(h => !/:free['"]$/.test(h));
      if (hits.length && name !== '_llm.js') offenders.push(`${name}: ${hits.join(', ')}`);
    });
    ok(offenders.length === 0, '★ 유료 모델 id 는 api/_llm.js 밖에 없다', offenders.join(' | ') || '없음');

    const llmSrc = fs.readFileSync(path.join(ROOT, 'api', '_llm.js'), 'utf-8');
    ok(/function allowPaid\(\)/.test(llmSrc), 'allowPaid() 가드가 존재한다');
    ok(/OPENROUTER_ALLOW_PAID/.test(llmSrc), '유료는 명시적 환경변수로만 열린다');
    ok(/paid-blocked/.test(llmSrc), 'attempt() 에 호출 직전 차단 경로가 있다');

    // ai.js 는 OpenRouter 를 직접 부르지 않는다 (부르면 가드를 우회한다).
    const aiSrc = fs.readFileSync(path.join(ROOT, 'api', 'ai.js'), 'utf-8');
    ok(aiSrc.indexOf('openrouter.ai/api/') === -1,
      '★ ai.js 는 OpenRouter 를 직접 호출하지 않는다 (전부 _llm 사슬을 지난다)');
  }

  /* ══════════════════════════════════════════════════════════
     2. 사슬 구성 — 환경변수가 하나도 없을 때
     ══════════════════════════════════════════════════════════ */
  section('2. 기본 사슬 (운영과 같은 조건: 관련 환경변수 없음)');
  {
    llm._internal._reset();
    const a = llm.chainFor('answer');
    const c = llm.chainFor('classify');
    ok(a.length > 0 && a.every(llm.isFree), '★★ 답변 사슬이 전부 무료다', a.join(' → '));
    ok(c.length > 0 && c.every(llm.isFree), '★★ 분류 사슬이 전부 무료다', c.join(' → '));
    ok(llm.allowPaid() === false, 'allowPaid() = false');
    ok(llm.stats().zeroCost === true, 'stats().zeroCost = true');
  }

  /* ══════════════════════════════════════════════════════════
     3. 잘못된 설정으로도 과금되지 않는가
     ══════════════════════════════════════════════════════════ */
  section('3. 설정 사고 — 유료 id 를 적어도 나가지 않는다');
  {
    llm._internal._reset();
    process.env.OPENROUTER_MODELS = 'anthropic/claude-sonnet-5';
    const before = called.length;
    const r = await llm.chat({ role: 'answer', messages: [{ role: 'user', content: '안녕' }],
      maxTokens: 900, temperature: 0.2 });
    const fired = called.slice(before);
    ok(fired.every(x => x.free), '★★ 유료 id 만 적어도 유료 호출이 나가지 않는다',
      fired.map(x => x.model).join(',') || '(호출 없음)');
    ok(r.ok === true, '그래도 답은 나온다 (무료 사슬로 되돌아간다)', r.model);
    delete process.env.OPENROUTER_MODELS;
  }
  {
    /*
     * 방어선 2 — chainFor 를 통과해 버린 유료 모델도 네트워크 직전에 막힌다.
     *
     * 실제로는 chainFor 가 이미 걸러내므로 이 상황은 나오지 않는다. 그래서
     * 여기서는 attempt() 를 직접 부른다. 뒷사람이 chainFor 를 손대다 필터를
     * 깨뜨려도 돈이 나가지 않는다는 것이 이 검사의 내용이다.
     */
    llm._internal._reset();
    const before = called.length;
    const r = await llm._internal.attempt('anthropic/claude-sonnet-5',
      { messages: [{ role: 'user', content: '안녕' }], maxTokens: 900, temperature: 0.2 }, 5000);
    const fired = called.slice(before);
    ok(fired.length === 0, '★★ 사슬을 뚫고 온 유료 모델도 네트워크로 나가지 않는다',
      fired.map(x => x.model).join(',') || '(호출 없음)');
    ok(r.ok === false && r.reason === 'paid-blocked', '차단 사유를 남긴다', r.reason);
    ok(r.advance === true, '차단해도 다음 모델로 넘어간다 (기능은 살아 있다)');
    ok(llm.stats().paidBlocked === 1, '차단 계수기가 올라간다', String(llm.stats().paidBlocked));
    ok(llm.stats().paidCalls === 0, '★ 유료 호출 0회', String(llm.stats().paidCalls));
  }

  /* ══════════════════════════════════════════════════════════
     4. 실제 요청 경로 — 로그인 · 게스트
     ══════════════════════════════════════════════════════════ */
  section('4. /api/ai 전 구간 — 부른 모델이 전부 무료인가');
  {
    llm._internal._reset();
    called.length = 0; violation = null;
    const token = auth.issueToken('qa@seosa.local');
    const r = await callAi(
      { question: '20만원 이하 무선 이어폰 추천해줘', contextProducts: [], chatHistory: [] },
      { authorization: 'Bearer ' + token });
    ok(r.status === 200, '로그인 요청 200', String(r.status));
    ok(violation === null, '★★ 유료 모델을 한 번도 부르지 않았다', violation || '없음');
    ok(called.length > 0 && called.every(x => x.free), '부른 모델이 전부 :free 다',
      called.map(x => x.model).join(','));
    ok(llm.stats().paidCalls === 0, '★★ stats().paidCalls = 0', String(llm.stats().paidCalls));
    ok(llm.stats().estimatedCostUsd === 0, '★★ 추정 비용 $0', String(llm.stats().estimatedCostUsd));
    console.log(`         (이 요청의 LLM 호출 ${called.length}회)`);
  }
  {
    llm._internal._reset();
    called.length = 0; violation = null;
    const r = await callAi({ question: '20만원 이하 무선 이어폰 추천해줘', contextProducts: [], chatHistory: [] });
    ok(r.status === 200 && r.body.guest === true, '게스트 요청 200', String(r.status));
    ok(called.length === 0, '★★ 게스트는 LLM 을 한 번도 부르지 않는다', String(called.length));
    ok(llm.stats().calls === 0, 'stats().calls = 0');
  }

  /* ══════════════════════════════════════════════════════════
     5. LLM 호출 수 — deterministic-first 가 실제로 줄이는가
     ══════════════════════════════════════════════════════════ */
  section('5. 요청당 LLM 호출 수');
  const token = auth.issueToken('qa@seosa.local');
  async function countCalls(body) {
    llm._internal._reset();
    called.length = 0;
    await callAi(body, { authorization: 'Bearer ' + token });
    return called.length;
  }
  {
    const n1 = await countCalls({ question: '20만원 이하 무선 이어폰 추천해줘', contextProducts: [], chatHistory: [] });
    ok(n1 === 1, '★★ 분명한 질문(히스토리 없음) → LLM 1회 (답변만)', `${n1}회`);

    const n2 = await countCalls({
      question: '대학생이 쓰기 좋은 노트북 추천해줘', contextProducts: [],
      chatHistory: [{ role: 'user', text: '무선 이어폰 추천해줘' }, { role: 'assistant', text: '…' }]
    });
    ok(n2 === 1, '★★ 분명한 질문(히스토리 있음) → LLM 1회 (예전 3회)', `${n2}회`);

    const n3 = await countCalls({ question: '안녕', contextProducts: [], chatHistory: [] });
    ok(n3 === 1, '잡담 → LLM 1회 (분류 호출 없음)', `${n3}회`);

    // 애매한 말은 여전히 LLM 분류를 쓴다 — 품질을 위해 남겨 둔 경로다.
    const n4 = await countCalls({
      question: '좀 더 싼 거', contextProducts: [],
      chatHistory: [{ role: 'user', text: '무선 이어폰 추천해줘' }, { role: 'assistant', text: '…' }]
    });
    ok(n4 >= 2, '애매한 후속 질문은 LLM 분류를 쓴다 (품질 유지)', `${n4}회`);
  }

  /* ══════════════════════════════════════════════════════════
     6. 무료 모델이 전부 죽어도 — 유료로 넘어가지 않는다
     ══════════════════════════════════════════════════════════ */
  section('6. 무료가 전부 실패해도 유료 fallback 이 없다');
  {
    llm._internal._reset();
    called.length = 0; violation = null;
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      const free = /:free$/.test(String(body.model));
      called.push({ model: body.model, free });
      if (!free) violation = body.model;
      return { ok: false, status: 429, text: async () => '{"error":"rate limited"}' };
    };
    const r = await callAi(
      { question: '20만원 이하 무선 이어폰 추천해줘', contextProducts: [], chatHistory: [] },
      { authorization: 'Bearer ' + token });
    global.fetch = realFetch;

    ok(violation === null, '★★ 무료가 전부 429 여도 유료로 넘어가지 않는다', violation || '없음');
    ok(llm.stats().paidCalls === 0, 'stats().paidCalls = 0');
    ok(r.status === 200, '그래도 사용자는 답을 받는다 (결정론 fallback)', String(r.status));
    ok(r.body && r.body.text && r.body.text.length > 0, '답변 본문이 비어 있지 않다',
      String((r.body.text || '').slice(0, 40)));
    ok(r.body && (r.body.items || []).length > 0, '찾아둔 상품 카드도 함께 나간다');
  }

  /* ══════════════════════════════════════════════════════════
     7. 최종 판정
     ══════════════════════════════════════════════════════════ */
  section('7. 최종 판정');
  {
    const s = llm.stats();
    ok(s.paidCalls === 0, 'Paid model reachable:  NO');
    ok(s.estimatedCostUsd === 0, 'Paid API fallback:     NO');
    ok(llm.allowPaid() === false, 'Production paid path:  NO');
  }

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
  if (fail) { console.log('실패: ' + failures.join(' | ')); process.exit(1); }
})().catch(e => { console.error('오류:', (e && e.stack) || e); process.exit(1); });
