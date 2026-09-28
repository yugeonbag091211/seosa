'use strict';

/**
 * True only when the bounded server-side observation set can support a
 * repeated record-low statement. Callers must attach this history to the
 * exact product/option/mall identity before using the result.
 */
function hasConfirmedRecordLow(history) {
  if (!history || typeof history !== 'object') return false;
  const low = Number(history.low);
  const count = Number(history.count);
  const lowCount = Number(history.lowCount);
  const days = Number(history.historyDays);
  const validDate = value => {
    const text = String(value || '');
    if (text.length !== 10 || text[4] !== '-' || text[7] !== '-') return false;
    const digits = text.slice(0, 4) + text.slice(5, 7) + text.slice(8, 10);
    if (!digits.split('').every(ch => ch >= '0' && ch <= '9')) return false;
    const parsed = new Date(text + 'T00:00:00Z');
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
  };
  const firstDate = String(history.firstDate || '');
  const lastDate = String(history.lastDate || '');
  return Number.isSafeInteger(low) && low > 0
    && Number.isSafeInteger(count) && count >= 7
    && Number.isSafeInteger(lowCount) && lowCount >= 2
    && Number.isSafeInteger(days) && days >= 7
    && history.lowConfirmed === true
    && validDate(firstDate) && validDate(lastDate)
    && firstDate <= lastDate;
}


/**
 * Current-price claims from catalog snapshots are only current for a short window.
 * Search API responses without a catalog timestamp retain their existing source checks.
 * checkedAt is a server-derived KST calendar date from a verified catalog row.
 */
function isCurrentPriceFresh(item, now = Date.now()) {
  if (!item || !item.checkedAt) return true;
  const checkedAt = String(item.checkedAt);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkedAt)) return false;
  const parsed = new Date(checkedAt + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== checkedAt) return false;
  const kstToday = new Date(Number(now) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const today = new Date(kstToday + 'T00:00:00Z');
  const ageDays = Math.floor((today.getTime() - parsed.getTime()) / 86400000);
  return Number.isInteger(ageDays) && ageDays >= 0 && ageDays <= 3;
}

module.exports = { hasConfirmedRecordLow, isCurrentPriceFresh };
