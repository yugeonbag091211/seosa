(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CartSummary = api;
})(typeof window === 'object' ? window : null, function () {
  'use strict';

  function integer(value) {
    var number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
  }

  function summarize(plan) {
    if (!plan || !Array.isArray(plan.byMall)) return { ok: false };

    var totals = { total: 0, itemsCost: 0, shippingCost: 0, couponDiscount: 0 };
    for (var i = 0; i < plan.byMall.length; i++) {
      var group = plan.byMall[i];
      if (!group || !Array.isArray(group.lines)) return { ok: false };

      var subtotal = integer(group.subtotal);
      var shipping = integer(group.shipping);
      var coupon = integer(group.coupon);
      var total = integer(group.total);
      if ([subtotal, shipping, coupon, total].some(function (n) { return n === null || n < 0; })) {
        return { ok: false };
      }

      var lineTotal = 0;
      for (var j = 0; j < group.lines.length; j++) {
        var line = integer(group.lines[j] && group.lines[j].lineTotal);
        if (line === null || line < 0) return { ok: false };
        lineTotal += line;
        if (!Number.isSafeInteger(lineTotal)) return { ok: false };
      }
      if (subtotal !== lineTotal || subtotal + shipping - coupon !== total) return { ok: false };

      totals.itemsCost += lineTotal;
      totals.shippingCost += shipping;
      totals.couponDiscount += coupon;
      totals.total += total;
      if (![totals.itemsCost, totals.shippingCost, totals.couponDiscount, totals.total].every(Number.isSafeInteger)) {
        return { ok: false };
      }
    }

    if (totals.itemsCost + totals.shippingCost - totals.couponDiscount !== totals.total
      || integer(plan.total) !== totals.total
      || integer(plan.shippingCost) !== totals.shippingCost
      || integer(plan.couponDiscount) !== totals.couponDiscount) {
      return { ok: false };
    }
    totals.itemsCostMismatch = integer(plan.itemsCost) !== totals.itemsCost;
    return Object.assign({ ok: true }, totals);
  }

  return { summarize: summarize };
});

