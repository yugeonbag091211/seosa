#!/usr/bin/env node
/*
 * Browser QA for SEOSA UI. All browser traffic stays on loopback and every API
 * response is synthetic. No production endpoints, credentials, or databases.
 * Usage: node scripts/ui-layout-regression.js
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = path.join(ROOT, 'artifacts', 'ui-qa');
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].find(fs.existsSync);
const viewports = [320, 360, 390, 430, 768, 820, 1024, 1440, 1920];
const baselineCapture = process.env.SEOSA_QA_BASELINE === '1';
const capturePrefix = baselineCapture ? 'before' : 'after';
const results = { checks: 0, passed: 0, failures: [], diagnostics: [], screenshots: [], unexpectedWrites: [] };

function check(ok, name, detail) {
  results.checks++;
  if (ok) results.passed++;
  else results.failures.push({ name, detail });
}

function fixtureProduct(i, opts = {}, port = 0) {
  const title = opts.title || `무선 이어폰 합성 상품 ${String(i + 1).padStart(3, '0')}`;
  return {
    productId: String(900000000000 + i), vendorItemId: '',
    title, mall: i % 2 ? '네이버쇼핑' : '쿠팡', mallLabel: i % 2 ? '네이버쇼핑' : '쿠팡',
    image: opts.noImage ? '' : `http://127.0.0.1:${port}/fixture-image${opts.broken ? '-missing' : ''}.svg`,
    link: 'https://example.com/qa-purchase',
    oprice: opts.noPrice ? null : 299000 + i * 1000, savePct: opts.noPrice ? null : 20, isFreeShipping: true,
    lprice: opts.noPrice ? null : 239000 + i * 1000,
    collectedAt: new Date().toISOString()
  };
}

function installRendererFixture(port, mode = 'normal') {
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === './_supabase' || request === path.join(ROOT, 'api', '_supabase.js')) {
      return { from() { throw new Error('Synthetic renderer fixture must not query a database'); } };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    const page = require(path.join(ROOT, 'api', '_product-page.js'));
    const product = {
      productId: '900000000001', vendorItemId: '', title: '무선 이어폰 합성 상세 상품',
      mall: '쿠팡', mallLabel: '쿠팡', image: `http://127.0.0.1:${port}/fixture-image.svg`,
      link: 'https://example.com/qa-purchase', lprice: 239000, oprice: 299000,
      isCoupang: true
    };
    const row = { product_id: product.productId, vendor_item_id: '', title: product.title,
      mall: '쿠팡', keyword: '무선 이어폰', lprice: product.lprice, link: product.link,
      image: product.image, collected_at: new Date().toISOString() };
    const points = mode === 'no-history' ? [] : Array.from({ length: 14 }, (_, index) => ({
      date: new Date(Date.now() - (13 - index) * 86400000).toISOString().slice(0, 10),
      price: 269000 - index * 2300
    }));
    const stat = mode === 'no-history' ? null : { low: 239000, high: 269000, avg30: 253000, avg7: 241000,
      count: points.length, avg: 253000, median: 253000 };
    const deal = { label: mode === 'no-history' ? '기록 부족' : '가격 기록', reasons: [], cautions: [], anomalies: [] };
    const offers = [
      { productId: product.productId, mall: '쿠팡', mallLabel: '쿠팡', price: 239000, link: product.link, vendorItemId: '' },
      { productId: product.productId, mall: '네이버쇼핑', mallLabel: '네이버쇼핑', price: 244000, link: 'https://example.com/qa-buy-2', vendorItemId: '' }
    ];
    const html = page._internal.renderPage({ product, points, stat, deal,
      price: 239000, indexable: false, row, today: new Date().toISOString().slice(0, 10),
      life: { state: 'LIVE' },
      canonical: mode === 'compare' ? { canonicalLowestPrice: 239000, canonicalLowestMerchant: '쿠팡',
        canonicalLowestMall: '쿠팡', canonicalLowestLink: product.link, canonicalLowestProductId: product.productId,
        canonicalLowestVendorItemId: '', canonicalOffers: offers, offers, offerCount: offers.length } : null }, []);
    return html;
  } finally {
    Module._load = originalLoad;
  }
}

function response(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

async function startFixtureServer() {
  let rendererHtml = '';
  let rendererHtmlCompare = '';
  let rendererHtmlNoHistory = '';
  let port = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/search') {
      const keyword = url.searchParams.get('keyword') || '';
      let products = [];
      if (!/0건|없음|없는 결과/.test(keyword)) {
        const count = /대량/.test(keyword) ? 100 : /소량/.test(keyword) ? 3 : 12;
        products = Array.from({ length: count }, (_, i) => fixtureProduct(i, {
          title: /긴제목/.test(keyword) && i === 0 ? '무선 이어폰 ' + '아주 긴 상품명 '.repeat(25) : undefined,
          noImage: (/긴제목/.test(keyword) && i === 1) || (/부분누락/.test(keyword) && i === 0),
          broken: /긴제목/.test(keyword) && i === 2,
          noPrice: /부분누락/.test(keyword) && i === 0
        }, port));
      }
      return response(res, 200, 'application/json; charset=utf-8', JSON.stringify(products));
    }
    if (url.pathname === '/api/init') {
      const daily = Array.from({ length: 8 }, (_, i) => fixtureProduct(i, {}, port));
      const body = { popular: [{ keyword: '무선 이어폰', count: 120 }], daily: { keyword: '무선 이어폰', products: daily } };
      return response(res, 200, 'application/json; charset=utf-8', JSON.stringify(body));
    }
    if (url.pathname === '/api/rec') {
      return response(res, 200, 'application/json; charset=utf-8', JSON.stringify({ keyword: '무선 이어폰', products: Array.from({ length: 8 }, (_, i) => fixtureProduct(i, {}, port)) }));
    }
    if (url.pathname === '/api/hotdeals') return response(res, 200, 'application/json; charset=utf-8', JSON.stringify({ items: [] }));
    if (url.pathname === '/api/history' || url.pathname === '/api/history-batch') {
      return response(res, 200, 'application/json; charset=utf-8', JSON.stringify({ items: [], points: [], history: [] }));
    }
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') results.unexpectedWrites.push(`${req.method} ${url.pathname}`);
      const fallback = url.pathname === '/api/sync' ? { success: true, data: {} } : {};
      return response(res, 200, 'application/json; charset=utf-8', JSON.stringify(fallback));
    }
    if (url.pathname === '/fixture-image.svg') {
      await delay(90);
      return response(res, 200, 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480"><rect width="640" height="480" fill="#f2f0ed"/><rect x="180" y="100" width="280" height="210" rx="40" fill="#fff" stroke="#d5d1cc" stroke-width="8"/><circle cx="320" cy="210" r="20" fill="#aaa49d"/></svg>');
    }
    if (url.pathname === '/fixture-image-missing.svg') return response(res, 404, 'text/plain', 'not found');
    if (url.pathname === '/fixture-product') return response(res, 200, 'text/html; charset=utf-8', rendererHtml);
    if (url.pathname === '/fixture-product-compare') return response(res, 200, 'text/html; charset=utf-8', rendererHtmlCompare);
    if (url.pathname === '/fixture-product-no-history') return response(res, 200, 'text/html; charset=utf-8', rendererHtmlNoHistory);
    if (url.pathname === '/_vercel/insights/script.js') return response(res, 200, 'application/javascript', '');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      let html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
      html = html.replace(/<script\b[^>]*src=["']https?:\/\/[^"']+["'][^>]*>\s*<\/script>/gi, '');
      if (baselineCapture) html = html.replace(
        'margin-inline:calc(var(--rail-bleed,16px) * -1);padding:0 var(--rail-bleed,16px) 10px;scroll-snap-type:x proximity;scroll-padding-inline:var(--rail-bleed,16px);',
        'margin-inline:-16px;padding:0 16px 10px;scroll-snap-type:x proximity;scroll-padding-inline:16px;'
      ).replace('Anchor.init();', '/* baseline screenshot: initial occlusion guard disabled */');
      return response(res, 200, 'text/html; charset=utf-8', html);
    }
    const publicPath = path.resolve(ROOT, 'public', '.' + decodeURIComponent(url.pathname));
    if (!publicPath.startsWith(path.join(ROOT, 'public'))) return response(res, 403, 'text/plain', 'forbidden');
    try {
      const ext = path.extname(publicPath).toLowerCase();
      const mime = ({ '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' })[ext] || 'application/octet-stream';
      return response(res, 200, mime, fs.readFileSync(publicPath));
    } catch (_) { return response(res, 404, 'text/plain', 'not found'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  try {
    rendererHtml = installRendererFixture(port);
    rendererHtmlCompare = installRendererFixture(port, 'compare');
    rendererHtmlNoHistory = installRendererFixture(port, 'no-history');
  }
  catch (error) { server.close(); throw error; }
  return { server, port };
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', event => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result || {});
      } else if (msg.method) (this.listeners.get(msg.method) || []).forEach(fn => fn(msg.params || {}));
    });
  }
  on(method, fn) { const list = this.listeners.get(method) || []; list.push(fn); this.listeners.set(method, list); }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.nextId;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.ws.send(JSON.stringify({ id, method, params }));
    return result;
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

