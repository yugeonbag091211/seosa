'use strict';

/**
 * 과거 가격 기록 아카이브(Cloudflare R2, 비공개) 읽기 + DB 신규 기록과 합치기.
 *
 * ── 무엇이 들어 있나 ─────────────────────────────────────────────
 *
 * 2026-10-20 Supabase 백업에서 뽑은 price_history 320,413행을 상품 ID 해시 첫 바이트로
 * 256개 묶음(history/v1/shards/00…ff.jsonl.gz)으로 나눴다. 한 행은
 * [product_id, mall, vendor_item_id, recorded_at, recorded_date, price, source] 배열이다.
 * recorded_at 은 COPY 원문 표기('2026-08-22 16:44:48.98+00')라 읽을 때 PostgREST 표기로 맞춘다.
 * 아카이브의 마지막 관측은 2026-10-19T22:08:57.62Z — Supabase 가 막힌 시점이다.
 *
 * ── 그래프는 어떻게 합치나 (withArchive) ─────────────────────────
 *
 *   SEOSA_R2_HISTORY_CUTOFF 가 있으면 DB 에서는 그 시각 «이후» 행만 받고, 그 이전은 아카이브에서
 *   읽는다 → 같은 그래프를 그리면서 DB 전송량(Neon 무료 5GB/월)을 아낀다. R2 전송은 무료다.
 *   컷오프가 없으면 DB 전체 + 아카이브를 합치고 겹치는 관측은 한 번만 센다(기본값, 가장 보수적).
 *
 *   ★ 아카이브를 못 읽으면 DB 만으로 그린다(컷오프 없이 다시 읽는다). R2 장애가 그래프를
 *     500 으로 만들면 안 된다 — Neon 에는 같은 기록이 전부 남아 있다(지우지 않는다).
 *
 * R2 는 공개하지 않는다. 키는 서버 환경변수로만 받고, 클라이언트 JS 에 실리지 않는다.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createGunzip } = require('node:zlib');
const readline = require('node:readline');

const BUCKET = 'seosa-price-history';
const KEY_PREFIX = 'history/v1/shards/';
// 옛 상품 ID 에는 한글·공백·쉼표가 있다. 객체 키는 해시로만 만들므로 경로 문자를 막을 필요는 없고 제어문자만 막는다.
const PID = /^[^\x00-\x1f\x7f]{1,300}$/u;
const MAX_CACHE = 16;
const CACHE_MS = 120000;
const cache = new Map();
let s3 = null;

function bucketHash(pid) {
  return crypto.createHash('sha256').update(String(pid), 'utf8').digest()[0].toString(16).padStart(2, '0');
}

function keyOf(pid) {
  if (!PID.test(String(pid))) throw new Error('Invalid product ID');
  return KEY_PREFIX + bucketHash(pid) + '.jsonl.gz';
}

/** 아카이브를 쓰는가. Production 은 SEOSA_R2_HISTORY_ENABLED=1 만 인정한다(로컬 폴더 금지). */
function archiveEnabled() {
  if (process.env.SEOSA_R2_HISTORY_ENABLED === '1') return true;
  return process.env.VERCEL_ENV !== 'production' && !!process.env.SEOSA_R2_HISTORY_LOCAL_DIR;
}

/** 아카이브가 빠짐없이 담고 있는 마지막 시각(ISO). 없거나 이상하면 null → DB 전체를 읽는다. */
function archiveCutoff() {
  const raw = String(process.env.SEOSA_R2_HISTORY_CUTOFF || '').trim();
  if (!raw) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

function r2Client() {
  if (s3) return s3;
  const account = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!account || !/^[0-9a-f]{32}$/i.test(account) || !accessKeyId || !secretAccessKey || process.env.R2_BUCKET !== BUCKET) {
    throw new Error('Private R2 credentials missing');
  }
  const { S3Client } = require('@aws-sdk/client-s3');
  s3 = new S3Client({
    region: 'auto',
    endpoint: 'https://' + account + '.r2.cloudflarestorage.com',
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
    maxAttempts: 2,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED'
  });
  return s3;
}

/** COPY 원문 시각을 Neon/PostgREST 와 같은 글자로. 같은 관측이 두 출처에서 같은 문자열이 된다. */
function normalizeAt(value) {
  if (value instanceof Date) return value.toISOString().replace('Z', '+00:00');
  if (typeof value !== 'string' || !value) return value || null;
  return require('./_neonpg')._internal.isoTimestamp(value, true);
}

