#!/usr/bin/env node
/*
 * 모델 사슬 라우터 테스트 (api/_llm.js) — 완전 오프라인, 외부 호출 0회.
 *
 * ── 무엇을 고정하는가 ───────────────────────────────────────────
 *
 * 이 모듈이 있는 이유는 하나다: 모델 하나가 죽어도 AI 가 죽지 않게 하는 것.
 * 2026-08-28~29 운영에서 OpenRouter 잔액이 0이 되자 402 가 나면서 AI 기능이
 * 통째로 멈췄다. 여기서 고정하는 성질은 그 사고가 다시 나지 않는다는 것이다.
 *
 *   · 402 를 보면 다음 모델로 넘어간다 (그리고 한동안 유료 모델을 건너뛴다)
 *   · 401 을 보면 넘어가지 않는다 (같은 키라 물어봐야 소용없다)
 *   · 사슬이 길어도 요청 하나의 시간 예산을 넘기지 않는다
 *   · 업스트림 원문·API 키가 호출부나 로그로 새지 않는다
 *
 *   node scripts/test-llm-router.js
 */
'use strict';

const llm = require('../api/_llm');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}

/* ── 가짜 OpenRouter ────────────────────────────────────────────
 *
 * 모델 id 별로 응답을 정한다. 실제 호출은 한 번도 나가지 않는다.
 */
const ext = {
  byModel: {},      // model → 'ok' | 402 | 401 | 429 | 404 | 500 | 'empty' | 'badjson' | 'timeout'
  fallback: 'ok',
  calls: []         // 부른 모델 순서
};

global.fetch = async (url, opts) => {
  if (String(url).indexOf('openrouter.ai') < 0) {
    throw new Error(`오프라인 테스트에서 예상 밖 외부 호출: ${url}`);
  }
  const body = JSON.parse(opts.body);
  ext.calls.push(body.model);

  const mode = Object.prototype.hasOwnProperty.call(ext.byModel, body.model)
    ? ext.byModel[body.model] : ext.fallback;

  if (mode === 'timeout') {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    throw e;
  }
  if (typeof mode === 'number') {
    return {
      ok: false, status: mode,
      // 업스트림 원문에 키 모양을 섞어 둔다 — 로그·응답 어디로도 새면 안 된다.
      text: async () => `{"error":{"message":"Insufficient credits sk-or-v1-SECRETKEY123"}}`
    };
  }
  if (mode === 'badjson') {
    return { ok: true, status: 200, json: async () => { throw new Error('Unexpected token'); } };
  }
  const content = mode === 'empty' ? '' : `answered-by:${body.model}`;
  return {
    ok: true, status: 200,
    json: async () => ({ choices: [{ finish_reason: 'stop', message: { content } }] })
  };
};

function reset(env) {
  ext.byModel = {}; ext.fallback = 'ok'; ext.calls = [];
  llm._internal._reset();
  delete process.env.OPENROUTER_MODELS;
  delete process.env.OPENROUTER_CLASSIFY_MODELS;
  delete process.env.OPENROUTER_MODEL;
  delete process.env.OPENROUTER_CLASSIFY_MODEL;
  delete process.env.AI_CACHE_TTL_MS;
  /*
   * ZERO-COST 기본값 (2026-09-02). 유료 모델은 명시적 opt-in 없이는 호출되지
   * 않는다. 사슬 동작(넘어가기·건너뛰기)을 검사하는 케이스만 이 값을 켠다 —
   * 그 케이스들이 재는 것은 비용 정책이 아니라 라우팅 기계다.
   */
  delete process.env.OPENROUTER_ALLOW_PAID;
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-TESTKEY';
  Object.keys(env || {}).forEach(k => { process.env[k] = env[k]; });
}

const MSGS = [{ role: 'user', content: '안녕' }];
const ask = (o) => llm.chat(Object.assign({ role: 'answer', messages: MSGS, maxTokens: 900, temperature: 0.2 }, o));

