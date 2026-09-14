import type { PricePoint } from './api';

/** Geometry of the price chart. Pure, so tests can check every edge case without a renderer. */
export const CHART = { height: 132, top: 12, bottom: 120, side: 6, maxPoints: 30 } as const;

/** Advance width of a monospace digit or comma in em (IBM Plex Mono and the platform monospace fallbacks are 0.6), with slack. */
export const MONO_ADVANCE = 0.62;
/** Space kept left of the y-axis labels, and between the labels and the plot. */
const AXIS_PAD = 4;
/** The y-axis may take at most this share of the chart width before labels switch to 만/억 units. */
const MAX_GUTTER_SHARE = 0.4;
const DAY_MS = 86_400_000;

export type ChartCoord = { x: number; y: number };
export type ChartTick = { value: number; y: number; label: string };

export type GuideKind = 'max' | 'avg' | 'min';
/**
 * A dashed reference line with a direct text label ("최고 16,800"), so min/avg/max never rely on color alone.
 * The label sits on a plate centered at `labelY` (moved apart when lines are close) at the plot's start or end,
 * whichever the price line does not run through.
 */
export type ChartGuide = {
  kind: GuideKind;
  value: number;
  y: number;
  label: string;
  labelY: number;
  labelWidth: number;
  labelHeight: number;
  anchor: 'start' | 'end';
};

export type ChartModel = {
  points: PricePoint[];
  min: number;
  max: number;
  latest: number;
  flat: boolean;
  coords: ChartCoord[];
  path: string;
  /** The line path closed down to the bottom rule, for the web's soft fill under the line. */
  fillPath: string;
  /** Horizontal grid lines with price labels (web: Chart.js y axis). */
  ticks: ChartTick[];
  /** Width reserved left of the plot for the tick labels (the plot starts at `left + CHART.side`). */
  left: number;
  guides: ChartGuide[];
  /** 'date': x is proportional to calendar days, so gaps in collection show as gaps. 'index': dates were unreadable. */
  spacing: 'date' | 'index';
  last: ChartCoord;
  firstDate: string;
  lastDate: string;
  accessibilityLabel: string;
};

export type ChartOptions = {
  height?: number;
  top?: number;
  bottom?: number;
  /** Fixed y-axis gutter. When omitted and `axisFontSize` is set, the gutter is sized to the widest tick label. */
  left?: number;
  tickCount?: number;
  axisFontSize?: number;
  /** Draws labeled min/max guides, plus an average guide when this value lies inside the drawn range. */
  average?: number;
  guideFontSize?: number;
};

export function formatWon(price: number): string {
  return `${Math.round(price).toLocaleString('ko-KR')}원`;
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString('ko-KR');
}

/**
 * One value per day, oldest first, most recent `maxPoints` days.
 * The API already sends daily ascending points; this keeps the chart correct if it ever does not
 * (unsorted input would draw a zigzag, a repeated date would draw a vertical jump).
 * Invalid and non-positive prices are dropped rather than drawn at zero.
 */
export function normalizePoints(points: readonly PricePoint[], maxPoints: number = CHART.maxPoints): PricePoint[] {
  const byDate = new Map<string, number>();
  for (const point of points || []) {
    if (!point || typeof point.date !== 'string' || !point.date) continue;
    if (!Number.isFinite(point.price) || point.price <= 0) continue;
    byDate.set(point.date, point.price);
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(-maxPoints)
    .map(([date, price]) => ({ date, price }));
}

/** Width of the tick-label gutter for these labels in a monospace face. */
export function axisGutter(labels: readonly string[], fontSize: number): number {
  const longest = labels.reduce((n, label) => Math.max(n, label.length), 0);
  return longest === 0 ? 0 : Math.ceil(longest * fontSize * MONO_ADVANCE) + AXIS_PAD * 2;
}

/**
 * Tick labels in full won ("12,000,000") unless that gutter would take more than 40% of the chart;
 * then in 억 or 만 — whichever is shortest with at most two decimals while every tick stays distinct
 * ("1,200만", "1.23억", "12,345만").
 */
export function axisLabels(values: readonly number[], fontSize: number, width: number): string[] {
  const full = values.map(formatNumber);
  if (width <= 0 || axisGutter(full, fontSize) <= width * MAX_GUTTER_SHARE) return full;
  const top = Math.max(...values);
  const distinct = new Set(full).size;
  const units: [number, string][] = [[100_000_000, '억'], [10_000, '만']];
  let best = full;
  for (const [unit, suffix] of units) {
    if (top < unit) continue;
    for (let decimals = 0; decimals <= 2; decimals += 1) {
      const labels = values.map(v => `${(v / unit).toLocaleString('ko-KR', { maximumFractionDigits: decimals })}${suffix}`);
      if (new Set(labels).size !== distinct) continue;
      if (axisGutter(labels, fontSize) < axisGutter(best, fontSize)) best = labels;
      break;
    }
  }
  return best;
}

/** Rough rendered width of a guide label: Hangul about 1em, digits and punctuation about 0.62em. */
export function estimateLabelWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of text) em += /[ㄱ-ㆎ가-힣]/.test(ch) ? 1 : ch === ' ' ? 0.3 : MONO_ADVANCE;
  return Math.ceil(em * fontSize);
}

