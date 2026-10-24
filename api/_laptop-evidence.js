'use strict';

/*
 * Laptop quality evidence from seller titles, not performance benchmarks.
 *
 * A higher listed price is NOT evidence of better performance. This helper
 * only compares explicit memory amounts and Intel generations within the
 * SAME Core i tier. A later generation is not a benchmark claim and never
 * by itself proves a faster device. Unknown attributes stay unknown.
 * Numbers are ranking tie-breakers only; never present them as benchmarks.
 */

const LAPTOP_RE = /노트북|(?:^|[^가-힣])그램\s*\d*|\b(?:gram\s*\d*|laptop|notebook|macbook|thinkpad|ideapad|vivobook|zenbook|galaxy\s*book)\b|갤럭시북|맥북/i;
const GPU_RE = /\b(?:RTX|GTX|RADEON|GEFORCE|RX\s?\d{3,4})\b/i;
const MEMORY_RE = [
  /(?:\bRAM|램|메모리|DDR[345])\s*(?:용량\s*)?[:=]?\s*(\d{1,2})\s*(?:GB|G)(?![A-Z0-9])/i,
  /\b(\d{1,2})\s*(?:GB|G)\s*(?:RAM\b|램|메모리)/i
];

function validMemory(n) {
  return Number.isInteger(n) && [4, 6, 8, 12, 16, 24, 32, 48, 64].includes(n);
}

function memoryFromTitle(title) {
  const text = String(title || '');
  for (const re of MEMORY_RE) {
    const m = text.match(re);
    if (m && validMemory(Number(m[1]))) return Number(m[1]);
  }
  // Some laptop listings abbreviate "i5-1135G7 8G NVMe 512G".
  // Require a clear CPU + RAM + storage ordering; do not mistake RTX VRAM.
  if (!GPU_RE.test(text)
      && /\bi[3579][-\s]?\d{4,5}[A-Z0-9]*\s+(\d{1,2})\s*G(?:B)?\s+(?:NVMe|SSD)\b/i.test(text)) {
    const m = text.match(/\bi[3579][-\s]?\d{4,5}[A-Z0-9]*\s+(\d{1,2})\s*G(?:B)?\s+(?:NVMe|SSD)\b/i);
    if (m && validMemory(Number(m[1]))) return Number(m[1]);
  }
  return null;
}

function intelCoreFromTitle(title) {
  const m = String(title || '').match(/\bi([3579])[-\s]?(\d{4,5})(?:[A-Z]\d?)?\b/i);
  if (!m) return null;
  const model = m[2];
  const firstTwo = Number(model.slice(0, 2));
  const gen = firstTwo >= 10 && firstTwo <= 14 ? firstTwo : Number(model[0]);
  if (gen < 7 || gen > 14) return null;
  return { tier: Number(m[1]), generation: gen };
}

function laptopEvidence(title) {
  if (!LAPTOP_RE.test(String(title || ''))) return null;
  return { ramGb: memoryFromTitle(title), intel: intelCoreFromTitle(title) };
}

/*
 * Return ranking adjustments indexed by original item; don't mutate input.
 * Unknown RAM/CPU -> 0 (never award the expensive unknown-spec option).
 *
 * RAM: up to 10 pts, only if at least two candidates show RAM.
 * CPU generation: up to 4 pts, only among the same Intel tier.
 * No cross-vendor or i5-vs-i7 synthetic benchmark claims.
 */
function compareLaptopEvidence(items) {
  const list = (items || []).map(x => laptopEvidence(x && x.title));
  const adj = list.map(() => ({ points: 0, facts: [] }));
  const ram = list.map(x => x && x.ramGb).filter(x => Number.isInteger(x));
  if (ram.length >= 2) {
    const lo = Math.min(...ram), hi = Math.max(...ram);
    if (lo !== hi) list.forEach((x, i) => {
      if (!x || !Number.isInteger(x.ramGb)) return;
      const points = Math.round((x.ramGb - lo) / (hi - lo) * 10);
      if (points <= 0) return;
      adj[i].points += points;
      adj[i].facts.push(`상품명 표기 메모리 ${x.ramGb}GB (후보 간 비교)`);
    });
  }

  for (const tier of [3, 5, 7, 9]) {
    const subset = list.map((x, i) => ({ x, i }))
      .filter(e => e.x && e.x.intel && e.x.intel.tier === tier);
    if (subset.length < 2) continue;
    const lo = Math.min(...subset.map(e => e.x.intel.generation));
    const hi = Math.max(...subset.map(e => e.x.intel.generation));
    if (lo === hi) continue;
    subset.forEach(({ x, i }) => {
      const points = Math.round((x.intel.generation - lo) / (hi - lo) * 4);
      if (points <= 0) return;
      adj[i].points += points;
      adj[i].facts.push(`상품명 표기 Intel Core i${tier} ${x.intel.generation}세대 (후보 간 비교)`);
    });
  }
  return adj;
}

module.exports = { laptopEvidence, memoryFromTitle, intelCoreFromTitle, compareLaptopEvidence };
