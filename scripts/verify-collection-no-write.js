#!/usr/bin/env node
/*
 * 몰별 수집 테스트가 운영 DB 에 픽스처를 남기지 않았는지 확인한다 (읽기 전용).
 *
 * ── 왜 별도 스크립트인가 ───────────────────────────────────────
 *
 * 이 확인은 운영 Supabase 를 실제로 읽어야만 뜻이 있다. 그런데 그 코드가
 * scripts/test-price-mall-collection.js 안에 있으면 `npm test` 체인에서
 * 운영 DB 로 네트워크 호출이 나간다 — test-release.js 의 SAFE 검사가
 * "체인 안에 운영 Supabase 를 그대로 쓰는 테스트가 없다" 를 지키지 못하고,
 * 실제로 2026-08-30 기준 그 검사가 FAIL 이었다.
 *
 * 검사 자체를 버리지는 않는다. 2026-08-29 에 픽스처가 운영 products 에
 * 실제로 들어간 사고가 있었고, 그것을 잡아낸 것이 이 조회다. 체인 밖으로
 * 옮겨서, 필요할 때 손으로 돌린다.
 *
 *   node scripts/verify-collection-no-write.js
 *
 * 픽스처 product_id 는 전부 "<mall>-p<n>" 꼴이라 like 로 한 번에 잡힌다.
 * 운영 데이터의 product_id 는 쿠팡=숫자, ADPICK=sha256 hex 라 절대 겹치지 않는다.
 */
'use strict';

require('./_env.js');

const supabase = require('../api/_supabase');

const LIKE = 'product_id.like.ADPICK-p%,product_id.like.쿠팡-p%';

(async () => {
  const [{ data: prods, error: e1 }, { data: hist, error: e2 }] = await Promise.all([
    supabase.from('products').select('product_id').or(LIKE),
    supabase.from('price_history').select('product_id').or(LIKE)
  ]);

  if (e1 || e2) {
    console.error('조회 실패:', (e1 || e2).message);
    process.exit(1);
  }

  const p = (prods || []).length;
  const h = (hist || []).length;
  console.log(`products 픽스처 행: ${p}`);
  console.log(`price_history 픽스처 행: ${h}`);

  if (p + h === 0) {
    console.log('\n[PASS] 운영 DB 에 테스트 픽스처가 없다.');
    process.exit(0);
  }
  console.log('\n[FAIL] 운영 DB 에 테스트 픽스처가 남아 있다. 아래 id 를 지워야 한다.');
  (prods || []).forEach(r => console.log('  products      ', r.product_id));
  (hist || []).forEach(r => console.log('  price_history ', r.product_id));
  process.exit(1);
})().catch(e => { console.error(e.message); process.exit(1); });
