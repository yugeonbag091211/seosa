#!/usr/bin/env node
/*
 * Google Sheets(가격 히스토리) -> Supabase price_history 이관 스크립트
 *
 *   node scripts/import-history.js <CSV경로 | 시트URL>            # 미리보기 (기본)
 *   node scripts/import-history.js <CSV경로 | 시트URL> --commit   # 실제 저장
 *   node scripts/import-history.js <...> --map "상품명=title,가격=price"
 *
 * 기본은 dry-run이라 --commit 없이는 아무것도 쓰지 않는다.
 * 시트 URL은 "링크가 있는 모든 사용자에게 보기 허용" 상태여야 읽을 수 있다.
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const supabase = require(path.join(__dirname, '..', 'api', '_supabase.js'));

const CHUNK = 500;

/* ---------- CSV 파싱 (따옴표 안의 쉼표/줄바꿈까지 처리) ---------- */
function parseCSV(text) {
  text = text.replace(/^﻿/, '');           // BOM 제거
  const rows = [];
  let row = [], field = '', inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }   // 이스케이프된 따옴표
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* 무시 */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

/* ---------- 컬럼 자동 감지 ---------- */
const ALIASES = {
  product_id: ['product_id', 'productid', '상품id', '상품아이디', '상품코드', 'id'],
  title:      ['title', '상품명', '제품명', '이름', 'name'],
  price:      ['price', 'lprice', '가격', '최저가', '현재가', '금액'],
  mall:       ['mall', '쇼핑몰', '판매처', '몰', 'mallname'],
  link:       ['link', 'url', '링크', '주소'],
  date:       ['recorded_date', 'recorded_at', 'date', '날짜', '수집일', '기록일', '일자', '수집일시']
};

function norm(s) { return String(s).toLowerCase().replace(/[\s_\-()]/g, ''); }

function detectMapping(headers, manual) {
  const map = {};
  headers.forEach((h, i) => {
    const nh = norm(h);
    for (const [field, aliases] of Object.entries(ALIASES)) {
      if (map[field] !== undefined) continue;
      if (aliases.some(a => norm(a) === nh)) { map[field] = i; return; }
    }
  });
  // 정확히 안 맞으면 부분 일치로 한 번 더
  headers.forEach((h, i) => {
    const nh = norm(h);
    for (const [field, aliases] of Object.entries(ALIASES)) {
      if (map[field] !== undefined) continue;
      if (aliases.some(a => nh.includes(norm(a)))) map[field] = i;
    }
  });
  // --map 으로 준 값이 최우선
  for (const [colName, field] of Object.entries(manual)) {
    const i = headers.findIndex(h => norm(h) === norm(colName));
    if (i >= 0) map[field] = i;
    else console.warn(`  경고: --map 의 "${colName}" 컬럼을 헤더에서 찾지 못함`);
  }
  return map;
}

