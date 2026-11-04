'use strict';

// Read-only catalog search. The storefront's existing DB adapter selects Supabase or Neon.
// No upsert, price-history mutation, or legacy recommendation decision code is used.
const safeTerm = value => String(value || '').normalize('NFKC')
  .replace(/[^0-9a-zA-Z가-힣\s-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);

async function searchCatalog(query, { db, liveSearch, mapRow } = {}) {
  const term = safeTerm(query);
  if (!term) return [];
  const source = db || require('./_supabase');
  const select = async (column, comparator) => {
    const builder = source.from('products').select('*');
    const response = await (comparator === 'eq'
      ? builder.eq(column, term).limit(40)
      : builder.ilike(column, '%' + term + '%').limit(40));
    if (response.error) throw new Error('Catalog read failed');
    return Array.isArray(response.data) ? response.data : [];
  };
  // Keep DB-first retrieval bounded. A product title query takes priority,
  // followed by indexed collection keyword when titles don't contain the query.
  let rows = await select('title', 'ilike');
  if (!rows.length) rows = await select('keyword', 'eq');
  if (rows.length) return rows.map(row => {
    const mapper = mapRow || require('./_shop').toClientProduct;
    const out = mapper(row);
    return { ...out, category: row.keyword || '', _source: 'db', shippingFee: null };
  });
  if (typeof liveSearch !== 'function') return [];
  const result = await liveSearch(term);
  if (!result || result.failed) throw new Error('Product search provider unavailable');
  return Array.isArray(result.items) ? result.items : [];
}
module.exports = { searchCatalog, safeTerm };
