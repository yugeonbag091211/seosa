#!/usr/bin/env node
/*
 * products.lprice / collected_at 을 price_history 의 실제 관측으로 되돌린다.
 *
 *   node scripts/backfill-current-prices.js            ← 미리보기 (아무것도 쓰지 않음)
 *   node scripts/backfill-current-prices.js --apply    ← 실제 반영
 *
 * ── 왜 필요한가 ────────────────────────────────────────────────────
 * 2026-08-09 이전의 scripts/collect-all-prices.js 는 price_history 에만 썼고
 * products 를 갱신하지 않았다. 그래서 매일 가격을 제대로 받아오고 있었는데도
 * 사용자에게 보이는 현재가(products.lprice)는 누군가 마지막으로 그 키워드를
 * 검색한 시점에 얼어붙어 있었다.
 *
 * 실측 (2026-08-09 운영 DB)
 *   products.lprice 가 같은 날 받아온 쿠팡 가격과 다른 행 39/200 (19.5%)
 *   예) "1+1 HOMEY NEST 암막커튼"  products=75,000 / 같은 날 쿠팡=39,900
 *
 * 코드는 고쳤지만 이미 저장된 행은 다음 수집이 그 상품을 다시 훑을 때까지
 * 틀린 값을 유지한다. 관측 기록은 price_history 에 이미 다 있으므로
 * 그걸로 현재가를 복구한다.
 *
 * ── 무엇을 하지 않는가 ─────────────────────────────────────────────
 *   - 행을 지우지 않는다. price_history 를 건드리지 않는다.
 *   - products 의 title / keyword / link / image 를 바꾸지 않는다.
 *   - 가격이 이미 맞는 행은 건드리지 않는다.
 *   → 바꾸는 컬럼은 lprice / oprice / save_pct / collected_at 뿐이다.
 *
 * ── 실행 순서 (중요) ───────────────────────────────────────────────
 * 이 스크립트보다 **수집을 한 번 돌리는 쪽이 먼저**다.
 *
 * price_history 에 이미 들어 있는 값 중 일부는 옵션 접기(collapseOptions)를
 * 넣기 전에 기록된 것이라, 같은 상품의 여러 옵션 중 임의의 하나일 수 있다.
 * 그걸 현재가로 승격시키면 오래된 값 대신 엉뚱한 옵션 값이 들어간다.
 *
 *   1) supabase/2026-08-price-accuracy.sql 적용
 *   2) node scripts/collect-all-prices.js   ← 이것만으로 대부분 정확해진다
 *   3) 그래도 남는 행이 있으면 이 스크립트
 *
 * 3번이 필요한 경우: 키워드 검색 상위 10위 밖으로 밀려나 수집이 닿지 못하는
 * 상품. 그런 행은 관측 기록만 있고 현재가가 갱신되지 않는다.
 *
 * ── 이상값을 그대로 옮기지 않는다 ───────────────────────────────────
 * price_history 에는 오염된 관측도 들어 있다 (같은 product_id 에 옵션이 섞여
 * 34,500 → 1,528,000 으로 튄 사례 등). 가장 최근 값을 무턱대고 가져오면
 * 그 오염을 현재가로 승격시키게 된다. 그래서 관측을 오래된 순으로 다시
 * 재생하면서 api/_price.js 의 classifyPrice() 를 그대로 통과시킨다.
 * 확인되지 않은 급변은 건너뛰고, 마지막으로 인정된 값을 현재가로 삼는다.
 */
'use strict';

require('./_env');
const supabase = require('../api/_supabase');
const { classifyPrice, isRefreshableMall } = require('../api/_price');
const { discountPct } = require('../api/_shop');

const APPLY = process.argv.indexOf('--apply') > -1;
const PAGE = 1000;
const UPDATE_CHUNK = 200;

/** 이보다 오래된 관측만 남아 있으면 현재가로 쓰지 않는다. */
const MAX_OBSERVATION_AGE_DAYS = Number(process.env.PRICE_MAX_DISPLAY_AGE_DAYS) || 10;