/**
 * Moves label centers (sorted top to bottom) apart so neighbours are at least `gap` apart, staying inside
 * [lo, hi] where possible. If they cannot all fit, the top one stays in bounds and the rest may overlap.
 */
export function spreadLabels(ys: readonly number[], gap: number, lo: number, hi: number): number[] {
  const out = ys.map(y => Math.min(hi, Math.max(lo, y)));
  for (let i = 1; i < out.length; i += 1) out[i] = Math.max(out[i], out[i - 1] + gap);
  if (out.length > 0) out[out.length - 1] = Math.min(out[out.length - 1], hi);
  for (let i = out.length - 2; i >= 0; i -= 1) out[i] = Math.min(out[i], out[i + 1] - gap);
  if (out.length > 0) out[0] = Math.max(out[0], lo);
  return out;
}

/** The price line's y at x (linear between points), or null outside the line. */
function lineYAt(coords: readonly ChartCoord[], x: number): number | null {
  if (coords.length === 0 || x < coords[0].x || x > coords[coords.length - 1].x) return null;
  for (let i = 1; i < coords.length; i += 1) {
    const a = coords[i - 1];
    const b = coords[i];
    if (x <= b.x) return b.x === a.x ? b.y : a.y + ((x - a.x) / (b.x - a.x)) * (b.y - a.y);
  }
  return coords[coords.length - 1].y;
}

/** Whether the price line (or its ringed last point) passes through a label plate spanning [x0, x1] × [y0, y1]. */
function lineCrosses(coords: readonly ChartCoord[], x0: number, x1: number, y0: number, y1: number): boolean {
  const ys = [lineYAt(coords, x0), lineYAt(coords, x1), ...coords.filter(c => c.x >= x0 && c.x <= x1).map(c => c.y)]
    .filter((y): y is number => y !== null);
  if (ys.length === 0) return false;
  const last = coords[coords.length - 1];
  const ringHit = last.x + 8 >= x0 && last.x - 8 <= x1 && last.y + 8 >= y0 && last.y - 8 <= y1;
  return ringHit || (Math.max(...ys) >= y0 && Math.min(...ys) <= y1);
}

