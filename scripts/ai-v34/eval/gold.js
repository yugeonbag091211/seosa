'use strict';
// Gold sets for the v3.4 100-question set, computed ONLY from the frozen
// spec (questions-v34.js) + the frozen corpus snapshot + the oracle's spec
// matcher. No engine code is involved. Faults that change the corpus (db:stale)
// are applied by faultOverlay() exactly as the runner applies them.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { eligibleRow, specErrors } = require('./oracle');

function loadCorpus(file) {
  const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  return rows;
}
// db:stale — every row that matches the question's FIRST-turn spec (ignoring
// freshness) is aged to 40 days before asOf: «the only records are old».
function faultOverlay(question, rows, asOfMs) {
  const fault = question.fault || {};
  if (fault.db !== 'stale') return null;
  const spec = question.turns[0].spec;
  const stale = new Date(asOfMs - 40 * 86400000).toISOString();
  const keys = new Set();
  for (const r of rows) if (specErrors(spec, r.title, r.lprice).length === 0) keys.add(r.mall + ':' + r.product_id);
  return { keys, collected_at: stale };
}
function applyOverlay(row, overlay) {
  if (!overlay || !overlay.keys.has(row.mall + ':' + row.product_id)) return row;
  return { ...row, collected_at: overlay.collected_at };
}
function goldFor(spec, rows, asOfMs, maxAgeDays, overlay) {
  const hits = [];
  for (const raw of rows) {
    const r = applyOverlay(raw, overlay);
    if (eligibleRow(spec, r, asOfMs, maxAgeDays)) hits.push({ id: r.mall + ':' + r.product_id, price: Number(r.lprice) });
  }
  hits.sort((a, b) => a.price - b.price || a.id.localeCompare(b.id));
  return { count: hits.length, ids: hits.slice(0, 5000).map(h => h.id), truncated: hits.length > 5000 };
}
function computeGold(questions, rows, { asOf, maxAgeDays }) {
  const asOfMs = Date.parse(asOf);
  const out = {};
  for (const q of questions) {
    const overlay = faultOverlay(q, rows, asOfMs);
    out[q.id] = q.turns.map(t => {
      if (t.expect === 'DYNAMIC' || t.expect === 'NON_SHOPPING') return { dynamic: true };
      if (t.spec && t.spec.sides) return { sides: t.spec.sides.map(s => goldFor(s, rows, asOfMs, maxAgeDays, overlay)) };
      return goldFor(t.spec || {}, rows, asOfMs, maxAgeDays, overlay);
    });
  }
  return out;
}
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
module.exports = { loadCorpus, computeGold, faultOverlay, applyOverlay, goldFor, sha256 };
