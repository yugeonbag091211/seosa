import { kstDate } from './format.ts';
import type { MonthlyCuration, Product } from './types.ts';

/*
 * Home content and layout rules. Pure, so node tests pin them.
 *
 * ── Why the hero copy lives in the app ────────────────────────────────
 * The web keeps its four hero banners (public/index.html #heroCarousel) and the veteran pledge
 * (#veteranOverlay) as static HTML — no table, no endpoint. Fetching them would mean scraping
 * index.html at runtime or adding a server route, and neither belongs in a home-screen change
 * (Vercel Hobby is at its 12-function cap). So the app carries a typed copy here and
 * tests/home.test.mjs compares every sentence with public/index.html whenever the repo copy is
 * present: change the web's wording and the test names the slide to update.
 *
 * To add, remove or reorder a banner, edit HERO_SLIDES only. components/HeroCarousel draws
 * whatever is listed; `art` picks one of the drawings in components/HeroArt.
 *
 * The monthly curation is not copied: it comes from /api/init `monthly`, the same row the web
 * renders, so the operator changes it once in Supabase (monthly_curation) for both.
 */

export type HeroAction = 'concierge' | 'drops' | 'pledge';
export type HeroArtKind = 'shelf' | 'ai' | 'price' | 'memorial';
export type HeroNote = { kind: 'affiliate' } | { kind: 'text'; text: string };

export type HeroSlide = {
  id: string;
  /** What a screen reader hears with the position ("2/4 AI 쇼핑"). The web's data-label. */
  label: string;
  /** Small pill above the headline (web .hc-label). */
  tag?: string;
  /** Headline lines; the web breaks them with <br>. */
  title: readonly string[];
  sub: string;
  cta: { label: string; action: HeroAction };
  /** Under the button: the affiliate disclosure (web .aff-note) or a plain note (web .hc-note). */
  note?: HeroNote;
  /** Slide 1 carries the «MM.DD 수집» stamp (web #recordStat). */
  stamp?: boolean;
  art: HeroArtKind;
};

/**
 * The web's four banners in the web's order. CTA targets in the app:
 *   concierge → AI 컨시어지 (web data-act="ai-entry")
 *   drops     → 가격하락 탭 (web data-act="scroll-drop" scrolls to its 핫딜 list, the same today-drop data)
 *   pledge    → 참전용사 지원 안내 (web data-act="open-veteran" opens #veteranOverlay)
 */
export const HERO_SLIDES: readonly HeroSlide[] = [
  {
    id: 'brand',
    label: '브랜드 소개',
    title: ['최저가도,', '고급지게.'],
    sub: 'AI가 찾아주는 최적의 쇼핑 경험',
    cta: { label: 'AI Concierge에게 물어보기', action: 'concierge' },
    note: { kind: 'affiliate' },
    stamp: true,
    art: 'shelf',
  },
  {
    id: 'ai',
    label: 'AI 쇼핑',
    title: ['찾지 말고,', '그냥 말하세요.'],
    sub: '예산과 용도를 말하면 SEOSA AI가 조건에 맞는 상품을 비교하고 좁혀드립니다.',
    cta: { label: 'AI에게 물어보기', action: 'concierge' },
    note: { kind: 'affiliate' },
    art: 'ai',
  },
  {
    id: 'timing',
    label: '구매 시점 판단',
    title: ['지금 살까,', '조금 더 기다릴까.'],
    sub: '가격 이력과 AI 분석으로 지금이 살 때인지 판단해드립니다.',
    cta: { label: '구매 타이밍 확인', action: 'drops' },
    art: 'price',
  },
  {
    id: 'veteran',
    label: '참전용사 지원',
    tag: '참전용사 지원',
    title: ['가격을 아끼는 일에서,', '기억을 지키는 일까지.'],
    sub: 'SEOSA는 앞으로 실제 정산된 제휴수익의 6.25%를 6·25 참전용사 지원에 사용합니다.',
    cta: { label: '취지 보기', action: 'pledge' },
    note: { kind: 'text', text: '구매자의 추가 부담은 없습니다.' },
    art: 'memorial',
  },
];

/**
 * The example screens in slides 2 and 3 (web .hc-demo). Drawings, not data: no number here is a
 * real product's price or a real verdict, which is why each carries the «예시 화면» tag. On the web
 * the AI example also links to a partner page; in the app nothing in the hero opens a purchase link.
 */
export const HERO_DEMO = {
  tag: '예시 화면',
  ask: ['30만원 이하, 운동할 때 쓸', '노이즈 캔슬링 헤드폰 찾아줘'],
  rank: '추천 1위',
  answerTitle: '노이즈 캔슬링 무선 헤드폰',
  answerPrice: '248,000원',
  answerFit: '조건 5/5 충족',
  verdictBadge: 'BUY',
  verdictText: '지금 사도 좋아요',
} as const;

export type PledgeSegment = { text: string; strong?: boolean };