function dayNumber(date: string): number {
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00Z` : date);
  return Number.isFinite(t) ? t / DAY_MS : Number.NaN;
}

/**
 * @param width   full drawing width
 * @param options `left` reserves a gutter for y-axis labels; `top`/`bottom` set the plot band.
 */
export function buildChartModel(input: readonly PricePoint[], width: number, options: ChartOptions = {}): ChartModel | null {
  const points = normalizePoints(input);
  if (points.length === 0) return null;

  const height = options.height ?? CHART.height;
  const top = options.top ?? CHART.top;
  const bottom = options.bottom ?? CHART.bottom;
  const tickCount = Math.max(2, options.tickCount ?? 5);
  const w = Math.max(0, width);

  const prices = points.map(point => point.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min;
  const yOf = (price: number) => (span === 0 ? (top + bottom) / 2 : bottom - ((price - min) / span) * (bottom - top));

  // Rounded tick values can repeat when the range is only a few won; one grid line per distinct label.
  const tickValues = span === 0 ? [min] : Array.from({ length: tickCount }, (_, i) => max - (span * i) / (tickCount - 1));
  const tickLabels = options.axisFontSize ? axisLabels(tickValues, options.axisFontSize, w) : tickValues.map(formatNumber);
  const seen = new Set<string>();
  const ticks: ChartTick[] = [];
  tickValues.forEach((value, i) => {
    if (seen.has(tickLabels[i])) return;
    seen.add(tickLabels[i]);
    ticks.push({ value: Math.round(value), y: yOf(value), label: tickLabels[i] });
  });

  const autoGutter = options.axisFontSize ? axisGutter(ticks.map(t => t.label), options.axisFontSize) : 0;
  const left = Math.max(0, options.left ?? autoGutter);
  const x0 = Math.min(w, left + CHART.side);
  const usable = Math.max(0, w - CHART.side - x0);

  // Calendar spacing: a week without collection is a visible gap, not squeezed next to yesterday.
  const days = points.map(point => dayNumber(point.date));
  const firstDay = days[0];
  const dayRange = days[days.length - 1] - firstDay;
  const byDate = points.length > 1 && days.every(Number.isFinite) && dayRange > 0
    && days.every((d, i) => i === 0 || d >= days[i - 1]);
  const fraction = (index: number) => (byDate ? (days[index] - firstDay) / dayRange : index / (points.length - 1));

  const coords = points.map((point, index) => ({
    x: points.length === 1 ? left + (w - left) / 2 : x0 + fraction(index) * usable,
    y: yOf(point.price),
  }));
  const path = coords.length > 1
    ? coords.map((c, index) => `${index === 0 ? 'M' : 'L'}${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ')
    : '';
  const fillPath = path
    ? `${path} L${coords[coords.length - 1].x.toFixed(1)} ${bottom.toFixed(1)} L${coords[0].x.toFixed(1)} ${bottom.toFixed(1)} Z`
    : '';

  const guides: ChartGuide[] = [];
  if (span > 0) {
    const fontSize = options.guideFontSize ?? 10;
    const labelHeight = Math.ceil(fontSize + 4);
    const average = options.average;
    const kinds: { kind: GuideKind; value: number; name: string }[] = [
      { kind: 'max', value: max, name: '최고' },
      ...(typeof average === 'number' && Number.isFinite(average) && average > min && average < max
        ? [{ kind: 'avg' as const, value: average, name: '평균' }] : []),
      { kind: 'min', value: min, name: '최저' },
    ];
    const labelYs = spreadLabels(kinds.map(k => yOf(k.value)), labelHeight + 1, labelHeight / 2, height - labelHeight / 2);
    kinds.forEach((k, i) => {
      const label = `${k.name} ${formatNumber(k.value)}`;
      const labelWidth = estimateLabelWidth(label, fontSize) + 6;
      const y0 = labelYs[i] - labelHeight / 2;
      const y1 = labelYs[i] + labelHeight / 2;
      const startBlocked = lineCrosses(coords, x0, x0 + labelWidth + 2, y0, y1);
      const endBlocked = lineCrosses(coords, w - CHART.side - labelWidth - 2, w - CHART.side, y0, y1);
      guides.push({
        kind: k.kind, value: k.value, y: yOf(k.value), label, labelY: labelYs[i], labelWidth, labelHeight,
        anchor: startBlocked && !endBlocked ? 'end' : 'start',
      });
    });
  }

  const first = points[0];
  const lastPoint = points[points.length - 1];
  const averageText = guides.some(g => g.kind === 'avg') ? ` 평균 ${formatWon(options.average as number)},` : '';
  let accessibilityLabel: string;
  if (points.length === 1) {
    accessibilityLabel = `가격 기록 1일. ${first.date} ${formatWon(first.price)}.`;
  } else if (span === 0) {
    accessibilityLabel = `최근 ${points.length}개 관측일 가격 추이. ${first.date}부터 ${lastPoint.date}까지 ${formatWon(lastPoint.price)}로 변동 없음.`;
  } else {
    accessibilityLabel = `최근 ${points.length}개 관측일 가격 추이. ${first.date}부터 ${lastPoint.date}까지. `
      + `최저 ${formatWon(min)},${averageText} 최고 ${formatWon(max)}, 최근 ${formatWon(lastPoint.price)}.`;
  }

  return {
    points, min, max, latest: lastPoint.price, flat: span === 0, coords, path, fillPath, ticks, left, guides,
    spacing: byDate ? 'date' : 'index',
    last: coords[coords.length - 1], firstDate: first.date, lastDate: lastPoint.date, accessibilityLabel,
  };
}
