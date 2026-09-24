'use strict';
/*
 * /api/waitroom — ② 구매 대기실 (docs/seosa2/CONTRACTS.md §3 ②).
 *
 *   GET                                  내 항목 목록
 *   POST { action:'save', … }            등록·목표가 변경 (같은 가격 계열이면 갱신)
 *   POST { action:'pause'|'resume', id } 알림 끄기·켜기
 *   DELETE { id }                        삭제 (자기 항목만)
 *
 * 새 서버리스 함수가 아니다 — api/alerts.js 첫 줄의 v2 훅이 이리로 넘긴다 (api/_v2router.js).
 *
 * ── 신원 ───────────────────────────────────────────────────────────
 * 이메일은 «서명이 검증된 토큰» 에서만 꺼낸다 (_auth.identify). 본문·쿼리의 email 은
 * 읽지 않는다 — 읽으면 남의 이메일로 남의 대기실을 보거나 지울 수 있다.
 * 모든 쿼리는 .eq('email', 토큰 이메일) 로 좁힌다. id 만으로 행을 건드리지 않는다.
 *
 * ── 마이그레이션 전 ───────────────────────────────────────────────
 * supabase/2026-09-24-seosa2-waitroom.sql 이 운영에 없으면 503 WAITROOM_NOT_READY.
 * 조용히 빈 목록을 주면 사용자는 등록이 된 줄 안다.
 */

const supabase = require('./_supabase');
const { applyCors, noStore, readBody, fail } = require('./_http');
const { guard } = require('./_ratelimit');
const { identify } = require('./_auth');
const { isMissingObject } = require('./_dberror');
const { loadStats } = require('./_pricestat');
const { productLifecycle } = require('./_price');
const W = require('./_waitroom');

const COLS = 'id, email, product_id, mall, vendor_item_id, title, image, link, target_price, status, armed,'
  + ' last_price, last_price_at, notified_at, notified_price, notify_count, created_at, updated_at';
const CHUNK = 60;

class NotReady extends Error {}

function check(error) {
  if (!error) return;
  if (isMissingObject(error)) throw new NotReady('waitroom tables missing');
  throw new Error(error.message);
}

function readId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * 카탈로그에 있고 수집기가 다시 찾아갈 수 있는가(= 매일 가격이 쌓이는가),
 * 그리고 지금 원장에 있는 마지막 가격.
 */
async function liveInfo(rows) {
  const out = new Map();
  if (!rows.length) return out;
  const ids = [...new Set(rows.map(r => r.product_id))];
  const catalog = new Map();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await supabase.from('products')
      .select('product_id, mall, keyword, lprice, collected_at')
      .in('product_id', ids.slice(i, i + CHUNK));
    if (error) { console.warn(`[waitroom] products 조회 실패(추적 여부 생략): ${error.message}`); break; }
    (data || []).forEach(p => catalog.set(`${p.product_id}|${p.mall}`, p));
  }
  const stats = await loadStats(rows.map(r => ({ productId: r.product_id, mall: r.mall, vendorItemId: r.vendor_item_id })));
  rows.forEach(r => {
    const key = `${r.product_id}|${r.mall}`;
    const p = catalog.get(key);
    const st = stats.get(key);
    out.set(r.id, {
      tracked: !!(p && productLifecycle(p).reachable),
      lastPrice: st ? st.lastPrice : null,
      lastDate: st ? st.lastDate : null,
      catalogPrice: p && Number(p.lprice) > 0 ? Math.round(Number(p.lprice)) : null
    });
  });
  return out;
}

async function list(email) {
  const { data, error } = await supabase.from('waitroom_items').select(COLS)
    .eq('email', email).order('created_at', { ascending: false }).limit(W.MAX_ITEMS_PER_USER);
  check(error);
  const rows = data || [];
  const live = await liveInfo(rows);
  return rows.map(r => W.publicItem(r, live.get(r.id)));
}

