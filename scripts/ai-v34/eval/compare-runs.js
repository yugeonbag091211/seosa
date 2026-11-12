'use strict';
// Side-by-side per-question comparison of offline runs (JSONL from run-offline.js).
//   node scripts/ai-v34/eval/compare-runs.js <a.jsonl> <b.jsonl> [<c.jsonl>] [--only-diff] [--causes]
const fs = require('node:fs');
const files = process.argv.slice(2).filter(x => !x.startsWith('--'));
const onlyDiff = process.argv.includes('--only-diff');
const showCauses = process.argv.includes('--causes');
const runs = files.map(f => new Map(fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)).map(r => [r.id, r])));
const ids = [...runs[0].keys()];
const short = v => ({ PASS: 'P', FAIL: 'F', UNVERIFIED: 'U', NEEDS_REVIEW: 'R' }[v] || '?');
for (const id of ids) {
  const rs = runs.map(m => m.get(id));
  const finals = rs.map(r => r ? r.verdict.final : '-');
  if (onlyDiff && finals.every(v => v === finals[0])) continue;
  const tag = rs.map(r => r ? short(r.verdict.final) + '(' + short(r.verdict.v34) + short(r.verdict.v2) + ')' : '-').join(' ');
  console.log(id, rs[0].type.padEnd(8), tag);
  if (showCauses) {
    rs.forEach((r, i) => {
      if (!r || r.verdict.final === 'PASS') return;
      for (const t of r.verdict.turns) {
        if (t.final === 'PASS') continue;
        const turn = r.turns[t.turn - 1];
        console.log('   [' + i + '] T' + t.turn + ' v34=' + t.v34.verdict + ' ' + t.v34.causes.slice(0, 4).join(',') + ' | v2=' + t.v2.verdict + ' ' + t.v2.causes.slice(0, 3).join(','));
        for (const c of (turn.cards || []).slice(0, 4)) console.log('       ' + c.price + ' ' + String(c.title).slice(0, 70) + (c.fresh ? ' [' + c.fresh + ' ' + c.ageDays + 'd]' : ''));
        if (!turn.cards || !turn.cards.length) console.log('       (no cards) ' + String(turn.answer || turn.error || '').slice(0, 90) + ' noResult=' + (turn.stats && turn.stats.noResult));
      }
    });
  }
}
