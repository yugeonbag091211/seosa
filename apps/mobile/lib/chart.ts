import type { PricePoint } from './api';

/** Geometry of the price chart. Pure, so tests can check every edge case without a renderer. */
export const CHART = { height: 132, top: 12, bottom: 120, side: 6, maxPoints: 30 } as const;

export type ChartCoord = { x: number; y: number };
export type ChartTick = { value: number; y: number };

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
  last: ChartCoord;
  firstDate: string;
  lastDate: string;
  accessibilityLabel: string;
};

export type ChartOptions = { height?: number; top?: number; bottom?: number; left?: number; tickCount?: number };

export function formatWon(price: number): string {
  return `${Math.round(price).toLocaleString('ko-KR')}원`;
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

/**
 * @param width   full drawing width
 * @param options `left` reserves a gutter for y-axis labels; `top`/`bottom` set the plot band.
 */
export function buildChartModel(input: readonly PricePoint[], width: number, options: ChartOptions = {}): ChartModel | null {
  const points = normalizePoints(input);
  if (points.length === 0) return null;

  const top = options.top ?? CHART.top;
  const bottom = options.bottom ?? CHART.bottom;
  const left = Math.max(0, options.left ?? 0);
  const tickCount = Math.max(2, options.tickCount ?? 5);

  const prices = points.map(point => point.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min;
  const w = Math.max(0, width);
  const x0 = Math.min(w, left + CHART.side);
  const usable = Math.max(0, w - CHART.side - x0);
  const yOf = (price: number) => (span === 0 ? (top + bottom) / 2 : bottom - ((price - min) / span) * (bottom - top));

  const coords = points.map((point, index) => ({
    x: points.length === 1 ? left + (w - left) / 2 : x0 + (index / (points.length - 1)) * usable,
    y: yOf(point.price),
  }));
  const path = coords.length > 1
    ? coords.map((c, index) => `${index === 0 ? 'M' : 'L'}${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ')
    : '';
  const fillPath = path
    ? `${path} L${coords[coords.length - 1].x.toFixed(1)} ${bottom.toFixed(1)} L${coords[0].x.toFixed(1)} ${bottom.toFixed(1)} Z`
    : '';
  const ticks: ChartTick[] = span === 0
    ? [{ value: min, y: yOf(min) }]
    : Array.from({ length: tickCount }, (_, i) => {
      const value = max - (span * i) / (tickCount - 1);
      return { value: Math.round(value), y: yOf(value) };
    });

  const first = points[0];
  const lastPoint = points[points.length - 1];
  let accessibilityLabel: string;
  if (points.length === 1) {
    accessibilityLabel = `가격 기록 1일. ${first.date} ${formatWon(first.price)}.`;
  } else if (span === 0) {
    accessibilityLabel = `최근 ${points.length}개 관측일 가격 추이. ${first.date}부터 ${lastPoint.date}까지 ${formatWon(lastPoint.price)}로 변동 없음.`;
  } else {
    accessibilityLabel = `최근 ${points.length}개 관측일 가격 추이. ${first.date}부터 ${lastPoint.date}까지. `
      + `최저 ${formatWon(min)}, 최고 ${formatWon(max)}, 최근 ${formatWon(lastPoint.price)}.`;
  }

  return {
    points, min, max, latest: lastPoint.price, flat: span === 0, coords, path, fillPath, ticks,
    last: coords[coords.length - 1], firstDate: first.date, lastDate: lastPoint.date, accessibilityLabel,
  };
}
