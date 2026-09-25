'use strict';
/*
 * ② 구매 대기실 — 규칙 (순수 함수).
 *
 * ── 이 파일이 정하는 것 ─────────────────────────────────────────────
 *
 *   1) 무엇을 받아 줄 것인가       validateSave
 *   2) 언제 메일을 보낼 것인가      evaluate  (결정론 — LLM 을 부르지 않는다)
 *   3) 화면에 무엇을 보여 줄 것인가 publicItem
 *   4) 메일 본문                    emailHtml
 *
 * DB 는 api/_waitroom-api.js(사용자 요청)와 scripts/check-waitroom.js(매일 잡)가 다룬다.
 * 두 곳이 같은 규칙을 쓰도록 판단은 전부 여기에 있다.
 *
 * ── 중복 알림을 막는 규칙 ───────────────────────────────────────────
 *
 * 레이더(api/_radar.js)와 같은 원칙이다: 목표가 도달은 `현재가 <= 목표가` 하나로 정한다.
 * 다만 매일 도는 잡이 그 조건만 보면, 목표가 아래에 머무는 동안 매일 메일이 간다.
 * 그래서 «무장(armed)» 을 둔다.
 *
 *     WAITING(armed) ── 가격 ≤ 목표 ──▶ 메일 1통 ──▶ REACHED(disarmed)
 *          ▲                                              │
 *          └──── 가격 > 목표 × REARM_RATIO 로 다시 오름 ◀──┘
 *
 *   · REARM_RATIO(1.03) 는 히스테리시스다. 목표가 ±1% 를 오가는 상품이 매일 무장·발사를
 *     반복하지 않게 한다.
 *   · 그래도 같은 항목은 COOLDOWN_DAYS(7) 안에 두 번 알리지 않는다.
 *   · 오래된 가격으로는 알리지 않는다. 마지막 관측이 NOTIFY_MAX_STALE_DAYS(1) 보다
 *     오래됐으면, 그 가격이 지금도 그 가격이라는 보장이 없다 — 메일은 되돌릴 수 없다.
 *   · 하루 한 통은 DB 가 보증한다 (waitroom_notifications UNIQUE (item_id, notify_date)).
 */

const { isSanePrice } = require('./_price');

/** 사용자당 최대 항목 수. 무제한이면 매일 잡이 한 사용자에게 수십 통을 보낼 수 있다. */
const MAX_ITEMS_PER_USER = 50;
/** 목표가가 현재가의 이 배수를 넘으면 받지 않는다 (0 하나를 더 친 실수 — 등록 즉시 «도달»). */
const TARGET_MAX_RATIO = 5;
/** 다시 무장하려면 가격이 목표가의 이 배수 «위로» 올라가야 한다. */
const REARM_RATIO = 1.03;
/** 같은 항목은 이 일수 안에 두 번 알리지 않는다. */
const COOLDOWN_DAYS = 7;
/** 이보다 오래된 관측으로는 알리지 않는다 (KST 달력 일수). */
const NOTIFY_MAX_STALE_DAYS = 1;
/** 발송 실패 시 같은 날 다시 시도하는 최대 횟수. */
const MAX_ATTEMPTS = 3;

const MALLS = ['쿠팡', 'ADPICK'];
const STATUS = { WAITING: 'WAITING', REACHED: 'REACHED', PAUSED: 'PAUSED' };

