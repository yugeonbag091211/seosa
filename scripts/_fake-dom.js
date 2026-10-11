'use strict';
/*
 * public/index.html 의 메인 스크립트를 Node 에서 «실행» 하기 위한 최소 가짜 DOM.
 *
 * 문자열이 소스에 있는지만 보는 시험은 `if (false && …)` 처럼 기능을 죽여도
 * 통과한다(2026-10-04 독립 리뷰 지적). 그래서 스크립트 전체를 vm 에서 돌리고
 * 실제 객체(Fmt·Card·Drop·Actions·Search·Track …)와 실제 document 클릭 위임
 * 핸들러로 시험한다. 마지막 `Init.run();` 만 빼고 돌린다(네트워크로 홈을 그린다).
 *
 * 지원하는 선택자: tag, #id, .class, [attr], [attr="v"] 와 그 조합(공백 없는 복합).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function parseSimple(sel) {
  const s = String(sel).trim();
  const out = { tag: '', id: '', classes: [], attrs: [] };
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) out.tag = m[1].toLowerCase();
    else if (m[2]) out.id = m[2];
    else if (m[3]) out.classes.push(m[3]);
    else if (m[4]) out.attrs.push([m[4], m[5]]);
  }
  return out;
}
function dataKey(attr) { return attr.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }

class FakeEl {
  constructor(tag, props) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.id = '';
    this.className = '';
    this.dataset = {};
    this.attrs = {};
    this.style = {};
    this.children = [];
    this.parentElement = null;
    this.innerHTML = '';
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.listeners = {};
    const self = this;
    this.classList = {
      add(c) { const s = new Set(self.className.split(/\s+/).filter(Boolean)); s.add(c); self.className = [...s].join(' '); },
      remove(c) { self.className = self.className.split(/\s+/).filter(x => x && x !== c).join(' '); },
      contains(c) { return self.className.split(/\s+/).indexOf(c) > -1; },
      toggle(c, on) { if (on === undefined ? !this.contains(c) : on) this.add(c); else this.remove(c); }
    };
    Object.assign(this, props || {});
  }
  getAttribute(a) { if (a.indexOf('data-') === 0) return this.dataset[dataKey(a)] != null ? this.dataset[dataKey(a)] : null; return this.attrs[a] != null ? this.attrs[a] : null; }
  setAttribute(a, v) { if (a.indexOf('data-') === 0) this.dataset[dataKey(a)] = String(v); else this.attrs[a] = String(v); }
  hasAttribute(a) { return this.getAttribute(a) != null; }
  removeAttribute(a) { delete this.attrs[a]; }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  append() { [].slice.call(arguments).forEach(c => this.appendChild(c)); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(x => x !== this); }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener() {}
  focus() {} blur() {} scrollIntoView() {} click() {}
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; }
  matches(sel) {
    return String(sel).split(',').some(one => {
      const p = parseSimple(one);
      if (p.tag && this.tagName.toLowerCase() !== p.tag) return false;
      if (p.id && this.id !== p.id) return false;
      if (p.classes.some(c => !this.classList.contains(c))) return false;
      return p.attrs.every(([a, v]) => { const got = this.getAttribute(a); return got != null && (v === undefined || String(got) === v); });
    });
  }
  closest(sel) { let e = this; while (e) { if (e.matches && e.matches(sel)) return e; e = e.parentElement; } return null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = e => e.children.forEach(c => { if (c.matches(sel)) out.push(c); walk(c); });
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

/** HTML 문자열에서 첫 여는 태그의 data-* 속성만 읽어 요소를 만든다(Card.html 같은 렌더 결과 확인용). */
function elFromHtml(html) {
  const m = String(html).match(/^\s*<([a-zA-Z]+)([^>]*)>/);
  const el = new FakeEl(m ? m[1] : 'div');
  if (!m) return el;
  const re = /([\w-]+)="([^"]*)"/g; let a;
  const unesc = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  while ((a = re.exec(m[2]))) {
    if (a[1] === 'class') el.className = a[2];
    else if (a[1] === 'id') el.id = a[2];
    else el.setAttribute(a[1], unesc(a[2]));
  }
  return el;
}

function loadApp(opts) {
  const o = opts || {};
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*ld\+json)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const main = scripts.reduce((a, b) => (b.length > a.length ? b : a), '');
  const code = main.replace(/\n\s*Init\.run\(\);\s*$/, '\n');
  if (code === main) throw new Error('Init.run() 을 찾지 못했다 — 스크립트 끝이 바뀌었다');

  const byId = new Map();
  const bySel = new Map();
  const docListeners = {};
  const opened = [];
  const pings = [];
  const toasts = [];
  const storage = new Map();
  const document = {
    readyState: 'complete',
    documentElement: new FakeEl('html'),
    body: new FakeEl('body'),
    getElementById(id) { return byId.get(id) || null; },
    querySelector(sel) { return bySel.get(sel) || null; },
    querySelectorAll(sel) { const e = bySel.get(sel); return e ? [e] : []; },
    createElement(t) { return new FakeEl(t); },
    createElementNS(ns, t) { return new FakeEl(t); },
    addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
    removeEventListener() {},
    contains() { return true; },
    hidden: false
  };
  const ctx = {
    document,
    localStorage: { getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { search: '', pathname: '/', href: 'https://seosa.ai.kr/', origin: 'https://seosa.ai.kr', hash: '' },
    history: { pushState() {}, replaceState() {}, state: null },
    navigator: { userAgent: 'node', clipboard: null, share: null },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    getComputedStyle: () => ({}),
    requestAnimationFrame: fn => setTimeout(fn, 0),
    scrollTo() {},
    open(url) { opened.push(url); return null; },
    fetch: o.fetch || ((url) => { pings.push(String(url)); return new Promise(() => {}); }),
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, URL, URLSearchParams, Promise, Date, Math, JSON,
    encodeURIComponent, decodeURIComponent, isFinite, parseInt, parseFloat, Number, String, Array, Object, RegExp, Error, Map, Set,
    innerWidth: 390, innerHeight: 844, scrollY: 0, pageYOffset: 0
  };
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.addEventListener = () => {};
  ctx.removeEventListener = () => {};
  vm.createContext(ctx);
  // 최상위 var/function 은 컨텍스트 전역이 된다. 끝에서 꺼내 쓸 이름을 globalThis 에 걸어 둔다.
  vm.runInContext(code + '\n;globalThis.__app = { Fmt, CONST, Card, Drop, Actions, Search, Track, AppState, Modal, Chat, Wish, Compare, ExternalHot, Recent, productKey, sameProduct, openLink };', ctx, { filename: 'index.html#main' });

  const app = ctx.__app;
  /* 테스트 편의: 토스트를 기록한다 */
  ctx.toast = msg => toasts.push(String(msg));
  return {
    app, ctx, opened, pings, toasts, byId, bySel, FakeEl, elFromHtml,
    /** 실제 document 클릭 위임 핸들러로 «누른다» */
    click(el) {
      const ev = { target: el, preventDefault() {}, stopPropagation() {} };
      (docListeners.click || []).forEach(fn => fn(ev));
    },
    register(el, { id, sel } = {}) { if (id) { el.id = id; byId.set(id, el); } if (sel) bySel.set(sel, el); return el; }
  };
}

module.exports = { loadApp, FakeEl, elFromHtml };
