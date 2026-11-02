'use strict';
/*
 * Playwright 로 운영 채팅 UI 를 실제로 쓴다. 입력창에 치고 «보내기» 를 누른 뒤,
 * 네트워크의 /api/ai 응답과 화면 말풍선을 함께 저장한다(서명 상태는 페이지가 스스로 이어 간다).
 *
 * 운영 통계를 오염시키지 않도록 /api/stats·분석 스크립트는 막고, 이미지도 받지 않는다.
 * 상품 링크는 누르지 않는다.
 */
const path = require('path');

async function launch() {
  const dir = process.env.PLAYWRIGHT_DIR;
  if (!dir) throw new Error('PLAYWRIGHT_DIR 환경변수에 playwright-core 설치 폴더가 필요하다');
  const { chromium } = require(path.join(dir, 'node_modules', 'playwright-core'));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const BASE = process.env.SEOSA_ORIGIN || 'https://seosa.ai.kr';
  let ctx = null, page = null, opened = false;

  async function open() {
    ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 SEOSA-QA-Production-5000/1.0' });
    await ctx.route('**/*', route => {
      const r = route.request();
      const u = r.url();
      if (r.resourceType() === 'image' || r.resourceType() === 'media') return route.abort();
      if (/\/api\/stats|\/_vercel\/(insights|speed)|google-analytics|googletagmanager|clarity\.ms/.test(u)) return route.abort();
      return route.continue();
    });
    page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('button.fab[data-act="ai-entry"]', { state: 'attached', timeout: 20000 });
    await page.evaluate(() => { const b = document.querySelector('button.fab[data-act="ai-entry"]'); b && b.click(); });
    await page.waitForSelector('#chatInput', { state: 'visible', timeout: 10000 });
    opened = true;
  }

  return {
    reset: async () => {
      if (ctx) await ctx.close().catch(() => {});
      ctx = null; page = null; opened = false;
      await open();
    },
    ask: async text => {
      if (!opened) await open();
      const t0 = Date.now();
      try {
        const bubblesBefore = await page.$$eval('#chat .msg, #chat .bubble, #chat > *', e => e.length);
        await page.fill('#chatInput', text);
        const waiter = page.waitForResponse(r => /\/api\/ai(\?|$)/.test(r.url()) && r.request().method() === 'POST', { timeout: 36000 });
        await page.click('#chatSendBtn');
        const resp = await waiter;
        const bodyText = await resp.text();
        let json = null; try { json = JSON.parse(bodyText); } catch (_) { /* 비 JSON */ }
        const ms = Date.now() - t0;
        await page.waitForFunction(n => document.querySelectorAll('#chat .msg, #chat .bubble, #chat > *').length > n + 1 && !document.querySelector('#chat .typing'), bubblesBefore, { timeout: 8000 }).catch(() => {});
        const dom = await page.evaluate(() => {
          const kids = Array.from(document.querySelectorAll('#chat > *'));
          const last = kids[kids.length - 1];
          return { text: last ? last.innerText.slice(0, 6000) : '', cards: last ? last.querySelectorAll('.mini-grid > *').length : 0 };
        });
        const h = resp.headers();
        return { status: resp.status(), ms, vercelId: h['x-vercel-id'] || '', retryAfter: h['retry-after'] || '', json, rawHead: json ? '' : bodyText.slice(0, 300), domText: dom.text, domCards: dom.cards };
      } catch (e) {
        return { status: 0, ms: Date.now() - t0, vercelId: '', error: 'ui: ' + String(e.message).slice(0, 180), json: null };
      }
    },
    close: async () => { if (ctx) await ctx.close().catch(() => {}); await browser.close(); }
  };
}
module.exports = { launch };
