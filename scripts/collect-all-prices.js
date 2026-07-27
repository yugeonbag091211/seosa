#!/usr/bin/env node
/*
 * GitHub Actions에서 매일 실행 — products 전체 상품 가격 수집
 * node scripts/collect-all-prices.js
 */

require('dotenv').config({ quiet: true });
const supabase = require('../api/_supabase');
const { fetchNaver, fetchCoupang } = require('../api/_shop');

const TODAY = new Date().toISOString().slice(0, 10);
const CONCURRENCY = 5;

async function run() {
  // 1. products 전체 조회
  const { data: products, error } = await supabase
    .from('products')
    .select('product_id, mall, title, keyword, link');
  if (error) throw new Error('products 조회 실패: ' + error.message);

  console.log(`총 ${products.length}개 상품 가격 수집 시작 (${TODAY})`);

  // 2. keyword 기준으로 그룹화 (API 호출 횟수 최소화)
  const byKeyword = new Map();
  const noKeyword = [];
  products.forEach(p => {
    if (p.keyword) {
      if (!byKeyword.has(p.keyword)) byKeyword.set(p.keyword, []);
      byKeyword.get(p.keyword).push(p);
    } else {
      noKeyword.push(p);
    }
  });

  const rows = []; // price_history에 저장할 행들

  // 3. 키워드별 검색 → product_id 매칭
  const keywords = [...byKeyword.keys()];
  for (let i = 0; i < keywords.length; i += CONCURRENCY) {
    const batch = keywords.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async keyword => {
      const targets = byKeyword.get(keyword);
      const idSet = new Set(targets.map(p => p.product_id));

      const [naver, coupang] = await Promise.all([
        fetchNaver(keyword, 20),
        fetchCoupang(keyword, 20)
      ]);

      const all = [...(naver.items || []), ...(coupang.items || [])];
      all.forEach(item => {
        if (!idSet.has(item.productId)) return;
        const target = targets.find(p => p.product_id === item.productId);
        if (!target) return;
        rows.push({
          product_id: item.productId,
          mall: target.mall,
          title: target.title,
          price: parseInt(item.lprice) || 0,
          link: item.link || target.link || '',
          recorded_date: TODAY
        });
      });

      console.log(`  [키워드] ${keyword}: ${all.length}개 조회`);
    }));
  }

  // 4. 키워드 없는 상품 — 상품명으로 검색
  for (let i = 0; i < noKeyword.length; i += CONCURRENCY) {
    const batch = noKeyword.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async p => {
      // 상품명 앞 4단어로 검색
      const q = p.title.split(/\s+/).slice(0, 4).join(' ');
      const isCoupang = p.mall === '쿠팡' || (p.link && p.link.includes('coupang'));
      const result = isCoupang ? await fetchCoupang(q, 20) : await fetchNaver(q, 20);
      const items = result.items || [];
      const match = items.find(it => it.productId === p.product_id);
      if (match) {
        rows.push({
          product_id: p.product_id,
          mall: p.mall,
          title: p.title,
          price: parseInt(match.lprice) || 0,
          link: match.link || p.link || '',
          recorded_date: TODAY
        });
      }
    }));
    if (i % 50 === 0) console.log(`  [무키워드] ${i}/${noKeyword.length}`);
  }

  // 5. price_history upsert
  console.log(`\n${rows.length}개 가격 저장 중...`);
  let saved = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error: e } = await supabase
      .from('price_history')
      .upsert(chunk, { onConflict: 'product_id,mall,recorded_date', ignoreDuplicates: false });
    if (e) console.error('저장 오류:', e.message);
    else saved += chunk.length;
  }

  console.log(`\n완료: ${saved}/${products.length}개 저장`);
}

run().catch(e => { console.error('오류:', e.message); process.exit(1); });