(async () => {
  console.log('=== 모델 사슬 라우터 (오프라인) ===\n');

  /* ── 1. 사슬 구성 ───────────────────────────────────────────── */
  console.log('[1] 사슬 구성');
  reset();
  {
    /*
     * ★ 2026-09-02 정책 변경 — 기본값이 무료 전용이다.
     *
     * 예전 기대값은 "기본 1순위는 유료 모델" 이었다. 그런데 운영(Vercel)에는
     * OPENROUTER_MODELS 가 없어서, 그 기본값이 곧 "모든 요청이 유료 모델을
     * 먼저 호출한다" 를 뜻했다. 무료 배포 서비스에서 그건 사고다.
     * 이제 유료는 OPENROUTER_ALLOW_PAID=1 로만 열린다.
     */
    const c = llm.chainFor('answer');
    const cc = llm.chainFor('classify');
    check('★★ 기본 사슬은 무료 전용이다 (환경변수 없이도 비용 0원)',
      c.length > 0 && c.every(llm.isFree), c.join(' → '));
    check('★★ 분류 사슬도 무료 전용이다', cc.length > 0 && cc.every(llm.isFree), cc.join(' → '));
    check('기본값으로는 유료 모델이 사슬에 없다', c.indexOf(llm.DEFAULT_ANSWER_MODEL) < 0);
    check('allowPaid() 기본값은 거짓', llm.allowPaid() === false);
    check('사슬 길이 상한을 지킨다', c.length <= llm.MAX_CHAIN, String(c.length));
  }
  {
    // 유료 id 를 환경변수에 적어도 opt-in 없이는 사슬에 들어가지 않는다.
    reset({ OPENROUTER_MODELS: 'anthropic/claude-sonnet-5, free/two:free' });
    const c = llm.chainFor('answer');
    check('★ 환경변수의 유료 id 는 걸러진다 (오타·실수로 과금되지 않는다)',
      c.length === 1 && c[0] === 'free/two:free', c.join(' → '));
  }
  {
    // 무료가 하나도 안 남으면 기본 무료 사슬로 되돌린다 (아무것도 안 하는 것이 최악).
    reset({ OPENROUTER_MODELS: 'anthropic/claude-sonnet-5, openai/gpt-4o' });
    const c = llm.chainFor('answer');
    check('★ 전부 유료면 기본 무료 사슬로 되돌아간다', c.length > 0 && c.every(llm.isFree), c.join(' → '));
  }
  {
    reset({ OPENROUTER_ALLOW_PAID: '1' });
    const c = llm.chainFor('answer');
    check('opt-in 하면 유료 1순위가 되돌아온다', c[0] === llm.DEFAULT_ANSWER_MODEL, c[0]);
    check('그 뒤에 무료 모델이 이어진다', c.length > 1 && c.slice(1).every(llm.isFree), c.join(' → '));
  }
  {
    reset({ OPENROUTER_MODELS: 'a/b:free, 쓰레기!!, c/d:free, a/b:free' });
    const c = llm.chainFor('answer');
    check('★ 환경변수가 사슬 전체를 덮어쓴다 (무료만 적으면 비용 0원 운영)',
      c.length === 2 && c[0] === 'a/b:free' && c[1] === 'c/d:free', c.join(' → '));
    check('모양이 틀린 모델 id 는 버린다', c.indexOf('쓰레기!!') < 0);
    check('중복은 한 번만 남는다', c.length === 2, String(c.length));
  }
  {
    reset();
    const s = llm._internal.sanitizeModel;
    check('경로 조작 문자열은 통과하지 못한다', s('../../etc/passwd') === '' && s('a/b?x=1') === '');
    check('정상 id 는 통과한다', s('anthropic/claude-haiku-4.5') === 'anthropic/claude-haiku-4.5');
  }

  /* ── 2. 402 — 이 모듈이 존재하는 이유 ────────────────────────── */
  console.log('\n[2] 402 크레딧 부족');
  reset({ OPENROUTER_MODELS: 'paid/one, free/two:free', OPENROUTER_ALLOW_PAID: '1', AI_CACHE_TTL_MS: '0' });
  ext.byModel['paid/one'] = 402;
  {
    const r = await ask();
    check('★★ 유료가 402 여도 무료 모델로 넘어가 답을 만든다', r.ok === true, r.reason);
    check('답을 만든 모델을 알려준다', r.model === 'free/two:free', r.model);
    check('두 모델을 순서대로 불렀다', ext.calls.join(',') === 'paid/one,free/two:free', ext.calls.join(','));
    const blob = JSON.stringify(r);
    check('★ 업스트림 원문이 호출부로 새지 않는다', blob.indexOf('Insufficient credits') < 0);
    check('★ API 키 모양이 응답에 새지 않는다', blob.indexOf('sk-or-') < 0);
  }
  {
    // 같은 인스턴스의 다음 요청 — 402 를 기억해 유료를 건너뛴다.
    ext.calls = [];
    const r = await ask();
    check('★ 402 를 본 뒤에는 유료 모델을 건너뛴다 (헛걸음 제거)',
      ext.calls.length === 1 && ext.calls[0] === 'free/two:free', ext.calls.join(','));
    check('그래도 답은 나온다', r.ok === true);
  }
  {
    // 잔액이 돌아오면 다시 1순위로. (기억을 지우고 유료가 성공하는 상황)
    reset({ OPENROUTER_MODELS: 'paid/one, free/two:free', OPENROUTER_ALLOW_PAID: '1' });
    const r = await ask();
    check('★ 잔액이 돌아오면 1순위로 되돌아간다 (배포 없이)',
      r.ok && r.model === 'paid/one', r.model);
    check('유료가 성공하면 건너뛰기 기억이 풀린다',
      llm._internal.state.paidBlockedUntil === 0);
  }

  /* ── 3. 넘어가면 안 되는 실패 ───────────────────────────────── */
  console.log('\n[3] 넘어가지 않는 실패 (401)');
  reset({ OPENROUTER_MODELS: 'a/one, b/two:free, c/three:free', OPENROUTER_ALLOW_PAID: '1' });
  ext.fallback = 401;
  {
    const r = await ask();
    check('★ 키가 잘못되면 다음 모델을 부르지 않는다 (같은 키라 소용없다)',
      ext.calls.length === 1, ext.calls.join(','));
    check('실패 이유는 우리가 만든 코드다', r.reason === 'auth', r.reason);
  }

  /* ── 4. 넘어가는 실패들 ─────────────────────────────────────── */
  console.log('\n[4] 넘어가는 실패');
  for (const [mode, label] of [[429, '분당 한도'], [500, '업스트림 장애'],
                               ['empty', '빈 응답'], ['badjson', '파싱 불가']]) {
    reset({ OPENROUTER_MODELS: 'a/one, b/two:free', OPENROUTER_ALLOW_PAID: '1' });
    ext.byModel['a/one'] = mode;
    const r = await ask();
    check(`${label}(${mode}) → 다음 모델로 넘어간다`, r.ok === true && r.model === 'b/two:free',
      `${ext.calls.join(',')} / ${r.reason}`);
  }
  {
    // 빈 응답을 성공으로 다루면 "답변을 만들지 못했어요" 가 그대로 나간다.
    reset({ OPENROUTER_MODELS: 'a/one, b/two:free', OPENROUTER_ALLOW_PAID: '1' });
    ext.fallback = 'empty';
    const r = await ask();
    check('★ 전부 빈 응답이면 성공이 아니다', r.ok === false && r.reason === 'empty', r.reason);
  }

  /* ── 5. 없는 모델 id ────────────────────────────────────────── */
  console.log('\n[5] 없는 모델 id (404)');
  reset({ OPENROUTER_MODELS: 'gone/model:free, b/two:free', AI_CACHE_TTL_MS: '0' });
  ext.byModel['gone/model:free'] = 404;
  {
    await ask();
    ext.calls = [];
    await ask();
    check('★ 없는 모델은 기억해 두고 다음 요청에서 건너뛴다',
      ext.calls.length === 1 && ext.calls[0] === 'b/two:free', ext.calls.join(','));
  }

  /* ── 6. 시간 예산 ───────────────────────────────────────────── */
  console.log('\n[6] 시간 예산');
  reset({ OPENROUTER_MODELS: 'a/one, b/two:free, c/three:free', OPENROUTER_ALLOW_PAID: '1' });
  ext.fallback = 'timeout';
  {
    const r = await ask({ perCallMs: 1000, budgetMs: 30000 });
    check('타임아웃도 다음 모델로 넘어간다', ext.calls.length === 3, ext.calls.join(','));
    check('전부 타임아웃이면 이유가 timeout 이다 (호출부가 504 로 가른다)',
      r.reason === 'timeout', r.reason);
  }
  {
    reset({ OPENROUTER_MODELS: 'a/one, b/two:free', OPENROUTER_ALLOW_PAID: '1' });
    const r = await ask({ budgetMs: 100 });
    check('★ 남은 시간이 없으면 아예 부르지 않는다 (함수가 매달리지 않게)',
      ext.calls.length === 0 && r.reason === 'budget', `${ext.calls.length}회 / ${r.reason}`);
  }

  /* ── 7. 키 없음 ─────────────────────────────────────────────── */
  console.log('\n[7] 키 없음');
  reset();
  delete process.env.OPENROUTER_API_KEY;
  {
    const r = await ask();
    check('★ 키가 없으면 한 번도 부르지 않는다', ext.calls.length === 0, String(ext.calls.length));
    check('이유를 알려준다', r.reason === 'nokey', r.reason);
  }

  /* ── 8. 캐시 ────────────────────────────────────────────────── */
  console.log('\n[8] 중복 질문 캐시');
  {
    /*
     * ★ 2026-09-02 정책 변경 — 캐시 기본값이 켜짐이다.
     *
     * 예전 기본값은 꺼짐이었다(유료 모델 시절, "같은 질문에 늘 같은 답" 이
     * 어색하다는 이유). 무료 전용으로 가면 아끼는 대상이 돈이 아니라
     * free-models-per-min 한도로 바뀐다 — 실측에서 실제로 429 를 받았다.
     */
    reset({ OPENROUTER_MODELS: 'a/one', OPENROUTER_ALLOW_PAID: '1' });
    await ask(); await ask();
    check('★★ 기본값은 켜짐 — 같은 프롬프트는 호출 한 번으로 끝난다 (분당 한도 보호)',
      ext.calls.length === 1, String(ext.calls.length));
  }
  {
    // 명시적으로 0 을 주면 끈다 (실패 경로를 재는 테스트가 그렇게 쓴다).
    reset({ OPENROUTER_MODELS: 'a/one', AI_CACHE_TTL_MS: '0', OPENROUTER_ALLOW_PAID: '1' });
    await ask(); await ask();
    check('AI_CACHE_TTL_MS=0 이면 매번 새로 묻는다', ext.calls.length === 2, String(ext.calls.length));
  }
  {
    reset({ OPENROUTER_MODELS: 'a/one', AI_CACHE_TTL_MS: '60000', OPENROUTER_ALLOW_PAID: '1' });
    const r1 = await ask();
    const r2 = await ask();
    check('★ 켜면 같은 프롬프트는 호출 없이 답한다', ext.calls.length === 1, String(ext.calls.length));
    check('캐시된 답이 원래 답과 같다', r1.text === r2.text && r2.reason === 'cache', r2.reason);

    const before = ext.calls.length;
    await llm.chat({ role: 'answer', messages: [{ role: 'user', content: '다른 질문' }],
      maxTokens: 900, temperature: 0.2 });
    check('다른 프롬프트는 캐시를 쓰지 않는다', ext.calls.length === before + 1);
  }

  /* ── 9. 로그 위생 ───────────────────────────────────────────── */
  console.log('\n[9] 로그 위생');
  {
    const red = llm._internal.redact('오류: sk-or-v1-abcdef123456 로 요청함');
    check('★ 로그에 남기기 전 키 모양을 지운다', red.indexOf('abcdef123456') < 0, red);
  }
  {
    reset({ OPENROUTER_MODELS: 'a/one, b/two:free', OPENROUTER_ALLOW_PAID: '1' });
    ext.fallback = 402;
    const seen = [];
    const realWarn = console.warn;
    console.warn = (...a) => { seen.push(a.join(' ')); };
    await ask();
    console.warn = realWarn;
    check('★ 실패 로그에도 키가 남지 않는다', seen.join('\n').indexOf('SECRETKEY123') >= 0
      ? seen.join('\n').indexOf('sk-or-v1-SECRETKEY123') < 0 : true, seen.length + '줄');
    check('어떤 모델이 왜 실패했는지는 남는다',
      seen.some(l => l.indexOf('a/one') >= 0 && l.indexOf('quota') >= 0), seen[0]);
  }

  /* ── 10. 재시도 정책 — 같은 모델을 두 번 부르지 않는다 ────────
   *
   * 무료 모델은 분당 한도가 있다. 실패했다고 같은 모델을 다시 부르면 한도를
   * 더 빨리 태우고, 재시도 자체가 장애를 길게 만든다. 여기서 고정하는 것:
   * 사슬은 각 모델을 정확히 한 번씩만 지난다. 재시도 0회, 상한은 MAX_CHAIN.
   */
  console.log('');
  console.log('[10] 재시도 정책 (모델당 1회)');
  {
    reset({ OPENROUTER_MODELS: 'a/one:free, b/two:free, c/three:free', AI_CACHE_TTL_MS: '0' });
    ext.fallback = 500;                       // 전부 실패시킨다
    const r = await ask();
    const uniq = new Set(ext.calls);
    check('★★ 전부 실패해도 같은 모델을 두 번 부르지 않는다',
      uniq.size === ext.calls.length, ext.calls.join(','));
    check('사슬 길이만큼만 부른다 (무한 재시도 없음)',
      ext.calls.length <= llm.MAX_CHAIN, ext.calls.length + '회 / 상한 ' + llm.MAX_CHAIN);
    check('전부 실패하면 실패로 끝난다 (조용히 반복하지 않는다)', r.ok === false, r.reason);
  }
  {
    /*
     * 시간 예산이 없으면 아예 부르지 않는다 — 사용자를 기다리게 하지 않는다.
     * (가짜 fetch 는 즉시 답하므로 "중간에 예산이 떨어지는" 상황은 여기서
     *  만들 수 없다. 예산 게이트가 있다는 것만 고정한다.)
     */
    reset({ OPENROUTER_MODELS: 'a/one:free, b/two:free, c/three:free', AI_CACHE_TTL_MS: '0' });
    const r2 = await ask({ budgetMs: 1 });
    check('★ 시간 예산이 없으면 한 번도 부르지 않는다', ext.calls.length === 0, ext.calls.join(',') || '(호출 없음)');
    check('그 경우 이유를 budget 으로 알린다', r2.ok === false && r2.reason === 'budget', r2.reason);
  }

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
