'use strict';
/*
 * 하루 캐시 파일 — GitHub Actions cache 와 짝을 이룬다 (2026-10-22).
 *
 * ── 왜 ────────────────────────────────────────────────────────────────
 * Neon Free 공용망 전송 한도는 월 5GB 이고, 넘으면 compute 가 다음 주기까지 멈춘다(사이트·수집 전부).
 * 같은 날 안에서 «변하지 않는» 큰 읽기를 실행마다 반복하고 있었다(운영 실측 2026-10-21):
 *   · 가격 수집기 — 오늘 대상 14,548개의 키·상품 행 ≈5.9MB, 하루 작업 실행 ≈13회
 *   · 핫딜 작업   — 대상 상품의 120일 기록 109,512행 13.3MB 중 «어제까지» 부분, 하루 3회
 * 그날 처음 읽은 실행이 파일로 남기고, 워크플로가 그 파일을 KST 날짜 키로 Actions cache 에 올린다.
 * 같은 날 다음 실행은 캐시에서 받아 DB 를 읽지 않는다. Actions cache 는 Neon 전송량에 들지 않는다.
 *
 * ── 안전 ──────────────────────────────────────────────────────────────
 * · 파일 안에 kind 와 key(날짜·서명·열 목록)를 같이 적고, 읽을 때 «정확히 같을 때만» 쓴다.
 *   다르거나 깨졌거나 없으면 hit=false → 호출부는 예전처럼 DB 에서 읽는다(동작 동일).
 * · 비밀값·개인정보를 담지 않는다(상품 ID·제목·링크·가격 기록 — 사이트에 공개된 값).
 * · 쓰기는 임시 파일 → rename 으로 원자적이다. 실패해도 던지지 않는다(수집을 막지 않는다).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FORMAT = 1;

/**
 * @returns {{hit:true, payload:any, createdAt:string, bytes:number} | {hit:false, reason:string}}
 */
function readDayCache(file, kind, key) {
  if (!file) return { hit: false, reason: 'off' };
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return { hit: false, reason: e && e.code === 'ENOENT' ? 'none' : 'read_error' };
  }
  let obj;
  try {
    obj = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
  } catch (e) {
    return { hit: false, reason: 'corrupt' };
  }
  if (!obj || obj.format !== FORMAT || obj.kind !== kind) return { hit: false, reason: 'format' };
  if (obj.key !== key) return { hit: false, reason: 'key' };
  return { hit: true, payload: obj.payload, createdAt: String(obj.createdAt || ''), bytes: buf.length };
}

/** @returns {{ok:true, bytes:number} | {ok:false, reason:string}} */
function writeDayCache(file, kind, key, payload) {
  if (!file) return { ok: false, reason: 'off' };
  try {
    const body = zlib.gzipSync(Buffer.from(JSON.stringify({
      format: FORMAT, kind, key, createdAt: new Date().toISOString(), payload
    }), 'utf8'));
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
    return { ok: true, bytes: body.length };
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e).slice(0, 120) };
  }
}

module.exports = { readDayCache, writeDayCache, FORMAT };
