'use strict';
// AI v3.4 feedback loop: privacy-by-construction records, opt-in storage in
// an isolated schema (local PGlite here), and a human review queue that never
// changes code or data on its own. Includes fast-check privacy properties.
const assert = require('node:assert/strict');
const fc = require('fast-check');
const { feedbackSignal, buildFailureRecord, assertSafeRecord, recordFeedback, whitelistedTerms } = require('../api/_ai-v34-feedback');
const { propose } = require('./ai-v34/propose-lexicon');
const { openPglite, applyMigration } = require('./ai-v34/_targets');

const SECRET = 'test-secret-0123456789abcdef';
const state = { lastQuery: '로지텍 G304 무선 마우스 박지성 010-1234-5678', category: '마우스', brandTerm: '로지텍', maxPrice: 30000,
  exclusions: ['삼성'], features: { wireless: true }, modelText: 'G304' };
const stats = { chosen: 0, noResult: 'no_verified_match', rejectedReasons: { wrong_model: 3, over_budget: 2, secret_field: 9 } };
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }

(async () => {
  await test('only the KIND of feedback is read from the message', async () => {
    assert.equal(feedbackSignal('이거 말고 다른 거 보여줘'), 'reject');
    assert.equal(feedbackSignal('다른 제품도 추천해줘'), 'retry');
    assert.equal(feedbackSignal('그중 더 싼 거'), 'refine');
    assert.equal(feedbackSignal('가격이 달라요 잘못된 상품이에요'), 'report');
    assert.equal(feedbackSignal('노트북 추천해줘'), null);
  });
  await test('record keeps counters and whitelisted tokens, never free text, names, phone numbers or unknown keys', async () => {
    const rec = buildFailureRecord({ signal: 'reject', state, stats, strategy: 'hybrid', sessionId: 'user@example.com', secret: SECRET, now: Date.parse('2026-11-12T03:00:00Z') });
    const text = JSON.stringify(rec);
    assert(!/박지성|010|1234|example|@|무선 마우스/.test(text), text);
    assert.deepEqual(rec.rejectedReasons, { wrong_model: 3, over_budget: 2 });
    assert(rec.terms.includes('brand:로지텍') && rec.terms.includes('model:g304'));
    assert.deepEqual(rec.constraintKinds.sort(), ['brand', 'budget', 'exclusion', 'feature:wireless', 'model']);
    assert.equal(assertSafeRecord(rec), true);
  });
  await test('session key rotates daily and cannot be computed without the server secret', async () => {
    const a = buildFailureRecord({ signal: 'retry', state, stats, sessionId: 's1', secret: SECRET, now: Date.parse('2026-11-12T03:00:00Z') });
    const b = buildFailureRecord({ signal: 'retry', state, stats, sessionId: 's1', secret: SECRET, now: Date.parse('2026-11-13T03:00:00Z') });
    assert.notEqual(a.sessionHash, b.sessionHash);
    assert.throws(() => buildFailureRecord({ signal: 'retry', state, stats, sessionId: 's1', secret: 'short' }));
  });
  await test('fast-check: arbitrary user text never leaks into a record (300 runs, seed 20261140)', async () => {
    await fc.assert(fc.property(fc.string({ minLength: 3, maxLength: 60 }), fc.string({ minLength: 3, maxLength: 40 }), (free, sid) => {
      const rec = buildFailureRecord({ signal: 'reject', state: { ...state, lastQuery: free, brandTerm: free, modelText: free },
        stats, sessionId: sid, secret: SECRET });
      assertSafeRecord(rec);
      for (const t of rec.terms) assert(/^(?:brand|syn|model):[0-9a-z가-힣]{1,24}$/.test(t));
      // the raw string itself is never stored unless it IS a whitelisted token
      const raw = free.trim().toLowerCase();
      if (raw.length > 6 && /\s/.test(raw)) assert(!JSON.stringify(rec).includes(raw));
    }), { numRuns: 300, seed: 20261140 });
  });
  await test('storage is opt-in, refused in read-only mode, and works in the isolated schema', async () => {
    const pg = await openPglite();
    try {
      await applyMigration(pg);
      const rec = buildFailureRecord({ signal: 'reject', state, stats, sessionId: 's', secret: SECRET });
      assert.deepEqual(await recordFeedback(pg.query, rec, {}), { stored: false, reason: 'disabled' });
      assert.deepEqual(await recordFeedback(pg.query, rec, { AI_V34_FEEDBACK_ENABLED: '1', SEOSA_DB_READONLY: '1' }), { stored: false, reason: 'read_only' });
      assert.deepEqual(await recordFeedback(pg.query, rec, { AI_V34_FEEDBACK_ENABLED: '1' }), { stored: true });
      const rows = (await pg.query('select signal, category, terms, rejected_reasons from ai_v34.retrieval_feedback')).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].category, '마우스');
      await assert.rejects(() => recordFeedback(pg.query, { ...rec, note: '박지성 010-1234-5678' }, { AI_V34_FEEDBACK_ENABLED: '1' }));
    } finally { await pg.close(); }
  });
  await test('proposals need >=3 distinct sessions, stay pending until a human approves, and never apply themselves', async () => {
    const recs = ['a', 'b', 'c', 'd'].map(s => buildFailureRecord({ signal: 'retry', state, stats, sessionId: s, secret: SECRET }));
    const out = propose([...recs, { schema: 'x', note: 'free text' }], []);
    assert.equal(out.rejectedRecords, 1);
    assert.equal(out.proposals.length, 1);
    assert.equal(out.proposals[0].status, 'pending_review');
    assert.equal(out.proposals[0].distinctSessions, 4);
    const approved = propose(recs, [{ key: out.proposals[0].key, decision: 'approve' }]);
    assert.equal(approved.proposals[0].status, 'approve');
    assert(/never applied automatically/i.test(approved.policy));
    assert.deepEqual(propose(recs.slice(0, 2), []).proposals, []);
  });
  assert.deepEqual(whitelistedTerms('그냥 아무 말 0101234567'), []);
  console.log(JSON.stringify({ passed, failed: 0, propertyRuns: 300 }));
})().catch(e => { console.error(e.stack || e); process.exit(1); });
