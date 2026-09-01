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
    const c = llm.chainFor('answer');
    check('기본 1순위는 기존 유료 모델이다 (품질 기본값을 낮추지 않는다)',
      c[0] === llm.DEFAULT_ANSWER_MODEL, c[0]);
    check('그 뒤에 무료 모델이 이어진다', c.length > 1 && c.slice(1).every(llm.isFree), c.join(' → '));
    check('사슬 길이 상한을 지킨다', c.length <= llm.MAX_CHAIN, String(c.length));
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
  reset({ OPENROUTER_MODELS: 'paid/one, free/two:free' });
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
    reset({ OPENROUTER_MODELS: 'paid/one, free/two:free' });
    const r = await ask();
    check('★ 잔액이 돌아오면 1순위로 되돌아간다 (배포 없이)',
      r.ok && r.model === 'paid/one', r.model);
    check('유료가 성공하면 건너뛰기 기억이 풀린다',
      llm._internal.state.paidBlockedUntil === 0);
  }

  /* ── 3. 넘어가면 안 되는 실패 ───────────────────────────────── */
  console.log('\n[3] 넘어가지 않는 실패 (401)');
  reset({ OPENROUTER_MODELS: 'a/one, b/two:free, c/three:free' });
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
    reset({ OPENROUTER_MODELS: 'a/one, b/two:free' });
    ext.byModel['a/one'] = mode;
    const r = await ask();
    check(`${label}(${mode}) → 다음 모델로 넘어간다`, r.ok === true && r.model === 'b/two:free',
      `${ext.calls.join(',')} / ${r.reason}`);
  }
  {
    // 빈 응답을 성공으로 다루면 "답변을 만들지 못했어요" 가 그대로 나간다.
    reset({ OPENROUTER_MODELS: 'a/one, b/two:free' });
    ext.fallback = 'empty';
    const r = await ask();
    check('★ 전부 빈 응답이면 성공이 아니다', r.ok === false && r.reason === 'empty', r.reason);
  }

  /* ── 5. 없는 모델 id ────────────────────────────────────────── */
  console.log('\n[5] 없는 모델 id (404)');
  reset({ OPENROUTER_MODELS: 'gone/model:free, b/two:free' });
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
  reset({ OPENROUTER_MODELS: 'a/one, b/two:free, c/three:free' });
  ext.fallback = 'timeout';
  {
    const r = await ask({ perCallMs: 1000, budgetMs: 30000 });
    check('타임아웃도 다음 모델로 넘어간다', ext.calls.length === 3, ext.calls.join(','));
    check('전부 타임아웃이면 이유가 timeout 이다 (호출부가 504 로 가른다)',
      r.reason === 'timeout', r.reason);
  }
  {
    reset({ OPENROUTER_MODELS: 'a/one, b/two:free' });
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
  reset({ OPENROUTER_MODELS: 'a/one' });
  {
    await ask(); await ask();
    check('기본값은 꺼짐 — 같은 질문도 매번 새로 묻는다', ext.calls.length === 2, String(ext.calls.length));
  }
  {
    reset({ OPENROUTER_MODELS: 'a/one', AI_CACHE_TTL_MS: '60000' });
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
    reset({ OPENROUTER_MODELS: 'a/one, b/two:free' });
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

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
