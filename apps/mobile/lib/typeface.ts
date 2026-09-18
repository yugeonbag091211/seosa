/*
 * Web typefaces: Pretendard (body) and IBM Plex Mono (observation stamps, chart axis).
 *
 * Every weight is its own font file named after its PostScript name, so one family string resolves the
 * same way everywhere: iOS looks fonts up by PostScript name, Android by the file name under
 * assets/fonts, and Expo Go by the name passed to useFonts. A custom face is never combined with
 * `fontWeight` — Android would synthesize a fake bold on top of an already bold file.
 *
 * Pure (no React Native import) so node tests can check the mapping.
 */

export const PRETENDARD = {
  400: 'Pretendard-Regular',
  500: 'Pretendard-Medium',
  600: 'Pretendard-SemiBold',
  700: 'Pretendard-Bold',
  800: 'Pretendard-ExtraBold',
} as const;

export const PLEX_MONO = 'IBMPlexMono-Regular';

export type TypefaceStyle = { fontFamily?: string; fontWeight?: string | number };

/** The bundled Pretendard file closest to a CSS/React Native font weight (only 400–800 are bundled). */
const NAMED_WEIGHTS: Record<string, number> = { bold: 700, medium: 500, semibold: 600, heavy: 800, black: 900 };

export function bodyFamily(weight?: string | number): string {
  const numeric = typeof weight === 'number' ? weight : NAMED_WEIGHTS[String(weight)] ?? Number.parseInt(String(weight ?? ''), 10);
  if (!Number.isFinite(numeric)) return PRETENDARD[400];
  const step = Math.min(800, Math.max(400, Math.round(numeric / 100) * 100)) as keyof typeof PRETENDARD;
  return PRETENDARD[step];
}

/**
 * What a text element's font should become once the bundled fonts are available.
 * Returns the replacement `{ fontFamily }` (the caller removes `fontWeight`), or null to leave the style alone:
 *
 * - fonts not ready (still loading, failed, or timed out) → system font with the declared weight, unchanged;
 * - an explicit family → kept (the mono face has one weight, so its declared weight is dropped);
 * - a nested text without its own weight → inherits the parent's resolved face;
 * - otherwise → the Pretendard file for the declared weight (400 when none).
 */
export function resolveTypeface(style: TypefaceStyle, ready: boolean, nested: boolean): { fontFamily: string } | null {
  if (!ready) return null;
  if (style.fontFamily) return style.fontFamily === PLEX_MONO && style.fontWeight !== undefined ? { fontFamily: PLEX_MONO } : null;
  if (nested && style.fontWeight === undefined) return null;
  return { fontFamily: bodyFamily(style.fontWeight) };
}
