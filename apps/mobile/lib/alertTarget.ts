export const TARGET_PRESETS = [5, 10, 20] as const;

/**
 * Suggests a target below the currently displayed price.
 * Round down to the nearest 100 won for a cleaner, user-editable goal; prices under 1,000 won
 * keep a 10-won step so a preset never collapses to zero.
 */
export function presetTargetPrice(currentPrice: number, percent: number): number {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return 0;
  if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) return 0;
  const raw = currentPrice * (1 - percent / 100);
  const step = currentPrice >= 1000 ? 100 : 10;
  return Math.max(step, Math.floor(raw / step) * step);
}