function str(v, max) {
  // 제어·서식 문자를 지운다 — 판매자 문자열이 메일 제목·본문으로 간다.
  return String(v == null ? '' : v).replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function httpsOrEmpty(v) {
  const s = String(v == null ? '' : v).trim().slice(0, 2000);
  return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s : '';
}
function dayNum(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : NaN;
}

/**
 * 저장 요청 검증.
 * @returns {{ok:true, value:object} | {ok:false, error:string}}
 */
function validateSave(body) {
  const b = body && typeof body === 'object' ? body : {};
  const productId = str(b.productId, 120);
  if (!/^[\w.-]{1,120}$/.test(productId)) return { ok: false, error: '상품 번호가 올바르지 않아요' };
  const mall = str(b.mall, 40);
  if (MALLS.indexOf(mall) === -1) return { ok: false, error: '지원하는 판매처는 쿠팡·ADPICK 이에요' };
  const vendorItemId = str(b.vendorItemId, 120);
  if (vendorItemId && !/^[\w.-]{1,120}$/.test(vendorItemId)) return { ok: false, error: '옵션 번호가 올바르지 않아요' };
  const title = str(b.title, 300);
  if (!title) return { ok: false, error: '상품 이름이 필요해요' };
  const target = Number(b.targetPrice);
  if (!Number.isInteger(target) || !isSanePrice(target)) {
    return { ok: false, error: '목표 가격은 1원 이상 1억 원 이하의 정수로 넣어 주세요' };
  }
  return {
    ok: true,
    value: {
      productId, mall, vendorItemId, title, targetPrice: target,
      link: httpsOrEmpty(b.link), image: httpsOrEmpty(b.image)
    }
  };
}

/**
 * 목표가가 현재가에 비춰 말이 되는가.
 * @returns {{ok:boolean, error?:string, reachedNow:boolean}}
 */
function checkTarget(target, currentPrice) {
  const cur = Math.round(Number(currentPrice) || 0);
  if (cur > 0 && target > cur * TARGET_MAX_RATIO) {
    return { ok: false, reachedNow: true, error: `목표 가격이 지금 가격(${cur.toLocaleString('ko-KR')}원)보다 훨씬 높아요. 숫자를 확인해 주세요` };
  }
  return { ok: true, reachedNow: cur > 0 && cur <= target };
}

/**
 * 매일 잡이 항목 하나에 대해 할 일.
 *
 * @param {object} item  waitroom_items 행
 * @param {{price:number, observedAt:string, observedDate:string}|null} obs  이 항목 옵션의 최신 관측
 * @param {{today:string, now?:number}} ctx
 * @returns {{action:'NOTIFY'|'REARM'|'NONE', patch:object, reason:string}}
 *   patch 는 «관측 반영» 분(last_price 등). NOTIFY 의 발송 후 갱신은 afterSend 가 만든다.
 */
function evaluate(item, obs, ctx) {
  const now = (ctx && ctx.now) || Date.now();
  const today = ctx && ctx.today;
  const patch = {};
  if (!item) return { action: 'NONE', patch, reason: 'no-item' };
  if (!obs || !(Number(obs.price) > 0)) return { action: 'NONE', patch, reason: 'no-observation' };

  const price = Math.round(Number(obs.price));
  const target = Math.round(Number(item.target_price));
  const lastAt = item.last_price_at ? Date.parse(item.last_price_at) : NaN;
  const obsAt = Date.parse(obs.observedAt || '');
  if (!Number.isFinite(lastAt) || (Number.isFinite(obsAt) && obsAt > lastAt) || item.last_price !== price) {
    patch.last_price = price;
    if (Number.isFinite(obsAt)) patch.last_price_at = new Date(obsAt).toISOString();
  }

  if (item.status === STATUS.PAUSED) return { action: 'NONE', patch, reason: 'paused' };
  if (!(target > 0)) return { action: 'NONE', patch, reason: 'no-target' };

  if (price > target * REARM_RATIO) {
    if (!item.armed || item.status === STATUS.REACHED) {
      return { action: 'REARM', patch: Object.assign(patch, { armed: true, status: STATUS.WAITING }), reason: 'above-target' };
    }
    return { action: 'NONE', patch, reason: 'above-target' };
  }
  if (price > target) return { action: 'NONE', patch, reason: 'hysteresis-band' };

  // price <= target
  if (!item.armed) return { action: 'NONE', patch, reason: 'already-notified' };
  const staleDays = today && obs.observedDate ? dayNum(today) - dayNum(obs.observedDate) : NaN;
  if (!Number.isFinite(staleDays) || staleDays > NOTIFY_MAX_STALE_DAYS) {
    return { action: 'NONE', patch, reason: 'stale-observation' };
  }
  const lastNotified = item.notified_at ? Date.parse(item.notified_at) : NaN;
  if (Number.isFinite(lastNotified) && now - lastNotified < COOLDOWN_DAYS * 86400000) {
    return { action: 'NONE', patch, reason: 'cooldown' };
  }
  return { action: 'NOTIFY', patch, reason: 'target-reached' };
}

/**
 * 중복 발송을 막는 단위 — «같은 사람 · 같은 상품» (email, product_id, mall).
 *
 * item_id 가 아니다. 첫 판은 item_id 로 막아서, 알림 뒤 항목을 지우고 다시 담거나
 * 같은 상품을 옵션 번호 있이/없이 두 번 담으면 같은 날 같은 상품 메일이 두 통 갔다
 * (scripts/test-v2-waitroom.js «계열 중복» 절). 메일 본문도 «같은 상품은 7일에 한 번까지»
 * 라고 약속한다. vendor_item_id 는 넣지 않는다 — 옵션 표기 차이가 곧 우회로였다.
 */
function seriesKey(row) {
  return [row.email, row.product_id, row.mall].map(v => String(v == null ? '' : v)).join('|');
}

/**
 * Resend Idempotency-Key — «같은 사람·같은 상품 · 날짜 · 시도 번호». 이메일 원문은 싣지 않는다.
 *
 * Resend 공식 문서(2026-09-25 확인): 키는 24시간 보존되고, 같은 키·같은 본문이면 다시 보내지 않고
 * 원래 응답을 준다. 같은 키에 «다른 본문» 이면 409 invalid_idempotent_request, 동시 요청은
 * 409 concurrent_idempotent_requests.
 *   · 항목을 지우고 다시 담아도 같은 계열·날짜·시도면 같은 키다 → 공급자가 한 통으로 합친다.
 *   · 시도 번호를 넣는 이유: 명확한 거절(4xx)은 발송이 없었다는 뜻인데, 같은 날 재시도 때 가격이
 *     바뀌어 본문이 달라지면 같은 키로는 409 를 받아 «수락 여부 불명» 으로 영영 막혔다.
 *     재시도는 명확한 거절 뒤에만 일어나므로(불명은 재시도하지 않는다) 새 키가 안전하다.
 */
function providerKey(row, date, attempt) {
  const h = require('crypto').createHash('sha256').update(seriesKey(row)).digest('hex').slice(0, 32);
  return `waitroom/${h}/${date}/${Math.max(1, Math.floor(Number(attempt) || 1))}`;
}

/** 발송 성공 뒤 항목에 남길 값. */
function afterSend(item, price, nowIso) {
  return {
    armed: false,
    status: STATUS.REACHED,
    notified_at: nowIso,
    notified_price: price,
    notify_count: (Number(item.notify_count) || 0) + 1,
    updated_at: nowIso
  };
}

/**
 * 화면에 내보낼 모양 (CONTRACTS.md §3 ② Item).
 * @param {object} row       waitroom_items 행
 * @param {{tracked:boolean, lastPrice?:number, lastDate?:string}} [live]  카탈로그·원장에서 본 값
 */
function publicItem(row, live) {
  const l = live || {};
  const lastPrice = row.last_price != null ? row.last_price : (l.lastPrice || null);
  const lastPriceAt = row.last_price_at || (l.lastDate || null);
  const target = row.target_price;
  return {
    id: row.id,
    productId: row.product_id,
    mall: row.mall,
    vendorItemId: row.vendor_item_id || '',
    title: row.title,
    image: row.image || '',
    link: row.link || '',
    targetPrice: target,
    status: row.status,
    armed: !!row.armed,
    tracking: l.tracked ? 'TRACKED' : 'UNTRACKED',
    lastPrice,
    lastPriceAt,
    gapPct: lastPrice && target ? Math.round(((lastPrice - target) / target) * 1000) / 10 : null,
    reached: !!(lastPrice && target && lastPrice <= target),
    notifiedAt: row.notified_at || null,
    notifiedPrice: row.notified_price == null ? null : row.notified_price,
    createdAt: row.created_at || null
  };
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function won(n) { return Math.round(Number(n) || 0).toLocaleString('ko-KR'); }

/**
 * 도달 메일. 기존 가격 알림 서식(api/_channel/email.js)은 «이 알림은 한 번만 발송됩니다» 라고
 * 약속한다 — 대기실은 다시 무장하므로 그 문구가 거짓이 된다. 그래서 본문을 따로 만든다.
 */
function emailHtml(o) {
  const manage = `${o.origin || 'https://seosa.ai.kr'}/v2/waitroom.html`;
  const link = httpsOrEmpty(o.link);
  const img = httpsOrEmpty(o.image);
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>SEOSA 구매 대기실</title></head>
<body style="margin:0;padding:24px;background:#f5f5f4;font-family:'Apple SD Gothic Neo','Noto Sans KR',sans-serif;color:#15171b">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:auto;background:#fff;border:1px solid #e2e5e9;border-radius:6px">
<tr><td style="padding:20px 28px;border-bottom:1px solid #e2e5e9"><b style="letter-spacing:.1em">SEOSA</b>
<span style="color:#8a6d1c;font-size:12px;margin-left:8px">구매 대기실</span></td></tr>
<tr><td style="padding:24px 28px">
${img ? `<img src="${esc(img)}" alt="" style="max-width:200px;max-height:160px;display:block;margin:0 auto 16px">` : ''}
<div style="font-size:15px;font-weight:700;line-height:1.5">${esc(o.title)}</div>
<div style="font-size:28px;font-weight:800;color:#0a7a46;margin-top:10px">${won(o.price)}원</div>
<div style="font-size:13px;color:#585e68">설정하신 목표 가격 ${won(o.target)}원에 도달했어요 · ${esc(o.mall)} · ${esc(o.observedDate)} 기록</div>
${link ? `<p style="margin:22px 0 0"><a href="${esc(link)}" style="display:inline-block;background:#15171b;color:#fff;padding:12px 24px;border-radius:4px;text-decoration:none;font-weight:700">판매처에서 확인하기</a></p>` : ''}
<p style="font-size:12px;color:#585e68;margin-top:22px;line-height:1.6">가격은 SEOSA가 확인한 시점의 기록이에요. 실제 결제 금액은 판매처에서 확인해 주세요.<br>
가격이 목표가보다 다시 오른 뒤 내려오면 한 번 더 알려 드려요 (같은 상품은 7일에 한 번까지).<br>
<a href="${esc(manage)}" style="color:#585e68">대기실에서 알림 끄기·목표가 바꾸기</a></p>
</td></tr></table></body></html>`;
}

module.exports = {
  validateSave, checkTarget, evaluate, afterSend, publicItem, emailHtml, seriesKey, providerKey,
  MAX_ITEMS_PER_USER, TARGET_MAX_RATIO, REARM_RATIO, COOLDOWN_DAYS, NOTIFY_MAX_STALE_DAYS,
  MAX_ATTEMPTS, MALLS, STATUS
};
