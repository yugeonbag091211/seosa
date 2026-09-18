import type { Deal, PricePoint } from './api';
import { CHART, normalizePoints } from './chart.ts';

/*
 * Display rules ported from the web (public/index.html) so the app says exactly what the site says.
 * Pure functions: no React Native imports, so node tests can load them.
 */

export function formatPrice(price: number): string {
  return Number.isFinite(price) ? Math.round(price).toLocaleString('ko-KR') : '-';
}

// SEOSA is a KST-only service (collection runs on a KST cron); "오늘"/"어제" are calendar
// days in KST regardless of the device or CI runner's own timezone.
const KST_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Midnight (KST) of the calendar day a timestamp falls on, as a UTC-anchored instant so days can be diffed. */
function startOfKstDay(ms: number): number {
  return Date.parse(`${KST_DAY.format(new Date(ms))}T00:00:00Z`);
}

/**
 * Web Fmt.asOf — when this stored price was collected. Empty when unknown.
 * Unlike the web (which buckets by elapsed 24h), this compares KST calendar dates: a price from
 * 23:50 yesterday is "어제" even minutes later, and one from 25 hours ago crossing two
 * midnights is dated rather than called "어제".
 */
export function asOfLabel(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const days = Math.round((startOfKstDay(now) - startOfKstDay(t)) / 86_400_000);
  if (days <= 0) return '오늘 기준';
  if (days === 1) return '어제 기준';
  const [, month, day] = KST_DAY.format(new Date(t)).split('-');
  return `${month}.${day} 기준`;
}

export type MallColor = { token: 'coupang' | 'ali' } | { hex: string } | null;

/** Web MallBrand.COLORS — only brand colors the web verified; everything else gets a neutral dot. */
export function mallColor(label: string | undefined): MallColor {
  switch ((label || '').trim()) {
    case '쿠팡': return { token: 'coupang' };
    case '알리익스프레스':
    case '알리': return { token: 'ali' };
    case '오늘의집': return { hex: '#00a1ff' };
    case '예스이십사': return { hex: '#0080ff' };
    case 'GS SHOP': return { hex: '#0088ff' };
    case '롯데홈쇼핑': return { hex: '#cd3129' };
    case '보리보리': return { hex: '#fdd137' };
    default: return null;
  }
}

export type VerdictTone = 'buy' | 'wait' | 'neutral';
export type VerdictStyle = { tone: VerdictTone; icon: string; head: string };

/** Web Modal.DEAL_STYLE. */
const DEAL_STYLE: Record<string, VerdictStyle> = {
  BUY: { tone: 'buy', icon: '✦', head: '지금 구매' },
  GOOD_BUY: { tone: 'buy', icon: '↘', head: '지금 사도 괜찮아요' },
  NORMAL: { tone: 'neutral', icon: '⚖️', head: '평범한 가격이에요' },
  WATCH: { tone: 'neutral', icon: '👀', head: '지켜볼 만해요' },
  WAIT: { tone: 'wait', icon: '⏳', head: '조금 기다려보세요' },
  DONT_BUY: { tone: 'wait', icon: '↗', head: '지금은 비싼 편이에요' },
  UNKNOWN: { tone: 'neutral', icon: '❓', head: '아직 판단하기 어려워요' },
};

export type VerdictView = VerdictStyle & { line: string };

/**
 * Web Modal.renderVerdict: fewer than two observations → "collecting"; otherwise the server verdict
 * with its first reason and first caution joined by " · " (falling back to the server label).
 */
export function verdictView(pointCount: number, deal: { verdict: string; label: string; reasons: string[]; cautions: string[] } | null): VerdictView | null {
  if (pointCount < 2) {
    return { tone: 'neutral', icon: '🗓', head: '가격 추이를 수집하고 있어요', line: '매일 새벽 자동 수집되며, 데이터가 쌓이면 그래프가 표시됩니다.' };
  }
  if (!deal || !deal.verdict) return null;
  const style = DEAL_STYLE[deal.verdict] || DEAL_STYLE.UNKNOWN;
  const lines = [deal.reasons[0], deal.cautions[0]].filter((s): s is string => !!s);
  return { ...style, line: lines.length ? lines.join(' · ') : deal.label || '' };
}

export type PriceStats = { min: number; avg: number; max: number };

