#!/usr/bin/env node
require('dotenv').config();
const supabase = require('../api/_supabase');

async function verify() {
  const TODAY = new Date().toISOString().slice(0, 10);
  console.log('='.repeat(55));
  console.log('  SEOSA 수집 검증  —  ' + TODAY);
  console.log('='.repeat(55));

  // 1. products 총 개수
  const { count: total, error: cErr } = await supabase
    .from('products').select('*', { count: 'exact', head: true });
  if (cErr) { console.error('products 조회 오류:', cErr.message); process.exit(1); }
  console.log('\n[products 총 개수]', total);

  // 2. 오늘 price_history
  const { data: todayRows, error: hErr } = await supabase
    .from('price_history')
    .select('product_id, mall, price, title')
    .eq('recorded_date', TODAY);
  if (hErr) { console.error('price_history 조회 오류:', hErr.message); process.exit(1); }
  console.log('[오늘 price_history 행 수]', todayRows.length);

  // 3. 수집률
  const pct = total > 0 ? (todayRows.length / total * 100).toFixed(1) : 0;
  console.log('[수집률]', pct + '%  (' + todayRows.length + '/' + total + ')');

  const covered = new Set(todayRows.map(r => r.product_id + '|' + r.mall));

  // 4. products 전체 조회 (페이지네이션)
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('products')
      .select('product_id, mall, title, keyword')
      .order('product_id', { ascending: true })
      .range(from, from + 999);
    if (error) { console.error('products 전체 조회 오류:', error.message); break; }
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  const missing = all.filter(p => !covered.has(p.product_id + '|' + p.mall));

  // 5. 키워드별 분포
  const kwStat = {};
  all.forEach(p => {
    const k = p.keyword || '(없음)';
    if (!kwStat[k]) kwStat[k] = { total: 0, missing: 0 };
    kwStat[k].total++;
  });
  missing.forEach(p => {
    const k = p.keyword || '(없음)';
    if (!kwStat[k]) kwStat[k] = { total: 0, missing: 0 };
    kwStat[k].missing++;
  });

  console.log('\n[키워드별 수집 현황]');
  const sorted = Object.entries(kwStat).sort((a, b) => b[1].missing - a[1].missing);
  sorted.forEach(([k, s]) => {
    const rate = ((s.total - s.missing) / s.total * 100).toFixed(0);
    const flag = s.missing > 0 ? ' ← 미수집 ' + s.missing : ' ✓';
    console.log('  ' + k.slice(0, 18).padEnd(20) + s.total.toString().padStart(4) + '개  수집 '
      + (s.total - s.missing).toString().padStart(4) + '개 (' + rate.padStart(3) + '%)' + flag);
  });

  // 6. 미수집 목록
  console.log('\n[미수집 상품 목록]', missing.length + '개');
  if (missing.length === 0) {
    console.log('  없음 — 100% 수집 완료!');
  } else {
    // 몰별 분류
    const byMall = {};
    missing.forEach(p => {
      if (!byMall[p.mall]) byMall[p.mall] = [];
      byMall[p.mall].push(p);
    });
    Object.entries(byMall).forEach(([mall, list]) => {
      console.log('\n  [' + mall + '] ' + list.length + '개:');
      list.slice(0, 20).forEach(p =>
        console.log('    kw=' + (p.keyword || '없음').slice(0, 10).padEnd(12)
          + '| ' + p.product_id.padEnd(16) + '| ' + p.title.slice(0, 45))
      );
      if (list.length > 20) console.log('    ... 외 ' + (list.length - 20) + '개');
    });

    // 실패 원인 추정
    console.log('\n[실패 원인 추정]');
    const noKw = missing.filter(p => !p.keyword);
    const hasKw = missing.filter(p => p.keyword);
    if (noKw.length) console.log('  keyword 없는 상품:', noKw.length + '개 (fallback 검색에서도 product_id 불일치)');
    if (hasKw.length) console.log('  keyword 있지만 미수집:', hasKw.length + '개 (API 결과 300건 초과 또는 상품 삭제/품절)');
  }

  // 7. price_history 최근 날짜 분포 (데이터 축적 현황)
  const { data: dateDist } = await supabase
    .from('price_history')
    .select('recorded_date')
    .order('recorded_date', { ascending: false })
    .limit(2000);

  if (dateDist) {
    const dateCount = {};
    dateDist.forEach(r => { dateCount[r.recorded_date] = (dateCount[r.recorded_date] || 0) + 1; });
    console.log('\n[최근 수집 이력 (날짜별 행 수)]');
    Object.entries(dateCount).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 7).forEach(([d, n]) => {
      const bar = '█'.repeat(Math.round(n / Math.max(...Object.values(dateCount)) * 20));
      console.log('  ' + d + '  ' + n.toString().padStart(5) + '행  ' + bar);
    });
  }

  console.log('\n' + '='.repeat(55));
}

verify().catch(e => { console.error('오류:', e.message); process.exit(1); });
