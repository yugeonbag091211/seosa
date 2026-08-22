'use strict';
/*
 * 데이터 품질 지표.
 *
 * 왜 별도 엔드포인트가 아닌가 — Vercel Hobby 는 서버리스 함수를 12개까지만
 * 허용하고 지금 정확히 12개다. 그래서 CRON_SECRET 으로 보호되는 기존
 * /api/cron?diag=1 에 얹는다. 이 모듈은 계산만 하고, 노출 판단은 호출부가 한다.
 *
 * ★ 여기 있는 수치는 전부 운영 정보다. 절대 공개 엔드포인트로 내보내지 말 것.
 *   (상품 수·수집 실패·API 성공률은 경쟁사에게 그대로 운영 규모를 알려준다)
 *
 * 판정 기준은 새로 만들지 않는다. api/_price.js 의 productLifecycle 을 그대로
 * 쓴다 — 화면에 보이는 것과 지표가 어긋나면 지표를 볼 이유가 없다.
 */

const supabase = require('./_supabase');
const { productLifecycle, LIFECYCLE, vendorIdOf, parsePrice, classifyPrice, ageDays, kstToday } = require('./_price');

const PAGE = 1000;
/** 이보다 많으면 표본만 본다. 진단 한 번에 DB 를 통째로 긁지 않기 위한 상한. */
const MAX_ROWS = 5000;

/**
 * @param {boolean} newestFirst
 *   표본 상한에 걸렸을 때 어느 쪽을 버릴지가 갈린다.
 *   price_history 는 반드시 최신순으로 읽어야 한다 — 오래된 순으로 읽고
 *   5000행에서 자르면 "오늘 기록 0건"처럼 정반대 결론이 나온다
 *   (실제로 이 지표를 처음 돌렸을 때 그렇게 나왔다).
 */
async function fetchAll(table, columns, newestFirst) {
  const out = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await supabase
      .from(table).select(columns)
      .order('id', { ascending: !newestFirst })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return { rows: out, truncated: out.length >= MAX_ROWS };
}

function pct(n, d) {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
}

/**
 * 데이터 품질 스냅샷. 읽기 전용 — 아무것도 쓰지 않는다.
 * 실패해도 진단 전체를 죽이지 않고 { error } 를 돌려준다.
 */
