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
const PAGE = 1000;        // products 조회 페이지 크기
const UPSERT_CHUNK = 500;

const isCoupangRow = p => p.mall === '쿠팡' || (p.link && p.link.includes('coupang'));

/** products 전체를 페이지 단위로 끝까지 읽는다 (한 번의 select는 행 수 상한에 걸린다). */
async function fetchAllProducts() {
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('products')
      .select('product_id, mall, title, keyword, link')
      .order('product_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error('products 조회 실패: ' + error.message);

    all.push(...(data || []));
    if (!data || data.length < PAGE) return all;
  }
}

async function run() {
  // 1. products 전체 조회
  const products = await fetchAllProducts();
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

  // price_history의 유니크 키가 (product_id, mall, recorded_date)라서
  // 같은 키가 두 번 들어가면 upsert가 청크째로 실패한다("cannot affect row a second time").
  // 같은 상품이 여러 키워드에 걸려 있으면 실제로 발생하므로 Map으로 모은다.
  const rowMap = new Map();
  const addRow = (target, price, link) => {
    const p = parseInt(price, 10) || 0;
    if (p <= 0) return;
    rowMap.set(`${target.product_id}|${target.mall}|${TODAY}`, {
      product_id: target.product_id,
      mall: target.mall,
      title: target.title,
      price: p,
      link: link || target.link || '',
      recorded_date: TODAY
    });
  };

  // 3. 키워드별 검색 → product_id 매칭
  const keywords = [...byKeyword.keys()];
  for (let i = 0; i < keywords.length; i += CONCURRENCY) {
    const batch = keywords.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async keyword => {
      const targets = byKeyword.get(keyword);

      // 네이버 결과는 네이버 상품에만, 쿠팡 결과는 쿠팡 상품에만 매칭해야 한다.
      // product_id만 보고 찾으면 몰이 다른 행에 엉뚱한 가격이 붙는다.
      const naverById   = new Map();
      const coupangById = new Map();
      targets.forEach(p => {
        (isCoupangRow(p) ? coupangById : naverById).set(p.product_id, p);
      });

      const [naver, coupang] = await Promise.all([
        fetchNaver(keyword, 20),
        fetchCoupang(keyword, 20)
      ]);

      (naver.items || []).forEach(item => {
        const target = naverById.get(item.productId);
        if (target) addRow(target, item.lprice, item.link);
      });
      (coupang.items || []).forEach(item => {
        const target = coupangById.get(item.productId);
        if (target) addRow(target, item.lprice, item.link);
      });

      const found = (naver.items || []).length + (coupang.items || []).length;
      console.log(`  [키워드] ${keyword}: ${found}개 조회`);
    }));
  }

  // 4. 키워드 없는 상품 — 상품명으로 검색
  for (let i = 0; i < noKeyword.length; i += CONCURRENCY) {
    const batch = noKeyword.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async p => {
      // 상품명 앞 4단어로 검색
      const q = p.title.split(/\s+/).slice(0, 4).join(' ');
      const result = isCoupangRow(p) ? await fetchCoupang(q, 20) : await fetchNaver(q, 20);
      const match = (result.items || []).find(it => it.productId === p.product_id);
      if (match) addRow(p, match.lprice, match.link);
    }));
    if (i % 50 === 0) console.log(`  [무키워드] ${i}/${noKeyword.length}`);
  }

  // 5. price_history upsert
  const rows = [...rowMap.values()];
  console.log(`\n${rows.length}개 가격 저장 중...`);
  let saved = 0;
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    const { error: e } = await supabase
      .from('price_history')
      .upsert(chunk, { onConflict: 'product_id,mall,recorded_date', ignoreDuplicates: false });
    if (e) console.error('저장 오류:', e.message);
    else saved += chunk.length;
  }

  console.log(`\n완료: ${saved}/${products.length}개 저장`);
}

run().catch(e => { console.error('오류:', e.message); process.exit(1); });
