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

const DROP_THRESHOLD = 0.05; // 5% 이상 하락 시 알림
const TODAY = new Date().toISOString().slice(0, 10);

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

  // 1. 오늘 수집된 가격
  const { data: todayPrices, error: e1 } = await supabase
    .from('price_history')
    .select('product_id, mall, title, price, link')
    .eq('recorded_date', TODAY);
  if (e1) throw new Error('오늘 가격 조회 실패: ' + e1.message);

  // 2. 어제 가격 (drop 조건용)
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const { data: yesterdayPrices } = await supabase
    .from('price_history')
    .select('product_id, mall, price')
    .eq('recorded_date', yesterday);
  const prevMap = new Map((yesterdayPrices || []).map(r => [r.product_id + '|' + r.mall, r.price]));

  // 3. 알림 목록
  // 테이블명은 alerts. /api/alerts 와 supabase/schema.sql 이 쓰는 이름과 반드시 같아야 한다.
  const { data: alertList, error: e3 } = await supabase
    .from('alerts')
    .select('*')
    .eq('sent', false);
  if (e3) throw new Error('알림 목록 조회 실패: ' + e3.message);

  console.log(`오늘 가격: ${todayPrices.length}개 / 알림 대상: ${alertList.length}개`);

  let sent = 0, skipped = 0;

  for (const alert of alertList) {
    /*
     * 오늘 가격 찾기 — product_id 가 있으면 그걸 먼저 쓴다.
     *
     * 상품명은 고유하지 않다. 쿠팡에는 같은 이름의 다른 상품이 흔해서, 이름만으로
     * 찾으면 값이 싼 동명이물의 가격으로 "목표가 달성" 메일이 나갈 수 있다.
     * (product_id 는 supabase/2026-08-hardening.sql 적용 이후 신청분부터 채워진다.
     *  그 전에 신청된 행은 빈 문자열이라 예전처럼 상품명으로 찾는다.)
     */
    const todayRow =
      (alert.product_id
        ? todayPrices.find(p => p.product_id === alert.product_id && p.mall === alert.mall)
          || todayPrices.find(p => p.product_id === alert.product_id)
        : null)
      || todayPrices.find(p => p.title === alert.title && p.mall === alert.mall)
      || todayPrices.find(p => p.title === alert.title);
    if (!todayRow) { skipped++; continue; }

    const cur = todayRow.price;
    const prev = prevMap.get(todayRow.product_id + '|' + todayRow.mall) || 0;

    // 알림 조건 확인
    const triggeredAlerts = [];
    if (alert.target_price > 0 && cur <= alert.target_price)
      triggeredAlerts.push({ type: 'target', targetPrice: alert.target_price });
    if (prev > 0 && (prev - cur) / prev >= DROP_THRESHOLD)
      triggeredAlerts.push({ type: 'drop', dropPct: ((prev - cur) / prev) * 100 });

    // 이 알림의 가격 기록을 어떤 범위로 볼지. 오늘 가격을 찾은 그 상품과
    // 같은 범위여야 한다 — 오늘 값은 A상품, 역대 최저가는 동명의 B상품에서
    // 가져오면 "역대 최저가 갱신"이 사실이 아니게 된다.
    const scoped = () => {
      const q = supabase.from('price_history').select('price');
      return todayRow.product_id
        ? q.eq('product_id', todayRow.product_id).eq('mall', todayRow.mall)
        : q.eq('title', alert.title);
    };

    // 역대 최저가 확인
    const { data: allHistory } = await scoped()
      .order('price', { ascending: true })
      .limit(1);
    const allTimeMin = allHistory && allHistory[0] ? allHistory[0].price : null;
    if (allTimeMin !== null && cur <= allTimeMin)
      triggeredAlerts.push({ type: 'atl' });

    if (!triggeredAlerts.length) { skipped++; continue; }

    // 30일 통계
    const thirtyAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const { data: hist30 } = await scoped().gte('recorded_date', thirtyAgo);
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

  console.log(`\n완료: ${sent}건 발송 / ${skipped}건 스킵`);
}

run().catch(e => { console.error('오류:', e.message); process.exit(1); });
