#!/usr/bin/env node
/*
 * 출시 전 안정화 테스트 — O4(정기결제) / O7(인증 시도 원자성) / OpenRouter 오류 처리.
 *
 *   node scripts/test-release.js
 *
 * ── 안전성 ───────────────────────────────────────────────────────────
 * 실제 결제 0회 / 실제 토스 호출 0회 / 실제 OpenRouter 호출 0회 /
 * 운영 Supabase 접근 0회 / 메일 발송 0회.
 *
 * OpenRouter 는 지금 402(크레딧 부족)라 실제 호출이 아무것도 검증하지 못한다.
 * 그래서 fetch 를 가로채 응답을 만들어 넣는다 — 402 도 그중 하나로 다룬다.
 * 크레딧 부족 자체는 코드로 풀 문제가 아니다. 여기서 확인하는 것은
 * "업스트림이 어떤 식으로 실패하든 사용자 쿼터가 손해를 보지 않는가" 뿐이다.
 */
'use strict';

const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');

process.env.AUTH_SECRET = 'test-secret-release';
process.env.TOSS_SECRET_KEY = 'test_sk_FAKE_FOR_TESTS_ONLY';
process.env.TOSS_CLIENT_KEY = 'test_ck_FAKE_FOR_TESTS_ONLY';
process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;

/* ------------------------------------------------------------------ *
 *  가짜 Supabase
 *
 *  ★ 왜 await 지점을 일부러 두는가 (O7 의 핵심)
 *
 *  동시성 버그는 "읽고 → 판단하고 → 쓰는" 사이에 다른 요청이 끼어들 때 난다.
 *  JS 는 단일 스레드라 그 틈이 await 지점에만 생긴다. 그래서 select 와 update 를
 *  각각 한 틱씩 쉬게 만들어야 실제 DB 왕복과 같은 인터리빙이 재현된다.
 *  그렇게 하지 않으면 잘못된 코드도 테스트를 통과해 버린다.
 *
 *  반대로 rpc 는 "SQL 한 문장" 이므로 틈 없이 처리한다 — Postgres 의
 *  UPDATE ... WHERE 가 행 잠금으로 직렬화하는 것과 같은 성질이다.
 * ------------------------------------------------------------------ */
const tick = () => new Promise(r => setImmediate(r));

const db = {
  subscriptions: [],
  payments: [],
  auth_codes: [],
  ai_usage: []
};
const rpcCalls = [];

function resetDb() {
  db.subscriptions = []; db.payments = []; db.auth_codes = []; db.ai_usage = [];
  rpcCalls.length = 0;
}