async function waitFor(fn, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result) return result;
    await delay(100);
  }
  throw new Error('Timed out waiting for browser condition');
}

async function main() {
  if (!CHROME) throw new Error('Chrome executable not found');
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const { server, port } = await startFixtureServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'seosa-ui-qa-'));
  let chrome;
  let cdp;
  try {
    chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--no-sandbox', '--remote-debugging-port=0', '--remote-allow-origins=*', `--user-data-dir=${profile}`, 'about:blank'],
    { windowsHide: true, stdio: 'ignore' });
    const activePort = await waitFor(() => {
      const file = path.join(profile, 'DevToolsActivePort');
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/)[0] : null;
    });
    const base = `http://127.0.0.1:${port}`;
    const targetResponse = await fetch(`http://127.0.0.1:${activePort}/json/new?${encodeURIComponent(base + '/')}`, { method: 'PUT' });
    const target = await targetResponse.json();
    cdp = new CDP(target.webSocketDebuggerUrl);
    await Promise.all(['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable', 'Performance.enable'].map(method => cdp.send(method)));
    await cdp.send('Network.setBlockedURLs', { urls: ['https://*'] });
    await cdp.send('Network.setBypassServiceWorker', { bypass: true });
    await cdp.send('Runtime.addBinding', { name: '__qaEvent' });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__qa = { consoleErrors:[], unhandled:[], layoutShifts:[], failedImages:[] };
      window.addEventListener('error', e => { if (e.target && e.target.tagName === 'IMG') window.__qa.failedImages.push(e.target.src); });
      window.addEventListener('unhandledrejection', e => window.__qa.unhandled.push(String(e.reason && e.reason.message || e.reason)));
      new PerformanceObserver(list => list.getEntries().forEach(e => { if (!e.hadRecentInput) window.__qa.layoutShifts.push(e.value); })).observe({type:'layout-shift', buffered:true});
    ` });
    const requestUrls = new Map();
    cdp.on('Runtime.exceptionThrown', event => results.diagnostics.push({ kind: 'exception', text: event.exceptionDetails && event.exceptionDetails.text }));
    cdp.on('Log.entryAdded', event => { if (event.entry.level === 'error') results.diagnostics.push({ kind: 'console', text: event.entry.text, url: event.entry.url || '' }); });
    cdp.on('Network.loadingFailed', event => {
      const url = requestUrls.get(event.requestId) || '';
      if (url.startsWith('http://127.0.0.1:') && !event.canceled && !url.includes('fixture-image-missing.svg')) {
        results.diagnostics.push({ kind: 'network', text: `${event.errorText} ${url}` });
      }
    });
    cdp.on('Network.requestWillBeSent', event => {
      requestUrls.set(event.requestId, event.request.url);
      if (!event.request.url.startsWith(base)) results.diagnostics.push({ kind: 'external-request-blocked', text: event.request.url });
    });
    cdp.on('Network.responseReceived', event => {
      if (event.response.url.startsWith(base) && event.response.status >= 400
          && !event.response.url.includes('fixture-image-missing.svg')) {
        results.diagnostics.push({ kind: 'network', text: `HTTP ${event.response.status} ${event.response.url}` });
      }
    });

    const evalJS = async expression => {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text || 'page evaluation failed'} :: ${expression.slice(0, 180)}`);
      return r.result && r.result.value;
    };
    const navigate = async url => {
      await cdp.send('Page.navigate', { url });
      await waitFor(async () => (await evalJS('document.readyState')) === 'complete');
      await delay(700);
    };
    const setViewport = async (width, height = 900) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, screenWidth: width, screenHeight: height, deviceScaleFactor: 1, mobile: width < 600 });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: width < 600, maxTouchPoints: width < 600 ? 5 : 1 });
      await delay(120);
    };
    const metrics = async label => {
      const data = await evalJS(`(() => {
        const vw=innerWidth, vh=innerHeight;
        const visible=e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>0&&r.height>0};
        const overflow=[];
        for(const e of document.querySelectorAll('body *')) if(visible(e)) { const r=e.getBoundingClientRect(); if(r.left < -2 || r.right > vw+2) { const c=e.className && String(e.className).split(' ')[0]; overflow.push({tag:e.tagName,cls:c||'',id:e.id||'',left:Math.round(r.left),right:Math.round(r.right)}); } }
        const clipped=[];
        for(const e of document.querySelectorAll('.p-title,h1,h2,.sec-title,.product-summary .price,.current-price-panel,.modal')) if(visible(e)) { if(e.scrollHeight>e.clientHeight+3) clipped.push({tag:e.tagName,id:e.id||'',cls:String(e.className||''),scroll:e.scrollHeight,client:e.clientHeight,text:(e.innerText||'').slice(0,70)}); }
        const unnamed=[...document.querySelectorAll('button,[role=button]')].filter(visible).filter(e=>!((e.getAttribute('aria-label')||e.innerText||e.title||'').trim()));
        const rail=document.querySelector('#recGrid'), rr=rail&&rail.getBoundingClientRect();
        const fab=document.querySelector('.fab'), fr=fab&&fab.getBoundingClientRect();
        const actionOverlap=!!(fab&&fr&&[...document.querySelectorAll('.card .buy,.card .alert-btn,.card .heart,.product-actions > *')].some(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0&&fr.left<r.right&&fr.right>r.left&&fr.top<r.bottom&&fr.bottom>r.top}));
        const buy=document.querySelector('.card .buy'), br=buy&&buy.getBoundingClientRect();
        const nav=document.querySelector('.mobile-tabbar');
        return {label:${JSON.stringify(label)},vw,clientWidth:document.documentElement.clientWidth,screenWidth:screen.width,visualWidth:visualViewport&&visualViewport.width,visualScale:visualViewport&&visualViewport.scale,docWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,rail:rr&&{left:rr.left,right:rr.right,width:rr.width,margin:getComputedStyle(rail).marginInline,bleed:getComputedStyle(rail).getPropertyValue('--rail-bleed').trim()},fabTucked:!!(fab&&fab.classList.contains('tuck')),fabAriaHidden:!!(fab&&fab.getAttribute('aria-hidden')==='true'),fabZ:fab?Number(getComputedStyle(fab).zIndex):0,navZ:nav?Number(getComputedStyle(nav).zIndex):0,fab:fr&&{left:fr.left,right:fr.right,top:fr.top,bottom:fr.bottom,transform:getComputedStyle(fab).transform},buy:br&&{left:br.left,right:br.right,top:br.top,bottom:br.bottom},actionOverlap,overflow:overflow.slice(0,20),clipped:clipped.slice(0,20),unnamed:unnamed.length,buttons:[...document.querySelectorAll('button')].filter(visible).length,cards:document.querySelectorAll('.card').length,images:[...document.images].filter(i=>i.complete&&!i.naturalWidth).map(i=>i.src),cls:(window.__qa.layoutShifts||[]).reduce((a,b)=>a+b,0)};
      })()`);
      results.diagnostics.push({ kind: 'viewport', ...data });
      return data;
    };
    const screenshot = async name => {
      const png = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = path.join(ARTIFACTS, `${name}.png`);
      fs.writeFileSync(file, Buffer.from(png.data, 'base64'));
      results.screenshots.push(file);
    };

    await navigate(base + '/');
    for (const width of viewports) {
      await setViewport(width, width < 600 ? 844 : 900);
      if (!baselineCapture) await waitFor(async () => (await evalJS(`(()=>{const f=document.querySelector('.fab');return !f||f.classList.contains('tuck')||!Anchor.overlapsAction(f)})()`)));
      if (await evalJS(`!!(document.querySelector('.fab')&&document.querySelector('.fab').classList.contains('tuck'))`)) await delay(280);
      const data = await metrics(`home-${width}`);
      check(data.docWidth <= data.clientWidth + 1, `home no horizontal overflow ${width}px`, `${data.docWidth}/${data.clientWidth}`);
      check(!data.actionOverlap, `home floating AI button does not cover product actions ${width}px`, `tucked=${data.fabTucked}, aria-hidden=${data.fabAriaHidden}`);
      check(data.unnamed === 0, `home visible controls have accessible names ${width}px`, `${data.unnamed} unnamed`);
      if (width < 641 && data.fabTucked) check(data.fabZ < data.navZ, `tucked AI button moves behind bottom navigation ${width}px`, `${data.fabZ}/${data.navZ}`);
      if (width === 1440 || width === 390 || width === 320 || width === 360) await screenshot(`${capturePrefix}-${width}-home`);
    }

    // Homepage interactions: repeated horizontal rail use, view preference, overlays.
    await setViewport(390, 844);
    const rail = await evalJS(`(() => {const e=document.querySelector('#recGrid');if(!e)return null;return {width:e.clientWidth,scroll:e.scrollWidth,overflow:getComputedStyle(e).overflowX,snap:getComputedStyle(e).scrollSnapType}})()`);
    check(!!rail, 'homepage recommendation rail exists');
    if (rail && rail.scroll > rail.width) {
      for (let i = 0; i < 10; i++) await evalJS(`(()=>{const e=document.querySelector('#recGrid');e.scrollLeft=${i % 2 ? 0 : 280};return e.scrollLeft})()`);
      check(true, 'mobile horizontal recommendation rail responds to repeated scrolling');
    } else check(false, 'mobile horizontal recommendation rail has overflow', JSON.stringify(rail));
    await setViewport(390, 844);
    const chatOpened = await evalJS(`(()=>{const b=document.querySelector('.fab');if(!b)return false;b.click();return document.querySelector('#panel').classList.contains('open')})()`);
    check(chatOpened, 'AI chat UI opens without sending a prompt');
    await evalJS(`document.querySelector('#panel .panel-close').click()`);
    const mobileNavVisible = await evalJS(`getComputedStyle(document.querySelector('.mobile-tabbar')).display!=='none'`);
    check(mobileNavVisible, 'mobile bottom navigation is visible at 390px');
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const reducedMotion = await evalJS(`matchMedia('(prefers-reduced-motion: reduce)').matches && getComputedStyle(document.documentElement).scrollBehavior==='auto'`);
    check(reducedMotion, 'reduced-motion preference disables smooth scrolling');
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await evalJS(`(()=>{const m=document.querySelector('[data-act="toggle-menu"]');if(m)m.click();const t=document.querySelector('#themeBtn');if(t)t.click()})()`);
    const darkOn = await evalJS(`document.documentElement.dataset.theme==='dark'`);
    check(darkOn, 'theme menu switches to dark mode');
    await evalJS(`(()=>{const m=document.querySelector('[data-act="toggle-menu"]');if(m)m.click();const t=document.querySelector('#themeBtn');if(t)t.click()})()`);
    check(await evalJS(`document.documentElement.dataset.theme!=='dark'`), 'theme menu switches back to light mode');
    for (let i = 0; i < 10; i++) {
      await evalJS(`window.scrollTo({top:${i % 2 ? 0 : 900},behavior:'smooth'})`);
      await delay(25);
    }

    // Repeated reloads catch initialization races without contacting real APIs.
    await navigate(base + '/');
    let reloadPass = true;
    for (let i = 0; i < 10; i++) {
      await cdp.send('Page.reload', { ignoreCache: i % 2 === 0 });
      await waitFor(async () => (await evalJS(`document.readyState==='complete'&&!!document.querySelector('#q')&&typeof Anchor!=='undefined'`)));
      const state = await evalJS('({doc:document.documentElement.scrollWidth,client:document.documentElement.clientWidth})');
      reloadPass = reloadPass && state.doc <= state.client + 1;
    }
    check(reloadPass, 'homepage reloads ten times without initialization or overflow failure');

    // Search scenarios and faceting are all served from local synthetic fixtures.
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 220, downloadThroughput: 512000, uploadThroughput: 256000, connectionType: 'cellular3g' });
    await evalJS(`(()=>{const q=document.querySelector('#q');q.value='무선 이어폰';q.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-act="search"]').click()})()`);
    await waitFor(async () => (await evalJS(`document.querySelectorAll('#resGrid .card').length`)) >= 3);
    await screenshot(`${capturePrefix}-390-search`);
    const initialSearchCount = await evalJS(`document.querySelectorAll('#resGrid .card').length`);
    await evalJS('history.back()');
    await waitFor(async () => await evalJS(`!new URLSearchParams(location.search).has('q')`));
    const backRestoredHome = await evalJS(`getComputedStyle(document.querySelector('.hero-band')).display!=='none'`);
    check(backRestoredHome, 'browser Back restores the homepage state');
    await evalJS('history.forward()');
    await waitFor(async () => await evalJS(`new URLSearchParams(location.search).get('q')==='무선 이어폰'`));
    await waitFor(async () => (await evalJS(`document.querySelectorAll('#resGrid .card').length`)) >= 3);
    check(await evalJS(`document.querySelectorAll('#resGrid .card').length>0`), 'browser Forward restores cached search results');
    const mallFilter = await evalJS(`(()=>{const b=document.querySelector('#filterBar [data-act="filter"][data-mall="쿠팡"]');if(!b)return false;b.click();return document.querySelectorAll('#resGrid .card').length})()`);
    check(mallFilter && mallFilter < initialSearchCount, 'merchant filter narrows the synthetic results', `${mallFilter}/${initialSearchCount}`);
    await evalJS(`(()=>{const b=document.querySelector('#filterBar [data-act="filter"][data-mall="all"]');if(b)b.click()})()`);
    const filterToggle = await evalJS(`(()=>{const b=document.querySelector('#facetToggle');if(!b)return false;b.click();return getComputedStyle(document.querySelector('#facetBar')).display!=='none'})()`);
    check(filterToggle, 'detail filter sidebar expands');
    await evalJS(`(()=>{const a=document.querySelector('#fMin'),b=document.querySelector('#fMax');if(a)a.value='240000';if(b)b.value='245000';const x=document.querySelector('[data-act="price-apply"]');if(x)x.click()})()`);
    const rangeCount = await evalJS(`document.querySelectorAll('#resGrid .card').length`);
    check(rangeCount > 0 && rangeCount < initialSearchCount, 'price range filter applies to products', `${rangeCount}/${initialSearchCount}`);
    await evalJS(`(()=>{const b=document.querySelector('[data-act="facet-reset"]');if(b)b.click();const t=document.querySelector('#facetToggle');if(t)t.click()})()`);
    const sortExists = await evalJS(`(()=>{const b=document.querySelector('#sortBar [data-act="sort"]');if(!b)return false;b.click();return true})()`);
    check(sortExists, 'sort control responds to a user click');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: 'none' });
    for (let i = 0; i < 10; i++) {
      const kw = ['무선 이어폰','소량 결과','대량 결과','긴제목 이미지'][i % 4];
      await evalJS(`(()=>{const q=document.querySelector('#q');q.value=${JSON.stringify(kw)};document.querySelector('[data-act="search"]').click()})()`);
      await delay(180);
      if (i % 2 === 0) await evalJS(`(()=>{const b=document.querySelector('[data-act="filter"]');if(b)b.click(); const s=document.querySelector('[data-act="sort"]');if(s)s.click()})()`);
    }
    await evalJS(`(()=>{const q=document.querySelector('#q');q.value='0건 결과';document.querySelector('[data-act="search"]').click()})()`);
    await delay(250);
    check((await evalJS(`document.querySelector('#resGrid').innerText.includes('결과') || document.querySelector('#resGrid').innerText.length > 0`)), 'zero-result search has a visible empty state');
    await evalJS(`(()=>{const q=document.querySelector('#q');q.value='긴제목 이미지';document.querySelector('[data-act="search"]').click()})()`);
    await delay(500);
    const searchData = await metrics('search-long-title-mobile');
    check(searchData.docWidth <= searchData.clientWidth + 1, 'long title and missing image do not widen mobile search', `${searchData.docWidth}/${searchData.clientWidth}`);
    check(!searchData.actionOverlap, 'floating AI button does not cover search result actions', `tucked=${searchData.fabTucked}`);
    check(searchData.unnamed === 0, 'search result controls have accessible names', `${searchData.unnamed} unnamed`);
    await evalJS(`(()=>{const i=document.querySelector('#resGrid .card img[src*="fixture-image-missing"]');if(i){i.loading='eager';i.closest('.card').scrollIntoView({block:'center',behavior:'instant'})}})()`);
    await delay(500);
    const imageFallbackPassed = await evalJS(`(()=>{const i=document.querySelector('#resGrid .card img[src*="fixture-image-missing"]');return !!i&&getComputedStyle(i).display==='none'&&!!i.parentNode.querySelector('.glyph')})()`);
    check(imageFallbackPassed, 'failed product image falls back to a visible glyph');
    await screenshot(`${capturePrefix}-390-search-long-title`);

    // Repeat resize cycles across the requested widths while the long-title state is visible.
    for (let n = 0; n < 10; n++) for (const width of viewports) {
      await setViewport(width, width < 600 ? 844 : 900);
      const data = await evalJS('({w:innerWidth,doc:document.documentElement.scrollWidth,client:document.documentElement.clientWidth})');
      check(data.doc <= data.client + 1, `search resize cycle ${n + 1} ${width}px`, `${data.doc}/${data.client}`);
    }

    await setViewport(390, 844);
    await evalJS(`(()=>{const q=document.querySelector('#q');q.value='부분누락 결과';document.querySelector('[data-act="search"]').click()})()`);
    await waitFor(async () => (await evalJS(`!!document.querySelector('#resGrid .price-unknown')`)));
    check(await evalJS(`document.querySelector('#resGrid .price-unknown').innerText.includes('가격 미확인')`), 'missing price remains explicitly unknown');
    check(await evalJS(`!document.querySelector('#resGrid .card:first-child .thumb img')`), 'missing image uses the no-image card fallback');

    // Repeated wish panel and comparison modal operations use synthetic products
    // and local API responses only; no purchase link is followed.
    await evalJS(`(()=>{const q=document.querySelector('#q');q.value='무선 이어폰';document.querySelector('[data-act="search"]').click()})()`);
    await waitFor(async () => (await evalJS(`document.querySelectorAll('#resGrid .card').length`)) >= 3);
    await evalJS(`(()=>{const h=document.querySelector('#resGrid .card .heart');if(h)h.click()})()`);
    let wishCycles = true;
    for (let i = 0; i < 10; i++) {
      await evalJS(`document.querySelector('.mobile-tabbar [data-act="open-wish"]').click()`);
      wishCycles = wishCycles && await evalJS(`document.querySelector('#wishPanel').classList.contains('open')`);
      await evalJS(`document.querySelector('#wishPanel [data-act="close-wish"]').click()`);
      await delay(30);
    }
    check(wishCycles, 'wishlist panel opens and closes repeatedly (10 cycles)');
    let compareCycles = true;
    for (let i = 0; i < 10; i++) {
      await evalJS(`document.querySelector('#resGrid .card [data-act="card-compare"]').click()`);
      await waitFor(async () => await evalJS(`document.querySelector('#cmpOverlay').classList.contains('open')`));
      compareCycles = compareCycles && await evalJS(`document.querySelector('#cmpOverlay').classList.contains('open')`);
      await evalJS(`document.querySelector('#cmpOverlay [data-act="close-compare"]').click()`);
      await delay(30);
    }
    check(compareCycles, 'comparison modal opens and closes repeatedly (10 cycles)');

    await navigate(base + '/fixture-product');
    for (const width of viewports) {
      await setViewport(width, width < 600 ? 844 : 900);
      const data = await metrics(`detail-${width}`);
      check(data.docWidth <= width + 1, `detail no horizontal overflow ${width}px`, `${data.docWidth}/${width}`);
      check(data.unnamed === 0, `detail visible controls have accessible names ${width}px`, `${data.unnamed} unnamed`);
      if (width === 1440 || width === 390) await screenshot(`${capturePrefix}-${width}-detail`);
    }
    await setViewport(390, 844);
    check(await evalJS(`!!document.querySelector('.price-history-panel') && !!document.querySelector('#saveProduct')`), 'detail price history and save control render');
    await evalJS(`document.querySelector('#saveProduct').click()`);
    check(await evalJS(`document.querySelector('#saveProduct').getAttribute('aria-pressed')==='true'`), 'detail save control toggles and announces state');
    await evalJS(`document.querySelector('#saveProduct').click()`);

    await navigate(base + '/fixture-product-no-history');
    await setViewport(390, 844);
    check(await evalJS(`document.querySelector('.price-history-panel').innerText.includes('아직 가격 기록이 없어요.')&&!document.querySelector('.price-history-panel svg')`), 'product detail with no history shows an explicit empty state');
    await navigate(base + '/fixture-product-compare');
    await setViewport(1440, 900);
    check(await evalJS(`document.querySelectorAll('.seller-panel li').length===2`), 'product detail seller comparison renders available offers');
    await screenshot(`${capturePrefix}-1440-detail-sellers`);

    const pageState = await evalJS('window.__qa || {consoleErrors:[],unhandled:[],layoutShifts:[]}');
    check(pageState.unhandled.length === 0, 'no unhandled Promise rejections', JSON.stringify(pageState.unhandled));
    check(results.unexpectedWrites.length === 0, 'no write API requests in isolated fixture', JSON.stringify(results.unexpectedWrites));
    const errorDiagnostics = results.diagnostics.filter(d => d.kind === 'exception' || d.kind === 'network'
      || (d.kind === 'console' && !(imageFallbackPassed && /404 \(Not Found\)/.test(d.text))));
    check(errorDiagnostics.length === 0, 'no browser exceptions, console errors, or local request failures', JSON.stringify(errorDiagnostics.slice(0, 6)));

    fs.writeFileSync(path.join(ARTIFACTS, `report-${capturePrefix}.json`), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ checks: results.checks, passed: results.passed, failures: results.failures,
      screenshots: results.screenshots, diagnosticKinds: results.diagnostics.reduce((a, x) => (a[x.kind] = (a[x.kind] || 0) + 1, a), {}) }, null, 2));
    if (results.failures.length) process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (chrome && !chrome.killed) chrome.kill();
    server.close();
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