async function qualitySnapshot() {
  try {
    const p = await fetchAll('products',
      'product_id, mall, keyword, title, lprice, collected_at, link, item_id, vendor_item_id', false);
    // 최신순 — 잘리더라도 최근 기록이 남아야 신선도 지표가 사실이 된다.
    const h = await fetchAll('price_history', 'product_id, mall, price, recorded_date', true);
    const products = p.rows;
    const history = h.rows;

    /* ── 1. 상품 라이프사이클 ─────────────────────────────── */
    const life = { live: 0, stale: 0, 'dead-mall': 0, invalid: 0 };
    let unreachable = 0;      // 쿠팡인데 keyword 가 없어 수집기가 못 찾는 행
    let withVendorId = 0;     // 컬럼 또는 link 로 옵션 식별자를 아는 행
    let vendorIdInColumn = 0; // 컬럼에 실제로 저장된 행

    products.forEach(p => {
      const { state, reachable } = productLifecycle(p);
      life[state] = (life[state] || 0) + 1;
      if (state !== LIFECYCLE.DEAD_MALL && !reachable) unreachable++;
      if (vendorIdOf(p)) withVendorId++;
      if (p.vendor_item_id) vendorIdInColumn++;
    });

    /* ── 2. 신선도 ────────────────────────────────────────── */
    const coupang = products.filter(p => p.mall === '쿠팡');
    const fresh = d => coupang.filter(p => ageDays(p.collected_at) <= d).length;
    const newest = coupang.reduce((min, p) => Math.min(min, ageDays(p.collected_at)), Infinity);

    /* ── 3. 가격 값 이상 ──────────────────────────────────── */
    const invalidPrice = products.filter(p => parsePrice(p.lprice) === null).length;

    /* ── 4. price_history 커버리지 + 급변 ─────────────────── */
    const series = new Map();
    history.forEach(r => {
      const k = `${r.product_id}|${r.mall}`;
      if (!series.has(k)) series.set(k, []);
      series.get(k).push(r);
    });

    let suspectPairs = 0;
    let comparedPairs = 0;
    const depth = { d1: 0, d2_6: 0, d7_29: 0, d30: 0 };
    series.forEach(rows => {
      rows.sort((a, b) => String(a.recorded_date).localeCompare(String(b.recorded_date)));
      const n = rows.length;
      if (n === 1) depth.d1++;
      else if (n < 7) depth.d2_6++;
      else if (n < 30) depth.d7_29++;
      else depth.d30++;

      for (let i = 1; i < n; i++) {
        comparedPairs++;
        const v = classifyPrice(rows[i].price, {
          price: rows[i - 1].price,
          observedAt: `${rows[i - 1].recorded_date}T00:00:00Z`
        }, {});
        if (v.status !== 'ok') suspectPairs++;
      }
    });

    const dates = [...new Set(history.map(r => r.recorded_date))].sort();
    // recorded_date 와 같은 KST 달력 기준으로 세야 오늘/어제 행수가 사실이 된다.
    const today = kstToday();
    const yesterday = kstToday(new Date(Date.now() - 86400000));
    const rowsOn = d => history.filter(r => r.recorded_date === d).length;

    /* ── 5. 쿠팡 API 성공률 (최근 24시간) ─────────────────── */
    let api = null;
    try {
      const { data } = await supabase
        .from('coupang_api_calls')
        .select('source, outcome, called_at')
        .gte('called_at', new Date(Date.now() - 86400000).toISOString())
        .limit(2000);
      const calls = data || [];
      const ok = calls.filter(c => c.outcome === 'ok').length;
      const bySource = {};
      calls.forEach(c => {
        bySource[c.source] = bySource[c.source] || { total: 0, ok: 0 };
        bySource[c.source].total++;
        if (c.outcome === 'ok') bySource[c.source].ok++;
      });
      const outcomes = {};
      calls.forEach(c => { outcomes[c.outcome] = (outcomes[c.outcome] || 0) + 1; });
      api = {
        최근24시간_호출: calls.length,
        성공률: `${pct(ok, calls.length)}%`,
        결과별: outcomes,
        출처별: Object.fromEntries(Object.entries(bySource)
          .map(([k, v]) => [k, `${v.ok}/${v.total} (${pct(v.ok, v.total)}%)`]))
      };
    } catch (e) {
      api = { error: e.message };
    }

    return {
      상품: {
        전체: products.length,
        노출가능_live: life.live,
        묵음_stale: life.stale,
        수집중단몰: life['dead-mall'],
        값이상_invalid: life.invalid,
        노출가능률: `${pct(life.live, products.length)}%`
      },
      수집도달성: {
        쿠팡: coupang.length,
        수집기가_못찾는행: unreachable,
        도달률: `${pct(coupang.length - unreachable, coupang.length)}%`,
        비고: unreachable
          ? 'keyword 가 없는 행. collect-all-prices 가 제목에서 검색어를 유도해 회수를 시도한다.'
          : '전부 도달 가능'
      },
      식별자: {
        // 분모는 쿠팡 행이다. 연동이 끊긴 몰 행은 애초에 쿠팡 옵션 식별자를
        // 가질 수 없으므로 분모에 넣으면 보유율이 영원히 절반으로 보인다.
        옵션식별자_보유: withVendorId,
        보유율_쿠팡기준: `${pct(withVendorId, coupang.length)}%`,
        컬럼에_저장됨: vendorIdInColumn,
        링크에서_추출: withVendorId - vendorIdInColumn,
        비고: '컬럼이 비어도 link 에서 뽑아 옵션 교체 감지에 사용한다'
      },
      신선도: {
        가장_최근_수집: Number.isFinite(newest) ? `${Math.round(newest * 10) / 10}일 전` : '없음',
        '1일이내': fresh(1),
        '3일이내': fresh(3),
        '7일이내': fresh(7),
        '10일이내_노출기준': fresh(10)
      },
      가격값: {
        파싱불가: invalidPrice,
        급변_의심_관측쌍: suspectPairs,
        비교한_관측쌍: comparedPairs,
        의심률: `${pct(suspectPairs, comparedPairs)}%`
      },
      가격이력: {
        이력보유_상품: series.size,
        '1일치': depth.d1,
        '2-6일치': depth.d2_6,
        '7-29일치': depth.d7_29,
        '30일이상': depth.d30,
        '30일차트_가능률': `${pct(depth.d30, series.size)}%`,
        기록범위: dates.length ? `${dates[0]} ~ ${dates[dates.length - 1]} (${dates.length}일)` : '없음',
        오늘_기록: rowsOn(today),
        어제_기록: rowsOn(yesterday)
      },
      쿠팡API: api,
      표본: {
        products: p.truncated ? `최근 ${products.length}행만 (총량은 더 많음)` : `전량 ${products.length}행`,
        price_history: h.truncated
          ? `최신 ${history.length}행만 (총량은 더 많음 — 오래된 이력은 이 지표에 미반영)`
          : `전량 ${history.length}행`
      }
    };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { qualitySnapshot };
