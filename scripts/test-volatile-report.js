'use strict';
const assert = require('assert');
const { confirmAppliedChanges } = require('./collect-volatile-prices');
const { totals, subjectFor, buildVolatileReportHtml, sendVolatileReport } = require('./_volatile-report');

const base = {
  day: '2026-10-26', slot: 'noon', status: 'completed', finishedAt: '2026-10-26 12:37 KST',
  usage: { '쿠팡': 3300, 'ADPICK': 2800 },
  caps: { '쿠팡': 3400, 'ADPICK': 3000 },
  results: {
    '쿠팡': { candidates: 100, spent: 6, checked: 12, saved: 10,
      changedApplied: 2, observedDifferences: 3, suspect: 1, rejected: 1, optionMiss: 1, cacheSkip: 0, failed: 1 },
    'ADPICK': { candidates: 70, spent: 4, checked: 8, saved: 8,
      changedApplied: 1, observedDifferences: 1, suspect: 0, rejected: 0, optionMiss: 0, cacheSkip: 1, failed: 0 }
  }
};
assert.strictEqual(totals(base.results).checked, 20);
assert.strictEqual(totals(base.results).changedApplied, 3);
assert.strictEqual(totals(base.results).spent, 10);
assert.match(subjectFor(base), /점심 가격 재확인 완료/);
assert.match(subjectFor(base), /실제 가격 변경 3건 \/ 확인 20건/);
const html = buildVolatileReportHtml(base);
assert.match(html, /3,306\s*\/\s*3,400/);
assert.match(html, /2,804\s*\/\s*3,000/);
assert.match(html, /현재 표시가가 이전과 달라진/);
assert.match(html, /이상 가격으로 현재가 반영 보류/);
const later = { ...base, slot: 'evening' };
assert.match(subjectFor(later), /저녁 가격 재확인 완료/);
assert.match(subjectFor({ ...base, status: 'skipped' }), /건너뜀$/);
assert.match(subjectFor({ ...base, status: 'failed' }), /실패$/);
const malicious = buildVolatileReportHtml({ ...base, reason: '<img src=x onerror=alert(1)>' });
assert(!malicious.includes('<img src=x onerror'));
assert(malicious.includes('&lt;img'));
(async () => {
  let sent = 0;
  const mock = async arg => {
    sent++;
    assert.strictEqual(arg.to, 'test@example.com');
    assert.match(arg.subject, /SEOSA/);
    assert(arg.html.includes('INTRADAY PRICE RECHECK'));
    return { ok: true, id: 'unit-test' };
  };
  const a = await sendVolatileReport(base, { to: 'test@example.com', send: mock });
  assert(a.ok);
  assert.strictEqual(sent, 1);
  const b = await sendVolatileReport(base, { to: 'test@example.com', send: async () => ({ ok: false, error: 'SMTP disabled' }) });
  assert.strictEqual(b.ok, false);
  // 메일의 '실제 가격 변경'은 관측과 별도로 DB 현재가 확인을 거쳐야 한다.
  let pages = 0;
  const fakeDb = {
    from(name) {
      assert.strictEqual(name, 'products');
      return {
        select(columns) {
          assert.match(columns, /lprice/);
          return {
            in(field, ids) {
              assert.strictEqual(field, 'product_id');
              pages++;
              return {
                async eq(key, mall) {
                  assert.strictEqual(key, 'mall');
                  assert.strictEqual(mall, '쿠팡');
                  return { data: ids.map(id => ({
                    product_id: id, mall: '쿠팡', lprice: id === 'held' ? 100 : 120
                  })), error: null };
                }
              };
            }
          };
        }
      };
    }
  };
  const differences = Array.from({length:75}, (_, i) =>
    ({productId:String(i),beforePrice:100,afterPrice:120}));
  differences.push({productId:'held',beforePrice:100,afterPrice:130});
  const changed = await confirmAppliedChanges(differences, '쿠팡', fakeDb);
  assert.strictEqual(changed, 75);
  assert.strictEqual(pages, 2);
  const wrongDb = { from: () => ({ select: () => ({ in: () => ({
    eq: async () => ({ data: null, error: { message: 'database unavailable' } })
  }) }) }) };
  await assert.rejects(confirmAppliedChanges(differences,'쿠팡',wrongDb), /재검증 실패/);
  assert.strictEqual(await confirmAppliedChanges([],'쿠팡',wrongDb), 0);
  console.log('Volatile price email report regression PASS');
})().catch(e => { console.error(e); process.exitCode=1; });