async function readShard(name) {
  const local = process.env.SEOSA_R2_HISTORY_LOCAL_DIR;
  let compressed;
  if (local) {
    if (process.env.VERCEL_ENV === 'production') throw new Error('Local archive path is never allowed in Production');
    compressed = fs.createReadStream(path.join(local, name + '.jsonl.gz'));
  } else {
    if (process.env.SEOSA_R2_HISTORY_ENABLED !== '1') throw new Error('R2 price history not enabled');
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const r = await r2Client().send(new GetObjectCommand({ Bucket: BUCKET, Key: KEY_PREFIX + name + '.jsonl.gz' }));
    if (Number(r.ContentLength) > 4 * 1024 * 1024) throw new Error('Unexpectedly large R2 history shard');
    compressed = r.Body;
  }
  /*
   * ★ .pipe() 는 원본 스트림의 오류를 넘겨주지 않는다. 그대로 두면 R2 응답이 중간에 끊기거나
   *   파일이 없을 때 처리되지 않은 'error' 이벤트로 함수 프로세스가 통째로 죽는다(2026-10-21
   *   테스트에서 재현). 원본 오류로 gunzip 을 부숴 readline 반복이 예외로 끝나게 한다.
   */
  const gunzip = createGunzip();
  compressed.once('error', e => gunzip.destroy(e));
  compressed.pipe(gunzip);
  const reader = readline.createInterface({ input: gunzip, crlfDelay: Infinity });
  const result = [];
  for await (const line of reader) {
    if (!line) continue;
    const v = JSON.parse(line);
    if (!Array.isArray(v) || v.length !== 7 || !PID.test(v[0]) || !Number.isSafeInteger(v[5]) || v[5] < 0) throw new Error('Invalid archive row');
    if (bucketHash(v[0]) !== name) throw new Error('Invalid archive shard position');
    result.push({
      product_id: v[0], mall: v[1], vendor_item_id: v[2],
      recorded_at: normalizeAt(v[3]), recorded_date: v[4], price: v[5], source: v[6]
    });
    if (result.length > 15000) throw new Error('Archive shard exceeds safety limit');
  }
  return result;
}

/** 한 상품(·몰)의 아카이브 행. 묶음 하나를 통째로 읽고 인스턴스에서 2분 캐시한다. */
async function getHistory(pid, mall = '') {
  const key = keyOf(pid);
  const name = key.slice(KEY_PREFIX.length, KEY_PREFIX.length + 2);
  const hit = cache.get(name);
  let rows;
  if (hit && hit.expires > Date.now()) {
    rows = hit.rows;
  } else {
    rows = await readShard(name);
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(name, { rows, expires: Date.now() + CACHE_MS });
  }
  const product = String(pid);
  return rows.filter(r => r.product_id === product && (!mall || r.mall === mall));
}

/** DB 행과 아카이브 행을 합친다. 같은 (상품·몰·옵션·시각·가격) 관측은 한 번만 남긴다. */
function mergeHistory(online = [], archived = [], context = {}) {
  const values = new Map();
  for (const r of [...online, ...archived]) {
    if (!r) continue;
    const pid = r.product_id || context.productId;
    const mall = r.mall || context.mall || '';
    if (!pid) continue;
    const ms = r.recorded_at instanceof Date ? r.recorded_at.getTime() : (r.recorded_at ? Date.parse(r.recorded_at) : NaN);
    const at = Number.isFinite(ms) ? new Date(ms).toISOString() : String(r.recorded_at || r.recorded_date || '');
    const k = [pid, mall, r.vendor_item_id || '', at, r.price].join('\u001f');
    if (!values.has(k)) values.set(k, r);
  }
  return [...values.values()];
}

/**
 * 그래프용 기록 = DB(신규) + 아카이브(과거).
 *
 * @param {string} productId
 * @param {string} mall
 * @param {(sinceIso: string|null) => Promise<{data:any[], error:any}>} queryOnline
 *        sinceIso 가 있으면 recorded_at > sinceIso 인 행만 읽는 DB 질의를 돌려준다.
 * @returns {Promise<{data:any[]|null, error:any, archive:'disabled'|'merged'|'db-only'}>}
 */
async function withArchive(productId, mall, queryOnline) {
  if (!archiveEnabled()) return { ...(await queryOnline(null)), archive: 'disabled' };
  const cutoff = archiveCutoff();
  const [archived, online] = await Promise.all([
    getHistory(productId, mall).then(rows => ({ rows }), error => ({ error })),
    queryOnline(cutoff)
  ]);
  if (archived.error) {
    console.warn('[r2history] 아카이브 읽기 실패 — DB 만으로 그립니다:', archived.error.message);
    const full = cutoff ? await queryOnline(null) : online;
    return { ...full, archive: 'db-only' };
  }
  if (online.error) return { ...online, archive: 'merged' };
  return { data: mergeHistory(online.data || [], archived.rows, { productId, mall }), error: null, archive: 'merged' };
}

function _resetForTests() {
  cache.clear();
  s3 = null;
}

module.exports = { getHistory, keyOf, bucketHash, mergeHistory, withArchive, archiveEnabled, archiveCutoff, normalizeAt, _resetForTests };