/* ---------- 값 정규화 ---------- */
function toPrice(v) {
  const n = parseInt(String(v == null ? '' : v).replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function toDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  let m = s.match(/(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/);   // 2026-07-26 / 2026. 7. 26 / 2026년 7월 26일
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  return null;
}

/* ---------- 입력 읽기 ---------- */
async function readInput(src) {
  if (/^https?:\/\//.test(src)) {
    const idm = src.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!idm) throw new Error('시트 URL에서 문서 ID를 찾지 못했습니다.');
    const gidm = src.match(/[#&?]gid=(\d+)/);
    const url = `https://docs.google.com/spreadsheets/d/${idm[1]}/export?format=csv`
      + (gidm ? `&gid=${gidm[1]}` : '');
    console.log('시트 CSV 요청:', url);
    const r = await fetch(url, { redirect: 'follow' });
    const body = await r.text();
    if (!r.ok || body.trimStart().startsWith('<')) {
      throw new Error(
        `시트를 읽지 못했습니다 (HTTP ${r.status}). 비공개 시트입니다.\n` +
        '  해결: 시트 > 공유 > "링크가 있는 모든 사용자" = 뷰어 로 바꾼 뒤 재시도하거나,\n' +
        '        파일 > 다운로드 > CSV 로 받아서 그 경로를 인자로 넘기세요.'
      );
    }
    return body;
  }
  if (!fs.existsSync(src)) throw new Error(`파일을 찾을 수 없습니다: ${src}`);
  return fs.readFileSync(src, 'utf8');
}

/* ---------- 메인 ---------- */
(async () => {
  const args = process.argv.slice(2);
  const src = args.find(a => !a.startsWith('--'));
  const commit = args.includes('--commit');
  const mapArg = (args.find(a => a.startsWith('--map=')) || '').replace('--map=', '')
    || (args[args.indexOf('--map') + 1] && !args[args.indexOf('--map') + 1].startsWith('--')
        ? args[args.indexOf('--map') + 1] : '');

  if (!src) {
    console.log('사용법: node scripts/import-history.js <CSV경로|시트URL> [--commit] [--map "헤더=필드,..."]');
    process.exit(1);
  }

  const manual = {};
  mapArg.split(',').filter(Boolean).forEach(pair => {
    const [col, field] = pair.split('=').map(s => s.trim());
    if (col && field) manual[col] = field;
  });

  const rows = parseCSV(await readInput(src));
  if (rows.length < 2) throw new Error('데이터 행이 없습니다.');

  const headers = rows[0].map(h => String(h).trim());
  const map = detectMapping(headers, manual);

  console.log('\n헤더:', headers.join(' | '));
  console.log('\n감지된 매핑:');
  ['title', 'price', 'date', 'product_id', 'mall', 'link'].forEach(f => {
    const i = map[f];
    console.log(`  ${f.padEnd(11)} <- ${i === undefined ? '(없음)' : `[${i}] ${headers[i]}`}`);
  });

  for (const req of ['title', 'price', 'date']) {
    if (map[req] === undefined) {
      throw new Error(`필수 컬럼 "${req}" 을(를) 찾지 못했습니다. --map "실제헤더=${req}" 로 지정하세요.`);
    }
  }

  const cell = (r, f) => (map[f] === undefined ? '' : (r[map[f]] == null ? '' : String(r[map[f]]).trim()));

  const out = [];
  const skipped = [];
  const seen = new Set();

  rows.slice(1).forEach((r, idx) => {
    const title = cell(r, 'title');
    const price = toPrice(cell(r, 'price'));
    const date = toDate(cell(r, 'date'));
    const lineNo = idx + 2;

    if (!title)  return skipped.push(`${lineNo}행: 상품명 없음`);
    if (!price)  return skipped.push(`${lineNo}행: 가격 없음/0 (${cell(r, 'price')})`);
    if (!date)   return skipped.push(`${lineNo}행: 날짜 해석 실패 (${cell(r, 'date')})`);

    const mall = cell(r, 'mall') || '기타';
    const productId = cell(r, 'product_id') || title;
    const key = `${productId}|${mall}|${date}`;
    if (seen.has(key)) return skipped.push(`${lineNo}행: 중복 (${key})`);
    seen.add(key);

    out.push({
      product_id: productId,
      mall,
      title,
      price,
      link: cell(r, 'link'),
      recorded_at: new Date(`${date}T00:00:00Z`).toISOString(),
      recorded_date: date
    });
  });

  const dates = out.map(o => o.recorded_date).sort();
  console.log(`\n원본 ${rows.length - 1}행 -> 이관 대상 ${out.length}행, 건너뜀 ${skipped.length}행`);
  if (out.length) console.log(`날짜 범위: ${dates[0]} ~ ${dates[dates.length - 1]}`);
  console.log('\n샘플 3건:');
  out.slice(0, 3).forEach(o => console.log('  ' + JSON.stringify(o)));
  if (skipped.length) {
    console.log(`\n건너뛴 행 (앞 10개):`);
    skipped.slice(0, 10).forEach(s => console.log('  ' + s));
  }

  if (!commit) {
    console.log('\n[미리보기] 아무것도 저장하지 않았습니다. 위 매핑이 맞으면 --commit 을 붙여 다시 실행하세요.');
    return;
  }

  console.log(`\n${out.length}행 저장 시작...`);
  let done = 0;
  for (let i = 0; i < out.length; i += CHUNK) {
    const chunk = out.slice(i, i + CHUNK);
    const { error } = await supabase
      .from('price_history')
      .upsert(chunk, { onConflict: 'product_id,mall,recorded_date' });
    if (error) throw new Error(`${i}~${i + chunk.length}행 저장 실패: ${error.message}`);
    done += chunk.length;
    console.log(`  ${done}/${out.length}`);
  }
  console.log('\n완료: ' + done + '행 저장');
})().catch(e => { console.error('\n오류: ' + e.message); process.exit(1); });
