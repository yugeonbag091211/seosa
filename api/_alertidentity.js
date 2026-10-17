'use strict';

const MAX_VENDOR_ID_LEN = 200;

function cleanVendorItemId(value) {
  return String(value == null ? '' : value).trim().slice(0, MAX_VENDOR_ID_LEN);
}

function cleanPart(value) {
  return String(value == null ? '' : value).trim();
}

function productMallKey(productId, mall) {
  return `${cleanPart(productId)}|${cleanPart(mall)}`;
}

function offerKey(productId, mall, vendorItemId) {
  return `${productMallKey(productId, mall)}|${cleanVendorItemId(vendorItemId)}`;
}

/**
 * Rows must already be ordered oldest -> newest. Later observations overwrite earlier ones.
 * The legacy maps preserve the old product-level alert behavior; byOffer is the exact option gate.
 */
function indexPriceRows(rows) {
  const byProductMall = new Map();
  const byProduct = new Map();
  const byOffer = new Map();

  for (const row of rows || []) {
    if (!row || !cleanPart(row.product_id)) continue;
    const pid = cleanPart(row.product_id);
    const mall = cleanPart(row.mall);
    const vid = cleanVendorItemId(row.vendor_item_id);
    byProductMall.set(productMallKey(pid, mall), row);
    byProduct.set(pid, row);
    if (mall && vid) byOffer.set(offerKey(pid, mall, vid), row);
  }

  return { byProductMall, byProduct, byOffer };
}

/**
 * New option-bound alerts are fail-closed: product + mall + vendor must all match.
 * Legacy alerts without vendor_item_id keep the previous product+mall, then product-only fallback.
 */
function priceRowForAlert(alert, index) {
  if (!alert || !index) return null;
  const pid = cleanPart(alert.product_id);
  const mall = cleanPart(alert.mall);
  const vid = cleanVendorItemId(alert.vendor_item_id);
  if (!pid) return null;

  if (vid) {
    if (!mall) return null;
    return index.byOffer.get(offerKey(pid, mall, vid)) || null;
  }

  if (mall) {
    const exactMall = index.byProductMall.get(productMallKey(pid, mall));
    if (exactMall) return exactMall;
  }
  return index.byProduct.get(pid) || null;
}

module.exports = {
  MAX_VENDOR_ID_LEN,
  cleanVendorItemId,
  productMallKey,
  offerKey,
  indexPriceRows,
  priceRowForAlert
};
