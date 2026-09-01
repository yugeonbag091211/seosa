#!/usr/bin/env node
/*
 * 운영 DB 무결성 감사 — 읽기 전용. 아무것도 쓰지 않는다.
 *
 *   node scripts/audit-integrity.js          사람이 읽는 표
 *   node scripts/audit-integrity.js --json   기계가 읽는 JSON
 *
 * ── 왜 필요한가 ────────────────────────────────────────────────
 * 단위 테스트는 "코드가 규칙을 지키는가" 만 본다. 운영 데이터가 실제로
 * 온전한지는 별개 문제다. 2026-08-27 감사에서 실제로 그 간극이 드러났다 —
 * 테스트는 전부 통과하는데 products 278행이 대응하는 price_history 행 없이
 * 남아 있었다(그중 81행은 현행 저장 경로가 만든 것). 그 상태는 어떤 테스트도
 * 잡지 못했다. 화면에는 현재가로 찍히는데 그 값을 받치는 관측 기록이 없다.
 *
 * 그래서 "데이터 쪽" 검사를 코드로 고정해 둔다. 배포 전이나 이상이 의심될 때
 * 돌리면 된다. 실패해도 서비스에 영향이 없다(읽기만 한다).
 *
 * ── 판정 기준 ──────────────────────────────────────────────────
 *   FAIL  지금 사용자에게 잘못된 것을 보여주고 있거나, 곧 그렇게 된다
 *   WARN  구조적으로 알려진 한계이거나 레거시 잔재 — 추적은 하되 막지는 않는다
 *   OK    정상
 *
 * 각 검사에는 "왜 이게 문제인가" 를 한 줄로 붙인다. 숫자만 있으면 몇 달 뒤에
 * 그 숫자가 나빠져도 아무도 알아채지 못한다.
 */
'use strict';

require('./_env');

const supabase = require('../api/_supabase');
const {
  observedKstDate, kstToday, isRefreshableMall, productLifecycle, vendorIdOf
} = require('../api/_price');
const { adpickProductId } = require('../api/_shop');

const JSON_OUT = process.argv.includes('--json');

/*
 * 레거시 경계.
 *
 * scripts/backfill-current-prices.js 는 products 만 쓰는 일회성 도구라
 * 그 시절 행은 원장이 없는 게 정상이다. 현행 저장 경로(api/_shop.recordPrices)가
 * 두 테이블을 함께 쓰기 시작한 시점 이후만 결함으로 센다.
 */
const LIVE_WRITE_SINCE = '2026-08-08';

async function fetchAll(table, cols) {
  const out = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await supabase.from(table).select(cols).range(from, from + size - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < size) return out;
  }
}

const results = [];
function record(level, name, count, why, samples) {
  results.push({ level, name, count, why, samples: samples || [] });
}
const ok   = (n, c, w, s) => record('OK', n, c, w, s);
const warn = (n, c, w, s) => record('WARN', n, c, w, s);
const bad  = (n, c, w, s) => record('FAIL', n, c, w, s);
/** 0이면 OK, 아니면 FAIL. */
const zero = (n, c, w, s) => (c === 0 ? ok : bad)(n, c, w, s);

