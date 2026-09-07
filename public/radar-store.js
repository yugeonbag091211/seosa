(function (root) {
  'use strict';
  /*
   * ★ 저장소는 하나다 — 'seosa_wish'.
   *
   * ── 왜 바꿨나 (2026-09-07 통합) ──────────────────────────────────
   *
   * 레이더는 'seosa_wishlist' 를, index.html 의 ♡ 는 'seosa_wish' 를 쓰고
   * 있었다. 두 저장소가 이름만 다르고 하는 일이 같아서, 사용자에게는 이런
   * 흐름이 됐다.
   *
   *     홈에서 ♡ 누름 → 패널 제목이 "내 레이더"
   *     → "가격 변화와 목표가격 보기" → /radar.html → **비어 있음**
   *
   * 'seosa_wish' 쪽으로 합친다. 그쪽이
   *   · 이미 사용자 데이터가 들어 있고 (기존 위시 목록)
   *   · /api/sync(user_data.wish)로 기기 간 백업까지 되고 있으며
   *   · index.html 의 위시 패널이 그대로 읽는 키다
   * 반대로 옮기면 기존 사용자의 저장 목록이 통째로 사라진 것처럼 보인다.
   *
   * 항목 모양은 서로 호환된다. index.html 이 savedPrice·savedAt·targetPrice 를
   * 이미 넣고 있고, 아래 read/toggle 은 없는 필드를 전부 폴백으로 다룬다.
   */
  var KEY = 'seosa_wish';
  function read() {
    try { var value = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(value) ? value : []; }
    catch (_) { return []; }
  }
  function write(items) { try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (_) {} return items; }
  function key(p) { return String((p && p.productId) || '') + '|' + String((p && p.mall) || '') || String((p && p.title) || ''); }
  function same(a, b) { return a && b && ((a.productId && b.productId && String(a.productId) === String(b.productId) && String(a.mall || '') === String(b.mall || '')) || (!a.productId && !b.productId && a.title === b.title && a.mall === b.mall)); }
  function find(product) { return read().find(function (x) { return same(x, product); }) || null; }
  function toggle(product) {
    var items = read(), index = items.findIndex(function (x) { return same(x, product); });
    if (index > -1) { items.splice(index, 1); write(items); return { saved: false, items: items }; }
    var price = Number(product.price || product.lprice) || 0;
    /*
     * seenPrice / seenDecision / vendorItemId 는 POST /api/radar 가 «무엇과
     * 견줄지» 를 정하는 값이다 (api/_radar.changesFor).
     *
     *   seenPrice     사용자가 마지막으로 «본» 값. 처음에는 저장 시점 가격이다.
     *   seenDecision  그때의 판정. WAIT → BUY 로 바뀐 것만 «변화» 로 친다.
     *   vendorItemId  옵션 식별자. 없으면 다른 옵션의 이력이 섞일 수 있다.
     *
     * 서버는 이 값들을 저장하지 않는다 — 브라우저가 들고 있다가 보낸다.
     * 그래서 로그인하지 않은 사용자도 변화 감지를 그대로 쓴다.
     */
    items.unshift({ title: String(product.title || ''), productId: String(product.productId || ''), mall: String(product.mall || ''), mallLabel: String(product.mallLabel || product.mall || ''), vendorItemId: String(product.vendorItemId || ''), price: price, currentPrice: price, savedPrice: price, seenPrice: price, seenDecision: String(product.verdict === 'BUY' || product.verdict === 'GOOD_BUY' ? 'BUY' : (product.decision || '')), link: String(product.link || product.url || ''), image: String(product.image || ''), savedAt: Date.now(), targetPrice: null, verdict: product.verdict || '', verdictLabel: product.verdictLabel || '', verdictReason: product.verdictReason || '' });
    write(items); return { saved: true, items: items };
  }
  function target(product, value) {
    var items = read(), item = items.find(function (x) { return same(x, product); });
    if (!item) return false;
    var price = Number(value); item.targetPrice = Number.isFinite(price) && price > 0 ? Math.round(price) : null;
    write(items); return true;
  }
  /*
   * ★ 화면은 이 함수를 쓰지 않는다 (public/radar.js).
   *
   * 갈래를 나누는 일은 서버가 한다 — POST /api/radar 가 목표가 도달·가격
   * 하락·BUY 전환을 판정해 events[] 와 decision 으로 준다. 여기서 같은
   * 판단을 되풀이하면 두 곳이 언젠가 갈리고, 그때 목록과 상품 상세가 서로
   * 다른 말을 한다.
   *
   * 그럼에도 남겨 두는 이유: 서버 응답이 아직 없거나(첫 그리기) 조회에
   * 실패했을 때 저장 목록만으로 대충의 상태를 말해야 하는 자리가 있고,
   * 저장 구조를 쓰는 다른 화면이 생길 수 있다. «판정» 이 아니라 «폴백» 이다.
   */
  function classify(item) {
    var current = Number(item.currentPrice || item.price) || 0, saved = Number(item.savedPrice || item.price) || 0, targetPrice = Number(item.targetPrice) || 0;
    if (targetPrice > 0 && current > 0 && current <= targetPrice) return 'target';
    if (saved > 0 && current > 0 && current < saved) return 'drop';
    return 'watch';
  }
  root.RadarStore = { KEY: KEY, read: read, write: write, key: key, same: same, find: find, toggle: toggle, target: target, classify: classify };
  if (typeof module !== 'undefined') module.exports = root.RadarStore;
})(typeof window !== 'undefined' ? window : globalThis);
