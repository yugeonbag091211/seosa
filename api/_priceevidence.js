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
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(text)) return false;
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

module.exports = { hasConfirmedRecordLow };
