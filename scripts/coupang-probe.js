#!/usr/bin/env node
/*
 * 쿠팡 API 차단 원인 진단 전용 스크립트.
 *
 * ── 왜 api/_coupang.js 를 안 거치는가 ──────────────────────────────
 * 평소 규칙은 "쿠팡 호출은 반드시 searchCoupang() 로"다. 그 규칙을 여기서만
 * 어긴다. 요청 헤더를 바꿔가며 무엇이 차단을 유발하는지 좁히는 게 목적이라
 * 헤더를 고정하는 공용 통로로는 할 수 없는 일이기 때문이다.
 *
 * 대신 스스로를 강하게 제한한다.
 *   - 한 번 실행에 최대 MAX_CALLS 회
 *   - 호출 간 GAP_MS 대기
 *   - 서킷 브레이커를 건드리지 않는다 (전역 차단 상태를 오염시키지 않기 위해)
 *
 * 사용법:  node scripts/coupang-probe.js [검색어]
 */
'use strict';

require('./_env');
const crypto = require('crypto');

const HOST = 'https://api-gateway.coupang.com';
const PATH = '/v2/providers/affiliate_open_api/apis/openapi/products/search';

const MAX_CALLS = 4;
const GAP_MS = 2500;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function sign(method, path, query) {
  const d = new Date();
  const ts = d.getUTCFullYear().toString().slice(-2)
    + String(d.getUTCMonth() + 1).padStart(2, '0')
    + String(d.getUTCDate()).padStart(2, '0')
    + 'T'
    + String(d.getUTCHours()).padStart(2, '0')
    + String(d.getUTCMinutes()).padStart(2, '0')
    + String(d.getUTCSeconds()).padStart(2, '0')
    + 'Z';
  const sig = crypto.createHmac('sha256', process.env.COUPANG_SECRET_KEY)
    .update(ts + method + path + query).digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${process.env.COUPANG_ACCESS_KEY}, `
    + `signed-date=${ts}, signature=${sig}`;
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** 시험해볼 헤더 조합. 위에서부터 하나씩. */
const VARIANTS = [
  { name: '기본(Node 그대로)', headers: {} },
  { name: 'User-Agent 지정',   headers: { 'User-Agent': BROWSER_UA } },
  { name: 'UA + Accept json',  headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } },
  { name: 'UA + Accept + 언어', headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json', 'Accept-Language': 'ko-KR,ko;q=0.9' } }
];

async function probe(keyword, variant) {
  const query = `keyword=${encodeURIComponent(keyword)}&limit=5`;
  const started = Date.now();
  let r, text;
  try {
    r = await fetch(`${HOST}${PATH}?${query}`, {
      headers: Object.assign({ Authorization: sign('GET', PATH, query) }, variant.headers)
    });
    text = await r.text();
  } catch (e) {
    return { ok: false, note: `네트워크 오류: ${e.message}`, ms: Date.now() - started };
  }

  const ms = Date.now() - started;
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* HTML 응답 */ }

  if (!data) {
    const peek = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
    return { ok: false, note: `HTTP ${r.status} · JSON 아님 (${text.length}B): ${peek}`, ms };
  }
  const n = ((data.data && data.data.productData) || []).length;
  return {
    ok: String(data.rCode) === '0' || data.rCode === undefined,
    note: `HTTP ${r.status} · rCode=${data.rCode} · 상품 ${n}건`
      + (n ? ` · 첫 상품: ${String(data.data.productData[0].productName).slice(0, 40)}` : ''),
    ms
  };
}

(async () => {
  const keyword = process.argv[2] || '무선 이어폰';

  if (!process.env.COUPANG_ACCESS_KEY || !process.env.COUPANG_SECRET_KEY) {
    console.error('COUPANG_ACCESS_KEY / COUPANG_SECRET_KEY 가 없습니다.');
    process.exit(1);
  }

  console.log(`쿠팡 응답 진단 — 검색어 "${keyword}"`);
  console.log(`최대 ${MAX_CALLS}회, ${GAP_MS}ms 간격. 서킷 브레이커는 건드리지 않습니다.\n`);

  const variants = VARIANTS.slice(0, MAX_CALLS);
  for (let i = 0; i < variants.length; i++) {
    if (i > 0) await sleep(GAP_MS);
    const v = variants[i];
    const r = await probe(keyword, v);
    console.log(`${r.ok ? '성공' : '실패'}  ${v.name.padEnd(18)} ${String(r.ms).padStart(5)}ms  ${r.note}`);
    // 성공한 조합을 찾으면 더 호출하지 않는다 (쿼터 낭비 방지).
    if (r.ok) {
      console.log(`\n→ "${v.name}" 조합에서 정상 응답. api/_coupang.js 의 요청 헤더를 여기에 맞추세요.`);
      return;
    }
  }
  console.log('\n→ 모든 조합이 실패했습니다. 헤더 문제가 아니라 IP 또는 계정 차단일 가능성이 큽니다.');
  console.log('   쿠팡 파트너스(https://partners.coupang.com) 에서 이용 상태를 확인하세요.');
})();
