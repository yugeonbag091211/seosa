#!/usr/bin/env node
/*
 * 결제·구독·가격 알림을 «실제 Neon 어댑터 + 실제 Postgres 제약» 위에서 돌린다 — 모의 토스, 모의 메일.
 *
 *   NEON_SANDBOX_URL=<스키마만 복제한 Neon 자식 브랜치> node scripts/migration/test-neon-payment-alerts-sandbox.js
 *
 * 왜: scripts/test-payment.js(178개)·test-alerts.js 는 가짜 DB 배열 위에서 돈다. Neon 전환 뒤
 *     UNIQUE 위반 코드(23505)·조건부 UPDATE(선점 CAS)·upsert·maybeSingle 이 «실제로» 같은 답을
 *     주는지는 아무도 확인하지 않았다. 여기서는 같은 운영 코드(api/payment · api/_billing ·
 *     api/_plan · scripts/check-alerts)를 Neon 위에서 부른다.
 *
 * 안전:
 *   · 운영 브랜치 호스트는 거절한다. 스키마만 복제한 브랜치(neon branches create --schema-only
 *     --expires-at …)에서만 돈다 — 운영 데이터·개인정보를 읽지도 쓰지도 않는다.
 *   · 토스 API 는 fetch 가로채기로 흉내 낸다(실제 결제 0회). 메일은 _notify 를 가짜로 바꾼다(발송 0회).
 *   · 끝에 이 테스트가 만든 행(이메일 접미사 @sandbox.invalid)을 지운다 — 버려질 브랜치라도 남기지 않는다.
 */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const pg = require('pg');

const PRODUCTION_HOSTS = new Set([
  'ep-gentle-art-aoaa97v4.c-2.ap-southeast-1.aws.neon.tech',
  'ep-gentle-art-aoaa97v4-pooler.c-2.ap-southeast-1.aws.neon.tech'
]);
const SUFFIX = '@sandbox.invalid';

function inject(rel, exportsValue) {
  const p = require.resolve(path.join(__dirname, '..', '..', rel));
  const m = new Module(p, null);
  m.filename = p; m.loaded = true; m.exports = exportsValue;
  require.cache[p] = m;
}

/* ── 모의 토스 (scripts/test-payment.js 와 같은 모양) ── */
const toss = { billingKey: 'bk_sandbox', charges: [], payments: {}, failCharge: false, chargeDelayMs: 0 };
global.fetch = async function (url, opts = {}) {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : {};
  const json = (status, data) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) });
  if (u.endsWith('/v1/billing/authorizations/issue')) return json(200, { billingKey: toss.billingKey, customerKey: body.customerKey });
  if (/\/v1\/billing\/[^/]+$/.test(u)) {
    if (toss.chargeDelayMs) await new Promise(r => setTimeout(r, toss.chargeDelayMs));
    if (toss.failCharge) return json(402, { code: 'REJECT_CARD_COMPANY', message: 'declined' });
    const p = { paymentKey: 'pk_' + body.orderId, orderId: body.orderId, totalAmount: body.amount, status: 'DONE', method: '카드' };
    toss.payments[p.paymentKey] = p;
    toss.charges.push(body);
    return json(200, p);
  }
  const byOrder = u.match(/\/v1\/payments\/orders\/([^/]+)$/);
  if (byOrder) {
    const p = Object.values(toss.payments).find(x => x.orderId === decodeURIComponent(byOrder[1]));
    return p ? json(200, p) : json(404, { code: 'NOT_FOUND_PAYMENT', message: 'no such payment' });
  }
  const look = u.match(/\/v1\/payments\/([^/]+)$/);
  if (look) {
    const p = toss.payments[decodeURIComponent(look[1])];
    return p ? json(200, p) : json(404, { code: 'NOT_FOUND_PAYMENT', message: 'no such payment' });
  }
  return json(404, { code: 'UNKNOWN', message: u });
};