async function fetchAll(table, columns, order) {
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table).select(columns).order(order, { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} 조회 실패: ${error.message}`);
    all.push(...(data || []));
    if (!data || data.length < PAGE) return all;
  }
}

/**
 * 한 상품의 관측 이력을 오래된 순으로 재생해서 "지금 믿을 수 있는 가격"을 낸다.
 * @returns {{price:number, date:string, skipped:number}|null}
 */
function replay(observations) {
  const sorted = observations.slice().sort((a, b) => String(a.recorded_date).localeCompare(String(b.recorded_date)));
  let accepted = null;
  let acceptedDate = '';
  let skipped = 0;

  for (const o of sorted) {
    const prev = accepted === null ? null : {
      price: accepted,
      observedAt: acceptedDate,
      vendorItemId: ''   // 옛 기록에는 옵션 식별자가 없다. 급변 판정만 적용한다.
    };
    const verdict = classifyPrice(o.price, prev, {});
    if (verdict.status === 'ok') {
      accepted = verdict.price;
      acceptedDate = o.recorded_date;
      continue;
    }
    if (verdict.status === 'suspect') {
      /*
       * 급변이다. 바로 다음 관측이 같은 수준이면 실제로 값이 바뀐 것으로 본다
       * (api/_shop.js 의 확인 규칙과 같다). 다음 관측이 원래 수준으로
       * 돌아오면 이 값은 그냥 튄 것이라 버린다.
       */
      const i = sorted.indexOf(o);
      const next = sorted[i + 1];
      const corroborated = next && Math.abs(next.price - verdict.price) / verdict.price <= 0.2;
      if (corroborated) {
        accepted = verdict.price;
        acceptedDate = o.recorded_date;
      } else {
        skipped++;
      }
      continue;
    }
    skipped++;
  }

  return accepted === null ? null : { price: accepted, date: acceptedDate, skipped };
}

function ageDaysOf(dateStr) {
  const t = Date.parse(`${dateStr}T00:00:00Z`);
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 86400000;
}

(async () => {
  console.log(APPLY
    ? '모드: 실제 반영 (--apply)\n'
    : '모드: 미리보기 — 아무것도 쓰지 않습니다. 반영하려면 --apply 를 붙이세요.\n');

  const products = await fetchAll('products', 'product_id, mall, title, lprice, oprice, collected_at', 'product_id');
  const history = await fetchAll('price_history', 'product_id, mall, price, recorded_date', 'product_id');
  console.log(`products ${products.length}행 / price_history ${history.length}행 읽음\n`);

  const byKey = new Map();
  history.forEach(h => {
    const k = `${h.product_id}|${h.mall}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(h);
  });

  const updates = [];
  const stats = { noHistory: 0, tooOld: 0, alreadyCorrect: 0, deadMall: 0, skippedOutlier: 0 };

  for (const p of products) {
    const obs = byKey.get(`${p.product_id}|${p.mall}`);
    if (!obs || !obs.length) { stats.noHistory++; continue; }

    const r = replay(obs);
    if (!r) { stats.noHistory++; continue; }
    if (r.skipped) stats.skippedOutlier += r.skipped;

    if (ageDaysOf(r.date) > MAX_OBSERVATION_AGE_DAYS) {
      // 관측이 너무 오래됐다. 그 값을 현재가로 올려 봐야 여전히 틀린 값이고,
      // collected_at 만 새로 찍으면 오히려 신선한 척하게 된다.
      stats.tooOld++;
      if (!isRefreshableMall(p.mall)) stats.deadMall++;
      continue;
    }

    const curCollected = String(p.collected_at || '').slice(0, 10);
    if (Number(p.lprice) === r.price && curCollected === r.date) { stats.alreadyCorrect++; continue; }

    const oprice = Number(p.oprice) > r.price ? Number(p.oprice) : r.price;
    updates.push({
      product_id: p.product_id,
      mall: p.mall,
      title: p.title,
      was: Number(p.lprice),
      now: r.price,
      observedOn: r.date,
      row: {
        product_id: p.product_id,
        mall: p.mall,
        lprice: r.price,
        oprice,
        save_pct: discountPct(r.price, oprice),
        // 이 가격을 실제로 관측한 날. 프론트의 "M/D 수집 기준" 표기가 사실이 된다.
        collected_at: new Date(`${r.date}T00:00:00Z`).toISOString()
      }
    });
  }

  const changedPrice = updates.filter(u => u.was !== u.now);
  console.log('── 대상 ──');
  console.log(`  갱신할 행            ${updates.length}`);
  console.log(`   ├ 가격이 바뀌는 행  ${changedPrice.length}`);
  console.log(`   └ 수집일만 바뀌는 행 ${updates.length - changedPrice.length}`);
  console.log(`  이미 정확            ${stats.alreadyCorrect}`);
  console.log(`  관측 기록 없음        ${stats.noHistory}`);
  console.log(`  관측이 ${MAX_OBSERVATION_AGE_DAYS}일보다 오래됨  ${stats.tooOld}  (그중 수집 중단된 몰 ${stats.deadMall})`);
  console.log(`  이상값으로 건너뛴 관측 ${stats.skippedOutlier}건\n`);

  if (changedPrice.length) {
    console.log('── 가격이 바뀌는 행 (차이 큰 순 상위 25) ──');
    changedPrice
      .slice()
      .sort((a, b) => Math.abs(b.now / (b.was || 1) - 1) - Math.abs(a.now / (a.was || 1) - 1))
      .slice(0, 25)
      .forEach(u => console.log(
        `  ${String(u.was).padStart(9)} → ${String(u.now).padStart(9)}`
        + `  (x${(u.now / (u.was || 1)).toFixed(2)}, ${u.observedOn})  [${u.mall}] ${String(u.title).slice(0, 45)}`
      ));
    console.log('');
  }

  if (!APPLY) {
    console.log('미리보기로 끝났습니다. 위 내용이 맞으면 --apply 를 붙여 다시 실행하세요.');
    return;
  }
  if (!updates.length) {
    console.log('바꿀 행이 없습니다.');
    return;
  }

  let saved = 0;
  const errors = [];
  for (let i = 0; i < updates.length; i += UPDATE_CHUNK) {
    const chunk = updates.slice(i, i + UPDATE_CHUNK).map(u => u.row);
    const { error } = await supabase.from('products').upsert(chunk, { onConflict: 'product_id,mall' });
    if (error) errors.push(error.message);
    else saved += chunk.length;
  }

  console.log(`\nproducts 갱신 완료: ${saved}/${updates.length}행`);
  if (errors.length) {
    console.error('오류:', [...new Set(errors)].slice(0, 3).join(' | '));
    process.exitCode = 1;
  }
})().catch(e => {
  console.error('치명적 오류:', e.message);
  process.exit(1);
});
