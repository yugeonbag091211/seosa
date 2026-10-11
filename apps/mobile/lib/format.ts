/*
 * Number and date formatting. Pure.
 *
 * Dates: the server stamps observations in KST (api/_price.observedKstDate), so relative labels
 * ("오늘", "어제", "9월 28일") are computed on the KST calendar, not the device's time zone.
 */

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

export function won(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '';
  return `${Math.round(value).toLocaleString('ko-KR')}원`;
}

/** Digits only, for layouts that set "원" in a smaller size. */
export function digits(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '';
  return Math.round(value).toLocaleString('ko-KR');
}

/** "12.3%" → "12%"; the server already rounds, this keeps display to whole percents. */
export function percent(value: number): string {
  if (!Number.isFinite(value)) return '';
  return `${Math.round(value)}%`;
}

/** YYYY-MM-DD on the KST calendar for an instant. */
export function kstDate(at: Date | number | string): string {
  const ms = typeof at === 'string' ? Date.parse(at) : typeof at === 'number' ? at : at.getTime();
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

function dayNumber(ymd: string): number {
  const ms = Date.parse(`${ymd}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.floor(ms / DAY_MS) : NaN;
}

/**
 * "오늘" / "어제" / "9월 28일" for an observation date (YYYY-MM-DD or ISO instant).
 * Returns '' when the input cannot be read — callers then show nothing rather than a guess.
 */
export function observedLabel(value: string, now: Date | number = Date.now()): string {
  if (!value) return '';
  const ymd = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : kstDate(value);
  if (!ymd) return '';
  const diff = dayNumber(kstDate(now)) - dayNumber(ymd);
  if (!Number.isFinite(diff)) return '';
  if (diff <= 0) return '오늘';
  if (diff === 1) return '어제';
  const [, m, d] = ymd.split('-').map(Number);
  return `${m}월 ${d}일`;
}

/** Short axis date "9.28". */
export function shortDate(ymd: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(ymd || '');
  return m ? `${Number(m[1])}.${Number(m[2])}` : '';
}

/** Whole days between an observation and now on the KST calendar; null when unknown. */
export function ageInDays(value: string, now: Date | number = Date.now()): number | null {
  if (!value) return null;
  const ymd = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : kstDate(value);
  const diff = dayNumber(kstDate(now)) - dayNumber(ymd);
  return Number.isFinite(diff) ? Math.max(0, diff) : null;
}

export function isEmail(value: string): boolean {
  const s = String(value || '').trim();
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
