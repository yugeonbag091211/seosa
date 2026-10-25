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

function windowObservationCountMention(text, windowDays, observedDays) {
  if (!observedDays) return true;
  const window = `(?:최근|지난)\\s*${windowDays}\\s*일(?:간)?`;
  const count = `(?:\\*{1,2})?${observedDays}\\s*일(?:치)?(?:\\*{1,2})?`;
  const patterns = [
    new RegExp(`(?:가격\\s*)?기록(?:이\\s*있는)?\\s*(?:날짜|날|일)(?:는|은|이|가)?[^.!?\\n]{0,12}${count}`),
    new RegExp(`(?:가격\\s*)?기록(?:은|는|이|가)?[^.!?\\n]{0,12}${count}`),
    new RegExp(`${window}[^.!?\\n]{0,12}(?:가격\\s*)?(?:기록|관측)(?:은|는|이|가)?[^.!?\\n]{0,12}${count}`),
    new RegExp(`${window}[^.!?\\n]{0,8}${count}[^.!?\\n]{0,10}(?:가격\\s*)?(?:기록|관측)`)
  ];
  return patterns.some(pattern => pattern.test(String(text || '')));
}

function lowObservationCountMention(text, count) {
  if (!count) return true;
  const number = count === 1 ? '(?:한\\s*번(?:만)?|1\\s*(?:회|번|일))' : `${count}\\s*(?:회|번|일)`;
  const low = '(?:최저(?:가|가격|관측가)?|해당\\s*가격|그\\s*가격)';
  const patterns = [
    new RegExp(`${low}[^.!?\\n]{0,40}${number}[^.!?\\n]{0,12}(?:관측|기록|확인)`),
    new RegExp(`${low}[^.!?\\n]{0,20}(?:관측|기록|확인)[^.!?\\n]{0,20}${number}`),
    new RegExp(`${number}[^.!?\\n]{0,12}(?:관측|기록|확인)[^.!?\\n]{0,30}${low}`)
  ];
  return patterns.some(pattern => pattern.test(String(text || '')));
}

function snapshotQuestionCheck(q, text) {
  if (q.kind === 'current') {
    return priceMention(text, q.currentPrice) && dateMention(text, q.lastDate);
  }
  if (q.kind === 'low7') return priceMention(text, q.lowPrice) && /7\s*일/.test(text)
    && windowObservationCountMention(text, 7, q.observedDays)
    && lowObservationCountMention(text, q.lowObservedCount)
    && (!q.lowDate || dateMention(text, q.lowDate));
  if (q.kind === 'low30') return priceMention(text, q.lowPrice) && /30\s*일/.test(text)
    && windowObservationCountMention(text, 30, q.observedDays)
    && lowObservationCountMention(text, q.lowObservedCount)
    && (!q.lowDate || dateMention(text, q.lowDate));
  if (q.kind === 'allTime' && q.confirmed === false) {
    const candidate = /(?:관측\s*최저(?:\s*후보)?|최저\s*관측(?:\s*후보)?|최저(?:가)?\s*후보)/.test(text);
    const observedLow = /(?:기록\s*최저.{0,24}(?:확인|확정|단정|검증).{0,8}(?:중|수\s*없|되(?:지(?:는)?|지는)\s*않)|최저.{0,24}(?:관측|기록).{0,24}(?:확인|확정|단정|검증))/.test(text);
    const describedObservedMinimum = /(?:기록|관측).{0,50}(?:가장\s*낮게\s*관측|가장\s*낮은\s*관측|최저\s*관측가)/.test(text);
    const unconfirmed = /(?:하루만|한\s*번(?:만)?|단\s*한\s*번|1\s*(?:회|번|일)|확정할 수 없|확정되지 않|단정할 수 없|미확정|확인 중|검증 중|확인되지 않|기록 최저가로 볼 수 없)/.test(text);
    const countMatches = !q.observedCount || (q.observedCount === 1
      ? /(?:하루만|한\s*번(?:만)?|단\s*한\s*번|1\s*(?:회|번|일))/.test(text)
      : new RegExp(`${q.observedCount}\\s*(?:회|번|일)`).test(text));
    return priceMention(text, q.lowPrice) && (candidate || observedLow || describedObservedMinimum) && unconfirmed && countMatches
      && (!q.lowDate || dateMention(text, q.lowDate));
  }
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
    const saysUnavailable = new RegExp(`${option}.{0,40}(없|확인할 수 없|확인되지 않|찾지 못|찾을 수 없|비교할 수 없)|(없|확인할 수 없|확인되지 않|찾지 못|찾을 수 없).{0,40}${option}`, 'i').test(text);
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
    const pricedOption = optionSpans.filter(span => span.value === target).some(span => {
      const aroundOption = text.slice(Math.max(0, span.start - 24), Math.min(text.length, span.end + 48));
      // A nearby repeated option mention can explicitly deny that an adjacent
      // price belongs to it (e.g. "256GB ... 1,749,000원 ... 512GB 가격으로
      // 볼 수 없습니다"). Do not let that denial reverse the unavailability check.
      if (/(?:가격|금액)(?:으로|은|는|이|가)?[^.!?\n]{0,24}(?:볼\s*수(?:는)?\s*없|확인(?:할\s*수\s*없|되지\s*않)|알\s*수\s*없|판단할\s*수\s*없|아니)|(?:볼\s*수(?:는)?\s*없|확인(?:할\s*수\s*없|되지\s*않)|알\s*수\s*없|판단할\s*수\s*없)[^.!?\n]{0,24}(?:가격|금액)/i.test(aroundOption)) return false;
      return prices.some(price => {
        const distance = price.start >= span.end ? price.start - span.end : span.start - price.end;
        if (distance > 50) return false;
        const from = Math.min(span.end, price.end);
        const to = Math.max(span.start, price.start);
        return !optionSpans.some(other => other.value !== target && other.start >= from && other.end <= to);
      });
    });
    return saysUnavailable && !pricedOption;
  }
  return false;
}

module.exports = { priceMention, snapshotQuestionCheck };