async function save(email, body) {
  const v = W.validateSave(body);
  if (!v.ok) return { status: 400, body: { ok: false, error: v.error, code: 'BAD_INPUT' } };
  const s = v.value;

  const { data: existing, error: exErr } = await supabase.from('waitroom_items').select('id, product_id, mall, vendor_item_id')
    .eq('email', email).limit(W.MAX_ITEMS_PER_USER + 1);
  check(exErr);
  const same = (existing || []).find(r => r.product_id === s.productId && r.mall === s.mall
    && (r.vendor_item_id || '') === s.vendorItemId);
  if (!same && (existing || []).length >= W.MAX_ITEMS_PER_USER) {
    return { status: 400, body: { ok: false, code: 'LIMIT', error: `대기실에는 ${W.MAX_ITEMS_PER_USER}개까지 담을 수 있어요` } };
  }

  // 목표가가 말이 되는지 — 지금 원장 가격(없으면 카탈로그 가격)과 견준다.
  const probe = { id: 0, product_id: s.productId, mall: s.mall, vendor_item_id: s.vendorItemId };
  const live = (await liveInfo([probe])).get(0) || {};
  const tc = W.checkTarget(s.targetPrice, live.lastPrice || live.catalogPrice);
  if (!tc.ok) return { status: 400, body: { ok: false, error: tc.error, code: 'BAD_TARGET' } };

  const nowIso = new Date().toISOString();
  const row = {
    email, product_id: s.productId, mall: s.mall, vendor_item_id: s.vendorItemId,
    title: s.title, image: s.image, link: s.link, target_price: s.targetPrice,
    // 목표가를 새로 정하면 새 의도다 — 다시 무장한다. 단, notified_at 은 지우지 않는다
    // (목표가를 바꿔 가며 메일을 여러 번 받는 것을 쿨다운이 계속 막는다).
    status: W.STATUS.WAITING, armed: true, updated_at: nowIso
  };
  const { data, error } = await supabase.from('waitroom_items')
    .upsert(row, { onConflict: 'email,product_id,mall,vendor_item_id' })
    .select(COLS);
  check(error);
  const saved = (data || [])[0];
  if (!saved) throw new Error('waitroom upsert returned no row');
  return {
    status: 200,
    body: {
      ok: true,
      item: W.publicItem(saved, live),
      reachedNow: tc.reachedNow,
      notice: [
        tc.reachedNow ? '지금 가격이 이미 목표가 이하예요. 다음 가격 확인 때 알림이 가요.' : '',
        live.tracked ? '' : 'SEOSA가 매일 가격을 확인하는 상품이 아니라서 알림이 가지 않을 수 있어요.'
      ].filter(Boolean)
    }
  };
}

async function setPaused(email, id, paused) {
  const patch = paused
    ? { status: W.STATUS.PAUSED, updated_at: new Date().toISOString() }
    : { status: W.STATUS.WAITING, armed: true, updated_at: new Date().toISOString() };
  const { data, error } = await supabase.from('waitroom_items').update(patch)
    .eq('id', id).eq('email', email).select(COLS);
  check(error);
  const row = (data || [])[0];
  if (!row) return { status: 404, body: { ok: false, error: '항목을 찾을 수 없어요', code: 'NOT_FOUND' } };
  return { status: 200, body: { ok: true, item: W.publicItem(row, null) } };
}

async function remove(email, id) {
  const { data, error } = await supabase.from('waitroom_items').delete()
    .eq('id', id).eq('email', email).select('id');
  check(error);
  if (!(data || []).length) return { status: 404, body: { ok: false, error: '항목을 찾을 수 없어요', code: 'NOT_FOUND' } };
  return { status: 200, body: { ok: true } };
}

async function handler(req, res) {
  if (!applyCors(req, res, 'private')) return;
  noStore(res);   // 개인 데이터 — 중간 캐시에 남으면 안 된다
  if (!guard(req, res, { name: 'v2-waitroom', limit: 40, windowMs: 60 * 1000 })) return;

  const who = identify(req);
  if (!who.ok) return res.status(401).json({ ok: false, error: who.reason, needsAuth: true, code: 'AUTH' });

  try {
    if (req.method === 'GET') {
      const items = await list(who.email);
      return res.json({ ok: true, items, limits: { max: W.MAX_ITEMS_PER_USER } });
    }
    const body = readBody(req);
    if (req.method === 'POST') {
      const action = String(body.action || 'save');
      let r;
      if (action === 'save') r = await save(who.email, body);
      else if (action === 'pause' || action === 'resume') {
        const id = readId(body.id);
        if (!id) return res.status(400).json({ ok: false, error: '항목 번호가 필요해요', code: 'BAD_INPUT' });
        r = await setPaused(who.email, id, action === 'pause');
      } else {
        return res.status(400).json({ ok: false, error: '알 수 없는 요청이에요', code: 'BAD_INPUT' });
      }
      return res.status(r.status).json(r.body);
    }
    if (req.method === 'DELETE') {
      const id = readId(body.id);
      if (!id) return res.status(400).json({ ok: false, error: '항목 번호가 필요해요', code: 'BAD_INPUT' });
      const r = await remove(who.email, id);
      return res.status(r.status).json(r.body);
    }
    return res.status(405).json({ ok: false, error: 'GET / POST / DELETE만 지원해요', code: 'METHOD' });
  } catch (e) {
    if (e instanceof NotReady) {
      return res.status(503).json({ ok: false, code: 'WAITROOM_NOT_READY',
        error: '구매 대기실은 아직 준비 중이에요. 곧 열어 드릴게요.' });
    }
    return fail(res, e, { where: 'v2-waitroom', route: '/api/waitroom', message: '구매 대기실을 처리하지 못했어요.' });
  }
}

module.exports = { handler, _internal: { liveInfo } };
