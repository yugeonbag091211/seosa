import { Platform, useColorScheme } from 'react-native';
import { palette, type Theme } from './palette';

export { palette };
export type { Theme } from './palette';

/** --r 4 / --r-sm 3 / --r-lg 8, plus the fixed radii the web uses on mobile. */
export const radius = { r: 4, sm: 3, lg: 8, panel: 10, dropCard: 14, field: 26 } as const;

/** Measured on seosa.ai.kr at a 390px viewport (the ≤480px breakpoint). */
export const space = {
  page: 14,       // .wrap padding
  heroX: 28,      // .hero-band .hero-inner padding
  section: 56,    // section.block margin-top
  sectionHead: 14, // .sec-head margin-bottom
  grid: 10,       // .grid / .drop-cards gap
  header: 50,     // .bar height (plus a 1px rule)
} as const;

/** Web type scale at 390px, in px (= dp). */
export const typography = {
  heroTitle: { fontSize: 38.4, lineHeight: 44.5, fontWeight: '800', letterSpacing: -1.73 },
  heroSub: { fontSize: 15, lineHeight: 23.3, letterSpacing: -0.15 },
  sectionTitle: { fontSize: 16, lineHeight: 19.2, fontWeight: '700', letterSpacing: -0.45 },
  sectionSub: { fontSize: 11.84, lineHeight: 18.35 },
  chip: { fontSize: 12.8, fontWeight: '500' },
  cardTitle: { fontSize: 11.52, lineHeight: 16.1 },
  cardPrice: { fontSize: 16.32, lineHeight: 19.6, fontWeight: '700', letterSpacing: -0.41 },
  won: { fontSize: 10.56, fontWeight: '500' },
  mall: { fontSize: 10.56, lineHeight: 16.4, fontWeight: '600' },
  stamp: { fontSize: 9.28, lineHeight: 14.4, letterSpacing: 0.28 },
  dropName: { fontSize: 11.84, lineHeight: 16 },
  dropPrice: { fontSize: 14.72, lineHeight: 22.8, fontWeight: '700', letterSpacing: -0.29 },
  dropMeta: { fontSize: 10.88, lineHeight: 16.9 },
  modalTitle: { fontSize: 16, lineHeight: 22, fontWeight: '700', letterSpacing: -0.32 },
  modalSub: { fontSize: 11.84, lineHeight: 17.8 },
  verdictHead: { fontSize: 13.44, lineHeight: 19, fontWeight: '700' },
  verdictLine: { fontSize: 11.52, lineHeight: 17.9 },
} as const;

/** Web: the S mark is Georgia bold; stamps use IBM Plex Mono (platform monospace here). */
export const fonts = {
  serif: Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia, serif' }),
  mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, monospace' }),
} as const;

export function useTheme(): Theme {
  return palette[useColorScheme() === 'dark' ? 'dark' : 'light'];
}
