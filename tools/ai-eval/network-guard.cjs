'use strict';
// Preloaded into the offline Promptfoo run (NODE_OPTIONS=--require ...):
// any connection that is not loopback / a local pipe is refused and recorded,
// so the report can PROVE that no question, product or result left the
// machine (telemetry, sharing, model calls, seller APIs).
const net = require('node:net');
const fs = require('node:fs');
const blocked = [];
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '']);
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const first = args[0];
  if (first && typeof first === 'object' && first.path) return originalConnect.apply(this, args); // pipe / unix socket
  const host = first && typeof first === 'object' ? String(first.host || first.hostname || '') : String(typeof args[1] === 'string' ? args[1] : '');
  if (!LOOPBACK.has(host)) {
    blocked.push(host);
    const socket = this;
    process.nextTick(() => socket.destroy(new Error('SEOSA offline guard: network blocked (' + host + ')')));
    return socket;
  }
  return originalConnect.apply(this, args);
};
const realFetch = globalThis.fetch;
globalThis.fetch = async function guardedFetch(input, init) {
  const url = String(input && input.url || input);
  if (/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/)/i.test(url)) return realFetch(input, init);
  blocked.push(url.replace(/[?#].*$/, ''));
  throw new TypeError('SEOSA offline guard: fetch blocked');
};
process.on('exit', () => {
  const out = process.env.SEOSA_GUARD_REPORT;
  if (!out) return;
  let prior = [];
  try { prior = JSON.parse(fs.readFileSync(out, 'utf8')).blocked || []; } catch {}
  try { fs.writeFileSync(out, JSON.stringify({ blocked: [...prior, ...blocked] })); } catch {}
});
