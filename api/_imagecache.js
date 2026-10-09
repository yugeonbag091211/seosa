'use strict';
/*
 * ADPICK 상품 사진 원본 캐시 (2026-10-09).
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────────
 *   ADPICK 검색 응답의 photo 는 d2iaagr1j041pi.cloudfront.net/apis/search_img.php?code=…
 *   하나뿐이다(원본 응답 60개 실측: 필드는 title/price/photo/cp_code/cp_name/cp_icon/
 *   commissionlink, cp_icon 은 판매처 로고). 이 code 는 검색할 때마다 새로 발급되고
 *   (같은 상품 3,236개 전부 검색마다 다른 code) 발급 후 3h 까지는 열리고 6h 가 넘으면
 *   전부 404 다. 카탈로그는 처음 받은 주소를 영구히 들고 있으므로 ADPICK 카드 사진이
 *   몇 시간 뒤 전부 죽는다.
 *
 * ── 무엇을 하나 ──────────────────────────────────────────────────────
 *   수집기가 «이미 받은» 응답의 photo 가 아직 살아 있을 때 그 바이트를 그대로
 *   Supabase Storage 에 한 번 저장하고, 카탈로그에는 Storage 공개 주소를 남긴다.
 *     · 이미지 때문에 ADPICK 검색 API 를 부르지 않는다. 네트워크는 사진 주소 GET 하나.
 *     · 원본 바이트 그대로. 리사이즈·크롭·재압축·워터마크 없음.
 *     · 상품당 키 하나(adpick-products/{productId}.{ext}) — 같은 상품을 두 번 받지 않는다.
 *     · 실패는 조용히 넘어간다. 가격 저장은 이 모듈의 성패와 무관하다.
 *
 * ── 켜는 법 ──────────────────────────────────────────────────────────
 *   ADPICK_IMAGE_CACHE=1 + 버킷(supabase/2026-10-09-product-images-bucket.sql).
 *   기본은 꺼져 있다 — ADPICK 이용 안내의 «상품 정보 저장·가공 불허» 문구 검토가 먼저다.
 *   버킷이 없으면 첫 실패에서 이 프로세스의 캐시를 끄고 수집은 그대로 간다.
 */

const BUCKET = 'product-images';
const PREFIX = 'adpick-products';
const MAX_BYTES = 2 * 1024 * 1024;   // 실측 25–115KB(640x640). 2MB 를 넘으면 사진이 아니라고 본다
const MIN_BYTES = 256;
const FETCH_TIMEOUT_MS = 6000;
const CONCURRENCY = 4;
const CALL_BUDGET_MS = 20000;        // recordPrices 한 번이 사진 때문에 기다리는 최대 시간
const MAX_PER_PROCESS = 1500;        // 수집기 한 실행이 시도하는 사진 수 상한

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };

function enabled(env = process.env) {
  return env.ADPICK_IMAGE_CACHE === '1';
}

/** ADPICK 이 검색마다 새로 발급하는 임시 사진 주소인가. */
function isEphemeralAdpickImage(value) {
  try {
    const u = new URL(String(value || ''));
    return u.protocol === 'https:' && /(^|\.)cloudfront\.net$/i.test(u.hostname)
      && /\/apis\/search_img\.php$/i.test(u.pathname) && /^\d+$/.test(u.searchParams.get('code') || '');
  } catch (_) {
    return false;
  }
}

/** 우리 Storage 에 이미 저장된 사진 주소인가. */
function isCachedImageUrl(value, supabaseUrl = process.env.SUPABASE_URL) {
  const base = String(supabaseUrl || '').replace(/\/+$/, '');
  if (!base) return false;
  return String(value || '').startsWith(`${base}/storage/v1/object/public/${BUCKET}/`);
}

/**
 * 이 상품의 사진을 지금 저장해야 하는가.
 *   · 이미 우리 Storage 주소 → 아니다 (중복 저장 금지)
 *   · daumcdn 등 임시가 아닌 주소 → 아니다 (멀쩡한 주소를 건드리지 않는다)
 *   · 지금 받은 photo 가 임시 주소일 때만 → 그렇다
 */