export function priceStats(points: readonly PricePoint[]): PriceStats | null {
  const prices = points.map(p => p.price).filter(p => Number.isFinite(p) && p > 0);
  if (prices.length === 0) return null;
  const sum = prices.reduce((a, b) => a + b, 0);
  return { min: Math.min(...prices), avg: Math.round(sum / prices.length), max: Math.max(...prices) };
}

export type TrendTone = 'down' | 'up' | 'flat';
export type TrendSummary = { days: number; label: string; tone: TrendTone; recent: string; position: string };

/** Web Modal.renderTrend, without the emoji chart icon's markup. Needs at least two points. */
export function trendSummary(points: readonly PricePoint[], deal: { verdict: string; label: string } | null): TrendSummary | null {
  const prices = points.map(p => p.price).filter(p => Number.isFinite(p) && p > 0);
  if (prices.length < 2) return null;
  const first = prices[0];
  const last = prices[prices.length - 1];
  const pct = first > 0 ? Math.round(((last - first) / first) * 1000) / 10 : 0;

  let label: string;
  let tone: TrendTone;
  if (Math.abs(pct) < 1) { label = '거의 변동 없음'; tone = 'flat'; }
  else if (pct < 0) { label = `${Math.abs(pct).toFixed(1)}% 하락 ↓`; tone = 'down'; }
  else { label = `${pct.toFixed(1)}% 상승 ↑`; tone = 'up'; }

  const recentPrices = prices.slice(-7);
  let recent = '';
  if (recentPrices.length >= 2) {
    const rMin = Math.min(...recentPrices);
    const rMax = Math.max(...recentPrices);
    const vol = rMin > 0 ? ((rMax - rMin) / rMin) * 100 : 0;
    const allDown = recentPrices.every((v, i) => i === 0 || v <= recentPrices[i - 1]);
    const allUp = recentPrices.every((v, i) => i === 0 || v >= recentPrices[i - 1]);
    const lastRecent = recentPrices[recentPrices.length - 1];
    if (allDown && lastRecent < recentPrices[0]) recent = `📉 최근 ${recentPrices.length}일 연속 하락 중`;
    else if (allUp && lastRecent > recentPrices[0]) recent = `📈 최근 ${recentPrices.length}일 연속 상승 중`;
    else if (vol < 2) recent = '최근 7일 안정세';
    else if (vol < 8) recent = '최근 7일 소폭 변동';
    else recent = '최근 7일 큰 변동';
  }

  // Only the server's verdict is used for the position wording (the web's local fallback is not ported).
  let position = '';
  if (deal && deal.verdict && deal.verdict !== 'UNKNOWN') {
    const style = DEAL_STYLE[deal.verdict] || DEAL_STYLE.UNKNOWN;
    position = `${style.icon} ${deal.label || style.head}`;
  } else if (deal && deal.verdict === 'UNKNOWN') {
    position = '❓ 가격 데이터가 충분하지 않아 추세를 정확하게 판단하기 어렵습니다';
  }

  return { days: prices.length, label, tone, recent, position };
}

export type ProductDetailView = {
  count: number;
  verdict: VerdictView | null;
  stats: PriceStats | null;
  trend: TrendSummary | null;
  observations: PricePoint[];
};

/**
 * Every metric on the product detail screen (verdict count, chart, trend, min/avg/max, recent
 * observations) is deduped over the same one-point-per-day series, so duplicate or out-of-order
 * dates from the server can never make them disagree with each other.
 *
 * min/avg/max is deduped over the full series the server sent (not the chart's 30-day drawing
 * window) — the "최저/평균/최고" labels don't say "30일", so an older all-time low must not
 * silently drop out. Trend, however, describes what the chart is currently drawing ("N% 하락"),
 * so it is computed over that same 30-point window — otherwise a longer history can call a trend
 * "하락" while the visible chart is climbing.
 */
export function productDetailView(points: readonly PricePoint[], deal: Deal | null): ProductDetailView {
  const recent = normalizePoints(points, points.length);
  const windowed = recent.slice(-CHART.maxPoints);
  return {
    count: recent.length,
    verdict: verdictView(recent.length, deal),
    stats: priceStats(recent),
    trend: trendSummary(windowed, deal),
    observations: recent.slice(-5).reverse(),
  };
}

/** "마우스" 결과 요약 (web result-banner): lowest price, count, and price range. */
export function resultSummary(prices: readonly number[]): { min: number; max: number; count: number } | null {
  const valid = prices.filter(p => Number.isFinite(p) && p > 0);
  if (valid.length === 0) return null;
  return { min: Math.min(...valid), max: Math.max(...valid), count: valid.length };
}
