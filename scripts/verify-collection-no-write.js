#!/usr/bin/env node
/*
 * 운영 DB 에 테스트 픽스처가 남아 있지 않은지 확인한다 (읽기 전용).
 *
 * ── 왜 별도 스크립트인가 ───────────────────────────────────────
 *
 * 이 확인은 운영 Supabase 를 실제로 읽어야만 뜻이 있다. 그런데 그 코드가
 * scripts/test-price-mall-collection.js 안에 있으면 `npm test` 체인에서
 * 운영 DB 로 네트워크 호출이 나간다 — test-release.js 의 SAFE 검사가
 * "체인 안에 운영 Supabase 를 그대로 쓰는 테스트가 없다" 를 지키지 못한다.
 *
 * 검사 자체를 버리지는 않는다. 필요할 때 손으로 돌린다.
 *
 *   npm run verify:no-write
 *
 * ── 판정 방법 (2026-09-03 확장) ────────────────────────────────
 *
 * 예전에는 "<mall>-p<n>" 꼴만 like 로 잡았다. 그런데 테스트가 쓰는 픽스처 id 는
 * 그것만이 아니다 — 실제로 P1·P2·P3·X1 이 운영에 들어간 사고가 있었고
 * (2026-09-03, runMallCollection 이 기본값으로 진짜 recordPrices 를 불렀다)
 * 그 패턴은 like 에 걸리지 않았다.
 *
 * 그래서 이제는 **운영 id 의 모양을 정의하고, 거기서 벗어난 것을 잡는다.**
 *   쿠팡    숫자만          (실측 5~14자리)
 *   ADPICK  sha256 hex 64자 (api/_shop.js adpickProductId)
 *
 * 벗어난 것은 다시 두 갈래로 나눈다.
 *   legacy   공백이나 한글이 들어간 id = 옛날 `it.productId || it.title` 폴백이
 *            상품명을 그대로 기본키에 넣던 시절의 잔재다(api/_shop.js 주석 참고).
 *            지금 코드는 그런 행을 만들지 않는다 — 세어서 보여만 주고 실패로 치지 않는다.
 *   fixture  공백도 한글도 없는 짧은 토큰 = 테스트 픽스처 모양이다(P1, X1, 쿠팡-p1 …).
 *            이건 방금 누가 운영에 쓴 것이므로 반드시 0 이어야 한다.
 *
 * 전체 스캔이라 페이지네이션으로 읽는다.
 */
'use strict';

require('./_env.js');

const supabase = require('../api/_supabase');

const PAGE = 1000;

/** 운영 product_id 의 모양. */
const COUPANG_ID = /^[0-9]+$/;
const ADPICK_ID = /^[0-9a-f]{64}$/;
/** 공백 또는 한글이 있으면 "상품명이 id 에 들어간" 옛 행이다. */
const HAS_TEXT = /[\sㄱ-힝]/;

function looksReal(id) {
  const s = String(id == null ? '' : id);
  return COUPANG_ID.test(s) || ADPICK_ID.test(s);
}

async function scan(table) {
  const bad = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table).select('product_id, mall').range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    (data || []).forEach(r => { if (!looksReal(r.product_id)) bad.push(r); });
    if (!data || data.length < PAGE) return bad;
  }
}

(async () => {
  const [prods, hist] = await Promise.all([scan('products'), scan('price_history')]);

  const split = (rows) => ({
    legacy: rows.filter(r => HAS_TEXT.test(String(r.product_id))),
    fixture: rows.filter(r => !HAS_TEXT.test(String(r.product_id)))
  });
  const P = split(prods), H = split(hist);

  console.log(`products      — 픽스처 의심 ${P.fixture.length} / 옛 제목형 ${P.legacy.length}`);
  console.log(`price_history — 픽스처 의심 ${H.fixture.length} / 옛 제목형 ${H.legacy.length}`);

  const legacyTotal = P.legacy.length + H.legacy.length;
  if (legacyTotal > 0) {
    console.log('');
    console.log(`[참고] product_id 에 상품명이 들어간 옛 행이 ${legacyTotal}건 있다.`);
    console.log('       지금 코드는 그런 행을 만들지 않는다(식별자가 없으면 아예 저장하지 않는다).');
    console.log('       과거 데이터라 이 검사에서는 실패로 치지 않는다.');
  }

  if (P.fixture.length + H.fixture.length === 0) {
    console.log('');
    console.log('[PASS] 운영 DB 에 테스트 픽스처가 없다.');
    process.exit(0);
  }

  console.log('');
  console.log('[FAIL] 테스트 픽스처 모양의 행이 운영에 있다. 지워야 한다.');
  const show = (label, rows) => {
    [...new Set(rows.map(r => `${r.mall}/${r.product_id}`))]
      .slice(0, 40).forEach(v => console.log(`  ${label} ${v}`));
  };
  show('products     ', P.fixture);
  show('price_history', H.fixture);
  process.exit(1);
})().catch(e => { console.error(e.message); process.exit(1); });