/** «취지 보기» — the web's #veteranOverlay word for word (tests compare it). */
export const VETERAN_PLEDGE = {
  title: '참전용사 지원 — SEOSA 6.25% 약속',
  lead: '구매자의 추가 부담은 없습니다.',
  paragraphs: [
    [{ text: 'SEOSA는 가격을 기록하고 비교해 조금이라도 덜 쓰게 하는 일을 합니다. 그렇게 이어진 구매에서 실제 정산된 제휴수익의 일부를, 지금의 일상을 가능하게 한 분들을 지원하는 데 사용합니다.' }],
    [
      { text: 'SEOSA는 ' },
      { text: '실제 정산된 제휴수익의 6.25%를 6·25 참전용사 지원에 사용합니다.', strong: true },
      { text: ' 6.25%라는 숫자에는 6·25전쟁과 참전용사분들의 희생을 기억하겠다는 의미를 담았습니다.' },
    ],
    [{ text: '지원 단체, 전달 주기, 집행 내역 공개 방식은 실제 집행에 맞춰 투명하게 안내하겠습니다. 지원 내역을 확인할 수 있도록 기록과 공개 방법도 함께 정리하겠습니다.' }],
  ] as readonly (readonly PledgeSegment[])[],
  footnote: '실제 집행이 시작되면 이 자리에 시행 시기와 집행 내역 공개 방법을 함께 적겠습니다. SEOSA의 6.25% 약속과 집행 내역을 계속 확인할 수 있게 하겠습니다.',
} as const;

/* ── Monthly curation ───────────────────────────────────────────────── */

/** Cards and keyword chips the home shows from `monthly` (the server sends 8 products; SECTION_SIZE). */
export const MONTHLY_CARDS = 8;
export const MONTHLY_CHIPS = 8;

/** Month (1–12) on the KST calendar, like the server's api/_kst.kstMonth. 0 when the instant is unreadable. */
export function kstMonthOf(now: Date | number = Date.now()): number {
  const ymd = kstDate(now);
  return ymd ? Number(ymd.slice(5, 7)) : 0;
}

/**
 * «10월 추천 상품». The server's month names the month these products were picked for, so it wins;
 * the device's KST month fills in only while loading or when the payload had none. (Right after
 * midnight on the 1st the server can still be serving last month's row — then the title says so.)
 */
export function monthlyHeading(monthly: MonthlyCuration | null | undefined, now: Date | number = Date.now()): string {
  const m = monthly?.month || kstMonthOf(now);
  return m ? `${m}월 추천 상품` : '이달의 추천 상품';
}

export type MonthlyState = 'hidden' | 'loading' | 'error' | 'empty' | 'cards';

/**
 * What the monthly section shows. A row already on screen wins over a failed refresh
 * (React Query keeps the last `data` on error); without a row it is a spinner while loading,
 * a retry after a failure, and nothing at all when the month simply has no curation.
 */
export function monthlyState(monthly: MonthlyCuration | null | undefined, pending: boolean, failed: boolean): MonthlyState {
  if (monthly) return monthly.products.length ? 'cards' : 'empty';
  if (pending) return 'loading';
  return failed ? 'error' : 'hidden';
}

/** The operator's banner text («깊어가는 가을 · 감성을 더하는 가을의 큐레이션»), whichever parts exist. */
export function monthlySubline(monthly: MonthlyCuration | null | undefined): string {
  return [monthly?.title, monthly?.subtitle].filter(Boolean).join(' · ');
}

/* ── «MM.DD 수집» ───────────────────────────────────────────────────── */

const DAY_MS = 86_400_000;

/**
 * The newest collectedAt among the products on screen, as «10.10 수집» on the KST calendar
 * (web Record.render). It proves the record is alive today; it is never invented — no readable
 * date, no stamp. A date more than a day ahead of the device clock is ignored.
 */
export function recordStamp(lists: readonly (readonly Product[] | undefined | null)[], now: Date | number = Date.now()): string {
  const limit = (typeof now === 'number' ? now : now.getTime()) + DAY_MS;
  let newest = 0;
  for (const list of lists) {
    for (const p of list || []) {
      const at = Date.parse(p.collectedAt);
      if (Number.isFinite(at) && at > newest && at <= limit) newest = at;
    }
  }
  if (!newest) return '';
  const ymd = kstDate(newest);
  return `${ymd.slice(5, 7)}.${ymd.slice(8, 10)} 수집`;
}

/* ── Hero layout ────────────────────────────────────────────────────── */

/** From this column width the copy and the drawing sit side by side (Android tablets, unfolded foldables). */
export const HERO_WIDE_MIN = 600;

export type HeroMetrics = { wide: boolean; titleSize: number; titleLine: number; artHeight: number };

/**
 * Sizes for a column `width` dp wide. Phones stack copy over the drawing with the headline scaled
 * to the width, so the longest line («가격을 아끼는 일에서,») stays on one line from 320 dp up;
 * wide columns put the drawing beside the copy at a fixed size.
 */
export function heroMetrics(width: number): HeroMetrics {
  const w = Number.isFinite(width) && width > 0 ? width : 375;
  const wide = w >= HERO_WIDE_MIN;
  const titleSize = wide ? 36 : Math.min(32, Math.max(25, Math.round(w * 0.08)));
  return { wide, titleSize, titleLine: Math.round(titleSize * 1.22), artHeight: wide ? 250 : 156 };
}

/** The page a paging scroll view rests on. Never out of range, whatever the offset. */
export function pageIndex(offsetX: number, pageWidth: number, count: number): number {
  if (!(pageWidth > 0) || !(count > 0) || !Number.isFinite(offsetX)) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(offsetX / pageWidth)));
}
