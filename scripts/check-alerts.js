#!/usr/bin/env node
/*
 * 가격 알림 조건 확인 → 이메일 발송
 * GitHub Actions에서 collect-all-prices.js 다음에 실행됩니다.
 *
 * 알림 조건 (중복 가능, 한 번에 모아서 발송):
 *   1. target  — 오늘 가격 ≤ 사용자 목표가
 *   2. drop    — 전날 대비 5% 이상 하락
 *   3. atl     — 역대 최저가 갱신
 */

require('./_env');
const supabase = require('../api/_supabase');
const notify   = require('../api/_notify');
const { kstToday, kstDayStartUtc } = require('../api/_price');

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

function buildTiming(cur, avg30, min30, alerts) {
  const lines = [];
  if (alerts.some(a => a.type === 'target')) lines.push('설정하신 목표 가격에 도달했습니다.');
  if (alerts.some(a => a.type === 'atl'))    lines.push('역대 최저가를 갱신했습니다. 지금이 가장 저렴한 시점입니다.');
  if (alerts.some(a => a.type === 'drop')) {
    const drop = alerts.find(a => a.type === 'drop');
    lines.push(`전날보다 ${drop.dropPct.toFixed(1)}% 하락했습니다.`);
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
  const { data: todayRows, error: e1 } = await supabase
    .from('price_history')
    .select('product_id, mall, title, price, link, recorded_at')
    .gte('recorded_at', todayStart)
    .order('recorded_at', { ascending: true });
  if (e1) throw new Error('오늘 가격 조회 실패: ' + e1.message);
  const todayPrices = [...latestByProduct(todayRows).values()];

  // 2. 어제(KST) 가격 (drop 조건용)
  const { data: yesterdayRows } = await supabase
    .from('price_history')
    .select('product_id, mall, price, recorded_at')
    .gte('recorded_at', yestStart)
    .lt('recorded_at', todayStart)
    .order('recorded_at', { ascending: true });
  const prevMap = new Map(
    [...latestByProduct(yesterdayRows).entries()].map(([k, r]) => [k, r.price]));

  // 3. 알림 목록
  // 테이블명은 alerts. /api/alerts 와 supabase/schema.sql 이 쓰는 이름과 반드시 같아야 한다.
  const { data: alertList, error: e3 } = await supabase
    .from('alerts')
    .select('*')
    .eq('sent', false);
  if (e3) throw new Error('알림 목록 조회 실패: ' + e3.message);

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
    const prev = prevMap.get(todayRow.product_id + '|' + todayRow.mall) || 0;

    // 알림 조건 확인
    const triggeredAlerts = [];
    if (alert.target_price > 0 && cur <= alert.target_price)
      triggeredAlerts.push({ type: 'target', targetPrice: alert.target_price });
    if (prev > 0 && (prev - cur) / prev >= DROP_THRESHOLD)
      triggeredAlerts.push({ type: 'drop', dropPct: ((prev - cur) / prev) * 100 });

    /*
     * 역대 최저가 · 30일 통계를 볼 범위. 오늘 가격을 찾은 그 상품과 같아야 한다.
     *
     * 여기에도 상품명 폴백이 있었다. 오늘 값은 A상품에서, 역대 최저가는 동명의
     * B상품에서 가져오면 "역대 최저가 갱신"도 "30일 평균보다 쌉니다"도 사실이
     * 아니게 된다. 이제 상품 단위로만 본다.
     */
    const scoped = () => supabase
      .from('price_history').select('price')
      .eq('product_id', todayRow.product_id)
      .eq('mall', todayRow.mall);

    // 역대 최저가 확인
    const { data: allHistory } = await scoped()
      .order('price', { ascending: true })
      .limit(1);
    const allTimeMin = allHistory && allHistory[0] ? allHistory[0].price : null;
    if (allTimeMin !== null && cur <= allTimeMin)
      triggeredAlerts.push({ type: 'atl' });

    if (!triggeredAlerts.length) { skipped++; continue; }

    // 30일 통계 — 여기도 라벨이 아니라 절대 시각으로 자른다 (위 TODAY 주석 참고)
    const thirtyAgo = kstToday(new Date(Date.now() - 30 * 86400000));
    const { data: hist30 } = await scoped().gte('recorded_at', kstDayStartUtc(thirtyAgo));
    const prices30 = (hist30 || []).map(r => r.price);
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

    const condNames = triggeredAlerts.map(a =>
      a.type === 'target' ? '목표가 달성' : a.type === 'atl' ? '역대 최저가' : '가격 급락'
    ).join(' · ');

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