function group(arr, keyOf) {
  const m = new Map();
  arr.forEach(x => {
    const k = keyOf(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  });
  return m;
}

(async () => {
  const P = await fetchAll('products',
    'id,product_id,mall,mall_label,keyword,title,link,image,lprice,oprice,vendor_item_id,item_id,collected_at');
  const H = await fetchAll('price_history',
    'id,product_id,mall,title,price,link,vendor_item_id,item_id,recorded_date,recorded_at');

  const today = kstToday();
  const pKey = r => `${r.product_id}|${r.mall}`;
  /** 옵션까지 포함한 이력 계열 키. 쿠팡은 vid 로 갈리고 ADPICK 은 vid 가 ''. */
  const sKey = r => `${r.product_id}|${r.mall}|${r.vendor_item_id || ''}`;

  const histByPidMall = group(H, pKey);
  const productKeys = new Set(P.map(pKey));

  /* ── 1. 식별자 ──────────────────────────────────────────────── */
  zero('products.product_id 빈값', P.filter(r => !r.product_id).length,
    '식별자가 없으면 이력이 어느 상품 것인지 영원히 알 수 없다');

  zero('products 중복 (product_id, mall)',
    [...group(P, pKey)].filter(([, v]) => v.length > 1).length,
    'UNIQUE(product_id, mall) 가 살아 있으면 0이다. 0이 아니면 제약이 빠진 것');

  zero('동일 product_id 가 서로 다른 mall 로 저장됨',
    [...group(P, r => r.product_id)].filter(([, v]) => new Set(v.map(x => x.mall)).size > 1).length,
    '같은 식별자가 두 몰에 걸치면 가격 이력 조회가 엉뚱한 몰로 나간다');

  {
    // ADPICK 은 product_id 가 commissionlink 의 sha256 이어야 한다.
    const ap = P.filter(r => r.mall === 'ADPICK');
    const mismatch = ap.filter(r => adpickProductId(r.link) !== r.product_id);
    zero('ADPICK product_id ≠ sha256(link)', mismatch.length,
      '링크에서 식별자를 다시 만들 수 없으면 재수집 때 같은 상품을 새 상품으로 저장한다',
      mismatch.slice(0, 5).map(r => `${String(r.product_id).slice(0, 12)}… ${r.link}`));

    zero('ADPICK 중복 link',
      [...group(ap, r => r.link)].filter(([, v]) => v.length > 1).length,
      '같은 제휴 링크가 두 상품 행에 붙으면 클릭이 어느 상품인지 모호해진다');
  }

  {
    /*
     * ★ 사용자가 실제로 클릭하는 것은 products.link 다.
     *
     *   price_history.link 가 아니다 — price_drop_top 은 p2.link(products)를 싣고,
     *   검색·시세판·찜·비교표 전부 products 계열에서 링크를 가져온다. 이력의 link 는
     *   vendorIdOf 폴백에만 쓰인다. 그래서 "상품 A 카드가 상품 B 로 간다" 를 판정하려면
     *   products 쪽을 봐야 한다.
     */
    const shared = [...group(P.filter(r => r.link), r => r.link)]
      .filter(([, v]) => new Set(v.map(x => x.product_id)).size > 1);
    zero('서로 다른 product_id 가 같은 products.link 공유', shared.length,
      '상품 A 카드에서 상품 B 로 가게 되는 유일한 사용자 노출 경로다',
      shared.slice(0, 5).map(([l, v]) => `${String(l).slice(0, 50)} → ${[...new Set(v.map(x => x.product_id))].slice(0, 3).join(', ')}`));

    /*
     * 이력 쪽 link 공유는 별도로 WARN 으로만 센다.
     *
     * 2026-08-27 실측: 21건 전부 vendor_item_id='__LEGACY__' 인 옛 행이고, link 가
     * 네이버 카탈로그 주소다. 네이버 카탈로그는 원래 여러 판매자 상품이 한 주소를
     * 공유하는 구조라 값 자체가 틀린 게 아니다. 사용자에게 노출되지 않으므로
     * 막지 않되, 새로 늘어나면 보이도록 숫자는 남긴다.
     */
    const liveH = H.filter(r => r.link && isRefreshableMall(r.mall) && productKeys.has(pKey(r)));
    const sharedH = [...group(liveH, r => r.link)]
      .filter(([, v]) => new Set(v.map(x => x.product_id)).size > 1);
    const legacyOnly = sharedH.filter(([, v]) => v.every(x => x.vendor_item_id === '__LEGACY__'));
    warn('price_history.link 를 여러 pid 가 공유', sharedH.length,
      `그중 ${legacyOnly.length}건은 __LEGACY__ 옛 행(네이버 카탈로그 주소). 사용자에게 노출되지 않는다`);
  }

  {
    /*
     * ★ 쿠팡 식별의 핵심 불변식.
     *
     * 제휴 링크에는 vendorItemId 가 쿼리로 박혀 있다. 저장된 vendor_item_id 가 그것과
     * 다르면, 카드에 찍히는 가격과 그 카드가 여는 판매 단위가 서로 다른 것이다 —
     * 옵션이 여러 개인 상품에서 정확히 그렇게 값이 어긋난다.
     *
     * (link.coupang.com/re/… 형태에는 productId 가 pageKey 로만 들어 있어
     *  coupangItemIds 가 productId 를 뽑지 않는다. 그래서 vid 쪽만 대조한다.)
     */
    const cp = P.filter(r => r.mall === '쿠팡' && r.vendor_item_id);
    const mismatch = cp.filter(r => {
      const linkVid = vendorIdOf({ link: r.link });
      return linkVid && String(linkVid) !== String(r.vendor_item_id);
    });
    zero('쿠팡 vendor_item_id ≠ link 의 vendorItemId', mismatch.length,
      '카드의 가격과 그 카드가 여는 판매 단위가 어긋난다 (옵션 상품에서 값이 틀리는 경로)',
      mismatch.slice(0, 5).map(r => `pid=${r.product_id} 컬럼=${r.vendor_item_id} link=${vendorIdOf({ link: r.link })}`));

    const nonCoupangLink = P.filter(r => r.mall === '쿠팡' && r.link && !/(^|\.)coupang\.com/i.test((() => {
      try { return new URL(r.link).hostname; } catch (e) { return ''; }
    })()));
    zero('mall=쿠팡 인데 products.link 가 쿠팡이 아님', nonCoupangLink.length,
      '구매 버튼이 다른 쇼핑몰로 나간다',
      nonCoupangLink.slice(0, 5).map(r => `pid=${r.product_id} ${String(r.link).slice(0, 50)}`));
  }

  /* ── 2. products ↔ price_history ────────────────────────────── */
  {
    /*
     * ★ 이번 감사의 핵심 검사.
     *
     * recordPrices 는 두 테이블에 같은 시각을 쓴다. 그러니 products.collected_at
     * 과 똑같은 시각의 price_history 행이 없다면, 그 배치에서 원장 쓰기가
     * 실패했는데 카탈로그만 쓰인 것이다. 그 행은 화면에 현재가로 찍히면서
     * 근거가 없고, 다음 수집의 classifyPrice 가 비교할 prev 도 못 찾는다.
     */
    const unbacked = P.filter(r =>
      !(histByPidMall.get(pKey(r)) || []).some(h => h.recorded_at === r.collected_at));
    const live = unbacked.filter(r => String(r.collected_at) >= LIVE_WRITE_SINCE);
    const legacy = unbacked.length - live.length;

    zero('원장 없는 카탈로그 갱신 (현행 저장 경로)', live.length,
      'products 만 쓰이고 price_history 가 빠진 행. 근거 없는 현재가가 화면에 뜬다',
      [...group(live, r => r.collected_at)]
        .sort((a, b) => b[1].length - a[1].length).slice(0, 5)
        .map(([ts, v]) => `${ts} — ${v.length}건 [${[...new Set(v.map(x => x.mall))].join(',')}]`));

    warn(`원장 없는 카탈로그 갱신 (${LIVE_WRITE_SINCE} 이전 레거시)`, legacy,
      'backfill-current-prices.js 가 products 만 쓰던 시절의 행. 재수집되면 자연히 해소된다');
  }

  {
    /*
     * orphan 은 화면에 새지 않는다 — price_drop_top 이 products 를 inner join 하고,
     * 검색·시세판·추천도 전부 products 에서 출발하기 때문이다. 그래서 WARN 이다.
     *
     * 2026-08-27 실측(쿠팡 365건): 331건은 product_id 자리에 상품명이 들어간 옛
     * 이관분이고(그 시절 폴백은 이미 제거됐다), 34건은 이력만 남고 카탈로그 행이
     * 없는 계열이다. 둘 다 노출 경로가 없다. 다만 숫자 pid 쪽이 늘어나면
     * 카탈로그가 지워지고 있다는 신호이므로 따로 센다.
     */
    const orphan = [...new Set(H.map(pKey))].filter(k => !productKeys.has(k));
    const liveOrphan = orphan.filter(k => isRefreshableMall(k.split('|')[1]));
    const numericOrphan = liveOrphan.filter(k => /^\d+\|/.test(k));
    warn('orphan 이력 계열 (products 에 대응 행 없음)', orphan.length,
      'price_drop_top 이 products 를 inner join 하므로 화면에는 새지 않는다. 이력만 남은 상태');
    warn('  그중 수집 중인 몰 · 숫자 pid', numericOrphan.length,
      `수집 중인 몰 orphan ${liveOrphan.length}건 중. 나머지는 product_id 가 상품명인 옛 이관분이다`,
      numericOrphan.slice(0, 5));
  }

  {
    const missing = P.filter(r => !(histByPidMall.get(pKey(r)) || []).length);
    const liveMissing = missing.filter(r => isRefreshableMall(r.mall));
    warn('이력이 하나도 없는 상품', missing.length,
      '가격 이력 차트가 비고 시세판에 오르지 못한다',
      [...group(liveMissing, r => r.mall)].map(([m, v]) => `${m}=${v.length}`));
  }

  /* ── 3. 가격 값 ─────────────────────────────────────────────── */
  zero('products.lprice ≤ 0', P.filter(r => !(Number(r.lprice) > 0)).length,
    '0원 상품이 화면에 뜨고 정렬·하락률 계산이 무너진다');

  {
    const badPrice = H.filter(r => !(Number(r.price) > 0));
    zero('price_history.price ≤ 0', badPrice.length,
      'price_drop_top 의 all_time_low 가 음수가 되어 "기록상 최저" 배지가 영구히 꺼진다',
      badPrice.slice(0, 5).map(r => `[${r.mall}] ${r.product_id} price=${r.price} @${String(r.recorded_at).slice(0, 10)}`));
  }

  zero('products.link 이 http(s) 가 아님',
    P.filter(r => r.link && !/^https?:\/\//i.test(r.link)).length,
    '구매 버튼이 죽거나 javascript: 같은 스킴이 들어올 자리다');

  zero('미래 시각 collected_at', P.filter(r => Date.parse(r.collected_at) > Date.now() + 60000).length,
    '미래 시각은 최신성 판정을 영원히 통과시킨다');
  zero('미래 시각 recorded_at', H.filter(r => Date.parse(r.recorded_at) > Date.now() + 60000).length,
    '미래 관측은 "오늘의 하락" 비교 기준을 망가뜨린다');

  /* ── 4. 계열 안에서 상품이 바뀌었는가 ───────────────────────── */
  {
    const byS = group(H, sKey);
    zero('이력 계열 안에서 mall 이 바뀜',
      [...byS].filter(([, v]) => new Set(v.map(x => x.mall)).size > 1).length,
      '같은 계열이 두 몰을 오가면 서로 다른 상품의 가격을 한 줄로 잇는 것이다');

    const adSeries = [...byS].filter(([k]) => k.includes('|ADPICK|'));
    zero('ADPICK 계열 안에서 link 가 바뀜',
      adSeries.filter(([, v]) => new Set(v.map(x => x.link).filter(Boolean)).size > 1).length,
      'ADPICK 은 link 가 곧 식별자다. 계열 안에서 바뀌면 다른 상품이 섞인 것');
  }

  /* ── 5. 중복 이력 ───────────────────────────────────────────── */
  zero('price_history 중복 (product_id, mall, vendor_item_id, recorded_date)',
    [...group(H, r => `${sKey(r)}|${r.recorded_date}`)].filter(([, v]) => v.length > 1).length,
    'UNIQUE 가 살아 있으면 0이다. 0이 아니면 제약이 빠져 같은 날 값이 갈라진다');

  {
    /*
     * ★ 알려진 구조적 한계 (2026-08-27 확인).
     *
     * price_history.recorded_date 는 DB 트리거가 recorded_at 의 UTC 날짜로
     * 덮어쓴다(운영 17,545행 전부 예외 0건). 앱은 KST 를 보내는데 저장되는 건
     * UTC 날짜다. UNIQUE 에 recorded_date 가 들어가므로 KST 하루가 UTC 자정을
     * 걸치면 같은 날인데 2행이 되고, 반대로 KST 다른 날이 같은 라벨을 공유하면
     * 뒤엣것이 앞엣것을 덮어쓴다.
     *
     * 읽기 경로는 observedKstDate(recorded_at) 를 쓰므로 값 자체는 틀리지 않는다.
     * 거짓 하락도 만들어지지 않는다. 다만 이력이 유실되고 실제 하락이 억제된다.
     */
    const sameKstTwice = [...group(H, r => `${sKey(r)}|${observedKstDate(r)}`)]
      .filter(([, v]) => v.length > 1);
    warn('같은 KST 하루에 2행 이상 (recorded_date UTC 라벨 문제)', sameKstTwice.length,
      'DB 트리거가 recorded_date 를 UTC 로 강제해서 생긴다. 실제 하락이 시세판에서 억제된다');

    const dayObs = H.filter(r => r.recorded_at && new Date(r.recorded_at).getUTCHours() < 15);
    const nightObs = H.filter(r => r.recorded_at && new Date(r.recorded_at).getUTCHours() >= 15);
    const exposed = [...new Set(dayObs.map(sKey))].filter(k => new Set(nightObs.map(sKey)).has(k));
    warn('덮어쓰기에 노출된 이력 계열', exposed.length,
      'KST 낮 관측(UTC 00~14시)과 KST 새벽 관측(UTC 15~23시)이 같은 라벨을 공유하는 계열');
  }

  /* ── 6. 라벨 vs 실제 관측일 ────────────────────────────────── */
  {
    const mislabeled = H.filter(r => r.recorded_at && observedKstDate(r) !== r.recorded_date);
    warn('recorded_date 라벨 ≠ KST 관측일', mislabeled.length,
      `전체 ${H.length}행 중. 읽기 경로는 recorded_at 을 보므로 화면 값은 정확하다`);
    zero('recorded_at 결측', H.filter(r => !r.recorded_at).length,
      'recorded_at 이 없으면 KST 관측일을 판정할 방법이 없어 라벨을 믿을 수밖에 없다');
  }

  /* ── 7. 쿠팡 옵션(vendor_item_id) 식별 ─────────────────────── */
  {
    const cp = P.filter(r => r.mall === '쿠팡');
    zero('쿠팡 products 중 vendor_item_id 를 link 에서도 못 뽑는 것',
      cp.filter(r => !vendorIdOf(r)).length,
      'vid 가 없으면 한 상품의 여러 옵션이 한 줄로 합쳐져 가격이 서로를 덮어쓴다');

    const cpH = H.filter(r => r.mall === '쿠팡');
    warn("쿠팡 이력 중 vendor_item_id 가 '' 또는 __LEGACY__",
      cpH.filter(r => !r.vendor_item_id || r.vendor_item_id === '__LEGACY__').length,
      'vid 도입 이전 행. 읽기 경로가 link 에서 폴백하므로 조회는 되지만 옵션별로 갈리지 않는다');
  }

  /* ── 8. 노출 가능성 ─────────────────────────────────────────── */
  {
    const lc = new Map();
    P.forEach(r => {
      const s = productLifecycle(r).state;
      lc.set(s, (lc.get(s) || 0) + 1);
    });
    ok('lifecycle 분포', P.length, '현재가로 내보낼 수 있는 상품 수',
      [...lc].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`));
  }

  /* ── 9. 현재가가 원장과 맞는가 ─────────────────────────────── */
  {
    let match = 0;
    const mismatch = [];
    P.forEach(r => {
      const rows = (histByPidMall.get(pKey(r)) || []).slice()
        .sort((a, b) => String(b.recorded_at).localeCompare(a.recorded_at));
      if (!rows.length) return;
      if (Number(rows[0].price) === Number(r.lprice)) match++;
      else mismatch.push(`[${r.mall}] ${String(r.product_id).slice(0, 12)} products=${r.lprice} 최신원장=${rows[0].price}`);
    });
    /*
     * 불일치가 전부 결함은 아니다. classifyPrice 가 'suspect' 로 판정한 관측은
     * 원장에는 남기고 현재가로는 올리지 않는다 — 그게 설계된 동작이다.
     * 그래서 FAIL 이 아니라 WARN 으로 둔다. 비율이 갑자기 튀면 그때 본다.
     */
    warn('products.lprice ≠ 최신 원장 가격', mismatch.length,
      `일치 ${match}건. suspect 보류(설계된 동작)와 원장 쓰기 실패가 섞여 있다`,
      mismatch.slice(0, 5));
  }

  /* ── 출력 ───────────────────────────────────────────────────── */
  const fails = results.filter(r => r.level === 'FAIL');
  const warns = results.filter(r => r.level === 'WARN');

  if (JSON_OUT) {
    console.log(JSON.stringify({
      today, products: P.length, priceHistory: H.length,
      fail: fails.length, warn: warns.length, results
    }, null, 2));
  } else {
    console.log(`\nSEOSA 운영 DB 무결성 감사 (읽기 전용)`);
    console.log(`KST ${today} · products ${P.length} · price_history ${H.length}\n`);
    results.forEach(r => {
      const mark = r.level === 'FAIL' ? '✗' : r.level === 'WARN' ? '!' : '✓';
      console.log(`${mark} ${r.name.padEnd(52)} ${String(r.count).padStart(6)}`);
      if (r.level !== 'OK') console.log(`     ${r.why}`);
      r.samples.slice(0, 5).forEach(s => console.log(`       · ${s}`));
    });
    console.log(`\n${'─'.repeat(66)}`);
    console.log(`FAIL ${fails.length} / WARN ${warns.length} / OK ${results.length - fails.length - warns.length}`);
    if (fails.length) {
      console.log('\n먼저 볼 것:');
      fails.forEach(r => console.log(`  · ${r.name} (${r.count}) — ${r.why}`));
    }
  }

  process.exit(fails.length ? 1 : 0);
})().catch(e => {
  console.error('감사 실행 실패:', e.message);
  process.exit(2);
});
