'use strict';

function kstDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return values.year + '-' + values.month + '-' + values.day;
}

function isSameKstDate(left, right = Date.now()) {
  const leftKey = kstDateKey(left);
  return !!leftKey && leftKey === kstDateKey(right);
}

module.exports = { kstDateKey, isSameKstDate };