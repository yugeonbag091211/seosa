/*
 * 예산의 범위 — 상품 전용 예산인가, 모든 상품의 예산인가 (api/_convstate.js, 2026-10-23 Codex 감사 CO-03).
 *
 * 재현된 정책 결함:
 *
 *   [1]  "30만원 이하 노트북 추천해줘."
 *   …    (상품 얘기가 없는 20턴)
 *   [21] "청소기 추천해줘."          ← 노트북 예산 30만원이 청소기에 걸렸다
 *
 * 여기서 확인하는 정책:
 *   1. 같은 상품을 이어 찾으면 예산을 유지한다.
 *   2. 종류가 분명히 다른 상품으로 바뀌면 상품 전용 예산은 거둔다(그리고 그 사실을 알린다).
 *   3. 사용자가 "모든 상품" 이라고 말한 예산은 상품이 바뀌어도 유지한다.
 *   4. 사용자의 예산 변경·해제는 같은 턴부터 반영한다.
 *   5. 브랜드·모델명만으로 바뀐 전환(노트북 → 맥북 프로)은 거두지 않는다 — 종류를 모르기 때문이다.
 *
 * 외부 호출 0회, DB 쓰기 0회, LLM 0회. 서명 상태를 실제로 만들고 검증해 왕복시킨다.
 */
'use strict';

process.env.AUTH_SECRET = 'offline-budget-scope-key';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;

