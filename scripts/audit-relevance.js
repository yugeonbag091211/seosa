#!/usr/bin/env node
/*
 * products 에 저장된 상품이 자기 keyword 와 맞는지 점검한다.
 *
 *   node scripts/audit-relevance.js            ← 보고만 (기본, 아무것도 안 지운다)
 *   node scripts/audit-relevance.js --apply    ← 무관한 행을 실제로 삭제
 *
 * 노출 단계에서는 api/_shop.js 의 relevantRows() 가 이미 걸러내므로,
 * 이 스크립트를 돌리지 않아도 화면에는 이상한 상품이 나오지 않는다.
 * DB 자체를 정리하고 싶을 때만 --apply 를 쓴다.
 *
 * ※ --apply 는 되돌릴 수 없다. 먼저 인자 없이 실행해서 목록을 확인할 것.
 */
'use strict';

require('./_env');
const supabase = require('../api/_supabase');
// 노출 단계(api/_shop.relevantRows)와 같은 기준을 써야 이 보고서가 화면과 일치한다.
const { isRelevant, analyzeQuery } = require('../api/_search');

const PAGE = 1000;
const APPLY = process.argv.includes('--apply');

async function fetchAll() {
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('products')
      .select('id, product_id, mall, keyword, title, collected_at')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error('products 조회 실패: ' + error.message);
    all.push(...(data || []));
    if (!data || data.length < PAGE) return all;
  }
}

(async () => {
  const rows = await fetchAll();
  console.log(`\nproducts ${rows.length}행 점검\n`);

  const byKeyword = new Map();
  const bad = [];
  const analysisCache = new Map();   // 같은 keyword 를 여러 행이 공유한다

  rows.forEach(r => {
    const kw = r.keyword || '';
    const k = kw || '(없음)';
    if (!byKeyword.has(k)) byKeyword.set(k, { total: 0, bad: 0 });
    byKeyword.get(k).total++;
    if (!analysisCache.has(kw)) analysisCache.set(kw, analyzeQuery(kw));
    if (!isRelevant(kw, r.title, { analysis: analysisCache.get(kw) })) {
      byKeyword.get(k).bad++;
      bad.push(r);
    }
  });

  const sorted = [...byKeyword.entries()].sort((a, b) => b[1].bad - a[1].bad);
  console.log('키워드                 전체   무관   비율');
  console.log('─'.repeat(46));
  sorted.forEach(([k, s]) => {
    const pct = Math.round(s.bad / s.total * 100);
    const flag = pct >= 50 ? '  ← 대부분 무관' : pct > 0 ? '  ←' : '';
    console.log(
      k.slice(0, 20).padEnd(22)
      + String(s.total).padStart(5)
      + String(s.bad).padStart(7)
      + String(pct + '%').padStart(7)
      + flag
    );
  });

  console.log(`\n무관한 행 합계: ${bad.length}/${rows.length} (${Math.round(bad.length / rows.length * 100)}%)`);
  console.log('\n예시 (최대 15건):');
  bad.slice(0, 15).forEach(r =>
    console.log(`  [${String(r.keyword).slice(0, 12).padEnd(13)}] ${String(r.title).slice(0, 52)}`)
  );

  if (!bad.length) { console.log('\n정리할 것이 없습니다.'); return; }

  if (!APPLY) {
    console.log('\n보고만 했습니다. 실제로 지우려면 --apply 를 붙여 다시 실행하세요.');
    console.log('(노출은 이미 api/_shop.js 의 relevantRows() 가 막고 있어 급하지 않습니다)');
    return;
  }

  console.log(`\n--apply — ${bad.length}행을 삭제합니다...`);
  let deleted = 0;
  for (let i = 0; i < bad.length; i += 200) {
    const ids = bad.slice(i, i + 200).map(r => r.id);
    const { error } = await supabase.from('products').delete().in('id', ids);
    if (error) { console.error('  삭제 실패:', error.message.slice(0, 120)); break; }
    deleted += ids.length;
  }
  console.log(`삭제 완료: ${deleted}행`);
  console.log('※ price_history 의 해당 상품 기록은 그대로 둡니다 (가격 이력은 지우지 않습니다).');
})().catch(e => { console.error('오류:', e.message); process.exit(1); });