function cmpVal(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

const fakeSupabase = {
  from(table) {
    const eqs = [], ins = [], nots = [], ltes = [];
    let sort = null, cap = null, patch = null, mode = '';

    const match = r =>
      eqs.every(([c, v]) => String(r[c]) === String(v))
      && ins.every(([c, vs]) => vs.map(String).indexOf(String(r[c])) > -1)
      && nots.every(([c]) => r[c] !== null && r[c] !== undefined)
      && ltes.every(([c, v]) => cmpVal(r[c], v) <= 0);

    const q = {
      select() { return q; },
      eq(c, v) { eqs.push([c, v]); return q; },
      in(c, vs) { ins.push([c, vs]); return q; },
      not(c) { nots.push([c]); return q; },
      lte(c, v) { ltes.push([c, v]); return q; },
      order(c, o) { sort = { col: c, asc: !o || o.ascending !== false }; return q; },
      limit(n) { cap = n; return q; },
      update(p) { mode = 'update'; patch = p; return q; },
      async maybeSingle() {
        await tick();                       // DB 왕복 — 여기서 다른 요청이 끼어든다
        return { data: (db[table] || []).filter(match)[0] || null, error: null };
      },
      async insert(row) {
        await tick();
        const dup = (db[table] || []).some(r =>
          (row.order_id !== undefined && r.order_id === row.order_id)
          || (row.payment_key !== undefined && r.payment_key === row.payment_key));
        if (dup) return { error: { code: '23505', message: 'duplicate key' } };
        db[table].push(Object.assign({}, row));
        return { error: null };
      },
      async upsert(row, opts) {
        await tick();
        const key = (opts && opts.onConflict) || 'email';
        const i = (db[table] || []).findIndex(r => String(r[key]) === String(row[key]));
        if (i > -1) db[table][i] = Object.assign({}, db[table][i], row);
        else db[table].push(Object.assign({}, row));
        return { error: null };
      },
      async delete() {
        await tick();
        db[table] = (db[table] || []).filter(r => !match(r));
        return { error: null };
      },
      then(resolve, reject) {
        return tick().then(() => {
          let rows = (db[table] || []).filter(match);
          if (mode === 'update') {
            rows.forEach(r => Object.assign(r, patch));
            return { data: rows.map(r => Object.assign({}, r)), error: null };
          }
          if (sort) rows = rows.slice().sort((a, b) => (sort.asc ? 1 : -1) * cmpVal(a[sort.col], b[sort.col]));
          if (cap !== null) rows = rows.slice(0, cap);
          return { data: rows, error: null };
        }).then(resolve, reject);
      }
    };
    // delete() 는 eq() 뒤에 오므로 체이닝을 위해 별도 래핑
    const withDelete = Object.assign(q, {
      delete() {
        return {
          eq(c, v) {
            eqs.push([c, v]);
            return tick().then(() => {
              db[table] = (db[table] || []).filter(r => !match(r));
              return { error: null };
            });
          }
        };
      }
    });
    return withDelete;
  },

  /*
   * RPC = SQL 한 문장. 중간에 await 를 두지 않는다.
   * 이것이 Postgres 의 UPDATE ... WHERE 가 주는 원자성을 흉내 낸 것이다.
   */
  rpc(name, args) {
    rpcCalls.push({ name, args });

    if (name === 'auth_code_attempt') {
      const row = db.auth_codes.find(r => r.email === args.p_email);
      if (!row) return Promise.resolve({ data: [{ allowed: false, matched: false, attempt_count: args.p_max, expired: false }], error: null });
      if ((row.attempts || 0) >= args.p_max) {
        return Promise.resolve({ data: [{ allowed: false, matched: false, attempt_count: row.attempts, expired: false }], error: null });
      }
      row.attempts = (row.attempts || 0) + 1;          // ← 증가와 판정이 한 덩어리
      if (new Date(row.expires_at).getTime() < Date.now()) {
        return Promise.resolve({ data: [{ allowed: false, matched: false, attempt_count: row.attempts, expired: true }], error: null });
      }
      const matched = row.code_hash === args.p_hash;
      if (matched) db.auth_codes = db.auth_codes.filter(r => r.email !== args.p_email);
      return Promise.resolve({ data: [{ allowed: true, matched, attempt_count: row.attempts, expired: false }], error: null });
    }

    if (name === 'ai_quota_reserve') {
      let row = db.ai_usage.find(r => r.email === args.p_email && r.usage_date === args.p_date);
      if (!row) { row = { email: args.p_email, usage_date: args.p_date, used: 0 }; db.ai_usage.push(row); }
      if (row.used >= args.p_limit) return Promise.resolve({ data: [{ allowed: false, used: row.used }], error: null });
      row.used++;
      return Promise.resolve({ data: [{ allowed: true, used: row.used }], error: null });
    }

    if (name === 'ai_quota_release') {
      const row = db.ai_usage.find(r => r.email === args.p_email && r.usage_date === args.p_date);
      if (row && row.used > 0) row.used--;
      return Promise.resolve({ data: null, error: null });
    }

    return Promise.resolve({ data: null, error: null });
  }
};

function inject(rel, exportsObj) {
  const p = require.resolve(path.join(ROOT, rel));
  require.cache[p] = new Module(p, null);
  require.cache[p].filename = p;
  require.cache[p].loaded = true;
  require.cache[p].exports = exportsObj;
}
inject('api/_supabase.js', fakeSupabase);

/* ------------------------------------------------------------------ *
 *  가짜 외부 API (토스 + OpenRouter)
 * ------------------------------------------------------------------ */
const ext = {
  charges: [],
  tossPayments: {},
  failCharge: false,
  /*
   * 승인 요청은 토스에 도달했는데 우리가 응답을 못 받은 상태.
   * = 카드에는 청구됐을 수 있는데 우리 서버는 모른다. 이중 청구가 나는 자리다.
   */
  timeoutCharge: false,
  /** 'ok' | '402' | '429' | '500' | 'timeout' | 'malformed' */
  aiMode: 'ok',
  aiCalls: 0
};
function resetExt() {
  ext.charges = []; ext.tossPayments = {}; ext.failCharge = false; ext.timeoutCharge = false;
  ext.aiMode = 'ok'; ext.aiCalls = 0;
  /*
   * LLM 응답 캐시를 비운다 (2026-09-02 캐시 기본값 ON 이후 필수).
   *
   * 아래 시나리오들은 업스트림을 일부러 402·429·500·timeout 으로 만들고
   * 사용자에게 오류가 제대로 전달되는지 본다. 캐시가 남아 있으면 앞 시나리오의
   * 성공 응답이 그대로 나와서, 실패를 검사하는 시나리오가 통째로 무력해진다.
   */
  try { require('../api/_llm')._internal._reset(); } catch (e) { /* 없으면 그만 */ }
}

global.fetch = async function (url, opts = {}) {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : {};
  const json = (status, data) => ({
    ok: status < 400, status,
    json: async () => data,
    text: async () => JSON.stringify(data)
  });

  /* ── OpenRouter ────────────────────────────────────────────────── */
  if (u.indexOf('openrouter.ai') > -1) {
    ext.aiCalls++;
    if (ext.aiMode === 'timeout') {
      const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e;
    }
    if (ext.aiMode === '402') {
      return json(402, { error: { message: 'Insufficient credits. This account never purchased credits.' } });
    }
    if (ext.aiMode === '429') return json(429, { error: { message: 'Rate limit exceeded' } });
    if (ext.aiMode === '500') return json(500, { error: { message: 'Internal Server Error' } });
    if (ext.aiMode === 'malformed') {
      return { ok: true, status: 200, json: async () => { throw new Error('Unexpected token'); }, text: async () => '<html>' };
    }
    // 분류기 호출과 본답변을 구분한다 (max_tokens 로 판별).
    const isClassifier = body.max_tokens && body.max_tokens <= 32;
    const content = isClassifier ? 'A|' : '안녕하세요. 무엇을 도와드릴까요?';
    return json(200, { choices: [{ message: { content } }] });
  }

  /* ── 토스 ──────────────────────────────────────────────────────── */
  if (u.endsWith('/v1/billing/authorizations/issue')) {
    return json(200, { billingKey: 'bk_test', customerKey: body.customerKey });
  }
  if (/\/v1\/billing\/[^/]+$/.test(u)) {
    if (ext.failCharge) return json(402, { code: 'REJECT_CARD_COMPANY', message: 'declined' });
    if (ext.timeoutCharge) {
      // 토스는 받아서 승인까지 했다. 우리만 응답을 못 받았다.
      const tk = 'pk_' + body.orderId;
      ext.tossPayments[tk] = { paymentKey: tk, orderId: body.orderId, totalAmount: body.amount, status: 'DONE' };
      ext.charges.push(body);
      const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e;
    }
    const pk = 'pk_' + body.orderId;
    const p = { paymentKey: pk, orderId: body.orderId, totalAmount: body.amount, status: 'DONE' };
    ext.tossPayments[pk] = p;
    ext.charges.push(body);
    return json(200, p);
  }
  const byOrder = u.match(/\/v1\/payments\/orders\/([^/]+)$/);
  if (byOrder) {
    const p = Object.values(ext.tossPayments).find(x => x.orderId === decodeURIComponent(byOrder[1]));
    return p ? json(200, p) : json(404, { code: 'NOT_FOUND_PAYMENT', message: 'no such payment' });
  }
  return json(404, { code: 'UNKNOWN', message: u });
};

const billing = require(path.join(ROOT, 'api/_billing.js'));
const plan = require(path.join(ROOT, 'api/_plan.js'));
const auth = require(path.join(ROOT, 'api/_auth.js'));
const aiHandler = require(path.join(ROOT, 'api/ai.js'));
const { kstToday } = require(path.join(ROOT, 'api/_kst.js'));

/* ------------------------------------------------------------------ *
 *  유틸
 * ------------------------------------------------------------------ */
const results = {};
let current = null;
function suite(id, title) {
  current = id;
  results[id] = results[id] || { pass: 0, fail: 0 };
  console.log(`\n${'─'.repeat(66)}\n${id} — ${title}\n${'─'.repeat(66)}`);
}
function check(ok, label, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined && detail !== '' ? '  — ' + detail : ''}`);
  ok ? results[current].pass++ : results[current].fail++;
  return ok;
}
function note(m) { console.log(`        ${m}`); }

const USER = 'sub@example.com';
const daysFromNow = n => new Date(Date.now() + n * 86400000).toISOString();

function subRow(over) {
  return Object.assign({
    email: USER, plan: 'pro', status: 'active',
    expires_at: daysFromNow(1), billing_key: 'bk_test',
    customer_key: billing.customerKeyFor(USER),
    renew_failures: 0, last_renew_at: null, provider: 'toss'
  }, over || {});
}
const subOf = e => db.subscriptions.find(r => r.email === e);

function mkRes() {
  return {
    code: 200, payload: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(b) { this.payload = b; return this; },
    end() { return this; }
  };
}

/* ================================================================== *
 *  O4 — 정기결제
 * ================================================================== */
async function runO4() {
  suite('O4', '정기결제 — 서버/DB 기준으로만 PRO 를 판단한다');

  /* O4-1. 신규 구독은 갱신 대상이 아니다 (만료가 한참 남았다) */
  resetDb(); resetExt();
  db.subscriptions.push(subRow({ expires_at: daysFromNow(29) }));
  {
    const { rows } = await billing.dueForRenewal(new Date());
    check(rows.length === 0, '만료가 먼 구독은 긁지 않는다', `${rows.length}건`);
    check(ext.charges.length === 0, '청구 0회');
  }

  /* O4-2. 만료가 임박하면 대상이 된다 */
  resetDb(); resetExt();
  db.subscriptions.push(subRow({ expires_at: daysFromNow(1) }));
  {
    const { rows } = await billing.dueForRenewal(new Date());
    check(rows.length === 1, '만료 임박 구독이 대상', `${rows.length}건`);
  }

  /* O4-3. 결제 성공 → 기간 연장 + 실패 카운터 초기화 */
  resetDb(); resetExt();
  db.subscriptions.push(subRow({ expires_at: daysFromNow(1), renew_failures: 2 }));
  {
    const before = subOf(USER).expires_at;
    const r = await billing.renewDueSubscriptions({}, new Date());
    check(r.renewed === 1 && r.failed === 0, '갱신 성공 1건', JSON.stringify({ renewed: r.renewed, failed: r.failed }));
    check(ext.charges.length === 1, '토스 승인 1회', String(ext.charges.length));
    check(ext.charges[0].amount === billing.PRO_PRICE, '금액은 서버 상수 ★', String(ext.charges[0].amount));
    check(subOf(USER).expires_at > before, '만료일이 연장됐다');
    check(subOf(USER).renew_failures === 0, '실패 카운터가 0 으로 초기화된다', String(subOf(USER).renew_failures));
    const pay = db.payments[0];
    check(pay && pay.status === 'paid', '갱신 결제도 원장에 paid 로 남는다', pay && pay.status);
  }

  /* O4-4. 결제 실패 → 기간 그대로, 실패 카운터 증가 */
  resetDb(); resetExt(); ext.failCharge = true;
  db.subscriptions.push(subRow({ expires_at: daysFromNow(1) }));
  {
    const before = subOf(USER).expires_at;
    const r = await billing.renewDueSubscriptions({}, new Date());
    check(r.failed === 1 && r.renewed === 0, '갱신 실패 1건', JSON.stringify({ renewed: r.renewed, failed: r.failed }));
    check(subOf(USER).expires_at === before, '만료일을 늘리지 않는다 ★');
    check(subOf(USER).renew_failures === 1, '실패 카운터 증가', String(subOf(USER).renew_failures));
    check(db.payments[0].status === 'failed', '원장에 failed 로 남는다', db.payments[0].status);
  }

  /* O4-5. 재시도 간격 — 방금 시도한 구독은 다시 긁지 않는다 */
  resetDb(); resetExt();
  db.subscriptions.push(subRow({ expires_at: daysFromNow(1), last_renew_at: new Date().toISOString() }));
  {
    const { rows } = await billing.dueForRenewal(new Date());
    check(rows.length === 0, '방금 시도한 구독은 건너뛴다 ★ (카드사 거절 누적 방지)', `${rows.length}건`);
  }

  /* O4-6. 실패 상한 도달 → 다음 청구를 끊는다 */
  resetDb(); resetExt(); ext.failCharge = true;
  db.subscriptions.push(subRow({
    expires_at: daysFromNow(1),
    renew_failures: billing.MAX_RENEW_FAILURES - 1
  }));
  {
    const r = await billing.renewDueSubscriptions({}, new Date());
    check(r.gaveUp === 1, '상한 도달로 포기', String(r.gaveUp));
    check(subOf(USER).billing_key === null, 'billing_key 를 지워 다음 청구를 끊는다 ★');
    check(subOf(USER).status === 'active', '남은 기간은 그대로 쓴다 (즉시 강등하지 않는다)');
  }

  /* O4-7. 실패 상한을 넘긴 구독은 애초에 대상이 아니다 */
  resetDb(); resetExt();
  db.subscriptions.push(subRow({ expires_at: daysFromNow(1), renew_failures: billing.MAX_RENEW_FAILURES }));
  {
    const { rows } = await billing.dueForRenewal(new Date());
    check(rows.length === 0, '상한을 넘긴 구독은 긁지 않는다', `${rows.length}건`);
  }

  /* O4-8. 해지된 구독(billing_key 없음)은 갱신하지 않는다 */
  resetDb(); resetExt();
  db.subscriptions.push(subRow({ expires_at: daysFromNow(1), billing_key: null }));
  {
    const { rows } = await billing.dueForRenewal(new Date());
    check(rows.length === 0, '해지 구독은 대상이 아니다 ★', `${rows.length}건`);
    const r = await billing.renewOne(subRow({ billing_key: null }), {}, new Date());
    check(!r.ok && /빌링키/.test(r.reason), '직접 불러도 거부한다', r.reason);
    check(ext.charges.length === 0, '청구 0회');
  }

  /* O4-9. FREE / inactive 구독은 갱신하지 않는다 */
  resetDb(); resetExt();
  db.subscriptions.push(subRow({ email: 'free@example.com', plan: 'free', expires_at: daysFromNow(1) }));
  db.subscriptions.push(subRow({ email: 'off@example.com', status: 'inactive', expires_at: daysFromNow(1) }));
  {
    const { rows } = await billing.dueForRenewal(new Date());
    check(rows.length === 0, 'plan=free / status=inactive 는 대상이 아니다', `${rows.length}건`);
  }

  /* O4-10. 만료 → 결제 없이는 PRO 가 아니다 (서버 판정) */
  {
    const expired = billing.publicSubscription({ plan: 'pro', status: 'active', expires_at: daysFromNow(-1) });
    check(expired.plan === 'pro', '표시상 plan 은 pro 지만');
    const resolved = plan.resolvePlanFromRow({ plan: 'pro', status: 'active', expires_at: daysFromNow(-1) });
    check(resolved.plan === 'free', '권한 판정은 FREE 로 떨어진다 ★', resolved.reason);
    check(resolved.limit === plan.FREE_DAILY_AI_LIMIT, '한도도 FREE', String(resolved.limit));
  }

  /* O4-11. 해지 — 남은 기간은 유지, 다음 결제만 중단 */
  resetDb(); resetExt();
  db.subscriptions.push(subRow({ expires_at: daysFromNow(10) }));
  {
    const r = await billing.cancelSubscription(USER, new Date());
    check(r.ok, '해지 성공');
    check(subOf(USER).billing_key === null, 'billing_key 제거 → 다음 결제 없음 ★');
    check(subOf(USER).status === 'active', '남은 기간은 계속 PRO');
    const pub = billing.publicSubscription(subOf(USER));
    check(pub.canceled === true, '프론트에 "갱신 안 함" 으로 나간다');
  }

  /* O4-12. 권한 회수 — 환불 시 즉시 FREE */
  resetDb(); resetExt();
  db.subscriptions.push(subRow({ expires_at: daysFromNow(10) }));
  {
    await billing.deactivate(USER, new Date());
    check(subOf(USER).plan === 'free' && subOf(USER).status === 'inactive', '환불 시 즉시 강등 ★');
    const resolved = plan.resolvePlanFromRow(subOf(USER));
    check(resolved.plan === 'free', '권한 판정도 FREE');
  }

  /* O4-13. 재활성화 — 만료된 구독을 다시 결제하면 지금부터 30일 */
  resetDb(); resetExt();
  db.subscriptions.push(subRow({ expires_at: daysFromNow(-5), billing_key: null, plan: 'free', status: 'inactive' }));
  {
    const now = new Date();
    const act = await billing.activatePro(USER, { billingKey: 'bk_new', customerKey: 'ck', now });
    check(act.ok, '재활성화 성공');
    const exp = Date.parse(act.expiresAt);
    const expected = now.getTime() + billing.PERIOD_DAYS * 86400000;
    check(Math.abs(exp - expected) < 2000, '만료가 지났으면 지금부터 30일 ★',
      new Date(exp).toISOString().slice(0, 10));
    check(subOf(USER).plan === 'pro' && subOf(USER).status === 'active', 'PRO 로 복귀');
  }

  /* O4-14. 기간이 남아 있으면 그 뒤로 30일을 더한다 */
  resetDb(); resetExt();
  {
    const now = new Date();
    const remain = new Date(now.getTime() + 10 * 86400000).toISOString();
    db.subscriptions.push(subRow({ expires_at: remain }));
    const act = await billing.activatePro(USER, { customerKey: 'ck', now });
    const expected = Date.parse(remain) + billing.PERIOD_DAYS * 86400000;
    check(Math.abs(Date.parse(act.expiresAt) - expected) < 2000,
      '남은 기간 뒤로 30일 (갱신이 일찍 돌아도 손해 없음) ★');
  }

  /* O4-15. 중복 billing — 같은 실행에서 두 번 긁지 않는다 */
  resetDb(); resetExt();
  db.subscriptions.push(subRow({ expires_at: daysFromNow(1) }));
  {
    await billing.renewDueSubscriptions({}, new Date());
    const chargesAfterFirst = ext.charges.length;
    // 갱신 직후 다시 돌린다 — last_renew_at 때문에 대상에서 빠져야 한다.
    const r2 = await billing.renewDueSubscriptions({}, new Date());
    check(r2.attempted === 0, '연달아 돌려도 두 번 긁지 않는다 ★', `${r2.attempted}건 시도`);
    check(ext.charges.length === chargesAfterFirst, '청구 횟수 그대로', String(ext.charges.length));
  }

  /* O4-16. 잘못된 사용자 — 이메일 없는 행은 처리하지 않는다 */
  {
    const r = await billing.renewOne({ billing_key: 'bk' }, {}, new Date());
    check(!r.ok && /이메일/.test(r.reason), '이메일 없는 행은 거부', r.reason);
  }

  /* O4-17. 잘못된 금액 — 토스가 다른 금액을 돌려주면 확정하지 않는다 */
  resetDb(); resetExt();
  db.subscriptions.push(subRow({ expires_at: daysFromNow(1) }));
  {
    const fakeToss = {
      chargeBilling: async (bk, body, idem) => ({
        ok: true,
        data: { paymentKey: 'pk_x', orderId: body.orderId, totalAmount: 100, status: 'DONE' }
      })
    };
    const before = subOf(USER).expires_at;
    const r = await billing.renewOne(subOf(USER), { toss: fakeToss }, new Date());
    check(!r.ok && /금액/.test(r.reason), '금액 불일치는 거부 ★', r.reason);
    check(subOf(USER).expires_at === before, '기간을 늘리지 않는다');
    check(db.payments[0].status === 'failed', '원장은 failed', db.payments[0].status);
  }

  /* O4-18. 갱신 승인 타임아웃 — failed 로 굳히지 않는다 (이중 청구 방지) ★ */
  resetDb(); resetExt(); ext.timeoutCharge = true;
  db.subscriptions.push(subRow({ expires_at: daysFromNow(1) }));
  {
    const before = subOf(USER).expires_at;
    const r = await billing.renewDueSubscriptions({}, new Date());
    check(r.renewed === 0 && r.failed === 1, '타임아웃은 성공으로 치지 않는다', JSON.stringify({ renewed: r.renewed, failed: r.failed }));
    check(subOf(USER).expires_at === before, '결과를 모르는 채로 기간을 늘리지 않는다');
    check(db.payments.length === 1 && db.payments[0].status === 'charging',
      '원장은 charging 으로 남는다 ★ (failed 로 굳히면 다음 실행이 새 주문으로 또 긁는다)',
      db.payments[0] && db.payments[0].status);
  }

  /* O4-19. 다음 실행 — 토스에 재조회해서 재승인 없이 확정한다 ★ */
  {
    ext.timeoutCharge = false;
    const chargesAfterTimeout = ext.charges.length;
    const before = subOf(USER).expires_at;
    // 하루 뒤 (last_renew_at 간격 통과)
    const nextDay = new Date(Date.now() + 86400000);
    const r = await billing.renewDueSubscriptions({}, nextDay);
    check(ext.charges.length === chargesAfterTimeout,
      '★ 두 번째 청구가 나가지 않는다 (이중 청구 없음)',
      `청구 ${ext.charges.length}회`);
    check(r.renewed === 1, '이미 승인돼 있던 결제로 갱신을 확정한다', JSON.stringify({ renewed: r.renewed, failed: r.failed }));
    check(db.payments.length === 1 && db.payments[0].status === 'paid',
      '원장이 paid 로 확정된다', db.payments[0] && db.payments[0].status);
    check(subOf(USER).expires_at > before, '그제서야 기간이 연장된다');
    check(subOf(USER).renew_failures === 0, '실패 카운터가 정리된다', String(subOf(USER).renew_failures));
  }

  /* O4-20. 타임아웃이었지만 토스에 결제가 없던 경우 — 정상적으로 새로 긁는다 */
  resetDb(); resetExt();
  db.subscriptions.push(subRow({ expires_at: daysFromNow(1) }));
  {
    // 청구가 토스에 닿지 않은 채 끊긴 상황을 원장으로 재현한다.
    db.payments.push({
      email: USER, order_id: 'seosa_lost_order', payment_key: 'pending_seosa_lost_order',
      amount: billing.PRO_PRICE, currency: 'KRW', status: 'charging', provider: 'toss',
      raw_status: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    });
    const r = await billing.renewDueSubscriptions({}, new Date());
    const lost = db.payments.find(p => p.order_id === 'seosa_lost_order');
    check(lost && lost.status === 'failed', '토스에 없는 주문(404)은 failed 로 정리한다', lost && lost.status);
    check(r.renewed === 1, '그 뒤 정상적으로 새로 긁어 갱신한다', JSON.stringify({ renewed: r.renewed }));
    check(ext.charges.length === 1, '청구는 정확히 1회', String(ext.charges.length));
  }

  /* O4-21. 조회 자체가 실패하면 긁지 않는다 (fail closed) ★ */
  resetDb(); resetExt();
  db.subscriptions.push(subRow({ expires_at: daysFromNow(1) }));
  {
    db.payments.push({
      email: USER, order_id: 'seosa_unknown_order', payment_key: 'pending_seosa_unknown_order',
      amount: billing.PRO_PRICE, currency: 'KRW', status: 'charging', provider: 'toss',
      raw_status: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    });
    const flakyToss = {
      getPaymentByOrderId: async () => ({ ok: false, status: 500, data: {}, error: 'TOSS_DOWN: 일시 오류' }),
      chargeBilling: async () => { throw new Error('여기까지 오면 안 된다'); }
    };
    const r = await billing.renewOne(subOf(USER), { toss: flakyToss }, new Date());
    check(!r.ok && /확인 실패/.test(r.reason), '미결 주문을 확인 못 하면 새로 긁지 않는다 ★', r.reason);
    check(ext.charges.length === 0, '청구 0회', String(ext.charges.length));
    const still = db.payments.find(p => p.order_id === 'seosa_unknown_order');
    check(still && still.status === 'charging', 'charging 그대로 둔다 (다음 실행이 다시 물어본다)', still && still.status);
  }
}

/* ================================================================== *
 *  O7 — 인증 코드 시도 원자성
 * ================================================================== */
async function runO7() {
  suite('O7', '인증 코드 — 동시 요청으로 시도 횟수 제한을 우회할 수 없다');

  const EMAIL = 'victim@example.com';
  const RIGHT = '123456';
  const MAX = auth.MAX_ATTEMPTS;

  function seedCode() {
    resetDb();
    db.auth_codes.push({
      email: EMAIL,
      // hashCode 는 내부 함수라 노출되지 않는다. 실제 발급 경로를 그대로 쓴다.
      code_hash: null,
      expires_at: new Date(Date.now() + 10 * 60000).toISOString(),
      attempts: 0,
      created_at: new Date().toISOString()
    });
  }

  /* 실제 해시를 얻으려면 createCode 를 태워야 한다 */
  async function seedRealCode() {
    resetDb();
    const made = await auth.createCode(EMAIL);
    if (!made.ok) throw new Error('코드 발급 실패: ' + made.error);
    return made.code;
  }

  /* O7-1. 정상 동작 확인 */
  {
    const code = await seedRealCode();
    const r = await auth.consumeCode(EMAIL, code);
    check(r.ok === true, '올바른 코드는 통과한다');
    check(db.auth_codes.length === 0, '성공하면 코드를 즉시 폐기한다 ★ (재사용 방지)');
  }

  /* O7-2. 사용한 코드는 다시 쓸 수 없다 */
  {
    const code = await seedRealCode();
    await auth.consumeCode(EMAIL, code);
    const again = await auth.consumeCode(EMAIL, code);
    check(!again.ok, '같은 코드 재사용 거부 ★', again.error);
  }

  /* O7-3. 순차 오입력 — 정확히 MAX 회까지만 시도할 수 있다 */
  {
    await seedRealCode();
    const outcomes = [];
    for (let i = 0; i < MAX + 5; i++) outcomes.push(await auth.consumeCode(EMAIL, '000000'));
    const overLimit = outcomes.filter(o => /초과/.test(o.error || '')).length;
    check(overLimit === 5, `${MAX}회 뒤부터는 "시도 횟수 초과"`, `초과 응답 ${overLimit}건`);
    const row = db.auth_codes.find(r => r.email === EMAIL);
    check(row && row.attempts === MAX, `DB attempts 가 정확히 ${MAX}`, String(row && row.attempts));
  }

  /* O7-4. ★ 동시 10건 — 정확히 MAX 회만 소비되어야 한다 */
  {
    await seedRealCode();
    const N = 10;
    const rs = await Promise.all(
      Array.from({ length: N }, () => auth.consumeCode(EMAIL, '000000')));
    const mismatch = rs.filter(o => /일치하지/.test(o.error || '')).length;
    const blocked = rs.filter(o => /초과/.test(o.error || '')).length;
    const row = db.auth_codes.find(r => r.email === EMAIL);

    check(mismatch === MAX, `동시 ${N}건 중 정확히 ${MAX}건만 시도로 소비된다 ★`, `소비 ${mismatch}건`);
    check(blocked === N - MAX, `나머지 ${N - MAX}건은 차단된다`, `차단 ${blocked}건`);
    check(row && row.attempts === MAX, `최종 DB count 가 정확히 ${MAX} ★`, String(row && row.attempts));
    check(rs.every(o => !o.ok), '동시 요청 중 어느 것도 통과하지 않는다');
  }

  /* O7-5. 동시 요청 중 하나가 정답이어도 시도 상한은 지켜진다 */
  {
    const code = await seedRealCode();
    const attempts = ['000000', '111111', code, '222222', '333333', '444444', '555555'];
    const rs = await Promise.all(attempts.map(c => auth.consumeCode(EMAIL, c)));
    const ok = rs.filter(o => o.ok).length;
    check(ok === 1, '정답 1건만 통과한다 ★', `통과 ${ok}건`);
    check(db.auth_codes.length === 0, '통과 후 코드가 폐기된다');
  }

  /* O7-6. 만료된 코드는 통과하지 않는다 */
  {
    const code = await seedRealCode();
    db.auth_codes[0].expires_at = new Date(Date.now() - 1000).toISOString();
    const r = await auth.consumeCode(EMAIL, code);
    check(!r.ok && /만료/.test(r.error), '만료 코드 거부', r.error);
  }

  /* O7-7. 구현이 원자적 경로를 쓰는지 (정적) */
  {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(ROOT, 'api/_auth.js'), 'utf8');
    check(/rpc\('auth_code_attempt'/.test(src),
      'consumeCode 가 auth_code_attempt RPC 를 쓴다 ★');
    const usedRpc = rpcCalls.some(c => c.name === 'auth_code_attempt');
    check(usedRpc, '실제 호출 경로에서도 RPC 를 탄다', `RPC 호출 ${rpcCalls.filter(c => c.name === 'auth_code_attempt').length}회`);
  }

  /* O7-8. 마이그레이션 전 환경 — 폴백이 동작하되 위험을 로그로 알린다 */
  note('※ RPC 가 없는 환경에서는 예전 방식으로 폴백하며 경고를 남긴다.');
  note('   그 상태는 동시 요청에 취약하므로 마이그레이션 적용이 전제다.');
}

/* ================================================================== *
 *  OpenRouter — 실패 처리와 쿼터 복구 (실제 호출 0회)
 * ================================================================== */
async function runAI() {
  suite('AI', 'OpenRouter 실패 처리 — 장애가 사용자 쿼터를 태우지 않는다');

  const EMAIL = 'ai@example.com';
  const token = auth.issueToken(EMAIL);
  const today = kstToday();

  function aiReq(question) {
    return {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token },
      query: {},
      body: { question },
      socket: { remoteAddress: '10.9.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250) }
    };
  }
  const usedNow = () => {
    const r = db.ai_usage.find(x => x.email === EMAIL && x.usage_date === today);
    return r ? r.used : 0;
  };

  async function callAi(mode, question) {
    resetDb(); resetExt();
    ext.aiMode = mode;
    const res = mkRes();
    await aiHandler(aiReq(question || '안녕하세요'), res);
    return res;
  }

  /* AI-1. 정상 응답 — 쿼터 1회 소비 */
  {
    const res = await callAi('ok');
    check(res.payload && typeof res.payload.text === 'string' && res.payload.text.length > 0,
      '정상 응답에 본문이 있다', String(res.code));
    check(usedNow() === 1, '쿼터 1회 소비', String(usedNow()));
    check(res.payload.usage && res.payload.usage.plan === 'free', '사용량이 응답에 실린다');
  }

  /* AI-2. ★ 402 크레딧 부족 — 쿼터를 되돌린다 */
  {
    const res = await callAi('402');
    check(res.code === 500, '사용자에게는 500 (업스트림 상태를 그대로 노출하지 않는다)', String(res.code));
    check(usedNow() === 0, '차감했던 쿼터를 복구한다 ★', String(usedNow()));
    const blob = JSON.stringify(res.payload);
    check(blob.indexOf('Insufficient credits') === -1, '"Insufficient credits" 가 새지 않는다 ★');
    check(blob.indexOf('OpenRouter') === -1, '공급자 이름이 새지 않는다 ★');
    check(blob.indexOf('402') === -1, '업스트림 상태코드가 새지 않는다');
    check(/다시 시도/.test(res.payload.text || ''), '사람 말로 안내한다', res.payload.text);
    check(res.payload.usage && res.payload.usage.used === 0, 'usage 도 복구된 값으로 나간다',
      String(res.payload.usage && res.payload.usage.used));
  }

  /* AI-3. 429 — 쿼터 복구 */
  {
    const res = await callAi('429');
    check(res.code === 500, '429 도 사용자에게는 일반 오류', String(res.code));
    check(usedNow() === 0, '쿼터 복구 ★', String(usedNow()));
    check(JSON.stringify(res.payload).indexOf('Rate limit') === -1, '업스트림 문구가 새지 않는다');
  }

  /* AI-4. 500 — 쿼터 복구 */
  {
    const res = await callAi('500');
    check(res.code === 500, '업스트림 500', String(res.code));
    check(usedNow() === 0, '쿼터 복구 ★', String(usedNow()));
  }

  /* AI-5. timeout — 504 + 쿼터 복구 */
  {
    const res = await callAi('timeout');
    check(res.code === 504, 'timeout → 504', String(res.code));
    check(usedNow() === 0, '쿼터 복구 ★', String(usedNow()));
    check(/시간|다시/.test(res.payload.text || ''), '사람 말로 안내한다', res.payload.text);
  }

  /* AI-6. malformed 응답 — 죽지 않고 쿼터 복구 */
  {
    const res = await callAi('malformed');
    check(res.code === 500, '파싱 불가 응답도 처리한다', String(res.code));
    check(usedNow() === 0, '쿼터 복구 ★', String(usedNow()));
  }

  /* AI-7. 한도 초과 — 업스트림을 아예 부르지 않는다 */
  {
    resetDb(); resetExt();
    db.ai_usage.push({ email: EMAIL, usage_date: today, used: plan.FREE_DAILY_AI_LIMIT });
    const res = mkRes();
    await aiHandler(aiReq('안녕'), res);
    check(res.code === 429, '한도 초과 → 429', String(res.code));
    check(ext.aiCalls === 0, '한도를 넘으면 OpenRouter 를 한 번도 부르지 않는다 ★', `${ext.aiCalls}회`);
    check(res.payload.upgradeRequired === true, 'FREE 사용자에게 업그레이드를 안내한다');
  }

  /*
   * AI-8. 비로그인 — 게스트 조립본(200), 업스트림 호출 없음 (2026-09-02 계약 변경)
   *
   * 예전 계약은 "토큰 없음 → 401" 이었다. 이제 토큰이 아예 없으면 LLM 을
   * 부르지 않는 결정론 답변을 200 으로 준다(api/ai.js 게스트 모드). 지켜야
   * 할 성질은 그대로다 — 익명 호출로 요금이 한 푼도 나가지 않는다.
   * 토큰이 "있는데 틀린" 경우는 여전히 401 이다 (재인증 안내).
   */
  {
    resetDb(); resetExt();
    const res = mkRes();
    await aiHandler({ method: 'POST', headers: {}, query: {}, body: { question: '안녕' }, socket: { remoteAddress: '10.9.1.1' } }, res);
    check(res.code === 200, '토큰 없음 → 200 게스트 응답', String(res.code));
    check(res.payload && res.payload.guest === true, '응답에 guest:true 가 실린다');
    check(ext.aiCalls === 0, '익명 호출로 요금이 나가지 않는다 ★');
    check(usedNow() === 0, '게스트는 쿼터를 쓰지 않는다 ★', String(usedNow()));
  }
  {
    resetDb(); resetExt();
    const res = mkRes();
    await aiHandler({ method: 'POST', headers: { authorization: 'Bearer v1.bad.token' }, query: {}, body: { question: '안녕' }, socket: { remoteAddress: '10.9.1.2' } }, res);
    check(res.code === 401, '틀린 토큰 → 401 (게스트로 떨어뜨리지 않는다) ★', String(res.code));
    check(ext.aiCalls === 0, '틀린 토큰으로도 요금이 나가지 않는다');
  }

  /* AI-9. 빈 질문 — 쿼터를 깎지 않는다 */
  {
    resetDb(); resetExt();
    const res = mkRes();
    await aiHandler(aiReq('   '), res);
    check(res.code === 400, '빈 질문 → 400', String(res.code));
    check(usedNow() === 0, '사용자 잘못이 아닌 입력 오류로 쿼터를 깎지 않는다 ★', String(usedNow()));
    check(ext.aiCalls === 0, '업스트림 호출 없음');
  }

  note('※ OpenRouter 크레딧 부족(402)은 코드 문제가 아니다. 위 테스트가 확인하는 것은');
  note('   "크레딧이 없어도 사용자 쿼터가 손해를 보지 않는가" 뿐이다.');
}


/* ================================================================== *
 *  MIG — 마이그레이션 미적용 상태에서의 동작
 *
 *  ★ 이건 가상의 상황이 아니라 지금 운영 상태다.
 *
 *  2026-08-24 확인: subscriptions.last_renew_at / renew_failures 없음,
 *  auth_code_attempt() RPC 없음, price_drop_top 뷰 미적용.
 *  코드는 이미 배포될 수 있으므로, 스키마가 따라오기 전 구간에서
 *  "조용히 잘못되는" 것이 하나도 없어야 한다.
 *
 *  각 항목이 답하는 질문은 하나다 — 못 하는 것과 틀리게 하는 것을 구분하는가.
 * ================================================================== */
async function runMIG() {
  suite('MIG', '마이그레이션 미적용 구간 — 못 하더라도 틀리지는 않는다');

  /* ── 1) 자동결제: 컬럼이 없으면 돌지 않고, 조용히 넘어가지도 않는다 ── */
  {
    resetDb(); resetExt();
    // 새 컬럼이 없는 subscriptions 를 흉내 낸다 (select 가 오류를 낸다).
    const realFrom = fakeSupabase.from;
    fakeSupabase.from = function (table) {
      if (table === 'subscriptions') {
        return {
          select(cols) {
            if (String(cols).indexOf('renew_failures') > -1) {
              const err = {
                data: null,
                error: { message: 'column subscriptions.renew_failures does not exist' }
              };
              const q = {
                eq() { return q; }, in() { return q; }, not() { return q; },
                lte() { return q; }, order() { return q; }, limit() { return q; },
                maybeSingle() { return Promise.resolve(err); },
                then(res, rej) { return Promise.resolve(err).then(res, rej); }
              };
              return q;
            }
            return realFrom.call(fakeSupabase, table).select(cols);
          }
        };
      }
      return realFrom.call(fakeSupabase, table);
    };

    const r = await billing.renewDueSubscriptions({}, new Date());
    fakeSupabase.from = realFrom;

    check(r.attempted === 0 && r.renewed === 0, '컬럼이 없으면 아무도 긁지 않는다 ★',
      JSON.stringify({ attempted: r.attempted, renewed: r.renewed }));
    check(!!r.error && /renew_failures/.test(r.error),
      '왜 못 돌았는지 이유를 돌려준다 (조용히 0건으로 끝내지 않는다) ★',
      String(r.error).slice(0, 60));
    check(ext.charges.length === 0, '청구 0회');
  }

  /* ── 2) cron 이 그 이유를 로그로 드러내는지 (정적) ── */
  {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(ROOT, 'api/cron.js'), 'utf8');
    check(/renewal\.error/.test(src) && /console\.error/.test(src),
      'cron 이 갱신 실패를 console.error 로 남긴다 ★ (매일 실패를 아무도 모르는 상태 방지)');
  }

  /* ── 3) 인증: RPC 가 없으면 폴백하되 한도는 그대로 지킨다 ── */
  {
    resetDb(); resetExt();
    const realRpc = fakeSupabase.rpc;
    fakeSupabase.rpc = function (name, args) {
      if (name === 'auth_code_attempt') {
        return Promise.resolve({
          data: null,
          error: { message: 'Could not find the function public.auth_code_attempt' }
        });
      }
      return realRpc.call(fakeSupabase, name, args);
    };

    // 폴백 플래그는 모듈 내부 상태다. 새로 로드해 깨끗한 상태에서 시작한다.
    const authPath = require.resolve(path.join(ROOT, 'api/_auth.js'));
    delete require.cache[authPath];
    const auth2 = require(authPath);

    const EMAIL = 'fallback@example.com';
    const made = await auth2.createCode(EMAIL);
    check(made.ok, '폴백 환경에서도 코드 발급은 된다');

    const wrong = [];
    for (let i = 0; i < auth2.MAX_ATTEMPTS + 3; i++) {
      wrong.push(await auth2.consumeCode(EMAIL, '000000'));
    }
    /*
     * 메시지로 세지 않는다. 폴백은 한도에 닿는 순간 코드 행을 지우므로
     * 그 뒤로는 "초과" 가 아니라 "먼저 코드를 요청해 주세요" 가 돌아온다.
     * RPC 경로는 행을 남겨 "초과" 를 계속 준다. 문구는 갈리지만 지켜야 할
     * 성질은 하나다 — 시도로 소비되는 횟수가 정확히 MAX 이고, 그 뒤로는
     * 어떤 요청도 통과하지 못한다.
     */
    const consumed = wrong.filter(o => /일치하지/.test(o.error || '')).length;
    check(consumed === auth2.MAX_ATTEMPTS,
      `폴백에서도 시도로 소비되는 횟수는 정확히 ${auth2.MAX_ATTEMPTS}회`, `소비 ${consumed}건`);
    check(wrong.every(o => !o.ok), '한도 이후 어떤 요청도 통과하지 않는다 ★');

    // 올바른 코드도 통과해야 한다 (기능이 죽지 않았는지)
    const made2 = await auth2.createCode('fallback2@example.com');
    const okr = await auth2.consumeCode('fallback2@example.com', made2.code);
    check(okr.ok === true, '폴백에서도 올바른 코드는 통과한다 ★ (로그인이 막히지 않는다)');

    fakeSupabase.rpc = realRpc;
    delete require.cache[authPath];
    require(authPath);   // 다른 스위트를 위해 정상 상태로 되돌린다
  }

  /* ── 4) 결제 pending 원장은 새 컬럼 없이도 동작한다 ── */
  {
    /*
     * payments 에는 새 컬럼을 추가하지 않았다 — pending/charging 은 기존
     * status(text) 값만 쓰고, 마이그레이션은 인덱스와 주석뿐이다.
     * 그래서 R1 흐름은 마이그레이션 전에도 그대로 돈다. 그 사실을 고정한다.
     */
    const fs = require('fs');
    const sql = fs.readFileSync(
      path.join(ROOT, 'supabase/2026-08-24-payment-pending-and-auth-attempts.sql'), 'utf8');
    const addsPaymentCols = /alter\s+table\s+payments\s+add\s+column/i.test(sql);
    check(!addsPaymentCols,
      'payments 에 새 컬럼을 요구하지 않는다 ★ (R1 흐름이 마이그레이션 전에도 동작)');

    resetDb(); resetExt();
    const oid = billing.createOrderId();
    const p = await billing.createPendingPayment({
      email: 'x@example.com', orderId: oid, amount: billing.PRO_PRICE
    });
    check(p.ok, '기존 스키마만으로 pending 주문이 기록된다');
    const claimed = await billing.claimForCharge(oid);
    check(claimed.claimed, '기존 스키마만으로 선점이 된다');
    const paid = await billing.markPaid(oid, { paymentKey: 'pk_1', amount: billing.PRO_PRICE, rawStatus: 'DONE' });
    check(paid.updated, '기존 스키마만으로 확정이 된다');
  }

  /* ── 5) 뷰 미적용 구간에서도 틀린 가격이 노출되지 않는다 ── */
  {
    /*
     * 옛 뷰는 고아 이력을 title/link NULL 로 올린다. 그 행이 사용자에게
     * 새어 나가지 않는 근거는 노출 단계의 plausibleDrop 이다 — 뷰를 아직
     * 못 바꾼 상태에서도 이 방어가 유효한지 확인한다.
     */
    const { plausibleDrop } = require(path.join(ROOT, 'api/_price.js'));
    const orphanRows = [
      { product_id: '500', mall: '네이버', title: null, link: null, current_price: 40000, prev_price: 80000, drop_pct: 50 },
      { product_id: '삼성 갤럭시 핏3', mall: '쿠팡', title: null, link: null, current_price: 30000, prev_price: 50000, drop_pct: 40 },
      { product_id: '600', mall: '쿠팡', title: '정상', link: null, current_price: 30000, prev_price: 50000, drop_pct: 40 }
    ];
    check(orphanRows.every(r => plausibleDrop(r) === false),
      '뷰 미적용 상태에서도 고아 행은 노출되지 않는다 ★',
      `통과 ${orphanRows.filter(plausibleDrop).length}행`);
  }

  note('※ 위 항목은 "마이그레이션 없이도 괜찮다" 는 뜻이 아니다.');
  note('   자동결제는 돌지 않고, 인증 시도 제한은 동시 요청에 취약한 상태로 남는다.');
  note('   확인한 것은 "그 구간에서 조용히 틀리지는 않는다" 뿐이다.');
}


/* ================================================================== *
 *  SAFE — 테스트가 돈을 쓰거나 운영 데이터를 망가뜨리지 않는가
 *
 *  ★ 이 검사는 테스트 스위트 안에 있어야 한다.
 *
 *  "실제 결제 호출 금지 / 실제 OpenRouter 호출 금지 / 운영 DB 파괴 금지" 는
 *  사람이 매번 기억해서 지키는 규칙이 아니라 자동으로 깨져야 하는 규칙이다.
 *  누군가 나중에 스위트를 하나 추가하면서 mock 을 빠뜨리면, 그 순간 npm test 가
 *  진짜 카드와 진짜 크레딧을 쓴다. 그때 알아채는 방법이 지금은 없다.
 *
 *  아래는 npm test / test:all 체인에 들어가는 파일만 검사한다.
 * ================================================================== */
async function runSAFE() {
  suite('SAFE', '테스트 체인이 실제 요금·운영 데이터를 건드리지 않는가');

  const fs = require('fs');

  /** package.json 의 test / test:all 체인에 실제로 들어가는 스크립트. */
  function chainScripts() {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const seen = new Set();
    const expand = (name, depth) => {
      if (depth > 5) return;
      const cmd = (pkg.scripts || {})[name] || '';
      cmd.split('&&').forEach(part => {
        const m = /node\s+scripts\/([\w.-]+)\.js/.exec(part.trim());
        if (m) { seen.add(m[1]); return; }
        const nm = /npm\s+(?:run\s+)?([\w:]+)/.exec(part.trim());
        if (nm) expand(nm[1] === 'test' ? 'test' : nm[1], depth + 1);
      });
    };
    expand('test:all', 0);
    return [...seen];
  }

  const scripts = chainScripts();
  check(scripts.length >= 8, 'test:all 체인의 스크립트를 찾았다', scripts.join(', '));

  /** 주석을 벗긴다 — 설명문에 적힌 URL 을 호출로 오인하지 않기 위해. */
  const strip = s => s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  const offenders = { paid: [], db: [], coupang: [] };

  for (const name of scripts) {
    const p = path.join(ROOT, 'scripts', name + '.js');
    if (!fs.existsSync(p)) { check(false, `${name}.js 존재`); continue; }
    const src = strip(fs.readFileSync(p, 'utf8'));

    const mocksFetch = /global\.fetch\s*=/.test(src);
    /*
     * "실제 호출" 의 판정은 URL 문자열이 아니라 fetch 호출이다.
     * scripts/test-ai-monetization.js 는 api/ai.js 소스에서 호출 순서를
     * 정적으로 검사하느라 OpenRouter URL 을 문자열로 들고 있을 뿐, fetch 를
     * 한 번도 부르지 않는다. 문자열만 보면 그런 파일이 전부 오탐이 된다.
     */
    const callsFetch = /(^|[^.\w])fetch\s*\(/.test(src);
    if (callsFetch && !mocksFetch) offenders.paid.push(name);

    // 운영 Supabase 로 나가는 경로: _supabase 를 require 하면서 가짜를 심지 않음
    const usesSupabase = /require\((['"])\.\.\/api\/_supabase\1\)/.test(src);
    const mocksSupabase = /require\.cache\[[^\]]*_supabase/.test(src)
      || /supabasePath/.test(src)
      || /inject\((['"])api\/_supabase\.js\1/.test(src);
    if (usesSupabase && !mocksSupabase) offenders.db.push(name);

    // 진짜 쿠팡 호스트를 그대로 두고 검색을 부르는가
    const realCoupangHost = /COUPANG_API_HOST\s*=\s*['"]https:\/\/api-gateway/.test(src);
    if (realCoupangHost) offenders.coupang.push(name);
  }

  check(offenders.paid.length === 0,
    '체인 안에 실제 fetch 를 mock 없이 부르는 테스트가 없다 ★ (유료 API 방지)',
    offenders.paid.join(', '));
  check(offenders.db.length === 0,
    '체인 안에 운영 Supabase 를 그대로 쓰는 테스트가 없다 ★',
    offenders.db.join(', '));
  check(offenders.coupang.length === 0,
    '체인 안에 진짜 쿠팡 호스트를 쓰는 테스트가 없다 ★',
    offenders.coupang.join(', '));

  /* 유료 호출을 하는 스크립트는 체인 밖에 있어야 한다. */
  {
    const paidScripts = ['test-intent', 'test-ai-e2e', 'test-e2e'];
    const leaked = paidScripts.filter(s => scripts.indexOf(s) > -1);
    check(leaked.length === 0,
      '실제 외부 호출 스크립트가 체인에 들어와 있지 않다 ★',
      leaked.length ? leaked.join(', ') : 'test-intent / test-ai-e2e / test-e2e 모두 체인 밖');
  }

  /* 운영 DB 를 지우는 문장이 체인 안에 없어야 한다. */
  {
    const destructive = [];
    for (const name of scripts) {
      const p = path.join(ROOT, 'scripts', name + '.js');
      if (!fs.existsSync(p)) continue;
      const src = strip(fs.readFileSync(p, 'utf8'));
      if (/\.delete\(\)/.test(src) && !/require\.cache|inject\(/.test(src)) destructive.push(name);
    }
    check(destructive.length === 0,
      '체인 안에 가짜 DB 없이 delete 를 부르는 테스트가 없다 ★',
      destructive.join(', '));
  }

  note('※ npm test / npm run test:all 에서 실제로 나가는 네트워크 호출은 0건이다.');
  note('   test-intent / test-ai-e2e / test-e2e 는 의도적으로 체인 밖에 둔다.');
}

/* ------------------------------------------------------------------ *
 *  실행
 * ------------------------------------------------------------------ */
(async () => {
  await runO4();
  await runO7();
  await runAI();
  await runMIG();
  await runSAFE();

  const order = ['O4', 'O7', 'AI', 'MIG', 'SAFE'];
  let pass = 0, fail = 0;
  console.log('\n' + '='.repeat(66));
  console.log('출시 전 안정화 테스트 요약');
  console.log('='.repeat(66));
  order.forEach(id => {
    const r = results[id] || { pass: 0, fail: 0 };
    pass += r.pass; fail += r.fail;
    console.log(`  ${id}  ${r.fail ? 'FAIL' : 'PASS'}   ${r.pass} pass / ${r.fail} fail`);
  });
  console.log('-'.repeat(66));
  console.log(`  합계  ${pass} PASS / ${fail} FAIL\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n오류:', e && e.stack || e); process.exit(1); });
