#!/usr/bin/env node
/*
 * 가격 알림 조건 확인 → 이메일 발송
 * GitHub Actions에서 collect-all-prices.js 다음에 실행됩니다.
 *
 * 알림 조건 (중복 가능, 한 번에 모아서 발송):
 *   1. target  — 오늘 가격 ≤ 사용자 목표가
 *   2. drop    — 전날 대비 5% 이상 하락
 *   3. atl     — 역대 최저가 갱신
 *   4. deal    — api/_deal.js 판정이 BUY/GOOD_BUY (alerts.on_deal 을 켠 알림만)
 *
 * 1~3 은 전부 "가격이 얼마인가" 만 본다. 목표가를 정하려면 사용자가 적정가를
 * 미리 알아야 하는데, 모르니까 알림을 신청한다. 4 는 그 부담을 없앤다 —
 * 판정은 Deal Engine 이 하고 여기서는 결과만 읽는다.
 */

require('./_env');
const supabase = require('../api/_supabase');
const notify   = require('../api/_notify');
const { kstToday, kstDayStartUtc, observedKstDate, sameVendorRows } = require('../api/_price');

const DROP_THRESHOLD = 0.05; // 5% 이상 하락 시 알림
/*
 * "오늘" / "어제" / "30일 전" 은 KST 달력 기준이다.
 *
 * ★ 그런데 recorded_date 라벨과 직접 비교하면 안 된다 — 이 스크립트가 정확히
 *   그렇게 해서 알림이 한 통도 나가지 않고 있었다.
 *
 *   recorded_date 는 운영 DB 가 recorded_at 을 UTC 로 잘라 넣는 값이라
 *   우리가 KST 로 보내도 무시된다 (api/_price.js kstToday 주석의 실측 참고).
 *   이 스크립트는 GitHub Actions 에서 KST 01·03·06시(= UTC 16·18·21시)에
 *   도는데, 그 시각의 kstToday() 는 "UTC 로는 내일" 이다. 즉
 *       .eq('recorded_date', kstToday())
 *   는 아직 존재할 수 없는 라벨을 찾는 질의라 항상 0건이었고, 모든 알림이
 *   "오늘 가격 없음"으로 건너뛰어졌다. (2026-08-23 확인: UTC 16/18/21시 세
 *   시점 모두 0건)
 *
 *   그래서 날짜 경계는 절대 시각(recorded_at)으로 잡는다 — kstDayStartUtc().
 *   라벨이 어느 시간대로 잘리든 결과가 달라지지 않는다.
 */
const TODAY = kstToday();

function won(n) { return Number(n).toLocaleString('ko-KR'); }

/* ------------------------------------------------------------------ *
 *  PostgREST 1,000행 상한
 *
 *  ★ .limit() 을 걸지 않아도 무제한으로 오지 않는다.
 *
 *  Supabase 의 db-max-rows 기본값이 1,000 이라, 그 값이 그대로 상한이 된다.
 *  이 스크립트의 조회는 전부 그 위에 있었고, 하필 정렬이
 *      .order('recorded_at', { ascending: true })
 *  이라 잘려 나가는 쪽이 "그날 나중에 수집된 행" 이었다. 그런데 latestByProduct
 *  는 "뒤에 온 것이 이긴다" 로 그날 최종값을 잡는 설계다 — 잘리면 설계가 통째로
 *  뒤집혀서, 새벽 첫 관측을 그날 가격으로 쓰게 된다.
 *
 *  실측(2026-08-24): 수집 대상 1,064개 / 오늘 price_history 544행. 아직 상한
 *  아래지만 보충 실행이 하루 2회 더 있어 곧 넘는다. 넘는 순간 조용히 틀린다.
 *
 *  ── 왜 limit 을 크게 잡는 것으로 끝내지 않는가 ──────────────────────
 *  db-max-rows 는 서버 설정이라 클라이언트가 .limit(5000) 을 보내도 1,000 에서
 *  잘린다. 오프셋을 옮겨 가며 여러 번 받아오는 수밖에 없다.
 *  (scripts/collect-all-prices.js fetchAllProducts 와 같은 방식)
 *
 *  ── 페이지네이션에는 전순서가 필요하다 ──────────────────────────────
 *  recordPrices 는 한 배치의 recorded_at 을 전부 같은 값으로 넣는다. 그래서
 *  recorded_at 만으로 정렬하면 동점이 대량으로 생기고, 페이지 경계에서 어떤
 *  행은 두 번 오고 어떤 행은 영영 안 온다. 반드시 id 를 2차 정렬키로 둔다.
 * ------------------------------------------------------------------ */
