'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

for (const p of ['api/search.js','api/history.js','api/init.js','api/rec.js']) {
  const s=read(p);
  assert(s.includes("if (!applyCors(req, res, 'public')) return;"), p+' keeps public CORS/OPTIONS handling');
  assert(s.includes("if (req.method !== 'GET') return res.status(405)"), p+' rejects non-GET methods');
  assert(s.indexOf("applyCors(req, res, 'public')") < s.indexOf("req.method !== 'GET'"),
    p+' handles OPTIONS before GET guard');
}

const cron=read('api/cron.js');
assert(cron.includes("if (req.method !== 'GET') return res.status(405)"), 'cron rejects non-GET methods');
assert(cron.indexOf("req.headers.authorization") < cron.indexOf("req.method !== 'GET'"),
  'cron authenticates before method detail is exposed');


for (const p of ['api/alerts.js','api/auth.js','api/history.js','api/stats.js','api/sync.js']) {
  const s=read(p);
  assert(!s.includes("res.status(500).json({ error: e.message })"), p+' does not expose internal exception text');
}

const hot=read('api/hotdeals.js');
assert(hot.includes("if (req.method !== 'GET') return res.status(405)"), 'hotdeals remains GET-only');

console.log('PASS HTTP surface: public read APIs and cron reject unsupported methods');
