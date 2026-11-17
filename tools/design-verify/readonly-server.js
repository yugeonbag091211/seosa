// Real-data, read-only verification server.
// Serves a local public/ and forwards ONLY allow-listed read GETs to production (seosa.ai.kr).
// Everything that writes or calls paid APIs is blocked here, before any network call.
//   allowed: GET /api/init, /api/rec, /api/hotdeals, /api/history (no __route, or product/batch), /api/history-batch
//   /api/search -> rewritten to /api/rec?keyword=  (stored products only: no Coupang/ADPICK call, no DB save)
//   blocked: /api/stats (visit/search counters), /api/ai, /api/sync, /api/alerts, /api/auth, /api/payment, everything else
// Responses are cached on disk so reruns don't hit production again.
// usage: node tools/design-verify/readonly-server.js <publicDir> <port> <cacheDir>
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const [PUB, PORTS, CACHE] = process.argv.slice(2);
const PORT = Number(PORTS || 3180);
const ORIGIN = 'https://seosa.ai.kr';
fs.mkdirSync(CACHE, { recursive: true });
const LOG = path.join(CACHE, 'requests.log');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain' };
const log = s => fs.appendFileSync(LOG, new Date().toISOString() + ' ' + s + '\n');

function allowed(u, method) {
  if (method !== 'GET') return null;
  const p = u.pathname, q = u.searchParams;
  if (p === '/api/init' || p === '/api/rec' || p === '/api/history-batch') return p + u.search;
  if (p === '/api/hotdeals') return q.get('id') ? null : p + u.search;
  if (p === '/api/history') { const r = q.get('__route'); return (!r || r === 'product' || r === 'batch') ? p + u.search : null; }
  if (p === '/api/search') return '/api/rec?keyword=' + encodeURIComponent(q.get('keyword') || '');
  return null;
}
async function forward(target) {
  const key = crypto.createHash('sha1').update(target).digest('hex');
  const f = path.join(CACHE, key + '.json');
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const r = await fetch(ORIGIN + target, { headers: { 'User-Agent': 'seosa-design-readonly-check', Accept: 'application/json' } });
  const body = await r.text();
  const out = { status: r.status, body };
  if (r.ok) fs.writeFileSync(f, JSON.stringify(out));
  log('NET ' + r.status + ' ' + target);
  return out;
}
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) {
    const target = allowed(u, req.method);
    if (!target) { log('BLOCK ' + req.method + ' ' + u.pathname + u.search.slice(0, 80)); res.writeHead(u.pathname === '/api/stats' ? 204 : 503, { 'Content-Type': 'application/json' }); return res.end(u.pathname === '/api/stats' ? '' : '{"error":"read-only verification: blocked"}'); }
    try {
      const o = await forward(target);
      let body = o.body;
      if (u.pathname === '/api/search' && o.status === 200) { try { body = JSON.stringify(JSON.parse(body).products || []); } catch (e) {} }
      res.writeHead(o.status, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(body);
    } catch (e) { log('ERR ' + target + ' ' + e.message); res.writeHead(502); return res.end('{}'); }
  }
  if (u.pathname.startsWith('/_vercel/')) { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end(''); }
  let f = path.join(PUB, decodeURIComponent(u.pathname));
  if (u.pathname === '/' || !path.extname(f)) f = path.join(PUB, 'index.html');
  fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(b); });
}).listen(PORT, () => console.log('real-readonly on ' + PORT));
