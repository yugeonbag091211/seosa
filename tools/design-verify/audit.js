// Runs in the page (Runtime.evaluate). Returns a JSON report; clicks nothing.
(async function () {
  var AFF = '이 페이지에는 제휴 링크가 포함되어 있으며, 구매 시 SEOSA가 일정 수수료를 제공받습니다.';
  var digits = function (s) { return Number(String(s || '').replace(/[^0-9]/g, '')) || 0; };
  var vis = function (e) { if (!e) return false; var r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05; };
  for (var y=0;y<document.documentElement.scrollHeight;y+=400){scrollTo(0,y);await new Promise(function(r){setTimeout(r,150)})} await new Promise(function(r){setTimeout(r,2500)}); scrollTo(0,0);
  // wait for images
  var imgs = [].slice.call(document.querySelectorAll('.card .thumb img, .dthumb img'));
  await Promise.all(imgs.map(function (i) { return i.complete ? 0 : new Promise(function (r) { i.onload = i.onerror = r; setTimeout(r, 6000); }); }));
  var api = {};
  var add = function (p) { if (p && p.title) api[p.title] = p; };
  var q = new URLSearchParams(location.search).get('q');
  try {
    if (q) { (await (await fetch('/api/search?keyword=' + encodeURIComponent(q))).json()).forEach(add); }
    else {
      var init = await (await fetch('/api/init')).json();
      (init.daily.products || []).forEach(add); ((init.monthly || {}).products || []).forEach(add);
      var hd = await (await fetch('/api/hotdeals?view=today-drop&limit=60')).json();
      (hd.items || []).forEach(function (it) { add({ title: it.title, lprice: it.currentPrice, link: it.link }); });
    }
  } catch (e) {}
  var sections = q ? ['results'] : ['priceDrop', 'today', 'monthly'];
  var out = { url: location.pathname + location.search, w: innerWidth, overflowX: document.documentElement.scrollWidth - innerWidth, sections: {} };
  sections.forEach(function (id) {
    var sec = document.getElementById(id); var s = { shown: vis(sec) };
    if (!s.shown) { out.sections[id] = s; return; }
    var cards = [].slice.call(sec.querySelectorAll('.card, .dcard')).filter(vis);
    s.cards = cards.length;
    var c = { imgOk: 0, imgBroken: 0, imgNone: 0, distorted: 0, overflowThumb: 0, ratios: [], priceMatch: 0, priceMismatch: [], noApi: 0, buyBtn: 0, buyOff: 0, buyLinkMismatch: 0, buyMinH: 999, titleClampOk: 0 };
    cards.forEach(function (card) {
      var img = card.querySelector('.thumb img, .dthumb img'); var box = card.querySelector('.thumb, .dthumb');
      if (!img) c.imgNone++;
      else if (!img.complete || !img.naturalWidth) { c.imgBroken++; (c.brokenSrc=c.brokenSrc||[]).push((img.currentSrc||img.src||'').slice(0,60)+' lazy='+img.loading+' complete='+img.complete); }
      else {
        c.imgOk++;
        var cs = getComputedStyle(img), ir = img.getBoundingClientRect(), br = box.getBoundingClientRect();
        var nat = img.naturalWidth / img.naturalHeight, ren = ir.width / ir.height;
        if (cs.objectFit !== 'contain' && Math.abs(nat - ren) / nat > 0.03) c.distorted++;
        if (ir.width > br.width + 1 || ir.height > br.height + 1) c.overflowThumb++;
        c.ratios.push(Math.round(br.width / br.height * 100) / 100);
      }
      var tEl = card.querySelector('.p-title, .dname'); var title = tEl ? tEl.textContent.trim() : '';
      if (tEl && tEl.scrollHeight <= tEl.clientHeight + 2 || (tEl && getComputedStyle(tEl).webkitLineClamp !== 'none')) c.titleClampOk++;
      var pEl = card.querySelector('.price, .dprice'); var shown = digits(pEl && pEl.firstChild ? pEl.childNodes[0].textContent : '');
      var a = api[title];
      if (!a) c.noApi++;
      else if (digits(a.lprice) === shown) c.priceMatch++;
      else c.priceMismatch.push(title.slice(0, 20) + ' ' + shown + '≠' + a.lprice);
      var b = card.querySelector('[data-act="card-buy"], [data-act="ledger-buy"], .buy, .lact.dark');
      if (b && !b.classList.contains('is-off')) { c.buyBtn++; c.buyMinH = Math.min(c.buyMinH, Math.round(b.getBoundingClientRect().height)); if (a && !a.link) c.buyLinkMismatch++; }
      else { c.buyOff++; if (a && a.link) c.buyLinkMismatch++; }
    });
    c.ratios = Array.from(new Set(c.ratios));
    s.c = c;
    var note = sec.querySelector('.aff-note');
    var firstBuy = sec.querySelector('[data-act="card-buy"], [data-act="ledger-buy"]');
    s.aff = note ? { visible: vis(note), textOk: note.textContent.indexOf(AFF) >= 0, fontPx: parseFloat(getComputedStyle(note).fontSize),
      beforeBuy: firstBuy ? !!(note.compareDocumentPosition(firstBuy) & Node.DOCUMENT_POSITION_FOLLOWING) : null } : 'MISSING';
    out.sections[id] = s;
  });
  out.affNotesVisibleTotal = [].slice.call(document.querySelectorAll('.aff-note')).filter(vis).length;
  return out;
})()
