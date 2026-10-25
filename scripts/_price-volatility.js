'use strict';

// 가격 이력의 동일 판매 단위(product_id + mall + vendor_item_id)별 변동 횟수.
const keyOf = r => [r.product_id, r.mall, r.vendor_item_id || ''].join('|');

function volatilityRanking(rows, minChanges = 1) {
  const groups = new Map();
  for (const r of rows || []) {
    if (!r.product_id || !['쿠팡', 'ADPICK'].includes(r.mall)) continue;
    const price = Number(r.price);
    const at = Date.parse(r.recorded_at);
    if (!Number.isSafeInteger(price) || price <= 0 || !Number.isFinite(at)) continue;
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push([at, price]);
  }
  const ranked = [];
  for (const [key, values] of groups) {
    if (values.length < 2) continue;
    values.sort((a, b) => a[0] - b[0]);
    let changes = 0;
    for (let i = 1; i < values.length; i++) {
      if (values[i][1] !== values[i - 1][1]) changes++;
    }
    if (changes < minChanges) continue;
    const last = values[values.length - 1];
    ranked.push({ key, changes, observations: values.length, lastObservedMs: last[0] });
  }
  return ranked.sort((a, b) => b.changes - a.changes
    || b.lastObservedMs - a.lastObservedMs || a.key.localeCompare(b.key));
}

function slotPlan(now, wantedSlot) {
  const local = new Date(now.getTime() + 9 * 3600000);
  const day = local.toISOString().slice(0, 10);
  const h = local.getUTCHours();
  const slot = wantedSlot || (h >= 12 && h < 15 ? 'noon' : h >= 19 && h < 22 ? 'evening' : '');
  const first = slot === 'noon' ? 12 : slot === 'evening' ? 19 : -1;
  // GitHub cron이 늦게 실행됐다고 밤중에 점심 재확인을 실행하지 않는다.
  if (first < 0 || h < first || h >= first + 3) return null;
  const startMs = Date.parse(day + 'T00:00:00Z') - 9 * 3600000 + first * 3600000;
  return { slot, day, startMs, minChanges: slot === 'noon' ? 3 : 1 };
}

function pickSearchGroups(candidates, maxQueries) {
  const groups = new Map();
  for (const item of candidates || []) {
    const word = String(item.keyword || item.title || '').trim().slice(0, 80);
    if (!word) continue;
    const k = item.mall + '|' + word;
    if (!groups.has(k)) groups.set(k, { mall: item.mall, keyword: word, targets: [] });
    groups.get(k).targets.push(item);
  }
  return [...groups.values()].slice(0, maxQueries);
}

module.exports = { keyOf, volatilityRanking, slotPlan, pickSearchGroups };