const PAGE = 1000;

/**
 * 오프셋을 옮겨 가며 전부 받아온다.
 * @param {string} label   오류 메시지에 쓸 이름
 * @param {function} build 매번 새 쿼리 빌더를 만들어 주는 함수 (재사용 불가하므로)
 */
async function fetchAllRows(label, build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(`${label} 조회 실패: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE) return out;
  }
}

/**
 * 30일 통계용 상한.
 * 상품 1개 × 30일 × 옵션 몇 개면 수십 행이다. 페이지네이션까지 갈 일이 없고,
 * 명시적 limit 하나로 "상한이 있다" 는 사실을 코드에 남긴다.
 */
const HIST30_MAX_ROWS = 500;

function buildTiming(cur, avg30, min30, alerts) {
  const lines = [];
  if (alerts.some(a => a.type === 'target')) lines.push('설정하신 목표 가격에 도달했습니다.');
  if (alerts.some(a => a.type === 'atl'))    lines.push('역대 최저가를 갱신했습니다. 지금이 가장 저렴한 시점입니다.');
  if (alerts.some(a => a.type === 'drop')) {
    const drop = alerts.find(a => a.type === 'drop');
    lines.push(`전날보다 ${drop.dropPct.toFixed(1)}% 하락했습니다.`);
  }
  /*
   * Deal 판정으로 발동한 경우. 판정이 만든 근거 문장을 그대로 싣는다 —
   * 메일에서 다시 쓰면 화면·AI 답변과 다른 말이 된다.
   */
  const deal = alerts.find(a => a.type === 'deal');
  if (deal) {
    lines.push(deal.reason
      ? `구매 시점 판정이 "${deal.verdict}" 입니다. ${deal.reason}.`
      : `구매 시점 판정이 "${deal.verdict}" 입니다.`);
  }
  if (avg30 > 0) {
    const pct = ((cur - avg30) / avg30) * 100;
    if (pct < -10)      lines.push(`최근 30일 평균보다 ${Math.abs(pct).toFixed(1)}% 저렴합니다. 지금 구매를 추천드립니다.`);
    else if (pct < 0)   lines.push(`최근 30일 평균보다 ${Math.abs(pct).toFixed(1)}% 저렴합니다.`);
    else                lines.push(`최근 30일 평균(${won(avg30)}원)보다 ${pct.toFixed(1)}% 높지만, 알림 조건을 충족했습니다.`);
  }
  return lines.join(' ') || '가격 알림 조건이 충족되었습니다.';
}

/**
 * 발송 완료 표시. 이걸 못 남기면 내일도 같은 메일이 또 나가므로
 * sent_at 컬럼이 아직 없는 DB에서는 sent만이라도 반드시 올린다.
 */
async function markSent(id, currentPrice) {
  const base = { sent: true, current_price: currentPrice };

  const { error } = await supabase
    .from('alerts')
    .update({ ...base, sent_at: new Date().toISOString() })
    .eq('id', id);
  if (!error) return;

  if (/sent_at|column/i.test(error.message)) {
    console.warn('⚠️ alerts.sent_at 컬럼이 없습니다. supabase/schema.sql을 실행하세요.');
    const { error: retryErr } = await supabase.from('alerts').update(base).eq('id', id);
    if (!retryErr) return;
    console.error(`❌ sent 갱신 실패 (중복 발송 위험): ${retryErr.message}`);
    return;
  }
  console.error(`❌ sent 갱신 실패 (중복 발송 위험): ${error.message}`);
}

async function run() {
  // 메일 발송 수단이 없으면 조건을 아무리 잘 판정해도 아무 일도 일어나지 않는다.
  // 조용히 "0건 발송"으로 끝나면 설정 누락을 알 수 없으므로 먼저 밝힌다.
  if (!process.env.RESEND_API_KEY) {
    console.error('❌ RESEND_API_KEY 가 없습니다 — 알림 메일을 보낼 수 없습니다.');
    console.error('   GitHub > Settings > Secrets and variables > Actions 에 추가하세요.');
    process.exitCode = 1;
  }

  // KST 달력 하루의 경계 (절대 시각). 위 TODAY 주석 참고.
  const yesterday  = kstToday(new Date(Date.now() - 86400000));
  const todayStart = kstDayStartUtc(TODAY);
  const yestStart  = kstDayStartUtc(yesterday);

  /*
   * 한 상품이 하루에 여러 번 관측될 수 있다 (옵션별 행 + 크론이 여러 번 돎).
   * 그날의 값은 가장 늦게 관측된 것이다 — 오름차순으로 받아 뒤에 온 것이
   * 앞의 것을 덮게 한다. 예전 .eq(recorded_date) 질의는 라벨 UNIQUE 덕에
   * 상품당 한 행이었으므로, 접지 않으면 임의의 옵션 값이 잡힌다.
   */
  const latestByProduct = rows => {
    const m = new Map();
    (rows || []).forEach(r => m.set(r.product_id + '|' + r.mall, r));
    return m;
  };

  // 1. 오늘(KST) 수집된 가격
  const todayRows = await fetchAllRows('오늘 가격', () => supabase
    .from('price_history')
    // vendor_item_id 도 받는다 — 아래 이력 조회를 같은 옵션으로 좁히는 데 쓴다.
    .select('product_id, mall, title, price, link, recorded_at, vendor_item_id')
    .gte('recorded_at', todayStart)
    .order('recorded_at', { ascending: true })
    .order('id', { ascending: true }));
  const todayPrices = [...latestByProduct(todayRows).values()];

  /*
   * 2. 어제(KST) 가격 (drop 조건용)
   *
   * 여기서 실패해도 스크립트를 죽이지 않는다. 어제 값이 없으면 '전날 대비 하락'
   * 조건만 판정할 수 없을 뿐, 목표가·역대 최저가 알림은 그대로 나가야 한다.
   * (예전에도 이 조회의 오류를 무시하고 있었다 — 그 동작을 유지한다)
   */
  let prevMap = new Map();
  try {
    const yesterdayRows = await fetchAllRows('어제 가격', () => supabase
      .from('price_history')
      .select('product_id, mall, price, recorded_at, vendor_item_id')
      .gte('recorded_at', yestStart)
      .lt('recorded_at', todayStart)
      .order('recorded_at', { ascending: true })
      .order('id', { ascending: true }));
    // 가격만이 아니라 옵션도 함께 기억한다 — 어제와 오늘이 다른 옵션이면
    // 그 둘의 차이는 "가격이 내렸다" 가 아니라 "다른 상품을 봤다" 이다.
    prevMap = new Map(
      [...latestByProduct(yesterdayRows).entries()]
        .map(([k, r]) => [k, { price: r.price, vid: String(r.vendor_item_id || '') }]));
  } catch (e) {
    console.warn(`⚠️ 어제 가격을 읽지 못했습니다(하락 조건만 생략): ${e.message}`);
  }

  // 3. 알림 목록
  // 테이블명은 alerts. /api/alerts 와 supabase/schema.sql 이 쓰는 이름과 반드시 같아야 한다.
  // id 오름차순 — 페이지 경계에서 행이 새거나 겹치지 않게 전순서를 준다.
  const alertList = await fetchAllRows('알림 목록', () => supabase
    .from('alerts')
    .select('*')
    .eq('sent', false)
    .order('id', { ascending: true }));

  console.log(`오늘 가격: ${todayPrices.length}개 / 알림 대상: ${alertList.length}개`);
  /*
   * 알림 신청은 있는데 오늘 가격이 한 건도 없으면 조건 판정 자체가 불가능하다.
   * 조용히 "0건 발송"으로 끝나면 날짜 경계가 어긋났을 때 아무도 눈치채지 못한다
   * — 실제로 그렇게 한동안 알림이 멈춰 있었다.
   */
  if (alertList.length && !todayPrices.length) {
    console.error(`❌ 오늘(KST ${TODAY}, ${todayStart} 이후) 수집된 가격이 0건입니다.`
      + ' 수집이 실패했거나 날짜 경계가 어긋났습니다 — 알림을 판정할 수 없습니다.');
    process.exitCode = 1;
  }

  let sent = 0, skipped = 0, skippedLegacy = 0;

  for (const alert of alertList) {
    /*
     * 오늘 가격은 상품 식별자(product_id [+ mall])로만 찾는다.
     *
     * 상품명 폴백은 없앴다. 상품명은 고유하지 않다 — 쿠팡에는 같은 이름의
     * 다른 상품이 흔하고, 그중 싼 쪽 가격을 집으면 "목표가 달성" 메일이
     * 사실이 아닌 채로 나간다. 화면 표시와 달리 메일은 되돌릴 수 없고,
     * 사용자는 그걸 믿고 클릭해서 전혀 다른 가격을 보게 된다.
     *
     * product_id 는 supabase/2026-08-hardening.sql 적용 이후 신청분부터
     * 채워진다. 그 전에 신청된 행은 빈 문자열이라 이제 발송 대상에서 빠진다.
     * 잘못된 알림을 보내는 것보다 안 보내는 쪽이 낫다. 사용자가 그 상품을
     * 다시 찜하거나 알림을 재신청하면 product_id 가 채워져 정상 동작한다.
     */
    if (!alert.product_id) {
      skippedLegacy++;
      continue;
    }

    const todayRow =
      todayPrices.find(p => p.product_id === alert.product_id && p.mall === alert.mall)
      || todayPrices.find(p => p.product_id === alert.product_id);
    if (!todayRow) { skipped++; continue; }

    const cur = todayRow.price;
    /*
     * 오늘 관측의 옵션(vendor_item_id). 아래 이력 조회를 전부 이 옵션으로 좁힌다.
     *
     * 좁히지 않으면 같은 상품 페이지에 묶인 다른 옵션의 값으로 "역대 최저가
     * 갱신" 메일이 나간다. 운영 실측(2026-09-04): (product_id, mall) 조합
     * 3,220개 중 301개에서 역대 최저가가 지금 파는 옵션의 값이 아니었다.
     */
    const curVid = String(todayRow.vendor_item_id || '');

    /*
     * 어제 가격 — 같은 옵션일 때만 쓴다.
     *
     * 어제는 A옵션(20,000원), 오늘은 B옵션(12,000원)이 잡혔다면 40% 하락이
     * 아니라 다른 상품이다. 어느 한쪽의 옵션을 모르면(옛 기록) 예전처럼 비교한다 —
     * 모른다는 이유로 알림을 없애지는 않는다.
     */
    const prevRec = prevMap.get(todayRow.product_id + '|' + todayRow.mall);
    const prevMismatch = !!(prevRec && prevRec.vid && curVid && prevRec.vid !== curVid);
    const prev = (prevRec && !prevMismatch) ? (prevRec.price || 0) : 0;
    if (prevMismatch) {
      console.log(`  · ${alert.title}: 어제와 오늘의 옵션이 다릅니다`
        + ` (${prevRec.vid} → ${curVid}) — 하락 조건은 건너뜁니다`);
    }

    // 알림 조건 확인
    const triggeredAlerts = [];
    if (alert.target_price > 0 && cur <= alert.target_price)
      triggeredAlerts.push({ type: 'target', targetPrice: alert.target_price });
    if (prev > 0 && (prev - cur) / prev >= DROP_THRESHOLD)
      triggeredAlerts.push({ type: 'drop', dropPct: ((prev - cur) / prev) * 100 });

    /*
     * "AI 가 사도 좋다고 하면 알려줘" (alerts.on_deal).
     *
     * 위 세 조건은 전부 "가격이 얼마인가" 만 본다. 목표가를 정하려면 사용자가
     * 적정가를 미리 알아야 하는데, 모르니까 알림을 신청하는 것이다.
     *
     * 이 조건은 api/_deal.js 판정을 그대로 쓴다. 여기서 다시 계산하지 않는다 —
     * 화면·AI 답변·알림 메일이 같은 상품을 두고 다른 말을 하면 안 된다.
     * BUY / GOOD_BUY 일 때만 보낸다. NORMAL 에 메일을 보내면 알림이 소음이 된다.
     *
     * on_deal 컬럼이 없는 DB에서는 undefined 라 그냥 건너뛴다.
     */
    if (alert.on_deal) {
      try {
        const { statsFrom } = require('../api/_pricestat');
        const { dealOf, DEAL_ORDER } = require('../api/_deal');

        // 판정에 쓸 기록은 오늘 가격을 찾은 그 상품·그 옵션 것이어야 한다
        // (아래 scoped 와 같은 기준).
        const { data: histRows } = await supabase
          .from('price_history')
          .select('recorded_date, recorded_at, price, vendor_item_id')
          .eq('product_id', todayRow.product_id)
          .eq('mall', todayRow.mall)
          .order('recorded_at', { ascending: false })
          .limit(HIST30_MAX_ROWS);

        const byDate = new Map();
        sameVendorRows(histRows || [], curVid).forEach(r => {
          const d = observedKstDate(r);
          if (!d) return;
          const got = byDate.get(d);
          if (got === undefined || r.price < got) byDate.set(d, r.price);
        });
        const points = [...byDate.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([date, price]) => ({ date, price }));

        const deal = dealOf(statsFrom(points), cur, TODAY);
        if (DEAL_ORDER[deal.verdict] >= DEAL_ORDER.GOOD_BUY) {
          triggeredAlerts.push({ type: 'deal', verdict: deal.verdict, reason: deal.reasons[0] || '' });
        }
      } catch (e) {
        // 판정에 실패했다고 다른 조건까지 막지 않는다.
        console.warn(`⚠️ 구매 시점 판정 실패(${alert.title}): ${e.message}`);
      }
    }

    /*
     * 역대 최저가 · 30일 통계를 볼 범위. 오늘 가격을 찾은 그 상품과 같아야 한다.
     *
     * 여기에도 상품명 폴백이 있었다. 오늘 값은 A상품에서, 역대 최저가는 동명의
     * B상품에서 가져오면 "역대 최저가 갱신"도 "30일 평균보다 쌉니다"도 사실이
     * 아니게 된다. 이제 상품 단위로만 본다.
     */
    /*
     * ★ 옵션까지 좁힌다.
     *
     * 예전에는 (product_id, mall) 로만 좁히고 최저가 1행을 DB 에서 바로 뽑았다.
     * 그러면 같은 상품 페이지의 다른 옵션 값이 "역대 최저" 가 되어, 살 수 없는
     * 가격으로 메일이 나간다. 옵션 판정(_price.sameVendorRows)은 코드에서
     * 해야 하므로 행을 받아 와서 거른 뒤 최저값을 구한다.
     */
    const scoped = () => supabase
      .from('price_history').select('price, vendor_item_id')
      .eq('product_id', todayRow.product_id)
      .eq('mall', todayRow.mall);

    // 역대 최저가 확인
    const { data: allHistory } = await scoped()
      .order('price', { ascending: true })
      .limit(HIST30_MAX_ROWS);
    const allPrices = sameVendorRows(allHistory || [], curVid)
      .map(r => Number(r.price)).filter(n => n > 0);
    const allTimeMin = allPrices.length ? Math.min(...allPrices) : null;
    if (allTimeMin !== null && cur <= allTimeMin)
      triggeredAlerts.push({ type: 'atl' });

    if (!triggeredAlerts.length) { skipped++; continue; }

    // 30일 통계 — 여기도 라벨이 아니라 절대 시각으로 자른다 (위 TODAY 주석 참고)
    const thirtyAgo = kstToday(new Date(Date.now() - 30 * 86400000));
    // 상품 1개로 좁혀진 쿼리라 페이지네이션까지 갈 일이 없다. 다만 상한은
    // 명시한다 — 안 적으면 db-max-rows(1,000)에 조용히 걸린다.
    const { data: hist30 } = await scoped()
      .gte('recorded_at', kstDayStartUtc(thirtyAgo))
      .order('recorded_at', { ascending: false })
      .limit(HIST30_MAX_ROWS);
    const prices30 = sameVendorRows(hist30 || [], curVid).map(r => r.price);
    const avg30 = prices30.length ? Math.round(prices30.reduce((a, b) => a + b, 0) / prices30.length) : 0;
    const min30 = prices30.length ? Math.min(...prices30) : 0;
    const diffPct = avg30 > 0 ? ((cur - avg30) / avg30) * 100 : null;

    const product = {
      title: alert.title,
      currentPrice: cur,
      mall: alert.mall || todayRow.mall || '',
      link: alert.link || todayRow.link || '',
      image: alert.image || ''
    };

    const analysis = {
      avg30, min30, diffPct,
      timing: buildTiming(cur, avg30, min30, triggeredAlerts)
    };

    /*
     * 조건 이름. 삼항 사슬의 끝이 '가격 급락' 이라, 새 조건을 추가하면 그것도
     * 조용히 '가격 급락' 으로 찍힌다 — deal 조건을 넣자마자 로그에 "가격 급락"
     * 이 두 번 나왔다. 표로 바꿔서 모르는 종류는 종류 이름 그대로 남긴다.
     */
    const COND_NAME = {
      target: '목표가 달성', atl: '역대 최저가', drop: '가격 급락', deal: 'AI 구매 추천'
    };
    const condNames = triggeredAlerts.map(a => COND_NAME[a.type] || a.type).join(' · ');

    const result = await notify.send('email', {
      to: alert.email,
      subject: `[SEOSA] ${condNames} — ${alert.title.slice(0, 25)}`,
      product, analysis,
      alerts: triggeredAlerts
    });

    if (result.ok) {
      await markSent(alert.id, cur);
      console.log(`✅ ${alert.email} → ${alert.title.slice(0, 30)} (${condNames})`);
      sent++;
    } else {
      console.error(`❌ 발송 실패 ${alert.email}: ${result.error}`);
    }
  }

  console.log(`\n완료: ${sent}건 발송 / ${skipped}건 스킵`
    + (skippedLegacy ? ` / ${skippedLegacy}건 제외(product_id 없는 옛 신청)` : ''));

  if (skippedLegacy) {
    console.warn(
      `⚠️  product_id 가 없는 알림 ${skippedLegacy}건은 발송하지 않았습니다.\n`
      + '   상품명만으로 가격을 찾으면 동명의 다른 상품 가격으로 잘못된 알림이 나갈 수 있어\n'
      + '   의도적으로 건너뜁니다. 사용자가 해당 상품에서 알림을 다시 신청하면 채워집니다.'
    );
  }
}

/*
 * 직접 실행할 때만 돌린다 (GitHub Actions 의 `node scripts/check-alerts.js`).
 * require 해도 자동 실행되지 않아야 테스트에서 가짜 Supabase / 가짜 발송기를
 * 물려 놓고 run() 을 부를 수 있다. CLI 동작은 그대로다.
 */
if (require.main === module) {
  run().catch(e => { console.error('오류:', e.message); process.exit(1); });
}

module.exports = { run };