const mails = [];
inject('api/_notify.js', { send: async (channel, msg) => { mails.push({ channel, to: msg && msg.to, subject: msg && msg.subject }); return { ok: true, id: 'sandbox' }; } });

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  PASS ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

async function main() {
  const url = process.env.NEON_SANDBOX_URL || '';
  const host = new URL(url || 'postgres://x').hostname;
  if (!/\.neon\.tech$/.test(host) || PRODUCTION_HOSTS.has(host)) throw new Error('스키마만 복제한 Neon 자식 브랜치에서만 돈다 (운영 호스트 거절)');

  process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'sandbox-auth-secret';
  process.env.TOSS_SECRET_KEY = 'test_sk_SANDBOX_ONLY';
  process.env.TOSS_CLIENT_KEY = 'test_ck_SANDBOX_ONLY';
  process.env.RESEND_API_KEY = 'sandbox-not-used';   // check-alerts 가 «발송 수단 없음» 으로 끝나지 않게. 발송은 가짜 _notify.

  const { createClient, _internal } = require('../../api/_neonpg');
  const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: true }, max: 4, types: _internal.postgrestTypes });
  const sql = (text, values) => pool.query(text, values);
  const leftovers = await sql(`select (select count(*) from products) p, (select count(*) from price_history) h`);
  if (Number(leftovers.rows[0].p) || Number(leftovers.rows[0].h)) throw new Error('빈 스키마 브랜치가 아니다 — 운영 데이터 사본일 수 있어 거절');

  inject('api/_supabase.js', createClient({
    query: (text, values) => pool.query({ text, values }),
    transaction: async fn => {
      const c = await pool.connect();
      try { await c.query('BEGIN'); const out = await fn((text, values) => c.query({ text, values })); await c.query('COMMIT'); return out; }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
      finally { c.release(); }
    }
  }));

  const payment = require('../../api/payment');
  const billing = require('../../api/_billing');
  const Plan = require('../../api/_plan');
  const { issueToken } = require('../../api/_auth');
  const { kstToday, kstDayStartUtc } = require('../../api/_price');

  const mkRes = () => ({ code: 200, payload: null, headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; }, json(b) { this.payload = b; return this; } });
  const reqFor = (email, body, action) => ({ method: 'POST', headers: { authorization: 'Bearer ' + issueToken(email) },
    query: { action }, body: body || {}, socket: { remoteAddress: '10.9.0.' + Math.floor(Math.random() * 250) } });
  const prepare = async email => { const r = mkRes(); await payment.handlePrepare(reqFor(email, {}, 'prepare'), r, email); return r; };
  const confirm = async (email, body) => { const r = mkRes(); await payment.handleConfirm(reqFor(email, body, 'confirm'), r, email, body); return r; };
  const payRow = async orderId => (await sql('select * from payments where order_id=$1', [orderId])).rows[0];
  const subRow = async email => (await sql('select * from subscriptions where email=$1', [email])).rows[0];

  const BUYER = 'buyer' + SUFFIX, OTHER = 'attacker' + SUFFIX, DECLINED = 'declined' + SUFFIX, RACE = 'race' + SUFFIX,
    CRASH = 'crash' + SUFFIX, RENEW = 'renew' + SUFFIX;

  try {
    console.log('\n[결제 — 실제 Neon 제약 위에서]');
    let buyerOrder = '';
    await test('prepare → pending 주문, 금액은 서버 상수 4,900원', async () => {
      const r = await prepare(BUYER);
      assert.equal(r.code, 200, JSON.stringify(r.payload));
      buyerOrder = r.payload.orderId;
      const row = await payRow(buyerOrder);
      assert.equal(row.status, 'pending'); assert.equal(Number(row.amount), 4900);
    });
    await test('★ 금액·plan·email 위조 body → 4,900원으로만 승인, PRO 는 토큰 주인에게', async () => {
      const r = await confirm(BUYER, { authKey: 'ak', orderId: buyerOrder, amount: 100, plan: 'pro', email: OTHER });
      assert.equal(r.code, 200, JSON.stringify(r.payload));
      assert.equal(toss.charges.length, 1); assert.equal(toss.charges[0].amount, 4900);
      const row = await payRow(buyerOrder);
      assert.equal(row.status, 'paid'); assert.equal(Number(row.amount), 4900);
      const sub = await subRow(BUYER);
      assert.equal(sub.plan, 'pro'); assert.equal(sub.status, 'active');
      assert.equal(await subRow(OTHER), undefined, '위조 email 에는 아무것도 생기지 않는다');
      assert.equal((await Plan.resolvePlan(BUYER)).plan, 'pro');
    });
    await test('★ 같은 주문 재확정 → alreadyProcessed, 추가 청구 0', async () => {
      const r = await confirm(BUYER, { authKey: 'ak', orderId: buyerOrder });
      assert.equal(r.code, 200); assert.equal(r.payload.alreadyProcessed, true);
      assert.equal(toss.charges.length, 1);
      assert.equal(Number((await sql('select count(*) n from payments where email=$1', [BUYER])).rows[0].n), 1);
    });
    await test('★ 남의 주문번호로 확정 → 403, 청구 0', async () => {
      const r0 = await prepare(BUYER);
      const r = await confirm(OTHER, { authKey: 'ak', orderId: r0.payload.orderId });
      assert.equal(r.code, 403); assert.equal(r.payload.error, 'ORDER_OWNER_MISMATCH');
      assert.equal(toss.charges.length, 1);
    });
    await test('★ 동시 확정 2건(연결 2개) → Postgres 선점 CAS 로 청구 정확히 1건', async () => {
      const o = (await prepare(RACE)).payload.orderId;
      toss.chargeDelayMs = 400;
      const [a, b] = await Promise.all([confirm(RACE, { authKey: 'ak', orderId: o }), confirm(RACE, { authKey: 'ak', orderId: o })]);
      toss.chargeDelayMs = 0;
      const codes = [a.code, b.code].sort();
      assert.equal(toss.charges.filter(c => c.orderId === o).length, 1, '청구 1건');
      assert.deepEqual(codes, [200, 409], JSON.stringify([a.payload, b.payload]));
      assert.equal((await payRow(o)).status, 'paid');
      assert.equal((await Plan.resolvePlan(RACE)).plan, 'pro', '청구된 사용자는 PRO');
    });
    await test('★ 카드 거절 → 402, 주문 failed, PRO 없음', async () => {
      const o = (await prepare(DECLINED)).payload.orderId;
      toss.failCharge = true;
      const r = await confirm(DECLINED, { authKey: 'ak', orderId: o });
      toss.failCharge = false;
      assert.equal(r.code, 402);
      assert.equal((await payRow(o)).status, 'failed');
      assert.equal((await Plan.resolvePlan(DECLINED)).plan, 'free');
    });
    await test('★ 승인 뒤 죽은 주문(charging) 복구 → 재승인 없이 토스 조회로 paid + PRO', async () => {
      const o = (await prepare(CRASH)).payload.orderId;
      const claim = await billing.claimForCharge(o);
      assert.equal(claim.claimed, true);
      // 토스에는 청구가 이미 됐다 (우리 프로세스가 응답 직전에 죽었다).
      toss.payments['pk_' + o] = { paymentKey: 'pk_' + o, orderId: o, totalAmount: 4900, status: 'DONE', method: '카드' };
      const before = toss.charges.length;
      const r = await confirm(CRASH, { authKey: 'ak', orderId: o });
      assert.equal(r.code, 200, JSON.stringify(r.payload));
      assert.equal(toss.charges.length, before, '재승인 0');
      assert.equal((await payRow(o)).status, 'paid');
      assert.equal((await Plan.resolvePlan(CRASH)).plan, 'pro');
    });
    await test('★ 위조 웹훅(토스에 없는 결제) → 502, 권한 변화 없음', async () => {
      const r = mkRes();
      await payment.handleWebhook({ method: 'POST', headers: {}, body: {} }, r,
        { eventType: 'PAYMENT_STATUS_CHANGED', data: { paymentKey: 'pk_forged', orderId: 'seosa_forged', status: 'DONE' } });
      assert.equal(r.code, 502);
      assert.equal(await subRow('forged' + SUFFIX), undefined);
    });
    await test('★ 갱신 결제 실패 → 기간 연장 없음, 만료 시각이 지나면 FREE', async () => {
      const exp = new Date(Date.now() + 24 * 3600e3).toISOString();
      await sql(`insert into subscriptions (email, plan, status, expires_at, billing_key, customer_key) values ($1,'pro','active',$2,'bk_sandbox',$3)`,
        [RENEW, exp, billing.customerKeyFor(RENEW)]);
      toss.failCharge = true;
      const out = await billing.renewOne(await subRow(RENEW));
      toss.failCharge = false;
      assert.equal(out.ok, false);
      const sub = await subRow(RENEW);
      assert.equal(new Date(sub.expires_at).toISOString(), exp, '만료일 그대로');
      assert.equal(Plan.resolvePlanFromRow(sub, new Date(Date.parse(exp) + 60e3)).plan, 'free');
      assert.equal(Plan.resolvePlanFromRow(sub, new Date(Date.parse(exp) - 60e3)).plan, 'pro', '이미 낸 기간은 유지');
    });

    console.log('\n[가격 알림 — 옵션 단위 · 목표가]');
    await test('★ 다른 옵션이 목표가 아래여도 보내지 않고, 같은 옵션이 내려가면 한 번만 보낸다', async () => {
      const today = kstToday();
      const at = new Date(Date.parse(kstDayStartUtc(today)) + 3600e3).toISOString();
      const pid = '990000001';
      await sql(`insert into alerts (email, title, target_price, current_price, product_id, vendor_item_id, mall, link)
                 values ($1,'샌드박스 상품',10000,12000,$2,'V1','쿠팡','https://link.coupang.com/re/x')`, ['alert' + SUFFIX, pid]);
      await sql(`insert into price_history (product_id, mall, title, price, link, recorded_at, vendor_item_id, source)
                 values ($1,'쿠팡','샌드박스 상품',8000,'https://link.coupang.com/re/x',$2,'V2','sandbox'),
                        ($1,'쿠팡','샌드박스 상품',12000,'https://link.coupang.com/re/x',$2,'V1','sandbox')`, [pid, at]);
      const { run } = require('../check-alerts');
      await run();
      assert.equal(mails.length, 0, '첫 관측(V1 12,000원 · 목표가 위)도, 다른 옵션(V2 8,000원)도 메일 사유가 아니다');
      await sql(`update price_history set price=9000 where product_id=$1 and vendor_item_id='V1'`, [pid]);
      await run();
      assert.equal(mails.length, 1, '같은 옵션 V1 이 9,000원 → 1통');
      assert.equal(mails[0].to, 'alert' + SUFFIX);
      await run();
      assert.equal(mails.length, 1, '보낸 알림은 다시 보내지 않는다');
      assert.equal((await sql(`select sent from alerts where email=$1`, ['alert' + SUFFIX])).rows[0].sent, true);
    });
  } finally {
    await sql(`delete from payments where email like $1`, ['%' + SUFFIX]);
    await sql(`delete from subscriptions where email like $1`, ['%' + SUFFIX]);
    await sql(`delete from alerts where email like $1`, ['%' + SUFFIX]);
    await sql(`delete from price_history where source='sandbox'`);
    await pool.end();
  }
  console.log(`\n결과: ${passed} PASS / ${failed} FAIL`);
  console.log(`NEON_PAYMENT_ALERTS_SANDBOX ${failed ? 'FAIL' : 'PASS'}`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('실패:', e.message); process.exit(2); });