function needsCache(currentImage, freshImage, opts = {}) {
  const cur = String(currentImage || '');
  if (isCachedImageUrl(cur, opts.supabaseUrl)) return false;
  if (cur && !isEphemeralAdpickImage(cur)) return false;
  return isEphemeralAdpickImage(freshImage);
}

/** 바이트 머리가 선언한 형식과 맞는가 — text/html 을 image/jpeg 라고 우기는 응답을 거른다. */
function sniffMatches(buf, contentType) {
  if (!buf || buf.length < 12) return false;
  switch (contentType) {
    case 'image/jpeg': return buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
    case 'image/png': return buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
    case 'image/gif': return buf.slice(0, 4).toString('latin1') === 'GIF8';
    case 'image/webp': return buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP';
    case 'image/avif': return buf.slice(4, 8).toString('latin1') === 'ftyp';
    default: return false;
  }
}

/**
 * 사진 주소를 GET 해서 원본 바이트를 받는다. 받은 그대로 돌려준다(가공 없음).
 * @returns {{ok:true, bytes:Buffer, contentType:string, ms:number} | {ok:false, reason:string, ms:number}}
 */
async function fetchImage(url, opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  const maxBytes = opts.maxBytes || MAX_BYTES;
  const started = Date.now();
  const fail = reason => ({ ok: false, reason, ms: Date.now() - started });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs || FETCH_TIMEOUT_MS);
  try {
    const r = await fetchImpl(url, { redirect: 'follow', signal: ac.signal, headers: { Accept: 'image/*' } });
    if (r.status !== 200) return fail(`http_${r.status}`);
    const contentType = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!EXT[contentType]) return fail(`content_type:${contentType || 'none'}`);
    const declared = Number(r.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) return fail('too_large');

    // 본문은 상한까지만 읽는다 — 길이를 숨긴 거대한 응답도 메모리에 다 올리지 않는다.
    const chunks = [];
    let size = 0;
    if (r.body && typeof r.body.getReader === 'function') {
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) { try { await reader.cancel(); } catch (_) { /* 이미 끊김 */ } return fail('too_large'); }
        chunks.push(Buffer.from(value));
      }
    } else {
      const b = Buffer.from(await r.arrayBuffer());
      size = b.length;
      if (size > maxBytes) return fail('too_large');
      chunks.push(b);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length < MIN_BYTES) return fail('too_small');
    if (!sniffMatches(bytes, contentType)) return fail('signature_mismatch');
    return { ok: true, bytes, contentType, ms: Date.now() - started };
  } catch (e) {
    return fail(ac.signal.aborted ? 'timeout' : `network:${(e && e.cause && e.cause.code) || (e && e.name) || 'error'}`);
  } finally {
    clearTimeout(timer);
  }
}

function objectKey(productId, contentType) {
  const id = String(productId || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !EXT[contentType]) return '';
  return `${PREFIX}/${id}.${EXT[contentType]}`;
}

function publicUrl(key, supabaseUrl = process.env.SUPABASE_URL) {
  return `${String(supabaseUrl || '').replace(/\/+$/, '')}/storage/v1/object/public/${BUCKET}/${key}`;
}

function isDuplicateError(err) {
  const m = String((err && (err.message || err.error)) || '');
  return /already exists|duplicate/i.test(m) || String(err && err.statusCode) === '409';
}
function isMissingBucket(err) {
  return /bucket not found/i.test(String((err && (err.message || err.error)) || ''));
}

/* 프로세스 상태 — 버킷이 없으면 한 번만 경고하고 끈다. */
const state = { disabled: false, warned: false, attempted: 0 };
function _resetState() { state.disabled = false; state.warned = false; state.attempted = 0; }

/**
 * 상품 하나의 사진을 저장한다.
 * @returns {{ok:true, url, key, bytes, ms, dedup?:true} | {ok:false, reason}}
 */
