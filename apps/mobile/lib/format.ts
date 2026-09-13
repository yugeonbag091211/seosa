import type { PricePoint } from './api';

/*
 * Display rules ported from the web (public/index.html) so the app says exactly what the site says.
 * Pure functions: no React Native imports, so node tests can load them.
 */

export function formatPrice(price: number): string {
  return Number.isFinite(price) ? Math.round(price).toLocaleString('ko-KR') : '-';
}

/** Web Fmt.asOf — when this stored price was collected. Empty when unknown. */
export function asOfLabel(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!t) return '';
  const days = Math.floor((now - t) / 86_400_000);
  if (days <= 0) return '오늘 기준';
  if (days === 1) return '어제 기준';
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}.${pad(d.getDate())} 기준`;
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

/** "마우스" 결과 요약 (web result-banner): lowest price, count, and price range. */
export function resultSummary(prices: readonly number[]): { min: number; max: number; count: number } | null {
  const valid = prices.filter(p => Number.isFinite(p) && p > 0);
  if (valid.length === 0) return null;
  return { min: Math.min(...valid), max: Math.max(...valid), count: valid.length };
}
