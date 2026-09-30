/*
 * Web typefaces: Pretendard (body) and IBM Plex Mono (observation stamps, chart axis).
 * From the PR #34 prototype.
 *
 * Each weight is its own file named after its PostScript name, so one family string resolves
 * the same on iOS (PostScript name), Android (file name) and in development (useFonts key).
 * A custom face is never combined with `fontWeight` — Android would synthesize bold on top.
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

const NAMED_WEIGHTS: Record<string, number> = { normal: 400, bold: 700, medium: 500, semibold: 600, heavy: 800, black: 900 };

export function bodyFamily(weight?: string | number): string {
  const numeric = typeof weight === 'number' ? weight : NAMED_WEIGHTS[String(weight)] ?? Number.parseInt(String(weight ?? ''), 10);
  if (!Number.isFinite(numeric)) return PRETENDARD[400];
  const step = Math.min(800, Math.max(400, Math.round(numeric / 100) * 100)) as keyof typeof PRETENDARD;
  return PRETENDARD[step];
}
