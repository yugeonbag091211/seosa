#!/usr/bin/env node
/**
 * 무료 모델 벤치마크 — 사슬 순서를 "실측으로" 정하기 위한 도구.
 *
 *   node scripts/bench-free-models.js                 # 사슬에 있는 모델만
 *   node scripts/bench-free-models.js --all           # OpenRouter 무료 목록 전부
 *   node scripts/bench-free-models.js --json out.json
 *
 * ── 왜 있는가 ────────────────────────────────────────────────────
 *
 * api/_llm.js 의 사슬 순서는 주석에 근거를 적어 두었다. 그런데 무료 모델은
 * 조용히 바뀐다 — 어제 5/5 이던 모델이 오늘 빈 문자열을 준다. 실제로
 * 2026-09-02 재측정에서 1순위였던 nemotron-3-super 가 답변 대신 입력
 * 프롬프트를 되뱉는 것을 발견했다. 주석만 믿었으면 못 찾았다.
 *
 * 그래서 근거를 다시 만들 수 있는 형태로 남긴다. 사슬을 바꾸기 전에 이걸
 * 돌리고, 결과를 _llm.js 주석에 옮겨 적는다.
 *
 * ── 안전 ─────────────────────────────────────────────────────────
 *
 * · :free 로 끝나지 않는 모델은 호출 직전에 예외를 던진다 (비용 0원 보장)
 * · 요청 사이를 4.5초 띄운다 — 무료 티어는 분당 한도가 있고, 붙여 쏘면
 *   뒤쪽 모델이 전부 429 를 맞아 "나쁜 모델" 로 잘못 기록된다
 * · npm test 에 넣지 않는다. 네트워크를 쓰고 몇 분 걸린다.
 */
'use strict';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const KEY = process.env.OPENROUTER_API_KEY;
const GAP_MS = Number(process.env.BENCH_GAP_MS || 4500);

if (!KEY) { console.error('OPENROUTER_API_KEY 가 없다.'); process.exit(1); }

/** ★ 비용 방어선 — 유료 모델은 이 스크립트에서 절대 나가지 않는다. */
function guard(model) {
  if (!/:free$/.test(String(model))) {
    throw new Error(`ZERO-COST 위반: 무료가 아닌 모델을 부르려 했다 — ${model}`);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(model, messages, maxTokens, temperature, extra) {
  guard(model);
  const t0 = Date.now();
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ model, messages, max_tokens: maxTokens, temperature }, extra || {}))
  });
  const ms = Date.now() - t0;
  if (!r.ok) return { err: `${r.status} ${(await r.text()).slice(0, 80)}`, ms };
  const j = await r.json();
  const c = j.choices && j.choices[0];
  return { text: String((c && c.message && c.message.content) || '').trim(), ms,
    finish: c && c.finish_reason };
}

/* ── 문항 ────────────────────────────────────────────────────────
 *
 * 프롬프트는 api/ai.js 의 운영 프롬프트와 같은 모양이어야 한다. 다른 걸로
 * 재면 "우리 서비스에서 잘 하는가" 가 아니라 "일반적으로 똑똑한가" 를
 * 재게 된다. 그건 우리가 알고 싶은 게 아니다.
 */
const CLASSIFY_SYSTEM = [
  '너는 쇼핑 대화의 의도를 한 글자로 분류한다.',
  'A=상품 자체 질문  B=일반 지식·방법  C=상품 추천 요청  D=가격 판단  E=구매 시점',
  '출력은 "글자|검색어" 한 줄. 검색어가 없으면 글자만.'
].join('\n');

// 사용자가 요구한 질문 유형 전부를 담는다.
const CASES = [
  ['무선 이어폰 추천해줘', 'C', '단순 검색'],
  ['10만원 이하 무선 이어폰', 'C', '예산 조건'],
  ['20만원 이하 노이즈캔슬링 되고 배터리 오래가는 이어폰', 'C', '복합 조건'],
  ['에어팟이랑 갤럭시버즈 중에 뭐가 나아?', 'A', '비교'],
  ['지금 사도 될까?', 'E', '구매 판단'],
  ['이거 비싼 편이야?', 'D', '가격 판단'],
  ['러닝할 때 쓸 이어폰', 'C', '용도 기반'],
  ['뭔가 좋은 거 없나', 'C', '모호한 질문'],
  ['노트북은 어떻게 골라야 해?', 'B', '방법 질문'],
  ['방수 안 되는 건 빼줘', 'C', '부정 조건'],
  ['그거 말고 더 싼 거', 'C', '후속 질문'],
  ['아까 말한 것 중에 배터리 제일 오래가는 건?', 'A', '복합 후속']
];

