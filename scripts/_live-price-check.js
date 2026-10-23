'use strict';

function priceMention(text, value) {
  const digits = String(Math.round(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',?');
  return digits !== '0' && new RegExp(`${digits}\\s*원`).test(String(text || ''));
}

function dateMention(text, date) {
  const [, year, month, day] = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/) || [];
  if (!year) return false;
  return new RegExp(`${year}[-/.]${month}[-/.]${day}|${year}년\\s*${Number(month)}월\\s*${Number(day)}일|${Number(month)}월\\s*${Number(day)}일`).test(String(text || ''));
}

function snapshotQuestionCheck(q, text) {
  if (q.kind === 'current') {
    return priceMention(text, q.currentPrice) && dateMention(text, q.lastDate);
  }
  if (q.kind === 'low7') return priceMention(text, q.lowPrice) && /7\s*일/.test(text)
    && (!q.observedDays || new RegExp(`${q.observedDays}\\s*일`).test(text))
    && (!q.lowDate || dateMention(text, q.lowDate));
  if (q.kind === 'low30') return priceMention(text, q.lowPrice) && /30\s*일/.test(text)
    && (!q.observedDays || new RegExp(`${q.observedDays}\\s*일`).test(text))
    && (!q.lowDate || dateMention(text, q.lowDate));
  if (q.kind === 'allTime') return priceMention(text, q.lowPrice)
    && /(역대|기록 전체|전체 기록|보유 기록|보유 가격 기록 전체|가격 기록 전체|관측 기록 전체)/.test(text);
  if (q.kind === 'gap') {
    const referencesGap = q.gapDate ? dateMention(text, q.gapDate) : /어제/.test(text);
    const priceClaims = [...String(text || '').matchAll(/(\d[\d,]*)\s*원/g)].map(m => Number(m[1].replace(/,/g, '')));
    const amountsGrounded = !Array.isArray(q.allowedPrices)
      || priceClaims.every(value => q.allowedPrices.includes(value));
    const inventedDelta = /\d[\d,]*\s*원\s*(?:하락|상승|떨어|내렸|올랐|차이|변화|변동)|(?:하락|상승|떨어|내렸|올랐|차이|변화|변동).{0,8}\d[\d,]*\s*원/.test(text);
    return referencesGap && /(기록|관측)/.test(text)
      && /(없|확인할 수 없|비교할 수 없|계산할 수 없)/.test(text)
      && amountsGrounded && !inventedDelta;
  }
  if (q.kind === 'yesterday') {
    const direction = Number(q.delta) === 0
      ? /(0\s*원|변화.{0,6}없|변동.{0,6}없|그대로|같은 가격)/.test(text)
      : Number(q.delta) > 0
        ? priceMention(text, q.delta) && /(하락|떨어|내렸|줄었)/.test(text)
        : priceMention(text, Math.abs(q.delta)) && /(상승|올랐|높아|늘었)/.test(text);
    return priceMention(text, q.yesterdayPrice) && priceMention(text, q.currentPrice) && direction;
  }
  if (q.kind === 'unavailable') {
    const option = String(q.option || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const saysUnavailable = new RegExp(`${option}.{0,40}(없|확인할 수 없|확인되지 않|찾을 수 없|비교할 수 없)|(없|확인할 수 없|확인되지 않|찾을 수 없).{0,40}${option}`).test(text);
    const normalizeOption = value => String(value || '').toUpperCase().replace(/\s+/g, '');
    const optionSpans = [];
    const capacity = /\b\d+(?:\.\d+)?\s*(?:GB|TB)\b/gi;
    let match;
    while ((match = capacity.exec(text)) !== null) {
      optionSpans.push({ start: match.index, end: match.index + match[0].length, value: normalizeOption(match[0]) });
    }
    // Also recognize non-capacity option identifiers supplied by the caller.
    const targetPattern = new RegExp(option, 'gi');
    while ((match = targetPattern.exec(text)) !== null) {
      optionSpans.push({ start: match.index, end: match.index + match[0].length, value: normalizeOption(match[0]) });
    }
    const target = normalizeOption(q.option);
    const prices = [...String(text || '').matchAll(/\d[\d,]*\s*원/g)].map(m => ({ start: m.index, end: m.index + m[0].length }));
    const pricedOption = optionSpans.filter(span => span.value === target).some(span => prices.some(price => {
      const distance = price.start >= span.end ? price.start - span.end : span.start - price.end;
      if (distance > 50) return false;
      const from = Math.min(span.end, price.end);
      const to = Math.max(span.start, price.start);
      return !optionSpans.some(other => other.value !== target && other.start >= from && other.end <= to);
    }));
    return saysUnavailable && /256\s*GB/.test(text) && !pricedOption;
  }
  return false;
}

module.exports = { priceMention, snapshotQuestionCheck };
