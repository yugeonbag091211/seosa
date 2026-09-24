#!/usr/bin/env node
'use strict';
/*
 * ② 구매 대기실 — 완전 오프라인.
 *
 * 여기서 고정하는 것
 *   1) 신원은 토큰에서만 — 남의 항목을 보거나 멈추거나 지울 수 없다
 *   2) 마이그레이션 전에는 503 으로 닫힌다 (조용히 빈 목록을 주지 않는다)
 *   3) 목표가 도달은 결정론: 무장 → 알림 1통 → 해제 → 1.03배 위로 가야 재무장
 *   4) 같은 날·같은 항목에 메일은 한 통뿐 (재실행·동시 실행·실패 재시도 모두)
 *   5) 오래된 관측·다른 옵션의 관측으로는 알리지 않는다
 *   6) 가격 원장·카탈로그·기존 알림 표에 쓰지 않는다. 외부 호출 0회 (메일은 가짜 발송기)
 */

const kit = require('./_v2-testkit');
const { db, state, T, mkReq, mkRes, fetchCalls } = kit.setup('test-v2-waitroom');

const W = require('../api/_waitroom');
const api = require('../api/_waitroom-api');
const alerts = require('../api/alerts');
const job = require('../scripts/check-waitroom');
const auth = require('../api/_auth');
const { kstToday } = require('../api/_kst');

const ME = 'me@example.com';
const OTHER = 'other@example.com';
const tokenMe = auth.issueToken(ME);
const tokenOther = auth.issueToken(OTHER);
const today = kstToday();
const daysAgo = n => kstToday(new Date(Date.now() - n * 86400000));
const previousWaitroomApiEnabled = process.env.WAITROOM_API_ENABLED;
delete process.env.WAITROOM_API_ENABLED;

state.uniques.waitroom_items = [['email', 'product_id', 'mall', 'vendor_item_id']];
state.uniques.waitroom_notifications = [['item_id', 'notify_date']];

function authed(token, o) {
  return mkReq(Object.assign({}, o, { headers: Object.assign({ authorization: `Bearer ${token}` }, (o && o.headers) || {}) }));
}
async function call(req) { const res = mkRes(); await api.handler(req, res); return res; }
function resetTables() {
  db.waitroom_items = []; db.waitroom_notifications = [];
  state.missingTables.clear();
}
const quiet = fn => async (...a) => { const l = console.log, e = console.error; console.log = () => {}; console.error = () => {};
  try { return await fn(...a); } finally { console.log = l; console.error = e; } };
const runJob = quiet(job.run);

