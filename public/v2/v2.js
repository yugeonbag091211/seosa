/*
 * SEOSA 2.0 화면 공용 도구 (빌드 없음, ES5).
 *
 * ★ 기존 index.html 의 전역을 쓰지 않는다. 같은 출처라 localStorage 는 공유되므로
 *   로그인 토큰('seosa_token')과 테마('seosa_theme')만 «읽어서» 이어받는다.
 * ★ 서버 문자열은 전부 esc() 를 거쳐 그린다 (판매자가 쓴 상품명이 들어온다).
 */
(function (global) {
  'use strict';

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function won(n) {
    if (n == null || !isFinite(n)) return '—';
    return Math.round(Number(n)).toLocaleString('ko-KR') + '원';
  }

  function pct(x, digits) {
    if (x == null || !isFinite(x)) return '—';
    return (Math.round(Number(x) * Math.pow(10, digits || 0)) / Math.pow(10, digits || 0)) + '%';
  }

  /** https 만, 그리고 스킴이 없는 값은 버린다 (javascript: 등 차단). */
  function safeUrl(u) {
    var s = String(u || '').trim();
    return /^https:\/\//i.test(s) ? s : '';
  }

  function readJSON(key, dflt) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : dflt; } catch (e) { return dflt; }
  }
  function writeJSON(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* 저장 불가 — 화면은 계속 */ }
  }

  /**
   * index.html 이 저장한 로그인 토큰 { token, email, expiresAt }. 만료면 null.
   * expiresAt 은 /api/auth 가 준 ISO 문자열이다 (옛 값이 숫자일 수도 있어 둘 다 읽는다).
   */
  function session() {
    var t = readJSON('seosa_token', null);
    if (!t || !t.token) return null;
    var exp = typeof t.expiresAt === 'number' ? t.expiresAt : Date.parse(t.expiresAt || '');
    if (isFinite(exp) && Date.now() > exp) return null;
    return t;
  }

  /**
   * JSON API 호출. 타임아웃 20초. 실패해도 throw 대신 {ok:false, error} 로 돌려준다.
   */
  function api(path, opts) {
    opts = opts || {};
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, opts.timeoutMs || 20000) : null;
    var headers = { 'Content-Type': 'application/json' };
    var s = opts.auth ? session() : null;
    if (s) headers.Authorization = 'Bearer ' + s.token;
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl ? ctrl.signal : undefined,
      credentials: 'same-origin'
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) {
        if (!r.ok) return { ok: false, status: r.status, error: (b && b.error) || '요청을 처리하지 못했어요.', code: b && b.code, needsAuth: b && b.needsAuth };
        if (b && b.ok === undefined) b.ok = true;
        return b;
      });
    }).catch(function (e) {
      return { ok: false, error: e && e.name === 'AbortError' ? '응답이 늦어요. 잠시 후 다시 시도해 주세요.' : '네트워크 오류가 났어요.' };
    }).then(function (b) { if (timer) clearTimeout(timer); return b; });
  }

  function qs(obj) {
    var out = [];
    Object.keys(obj || {}).forEach(function (k) {
      if (obj[k] === undefined || obj[k] === null || obj[k] === '') return;
      out.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]));
    });
    return out.length ? '?' + out.join('&') : '';
  }

  function param(name) {
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }

  /**
   * 가격 곡선 SVG. points=[{date,price}], opts: { band:{lo,hi}, flags:[date], width, height }.
   * 값이 없으면 빈 문자열.
   */
  function chart(points, opts) {
    opts = opts || {};
    var pts = (points || []).filter(function (p) { return p && p.price > 0; });
    if (pts.length < 2) return '';
    var W = opts.width || 640, H = opts.height || 180, L = 56, R = 8, T = 10, B = 22;
    var prices = pts.map(function (p) { return p.price; });
    var lo = Math.min.apply(null, prices), hi = Math.max.apply(null, prices);
    if (opts.band) { lo = Math.min(lo, opts.band.lo || lo); hi = Math.max(hi, opts.band.hi || hi); }
    if (hi === lo) { hi = hi * 1.02 + 1; lo = lo * 0.98; }
    var x = function (i) { return L + (W - L - R) * (i / (pts.length - 1)); };
    var y = function (v) { return T + (H - T - B) * (1 - (v - lo) / (hi - lo)); };
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.price).toFixed(1); }).join(' ');
    var svg = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(opts.label || '가격 추이') + '">';
    if (opts.band && opts.band.lo && opts.band.hi) {
      svg += '<rect class="band" x="' + L + '" y="' + y(opts.band.hi).toFixed(1) + '" width="' + (W - L - R) + '" height="' + Math.max(1, y(opts.band.lo) - y(opts.band.hi)).toFixed(1) + '"></rect>';
    }
    svg += '<line class="axis" x1="' + L + '" x2="' + (W - R) + '" y1="' + (H - B) + '" y2="' + (H - B) + '"></line>';
    svg += '<text x="4" y="' + (y(hi) + 4).toFixed(1) + '">' + esc(won(hi)) + '</text>';
    svg += '<text x="4" y="' + (y(lo) + 4).toFixed(1) + '">' + esc(won(lo)) + '</text>';
    svg += '<text x="' + L + '" y="' + (H - 6) + '">' + esc(pts[0].date) + '</text>';
    svg += '<text x="' + (W - R) + '" y="' + (H - 6) + '" text-anchor="end">' + esc(pts[pts.length - 1].date) + '</text>';
    svg += '<path class="line" d="' + d + '"></path>';
    var flags = {};
    (opts.flags || []).forEach(function (f) { flags[f] = true; });
    pts.forEach(function (p, i) {
      if (flags[p.date]) svg += '<circle class="flag" cx="' + x(i).toFixed(1) + '" cy="' + y(p.price).toFixed(1) + '" r="4"><title>' + esc(p.date + ' ' + won(p.price)) + '</title></circle>';
    });
    svg += '<circle class="dot" cx="' + x(pts.length - 1).toFixed(1) + '" cy="' + y(pts[pts.length - 1].price).toFixed(1) + '" r="3"></circle>';
    return svg + '</svg>';
  }

  function themeToggle(btn) {
    if (!btn) return;
    var root = document.documentElement;
    function label() { btn.textContent = root.dataset.theme === 'dark' ? '라이트모드' : '다크모드'; }
    label();
    btn.addEventListener('click', function () {
      root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('seosa_theme', root.dataset.theme); } catch (e) { /* 무시 */ }
      label();
    });
  }

  global.V2 = {
    esc: esc, won: won, pct: pct, safeUrl: safeUrl, api: api, qs: qs, param: param,
    chart: chart, session: session, readJSON: readJSON, writeJSON: writeJSON, themeToggle: themeToggle
  };

  document.addEventListener('DOMContentLoaded', function () { themeToggle(document.getElementById('theme')); });
})(window);
