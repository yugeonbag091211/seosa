import type { PricePoint } from './types.ts';

/*
 * Price chart geometry. Pure, so every edge case is tested without a renderer.
 *
 * x is proportional to calendar days: a week without observations shows as a gap in time,
 * not as two adjacent points. The chart draws only server points; nothing is interpolated
 * into a value the user could read as a real price — scrubbing snaps to the nearest real point.
 */

export type ChartRange = 7 | 30 | 90 | 365;
export const RANGES: readonly ChartRange[] = [7, 30, 90, 365];

export type ChartPoint = PricePoint & { x: number; y: number };

export type ChartModel = {
  points: ChartPoint[];
  path: string;
  area: string;
  min: number;
  max: number;
  /** Rounded min/max grid values (labels on the left). */
  ticks: { value: number; y: number }[];
  width: number;
  height: number;
  flat: boolean;
};

const DAY_MS = 86_400_000;
const dayOf = (ymd: string) => Math.floor(Date.parse(`${ymd}T00:00:00Z`) / DAY_MS);

/** Points inside the last `days` calendar days counted back from the newest point. */
export function withinRange(points: readonly PricePoint[], days: ChartRange): PricePoint[] {
  if (!points.length) return [];
  const last = dayOf(points[points.length - 1].date);
  return points.filter(p => last - dayOf(p.date) < days);
}

/**
 * The shortest range that already shows every point, so a product with 5 days of history
 * does not open on an empty-looking «1년» tab (the web's Modal.syncRangeTabs does the same).
 */
export function defaultRange(points: readonly PricePoint[]): ChartRange {
  if (points.length < 2) return 30;
  const span = dayOf(points[points.length - 1].date) - dayOf(points[0].date) + 1;
  return RANGES.find(r => r >= span) || 365;
}

/** Ranges worth offering: the first one that covers everything, and the shorter ones that hold ≥ 2 points. */
export function availableRanges(points: readonly PricePoint[]): ChartRange[] {
  const full = defaultRange(points);
  return RANGES.filter(r => r <= full && (r === full || withinRange(points, r).length >= 2));
}

function niceStep(span: number): number {
  const raw = span / 2;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const norm = raw / mag;
  return (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
}

export function buildChart(points: readonly PricePoint[], width: number, height: number, pad = { top: 12, bottom: 12, left: 0, right: 8 }): ChartModel | null {
  if (!points.length || width <= 0 || height <= 0) return null;
  const prices = points.map(p => p.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const flat = min === max;
  // A flat series sits in the middle; otherwise 8% headroom so neither extreme is drawn on the frame.
  const margin = flat ? max * 0.05 : (max - min) * 0.08;
  const lo = min - margin;
  const hi = max + margin;

  const d0 = dayOf(points[0].date);
  const d1 = dayOf(points[points.length - 1].date);
  const spanDays = Math.max(1, d1 - d0);
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const xOf = (date: string) => (points.length === 1 ? pad.left + plotW : pad.left + ((dayOf(date) - d0) / spanDays) * plotW);
  const yOf = (price: number) => pad.top + (1 - (price - lo) / (hi - lo)) * plotH;

  const coords: ChartPoint[] = points.map(p => ({ ...p, x: round(xOf(p.date)), y: round(yOf(p.price)) }));
  // Step line: a price holds until the next observation changes it (prices do not glide between days).
  let path = `M${coords[0].x},${coords[0].y}`;
  for (let i = 1; i < coords.length; i += 1) path += ` H${coords[i].x} V${coords[i].y}`;
  const bottom = pad.top + plotH;
  const area = `${path} V${bottom} H${coords[0].x} Z`;

  const step = niceStep(max - min || max * 0.1);
  const tickValues = flat ? [min] : [Math.ceil(min / step) * step, Math.floor(max / step) * step].filter((v, i, a) => a.indexOf(v) === i && v >= min && v <= max);
  const ticks = tickValues.map(value => ({ value, y: round(yOf(value)) }));

  return { points: coords, path, area, min, max, ticks, width, height, flat };
}

/** Index of the real point nearest to a finger at x. */
export function nearestIndex(model: ChartModel, x: number): number {
  let best = 0;
  let bestD = Infinity;
  model.points.forEach((p, i) => {
    const d = Math.abs(p.x - x);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Summary shown under the chart. Only computed from the drawn server points. */
export function rangeSummary(points: readonly PricePoint[]) {
  if (!points.length) return null;
  const prices = points.map(p => p.price);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  // The most recent day at the low: "최저 · 오늘" says more than the first time it happened.
  const lowPoint = [...points].reverse().find(p => p.price === low)!;
  const first = points[0].price;
  const last = points[points.length - 1].price;
  return { low, high, lowDate: lowPoint.date, first, last, change: last - first, days: points.length };
}
