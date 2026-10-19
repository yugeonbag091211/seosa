'use strict';
/*
 * AI Concierge v2 — 대화 속 상품 기억 (서버 서명).
 *
 * ── 왜 생겼나 (2026-10-18) ──────────────────────────────────────────
 *
 * v1 은 "직전 추천 1위" 하나만 서명 참조(air2)로 돌려받았다. 그래서
 *   · "두 번째 거" · "첫 번째 제품" 처럼 순서로 가리키면 대상이 없었고
 *   · 답변에 추천이 없는 턴(일반 대화)이 끼면 웹이 그 값을 '' 로 덮어써 기억이 사라졌다
 *     (public/index.html: AppState.lastTopRecommendationRef = res.topRecommendationRef || '').
 *
 * 이제 직전 답변에서 «카드로 보여 준 상품들» 을 보여 준 순서 그대로, 그 앞 답변의 상품
 * 몇 개와 함께 한 토큰에 서명해 같은 필드(topRecommendationRef → prevTopRef)로 돌려준다.
 * 웹·앱은 이 값을 해석하지 않고 그대로 되돌려 보내므로 클라이언트 수정이 필요 없다.
 * 상품이 없는 턴에도 기억을 다시 서명해 내려보내므로 일반 대화가 끼어도 이어진다.
 *
 * ── 신뢰 경계 ───────────────────────────────────────────────────────
 *
 *   · 토큰은 «무엇을 보여 줬는가» (productId·옵션 ID·몰) 만 증명한다. 가격·상품명은
 *     싣지 않는다 — 다음 요청에서 서버가 카탈로그로 다시 확인한다 (api/_aicontext.js).
 *   · 서명이 틀리거나 만료됐거나 형식이 다르면 통째로 버린다. 일부만 믿지 않는다.
 *   · 쿠팡 상품은 옵션 ID 없이 싣지 않는다 (옵션을 특정할 수 없는 참조는 임의 선택이 된다).
 *   · v1 토큰(air2)도 읽는다 — 플래그를 켠 직후 대화가 끊기지 않게. 반대로 v1 은 이 토큰을
 *     모르는 형식으로 보고 null 로 다룬다(플래그를 꺼도 오류 없이 "참조 없음" 이 된다).
 */

const crypto = require('crypto');
const AC = require('./_aicontext');

const PREFIX = 'aim1';
const LABEL = 'seosa-ai-agent-memory-v1';
/** 이어지는 대화를 덮을 만큼 — v1 추천 참조와 같은 수명. 매 턴 다시 서명된다. */
const TTL_MS = AC.REF_TTL_MS;
const CLOCK_SKEW_MS = 60 * 1000;
const MAX_CURRENT = 5;
const MAX_OLDER = 3;
const MAX_TOKEN_LEN = 4096;
const ID_LEN = 128;