async function main() {
  /* ── 1. 규칙 (순수 함수) ───────────────────────────────────── */
  T.section('입력 검증');
  {
    const ok = W.validateSave({ productId: '123', mall: '쿠팡', title: ' 무선​ 이어폰\n', targetPrice: 50000,
      link: 'https://link.coupang.com/a', image: 'http://insecure/img.jpg' });
    T.check(ok.ok && ok.value.title === '무선 이어폰', '제어·폭 없는 문자를 지운다', ok);
    T.check(ok.ok && ok.value.image === '' && ok.value.link === 'https://link.coupang.com/a', 'https 가 아닌 링크는 버린다');
    [
      [{ productId: '1;drop', mall: '쿠팡', title: 'x', targetPrice: 1 }, '상품 번호'],
      [{ productId: '1', mall: '네이버', title: 'x', targetPrice: 1 }, '판매처'],
      [{ productId: '1', mall: '쿠팡', title: '', targetPrice: 1 }, '이름'],
      [{ productId: '1', mall: '쿠팡', title: 'x', targetPrice: 0 }, '목표 가격'],
      [{ productId: '1', mall: '쿠팡', title: 'x', targetPrice: 10.5 }, '목표 가격'],
      [{ productId: '1', mall: '쿠팡', title: 'x', targetPrice: 200000000 }, '목표 가격'],
      [{ productId: '1', mall: '쿠팡', vendorItemId: 'a b', title: 'x', targetPrice: 1 }, '옵션']
    ].forEach(([b, word]) => {
      const r = W.validateSave(b);
      T.check(!r.ok && r.error.indexOf(word) > -1, `거절: ${word}`, r);
    });
    T.check(!W.checkTarget(600000, 100000).ok, '목표가가 현재가의 5배 초과 → 거절');
    T.check(W.checkTarget(90000, 80000).reachedNow === true, '이미 목표가 이하면 reachedNow');
    T.check(W.checkTarget(90000, 0).ok, '현재가를 모르면 목표가만으로 받는다');
  }

  T.section('도달 판정 (무장 · 해제 · 재무장)');
  {
    const base = { id: 1, target_price: 10000, status: 'WAITING', armed: true, notified_at: null, last_price: null };
    const fresh = p => ({ price: p, observedAt: new Date().toISOString(), observedDate: today });
    T.check(W.evaluate(base, null, { today }).action === 'NONE', '관측 없음 → 아무것도 안 한다');
    T.check(W.evaluate(base, fresh(10000), { today }).action === 'NOTIFY', '현재가 = 목표가 → 알림');
    T.check(W.evaluate(base, fresh(9000), { today }).action === 'NOTIFY', '현재가 < 목표가 → 알림');
    T.check(W.evaluate(base, fresh(10200), { today }).reason === 'hysteresis-band', '목표가 ~ 1.03배 사이 → 아무것도 안 한다');
    const off = Object.assign({}, base, { armed: false, status: 'REACHED' });
    T.check(W.evaluate(off, fresh(9000), { today }).reason === 'already-notified', '알린 뒤 목표가 아래에 머물면 다시 알리지 않는다');
    T.check(W.evaluate(off, fresh(10200), { today }).action === 'NONE', '1.03배 안으로는 재무장하지 않는다');
    const re = W.evaluate(off, fresh(10400), { today });
    T.check(re.action === 'REARM' && re.patch.armed === true && re.patch.status === 'WAITING', '1.03배 위로 오르면 재무장');
    const stale = W.evaluate(base, { price: 9000, observedAt: new Date(Date.now() - 2 * 86400000).toISOString(), observedDate: daysAgo(2) }, { today });
    T.check(stale.action === 'NONE' && stale.reason === 'stale-observation', '이틀 전 관측으로는 알리지 않는다');
    const cool = Object.assign({}, base, { notified_at: new Date(Date.now() - 3 * 86400000).toISOString() });
    T.check(W.evaluate(cool, fresh(9000), { today }).reason === 'cooldown', '7일 안에 알린 적 있으면 쉰다');
    const cooled = Object.assign({}, base, { notified_at: new Date(Date.now() - 8 * 86400000).toISOString() });
    T.check(W.evaluate(cooled, fresh(9000), { today }).action === 'NOTIFY', '7일이 지나면 다시 알린다');
    const paused = W.evaluate(Object.assign({}, base, { status: 'PAUSED' }), fresh(9000), { today });
    T.check(paused.action === 'NONE' && paused.patch.last_price === 9000, '멈춘 항목은 알리지 않지만 가격은 갱신한다');
    const after = W.afterSend({ notify_count: 2 }, 9000, '2026-01-01T00:00:00.000Z');
    T.check(after.armed === false && after.status === 'REACHED' && after.notify_count === 3 && after.notified_price === 9000, '발송 후 해제·기록');
  }

  T.section('메일 본문');
  {
    const html = W.emailHtml({ title: '<script>alert(1)</script> 이어폰', price: 9000, target: 10000, mall: '쿠팡',
      observedDate: today, link: 'javascript:alert(1)', image: 'https://img.example/a.jpg' });
    T.check(html.indexOf('<script>') === -1 && html.indexOf('&lt;script&gt;') > -1, '상품명은 escape 된다');
    T.check(html.indexOf('javascript:') === -1, 'https 가 아닌 링크는 버튼을 만들지 않는다');
    T.check(/\/v2\/waitroom\.html/.test(html), '알림 끄기·목표가 바꾸기 링크가 있다');
    T.check(html.indexOf('한 번만 발송') === -1, '«한 번만 발송» 이라는 거짓 약속이 없다 (재무장한다)');
  }

  /* ── 2. API ───────────────────────────────────────────────── */
  T.section('/api/waitroom — 인증 · 준비 상태');
  resetTables();
  db.products = [
    { product_id: '500', mall: '쿠팡', keyword: '이어폰', lprice: 100000, collected_at: new Date().toISOString() },
    { product_id: '600', mall: '쿠팡', keyword: '', lprice: 20000, collected_at: new Date().toISOString() }
  ];
  db.price_history = kit.historyRows({ productId: '500', vendorItemId: '5001', prices: [110000, 105000, 100000] })
    .concat(kit.historyRows({ productId: '500', vendorItemId: '5999', prices: [3000, 3000, 3000], startId: 900 }));
  {
    const r1 = await call(mkReq({ method: 'GET' }));
    T.check(r1.statusCode === 401 && r1.body.needsAuth, '토큰 없음 → 401');
    const r2 = await call(mkReq({ method: 'GET', headers: { authorization: 'Bearer v1.bad.token' } }));
    T.check(r2.statusCode === 401, '위조 토큰 → 401');
    const writesBeforeDisabled = state.writes.length;
    const disabled = await call(authed(tokenMe, { method: 'POST', body: { action: 'save', productId: '500', mall: '쿠팡', title: 't', targetPrice: 90000 } }));
    T.check(disabled.statusCode === 503 && disabled.body.code === 'WAITROOM_NOT_READY', 'WAITROOM_API_ENABLED 승인 전 등록 API 는 닫혀 있다', disabled.body);
    T.check(state.writes.length === writesBeforeDisabled, '비활성 API 는 DB 에 쓰지 않는다');
    process.env.WAITROOM_API_ENABLED = '1';
    state.missingTables.add('waitroom_items');
    const r3 = await call(authed(tokenMe, { method: 'GET' }));
    T.check(r3.statusCode === 503 && r3.body.code === 'WAITROOM_NOT_READY', '표가 없으면 503 WAITROOM_NOT_READY', r3.body);
    const r4 = await call(authed(tokenMe, { method: 'POST', body: { action: 'save', productId: '500', mall: '쿠팡', title: 't', targetPrice: 90000 } }));
    T.check(r4.statusCode === 503, '표가 없으면 저장도 503');
    resetTables();
    const r5 = await call(authed(tokenMe, { method: 'GET', headers: { origin: 'https://evil.example' } }));
    T.check(r5.headers['access-control-allow-origin'] === undefined, 'private CORS — 허용 밖 오리진에 헤더를 주지 않는다');
    T.check(/no-store/.test(r5.headers['cache-control'] || ''), '개인 데이터 — no-store');
  }

  T.section('/api/waitroom — 저장 · 목록 · 멈춤 · 삭제');
  {
    const save = await call(authed(tokenMe, { method: 'POST', body: {
      action: 'save', productId: '500', mall: '쿠팡', vendorItemId: '5001', title: '노캔 이어폰', targetPrice: 95000,
      email: OTHER   // ← 본문의 email 은 무시돼야 한다
    } }));
    T.check(save.statusCode === 200 && save.body.item && save.body.item.targetPrice === 95000, '저장 200', save.body);
    T.check(db.waitroom_items.length === 1 && db.waitroom_items[0].email === ME, '본문의 email 이 아니라 토큰의 이메일로 저장된다');
    T.check(save.body.item.tracking === 'TRACKED', '카탈로그에 있고 키워드가 있으면 TRACKED');
    T.check(save.body.item.lastPrice === 100000, '마지막 가격은 이 옵션의 원장 값 (다른 옵션 3,000원이 아니다)', save.body.item);
    T.check(save.body.reachedNow === false, '아직 목표가 위');

    const again = await call(authed(tokenMe, { method: 'POST', body: {
      action: 'save', productId: '500', mall: '쿠팡', vendorItemId: '5001', title: '노캔 이어폰', targetPrice: 100000 } }));
    T.check(db.waitroom_items.length === 1 && db.waitroom_items[0].target_price === 100000, '같은 가격 계열은 새 행이 아니라 목표가 갱신');
    T.check(again.body.reachedNow === true && again.body.notice.some(n => /이미 목표가 이하/.test(n)), '이미 도달했으면 알려 준다');

    const untracked = await call(authed(tokenMe, { method: 'POST', body: {
      action: 'save', productId: '600', mall: '쿠팡', title: '키워드 없는 상품', targetPrice: 15000 } }));
    T.check(untracked.body.item.tracking === 'UNTRACKED' && untracked.body.notice.some(n => /알림이 가지 않을 수/.test(n)),
      '매일 수집되지 않는 상품은 UNTRACKED 로 솔직하게 알린다', untracked.body);

    const tooHigh = await call(authed(tokenMe, { method: 'POST', body: {
      action: 'save', productId: '500', mall: '쿠팡', vendorItemId: '5001', title: 'x', targetPrice: 900000 } }));
    T.check(tooHigh.statusCode === 400 && tooHigh.body.code === 'BAD_TARGET', '현재가의 5배를 넘는 목표가 → 400');

    await call(authed(tokenOther, { method: 'POST', body: {
      action: 'save', productId: '500', mall: '쿠팡', vendorItemId: '5001', title: '남의 것', targetPrice: 80000 } }));
    const mine = await call(authed(tokenMe, { method: 'GET' }));
    T.check(mine.body.items.length === 2 && mine.body.items.every(i => i.title !== '남의 것'), '목록에는 내 항목만');
    const otherId = db.waitroom_items.find(r => r.email === OTHER).id;
    const myId = db.waitroom_items.find(r => r.email === ME && r.product_id === '500').id;

    const pauseOther = await call(authed(tokenMe, { method: 'POST', body: { action: 'pause', id: otherId } }));
    T.check(pauseOther.statusCode === 404 && db.waitroom_items.find(r => r.id === otherId).status === 'WAITING',
      '남의 항목은 멈출 수 없다 (404)');
    const pause = await call(authed(tokenMe, { method: 'POST', body: { action: 'pause', id: myId } }));
    T.check(pause.body.item.status === 'PAUSED', '내 항목 멈춤');
    db.waitroom_items.find(r => r.id === myId).armed = false;
    const resume = await call(authed(tokenMe, { method: 'POST', body: { action: 'resume', id: myId } }));
    T.check(resume.body.item.status === 'WAITING' && resume.body.item.armed === true, '다시 켜면 WAITING · 재무장');

    const delOther = await call(authed(tokenMe, { method: 'DELETE', body: { id: otherId } }));
    T.check(delOther.statusCode === 404 && db.waitroom_items.some(r => r.id === otherId), '남의 항목은 지울 수 없다');
    const bad = await call(authed(tokenMe, { method: 'DELETE', body: { id: 'x' } }));
    T.check(bad.statusCode === 400, '항목 번호가 없으면 400');
    const del = await call(authed(tokenMe, { method: 'DELETE', body: { id: myId } }));
    T.check(del.statusCode === 200 && !db.waitroom_items.some(r => r.id === myId), '내 항목 삭제');

    // 한도
    resetTables();
    for (let i = 0; i < W.MAX_ITEMS_PER_USER; i++) {
      db.waitroom_items.push({ id: i + 1, email: ME, product_id: `9${i}`, mall: '쿠팡', vendor_item_id: '', title: 't', target_price: 1, status: 'WAITING', armed: true });
    }
    const over = await call(authed(tokenMe, { method: 'POST', body: { action: 'save', productId: '500', mall: '쿠팡', title: 't', targetPrice: 90000 } }));
    T.check(over.statusCode === 400 && over.body.code === 'LIMIT', `사용자당 ${W.MAX_ITEMS_PER_USER}개 한도`);
    const viaAlerts = mkRes();
    await alerts(authed(tokenMe, { method: 'GET', query: { __route: 'waitroom' } }), viaAlerts);
    T.check(viaAlerts.body && viaAlerts.body.ok && viaAlerts.body.items.length === W.MAX_ITEMS_PER_USER,
      '/api/alerts?__route=waitroom 경로로도 같은 답 (vercel rewrite)');
  }

  /* ── 3. 매일 잡 ───────────────────────────────────────────── */
  T.section('check-waitroom — 발송 · 중복 방지');
  const sent = [];
  let sendMode = 'ok';
  const fakeSend = async payload => { sent.push(payload); return sendMode === 'ok' ? { ok: true, id: 'x' } : { ok: false, error: 'resend 500' }; };
  function seedJob() {
    resetTables();
    db.price_history = []
      .concat(kit.historyRows({ productId: 'A', vendorItemId: '1', prices: [12000, 11000, 9500], startId: 1 }))
      .concat(kit.historyRows({ productId: 'B', vendorItemId: '2', prices: [20000, 21000, 22000], startId: 100 }))
      .concat(kit.historyRows({ productId: 'C', vendorItemId: '3', prices: [9000, 12000, 12500], startId: 200 }))
      // D: 목표가 아래 값은 다른 옵션(9)에서만 — 알리면 안 된다
      .concat(kit.historyRows({ productId: 'D', vendorItemId: '4', prices: [30000, 30000, 30000], startId: 300 }))
      .concat(kit.historyRows({ productId: 'D', vendorItemId: '9', prices: [100, 100, 100], startId: 400 }))
      // E: 목표가 아래지만 마지막 관측이 이틀 전
      .concat(kit.historyRows({ productId: 'E', vendorItemId: '5', prices: [5000, 4000], startId: 500, endDaysAgo: 2 }));
    db.waitroom_items = [
      { id: 1, email: ME, product_id: 'A', mall: '쿠팡', vendor_item_id: '1', title: 'A상품', target_price: 10000, status: 'WAITING', armed: true, notify_count: 0, link: 'https://link.coupang.com/a' },
      { id: 2, email: ME, product_id: 'B', mall: '쿠팡', vendor_item_id: '2', title: 'B상품', target_price: 15000, status: 'WAITING', armed: true, notify_count: 0 },
      { id: 3, email: ME, product_id: 'C', mall: '쿠팡', vendor_item_id: '3', title: 'C상품', target_price: 10000, status: 'REACHED', armed: false, notify_count: 1,
        notified_at: new Date(Date.now() - 2 * 86400000).toISOString() },
      { id: 4, email: OTHER, product_id: 'D', mall: '쿠팡', vendor_item_id: '4', title: 'D상품', target_price: 1000, status: 'WAITING', armed: true, notify_count: 0 },
      { id: 5, email: OTHER, product_id: 'E', mall: '쿠팡', vendor_item_id: '5', title: 'E상품', target_price: 4500, status: 'WAITING', armed: true, notify_count: 0 },
      { id: 6, email: OTHER, product_id: 'A', mall: '쿠팡', vendor_item_id: '1', title: 'A상품(멈춤)', target_price: 10000, status: 'PAUSED', armed: true, notify_count: 0 }
    ];
  }
  {
    seedJob();
    const s1 = await runJob({ send: fakeSend });
    T.check(sent.length === 1 && sent[0].to === ME && /A상품/.test(sent[0].subject), '목표가에 닿은 A 에만 한 통', sent.map(x => x.subject));
    T.check(sent[0].idempotencyKey === `waitroom/1/${today}`, '항목·날짜별로 안정된 Resend idempotency key');
    const a = db.waitroom_items.find(r => r.id === 1);
    T.check(a.armed === false && a.status === 'REACHED' && a.notified_price === 9500 && a.notify_count === 1, 'A 는 해제·기록된다', a);
    const note = db.waitroom_notifications.find(n => n.item_id === 1);
    T.check(note && note.status === 'sent' && note.notify_date === today, '발송 기록 sent');
    const c = db.waitroom_items.find(r => r.id === 3);
    T.check(c.armed === true && c.status === 'WAITING' && s1.rearmed === 1, 'C 는 목표가 1.03배 위로 올라 재무장');
    T.check(!sent.some(p => /D상품|E상품/.test(p.subject)), '다른 옵션 값(D)·오래된 관측(E)으로는 알리지 않는다');
    T.check(db.waitroom_items.find(r => r.id === 2).last_price === 22000, '알리지 않는 항목도 마지막 가격은 갱신');
    T.check(db.waitroom_items.find(r => r.id === 6).armed === true, '멈춘 항목(PAUSED)은 잡이 읽지도 않는다');

    const s2 = await runJob({ send: fakeSend });
    T.check(sent.length === 1 && s2.notified === 0, '같은 날 다시 돌려도 두 번째 메일은 없다');

    // 동시 실행: 다른 잡이 이미 선점한 상태 (무장은 아직 true 로 남아 있다고 가정)
    seedJob(); sent.length = 0;
    db.waitroom_notifications.push({ id: 77, item_id: 1, email: ME, notify_date: today, price: 9500, target_price: 10000, status: 'claimed', attempts: 1 });
    const s3 = await runJob({ send: fakeSend });
    T.check(sent.length === 0 && s3.skipped['delivery-unconfirmed'] === 1, '다른 실행의 claimed 행은 다시 보내지 않는다');

    // 실패 → 재시도 → 한도
    seedJob(); sent.length = 0; sendMode = 'fail';
    await runJob({ send: fakeSend });
    let n = db.waitroom_notifications.find(x => x.item_id === 1);
    T.check(n.status === 'failed' && db.waitroom_items.find(r => r.id === 1).armed === true, '발송 실패 → failed 기록 · 항목 재무장');
    sendMode = 'ok';
    await runJob({ send: fakeSend });
    n = db.waitroom_notifications.find(x => x.item_id === 1);
    T.check(n.status === 'sent' && n.attempts === 2 && sent.length === 2, '같은 날 재시도 → 성공 (attempts 2)');
    T.check(sent[0].idempotencyKey === sent[1].idempotencyKey, '명확한 실패 재시도에도 같은 provider key를 쓴다');
    seedJob(); sent.length = 0; sendMode = 'fail';
    for (let k = 0; k < 5; k++) await runJob({ send: fakeSend });
    T.check(sent.length === W.MAX_ATTEMPTS, `같은 날 재시도는 ${W.MAX_ATTEMPTS}번까지`, sent.length);
    sendMode = 'ok';

    // 공급자는 수락했지만 응답이 유실된 경우: 미확정 상태로 고정하고 다시 보내지 않는다.
    seedJob(); sent.length = 0;
    const acceptedKeys = new Set();
    let providerAccepted = 0;
    const acceptedButLost = async payload => {
      sent.push(payload);
      if (!acceptedKeys.has(payload.idempotencyKey)) {
        acceptedKeys.add(payload.idempotencyKey);
        providerAccepted++;
      }
      return { ok: false, uncertain: true, error: 'mock response lost after provider acceptance' };
    };
    const unknown = await runJob({ send: acceptedButLost });
    let pending = db.waitroom_notifications.find(x => x.item_id === 1);
    T.check(unknown.unconfirmed === 1 && providerAccepted === 1 && pending.status === 'claimed'
      && !db.waitroom_items.find(r => r.id === 1).armed,
    '수락 후 응답 유실은 claimed·disarmed 로 남긴다 (실제 메일 없이 mock)');
    pending.notify_date = daysAgo(1); // 다음 날짜에 실행한 상황
    db.price_history.filter(r => r.product_id === 'A' && r.vendor_item_id === '1').forEach(r => { r.price = 12000; });
    const rise = await runJob({ send: acceptedButLost });
    T.check(sent.length === 1 && !db.waitroom_items.find(r => r.id === 1).armed
      && rise.skipped['delivery-unconfirmed'] === 1,
    '다음 날 가격이 올라 재무장 조건이어도 미확정 발송은 그대로 잠근다');
    db.price_history.filter(r => r.product_id === 'A' && r.vendor_item_id === '1').forEach(r => { r.price = 9500; });
    const fall = await runJob({ send: acceptedButLost });
    T.check(sent.length === 1 && providerAccepted === 1 && fall.skipped['delivery-unconfirmed'] === 1,
      '미확정 발송 뒤 가격이 다시 내려도 중복 이메일을 보내지 않는다');

    // dry-run: 아무것도 쓰지 않는다
    seedJob(); sent.length = 0;
    const before = state.writes.length;
    const dr = await runJob({ dryRun: true, send: fakeSend });
    T.check(dr.wouldNotify === 1 && sent.length === 0 && state.writes.length === before, 'dry-run 은 세기만 하고 보내지도 쓰지도 않는다');

    // 표 없음
    state.missingTables.add('waitroom_items');
    const nr = await runJob({ send: fakeSend });
    T.check(nr.notReady === true && sent.length === 0, '표가 없으면 할 일 없이 정상 종료');
    state.missingTables.clear();

    // RESEND 없음 → dry-run 으로 떨어지고 exit 1
    seedJob();
    const prevExit = process.exitCode;
    const nk = await runJob({});
    T.check(nk.wouldNotify === 1 && process.exitCode === 1, 'RESEND_API_KEY 가 없으면 보내지 않고 exit 1 로 알린다');
    process.exitCode = prevExit;
  }

  T.section('안전');
  const forbidden = state.writes.filter(w => ['products', 'price_history', 'alerts', 'hotdeals'].indexOf(w.table) > -1);
  T.check(forbidden.length === 0, '가격 원장·카탈로그·기존 알림·핫딜 표에 쓰지 않았다', forbidden.map(w => w.table));
  T.check(fetchCalls.length === 0, '외부 호출 0회', fetchCalls);

  if (previousWaitroomApiEnabled === undefined) delete process.env.WAITROOM_API_ENABLED;
  else process.env.WAITROOM_API_ENABLED = previousWaitroomApiEnabled;

  T.section('Resend idempotency adapter — mock only');
  const emailPath = require.resolve('../api/_channel/email');
  const previousEmailModule = require.cache[emailPath];
  const previousResendKey = process.env.RESEND_API_KEY;
  const previousFetch = global.fetch;
  process.env.RESEND_API_KEY = 'mock-only-not-a-secret';
  delete require.cache[emailPath];
  const emailChannel = require('../api/_channel/email');
  const accepted = new Map();
  const idempotencyHeaders = [];
  let mockAccepts = 0, mockCalls = 0, dropFirstResponse = true;
  const testPayload = {
    to: 'no-send@example.invalid', subject: 'waitroom test', html: '<p>mock only</p>',
    idempotencyKey: `waitroom/42/${today}`
  };
  global.fetch = async (url, options) => {
    mockCalls++;
    idempotencyHeaders.push(options.headers['Idempotency-Key']);
    if (!accepted.has(options.headers['Idempotency-Key'])) {
      accepted.set(options.headers['Idempotency-Key'], { body: options.body, id: 'mock-email-id' });
      mockAccepts++;
    } else {
      T.check(accepted.get(options.headers['Idempotency-Key']).body === options.body,
        '재요청은 같은 idempotency key와 동일 payload를 사용한다');
    }
    if (dropFirstResponse) {
      dropFirstResponse = false;
      throw new Error('simulated response loss after mock provider acceptance');
    }
    return { ok: true, status: 200, json: async () => ({ id: accepted.get(options.headers['Idempotency-Key']).id }) };
  };
  try {
    const first = await emailChannel.send(testPayload);
    const retry = await emailChannel.send(testPayload);
    T.check(!first.ok && first.uncertain === true, '응답 유실은 전달 여부 미확정으로 분류된다');
    T.check(retry.ok && retry.id === 'mock-email-id', 'mock provider 재요청은 최초 이메일 ID를 돌려준다');
    T.check(mockCalls === 2 && mockAccepts === 1 && accepted.size === 1,
      'Idempotency-Key가 provider 수락을 한 번으로 제한한다');
    T.check(idempotencyHeaders.every(k => k === testPayload.idempotencyKey), '모든 provider 시도에 같은 Idempotency-Key 전달');
  } finally {
    global.fetch = previousFetch;
    if (previousResendKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousResendKey;
    delete require.cache[emailPath];
    if (previousEmailModule) require.cache[emailPath] = previousEmailModule;
  }

  T.done();
}

main().catch(e => { console.error(e); process.exitCode = 1; });