const fs = require('fs');
const path = require('path');
const CS = require('../api/_convstate');
const AC = require('../api/_aicontext');

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); return; }
  fails.push(name);
  console.log(`  [FAIL] ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
}
function section(t) { console.log(`\n── ${t}`); }

/** 웹처럼 상태를 그대로 돌려주며 대화한다 (api/ai.js 의 resolve → createConversationState 왕복). */
function run(turns) {
  let hist = [];
  let token = '';
  const steps = [];
  turns.forEach((q, i) => {
    const conv = CS.resolve(AC.verifyConversationState(token), hist.slice(-10), q, { window: 6, textLimit: 450 });
    hist.push({ role: 'user', text: q });
    token = AC.createConversationState(conv.next);
    hist.push({ role: 'assistant', text: `답 ${i}` });
    steps.push({
      q,
      // api/ai.js 는 base 위에 이번 발화의 조건(turnCons)을 겹친다. 이어받은 예산은 base 쪽이다.
      base: conv.base ? conv.base.budgetMax : null,
      next: conv.next.constraints.budgetMax,
      scope: conv.next.budgetScope,
      forProduct: conv.next.budgetProduct,
      product: conv.next.product,
      dropped: conv.budgetDropped
    });
  });
  return steps;
}

const filler = Array.from({ length: 20 }, (_, i) => ['그래', '응', '알겠어', '고마워', '좋네'][i % 5]);

/* ================================================================== */
section('A. 상품 전용 예산 — 종류가 바뀌면 거둔다');
{
  const s = run(['30만원 이하 노트북 추천해줘', ...filler, '청소기 추천해줘']);
  const first = s[0];
  ok(first.next === 300000 && first.scope === '' && first.forProduct === '노트북',
    '예산을 말한 턴 — 상태에 "노트북의 예산" 으로 적힌다', first);

  const last = s[s.length - 1];
  ok(last.base === 0 && last.next === 0, '20턴 뒤 "청소기 추천해줘" — 노트북 예산 30만원을 걸지 않는다', last);
  ok(!!last.dropped && last.dropped.budget === 300000 && last.dropped.from === '노트북' && last.dropped.to === '청소기',
    '거둔 사실을 알린다 (budgetDropped — 조용히 넓히지 않는다)', last.dropped);
  ok(last.forProduct === '' && last.scope === '', '거둔 뒤 상태에는 예산의 상품이 남지 않는다', last);

  const mid = s[3];
  ok(mid.base === 300000 && !mid.dropped, '상품 얘기가 없는 중간 턴에서는 그대로 유지한다', mid);
}

/* ================================================================== */
section('B. 같은 상품을 이어 찾으면 유지한다');
{
  const s = run(['30만원 이하 노트북 추천해줘', ...filler, '게이밍 노트북으로 보여줘']);
  const last = s[s.length - 1];
  ok(last.base === 300000 && !last.dropped, '"게이밍 노트북" 은 좁히는 말이다 — 예산을 거두지 않는다', last);

  const narrow = run(['30만원 이하 무선청소기 추천해줘', ...filler, '로봇청소기도 보여줘']);
  const lastNarrow = narrow[narrow.length - 1];
  ok(lastNarrow.base === 300000 && !lastNarrow.dropped, '무선청소기 → 로봇청소기 — 같은 종류다', lastNarrow);

  const follow = run(['30만원 이하 노트북 추천해줘', '그중에 제일 싼 거', '조금 넘어도 괜찮아']);
  const lastFollow = follow[follow.length - 1];
  ok(lastFollow.next === 390000 && !lastFollow.dropped,
    '조건을 바꿔 말한 턴("조금 넘어도")을 상품 변경으로 오판하지 않는다', lastFollow);
}

/* ================================================================== */
section('C. 사용자가 모든 상품이라고 말한 예산은 유지한다');
{
  ['앞으로 모든 상품은 30만원 이하로만 추천해줘', '뭐든 30만원 이하로 찾아줘', '상품 상관없이 30만원 이하로 보여줘']
    .forEach(said => {
      const s = run([said, '노트북 추천해줘', ...filler, '청소기 추천해줘']);
      const last = s[s.length - 1];
      ok(last.base === 300000 && !last.dropped && last.scope === 'global',
        `전역 예산은 상품이 바뀌어도 남는다 — "${said.slice(0, 14)}…"`, last);
    });

  const local = run(['30만원 이하 노트북 추천해줘', '청소기 추천해줘']);
  ok(local[1].scope === '' && !!local[1].dropped, '같은 금액을 상품과 함께 말한 것은 전역이 아니다', local[1]);
}

/* ================================================================== */
section('D. 사용자의 변경·해제가 먼저다');
{
  const newCap = run(['30만원 이하 노트북 추천해줘', ...filler, '청소기는 10만원 이하로 추천해줘']);
  const last = newCap[newCap.length - 1];
  ok(last.next === 100000 && !last.dropped && last.forProduct === '청소기',
    '새 상품에 새 예산을 말하면 그 예산이다 (거둔 사실을 알리지 않는다)', last);

  const release = run(['30만원 이하 노트북 추천해줘', '예산은 상관없어', '청소기 추천해줘']);
  ok(release[1].next === 0 && release[1].scope === '', '"예산 상관없어" 로 거둔다', release[1]);
  ok(release[2].next === 0 && !release[2].dropped, '이미 거둔 예산을 다시 거뒀다고 알리지 않는다', release[2]);

  const raise = run(['30만원 이하 노트북 추천해줘', '50만원까지 올려줘']);
  ok(raise[1].next === 500000 && raise[1].forProduct === '노트북', '같은 상품의 예산 변경은 그대로 반영된다', raise[1]);
}

/* ================================================================== */
section('E. 거두지 않는 경우 — 종류를 모르는 전환');
{
  const s = run(['30만원 이하 노트북 추천해줘', ...filler, '맥북 프로 얼마야?']);
  const last = s[s.length - 1];
  ok(last.base === 300000 && !last.dropped,
    '브랜드·모델명만 바뀐 전환은 거두지 않는다 (맥북은 실제로 노트북이다 — gateBudget 이 거는지 판단한다)', last);
}

/* ================================================================== */
section('F. 상태 왕복 — 범위도 서명한다');
{
  const now = Date.now();
  const token = AC.createConversationState({
    product: '노트북', constraints: { budgetMax: 300000, budgetSaid: 300000 },
    excludedConditions: ['used'], absorbed: [], budgetScope: 'global', budgetProduct: '노트북', startedAt: now
  }, now);
  const v = AC.verifyConversationState(token, now);
  ok(!!v && v.budgetScope === 'global', '전역 범위가 서명·검증을 왕복한다', v && v.budgetScope);

  const token2 = AC.createConversationState({
    product: '노트북', constraints: { budgetMax: 300000 }, excludedConditions: [], absorbed: [],
    budgetScope: '', budgetProduct: '노트북', startedAt: now
  }, now);
  const v2 = AC.verifyConversationState(token2, now);
  ok(!!v2 && v2.budgetScope === '' && v2.budgetProduct === '노트북', '예산의 상품이 왕복한다', v2 && v2.budgetProduct);

  // 변조 — 범위를 global 로 바꿔치기하면 서명이 깨지고 상태 전체가 무시된다.
  const parts = token2.split('.');
  const body = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  body.bs = 'global';
  const forged = `${parts[0]}.${Buffer.from(JSON.stringify(body), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}.${parts[2]}`;
  ok(AC.verifyConversationState(forged, now) === null, '범위를 변조한 상태는 무시된다', forged.slice(0, 24));

  /*
   * 이 기능 전에 서명된 상태(범위 없음)에도 예산이 있다. 그 예산은 «그 상품의 예산» 으로 본다 —
   * 상태의 상품 구절이 예산의 상품이 된다.
   */
  const old = CS.resolve({ product: '노트북', constraints: { budgetMax: 300000, budgetSaid: 300000 },
    excludedConditions: [], absorbed: [CS.digest('30만원 이하 노트북 추천해줘')], startedAt: now },
  [{ role: 'user', text: '30만원 이하 노트북 추천해줘' }, { role: 'assistant', text: '답' }],
  '청소기 추천해줘', { window: 6, textLimit: 450 });
  ok(old.base.budgetMax === 0 && !!old.budgetDropped,
    '범위가 없는 옛 상태의 예산도 그 상품의 예산으로 보아 거둔다', old.budgetDropped);
}

/* ================================================================== */
section('G. api/ai.js 가 거둔 사실을 프롬프트에 싣는다');
{
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'api', 'ai.js'), 'utf8');
  ok(/P\.budgetScopeChanged\s*=\s*\(amount, from\)/.test(src), 'P.budgetScopeChanged 블록이 있다');
  ok(/conv\.budgetDropped && conv\.budgetDropped\.budget[\s\S]{0,260}P\.budgetScopeChanged\(/.test(src),
    '거둔 턴에만 그 블록을 붙인다');
  const block = (src.match(/P\.budgetScopeChanged = [\s\S]*?\]\.join\('\\n'\);/) || [''])[0];
  ok(/예산을 적용하지 않았다|적용하지 않았다/.test(block) && /되묻는다/.test(block),
    '적용하지 않았다는 사실과 되묻기를 지시한다');
  ok(/네가 정하지 마라|사용자가 말하지 않은 금액/.test(block), '모델이 새 예산을 지어내지 못하게 한다');
  ok(/budgetDropped: conv\.budgetDropped/.test(src), '조립본(_concierge)에도 거둔 사실을 넘긴다');
}

/* ================================================================== */
section('H. 조립본이 답할 때도 알린다 (_concierge)');
{
  /*
   * 2026-10-23 실호출에서 발견: 예산은 올바르게 거뒀는데 답이 조립본 경로로 나가
   * («확인된 상품·가격 데이터만 기준으로 정리했어요») 사용자에게 그 말이 닿지 않았다.
   */
  const CG = require('../api/_concierge');
  const ctx = {
    items: [{ title: '무선청소기 X10', lprice: 97895, mall: 'ADPICK' }],
    cards: [{ title: '무선청소기 X10', lprice: 97895 }],
    constraints: null, degraded: true, safety: true, search: 'found'
  };
  const withDrop = CG.compose(Object.assign({}, ctx, { budgetDropped: { budget: 300000, from: '노트북', to: '청소기' } })).text;
  ok(/300,000원/.test(withDrop) && /적용하지 않았어요/.test(withDrop) && /노트북/.test(withDrop),
    '거둔 금액과 그 상품을 밝히고 적용하지 않았다고 말한다', withDrop.split('\n').slice(0, 4));
  ok(/맞춰 드릴까요/.test(withDrop), '같은 금액으로 맞출지 되묻는다');
  ok(!/적용하지 않았어요/.test(CG.compose(ctx).text), '거두지 않은 턴에는 그 말이 없다');

  // 상품을 찾지 못한 답(식별 NONE)에서도 머리에 붙는다 — 예산을 왜 빼고 찾았는지가 그때도 필요하다.
  const none = CG.compose(Object.assign({}, ctx, {
    items: [], cards: [], identity: { state: 'NONE', label: '청소기' },
    budgetDropped: { budget: 300000, from: '노트북', to: '청소기' }
  })).text;
  ok(/적용하지 않았어요/.test(none), '상품을 못 찾은 답에도 붙는다', none.split('\n').slice(0, 4));
}

console.log(`\n=== 결과: ${pass}/${pass + fails.length} PASS ===`);
if (fails.length) {
  console.log('\n실패:');
  fails.forEach(f => console.log(`  - ${f}`));
  process.exit(1);
}