function keyFor() {
  const base = process.env.AUTH_SECRET || process.env.SUPABASE_SECRET_KEY;
  if (!base) return null;
  return crypto.createHmac('sha256', String(base)).update(LABEL).digest();
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function unb64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function cleanId(v, n) {
  return String(v == null ? '' : v).replace(/\p{C}/gu, '').replace(/[<>\s]/g, '').slice(0, n);
}

/** 상품 → 서명할 선택자. 식별자가 모자라면 null. */
function selectorOf(item) {
  const productId = cleanId(item && item.productId, ID_LEN);
  const vendorItemId = cleanId(item && item.vendorItemId, ID_LEN);
  const mall = cleanId(item && (item.mallId || item.mall), 30);
  if (!productId || !mall) return null;
  if (AC.isCoupangMall(mall) && !vendorItemId) return null;
  return { p: productId, v: vendorItemId, m: mall };
}

function sameSel(a, b) {
  return !!a && !!b && a.p === b.p && a.v === b.v && a.m === b.m;
}

/**
 * @param {{current:Array, older?:Array, primary?:number}} mem  current/older 는 상품(또는 선택자)
 * @returns {string} 서명 토큰. 비밀값이 없거나 실을 상품이 없으면 ''.
 */
function create(mem, now) {
  const key = keyFor();
  if (!key || !mem) return '';
  const current = [];
  (mem.current || []).forEach(it => {
    const s = it && it.p ? it : selectorOf(it);
    if (s && current.length < MAX_CURRENT && !current.some(x => sameSel(x, s))) current.push(s);
  });
  const older = [];
  (mem.older || []).forEach(it => {
    const s = it && it.p ? it : selectorOf(it);
    if (s && older.length < MAX_OLDER && !current.some(x => sameSel(x, s)) && !older.some(x => sameSel(x, s))) older.push(s);
  });
  if (!current.length && !older.length) return '';
  const primary = Number.isInteger(mem.primary) && mem.primary >= 0 && mem.primary < current.length ? mem.primary : -1;
  const iat = Number.isFinite(now) ? now : Date.now();
  const payload = b64url(JSON.stringify({ c: current, o: older, pi: primary, iat, exp: iat + TTL_MS }));
  const sig = b64url(crypto.createHmac('sha256', key).update(`${PREFIX}.${payload}`).digest());
  const token = `${PREFIX}.${payload}.${sig}`;
  return token.length <= MAX_TOKEN_LEN ? token : '';
}

function toSelector(s) {
  return { productId: s.p, vendorItemId: s.v, mall: s.m, mallId: s.m, title: '' };
}

function validSel(s) {
  if (!s || typeof s !== 'object') return null;
  const p = cleanId(s.p, ID_LEN);
  const v = cleanId(s.v, ID_LEN);
  const m = cleanId(s.m, 30);
  if (!p || !m || p !== s.p || v !== String(s.v || '') || m !== s.m) return null;
  if (AC.isCoupangMall(m) && !v) return null;
  return { p, v, m };
}

/**
 * @returns {{current:Array, older:Array, primary:number, legacy:boolean}|null}
 *   current/older 는 api/_aicontext 선택자 모양({productId, vendorItemId, mall, mallId}).
 */
function read(token, now) {
  const raw = String(token || '');
  if (!raw || raw.length > MAX_TOKEN_LEN) return null;
  if (raw.startsWith('air2.')) {
    const ref = AC.verifyRecommendationRef(raw, now);
    return ref ? { current: [ref], older: [], primary: 0, legacy: true } : null;
  }
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX
      || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return null;
  const key = keyFor();
  if (!key) return null;
  try {
    const expected = crypto.createHmac('sha256', key).update(`${PREFIX}.${parts[1]}`).digest();
    const got = unb64url(parts[2]);
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
    const d = JSON.parse(unb64url(parts[1]).toString('utf8'));
    const t = Number.isFinite(now) ? now : Date.now();
    const iat = Number(d && d.iat);
    const exp = Number(d && d.exp);
    if (!Number.isFinite(iat) || !Number.isFinite(exp)) return null;
    if (iat > t + CLOCK_SKEW_MS || exp < t || exp - iat > TTL_MS) return null;
    const c = Array.isArray(d.c) ? d.c.slice(0, MAX_CURRENT).map(validSel) : [];
    const o = Array.isArray(d.o) ? d.o.slice(0, MAX_OLDER).map(validSel) : [];
    // 한 칸이라도 형식이 틀리면 토큰 전체를 버린다 (서명은 맞는데 내용이 이상하다 = 우리 버그).
    if (c.some(x => !x) || o.some(x => !x)) return null;
    const pi = Number(d.pi);
    return {
      current: c.map(toSelector),
      older: o.map(toSelector),
      primary: Number.isInteger(pi) && pi >= 0 && pi < c.length ? pi : -1,
      legacy: false
    };
  } catch (e) {
    return null;
  }
}

module.exports = { create, read, selectorOf, PREFIX, TTL_MS, MAX_CURRENT, MAX_OLDER };
