// Headless Chrome via CDP (no puppeteer). Blocks analytics.
// usage: node shots.js <baseUrl> <outDir> <tag> [jobsJson]
// job: {name, w, h, path, full, eval (js run before shot), wait}
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [base, outDir, tag, jobsArg] = process.argv.slice(2);
const DEFAULT = [
  { name: 'home', w: 1440, h: 900, path: '/', full: true },
  { name: 'home', w: 390, h: 844, path: '/', full: true, mobile: true },
];
const jobs = jobsArg ? JSON.parse(fs.readFileSync(jobsArg, 'utf8')) : DEFAULT;
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const port = 9300 + Math.floor(Math.random() * 500);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'seosa-shots-'));
  const ch = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });
  let ver;
  for (let i = 0; i < 50; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (ver.length) break; } catch (e) {} await sleep(200); }
  const target = ver.find(t => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pend = new Map(); const events = [];
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } else if (d.method) events.push(d); };
  const send = (method, params) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  await send('Network.enable'); await send('Page.enable'); await send('Runtime.enable');
  await send('Network.setBlockedURLs', { urls: ['*googletagmanager*', '*google-analytics*', '*/_vercel/*', '*kakao*'] });
  const results = {};
  for (const j of jobs) {
    await send('Emulation.setDeviceMetricsOverride', { width: j.w, height: j.h, deviceScaleFactor: 1, mobile: !!j.mobile });
    if (j.dark !== undefined) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: j.dark ? 'dark' : 'light' }] });
    events.length = 0;
    await send('Page.navigate', { url: base + j.path });
    await sleep(j.wait || 3500);
    if (j.eval) { const r = await send('Runtime.evaluate', { expression: j.eval, awaitPromise: true, returnByValue: true }); results[j.name + '-' + j.w] = r.result && r.result.result && r.result.result.value; await sleep(j.after || 1200); }
    const errs = events.filter(e => e.method === 'Runtime.exceptionThrown').map(e => e.params.exceptionDetails.exception ? e.params.exceptionDetails.exception.description : e.params.exceptionDetails.text);
    if (errs.length) results[j.name + '-' + j.w + '-errors'] = errs.slice(0, 5);
    let clip;
    if (j.full) {
      const m = await send('Page.getLayoutMetrics');
      const cs = m.result.cssContentSize || m.result.contentSize;
      const hgt = Math.min(Math.ceil(cs.height), j.maxH || 9000);
      clip = { x: 0, y: 0, width: j.w, height: hgt, scale: 1 };
    }
    const shot = await send('Page.captureScreenshot', Object.assign({ format: 'png', captureBeyondViewport: !!j.full }, clip ? { clip } : {}));
    fs.writeFileSync(path.join(outDir, `${tag}-${j.name}-${j.w}.png`), Buffer.from(shot.result.data, 'base64'));
  }
  fs.writeFileSync(path.join(outDir, `${tag}-results.json`), JSON.stringify(results, null, 1));
  console.log(JSON.stringify(results, null, 1).slice(0, 3000));
  ws.close(); ch.kill();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
})().catch(e => { console.error(e); process.exit(1); });