async function cacheOne({ productId, url }, opts = {}) {
  const storage = opts.storage;
  const got = await fetchImage(url, opts);
  if (!got.ok) return { ok: false, reason: got.reason, ms: got.ms };
  const key = objectKey(productId, got.contentType);
  if (!key) return { ok: false, reason: 'bad_key', ms: got.ms };

  const t0 = Date.now();
  const { error } = await storage.from(BUCKET).upload(key, got.bytes, {
    contentType: got.contentType,
    cacheControl: '31536000',
    upsert: false               // 이미 있으면 덮지 않는다 — 같은 상품의 첫 사진이 정본이다
  });
  const uploadMs = Date.now() - t0;
  if (error && !isDuplicateError(error)) {
    return { ok: false, reason: isMissingBucket(error) ? 'bucket_missing' : `upload:${String(error.message || error).slice(0, 80)}`, ms: got.ms + uploadMs };
  }
  return { ok: true, url: publicUrl(key, opts.supabaseUrl), key, bytes: got.bytes.length,
    fetchMs: got.ms, uploadMs, ms: got.ms + uploadMs, dedup: !!error };
}

/**
 * 후보 여럿을 제한된 동시성·시간 안에서 저장한다. 절대 throw 하지 않는다.
 *
 * @param {Array<{productId, currentImage, freshImage}>} items
 * @param {object} opts  storage(필수) · fetch · supabaseUrl · concurrency · budgetMs · maxPerProcess · log
 * @returns {Promise<{urls: Map<productId,url>, stats}>}
 */
async function cacheImages(items, opts = {}) {
  const urls = new Map();
  const stats = { candidates: 0, attempted: 0, saved: 0, dedup: 0, failed: 0, skipped: 0, reasons: {}, bytes: 0, ms: 0 };
  if (state.disabled || !opts.storage) return { urls, stats };

  const seen = new Set();
  const queue = [];
  for (const it of items || []) {
    if (!it || seen.has(it.productId)) continue;
    if (!needsCache(it.currentImage, it.freshImage, opts)) continue;
    seen.add(it.productId);
    queue.push(it);
  }
  stats.candidates = queue.length;
  const cap = opts.maxPerProcess == null ? MAX_PER_PROCESS : opts.maxPerProcess;
  const deadline = Date.now() + (opts.budgetMs == null ? CALL_BUDGET_MS : opts.budgetMs);
  const log = opts.log || (msg => console.warn(msg));

  let next = 0;
  async function worker() {
    while (next < queue.length) {
      const it = queue[next++];
      if (state.disabled || Date.now() >= deadline || state.attempted >= cap) { stats.skipped++; continue; }
      state.attempted++;
      stats.attempted++;
      let r;
      try {
        r = await cacheOne({ productId: it.productId, url: it.freshImage }, opts);
      } catch (e) {
        r = { ok: false, reason: `exception:${String(e && e.message || e).slice(0, 60)}` };
      }
      if (r.ok) {
        urls.set(it.productId, r.url);
        stats.saved++;
        if (r.dedup) stats.dedup++;
        stats.bytes += r.bytes || 0;
        stats.ms += r.ms || 0;
      } else {
        stats.failed++;
        stats.reasons[r.reason] = (stats.reasons[r.reason] || 0) + 1;
        if (r.reason === 'bucket_missing') {
          state.disabled = true;
          if (!state.warned) {
            state.warned = true;
            log(`[imagecache] Storage 버킷 '${BUCKET}' 없음 — 이 실행의 사진 캐시를 끕니다 `
              + '(supabase/2026-10-09-product-images-bucket.sql). 가격 수집은 그대로 진행합니다.');
          }
        }
      }
    }
  }
  const n = Math.max(1, Math.min(opts.concurrency || CONCURRENCY, queue.length));
  await Promise.all(Array.from({ length: n }, worker));
  return { urls, stats };
}

module.exports = {
  BUCKET, PREFIX, MAX_BYTES, MIN_BYTES, EXT,
  enabled, isEphemeralAdpickImage, isCachedImageUrl, needsCache, sniffMatches,
  fetchImage, objectKey, publicUrl, cacheOne, cacheImages, _resetState
};