const { ANSWER_SYSTEM, ANSWER_Q, badWon } = require('./bench-prompts');

const RE_REF = /\[?P[1-8]\]?/;   // 내부 꼬리표가 새는가

async function benchOne(model) {
  const row = { model, intentOk: 0, intentTotal: CASES.length, ms: [], errs: [], wrong: [] };

  for (const [q, want, label] of CASES) {
    const r = await call(model, [
      { role: 'system', content: CLASSIFY_SYSTEM }, { role: 'user', content: q }
    ], 32, 0, { reasoning: { enabled: false } });
    await sleep(GAP_MS);
    if (r.err) { row.errs.push(r.err); process.stdout.write('!'); continue; }
    row.ms.push(r.ms);
    const got = (r.text.match(/^\s*([A-E])/) || [])[1] || '∅';
    if (got === want) { row.intentOk++; process.stdout.write('.'); }
    else { row.wrong.push(`${label}: ${got}≠${want}`); process.stdout.write('x'); }
  }

  const a = await call(model, [
    { role: 'system', content: ANSWER_SYSTEM }, { role: 'user', content: ANSWER_Q }
  ], 900, 0.2, { reasoning: { enabled: false } });
  await sleep(GAP_MS);

  if (a.err) row.answer = { err: a.err, ms: a.ms };
  else row.answer = {
    len: a.text.length, ms: a.ms, finish: a.finish,
    badWon: badWon(a.text),                       // 지어낸 금액
    leaksRef: RE_REF.test(a.text),                // 내부 꼬리표 유출
    tradeoff: /포기|다만|대신|아쉬|단점|반면/.test(a.text),
    text: a.text.slice(0, 400)
  };
  return row;
}

async function freeModels() {
  const r = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${KEY}` } });
  const j = await r.json();
  return (j.data || []).map(m => m.id).filter(id => /:free$/.test(id)).sort();
}

(async () => {
  const args = process.argv.slice(2);
  const llm = require('../api/_llm');
  let models = args.indexOf('--all') >= 0
    ? await freeModels()
    : Array.from(new Set(llm.FREE_ANSWER_CHAIN.concat(llm.FREE_CLASSIFY_CHAIN)));

  models.forEach(guard);   // 하나라도 유료면 시작도 하지 않는다

  console.log(`무료 모델 벤치마크 — ${models.length}종 · 문항 ${CASES.length + 1} · 간격 ${GAP_MS}ms`);
  console.log(`예상 소요 약 ${Math.ceil(models.length * (CASES.length + 1) * GAP_MS / 60000)}분\n`);

  const rows = [];
  for (const m of models) {
    process.stdout.write(`${m.padEnd(46)} `);
    try { rows.push(await benchOne(m)); }
    catch (e) { console.log(` 오류 ${e.message}`); continue; }
    const x = rows[rows.length - 1], an = x.answer || {};
    console.log(` ${x.intentOk}/${x.intentTotal}  ${an.err ? an.err.slice(0, 24) : `${an.len}자 ${an.ms}ms`}`);
  }

  console.log('\n── 정리 (분류 정확도 순) ──');
  rows.sort((a, b) => b.intentOk - a.intentOk);
  for (const x of rows) {
    const a = x.answer || {};
    const med = x.ms.length ? x.ms.slice().sort((p, q) => p - q)[Math.floor(x.ms.length / 2)] : 0;
    const flags = [];
    if (a.err) flags.push('답변실패');
    if (a.badWon && a.badWon.length) flags.push(`지어낸금액 ${a.badWon.join(',')}`);
    if (a.leaksRef) flags.push('★꼬리표유출');
    if (a.len === 0) flags.push('★빈답변');
    if (a.tradeoff === false) flags.push('포기없음');
    console.log(`  ${x.model.padEnd(46)} ${String(x.intentOk + '/' + x.intentTotal).padEnd(6)} ` +
      `분류 ${String(med).padStart(5)}ms  답변 ${String(a.len || 0).padStart(4)}자  ${flags.join(' · ')}`);
    if (x.wrong.length) console.log(`      틀린 것: ${x.wrong.join(' | ')}`);
  }

  const i = args.indexOf('--json');
  if (i >= 0 && args[i + 1]) {
    require('fs').writeFileSync(args[i + 1], JSON.stringify(rows, null, 2));
    console.log(`\n${args[i + 1]} 에 적었다.`);
  }
})().catch(e => { console.error(e); process.exit(1); });
