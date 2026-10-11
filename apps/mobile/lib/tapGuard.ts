/*
 * Repeated taps. A second tap that lands while the first navigation is still animating pushes the
 * same screen again — two product screens, or two AI sheets stacked. One guard is shared by every
 * push: the same target within `windowMs` is ignored; a different target always goes through.
 * Pure (the clock is an argument) so tests can drive it.
 */
export function createTapGuard(windowMs = 700) {
  let lastKey = '';
  let lastAt = -Infinity;
  return function allow(key: string, now: number = Date.now()): boolean {
    if (key === lastKey && now - lastAt < windowMs) return false;
    lastKey = key;
    lastAt = now;
    return true;
  };
}
