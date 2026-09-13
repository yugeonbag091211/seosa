import type { PricePoint } from './api';

/** Geometry of the price sparkline. Pure, so tests can check every edge case without a renderer. */
export const CHART = { height: 132, top: 12, bottom: 120, side: 6, maxPoints: 30 } as const;

export type ChartCoord = { x: number; y: number };

export type ChartModel = {
  points: PricePoint[];
  min: number;
  max: number;
  latest: number;
  flat: boolean;
  coords: ChartCoord[];
  path: string;
  last: ChartCoord;
  firstDate: string;
  lastDate: string;
  accessibilityLabel: string;
};

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

export function buildChartModel(input: readonly PricePoint[], width: number): ChartModel | null {
  const points = normalizePoints(input);
  if (points.length === 0) return null;

  const prices = points.map(point => point.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min;
  const w = Math.max(0, width);
  const usable = Math.max(0, w - CHART.side * 2);

  const coords = points.map((point, index) => ({
    x: points.length === 1 ? w / 2 : CHART.side + (index / (points.length - 1)) * usable,
    y: span === 0 ? (CHART.top + CHART.bottom) / 2 : CHART.bottom - ((point.price - min) / span) * (CHART.bottom - CHART.top),
  }));
  const path = coords.length > 1
    ? coords.map((c, index) => `${index === 0 ? 'M' : 'L'}${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ')
    : '';

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
    points, min, max, latest: lastPoint.price, flat: span === 0, coords, path,
    last: coords[coords.length - 1], firstDate: first.date, lastDate: lastPoint.date, accessibilityLabel,
  };
}
